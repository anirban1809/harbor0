import { expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { userPK, type Account } from '../../backend/src/domain';
import { transact } from '../../backend/src/repository';
import { tick, twoComputers } from './two-computers';

// Changes are queued by hand, as the watcher would; files, engine, API and hashes are real.
vi.mock('../src/local-watcher', () => ({
  watchTree: () => ({
    on() {
      return this;
    },
    async close() {},
  }),
}));

it('removes a deleted folder and its synced files everywhere, without bringing it back', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await mkdir(path.join(first.localPath, 'Docs', 'Inner'), { recursive: true });
  await writeFile(path.join(first.localPath, 'Docs', 'a.txt'), 'a');
  await writeFile(path.join(first.localPath, 'Docs', 'Inner', 'b.txt'), 'b');
  for (const relative of ['Docs', 'Docs/a.txt', 'Docs/Inner', 'Docs/Inner/b.txt'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  await tick(first);
  await tick(second);
  expect((await readdir(path.join(second.localPath, 'Docs'))).sort()).toEqual(['Inner', 'a.txt']);

  // Delete the whole folder on the first computer; the watcher reports the folder and its files.
  await rm(path.join(first.localPath, 'Docs'), { recursive: true });
  for (const relative of ['Docs/Inner/b.txt', 'Docs/a.txt', 'Docs/Inner', 'Docs'])
    first.journal.enqueue(first.root.id, relative, 'delete');
  await tick(first);
  await tick(second);
  await tick(first);
  await tick(second);

  expect((await cloud.list(folder.id)).items).toEqual([]);
  expect(await readdir(first.localPath)).toEqual([]);
  // Nothing on the second computer had unsynced work, so nothing needs recovering.
  expect(await readdir(second.localPath)).toEqual([]);
  expect(first.engine.state.issues).toEqual([]);
  expect(second.engine.state.issues).toEqual([]);
});

it('keeps unsynced work from a remotely deleted folder without re-creating the folder', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await mkdir(path.join(first.localPath, 'Docs'));
  await writeFile(path.join(first.localPath, 'Docs', 'a.txt'), 'a');
  for (const relative of ['Docs', 'Docs/a.txt'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  await tick(first);
  await tick(second);
  // The second computer has an edit the cloud has not seen yet.
  await writeFile(path.join(second.localPath, 'Docs', 'draft.txt'), 'unsynced');
  await rm(path.join(first.localPath, 'Docs'), { recursive: true });
  for (const relative of ['Docs/a.txt', 'Docs'])
    first.journal.enqueue(first.root.id, relative, 'delete');
  await tick(first);
  await tick(second);
  await tick(first);
  await tick(second);

  const [kept] = await readdir(second.localPath);
  expect(kept).toMatch(/^Docs \(Recovered by harbor0 /);
  expect(await readdir(path.join(second.localPath, kept))).toEqual(['draft.txt']);
  expect((await cloud.list(folder.id)).items).toEqual([]);
  expect(await readdir(first.localPath)).toEqual([]);
});

it('syncs a local rename or move as a move of the cloud item, even with storage full', async () => {
  const { computers, folder, cloud, service } = await twoComputers();
  const [first, second] = computers;
  await mkdir(path.join(first.localPath, 'Archive'));
  await writeFile(path.join(first.localPath, 'report.txt'), 'quarterly numbers');
  for (const relative of ['Archive', 'report.txt'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  await tick(first);
  await tick(second);
  const original = (await cloud.list(folder.id)).items.find((i) => i.name === 'report.txt')!;
  // No room for even one more byte: re-uploading the file could not succeed.
  await transact(service.repo, async (tx) => {
    const account = (await tx.get<Account>(userPK('alice'), 'PROFILE'))!;
    await tx.put(userPK('alice'), 'PROFILE', {
      ...account,
      storageQuotaBytes: account.storageUsedBytes,
    });
  });

  // Rename and move in one step; the watcher may report the new path first.
  await rename(
    path.join(first.localPath, 'report.txt'),
    path.join(first.localPath, 'Archive', 'report 2026.txt'),
  );
  first.journal.enqueue(first.root.id, 'Archive/report 2026.txt', 'upsert');
  first.journal.enqueue(first.root.id, 'report.txt', 'delete');
  await tick(first);
  await tick(second);

  expect(first.journal.jobs()).toEqual([]);
  expect(first.engine.state.issues).toEqual([]);
  const archive = (await cloud.list(folder.id)).items.find((i) => i.name === 'Archive')!;
  expect((await cloud.list(folder.id)).items.map((i) => i.name)).toEqual(['Archive']);
  const moved = (await cloud.list(archive.id)).items;
  expect(moved).toEqual([expect.objectContaining({ id: original.id, name: 'report 2026.txt' })]);
  expect(moved[0].currentVersionId).toBe(original.currentVersionId);
  expect(await readFile(path.join(second.localPath, 'Archive', 'report 2026.txt'), 'utf8')).toBe(
    'quarterly numbers',
  );
  expect(await readdir(second.localPath)).toEqual(['Archive']);

  // Reported the other way round, a plain rename is a move too.
  await rename(
    path.join(first.localPath, 'Archive', 'report 2026.txt'),
    path.join(first.localPath, 'Archive', 'final.txt'),
  );
  first.journal.enqueue(first.root.id, 'Archive/report 2026.txt', 'delete');
  first.journal.enqueue(first.root.id, 'Archive/final.txt', 'upsert');
  await tick(first);
  expect(first.journal.jobs()).toEqual([]);
  expect((await cloud.list(archive.id)).items.map((i) => [i.id, i.name])).toEqual([
    [original.id, 'final.txt'],
  ]);
});

it('treats a rename whose content also changed as a new file and a deletion', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first] = computers;
  await writeFile(path.join(first.localPath, 'a.txt'), 'one');
  first.journal.enqueue(first.root.id, 'a.txt', 'upsert');
  await tick(first);
  await rm(path.join(first.localPath, 'a.txt'));
  await writeFile(path.join(first.localPath, 'b.txt'), 'two');
  first.journal.enqueue(first.root.id, 'a.txt', 'delete');
  first.journal.enqueue(first.root.id, 'b.txt', 'upsert');
  await tick(first);
  expect((await cloud.list(folder.id)).items.map((i) => i.name)).toEqual(['b.txt']);
});
