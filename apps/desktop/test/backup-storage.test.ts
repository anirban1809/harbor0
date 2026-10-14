import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { MemoryRepository, transact } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { StorageService, userPK, type Account } from '../../backend/src/domain';
import { createApp } from '../../backend/src/api';
import { DevelopmentAuth } from '../../backend/src/auth';
import { Journal } from '../src/journal';
import { SyncEngine } from '../src/sync';
vi.mock('../src/local-watcher', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    watchTree: vi.fn(() => Object.assign(new EventEmitter(), { close: async () => {} })),
  };
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function backupFolder() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-backup-storage-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new Journal(':memory:');
  cleanup.push(async () => journal.close());
  const storage = new MemoryStorage();
  const service = new StorageService(new MemoryRepository(), storage);
  const { app } = createApp(service, new DevelopmentAuth());
  const login = await app.request('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'alice@example.test',
      password: 'Development-only-123!',
      deviceName: 'Mac',
      platform: 'MACOS',
    }),
  });
  const session = await login.json();
  const api = new ApiClient(async (url, init) => {
    const response = await app.request(url, {
      method: init?.method,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(
        data.error.code,
        data.error.message,
        response.status,
        undefined,
        data.error.details,
      );
    return data;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    storage.uploads
      .get(url.hostname)!
      .parts.set(Number(url.pathname.slice(1)), new Uint8Array(init!.body as Buffer));
    return new Response(null, { headers: { etag: `part-${url.pathname.slice(1)}` } });
  });
  const engine = new SyncEngine(api, journal, session.device.id, () => {});
  cleanup.push(() => engine.stop());
  const { root: remote } = await api.request('/v1/backups', {
    method: 'POST',
    body: { operationId: crypto.randomUUID(), deviceId: session.device.id, name: 'Documents' },
  });
  journal.root({
    id: 'local',
    backupId: remote.id,
    remoteId: remote.remoteRootDriveItemId,
    localPath: directory,
    mode: 'backup',
    paused: false,
    excluded: [],
  });
  const quota = (bytes: number) =>
    transact(service.repo, async (tx) => {
      const account = (await tx.get<Account>(userPK('alice'), 'PROFILE'))!;
      await tx.put(userPK('alice'), 'PROFILE', { ...account, storageQuotaBytes: bytes });
    });
  return { directory, journal, engine, quota, api, remote };
}

it('refuses "Back up now" up front when none of the changed files fit', async () => {
  const { directory, journal, engine, quota } = await backupFolder();
  await quota(10);
  await writeFile(path.join(directory, 'report.pdf'), Buffer.alloc(100));
  await expect(engine.backupNow('local')).rejects.toThrow(
    'There is not enough cloud storage to back up the changed file.',
  );
  expect(journal.get('backup-now:local')).toBe(false);
});

it('remembers that the last backup skipped files until a clean run', async () => {
  const { directory, journal, engine, quota, api, remote } = await backupFolder();
  await quota(150);
  await writeFile(path.join(directory, 'small.txt'), Buffer.alloc(100));
  await writeFile(path.join(directory, 'large.bin'), Buffer.alloc(100));
  await expect(engine.backupNow('local')).resolves.toMatchObject({ changes: 2 });
  await engine.tick();
  const states = async () =>
    ((await api.request(`/v1/backups/${remote.id}/runs`)).items as { state: string }[])
      .map((run) => run.state)
      .sort();
  expect(await states()).toEqual(['PARTIAL']);
  expect(journal.roots()[0].backupStorage).toEqual({
    requiredBytes: 200,
    availableBytes: 150,
    files: 0,
  });

  await quota(10_000);
  await engine.backupNow('local');
  await engine.tick();
  expect(await states()).toEqual(['COMPLETED', 'PARTIAL']);
  expect(journal.roots()[0].lastBackupError).toBeUndefined();
  expect(journal.roots()[0].backupStorage).toBeUndefined();
});

it('backs up what fits and leaves bigger files queued without trying them', async () => {
  const { directory, journal, engine, quota, api, remote } = await backupFolder();
  await quota(150);
  await writeFile(path.join(directory, 'first.txt'), Buffer.alloc(100));
  await writeFile(path.join(directory, 'second.txt'), Buffer.alloc(100));
  const requests: string[] = [];
  const request = api.request.bind(api);
  vi.spyOn(api, 'request').mockImplementation(async (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    return request(url, init);
  });
  await engine.backupNow('local');
  await engine.tick();
  // Only one upload was started: the second file no longer fit once the first was saved.
  expect(requests.filter((r) => /^POST \/v1\/backups\/.+\/uploads$/.test(r))).toHaveLength(1);
  // The file that did not fit waits, untried and without an error, for space to be freed.
  // Both were queued at once, so either may be the one saved.
  const waiting = journal.jobs().filter((job) => !journal.file('local', job.relativePath));
  expect(waiting).toEqual([
    expect.objectContaining({
      relativePath: expect.stringMatching(/^(first|second)\.txt$/),
      error: null,
      attempts: 0,
    }),
  ]);
  const { items } = await request(`/v1/backups/${remote.id}/runs`);
  expect(items).toEqual([
    expect.objectContaining({
      state: 'PARTIAL',
      error: '1 file was not backed up: there is not enough cloud storage (50 B free).',
    }),
  ]);
});

it('records no run while none of the waiting files fit', async () => {
  const { directory, journal, engine, quota, api, remote } = await backupFolder();
  await quota(50);
  const file = path.join(directory, 'video.mov');
  await writeFile(file, Buffer.alloc(100));
  const old = new Date(Date.now() - 2 * 3600_000);
  await utimes(file, old, old);
  await engine.tick();
  await engine.tick();
  expect((await api.request(`/v1/backups/${remote.id}/runs`)).items).toEqual([]);
  expect(journal.jobs().map((job) => job.relativePath)).toEqual(['video.mov']);
  expect(journal.roots()[0].backupStorage).toEqual({
    requiredBytes: 100,
    availableBytes: 50,
    files: 1,
  });
});

describe('small files in batches', () => {
  const watch = (api: ApiClient) => {
    const requests: string[] = [];
    const request = api.request.bind(api);
    const spy = vi.spyOn(api, 'request').mockImplementation(async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${url.replace(/\/[0-9a-f-]{36}/g, '/:id')}`);
      return request(url, init);
    });
    return { requests, request, spy };
  };
  const runFiles = async (api: ApiClient, backupId: string) => {
    // The newest run; listing order isn't guaranteed for runs started together.
    const { items: runs } = await api.request(`/v1/backups/${backupId}/runs`);
    const run = [...runs].sort((a: { startedAt: string }, b: { startedAt: string }) =>
      b.startedAt.localeCompare(a.startedAt),
    )[0];
    const { items } = await api.request(`/v1/backups/${backupId}/runs/${run.id}/files`);
    return { run, items: items as { relativePath: string }[] };
  };

  it('saves many small files with two requests per batch', async () => {
    const { directory, journal, engine, api, remote } = await backupFolder();
    for (let index = 0; index < 30; index++) {
      await mkdir(path.join(directory, `album-${index % 3}`), { recursive: true });
      await writeFile(
        path.join(directory, `album-${index % 3}`, `photo-${index}.jpg`),
        `photo ${index}`,
      );
    }
    const { requests } = watch(api);
    await engine.backupNow('local');
    await engine.tick();
    const count = (pattern: RegExp) => requests.filter((r) => pattern.test(r)).length;
    // 25 + 5 files, and one folder each for the three albums.
    expect(count(/^POST .*\/uploads\/batch$/)).toBe(2);
    expect(count(/^POST .*\/files\/batch$/)).toBe(2);
    expect(count(/^POST .*\/runs\/:id\/uploads$/)).toBe(0);
    expect(count(/^POST \/v1\/uploads\/:id\/(parts|complete)$/)).toBe(0);
    expect(count(/^POST .*\/runs\/:id\/folders$/)).toBe(3);
    const { run, items } = await runFiles(api, remote.id);
    expect(run.state).toBe('COMPLETED');
    expect(items).toHaveLength(30);
    expect(journal.jobs()).toEqual([]);
    expect(journal.file('local', 'album-1/photo-1.jpg')).toMatchObject({ type: 'FILE' });
  });

  it('backs up a file already in the cloud, and a large one, on their own', async () => {
    const { directory, journal, engine, api, remote } = await backupFolder();
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      await writeFile(path.join(directory, name), name);
    await writeFile(path.join(directory, 'large.bin'), Buffer.alloc(9 * 1024 * 1024, 1));
    await engine.backupNow('local');
    await engine.tick();
    expect(journal.jobs()).toEqual([]);
    // Saved again from a fresh copy of this computer: b.txt now exists in the cloud.
    journal.resetRootFiles('local');
    await writeFile(path.join(directory, 'b.txt'), 'b changed');
    await writeFile(path.join(directory, 'd.txt'), 'd');
    const { requests } = watch(api);
    await engine.backupNow('local');
    await engine.tick();
    expect(journal.jobs().map((job) => [job.relativePath, job.error])).toEqual([]);
    // The large file went alone, through the multipart path.
    expect(requests.some((r) => /^POST \/v1\/uploads\/:id\/complete$/.test(r))).toBe(true);
    const { items } = await runFiles(api, remote.id);
    expect(items.map((item) => item.relativePath).sort()).toEqual(
      expect.arrayContaining(['b.txt', 'd.txt']),
    );
  });

  it('saves one file at a time when the server has no batch routes', async () => {
    const { directory, journal, engine, api, remote } = await backupFolder();
    for (let index = 0; index < 4; index++)
      await writeFile(path.join(directory, `${index}.txt`), `${index}`);
    const { requests, request, spy } = watch(api);
    spy.mockImplementation(async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (/\/(uploads|files)\/batch$/.test(url))
        throw new ApiError('NOT_FOUND', 'Endpoint not found.', 404);
      return request(url, init);
    });
    await engine.backupNow('local');
    await engine.tick();
    expect(requests.filter((r) => r.endsWith('/uploads/batch'))).toHaveLength(1);
    expect(journal.jobs()).toEqual([]);
    expect((await runFiles(api, remote.id)).items).toHaveLength(4);
  });
});
