import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { StorageService, userPK, type Account } from '../../backend/src/domain';
import { MemoryRepository, transact } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { DevelopmentAuth } from '../../backend/src/auth';
import { createApp } from '../../backend/src/api';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';

// Changes are queued by hand, as the watcher would; files, engine, API and hashes are real.
vi.mock('../src/local-watcher', () => ({
  watchTree: () => ({
    on() {
      return this;
    },
    async close() {},
  }),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** One account syncing the same cloud folder on two computers. */
async function twoComputers() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-two-computers-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const storage = new MemoryStorage();
  const service = new StorageService(new MemoryRepository(), storage);
  const { app } = createApp(service, new DevelopmentAuth());
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    if (url.protocol !== 'memory:') throw new Error('Unexpected network request: ' + raw);
    if (init?.method === 'PUT') {
      storage.uploads
        .get(url.hostname)!
        .parts.set(Number(url.pathname.slice(1)), new Uint8Array(init.body as Buffer));
      return new Response('', { headers: { etag: 'part-1' } });
    }
    return new Response(Buffer.from(storage.objects.get(url.pathname.slice(1))!));
  });
  const api = (token: string) =>
    new ApiClient(async (endpoint, init) => {
      const response = await app.request(endpoint, {
        method: init?.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  const sessions = [];
  for (const name of ['first', 'second']) {
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.test',
        password: 'Development-only-123!',
        deviceName: name,
        platform: 'MACOS',
      }),
    });
    const { accessToken, device } = await login.json();
    sessions.push({ name, client: api(accessToken), deviceId: device.id as string });
  }
  const cloud = sessions[0].client;
  const folder = (await cloud.createFolder('Synced')).item;
  const computers = [];
  for (const { name, client, deviceId } of sessions) {
    await client.request('/v1/sync/folders', { method: 'PUT', body: { folderIds: [folder.id] } });
    const localPath = path.join(directory, name);
    await mkdir(localPath);
    const journal = new Journal(':memory:');
    cleanup.push(async () => journal.close());
    const root: Root = {
      id: 'root',
      localPath,
      remoteId: folder.id,
      mode: 'sync',
      paused: false,
      excluded: [],
      needsReconcile: true,
    };
    journal.root(root);
    const engine = new SyncEngine(client, journal, deviceId, () => {});
    cleanup.push(() => engine.stop());
    computers.push({ api: client, journal, root, engine, localPath });
  }
  return { computers, folder, cloud, service };
}
const tick = async (computer: { engine: SyncEngine }) => {
  await computer.engine.tick();
  await computer.engine.tick();
};

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
