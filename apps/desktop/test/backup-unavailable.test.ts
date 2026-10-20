import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiClient } from '@harbor/api-client';
import { Journal, type LocalJob, type Root } from '../src/journal';
import { BACKUP_QUIET_MS, FolderBackups, folderReadable } from '../src/backups';
import { syncIssueCode } from '../src/sync-state';

// chmod can't take away read access on Windows.
const posix = globalThis.process.platform !== 'win32';
let directory: string, journal: Journal, root: Root, backups: FolderBackups;
let saved: string[];
let onSave: (job: LocalJob) => Promise<void>;
/** Runs when the run starts: after its files are listed, before any is read. */
let onStart: () => Promise<void>;
const perform = async (r: Root, job: LocalJob) => {
  await onSave(job);
  saved.push(job.relativePath);
  journal.putFile({
    rootId: r.id,
    relativePath: job.relativePath,
    itemId: job.relativePath,
    revision: 1,
    hash: 'hash',
    type: 'FILE',
  });
};
async function file(name: string) {
  const target = path.join(directory, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'hello');
  const old = new Date(Date.now() - BACKUP_QUIET_MS - 5000);
  await utimes(target, old, old);
  journal.enqueue(root.id, name, 'upsert');
}
const waiting = () => journal.jobs().map((job) => job.relativePath);

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-backup-unavailable-'));
  journal = new Journal(':memory:');
  saved = [];
  onSave = async () => {};
  onStart = async () => {};
  root = {
    id: 'local',
    backupId: 'backup',
    localPath: directory,
    remoteId: 'remote',
    mode: 'backup',
    paused: false,
    excluded: [],
  };
  journal.root(root);
  const api = new ApiClient(async (url, init) => {
    if (url === '/v1/backups/backup') return { root: { state: 'ACTIVE' } };
    if (url === '/v1/backups/backup/runs' && init?.method === 'POST') await onStart();
    if (url.endsWith('/pending-restores')) return { items: [] };
    if (url.startsWith('/v1/drive/items/'))
      return { item: { id: url.split('/').at(-1), currentVersionId: 'v1', sizeBytes: 5 } };
    return {};
  });
  backups = new FolderBackups(api, journal);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await chmod(directory, 0o755).catch(() => {});
  await chmod(path.join(directory, 'locked'), 0o755).catch(() => {});
  journal.close();
  await rm(directory, { force: true, recursive: true });
});

it.skipIf(!posix)('sets aside a file it cannot read and backs up the rest', async () => {
  await file('1.txt');
  await file('3.txt');
  await file('locked/2.txt');
  // The subfolder becomes unreadable once the run is under way.
  onStart = () => chmod(path.join(directory, 'locked'), 0o000);
  await backups.process(root, perform, () => false);
  expect(saved.sort()).toEqual(['1.txt', '3.txt']);
  // It waits for a later run, with its error, rather than stopping the others.
  expect(waiting()).toEqual(['locked/2.txt']);
  expect(journal.jobs()[0]!.error).toMatch(/EACCES/);
});

it.skipIf(!posix)(
  'stops the run when the folder itself went away, and goes on from there once it is back',
  async () => {
    await file('1.txt');
    await file('2.txt');
    await file('3.txt');
    // The whole folder becomes unreadable mid-run, as a share that disconnected does.
    onStart = () => chmod(directory, 0o000);
    const stopped = await backups.process(root, perform, () => false).catch((error) => error);
    expect(stopped).toMatchObject({ code: 'FOLDER_UNAVAILABLE' });
    expect(stopped.message).toContain('can’t be read right now');
    expect(syncIssueCode(stopped)).toBe('FOLDER_UNAVAILABLE');
    expect(saved).toEqual([]);
    // Nothing was marked failed: the run is still open, and the rest still wait.
    expect(backups.run(root.id)).toBeTruthy();
    expect(journal.jobs().every((job) => !job.error)).toBe(true);

    await chmod(directory, 0o755);
    onStart = async () => {};
    await backups.process(root, perform, () => false);
    expect(saved.sort()).toEqual(['1.txt', '2.txt', '3.txt']);
    expect(waiting()).toEqual([]);
  },
);

it('gives up waiting on a folder that does not answer', async () => {
  expect(await folderReadable(directory)).toBe(true);
  expect(await folderReadable(path.join(directory, 'missing'))).toBe(false);
  vi.useFakeTimers();
  try {
    // A share that stopped answering: the look never returns.
    const answer = folderReadable(directory, 1000, () => new Promise<boolean>(() => {}));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(answer).resolves.toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
