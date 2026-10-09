import { it, expect } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ApiClient } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';
import { internalPath } from '../src/paths';
import {
  folderState,
  globalSyncState,
  syncIssueCode,
  WAITING,
  type SyncFolder,
} from '../src/sync-state';

const item = (overrides: Partial<DriveItem>): DriveItem =>
  ({
    id: 'item',
    ownerUserId: 'alice',
    parentId: 'remote',
    name: 'item',
    normalizedName: 'item',
    type: 'FILE',
    mimeType: 'text/plain',
    sizeBytes: 1,
    currentVersionId: 'version',
    revision: 2,
    favorite: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  }) as DriveItem;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-resilience-'));
  const local = path.join(directory, 'synced');
  await mkdir(local);
  const journal = new Journal(path.join(directory, 'journal.sqlite'));
  const root: Root = {
    id: 'root',
    localPath: local,
    remoteId: 'remote',
    mode: 'sync',
    paused: false,
    excluded: [],
  };
  journal.root(root);
  const folder = (): SyncFolder => ({
    ...journal.roots()[0],
    localPathDisplayName: 'synced',
    fileCount: 0,
    folderCount: 0,
  });
  return {
    local,
    journal,
    root,
    folder,
    async close() {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// chmod can't take away read access on Windows, so the file would upload normally there.
it.skipIf(process.platform === 'win32')(
  'keeps syncing other work when one file cannot be read',
  async () => {
    const { local, journal, root, close } = await fixture();
    const requests: string[] = [];
    const api = new ApiClient(async (endpoint, init) => {
      requests.push(`${init?.method ?? 'GET'} ${endpoint}`);
      return endpoint.startsWith('/v1/sync/changes')
        ? { changes: [], nextCursor: 7, hasMore: false }
        : {};
    });
    const engine = new SyncEngine(api, journal, 'device', () => {});
    try {
      await writeFile(path.join(local, 'locked.txt'), 'secret');
      await chmod(path.join(local, 'locked.txt'), 0o000);
      journal.enqueue(root.id, 'locked.txt', 'upsert');
      await new Promise((resolve) => setTimeout(resolve, 5));
      journal.putFile({
        rootId: root.id,
        relativePath: 'gone.txt',
        itemId: 'gone',
        revision: 1,
        hash: 'hash',
        type: 'FILE',
      });
      journal.enqueue(root.id, 'gone.txt', 'delete');
      await engine.tick();
      // The later deletion and the remote feed still ran.
      expect(requests).toContain('DELETE /v1/drive/items/gone');
      expect(journal.get('cursor')).toBe(7);
      expect(engine.state.lastSync).toBeTruthy();
      const [failed] = journal.jobs();
      expect(journal.jobs()).toHaveLength(1);
      expect(failed).toMatchObject({ relativePath: 'locked.txt', attempts: 1 });
      expect(failed.payload.retryAt).toBeGreaterThan(Date.now());
      expect(engine.state.issues).toEqual([
        expect.objectContaining({
          code: 'PERMISSION_DENIED',
          scope: 'item',
          jobId: failed.id,
          relativePath: 'locked.txt',
        }),
      ]);
      // The failed file waits for its retry time rather than being hammered every tick.
      await engine.tick();
      expect(journal.jobs()[0].attempts).toBe(1);
      expect(engine.state.issues).toHaveLength(1);
      // Resuming retries immediately; once readable, the problem clears by itself.
      engine.pause(true);
      engine.pause(false);
      expect(journal.jobs()[0].payload.retryAt).toBeUndefined();
    } finally {
      await chmod(path.join(local, 'locked.txt'), 0o600).catch(() => {});
      await engine.stop();
      await close();
    }
  },
);

it('does not mistake one missing file for a missing sync folder', () => {
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
  expect(syncIssueCode(missing)).toBe('FOLDER_MISSING');
  expect(syncIssueCode(missing, true)).toBe('SYNC_ERROR');
});

it('names conflict copies after this computer', async () => {
  const { local, journal, root, close } = await fixture();
  try {
    journal.set('deviceName', 'Study Mac.local');
    await writeFile(path.join(local, 'notes.txt'), 'unsynced changes');
    journal.putFile({
      rootId: root.id,
      relativePath: 'notes.txt',
      itemId: 'file',
      revision: 1,
      hash: createHash('sha256').update('old content').digest('hex'),
      type: 'FILE',
    });
    const engine = new SyncEngine(new ApiClient(async () => ({})), journal, 'device', () => {});
    await engine.remoteItem(
      root,
      item({ id: 'file', name: 'notes.txt', deletedAt: new Date().toISOString() }),
    );
    const names = await readdir(local);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^notes \(Conflict - Study Mac - [0-9a-f]{8}\)\.txt$/);
  } finally {
    await close();
  }
});

it('keeps a remotely deleted folder under a visible name and reports it once', async () => {
  const { local, journal, root, folder, close } = await fixture();
  try {
    await mkdir(path.join(local, 'plans', 'empty'), { recursive: true });
    await writeFile(path.join(local, 'plans', 'draft.txt'), 'keep me');
    await writeFile(path.join(local, 'plans', 'empty', '.DS_Store'), '');
    for (const [relativePath, itemId] of [
      ['plans', 'plans'],
      ['plans/empty', 'empty'],
    ])
      journal.putFile({
        rootId: root.id,
        relativePath,
        itemId,
        revision: 1,
        hash: null,
        type: 'FOLDER',
      });
    const engine = new SyncEngine(new ApiClient(async () => ({})), journal, 'device', () => {});
    const deleted = { type: 'FOLDER' as const, deletedAt: new Date().toISOString() };
    // A folder holding nothing but file-manager metadata is simply removed.
    await engine.remoteItem(root, item({ ...deleted, id: 'empty', name: 'empty' }));
    expect(await readdir(path.join(local, 'plans'))).toEqual(['draft.txt']);
    expect(engine.state.issues).toEqual([]);
    await engine.remoteItem(root, item({ ...deleted, id: 'plans', name: 'plans' }));
    const [kept] = await readdir(local);
    expect(kept).toMatch(/^plans \(Recovered by harbor0 \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\)$/);
    expect(await readFile(path.join(local, kept, 'draft.txt'), 'utf8')).toBe('keep me');
    // The kept copy must not be uploaded again as a new folder.
    expect(internalPath(`${kept}/draft.txt`)).toBe(true);
    expect(engine.state.issues).toEqual([
      expect.objectContaining({
        code: 'FOLDER_RECOVERED',
        relativePath: 'plans',
        conflictPath: kept,
      }),
    ]);
    // Informational only: the folder itself is healthy.
    expect(folderState(folder(), engine.state, [])).toBe('Up to date');
    expect(globalSyncState([folder()], engine.state, [])).toBe('Up to date');
    engine.dismissConflict(engine.state.issues[0].id);
    expect(engine.state.issues).toEqual([]);
  } finally {
    await close();
  }
});

it('shows files that are only on another device as waiting, not up to date', async () => {
  const { journal, root, folder, close } = await fixture();
  try {
    const remote = item({
      id: 'file',
      name: 'video.mov',
      cloudState: 'RELEASED',
    } as Partial<DriveItem>);
    const requests: string[] = [];
    const api = new ApiClient(async (endpoint, init) => {
      requests.push(`${init?.method ?? 'GET'} ${endpoint}`);
      if (endpoint === '/v1/drive/items/file') return { item: remote };
      if (endpoint === '/v1/drive/items/file/versions')
        return { items: [{ id: 'version', contentHash: 'abc' }] };
      return {};
    });
    const engine = new SyncEngine(api, journal, 'device', () => {});
    await engine.remoteItem(root, remote);
    expect(requests).toContain('POST /v1/sync/items/file/request-content');
    const state = { ...engine.state, waiting: [{ rootId: root.id, relativePath: 'video.mov' }] };
    expect(folderState(folder(), state, [])).toBe(WAITING);
    expect(globalSyncState([folder()], state, [])).toBe(WAITING);
    // The engine publishes the same list with its next state update.
    let published: { waiting?: unknown } = {};
    const observed = new SyncEngine(api, journal, 'device', (next) => {
      published = next as { waiting?: unknown };
    });
    await observed.remoteItem(root, remote);
    expect(published.waiting).toEqual([{ rootId: root.id, relativePath: 'video.mov' }]);
    await observed.remoteItem(root, { ...remote, deletedAt: new Date().toISOString() });
    observed.dismissConflict('none');
    expect(published.waiting).toEqual([]);
  } finally {
    await close();
  }
});
