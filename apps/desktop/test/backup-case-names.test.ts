import { expect, it, vi } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { MemoryRepository } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { StorageService } from '../../backend/src/domain';
import { createApp } from '../../backend/src/api';
import { DevelopmentAuth } from '../../backend/src/auth';
import { Journal, type Root } from '../src/journal';
import { SyncEngine, caseAlias } from '../src/sync';
import { FolderBackups, BACKUP_QUIET_MS } from '../src/backups';
vi.mock('../src/local-watcher', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    watchTree: vi.fn(() => Object.assign(new EventEmitter(), { close: async () => {} })),
  };
});

it('names an alias after the file, before its extension', () => {
  expect(caseAlias('IMG_8692.mov')).toBe('IMG_8692 (Case Conflict).mov');
  expect(caseAlias('photos')).toBe('photos (Case Conflict)');
  expect(caseAlias('IMG_8692.mov', 2)).toBe('IMG_8692 (Case Conflict 2).mov');
  expect(caseAlias('.hidden')).toBe('.hidden (Case Conflict)');
});

it('backs up files and folders whose names differ only in case, and restores each to its name', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-backup-case-'));
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
  const old = new Date(Date.now() - BACKUP_QUIET_MS - 1000);
  /** Writes a file that has been quiet long enough to back up, and queues it. */
  const write = async (relative: string, data: string) => {
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    await utimes(target, old, old);
    journal.enqueue('local', relative, 'upsert');
  };
  /** Removes it here, as a case-sensitive drive would hold both while this one can't. */
  const remove = async (relative: string) => {
    await rm(path.join(directory, relative), { recursive: true });
    journal.enqueue('local', relative, 'delete');
  };
  const children = async (id: string) => (await api.list(id)).items as DriveItem[];
  try {
    const { root: remote } = await api.request('/v1/backups', {
      method: 'POST',
      body: { operationId: crypto.randomUUID(), deviceId: session.device.id, name: 'library' },
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

    await write('Clips/IMG_8692.MOV', 'the first video');
    await write('Photos/a.jpg', 'a photo');
    await engine.tick();
    await remove('Clips/IMG_8692.MOV');
    await remove('Photos');
    await write('Clips/IMG_8692.mov', 'another video');
    await write('photos/b.jpg', 'another photo');
    await engine.backupNow(root.id);
    await engine.tick();

    const [clips] = (await children(root.remoteId!)).filter((i) => i.name === 'Clips');
    expect((await children(clips!.id)).map((i) => [i.name, i.sourceName]).sort()).toEqual([
      ['IMG_8692 (Case Conflict).mov', 'IMG_8692.mov'],
      ['IMG_8692.MOV', undefined],
    ]);
    const top = (await children(root.remoteId!)).map((i) => [i.name, i.sourceName]).sort();
    expect(top).toEqual([
      ['Clips', undefined],
      ['Photos', undefined],
      ['photos (Case Conflict)', 'photos'],
    ]);
    // Every run finished cleanly: no case or path errors.
    const runs = (await api.request(`/v1/backups/${remote.id}/runs`)).items;
    expect(runs.every((run: { state: string }) => run.state === 'COMPLETED')).toBe(true);

    // Backed up again, it is the same file: no new version.
    const alias = (await children(clips!.id)).find((i) => i.sourceName)!;
    journal.enqueue('local', 'Clips/IMG_8692.mov', 'upsert');
    await engine.backupNow(root.id);
    await engine.tick();
    expect((await api.request(`/v1/drive/items/${alias.id}/versions`)).items).toHaveLength(1);

    // Restored where the other is here too: under its own name if this disk can hold both.
    await engine.stop();
    await remove('Clips/IMG_8692.mov');
    await writeFile(path.join(directory, 'Clips/IMG_8692.MOV'), 'the first video');
    const caseSensitive = !(await lstat(path.join(directory, 'Clips/img_8692.mov')).catch(
      () => null,
    ));
    await api.request(`/v1/backups/${remote.id}/restores`, {
      method: 'POST',
      body: { id: 'restore', itemId: alias.id, versionId: alias.currentVersionId },
    });
    const worker = new FolderBackups(api, journal);
    await worker.process(
      root,
      async () => {
        throw new Error('No upload expected during restore');
      },
      () => false,
    );
    const restored = caseSensitive ? 'IMG_8692.mov' : 'IMG_8692 (Case Conflict).mov';
    expect(await readFile(path.join(directory, 'Clips', restored), 'utf8')).toBe('another video');
    // The other file is untouched.
    expect(await readdir(path.join(directory, 'Clips'))).toContain('IMG_8692.MOV');
    expect(await readFile(path.join(directory, 'Clips/IMG_8692.MOV'), 'utf8')).toBe(
      'the first video',
    );
  } finally {
    await engine.stop();
    fetchMock.mockRestore();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
