import { expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient, ApiError } from '@harbor/api-client';
import { MemoryRepository } from '../../backend/src/repository';
import { MemoryStorage } from '../../backend/src/storage';
import { StorageService } from '../../backend/src/domain';
import { createApp } from '../../backend/src/api';
import { DevelopmentAuth } from '../../backend/src/auth';
import { Journal, type Root } from '../src/journal';
import { NETWORK_TIMEOUT, SyncEngine } from '../src/sync';

// Drives are directories under a fake mount area; each mounted one has an id.
const drives = vi.hoisted(() => ({ base: '', ids: new Map<string, string>() }));
vi.mock('../src/volumes', async (original) => {
  const actual = await original<typeof import('../src/volumes')>();
  const { stat } = await import('node:fs/promises');
  const path = await import('node:path');
  const mounted = async (root: string) => !!(await stat(root).catch(() => null));
  return {
    ...actual,
    volumeRoot: (local: string) => {
      const relative = path.relative(drives.base, local);
      return !drives.base || relative.startsWith('..') || !relative
        ? null
        : path.join(drives.base, relative.split(path.sep)[0]);
    },
    volumeId: async (root: string) => ((await mounted(root)) ? drives.ids.get(root) : null) ?? null,
    findVolume: async (id: string) => {
      for (const [root, value] of drives.ids)
        if (value === id && (await mounted(root))) return root;
      return null;
    },
  };
});
vi.mock('../src/local-watcher', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    watchTree: vi.fn(() => Object.assign(new EventEmitter(), { close: async () => {} })),
  };
});

it('maps paths to swappable drives on macOS and Windows', async () => {
  const { volumeLabel, volumeRoot } =
    await vi.importActual<typeof import('../src/volumes')>('../src/volumes');
  expect(volumeRoot('/Volumes/Photos SSD/2024/Trip', 'darwin')).toBe('/Volumes/Photos SSD');
  expect(volumeRoot('/Users/me/Documents', 'darwin')).toBeNull();
  expect(volumeRoot('E:\\Photos\\Trip', 'win32')).toBe('E:\\');
  expect(volumeRoot('c:\\Users\\me', 'win32')).toBeNull();
  expect(volumeRoot('\\\\nas\\share\\Photos', 'win32')).toBe('\\\\NAS\\SHARE\\');
  expect(volumeLabel('\\\\NAS\\SHARE\\')).toBe('\\\\NAS\\SHARE');
  expect(volumeRoot('/media/usb/Photos', 'linux')).toBeNull();
  expect(volumeLabel('E:\\')).toBe('E:');
  expect(volumeLabel('/Volumes/Photos SSD')).toBe('Photos SSD');
});

it('backs up only from the drive the folder was added on, follows it to a new mount point and reads read-only drives', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-drives-'));
  drives.base = path.join(directory, 'Volumes');
  const mount = path.join(drives.base, 'USB');
  const local = path.join(mount, 'Photos');
  await mkdir(local, { recursive: true });
  await writeFile(path.join(local, 'a.jpg'), 'ours');
  drives.ids.set(mount, 'drive-a');
  const journal = new Journal(':memory:');
  const storage = new MemoryStorage();
  const { app } = createApp(
    new StorageService(new MemoryRepository(), storage),
    new DevelopmentAuth(),
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
  const names = async (id: string) =>
    ((await api.list(id)).items as { name: string }[]).map((i) => i.name).sort();
  const issue = () => engine.state.issues.find((i) => i.rootId === 'drive' && !i.jobId);
  try {
    const { root: remote } = await api.request('/v1/backups', {
      method: 'POST',
      body: { operationId: crypto.randomUUID(), deviceId: session.device.id, name: 'Photos' },
    });
    const root: Root = {
      id: 'drive',
      backupId: remote.id,
      remoteId: remote.remoteRootDriveItemId,
      localPath: local,
      mode: 'backup',
      paused: false,
      excluded: [],
    };
    journal.root(root);
    await engine.backupNow(root.id);
    await engine.tick();
    expect(await names(root.remoteId!)).toEqual(['a.jpg']);
    expect(journal.roots()[0].volume).toEqual({ root: mount, id: 'drive-a' });

    // Unplugged: a plain-language reason, and Back up now says the same.
    await rename(mount, path.join(directory, 'away'));
    await engine.tick();
    expect(issue()).toMatchObject({
      code: 'DRIVE_MISSING',
      message: 'The drive “USB” isn’t connected. Backups resume when you connect it.',
    });
    await expect(engine.backupNow(root.id)).rejects.toThrow('The drive “USB” isn’t connected.');

    // Another drive with a folder of the same name is mounted in its place.
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'someone-elses.jpg'), 'not ours');
    drives.ids.set(mount, 'drive-b');
    await engine.tick();
    expect(issue()?.code).toBe('WRONG_DRIVE');
    await expect(engine.backupNow(root.id)).rejects.toThrow('A different drive is connected');
    await engine.tick();
    expect(await names(root.remoteId!)).toEqual(['a.jpg']);

    // Our drive comes back under another name; the folder follows it.
    const moved = path.join(drives.base, 'USB 1');
    await rename(path.join(directory, 'away'), moved);
    drives.ids.set(moved, 'drive-a');
    await writeFile(path.join(moved, 'Photos', 'b.jpg'), 'ours too');
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] });
    await engine.tick();
    vi.useRealTimers();
    expect(journal.roots()[0]).toMatchObject({
      localPath: path.join(moved, 'Photos'),
      volume: { root: moved, id: 'drive-a' },
    });
    expect(issue()).toBeUndefined();
    await engine.backupNow(root.id);
    await engine.tick();
    expect(await names(root.remoteId!)).toEqual(['a.jpg', 'b.jpg']);

    // A read-only folder is still backed up.
    await chmod(path.join(moved, 'Photos'), 0o555);
    await engine.tick();
    expect(issue()).toBeUndefined();
    expect(await engine.backupNow(root.id)).toMatchObject({ changes: 0 });
  } finally {
    await chmod(path.join(drives.base, 'USB 1', 'Photos'), 0o755).catch(() => {});
    await engine.stop();
    fetchMock.mockRestore();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('gives up on a network share that stops answering and leaves it alone until it does', async () => {
  vi.useFakeTimers();
  const journal = new Journal(':memory:');
  const engine = new SyncEngine({} as ApiClient, journal, 'device', () => {});
  const root: Root = {
    id: 'nas',
    remoteId: 'remote',
    localPath: '/Volumes/photos/2024',
    mode: 'backup',
    paused: false,
    excluded: [],
  };
  const internals = engine as unknown as {
    shares: Map<string, string>;
    onShare: <T>(root: Root, work: () => Promise<T>) => Promise<T>;
  };
  internals.shares.set(root.id, '/Volumes/photos');
  try {
    let answer!: () => void;
    const stuck = internals.onShare(root, () => new Promise<void>((done) => (answer = done)));
    const failed = expect(stuck).rejects.toMatchObject({
      code: 'SHARE_UNAVAILABLE',
      message: 'The network share “photos” isn’t responding. Backups resume when it’s back.',
    });
    await vi.advanceTimersByTimeAsync(NETWORK_TIMEOUT);
    await failed;
    // Nothing more is sent while the first request is still stuck.
    const work = vi.fn(async () => 'listed');
    await expect(internals.onShare(root, work)).rejects.toMatchObject({
      code: 'SHARE_UNAVAILABLE',
    });
    expect(work).not.toHaveBeenCalled();
    answer();
    await vi.advanceTimersByTimeAsync(0);
    await expect(internals.onShare(root, work)).resolves.toBe('listed');
  } finally {
    vi.useRealTimers();
    journal.close();
  }
});
