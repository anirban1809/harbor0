import { expect, it, vi } from 'vitest';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SyncEngine } from '../src/sync';
import { tick, twoComputers } from './two-computers';

vi.mock('../src/local-watcher', async () => {
  const { EventEmitter } = await import('node:events');
  return { watchTree: () => Object.assign(new EventEmitter(), { close: async () => {} }) };
});

it('sends a local change while catching up on a long feed, then carries on from where it was', async () => {
  const { computers, folder, cloud } = await twoComputers();
  const [first, second] = computers;
  // A feed for the second computer to catch up on.
  for (let index = 0; index < 6; index++) {
    await writeFile(path.join(first.localPath, `remote-${index}.txt`), `${index}`);
    first.journal.enqueue(first.root.id, `remote-${index}.txt`, 'upsert');
  }
  await tick(first);
  const start = second.journal.get<number>('cursor') ?? 0;
  // Only the feed brings the files over; a full folder check would list them first.
  second.journal.root({ ...second.root, needsReconcile: false });
  // The second computer gets through one change, then time runs on while it is still catching
  // up, and a file is saved on it.
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const remoteItem = SyncEngine.prototype.remoteItem;
  let calls = 0;
  vi.spyOn(second.engine, 'remoteItem').mockImplementation(async function (
    this: SyncEngine,
    ...args
  ) {
    if (++calls === 1) {
      const local = path.join(second.localPath, 'mine.txt');
      await writeFile(local, 'saved here');
      second.journal.enqueue(second.root.id, 'mine.txt', 'upsert', {
        type: 'FILE',
        sizeBytes: (await stat(local)).size,
        updatedAt: new Date().toISOString(),
      });
      clock += 20_000;
    }
    return remoteItem.apply(this, args);
  });
  // When the local file goes up, how far the feed had got.
  let feedAtUpload: number | undefined;
  const request = second.api.request.bind(second.api);
  vi.spyOn(second.api, 'request').mockImplementation(async (url, init) => {
    if (/^\/v1\/uploads(\/batch)?$/.test(url)) feedAtUpload ??= calls;
    return request(url, init);
  });
  await tick(second);
  // The local file went up after one feed change, before the other five; then the feed finished.
  expect(feedAtUpload).toBe(1);
  expect(calls).toBeGreaterThanOrEqual(6);
  expect((await cloud.list(folder.id)).items.map((item) => item.name)).toContain('mine.txt');
  expect(
    (await readdir(second.localPath)).filter((name) => name.startsWith('remote-')),
  ).toHaveLength(6);
  expect(second.journal.get<number>('cursor')!).toBeGreaterThan(start);
});

it('stops catching up on a long feed for a restore asked for on this computer', async () => {
  const { computers } = await twoComputers();
  const [first, second] = computers;
  for (let index = 0; index < 6; index++) {
    await writeFile(path.join(first.localPath, `remote-${index}.txt`), `${index}`);
    first.journal.enqueue(first.root.id, `remote-${index}.txt`, 'upsert');
  }
  await tick(first);
  second.journal.root({ ...second.root, needsReconcile: false });
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const engine = second.engine as unknown as { runTick(): Promise<void> };
  const runTick = vi.spyOn(engine, 'runTick');
  const remoteItem = SyncEngine.prototype.remoteItem;
  let calls = 0;
  let passesAtSecondItem: number | undefined;
  vi.spyOn(second.engine, 'remoteItem').mockImplementation(async function (
    this: SyncEngine,
    ...args
  ) {
    if (++calls === 1) {
      second.engine.restoreSoon();
      clock += 20_000;
    }
    if (calls === 2) passesAtSecondItem = runTick.mock.calls.length;
    return remoteItem.apply(this, args);
  });
  await tick(second);
  // A new pass, which looks for restores first, started before the feed went on.
  expect(passesAtSecondItem).toBe(2);
  expect(
    (await readdir(second.localPath)).filter((name) => name.startsWith('remote-')),
  ).toHaveLength(6);
});
