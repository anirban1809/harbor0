import { open, lstat } from 'node:fs/promises';
import { ApiClient, ApiError } from '@harbor/api-client';
import { SYNC_ACKNOWLEDGE_ITEMS, type DriveItem, type SyncItemStatus } from '@harbor/contracts';
import { Journal, type Root } from './journal';
import { safeParents } from './paths';
import { hashFile } from './transfers';

type Receipt = {
  rootId: string;
  remoteId: string;
  relative: string;
  item: DriveItem;
  /** SHA-256 of the file on disk. */
  hash: string | null;
  /** SHA-256 of the version as stored, when it differs: an encrypted file's ciphertext. */
  storedHash?: string | null;
};
/**
 * Windows flushes a file only through a handle that may write it: fsync on a read-only handle
 * fails with EPERM. A file that cannot be opened for writing there (read-only, or locked by the
 * app editing it) is confirmed without the flush rather than never.
 */
async function openToFlush(full: string) {
  if (process.platform !== 'win32') return { file: await open(full, 'r'), flushable: true };
  try {
    return { file: await open(full, 'r+'), flushable: true };
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
    return { file: await open(full, 'r'), flushable: false };
  }
}
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
  // Off once the server turns out to have no batch confirmation route.
  private batches = true;
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
    pending[item.id] = {
      rootId: root.id,
      remoteId: root.remoteId,
      relative,
      item,
      hash,
      ...(item.encrypted
        ? { storedHash: (item as DriveItem & { contentHash?: string | null }).contentHash ?? null }
        : {}),
    };
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
    // Copies already waiting in the outbox are confirmed by flush; looking them up again here
    // only sends a second confirmation.
    const queued = this.pending();
    for (const candidate of batch) {
      if (signal?.aborted) return;
      if (queued[candidate.itemId]) continue;
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
  /**
   * Confirms the copies in the outbox: each is checked on disk first, then up to
   * SYNC_ACKNOWLEDGE_ITEMS are confirmed in one request.
   */
  async flush(signal?: AbortSignal) {
    const deadline = Date.now() + 5000;
    let ready: Ready[] = [];
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
        const body = await this.verified(id, root, receipt);
        if (!body) continue;
        ready.push({ id, root, receipt, body });
      } catch (error) {
        this.failed(id, root, receipt, error);
        continue;
      }
      if (ready.length >= SYNC_ACKNOWLEDGE_ITEMS) {
        await this.confirm(ready, signal);
        ready = [];
      }
    }
    if (ready.length && !signal?.aborted) await this.confirm(ready, signal);
  }
  /**
   * What confirming a copy sends, once the file on disk is checked to be that version and
   * flushed to it. Undefined when the copy no longer matches: the receipt is dropped.
   */
  private async verified(id: string, root: Root, receipt: Receipt) {
    // Only checks what is there: recreating a parent would undo the user deleting it.
    const full = await safeParents(root.localPath, receipt.relative, false);
    const stat = await lstat(full);
    if (receipt.item.type === 'FILE') {
      if (!stat.isFile() || (await hashFile(full)) !== receipt.hash) {
        this.remove(id, receipt);
        return undefined;
      }
      const { file, flushable } = await openToFlush(full);
      try {
        const verified = await file.stat();
        if (
          verified.size !== stat.size ||
          verified.mtimeMs !== stat.mtimeMs ||
          verified.ino !== stat.ino
        ) {
          this.remove(id, receipt);
          return undefined;
        }
        if (flushable) await file.sync();
      } finally {
        await file.close();
      }
    } else if (!stat.isDirectory()) {
      this.remove(id, receipt);
      return undefined;
    }
    // An encrypted version is confirmed by its stored hash, read from its versions when the
    // item didn't carry it.
    let stored = receipt.storedHash;
    if (stored === null) {
      const { items } = await this.api.request(`/v1/drive/items/${id}/versions`);
      stored =
        items.find((v: { id: string }) => v.id === receipt.item.currentVersionId)?.contentHash ??
        null;
    }
    return {
      versionId: receipt.item.currentVersionId,
      revision: receipt.item.revision,
      contentHash: stored === undefined ? receipt.hash : stored,
    };
  }
  private async confirm(ready: Ready[], signal?: AbortSignal) {
    const timeout = (ms: number) =>
      signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    if (this.batches && ready.length > 1) {
      try {
        const { results } = await this.api.request('/v1/sync/items/acknowledge', {
          method: 'POST',
          body: { items: ready.map(({ id, body }) => ({ itemId: id, ...body })) },
          signal: timeout(25_000),
        });
        ready.forEach(({ id, root, receipt }, n) => {
          const result = results?.[n];
          if (result?.error) {
            const { code, message } = result.error;
            this.failed(id, root, receipt, new ApiError(code, message, 409));
          } else this.confirmed(id, receipt, result?.ok === true);
        });
        return;
      } catch (error) {
        // An older server confirms one copy at a time.
        if (error instanceof ApiError && error.code === 'NOT_FOUND') this.batches = false;
        else {
          for (const { id, receipt } of ready) this.remove(id, receipt, true);
          return;
        }
      }
    }
    for (const { id, root, receipt, body } of ready) {
      if (signal?.aborted) return;
      try {
        const response = await this.api.request(`/v1/sync/items/${id}/acknowledge`, {
          method: 'POST',
          body,
          signal: timeout(8000),
        });
        this.confirmed(id, receipt, response?.ok === true);
      } catch (error) {
        this.failed(id, root, receipt, error);
      }
    }
  }
  private confirmed(id: string, receipt: Receipt, ok: boolean) {
    if (!ok) return this.remove(id, receipt, true);
    this.remove(id, receipt);
    this.journal.set('syncConfirmedAt', new Date().toISOString());
  }
  /** A copy that could not be confirmed: looked at again, or retried after the others. */
  private failed(id: string, root: Root, receipt: Receipt, error: unknown) {
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
/** A checked copy waiting to be confirmed; see SyncReceipts.flush. */
type Ready = {
  id: string;
  root: Root;
  receipt: Receipt;
  body: { versionId: string | null; revision: number; contentHash: string | null };
};
