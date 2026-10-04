import { expect, it, vi } from 'vitest';
import { writeFile, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { uploadFile } from '../src/transfers';
import { tick, twoComputers } from './two-computers';

vi.mock('../src/local-watcher', () => ({
  watchTree: () => ({
    on() {
      return this;
    },
    async close() {},
  }),
}));

it('tells the other computer why a folder stopped syncing when it was removed elsewhere', async () => {
  const { computers, folder } = await twoComputers();
  const [first, second] = computers;
  await writeFile(path.join(first.localPath, 'notes.txt'), 'kept');
  first.journal.enqueue(first.root.id, 'notes.txt', 'upsert');
  await tick(first);
  await tick(second);

  await second.engine.removeSyncedFolder(folder.id);
  await tick(first);
  expect(first.journal.roots()).toEqual([]);
  const notice = `“first” was removed from sync on another device. Your local files are still in ${first.localPath}.`;
  expect(first.engine.state.issues).toEqual([
    expect.objectContaining({ code: 'SYNC_DETACHED', rootId: '', message: notice }),
  ]);
  expect(first.notices).toEqual([`Folder stopped syncing: ${notice}`]);
  expect(await readFile(path.join(first.localPath, 'notes.txt'), 'utf8')).toBe('kept');
  // The computer that removed it did so itself: nothing to explain there.
  expect(second.engine.state.issues).toEqual([]);
  expect(second.notices).toEqual([]);

  // The notice stays through later passes until dismissed.
  await tick(first);
  expect(first.engine.state.issues).toHaveLength(1);
  first.engine.dismissConflict(first.engine.state.issues[0].id);
  expect(first.engine.state.issues).toEqual([]);
});

it('names a file that is illegal locally with its suffix before the extension', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first] = computers;
  const source = path.join(first.localPath, '..', 'source');
  await writeFile(source, 'q3');
  const item = await uploadFile(
    cloud,
    source,
    'Q3: plan #2 (50%).txt',
    folder.id,
    { operationId: crypto.randomUUID() },
    () => {},
  );
  await tick(first);
  expect(await readdir(first.localPath)).toEqual([`Q3_ plan #2 (50%)~${item.id.slice(0, 8)}.txt`]);
});

it('keeps a file synced under the old-style local name where it is', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first] = computers;
  await writeFile(path.join(first.localPath, '..', 'source'), 'v1');
  const item = await uploadFile(
    cloud,
    path.join(first.localPath, '..', 'source'),
    'a:b.txt',
    folder.id,
    { operationId: crypto.randomUUID() },
    () => {},
  );
  await tick(first);
  // As an earlier version left it: the suffix after the extension, recorded in the journal.
  const legacy = `a_b.txt~${item.id.slice(0, 8)}`;
  const current = `a_b~${item.id.slice(0, 8)}.txt`;
  await rename(path.join(first.localPath, current), path.join(first.localPath, legacy));
  const known = first.journal.fileByItem(first.root.id, item.id)!;
  first.journal.deleteFile(first.root.id, current);
  first.journal.putFile({ ...known, relativePath: legacy });
  first.journal.root({ ...first.journal.roots()[0], needsReconcile: true });

  await tick(first);
  expect(await readdir(first.localPath)).toEqual([legacy]);
  expect(first.journal.jobs()).toEqual([]);

  // A new version from the cloud still lands in the same local file.
  await writeFile(path.join(first.localPath, '..', 'source'), 'v2');
  await uploadFile(
    cloud,
    path.join(first.localPath, '..', 'source'),
    'a:b.txt',
    folder.id,
    { operationId: crypto.randomUUID() },
    () => {},
    {
      itemId: item.id,
      revision: (await cloud.request(`/v1/drive/items/${item.id}`)).item.revision,
    },
  );
  await tick(first);
  expect(await readdir(first.localPath)).toEqual([legacy]);
  expect(await readFile(path.join(first.localPath, legacy), 'utf8')).toBe('v2');
});
