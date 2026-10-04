import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  expect(journal.roots()[0].lastBackupError).toMatch(/storage/);

  await quota(10_000);
  await engine.backupNow('local');
  await engine.tick();
  expect(await states()).toEqual(['COMPLETED', 'PARTIAL']);
  expect(journal.roots()[0].lastBackupError).toBeUndefined();
});
