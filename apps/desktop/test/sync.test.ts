import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';
import { ApiClient } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
it('remote deletion preserves divergent local content as a conflict copy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-sync-'));
  const journal = new Journal(path.join(directory, 'journal.sqlite'));
  const root: Root = {
    id: 'root',
    localPath: directory,
    remoteId: null,
    mode: 'sync',
    paused: false,
    excluded: [],
  };
  try {
    await writeFile(path.join(directory, 'notes.txt'), 'unsynced changes');
    journal.root(root);
    journal.putFile({
      rootId: root.id,
      relativePath: 'notes.txt',
      itemId: 'file',
      revision: 1,
      hash: createHash('sha256').update('old content').digest('hex'),
      type: 'FILE',
    });
    const api = new ApiClient(async () => {
      throw new Error('No network required for deletion');
    });
    const engine = new SyncEngine(api, journal, 'device', () => {});
    await engine.remoteItem(root, {
      id: 'file',
      ownerUserId: 'alice',
      parentId: null,
      name: 'notes.txt',
      normalizedName: 'notes.txt',
      type: 'FILE',
      mimeType: 'text/plain',
      sizeBytes: 11,
      currentVersionId: 'version',
      revision: 2,
      favorite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: new Date().toISOString(),
    } satisfies DriveItem);
    const conflict = (await readdir(directory)).find((f) => f.includes('(Conflict'));
    expect(conflict).toBeDefined();
    expect(await readFile(path.join(directory, conflict!), 'utf8')).toBe('unsynced changes');
    expect(journal.jobs()).toHaveLength(1);
    expect(engine.state.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CONFLICT',
          relativePath: 'notes.txt',
          conflictPath: conflict,
        }),
      ]),
    );
    const reopened = new SyncEngine(api, journal, 'device', () => {});
    expect(reopened.state.issues[0].code).toBe('CONFLICT');
    expect(journal.file(root.id, 'notes.txt')).toBeUndefined();
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it('rejects overlapping backup and sync roots before starting watchers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-roots-'));
  const journal = new Journal(path.join(directory, 'journal.sqlite'));
  try {
    journal.root({
      id: 'one',
      localPath: directory,
      remoteId: null,
      mode: 'sync',
      paused: false,
      excluded: [],
    });
    const engine = new SyncEngine(new ApiClient(async () => ({})), journal, 'device', () => {});
    await expect(
      engine.addRoot({
        id: 'two',
        localPath: path.join(directory, 'nested'),
        remoteId: 'backup',
        mode: 'backup',
        paused: false,
        excluded: [],
      }),
    ).rejects.toThrow('overlap');
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains the last successful background check across restarts and failures', async () => {
  const journal = new Journal(':memory:');
  try {
    const api = new ApiClient(async (endpoint) =>
      endpoint.startsWith('/v1/sync/changes') ? { changes: [], nextCursor: 0, hasMore: false } : {},
    );
    const engine = new SyncEngine(api, journal, 'device', () => {});
    expect(engine.state.lastSync).toBeNull();
    await engine.tick();
    const lastSync = engine.state.lastSync;
    expect(lastSync).toBeTruthy();
    const restarted = new SyncEngine(
      new ApiClient(async () => {
        throw new TypeError('Offline');
      }),
      journal,
      'device',
      () => {},
    );
    expect(restarted.state.lastSync).toBe(lastSync);
    await restarted.tick();
    expect(restarted.state.lastSync).toBe(lastSync);
    expect(restarted.state.online).toBe(false);
  } finally {
    journal.close();
  }
});
