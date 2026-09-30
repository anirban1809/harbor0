import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { MemoryRepository } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { StorageService } from '../../backend/src/domain';
import { createApp } from '../../backend/src/api';
import { DevelopmentAuth } from '../../backend/src/auth';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';
import { FolderBackups, BACKUP_QUIET_MS } from '../src/backups';
vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: { watch: vi.fn(() => Object.assign(new EventEmitter(), { close: async () => {} })) },
  };
});
it('backs up a real folder through HTTP routes, deduplicates content, keeps versions and restores the selected bytes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-backup-e2e-'));
  const journal = new Journal(':memory:');
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
    if (!response.ok) throw new ApiError(data.error.code, data.error.message, response.status);
    return data;
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'PUT') {
      storage.uploads
        .get(url.hostname)!
        .parts.set(Number(url.pathname.slice(1)), new Uint8Array(init.body as Buffer));
      return new Response(null, { headers: { etag: `part-${url.pathname.slice(1)}` } });
    }
    return new Response(Buffer.from(storage.objects.get(url.pathname.slice(1))!));
  });
  const engine = new SyncEngine(api, journal, session.device.id, () => {});
  try {
    const { root: remote } = await api.request('/v1/backups', {
      method: 'POST',
      body: { operationId: crypto.randomUUID(), deviceId: session.device.id, name: 'Documents' },
    });
    const root: Root = {
      id: 'local',
      backupId: remote.id,
      remoteId: remote.remoteRootDriveItemId,
      localPath: directory,
      mode: 'backup',
      paused: false,
      excluded: [],
    };
    journal.root(root);
    const target = path.join(directory, 'Nested/notes.txt');
    await mkdir(path.dirname(target));
    await writeFile(target, 'version one');
    journal.enqueue(root.id, 'Nested/notes.txt', 'upsert');
    await engine.tick();
    expect((await api.list(root.remoteId)).items).toHaveLength(0);
    const old = new Date(Date.now() - BACKUP_QUIET_MS - 1000);
    await utimes(target, old, old);
    await engine.tick();
    const nested = (await api.list(root.remoteId)).items[0];
    const first = (await api.list(nested.id)).items[0];
    expect(first.name).toBe('notes.txt');
    expect((await api.request(`/v1/backups/${remote.id}/runs`)).items).toEqual([
      expect.objectContaining({ state: 'COMPLETED', fileCount: 1, trigger: 'AUTOMATIC' }),
    ]);
    await writeFile(target, 'version two');
    journal.enqueue(root.id, 'Nested/notes.txt', 'upsert');
    await engine.backupNow(root.id);
    await engine.tick();
    expect((await api.request(`/v1/drive/items/${first.id}/versions`)).items).toHaveLength(2);
    await engine.backupNow(root.id);
    await engine.tick();
    expect((await api.request(`/v1/drive/items/${first.id}/versions`)).items).toHaveLength(2);
    await api.request(`/v1/backups/${remote.id}/restores`, {
      method: 'POST',
      body: { id: 'restore', itemId: first.id, versionId: first.currentVersionId },
    });
    // A new worker checks pending restores immediately, as on desktop restart.
    const worker = new FolderBackups(api, journal);
    await worker.process(
      root,
      async () => {
        throw new Error('No upload expected during restore');
      },
      () => false,
    );
    expect(await readFile(target, 'utf8')).toBe('version one');
    expect((await api.request(`/v1/backups/${remote.id}/restores`)).items[0].state).toBe(
      'COMPLETED',
    );
    expect((await api.request(`/v1/drive/items/${first.id}/versions`)).items).toHaveLength(2);
    await rm(target);
    journal.enqueue(root.id, 'Nested/notes.txt', 'delete');
    await engine.tick();
    expect((await api.request(`/v1/drive/items/${first.id}/versions`)).items).toHaveLength(2);
    await writeFile(target, 'local edits after disconnect');
    journal.enqueue(root.id, 'Nested/notes.txt', 'upsert');
    await api.request(`/v1/backups/${remote.id}`, { method: 'DELETE' });
    await engine.tick();
    expect(journal.roots()).toHaveLength(0);
    expect(journal.jobs()).toHaveLength(0);
    expect(await readFile(target, 'utf8')).toBe('local edits after disconnect');
    expect((await api.request(`/v1/drive/items/${first.id}/versions`)).items).toHaveLength(2);
    const current = (await api.request(`/v1/drive/items/${first.id}`)).item;
    expect(current.backupRootId).toBeUndefined();
    await api.request(`/v1/drive/items/${first.id}`, {
      method: 'PATCH',
      body: {
        operationId: crypto.randomUUID(),
        baseRevision: current.revision,
        name: 'Cloud notes.txt',
      },
    });
    expect((await api.list(nested.id)).items[0].name).toBe('Cloud notes.txt');
  } finally {
    await engine.stop();
    fetchMock.mockRestore();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
