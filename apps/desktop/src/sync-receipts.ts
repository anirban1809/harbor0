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
// A pass that finds every copy confirmed waits an hour, or until nudge() reports new activity.
const AUDIT_RETRY = 15_000;
const AUDIT_IDLE = 3_600_000;
const AUDIT_BATCH = 25;
const AUDIT_BATCH_MIN = 5;
// The outbox survives restarts. Audits also recover copies completed before receipts existed.
export class SyncReceipts {
  private candidates: Candidate[] = [];
  private nextAuditAt = 0;
  private passFound = false;
  // Shrinks while the server is slow to answer, so a large folder still gets through.
  private batchSize = AUDIT_BATCH;
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
  /** Sync activity may have left copies unconfirmed; audit again soon. */
  nudge() {
    this.nextAuditAt = Math.min(this.nextAuditAt, Date.now() + AUDIT_RETRY);
  }
  private passEnded() {
    this.nextAuditAt = Date.now() + (this.passFound ? AUDIT_RETRY : AUDIT_IDLE);
  }
  async audit(signal?: AbortSignal) {
    if (!this.candidates.length) {
      if (Date.now() < this.nextAuditAt) return;
      this.passFound = false;
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
    const batch = this.candidates.slice(0, this.batchSize);
    if (!batch.length) {
      this.passEnded();
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
      this.batchSize = Math.min(AUDIT_BATCH, this.batchSize * 2);
    } catch (error) {
      if (signal?.aborted) return;
      if (
        error instanceof ApiError &&
        ['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND', 'ITEM_DELETING', 'SYNC_REMOVED'].includes(error.code)
      ) {
        this.passFound = true;
        for (const candidate of batch) {
          const root = this.journal.roots().find((r) => r.id === candidate.rootId);
          if (root) this.reconcile(root);
        }
        this.candidates.splice(0, batch.length);
        return;
      }
      // Never retry the same batch forever: move on, and audit this one again next pass.
      this.passFound = true;
      this.candidates.splice(0, batch.length);
      if (!this.candidates.length) this.passEnded();
      this.batchSize = Math.max(AUDIT_BATCH_MIN, Math.floor(this.batchSize / 2));
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
      this.passFound = true;
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
    if (!this.candidates.length) this.passEnded();
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
        // Only checks what is there: recreating a parent would undo the user deleting it.
        const full = await safeParents(root.localPath, receipt.relative, false);
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
