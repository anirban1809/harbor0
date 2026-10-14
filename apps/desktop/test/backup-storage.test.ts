import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, stat, writeFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { MemoryRepository, transact } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { StorageService, userPK, type Account } from '../../backend/src/domain';
import { createApp } from '../../backend/src/api';
import { DevelopmentAuth } from '../../backend/src/auth';
import { Journal } from '../src/journal';
import { transferKeys } from '../src/transfers';
import { FLAG_PK, emptyFlag } from '../../backend/src/flags';
import { e2eeTransport } from '../../../packages/api-client/src/e2ee-transport';
import {
  FileCipher,
  HEADER_SIZE,
  accountKeys,
  encryptedSize,
  newMasterKey,
  type AccountKeys,
} from '../../../packages/api-client/src/e2ee';
import { isEncryptedName } from '@harbor/contracts';
import { SyncEngine } from '../src/sync';
import type { SyncRuntime } from '../src/sync-state';
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

async function backupFolder(options: { encrypted?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-backup-storage-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const journal = new Journal(':memory:');
  cleanup.push(async () => journal.close());
  const storage = new MemoryStorage();
  const service = new StorageService(new MemoryRepository(), storage);
  const { app } = createApp(service, new DevelopmentAuth());
  // Flag rules are cached, so encryption is allowed before the first request.
  if (options.encrypted)
    await transact(service.repo, (tx) =>
      tx.put(FLAG_PK, 'e2ee', { ...emptyFlag('e2ee'), mode: 'TARGETED', userIds: ['alice'] }),
    );
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
  const raw = new ApiClient(async (url, init) => {
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
  let api = raw;
  let keys: AccountKeys | undefined;
  if (options.encrypted) {
    // Turned on from the web, as people do; the server only sees the wrapped key's shape.
    const web = await (
      await app.request('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@example.test',
          password: 'Development-only-123!',
          deviceName: 'Web',
          platform: 'WEB',
        }),
      })
    ).json();
    const shape = (n: number) => Buffer.alloc(n, 7).toString('base64url');
    const enrolled = await app.request('/v1/e2ee/enroll', {
      method: 'POST',
      headers: { Authorization: `Bearer ${web.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        passphrase: {
          v: 1,
          kdf: 'argon2id',
          salt: shape(16),
          memoryKiB: 65536,
          iterations: 3,
          parallelism: 1,
          iv: shape(12),
          ciphertext: shape(48),
        },
        recovery: { v: 1, kdf: 'hkdf', salt: shape(16), iv: shape(12), ciphertext: shape(48) },
        proof: 'proof-value-1234',
      }),
    });
    expect(enrolled.status).toBe(200);
    // Only builds that encrypt may use an encrypted account; this one says it's current.
    await transact(service.repo, async (tx) => {
      const key = `DEVICE#${session.device.id}`;
      const device = (await tx.get<Record<string, unknown>>(userPK('alice'), key))!;
      await tx.put(userPK('alice'), key, { ...device, appVersion: '99.0.0' });
    });
    const accountKeysNow = await accountKeys(newMasterKey());
    keys = accountKeysNow;
    api = new ApiClient(
      e2eeTransport((url, init) => raw.request(url, init), {
        vault: () => ({ userId: 'alice', enabled: true, keys: accountKeysNow }),
        onAccount: () => {},
        strict: true,
      }),
    );
    transferKeys.upload = () => accountKeysNow;
    transferKeys.read = () => accountKeysNow;
    cleanup.push(async () => {
      transferKeys.upload = () => undefined;
      transferKeys.read = () => undefined;
    });
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    // Downloads read what storage holds.
    if (init?.method !== 'PUT')
      return new Response(Buffer.from(storage.objects.get(url.pathname.slice(1))!));
    storage.uploads
      .get(url.hostname)!
      .parts.set(Number(url.pathname.slice(1)), new Uint8Array(init.body as Buffer));
    return new Response(null, { headers: { etag: `part-${url.pathname.slice(1)}` } });
  });
  // Every status the window would be sent.
  const states: SyncRuntime[] = [];
  const engine = new SyncEngine(api, journal, session.device.id, (state) =>
    states.push(state as SyncRuntime),
  );
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
  return { directory, journal, engine, quota, api, raw, remote, storage, keys, states };
}

it('starts nothing on "Back up now" when none of the changed files fit, and says so on the folder', async () => {
  const { directory, journal, engine, quota } = await backupFolder();
  await quota(10);
  await writeFile(path.join(directory, 'report.pdf'), Buffer.alloc(100));
  // Not an error of its own: the folder's panel says storage is full.
  await expect(engine.backupNow('local')).resolves.toEqual({
    queued: false,
    changes: 1,
    storage: true,
  });
  expect(journal.get('backup-now:local')).toBe(false);
  // Kept on screen, not only in the refusal: the folder needs storage, and the account is full.
  expect(journal.roots()[0].backupStorage).toEqual({
    requiredBytes: 100,
    availableBytes: 10,
    files: 1,
  });
  expect(engine.state.storageFull).toMatchObject({ availableBytes: 10 });
  // An ordinary pass, with the file still in its quiet hour, keeps saying so.
  await engine.tick();
  expect(journal.roots()[0].backupStorage).toMatchObject({ availableBytes: 10 });
  // Until space is freed.
  engine.storageFreed();
  expect(journal.roots()[0].backupStorage).toBeUndefined();
  expect(engine.state.storageFull).toBeUndefined();
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

it('backs up a file again, not as a failure, when the account is busy with another change', async () => {
  const { directory, journal, engine, api, remote } = await backupFolder();
  // Over the batch size, so it goes on its own.
  await writeFile(path.join(directory, 'large.bin'), Buffer.alloc(9 * 1024 * 1024, 1));
  const request = api.request.bind(api);
  let busy = 1;
  vi.spyOn(api, 'request').mockImplementation(async (url, init) => {
    if (/\/runs\/[^/]+\/uploads$/.test(url) && busy-- > 0)
      throw new ApiError(
        'CONCURRENT_UPDATE',
        'Another change is in progress. Retry with the same operation ID.',
        409,
      );
    return request(url, init);
  });
  await engine.backupNow('local');
  await engine.tick();
  await engine.tick();
  expect(journal.jobs()).toEqual([]);
  expect(journal.roots()[0].lastBackupError).toBeUndefined();
  const { items } = await request(`/v1/backups/${remote.id}/runs`);
  expect(items).toEqual([expect.objectContaining({ state: 'COMPLETED', fileCount: 1 })]);
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

  it('counts each file once when a finished batch is sent again', async () => {
    const { directory, engine, api, remote } = await backupFolder();
    for (let index = 0; index < 3; index++)
      await writeFile(path.join(directory, `${index}.txt`), `${index}`);
    const { request, spy } = watch(api);
    let replayed: { results: { entry: { itemId: string } }[] } | undefined;
    spy.mockImplementation(async (url, init) => {
      const result = await request(url, init);
      // As if the reply was lost: the device sends the same files again.
      if (url.endsWith('/files/batch')) replayed = await request(url, init);
      return result;
    });
    await engine.backupNow('local');
    await engine.tick();
    expect(replayed?.results.map((result) => result.entry.itemId)).toHaveLength(3);
    const { run, items } = await runFiles(api, remote.id);
    expect(items).toHaveLength(3);
    expect(run.fileCount).toBe(3);
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

it('batches an encrypted account’s files, encrypting their contents and names', async () => {
  const { directory, journal, engine, api, raw, remote, keys, storage } = await backupFolder({
    encrypted: true,
  });
  expect(keys).toBeDefined();
  for (let index = 0; index < 6; index++) {
    await mkdir(path.join(directory, 'Taxes'), { recursive: true });
    await writeFile(path.join(directory, 'Taxes', `return-${index}.pdf`), `return ${index}`);
  }
  const requests: string[] = [];
  const request = raw.request.bind(raw);
  vi.spyOn(raw, 'request').mockImplementation(async (url, init) => {
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    return request(url, init);
  });
  await engine.backupNow('local');
  await engine.tick();
  expect(journal.jobs()).toEqual([]);
  expect(requests.filter((r) => r.endsWith('/uploads/batch'))).toHaveLength(1);
  expect(requests.filter((r) => /\/runs\/[^/]+\/uploads$/.test(r))).toHaveLength(0);
  // As stored: encrypted names, encrypted sizes.
  const folders = (await request(`/v1/drive/folders/${remote.remoteRootDriveItemId}/children`))
    .items as { id: string; name: string }[];
  expect(folders).toHaveLength(1);
  expect(isEncryptedName(folders[0].name)).toBe(true);
  const stored = (await request(`/v1/drive/folders/${folders[0].id}/children`)).items as {
    name: string;
    sizeBytes: number;
    encrypted?: boolean;
  }[];
  expect(stored).toHaveLength(6);
  for (const file of stored) {
    expect(isEncryptedName(file.name)).toBe(true);
    expect(file.encrypted).toBe(true);
    expect(file.sizeBytes).toBe(encryptedSize('return 0'.length));
  }
  // Through the app, everything reads as the person named it.
  const seen = (await api.request(`/v1/drive/folders/${folders[0].id}/children`)).items as {
    name: string;
  }[];
  expect(seen.map((file) => file.name).sort()).toEqual(
    Array.from({ length: 6 }, (_, index) => `return-${index}.pdf`),
  );
  const { items: runs } = await request(`/v1/backups/${remote.id}/runs`);
  expect(runs).toEqual([expect.objectContaining({ state: 'COMPLETED', fileCount: 6 })]);
  // And what storage holds decrypts back to each file's contents.
  const contents = await Promise.all(
    // Copied out: a Buffer's slice shares its pool, which the header reader doesn't expect.
    [...storage.objects.values()].map(async (stored) => {
      const object = new Uint8Array(stored);
      const cipher = await FileCipher.open(keys!, object);
      const plain = await cipher.decryptRange(
        'return 0'.length,
        0,
        'return 0'.length,
        object.subarray(HEADER_SIZE),
      );
      return Buffer.from(plain).toString();
    }),
  );
  expect(contents.sort()).toEqual(Array.from({ length: 6 }, (_, index) => `return ${index}`));
});

describe('restores', () => {
  // Backs up the files, each last changed a day ago, and returns them by path.
  const backedUp = async (
    { directory, engine, api, remote }: Awaited<ReturnType<typeof backupFolder>>,
    files: Record<string, string>,
  ) => {
    const changed = new Date(Date.now() - 24 * 3600_000);
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await writeFile(path.join(directory, name), contents);
      await utimes(path.join(directory, name), changed, changed);
    }
    await engine.backupNow('local');
    await engine.tick();
    const items = new Map<string, { id: string; type: string; currentVersionId: string }>();
    const walk = async (parentId: string, folder: string) => {
      for (const item of (await api.list(parentId)).items) {
        const relative = folder ? `${folder}/${item.name}` : item.name;
        items.set(relative, item as never);
        if (item.type === 'FOLDER') await walk(item.id, relative);
      }
    };
    await walk(remote.remoteRootDriveItemId, '');
    return { items, changed };
  };
  const restore = async (
    { engine, api, remote }: Awaited<ReturnType<typeof backupFolder>>,
    body: { itemId: string; versionId?: string },
  ) => {
    await api.request(`/v1/backups/${remote.id}/restores`, {
      method: 'POST',
      body: { id: crypto.randomUUID(), ...body },
    });
    engine.restoreSoon();
    await engine.tick();
    const { items } = await api.request(`/v1/backups/${remote.id}/restores`);
    return items as { state: string; error?: string; folder?: boolean }[];
  };
  const newFileMode = 0o666 & ~process.umask();

  it('puts a deleted file back as it was, with its modified time and usual permissions', async () => {
    const folder = await backupFolder();
    const { directory, states } = folder;
    const { items, changed } = await backedUp(folder, { 'Taxes/2025/return.pdf': 'tax return' });
    const file = path.join(directory, 'Taxes/2025/return.pdf');
    await rm(file);
    states.length = 0;
    const file1 = items.get('Taxes/2025/return.pdf')!;
    const [request] = await restore(folder, {
      itemId: file1.id,
      versionId: file1.currentVersionId,
    });
    expect(request.state).toBe('COMPLETED');
    expect(await readFile(file, 'utf8')).toBe('tax return');
    const info = await stat(file);
    expect(Math.abs(info.mtimeMs - changed.getTime())).toBeLessThan(1000);
    expect(info.mode & 0o777).toBe(newFileMode);
    // The window was told which file was being restored, then how it went.
    expect(
      states.some((state) => state.restoring?.local?.relativePath === 'Taxes/2025/return.pdf'),
    ).toBe(true);
    expect(states.at(-1)?.restoring?.local).toBeUndefined();
    expect(states.at(-1)?.restored?.local).toMatchObject({ restored: 1, unchanged: 0, failed: 0 });
  });

  it('restores a folder: missing and changed files come back, others are left alone', async () => {
    const folder = await backupFolder();
    const { directory, states } = folder;
    const { items } = await backedUp(folder, {
      'Photos/beach.jpg': 'beach',
      'Photos/2024/hike.jpg': 'hike',
      'Photos/2024/snow.jpg': 'snow',
      'notes.txt': 'notes',
    });
    await rm(path.join(directory, 'Photos/beach.jpg'));
    await writeFile(path.join(directory, 'Photos/2024/hike.jpg'), 'edited');
    // Never backed up: kept.
    await writeFile(path.join(directory, 'Photos/new.jpg'), 'new');
    await rm(path.join(directory, 'notes.txt'));
    const [request] = await restore(folder, { itemId: items.get('Photos')!.id });
    expect(request).toMatchObject({ state: 'COMPLETED', folder: true });
    expect(await readFile(path.join(directory, 'Photos/beach.jpg'), 'utf8')).toBe('beach');
    expect(await readFile(path.join(directory, 'Photos/2024/hike.jpg'), 'utf8')).toBe('hike');
    expect(await readFile(path.join(directory, 'Photos/2024/snow.jpg'), 'utf8')).toBe('snow');
    expect(await readFile(path.join(directory, 'Photos/new.jpg'), 'utf8')).toBe('new');
    // Outside the folder restored.
    await expect(stat(path.join(directory, 'notes.txt'))).rejects.toThrow();
    expect(states.at(-1)?.restored?.local).toMatchObject({ restored: 2, unchanged: 1, failed: 0 });
  });

  it('restores the whole backed-up folder', async () => {
    const folder = await backupFolder();
    const { directory, remote, states } = folder;
    const { changed } = await backedUp(folder, { 'a.txt': 'a', 'Docs/b.txt': 'b' });
    await rm(path.join(directory, 'Docs'), { recursive: true });
    const [request] = await restore(folder, { itemId: remote.remoteRootDriveItemId });
    expect(request.state).toBe('COMPLETED');
    expect(await readFile(path.join(directory, 'Docs/b.txt'), 'utf8')).toBe('b');
    const restored = await stat(path.join(directory, 'Docs/b.txt'));
    expect(Math.abs(restored.mtimeMs - changed.getTime())).toBeLessThan(1000);
    expect(states.at(-1)?.restored?.local).toMatchObject({ restored: 1, unchanged: 1 });
  });

  it('gives a restored folder’s files the time this computer saved them, if the cloud has none', async () => {
    const folder = await backupFolder();
    const { directory, remote, api } = folder;
    const { changed } = await backedUp(folder, { 'Docs/b.txt': 'b' });
    // As files backed up before uploads recorded their time are listed.
    const list = api.list.bind(api);
    vi.spyOn(api, 'list').mockImplementation(async (...args) => {
      const page = await list(...args);
      return { ...page, items: page.items.map((item) => ({ ...item, modifiedAt: null })) };
    });
    await rm(path.join(directory, 'Docs/b.txt'));
    await restore(folder, { itemId: remote.remoteRootDriveItemId });
    const restored = await stat(path.join(directory, 'Docs/b.txt'));
    expect(Math.abs(restored.mtimeMs - changed.getTime())).toBeLessThan(1000);
  });

  it('refuses a version for a folder, and a file without one', async () => {
    const folder = await backupFolder();
    const { items } = await backedUp(folder, { 'Docs/b.txt': 'b' });
    const file = items.get('Docs/b.txt')!;
    for (const body of [
      { itemId: items.get('Docs')!.id, versionId: file.currentVersionId },
      { itemId: file.id },
    ])
      await expect(
        folder.api.request(`/v1/backups/${folder.remote.id}/restores`, {
          method: 'POST',
          body: { id: crypto.randomUUID(), ...body },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('restores an encrypted account’s folder under the names the person gave it', async () => {
    const folder = await backupFolder({ encrypted: true });
    const { directory, remote } = folder;
    const { changed } = await backedUp(folder, { 'Taxes/return.pdf': 'tax return' });
    await rm(path.join(directory, 'Taxes'), { recursive: true });
    const [request] = await restore(folder, { itemId: remote.remoteRootDriveItemId });
    expect(request).toMatchObject({ state: 'COMPLETED' });
    const file = path.join(directory, 'Taxes/return.pdf');
    expect(await readFile(file, 'utf8')).toBe('tax return');
    expect(Math.abs((await stat(file)).mtimeMs - changed.getTime())).toBeLessThan(1000);
  });
});
