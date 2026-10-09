import { expect, it, vi } from 'vitest';
import { lstat, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { userPK, type Account } from '../../backend/src/domain';
import { transact } from '../../backend/src/repository';
import { tick, twoComputers } from './two-computers';

// Changes are queued by hand, as the watcher would; files, engine, API and hashes are real.
// A test can also report paths through a root's watcher, as the OS would.
const watchers = vi.hoisted(
  () => new Map<string, Record<string, (full: string, info?: unknown) => void>>(),
);
vi.mock('../src/local-watcher', () => ({
  watchTree: (root: string) => {
    const listeners: Record<string, (full: string, info?: unknown) => void> = {};
    watchers.set(root, listeners);
    return {
      on(event: string, listener: (full: string, info?: unknown) => void) {
        listeners[event] = listener;
        return this;
      },
      async close() {},
    };
  },
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

it('removes the local copy of a file or folder moved out of the sync folder in the cloud', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await mkdir(path.join(first.localPath, 'Docs'));
  await writeFile(path.join(first.localPath, 'Docs', 'a.txt'), 'a');
  await writeFile(path.join(first.localPath, 'notes.txt'), 'notes');
  await writeFile(path.join(first.localPath, 'draft.txt'), 'draft');
  for (const relative of ['Docs', 'Docs/a.txt', 'notes.txt', 'draft.txt'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  await tick(first);
  await tick(second);
  expect((await readdir(second.localPath)).sort()).toEqual(['Docs', 'draft.txt', 'notes.txt']);

  // The second computer has an edit to draft.txt the cloud has not seen yet.
  await writeFile(path.join(second.localPath, 'draft.txt'), 'unsynced edit');
  const outside = (await cloud.createFolder('Elsewhere')).item;
  for (const item of (await cloud.list(folder.id)).items)
    await cloud.request(`/v1/drive/items/${item.id}/move`, {
      method: 'POST',
      body: { operationId: crypto.randomUUID(), baseRevision: item.revision, parentId: outside.id },
    });
  await tick(first);
  await tick(second);

  expect(await readdir(first.localPath)).toEqual([]);
  // Only the unsynced edit stays behind, as a conflict copy.
  const left = await readdir(second.localPath);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatch(/^draft \(Conflict/);
  expect(await readFile(path.join(second.localPath, left[0]), 'utf8')).toBe('unsynced edit');
  expect(first.journal.files(first.root.id)).toEqual([]);
  expect(second.journal.files(second.root.id).map((f) => f.relativePath)).toEqual(left);
  // The moved items are untouched in the cloud.
  expect((await cloud.list(outside.id)).items.map((i) => i.name).sort()).toEqual([
    'Docs',
    'draft.txt',
    'notes.txt',
  ]);
});

it('syncs a capitalization-only rename as a rename, on any file system', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await writeFile(path.join(first.localPath, 'Notes.txt'), 'meeting notes');
  first.journal.enqueue(first.root.id, 'Notes.txt', 'upsert');
  await tick(first);
  await tick(second);
  const original = (await cloud.list(folder.id)).items[0];

  await rename(path.join(first.localPath, 'Notes.txt'), path.join(first.localPath, 'notes.txt'));
  // A case-sensitive disk reports the old name gone; on macOS and Windows it still resolves.
  first.journal.enqueue(first.root.id, 'notes.txt', 'upsert');
  first.journal.enqueue(first.root.id, 'Notes.txt', 'delete');
  for (let i = 0; i < 3; i++) {
    await tick(first);
    await tick(second);
  }

  expect(first.journal.jobs()).toEqual([]);
  expect(first.engine.state.issues).toEqual([]);
  expect(second.engine.state.issues).toEqual([]);
  expect((await cloud.list(folder.id)).items.map((i) => [i.id, i.name])).toEqual([
    [original.id, 'notes.txt'],
  ]);
  expect(await readdir(first.localPath)).toEqual(['notes.txt']);
  expect(await readdir(second.localPath)).toEqual(['notes.txt']);
  expect(first.journal.files(first.root.id).map((f) => f.relativePath)).toEqual(['notes.txt']);
  expect(second.journal.files(second.root.id).map((f) => f.relativePath)).toEqual(['notes.txt']);
});

it('syncs a capitalization-only rename together with an edit to the same file', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await writeFile(path.join(first.localPath, 'Plan.txt'), 'draft');
  first.journal.enqueue(first.root.id, 'Plan.txt', 'upsert');
  await tick(first);
  await tick(second);
  const original = (await cloud.list(folder.id)).items[0];

  await rename(path.join(first.localPath, 'Plan.txt'), path.join(first.localPath, 'plan.txt'));
  await writeFile(path.join(first.localPath, 'plan.txt'), 'final');
  first.journal.enqueue(first.root.id, 'plan.txt', 'upsert');
  first.journal.enqueue(first.root.id, 'Plan.txt', 'delete');
  for (let i = 0; i < 3; i++) {
    await tick(first);
    await tick(second);
  }

  expect(first.engine.state.issues).toEqual([]);
  expect(second.engine.state.issues).toEqual([]);
  const [item] = (await cloud.list(folder.id)).items;
  expect([item.id, item.name, item.revision > original.revision]).toEqual([
    original.id,
    'plan.txt',
    true,
  ]);
  expect(await readdir(second.localPath)).toEqual(['plan.txt']);
  expect(await readFile(path.join(second.localPath, 'plan.txt'), 'utf8')).toBe('final');
});

it('syncs a capitalization-only rename of a folder', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await mkdir(path.join(first.localPath, 'Docs'));
  await writeFile(path.join(first.localPath, 'Docs', 'a.txt'), 'a');
  for (const relative of ['Docs', 'Docs/a.txt'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  await tick(first);
  await tick(second);
  const original = (await cloud.list(folder.id)).items[0];

  await rename(path.join(first.localPath, 'Docs'), path.join(first.localPath, 'docs'));
  // The watcher walks the renamed folder, and its reports can be handled in any order; a
  // case-sensitive disk also reports the old paths gone.
  for (const relative of ['docs/a.txt', 'docs'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  for (const relative of ['Docs/a.txt', 'Docs'])
    first.journal.enqueue(first.root.id, relative, 'delete');
  for (let i = 0; i < 3; i++) {
    await tick(first);
    await tick(second);
  }

  expect(first.journal.jobs()).toEqual([]);
  expect(first.engine.state.issues).toEqual([]);
  expect(second.engine.state.issues).toEqual([]);
  expect((await cloud.list(folder.id)).items.map((i) => [i.id, i.name])).toEqual([
    [original.id, 'docs'],
  ]);
  expect((await cloud.list(original.id)).items.map((i) => i.name)).toEqual(['a.txt']);
  for (const computer of [first, second]) {
    expect(await readdir(computer.localPath)).toEqual(['docs']);
    expect(await readdir(path.join(computer.localPath, 'docs'))).toEqual(['a.txt']);
    expect(
      computer.journal
        .files(computer.root.id)
        .map((f) => f.relativePath)
        .sort(),
    ).toEqual(['docs', 'docs/a.txt']);
  }
});

it('ignores the old spelling the watcher reports after a capitalization-only rename', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await writeFile(path.join(first.localPath, 'Budget.xlsx'), 'numbers');
  first.journal.enqueue(first.root.id, 'Budget.xlsx', 'upsert');
  await tick(first);
  await tick(second);
  const item = (await cloud.list(folder.id)).items[0];
  await cloud.request(`/v1/drive/items/${item.id}`, {
    method: 'PATCH',
    body: { operationId: crypto.randomUUID(), baseRevision: item.revision, name: 'budget.xlsx' },
  });
  await tick(second);
  // Renaming the file locally makes the watcher report both spellings.
  second.journal.enqueue(second.root.id, 'Budget.xlsx', 'upsert');
  second.journal.enqueue(second.root.id, 'budget.xlsx', 'upsert');
  await tick(second);
  await tick(first);

  for (const computer of [first, second]) {
    expect(computer.journal.jobs()).toEqual([]);
    expect(computer.engine.state.issues).toEqual([]);
    expect(await readdir(computer.localPath)).toEqual(['budget.xlsx']);
  }
  expect((await cloud.list(folder.id)).items.map((i) => [i.id, i.name])).toEqual([
    [item.id, 'budget.xlsx'],
  ]);
});

const B = ['Folder B', 'Folder B/f0.txt', 'Folder B/f1.txt', 'Folder B/f2.txt'].map(
  (relative) => ['upsert', relative] as const,
);
// As the watcher reports a removed folder: its synced contents, then the folder.
const A = ['Folder A/f0.txt', 'Folder A/f1.txt', 'Folder A/f2.txt', 'Folder A'].map(
  (relative) => ['delete', relative] as const,
);
it.each([
  ['the new folder first', [...B, ...A]],
  ['the old folder first', [...A, ...B]],
  // The old folder's own deletion comes before one of its files has been matched to its move.
  ['interleaved', [B[0], B[1], A[0], A[3], B[2], A[1], B[3], A[2]]],
])(
  'syncs a local folder rename reported with %s as a move, removing the old folder',
  async (_, reports) => {
    const { computers, folder, cloud } = await twoComputers();
    const [first, second] = computers;
    await mkdir(path.join(first.localPath, 'Folder A'));
    for (let i = 0; i < 3; i++)
      await writeFile(path.join(first.localPath, 'Folder A', `f${i}.txt`), `file ${i}`);
    for (const relative of ['Folder A', 'Folder A/f0.txt', 'Folder A/f1.txt', 'Folder A/f2.txt'])
      first.journal.enqueue(first.root.id, relative, 'upsert');
    await tick(first);
    await tick(second);
    const files = (await cloud.list((await cloud.list(folder.id)).items[0].id)).items;

    await rename(path.join(first.localPath, 'Folder A'), path.join(first.localPath, 'Folder B'));
    for (const [kind, relative] of reports) {
      first.journal.enqueue(first.root.id, relative, kind);
      // Distinct times keep the queue in exactly this order.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await tick(first);
    await tick(second);

    expect(first.journal.jobs()).toEqual([]);
    expect(first.engine.state.issues).toEqual([]);
    expect(second.engine.state.issues).toEqual([]);
    const top = (await cloud.list(folder.id)).items;
    expect(top.map((i) => i.name)).toEqual(['Folder B']);
    // The files themselves moved: same items, same versions.
    expect(
      (await cloud.list(top[0].id)).items.map((i) => [i.id, i.currentVersionId]).sort(),
    ).toEqual(files.map((i) => [i.id, i.currentVersionId]).sort());
    for (const computer of [first, second]) {
      expect(await readdir(computer.localPath)).toEqual(['Folder B']);
      expect((await readdir(path.join(computer.localPath, 'Folder B'))).sort()).toEqual([
        'f0.txt',
        'f1.txt',
        'f2.txt',
      ]);
    }
  },
);

it('notices a renamed folder whose old path the OS never reported', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  await mkdir(path.join(first.localPath, 'Folder A'));
  await writeFile(path.join(first.localPath, 'Folder A', 'f.txt'), 'kept');
  for (const relative of ['Folder A', 'Folder A/f.txt'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  await tick(first);
  await tick(second);
  const [original] = (await cloud.list((await cloud.list(folder.id)).items[0].id)).items;

  await rename(path.join(first.localPath, 'Folder A'), path.join(first.localPath, 'Folder B'));
  // Only the new folder is reported, as FSEvents and ReadDirectoryChangesW sometimes do.
  const report = watchers.get(first.localPath)!;
  for (const relative of ['Folder B', 'Folder B/f.txt']) {
    const full = path.join(first.localPath, relative);
    report[relative.includes('.') ? 'add' : 'addDir'](full, await lstat(full));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  await tick(first);
  await tick(second);

  expect(first.journal.jobs()).toEqual([]);
  expect(first.engine.state.issues).toEqual([]);
  const top = (await cloud.list(folder.id)).items;
  expect(top.map((i) => i.name)).toEqual(['Folder B']);
  expect((await cloud.list(top[0].id)).items.map((i) => [i.id, i.currentVersionId])).toEqual([
    [original.id, original.currentVersionId],
  ]);
  expect(await readdir(second.localPath)).toEqual(['Folder B']);
});

it('does not bring back a local deletion the cloud has not heard of yet', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first] = computers;
  await mkdir(path.join(first.localPath, 'Docs'));
  await writeFile(path.join(first.localPath, 'Docs', 'a.txt'), 'a');
  for (const relative of ['Docs', 'Docs/a.txt'])
    first.journal.enqueue(first.root.id, relative, 'upsert');
  await tick(first);
  const docs = (await cloud.list(folder.id)).items[0];
  const [file] = (await cloud.list(docs.id)).items;

  // Deleted here; the cloud reports the item again (the echo of its upload) before the watcher
  // has reported the deletion.
  await rm(path.join(first.localPath, 'Docs'), { recursive: true });
  await first.engine.remoteItem(first.root, file);
  await first.engine.remoteItem(first.root, docs);
  expect(await readdir(first.localPath)).toEqual([]);

  for (const relative of ['Docs/a.txt', 'Docs'])
    first.journal.enqueue(first.root.id, relative, 'delete');
  await tick(first);
  expect((await cloud.list(folder.id)).items).toEqual([]);
  expect(first.engine.state.issues).toEqual([]);
});
