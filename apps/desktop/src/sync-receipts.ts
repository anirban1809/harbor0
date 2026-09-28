import { open, lstat } from 'node:fs/promises';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { DriveItem, SyncItemStatus } from '@harbor/contracts';
import { Journal, type Root } from './journal';
import { safeParents } from './paths';
import { hashFile } from './transfers';

type Receipt = {
  rootId: string;
  remoteId: string;
  relative: string;
  item: DriveItem;
  hash: string | null;
};
type Candidate = { rootId: string; itemId: string; isRoot: boolean };
// The outbox survives restarts. Audits also recover copies completed before receipts existed.
export class SyncReceipts {
  private candidates: Candidate[] = [];
  private nextAuditAt = 0;
  constructor(
    private api: ApiClient,
    private journal: Journal,
  ) {}
  private pending() {
    return this.journal.get<Record<string, Receipt>>('syncReceipts') ?? {};
  }
  pendingRoots() {
    return [...new Set(Object.values(this.pending()).map((receipt) => receipt.rootId))];
  }
  queue(root: Root, relative: string, item: DriveItem, hash: string | null) {
    if (
      root.mode !== 'sync' ||
      !root.remoteId ||
      !item.id ||
      !item.revision ||
      (item.type === 'FILE' && (!item.currentVersionId || !hash))
    )
      return;
    const pending = this.pending();
    pending[item.id] = { rootId: root.id, remoteId: root.remoteId, relative, item, hash };
    this.journal.set('syncReceipts', pending);
  }
  private remove(id: string, receipt: Receipt, retry = false) {
    // Transfers may queue a newer revision while the network request is outstanding.
    const current = this.pending();
    if (JSON.stringify(current[id]) !== JSON.stringify(receipt)) return;
    delete current[id];
    if (retry) current[id] = receipt; // A failing item must not starve other confirmations.
    this.journal.set('syncReceipts', current);
  }
  private reconcile(root: Root) {
    const current = this.journal.roots().find((r) => r.id === root.id);
    if (current) this.journal.root({ ...current, needsReconcile: true });
  }
  async audit(signal?: AbortSignal) {
    if (!this.candidates.length) {
      if (Date.now() < this.nextAuditAt) return;
      this.candidates = this.journal
        .roots()
        .filter((root) => root.mode === 'sync' && root.remoteId && !root.paused)
        .flatMap((root) => [
          { rootId: root.id, itemId: root.remoteId!, isRoot: true },
          ...this.journal
            .files(root.id)
            .map((file) => ({ rootId: root.id, itemId: file.itemId, isRoot: false })),
        ]);
    }
    const batch = this.candidates.slice(0, 10);
    if (!batch.length) {
      this.nextAuditAt = Date.now() + 15000;
      return;
    }
    const requestSignal = () =>
      signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    let statuses: SyncItemStatus[];
    try {
      const response = await this.api.request(
        '/v1/sync/status?recursive=false&ids=' + batch.map((c) => c.itemId).join(','),
        { signal: requestSignal() },
      );
      if (!Array.isArray(response.items)) return;
      statuses = response.items;
    } catch (error) {
      if (
        error instanceof ApiError &&
        ['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND', 'ITEM_DELETING', 'SYNC_REMOVED'].includes(error.code)
      ) {
        for (const candidate of batch) {
          const root = this.journal.roots().find((r) => r.id === candidate.rootId);
          if (root) this.reconcile(root);
        }
        this.candidates.splice(0, batch.length);
      }
      return;
    }
    for (const candidate of batch) {
      if (signal?.aborted) return;
      const root = this.journal.roots().find((r) => r.id === candidate.rootId);
      if (!root || root.paused || root.mode !== 'sync') continue;
      const known = candidate.isRoot
        ? undefined
        : this.journal.fileByItem(root.id, candidate.itemId);
      if (!candidate.isRoot && !known) continue;
      const relative = candidate.isRoot ? '.' : known!.relativePath;
      if (root.excluded.some((p) => relative === p || relative.startsWith(p + '/'))) continue;
      const status = statuses.find((s) => s.itemId === candidate.itemId);
      if (!status) continue;
      if (
        status.deviceConfirmed === true &&
        (candidate.isRoot || status.revision === known?.revision)
      )
        continue;
      try {
        const { item }: { item: DriveItem } = await this.api.request(
          '/v1/drive/items/' + candidate.itemId,
          { signal: requestSignal() },
        );
        if (!item || item.deletedAt) {
          this.reconcile(root);
          continue;
        }
        if (known && (item.revision !== known.revision || (item.type === 'FILE' && !known.hash))) {
          this.reconcile(root);
          continue;
        }
        this.queue(root, relative, item, known?.hash ?? null);
      } catch {
        // Revisit this copy on the next audit; other files can still be confirmed.
      }
    }
    this.candidates.splice(0, batch.length);
    if (!this.candidates.length) this.nextAuditAt = Date.now() + 15000;
  }
  async flush(signal?: AbortSignal) {
    const deadline = Date.now() + 5000;
    for (const [id, receipt] of Object.entries(this.pending())) {
      if (signal?.aborted || Date.now() >= deadline) break;
      const root = this.journal.roots().find((r) => r.id === receipt.rootId);
      if (
        !root ||
        root.mode !== 'sync' ||
        root.remoteId !== receipt.remoteId ||
        root.excluded.some((p) => receipt.relative === p || receipt.relative.startsWith(p + '/'))
      ) {
        this.remove(id, receipt);
        continue;
      }
      if (root.paused) continue;
      try {
        const full = await safeParents(root.localPath, receipt.relative);
        const stat = await lstat(full);
        if (receipt.item.type === 'FILE') {
          if (!stat.isFile() || (await hashFile(full)) !== receipt.hash) {
            this.remove(id, receipt);
            continue;
          }
          const file = await open(full, 'r');
          try {
            const verified = await file.stat();
            if (
              verified.size !== stat.size ||
              verified.mtimeMs !== stat.mtimeMs ||
              verified.ino !== stat.ino
            ) {
              this.remove(id, receipt);
              continue;
            }
            await file.sync();
          } finally {
            await file.close();
          }
        } else if (!stat.isDirectory()) {
          this.remove(id, receipt);
          continue;
        }
        const response = await this.api.request(`/v1/sync/items/${id}/acknowledge`, {
          method: 'POST',
          body: {
            versionId: receipt.item.currentVersionId,
            revision: receipt.item.revision,
            contentHash: receipt.hash,
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
            : AbortSignal.timeout(8000),
        });
        if (response?.ok === true) {
          this.remove(id, receipt);
          this.journal.set('syncConfirmedAt', new Date().toISOString());
        } else this.remove(id, receipt, true);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error instanceof ApiError &&
            ['REVISION_CONFLICT', 'ITEM_NOT_FOUND', 'PARENT_NOT_FOUND'].includes(error.code))
        ) {
          this.reconcile(root);
          this.remove(id, receipt);
        } else this.remove(id, receipt, true);
      }
    }
  }
}
