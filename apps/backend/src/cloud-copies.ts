import type { FileVersion } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { Transaction, transact } from './repository';
import type { Save, StagedItem } from './workflows';

// "Copy to cloud" was removed once synced folders started keeping their files in the cloud.
// Copies that were still being made when it was removed are abandoned: their hidden, partially
// copied tree is deleted and the reserved storage returned. Finished copies are ordinary folders.
type Copy = Save & { rootId: string; released?: boolean };
type Entry = { id: string; sourceId: string };
type CopyWait = { copies: Record<string, string> };

export async function abandonCloudCopy(s: StorageService, id: string) {
  const copy = await new Transaction(s.repo).get<Copy>(`SAVE#${id}`, 'META');
  if (!copy || copy.state === 'COMPLETED' || copy.released) return true;
  const page = await s.repo.query(`SAVE#${id}`, 'ENTRY#', 10);
  for (const row of page.rows)
    await transact(s.repo, async (tx) => {
      const entry = await tx.get<Entry>(row.pk, row.sk);
      if (!entry) return;
      const item = await tx.get<StagedItem>(userPK(copy.userId), `ITEM#${entry.id}`);
      if (item) {
        if (item.currentVersionId) {
          const version = await tx.get<FileVersion>(
            userPK(copy.userId),
            `VERSION#${item.id}#${item.currentVersionId}`,
          );
          if (version) {
            await s.reference(tx, version.storageObjectId, -1);
            await tx.delete(userPK(copy.userId), `VERSION#${item.id}#${version.id}`);
          }
        }
        await s.reserveName(tx, { ...item, deletedAt: new Date().toISOString() }, item);
        await tx.delete(userPK(copy.userId), `ITEM#${item.id}`);
        await tx.delete(userPK(copy.userId), `ALLCHILD#${item.parentId ?? 'root'}#${item.id}`);
        await tx.delete('ITEMOWNER', item.id);
      }
      const wait = await tx.get<CopyWait>(userPK(copy.userId), `CLOUDCOPYWAIT#${entry.sourceId}`);
      if (wait) await tx.delete(userPK(copy.userId), `CLOUDCOPYWAIT#${entry.sourceId}`);
      await tx.delete(row.pk, row.sk);
    });
  if (page.cursor) return false;
  await transact(s.repo, async (tx) => {
    const current = await tx.get<Copy>(`SAVE#${id}`, 'META');
    if (!current || current.released || current.state === 'COMPLETED') return;
    const account = await s.account(tx, copy.userId);
    account.storageReservedBytes = Math.max(0, account.storageReservedBytes - current.bytes);
    await tx.put(userPK(copy.userId), 'PROFILE', account);
    await tx.put(`SAVE#${id}`, 'META', {
      ...current,
      state: 'FAILED',
      error: 'Copy to cloud is no longer available. Synced folders are kept in the cloud.',
      released: true,
    });
  });
  return true;
}
