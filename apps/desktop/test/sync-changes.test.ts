import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiClient } from '@harbor/api-client';
import { Journal, type Root } from '../src/journal';
import { SyncEngine, STALL_TIMEOUT } from '../src/sync';
import { SyncReceipts } from '../src/sync-receipts';
import { folderState, type SyncFolder } from '../src/sync-state';
import { watchTree } from '../src/local-watcher';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function folder() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-changes-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new Journal(':memory:');
  cleanup.push(async () => journal.close());
  const root: Root = {
    id: 'root',
    localPath: directory,
    remoteId: 'remote',
    mode: 'sync',
    paused: false,
    excluded: [],
  };
  journal.root(root);
  return { directory, journal, root };
}
const view = (root: Root): SyncFolder => ({
  ...root,
  localPathDisplayName: 'folder',
  fileCount: 0,
  folderCount: 0,
});

it('reports real file system changes, including new folders and removals', async () => {
  const { directory } = await folder();
  const watcher = watchTree(directory, (full) => path.basename(full) === 'ignored.txt');
  cleanup.push(() => watcher.close());
  const events: string[] = [];
  for (const kind of ['add', 'addDir', 'change', 'unlink'] as const)
    watcher.on(kind, (full) => events.push(`${kind} ${path.relative(directory, full)}`));
  // Let the OS watch start before changing anything.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await writeFile(path.join(directory, 'a.txt'), 'a');
  await writeFile(path.join(directory, 'ignored.txt'), 'x');
  await mkdir(path.join(directory, 'sub'));
  await writeFile(path.join(directory, 'sub', 'b.txt'), 'b');
  await vi.waitFor(
    () => {
      expect(events).toContain('change a.txt');
      expect(events).toContain('addDir sub');
      expect(events.some((e) => e.endsWith(path.join('sub', 'b.txt')))).toBe(true);
    },
    { timeout: 5000 },
  );
  expect(events.some((e) => e.includes('ignored.txt'))).toBe(false);
  await rm(path.join(directory, 'a.txt'));
  await vi.waitFor(() => expect(events).toContain('unlink a.txt'), { timeout: 5000 });
});

it('records each local change in a ledger and is up to date only once every change synced', async () => {
  const { directory, journal, root } = await folder();
  const file = async (name: string, content: string) => {
    await writeFile(path.join(directory, name), content);
    const info = await stat(path.join(directory, name));
    return { sizeBytes: info.size, mtimeMs: info.mtimeMs };
  };
  const tracked = (relativePath: string, extra: object = {}) =>
    journal.putFile({
      rootId: root.id,
      relativePath,
      itemId: relativePath,
      revision: 1,
      hash: 'hash',
      type: 'FILE',
      ...extra,
    });
  tracked('same.txt', await file('same.txt', 'same'));
  const edited = await file('edited.txt', 'edited');
  tracked('edited.txt', { ...edited, mtimeMs: edited.mtimeMs - 5000 });
  await file('new.txt', 'new');
  tracked('gone.txt', { sizeBytes: 1, mtimeMs: 1 });
  await mkdir(path.join(directory, 'dir'));
  journal.putFile({ ...journal.file(root.id, 'same.txt')!, relativePath: 'dir', type: 'FOLDER' });
  tracked('dir/kept.txt', await file('dir/kept.txt', 'kept'));
  const engine = new SyncEngine(new ApiClient(async () => ({})), journal, 'device', () => {});
  cleanup.push(() => engine.stop());

  await (engine as any).scanLocal(root);
  const jobs = journal.jobs().map((job) => `${job.kind} ${job.relativePath}`);
  expect(jobs.sort()).toEqual(['delete gone.txt', 'upsert edited.txt', 'upsert new.txt']);
  // A second scan, or the watcher reporting the same edit, is still one pending change.
  await (engine as any).scanLocal(root);
  expect(journal.changes(root.id).map((c) => c.source)).toEqual(['scan', 'scan', 'scan']);
  let summary = journal.changeSummaries().get(root.id)!;
  expect(summary.pending).toBe(3);
  const state = { ...engine.state, changes: Object.fromEntries(journal.changeSummaries()) };
  expect(folderState(view(root), state, [])).toBe('Syncing');

  for (const job of journal.jobs()) journal.finish(job.id);
  summary = journal.changeSummaries().get(root.id)!;
  expect(summary).toMatchObject({ pending: 0 });
  expect(summary.lastSyncedAt).toBeGreaterThan(0);
  expect(journal.changes(root.id).every((change) => change.syncedAt)).toBe(true);
  expect(
    folderState(
      view(root),
      { ...state, changes: Object.fromEntries(journal.changeSummaries()) },
      [],
    ),
  ).toBe('Up to date');
});

it('aborts a pass that stops making progress and starts the next one', async () => {
  vi.useFakeTimers();
  // No folders: only the cloud check runs, so fake timers drive the whole pass.
  const journal = new Journal(':memory:');
  cleanup.push(async () => journal.close());
  let checks = 0;
  const engine = new SyncEngine(
    new ApiClient(async (endpoint, init) => {
      if (!endpoint.includes('/changes')) return {};
      checks++;
      // A request that never answers, like a dropped connection with no timeout.
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      );
    }),
    journal,
    'device',
    () => {},
  );
  // The fake request never answers; real ones are bounded by the per-attempt timeout.
  cleanup.push(() => {
    (engine as any).tickController.abort();
    return engine.stop();
  });
  await engine.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(checks).toBe(1);
  expect(engine.state.running).toBe(true);
  await vi.advanceTimersByTimeAsync(STALL_TIMEOUT + 15_000);
  expect(engine.state.message).toBe('Sync stopped responding and was restarted.');
  // Restarting is automatic; it is not reported as a problem to fix.
  expect(engine.state.issues).toEqual([]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(checks).toBe(2);
});

it('moves past a confirmation batch the server is too slow to answer', async () => {
  const { journal, root } = await folder();
  for (let i = 0; i < 40; i++)
    journal.putFile({
      rootId: root.id,
      relativePath: `f${i}`,
      itemId: `item-${i}`,
      revision: 1,
      hash: 'hash',
      type: 'FILE',
    });
  const asked: string[][] = [];
  const receipts = new SyncReceipts(
    new ApiClient(async (endpoint) => {
      const ids = new URL('http://x' + endpoint).searchParams.get('ids')!.split(',');
      asked.push(ids);
      if (asked.length === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return {
        items: ids.map((itemId) => ({ itemId, revision: 1, deviceConfirmed: true })),
      };
    }),
    journal,
  );
  await receipts.audit();
  await receipts.audit();
  await receipts.audit();
  // The slow batch was skipped (not retried), then smaller batches carried on.
  expect(asked[0]).toHaveLength(25);
  expect(new Set(asked.flat()).size).toBe(asked.flat().length);
  expect(asked[1].length).toBeLessThan(25);
});
