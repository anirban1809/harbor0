import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, utimes, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ApiClient } from '@harbor/api-client';
import { Journal, type Root, type LocalJob } from '../src/journal';
import { FolderBackups, BACKUP_QUIET_MS, backupReady } from '../src/backups';
let directory: string, journal: Journal, root: Root, backups: FolderBackups, api: ApiClient;
let calls: { url: string; body: any }[];
let pending: any[];
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
    if (url.endsWith('/pending-restores')) return { items: pending };
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
