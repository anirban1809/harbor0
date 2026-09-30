import { assertBackupMutable } from './backup-policy';
import type { DriveItem, FileVersion } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { transact, type Transaction } from './repository';
import { assert } from './errors';
type PurgingItem = DriveItem & { purging?: boolean };
type Work = { itemId: string; phase: 'CHILDREN' | 'VERSIONS'; cursor?: string };
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
    await tx.put(userPK(userId), `ITEM#${id}`, detached);
    await tx.put(`PURGE#${id}`, 'META', { userId, id });
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
  async step(userId: string, id: string) {
    const s = this.service;
    let cursor: string | undefined;
    for (let n = 0; n < 30; n++) {
      const page = await s.repo.query(`PURGE#${id}`, 'WORK#', 1, cursor);
      if (!page.rows.length) return !(await s.repo.query(`PURGE#${id}`, 'WORK#', 1)).rows.length;
      const key = page.rows[0].sk;
      await transact(s.repo, async (tx) => {
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
        const account = await s.account(tx, userId);
        account.storageUsedBytes -= removed;
        await tx.put(userPK(userId), 'PROFILE', account);
        if (retained) return true;
        if (versions.cursor) return;
        if (!item.deletedAt)
          await s.reserveName(tx, { ...item, deletedAt: new Date().toISOString() }, item);
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
      cursor = page.cursor ?? undefined;
      if (!page.cursor) return !(await s.repo.query(`PURGE#${id}`, 'WORK#', 1)).rows.length;
    }
    return false;
  }
}
