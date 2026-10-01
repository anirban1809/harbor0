import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, utimes, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { Journal, type Root, type LocalJob } from '../src/journal';
import { FolderBackups, BACKUP_QUIET_MS, backupReady } from '../src/backups';
let directory: string, journal: Journal, root: Root, backups: FolderBackups, api: ApiClient;
let calls: { url: string; body: any }[];
let pending: any[];
let children: Record<string, any[]>;
let failEntry: boolean;
let failRestoreAck: boolean;
const content = 'historical content';
const hash = createHash('sha256').update(content).digest('hex');
const perform = vi.fn(async (r: Root, job: LocalJob) => {
  journal.putFile({
    rootId: r.id,
    relativePath: job.relativePath,
    itemId: job.relativePath,
    revision: 1,
    hash: 'hash',
    type: 'FILE',
  });
});
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-backup-'));
  journal = new Journal(':memory:');
  calls = [];
  pending = [];
  children = {};
  failEntry = false;
  failRestoreAck = false;
  perform.mockClear();
  root = {
    id: 'local',
    backupId: 'backup',
    localPath: directory,
    remoteId: 'remote',
    mode: 'backup',
    paused: false,
    excluded: ['ignored'],
  };
  journal.root(root);
  api = new ApiClient(async (url, init) => {
    calls.push({ url, body: init?.body });
    if (url === '/v1/backups/backup') return { root: { state: 'ACTIVE' } };
    if (url.endsWith('/pending-restores')) return { items: pending };
    if (url.endsWith('/children'))
      return { items: children[url.split('/')[4]] ?? [], nextCursor: null };
    if (url.endsWith('/files') && failEntry) {
      failEntry = false;
      throw new TypeError('Offline');
    }
    if (url.includes('/restores/') && url.endsWith('/complete') && failRestoreAck) {
      failRestoreAck = false;
      throw new TypeError('Offline');
    }
    if (url.startsWith('/v1/drive/items/'))
      return { item: { id: url.split('/').at(-1), currentVersionId: 'v1', sizeBytes: 5 } };
    if (url === '/v1/downloads')
      return {
        downloadUrl: 'https://backup.test/file',
        sizeBytes: Buffer.byteLength(content),
        contentHash: hash,
      };
    return {};
  });
  backups = new FolderBackups(api, journal);
});
afterEach(async () => {
  vi.restoreAllMocks();
  journal.close();
  await rm(directory, { force: true, recursive: true });
});
async function file(name: string, age = 0) {
  const target = path.join(directory, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'hello');
  await utimes(target, new Date(Date.now() - age), new Date(Date.now() - age));
  journal.enqueue(root.id, name, 'upsert');
}
const process = () => backups.process(root, perform, () => false);
it('waits a full hour from the latest write or observed change and retains deferred jobs', async () => {
  expect(backupReady(1000, 0, BACKUP_QUIET_MS + 999)).toBe(false);
  expect(backupReady(1000, 0, BACKUP_QUIET_MS + 1000)).toBe(true);
  expect(backupReady(0, 5000, BACKUP_QUIET_MS + 4999)).toBe(false);
  await file('recent.txt');
  await file('old.txt', BACKUP_QUIET_MS + 5000);
  await process();
  expect(perform.mock.calls.map(([, job]) => job.relativePath)).toEqual(['old.txt']);
  expect(journal.jobs().map((job) => job.relativePath)).toEqual(['recent.txt']);
  expect(calls.find((c) => c.url.endsWith('/runs'))?.body.trigger).toBe('AUTOMATIC');
});
it('on demand rescans recent files, respects exclusions, ignores symlinks, and persists a manual run', async () => {
  await file('nested/recent.txt');
  await file('ignored/private.txt');
  await file('.DS_Store');
  await file('nested/.DS_Store');
  await file('nested/._recent.txt');
  await file('nested/Thumbs.db');
  await symlink(path.join(directory, 'nested/recent.txt'), path.join(directory, 'link.txt'));
  journal.finish(journal.jobs().find((j) => j.relativePath === 'nested/recent.txt')!.id);
  await backups.request(root);
  await process();
  expect(perform.mock.calls.map(([, job]) => job.relativePath)).toEqual(['nested/recent.txt']);
  expect(calls.find((c) => c.url.endsWith('/runs'))?.body.trigger).toBe('MANUAL');
  expect(calls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(1);
});
it('does not drop an uploaded version when recording it fails and resumes the same run after restart', async () => {
  await file('old.txt', BACKUP_QUIET_MS + 5000);
  failEntry = true;
  await expect(process()).rejects.toThrow('Offline');
  const id = calls.find((c) => c.url.endsWith('/runs'))!.body.id;
  expect(journal.jobs()).toHaveLength(1);
  backups = new FolderBackups(api, journal);
  await process();
  expect(calls.filter((c) => c.url.endsWith('/runs')).every((c) => c.body.id === id)).toBe(true);
  expect(perform).toHaveBeenCalledTimes(1);
  expect(journal.jobs()).toHaveLength(0);
});
it('keeps local deletions out of cloud deletion requests', async () => {
  journal.enqueue(root.id, 'deleted.txt', 'delete');
  await process();
  expect(perform).not.toHaveBeenCalled();
  expect(journal.jobs()).toHaveLength(0);
  expect(calls.some((c) => c.url.includes('/drive/'))).toBe(false);
});
it('restores a selected version locally and never repeats a replacement after an acknowledgement failure', async () => {
  await file('notes.txt');
  pending = [{ id: 'restore1', relativePath: 'notes.txt', itemId: 'file', versionId: 'old' }];
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(content));
  failRestoreAck = true;
  await expect(process()).rejects.toThrow('Offline');
  expect(await readFile(path.join(directory, 'notes.txt'), 'utf8')).toBe(content);
  await writeFile(path.join(directory, 'notes.txt'), 'new edits after restore');
  backups = new FolderBackups(api, journal);
  await process();
  expect(await readFile(path.join(directory, 'notes.txt'), 'utf8')).toBe('new edits after restore');
  expect(calls.filter((c) => c.url === '/v1/downloads')).toEqual([
    expect.objectContaining({ body: { driveItemId: 'file', versionId: 'old' } }),
  ]);
});
it('rejects traversal and symlink restore destinations without touching files outside the folder', async () => {
  await symlink(os.tmpdir(), path.join(directory, 'outside'));
  pending = [
    { id: 'a', relativePath: '../escape.txt', itemId: 'file', versionId: 'old' },
    { id: 'b', relativePath: 'outside/escape.txt', itemId: 'file', versionId: 'old' },
  ];
  await process();
  expect(calls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(2);
  expect(calls.filter((c) => c.url.endsWith('/complete')).every((c) => c.body.error)).toBe(true);
  expect(calls.some((c) => c.url === '/v1/downloads')).toBe(false);
});
it('preserves the current local file when downloaded backup bytes fail verification', async () => {
  await file('notes.txt');
  pending = [{ id: 'corrupt', relativePath: 'notes.txt', itemId: 'file', versionId: 'old' }];
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('corrupt bytes'));
  await process();
  expect(await readFile(path.join(directory, 'notes.txt'), 'utf8')).toBe('hello');
  expect(calls.find((c) => c.url.endsWith('/corrupt/complete'))?.body.error).toContain(
    'integrity check failed',
  );
});
it('keeps changes made during a backup queued for the next eligible version', async () => {
  await file('old.txt', BACKUP_QUIET_MS + 5000);
  await backups.process(
    root,
    async (r, job) => {
      await perform(r, job);
      await writeFile(path.join(directory, job.relativePath), 'edited during backup');
    },
    () => false,
  );
  expect(journal.jobs()).toEqual([
    expect.objectContaining({
      relativePath: 'old.txt',
      payload: expect.objectContaining({ observedAt: expect.any(Number) }),
    }),
  ]);
  await process();
  expect(perform).toHaveBeenCalledTimes(1);
});
const helloHash = createHash('sha256').update('hello').digest('hex');
const save = async (r: Root, job: LocalJob) =>
  journal.putFile({
    rootId: r.id,
    relativePath: job.relativePath,
    itemId: job.relativePath,
    revision: 1,
    hash: helloHash,
    type: 'FILE',
  });
const exists = (name: string) =>
  readFile(path.join(directory, name)).then(
    () => true,
    () => false,
  );
async function requestArchive() {
  root = { ...root, archive: 'pending' };
  journal.root(root);
  journal.set(`backup-now:${root.id}`, true);
}
it('archives after a full backup, removing only verified files and keeping excluded ones', async () => {
  await file('a.txt');
  await file('sub/b.txt');
  await file('ignored/keep.txt');
  await writeFile(path.join(directory, 'sub', '.DS_Store'), 'finder');
  await requestArchive();
  const detach = vi.fn(async () => {});
  await backups.process(root, save, () => false);
  await backups.archive(root, detach, () => false);
  expect(calls.some((c) => c.url === '/v1/backups/backup/archive')).toBe(true);
  expect(detach).toHaveBeenCalledOnce();
  expect(await exists('a.txt')).toBe(false);
  expect(await exists('sub/b.txt')).toBe(false);
  expect(await exists('sub/.DS_Store')).toBe(false);
  expect(await exists('ignored/keep.txt')).toBe(true);
  expect(journal.roots()[0].archive).toBe('archived');
});
it('never removes a file that changed after its backup and gives up while it keeps changing', async () => {
  await file('a.txt');
  await requestArchive();
  const detach = vi.fn(async () => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    await backups.process(root, save, () => false);
    await writeFile(path.join(directory, 'a.txt'), `edit ${attempt}`);
    await backups.archive(journal.roots()[0], detach, () => false);
  }
  expect(calls.some((c) => c.url === '/v1/backups/backup/archive')).toBe(false);
  expect(detach).not.toHaveBeenCalled();
  expect(await readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('edit 2');
  expect(journal.roots()[0].archive).toBeUndefined();
  expect(journal.roots()[0].archiveError).toContain('keep changing');
});
it('restores an archived folder from the cloud copy without replacing local files', async () => {
  await writeFile(path.join(directory, 'local.txt'), 'newer local work');
  root = { ...root, archive: 'restoring' };
  journal.root(root);
  children = {
    remote: [
      { id: 'folder', name: 'sub', type: 'FOLDER' },
      { id: 'one', name: 'notes.txt', type: 'FILE' },
      { id: 'two', name: 'local.txt', type: 'FILE' },
    ],
    folder: [{ id: 'three', name: 'b.txt', type: 'FILE' }],
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(content));
  await backups.unarchive(root, () => false);
  expect(calls[0].url).toBe('/v1/backups/backup/unarchive');
  expect(await readFile(path.join(directory, 'notes.txt'), 'utf8')).toBe(content);
  expect(await readFile(path.join(directory, 'sub', 'b.txt'), 'utf8')).toBe(content);
  expect(await readFile(path.join(directory, 'local.txt'), 'utf8')).toBe('newer local work');
  expect(journal.roots()[0].archive).toBeUndefined();
});
it('cancels instead of retrying forever when the server has no archive endpoint', async () => {
  await file('a.txt');
  await requestArchive();
  await backups.process(root, save, () => false);
  vi.spyOn(api, 'request').mockImplementation(async (url: string) => {
    if (url.endsWith('/archive')) throw new ApiError('NOT_FOUND', 'Endpoint not found.', 404);
    return {};
  });
  const detach = vi.fn(async () => {});
  await backups.archive(journal.roots()[0], detach, () => false);
  expect(detach).not.toHaveBeenCalled();
  expect(await exists('a.txt')).toBe(true);
  expect(journal.roots()[0].archive).toBeUndefined();
  expect(journal.roots()[0].archiveError).toContain('does not support archiving');
});
