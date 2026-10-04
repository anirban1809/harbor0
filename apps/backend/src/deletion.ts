import { assertBackupMutable } from './backup-policy';
import type { DriveItem, FileVersion } from '@harbor/contracts';
import { emptied, StorageService, userPK, type Account } from './domain';
import { transact, type Transaction } from './repository';
import { assert } from './errors';
type PurgingItem = DriveItem & { purging?: boolean };
type Work = { itemId: string; phase: 'CHILDREN' | 'VERSIONS'; cursor?: string };
/**
 * `budget` is the part of the item's bytes already taken out of `storageUsedBytes` (moved to
 * `purgingBytes`) when it was emptied or permanently deleted; the purge draws it down.
 */
type PurgeMeta = { userId: string; id: string; budget?: number };
/** Bytes counted so far for a trashed item; `deletedAt` ties it to one stay in the trash. */
type TrashSize = { deletedAt: string; bytes: number };
const sizeKey = (id: string) => `TRASHSIZE#${id}`;
const measurePK = (id: string, deletedAt: string) => `MEASURE#${id}#${deletedAt}`;
// Detaching writes about ten rows; keep each transaction well under DynamoDB's 100-item limit.
const EMPTY_BATCH = 5;
/**
 * Permanent deletion is instant for the user: the item disappears and its bytes leave the storage
 * ledger in the request, using a size measured while the item sat in the trash. Version and
 * object cleanup then runs here in durable background batches.
 */
export class DeletionWorkflows {
  constructor(private service: StorageService) {}
  async start(userId: string, id: string, input: { operationId: string; baseRevision: number }) {
    const s = this.service;
    return s.operation(
      userId,
      input.operationId,
      { action: 'permanent', itemId: id, ...input },
      async (tx) => {
        const item = await s.owned(tx, userId, id, true);
        assert(item.deletedAt, 'INVALID_STATE', 'Move this item to trash first.', 409);
        assert(
          item.revision === input.baseRevision,
          'REVISION_CONFLICT',
          'The item changed.',
          409,
          { serverItem: item },
        );
        await this.detach(tx, userId, item);
        return { deleted: false, jobId: id };
      },
    );
  }
  async detach(tx: Transaction, userId: string, item: DriveItem) {
    const s = this.service;
    await assertBackupMutable(tx, userId, item.id, true);
    const id = item.id;
    const detached = {
      ...item,
      purging: true,
      revision: item.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    let budget = 0;
    const size = await tx.get<TrashSize>(userPK(userId), sizeKey(id));
    if (size) {
      await tx.delete(userPK(userId), sizeKey(id));
      if (size.deletedAt === item.deletedAt) {
        budget = size.bytes;
        const account = await s.account(tx, userId);
        // Emptying the trash already moved these bytes; a single deletion moves them now.
        if (!emptied(item, account)) {
          account.trashBytes = Math.max(0, (account.trashBytes ?? 0) - budget);
          account.storageUsedBytes -= budget;
          account.purgingBytes = (account.purgingBytes ?? 0) + budget;
          await s.storageAlert(tx, account);
          await tx.put(userPK(userId), 'PROFILE', account);
        }
      }
    }
    await tx.put(userPK(userId), `ITEM#${id}`, detached);
    await tx.put(`PURGE#${id}`, 'META', { userId, id, budget } satisfies PurgeMeta);
    await tx.put(`PURGE#${id}`, `WORK#${id}`, { itemId: id, phase: 'CHILDREN' } satisfies Work);
    await s.job(tx, {
      id: `purge-${id}`,
      type: 'PERMANENT_DELETE',
      entityId: id,
      userId,
      dueAt: new Date().toISOString(),
      attempts: 0,
    });
    await s.record(tx, userId, 'FILE_DELETED', id, detached);
  }
  /** Runs in the transaction that moves `item` (already stamped `deletedAt`) to the trash. */
  async trashed(tx: Transaction, userId: string, item: DriveItem) {
    const deletedAt = item.deletedAt!;
    const size: TrashSize = { deletedAt, bytes: 0 };
    if (item.type === 'FILE') size.bytes = await this.versionBytes(userId, item.id);
    else {
      // Folders can hold any number of files, so they are measured in the background.
      await tx.put(measurePK(item.id, deletedAt), `WORK#${item.id}`, {
        itemId: item.id,
        phase: 'CHILDREN',
      } satisfies Work);
      await this.service.job(tx, {
        id: `measure-${item.id}-${deletedAt}`,
        type: 'TRASH_MEASURE',
        entityId: item.id,
        key: deletedAt,
        userId,
        dueAt: new Date().toISOString(),
        attempts: 0,
      });
    }
    await tx.put(userPK(userId), sizeKey(item.id), size);
    if (size.bytes) await this.count(tx, userId, item, size.bytes);
  }
  /**
   * Drops a trashed item's measured size when it leaves the trash other than through its own
   * purge (restored, or deleted by an ancestor's purge). Bytes already moved out of the ledger by
   * emptying return to it, since whatever removes the versions releases them itself.
   */
  async forget(tx: Transaction, userId: string, item: DriveItem) {
    const size = await tx.get<TrashSize>(userPK(userId), sizeKey(item.id));
    if (!size) return;
    await tx.delete(userPK(userId), sizeKey(item.id));
    if (size.deletedAt !== item.deletedAt || !size.bytes) return;
    const account = await this.service.account(tx, userId);
    if (emptied(item, account)) {
      account.storageUsedBytes += size.bytes;
      account.purgingBytes = (account.purgingBytes ?? 0) - size.bytes;
    } else account.trashBytes = Math.max(0, (account.trashBytes ?? 0) - size.bytes);
    await tx.put(userPK(userId), 'PROFILE', account);
  }
  /** Adds measured bytes of trashed `root` to the trash total, or straight out of the ledger. */
  private async count(tx: Transaction, userId: string, root: DriveItem, bytes: number) {
    const account: Account = await this.service.account(tx, userId);
    if (emptied(root, account)) {
      account.storageUsedBytes -= bytes;
      account.purgingBytes = (account.purgingBytes ?? 0) + bytes;
      await this.service.storageAlert(tx, account);
    } else account.trashBytes = (account.trashBytes ?? 0) + bytes;
    await tx.put(userPK(userId), 'PROFILE', account);
  }
  /**
   * Bytes deleting a file frees: every version except legacy device-only ones and those a
   * transfer pins, which stay charged until it releases them. Pins in the trash only ever end.
   */
  private async versionBytes(userId: string, itemId: string) {
    const repo = this.service.repo;
    let bytes = 0;
    let cursor: string | undefined;
    do {
      const page = await repo.query(userPK(userId), `VERSION#${itemId}#`, 100, cursor);
      for (const row of page.rows) {
        const version = row.data as FileVersion;
        if (version.cloudState === 'RELEASED') continue;
        const pin = await repo.get({ pk: `PIN#${version.storageObjectId}`, sk: userId });
        if (!(pin?.data as { count?: number } | undefined)?.count) bytes += version.sizeBytes;
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return bytes;
  }
  /**
   * Walks a trashed folder, adding each file's bytes to its trash size. A trashed subtree cannot
   * change, so reads outside the transaction are stable. Items trashed on their own are skipped:
   * they carry their own size. Abandons the walk once the folder leaves this stay in the trash.
   */
  async measure(userId: string, id: string, deletedAt: string, until = Date.now() + 30_000) {
    const s = this.service;
    const pk = measurePK(id, deletedAt);
    while (Date.now() < until) {
      const page = await s.repo.query(pk, 'WORK#', 1);
      if (!page.rows.length) return true;
      const key = page.rows[0].sk;
      const work = page.rows[0].data as Work;
      const children =
        work.phase === 'CHILDREN'
          ? await s.repo.query(userPK(userId), `ALLCHILD#${work.itemId}#`, 25, work.cursor)
          : undefined;
      const next: Work[] = [];
      for (const row of children?.rows ?? []) {
        const child = (
          await s.repo.get({ pk: userPK(userId), sk: `ITEM#${(row.data as { id: string }).id}` })
        )?.data as DriveItem | undefined;
        if (child && !child.deletedAt)
          next.push({ itemId: child.id, phase: child.type === 'FILE' ? 'VERSIONS' : 'CHILDREN' });
      }
      const bytes = work.phase === 'VERSIONS' ? await this.versionBytes(userId, work.itemId) : 0;
      await transact(s.repo, async (tx) => {
        const current = await tx.get<Work>(pk, key);
        if (!current || current.cursor !== work.cursor) return;
        const root = await tx.get<PurgingItem>(userPK(userId), `ITEM#${id}`);
        const size = await tx.get<TrashSize>(userPK(userId), sizeKey(id));
        if (root?.purging || root?.deletedAt !== deletedAt || size?.deletedAt !== deletedAt) {
          await tx.delete(pk, key);
          return;
        }
        for (const child of next) await tx.put(pk, `WORK#${child.itemId}`, child);
        if (children?.cursor) {
          await tx.put(pk, key, { ...work, cursor: children.cursor });
          return;
        }
        await tx.delete(pk, key);
        if (!bytes) return;
        await tx.put(userPK(userId), sizeKey(id), { ...size, bytes: size.bytes + bytes });
        await this.count(tx, userId, root, bytes);
      });
    }
    return false;
  }
  /** Queues the background pass that detaches every emptied item, restarting any pass under way. */
  async scheduleEmpty(tx: Transaction, userId: string) {
    await tx.put(userPK(userId), 'TRASH_EMPTY', { cursor: null });
    await this.service.job(tx, {
      id: `empty-trash-${userId}`,
      type: 'TRASH_EMPTY',
      userId,
      dueAt: new Date().toISOString(),
      attempts: 0,
    });
  }
  /** Detaches the items emptied from the trash, scanning the owner's items page by page. */
  async empty(userId: string, until = Date.now() + 30_000) {
    const s = this.service;
    while (Date.now() < until) {
      const state = (await s.repo.get({ pk: userPK(userId), sk: 'TRASH_EMPTY' }))?.data as
        { cursor: string | null } | undefined;
      if (!state) return true;
      const account = (await s.repo.get({ pk: userPK(userId), sk: 'PROFILE' }))?.data as Account;
      const page = await s.repo.query(userPK(userId), 'ITEM#', 200, state.cursor ?? undefined);
      const due = page.rows
        .map((row) => row.data as PurgingItem)
        .filter((item) => !item.purging && emptied(item, account));
      for (let i = 0; i < due.length; i += EMPTY_BATCH)
        await transact(s.repo, async (tx) => {
          for (const candidate of due.slice(i, i + EMPTY_BATCH)) {
            const item = await tx.get<PurgingItem>(userPK(userId), `ITEM#${candidate.id}`);
            if (item && !item.purging && item.deletedAt === candidate.deletedAt)
              await this.detach(tx, userId, item);
          }
        });
      const restarted = await transact(s.repo, async (tx) => {
        const current = await tx.get<{ cursor: string | null }>(userPK(userId), 'TRASH_EMPTY');
        // Emptying again meanwhile reset the pass; follow the new one from the start.
        if (!current || current.cursor !== state.cursor) return true;
        if (page.cursor) await tx.put(userPK(userId), 'TRASH_EMPTY', { cursor: page.cursor });
        else await tx.delete(userPK(userId), 'TRASH_EMPTY');
        return false;
      });
      if (!restarted && !page.cursor) return true;
    }
    return false;
  }
  async step(userId: string, id: string, until = Date.now() + 30_000) {
    const s = this.service;
    let cursor: string | undefined;
    let progressed = false;
    while (Date.now() < until) {
      const page = await s.repo.query(`PURGE#${id}`, 'WORK#', 1, cursor);
      if (!page.rows.length && !cursor) {
        await this.settle(userId, id);
        return true;
      }
      if (!page.rows.length) {
        // A full pass over the work is done; if only transfer-pinned versions held it up,
        // retry on a later run.
        if (!progressed) return false;
        cursor = undefined;
        progressed = false;
        continue;
      }
      const key = page.rows[0].sk;
      const stalled = await transact(s.repo, async (tx) => {
        const work = await tx.get<Work>(`PURGE#${id}`, key);
        if (!work) return;
        const item = await tx.get<PurgingItem>(userPK(userId), `ITEM#${work.itemId}`);
        if (!item) {
          await tx.delete(`PURGE#${id}`, key);
          return;
        }
        await assertBackupMutable(tx, userId, item.id, true);
        await s.account(tx, userId);
        if (!item.purging) {
          item.purging = true;
          await tx.put(userPK(userId), `ITEM#${item.id}`, item);
        }
        if (work.phase === 'CHILDREN') {
          const children = await s.repo.query(
            userPK(userId),
            `ALLCHILD#${item.id}#`,
            15,
            work.cursor,
          );
          for (const row of children.rows) {
            const childId = (row.data as { id: string }).id;
            // A descendant trashed on its own is listed in the trash by itself; it stays there
            // (restoring it to My Drive once this parent is gone) until it is deleted itself.
            const child = await tx.get<PurgingItem>(userPK(userId), `ITEM#${childId}`);
            if (child?.deletedAt) continue;
            if (!(await tx.get(`PURGE#${id}`, `WORK#${childId}`)))
              await tx.put(`PURGE#${id}`, `WORK#${childId}`, {
                itemId: childId,
                phase: 'CHILDREN',
              } satisfies Work);
          }
          if (children.cursor) work.cursor = children.cursor;
          else {
            work.phase = 'VERSIONS';
            delete work.cursor;
          }
          await tx.put(`PURGE#${id}`, key, work);
          return;
        }
        const versions = await s.repo.query(userPK(userId), `VERSION#${item.id}#`, 8);
        let removed = 0;
        let retained = false;
        for (const row of versions.rows) {
          const version = await tx.get<FileVersion>(row.pk, row.sk);
          if (!version) continue;
          if (version.cloudState === 'RELEASED') {
            await tx.delete(row.pk, row.sk);
            continue;
          }
          const pin = await tx.get<{ count: number }>(`PIN#${version.storageObjectId}`, userId);
          if (pin?.count) {
            retained = true;
            continue;
          }
          await s.reference(tx, version.storageObjectId, -1);
          removed += version.sizeBytes;
          await tx.delete(row.pk, row.sk);
        }
        if (removed) {
          // Bytes the user already saw released come out of the budget, the rest out of the ledger.
          const meta = await tx.get<PurgeMeta>(`PURGE#${id}`, 'META');
          const covered = Math.min(removed, meta?.budget ?? 0);
          const account = await s.account(tx, userId);
          account.storageUsedBytes -= removed - covered;
          account.purgingBytes = (account.purgingBytes ?? 0) - covered;
          await s.storageAlert(tx, account);
          await tx.put(userPK(userId), 'PROFILE', account);
          if (meta && covered)
            await tx.put(`PURGE#${id}`, 'META', { ...meta, budget: meta.budget! - covered });
        }
        if (retained) return true;
        if (versions.cursor) return;
        if (!item.deletedAt)
          await s.reserveName(tx, { ...item, deletedAt: new Date().toISOString() }, item);
        // A descendant trashed on its own goes with this item, so its own size no longer applies.
        else if (item.id !== id) await this.forget(tx, userId, item);
        await tx.delete(userPK(userId), `ALLCHILD#${item.parentId ?? 'root'}#${item.id}`);
        await tx.delete(userPK(userId), `ITEM#${item.id}`);
        await tx.delete('ITEMOWNER', item.id);
        await tx.delete(`PURGE#${id}`, key);
        await s.record(tx, userId, 'FILE_DELETED', item.id, {
          ...item,
          deletedAt: new Date().toISOString(),
          revision: item.revision + 1,
        });
      });
      if (!stalled) progressed = true;
      cursor = page.cursor ?? undefined;
      if (!cursor) {
        if (!progressed) return false;
        progressed = false;
      }
    }
    return false;
  }
  /**
   * Returns any unspent budget to the ledger once the purge is done. Budget is unspent when an
   * ancestor's purge deleted part of this item first and released those bytes itself.
   */
  private async settle(userId: string, id: string) {
    await transact(this.service.repo, async (tx) => {
      const meta = await tx.get<PurgeMeta>(`PURGE#${id}`, 'META');
      if (!meta?.budget) return;
      const account = await this.service.account(tx, userId);
      account.storageUsedBytes += meta.budget;
      account.purgingBytes = (account.purgingBytes ?? 0) - meta.budget;
      await tx.put(userPK(userId), 'PROFILE', account);
      await tx.put(`PURGE#${id}`, 'META', { ...meta, budget: 0 });
    });
  }
}
