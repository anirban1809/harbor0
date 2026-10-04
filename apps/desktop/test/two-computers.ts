import { afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { StorageService } from '../../backend/src/domain';
import { MemoryRepository } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { DevelopmentAuth } from '../../backend/src/auth';
import { createApp } from '../../backend/src/api';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';

// Shared by the sync tests that run real engines against a real in-memory backend. Test files
// using it mock '../src/local-watcher' themselves and queue changes by hand, as the watcher would.
export const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** One account syncing the same cloud folder on two computers. */
export async function twoComputers() {
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
    const notices: string[] = [];
    const engine = new SyncEngine(
      client,
      journal,
      deviceId,
      () => {},
      (title, body) => notices.push(`${title}: ${body}`),
    );
    cleanup.push(() => engine.stop());
    computers.push({ api: client, journal, root, engine, localPath, notices });
  }
  return { computers, folder, cloud, service };
}
export const tick = async (computer: { engine: SyncEngine }) => {
  await computer.engine.tick();
  await computer.engine.tick();
};
