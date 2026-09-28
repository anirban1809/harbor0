import { afterEach, beforeEach, expect, it } from 'vitest';
import { Journal, type Root } from '../src/journal';
import { syncView } from '../src/sync-view';
import { localSyncId, mergeSyncItems } from '../src/sync-drive';
import type { SyncRuntime } from '../src/sync-state';

let journal: Journal;
let state: SyncRuntime;
const root: Root = {
  id: 'root',
  localPath: '/local',
  remoteId: 'cloud',
  mode: 'sync',
  paused: false,
  excluded: [],
};
beforeEach(() => {
  journal = new Journal(':memory:');
  journal.root(root);
  state = {
    running: false,
    paused: false,
    online: true,
    message: '',
    queued: 0,
    lastSync: null,
    active: null,
    issues: [],
    recent: [],
  };
});
afterEach(() => journal.close());
const queueFile = (relative: string) =>
  journal.enqueue(root.id, relative, 'upsert', {
    type: 'FILE',
    sizeBytes: 500,
    updatedAt: '2026-09-26T10:00:00Z',
  });

it('shows a new file before it has a cloud ID and progresses from pending to syncing', () => {
  queueFile('report.txt');
  const pending = syncView(journal, state);
  expect(pending.driveItems).toEqual([
    expect.objectContaining({
      name: 'report.txt',
      parentId: 'cloud',
      localOnly: true,
      syncStatus: 'Pending',
      sizeBytes: 500,
    }),
  ]);
  state.active = {
    rootId: root.id,
    relativePath: 'report.txt',
    direction: 'upload',
    loaded: 250,
    total: 500,
  };
  expect(syncView(journal, state).driveItems[0]).toMatchObject({
    syncStatus: 'Syncing',
    syncProgress: 50,
  });
});

it('creates browsable pending ancestors and resolves them to cloud folders after creation', () => {
  queueFile('new/sub/report.txt');
  const first = syncView(journal, state);
  const folder = mergeSyncItems([], first.driveItems, 'cloud')[0];
  expect(folder).toMatchObject({ name: 'new', type: 'FOLDER', localOnly: true });
  const sub = mergeSyncItems([], first.driveItems, folder.id)[0];
  expect(mergeSyncItems([], first.driveItems, sub.id)[0]).toMatchObject({ name: 'report.txt' });
  journal.putFile({
    rootId: root.id,
    relativePath: 'new',
    itemId: 'new-cloud',
    revision: 1,
    hash: null,
    type: 'FOLDER',
  });
  const next = syncView(journal, state);
  expect(next.folderIds[folder.id]).toBe('new-cloud');
  expect(mergeSyncItems([], next.driveItems, 'new-cloud')[0]).toMatchObject({ name: 'sub' });
});

it('annotates existing files without duplicating or replacing cloud metadata', () => {
  queueFile('report.txt');
  const cloud = [
    { id: 'real', name: 'report.txt', type: 'FILE' as const, sizeBytes: 100, revision: 7 },
  ];
  const merged = mergeSyncItems(cloud, syncView(journal, state).driveItems, 'cloud');
  expect(merged).toEqual([
    {
      ...cloud[0],
      syncStatus: 'Pending',
      syncDetail: 'Waiting to upload',
      syncProgress: undefined,
    },
  ]);
  expect(mergeSyncItems(cloud, [], 'cloud')).toEqual(cloud);
  expect(mergeSyncItems([], syncView(journal, state).driveItems, 'other-folder')).toEqual([]);
});

it('keeps paused, offline, and failed uploads visible as pending', () => {
  queueFile('report.txt');
  state.paused = true;
  expect(syncView(journal, state).driveItems[0]).toMatchObject({
    syncStatus: 'Pending',
    syncDetail: 'Sync is paused',
  });
  state.paused = false;
  state.online = false;
  expect(syncView(journal, state).driveItems[0].syncDetail).toBe('Waiting for a connection');
  const job = journal.jobs()[0];
  journal.saveJob({ ...job, error: 'Storage full', attempts: 1 });
  expect(syncView(journal, state).driveItems[0].syncDetail).toContain('Storage full');
});

it('does not invent files for deletions, exclusions, backups, or removed roots', () => {
  journal.enqueue(root.id, 'deleted.txt', 'delete');
  queueFile('excluded/file.txt');
  journal.root({ ...root, excluded: ['excluded'] });
  journal.root({ ...root, id: 'backup', mode: 'backup' });
  journal.enqueue('backup', 'backup.txt', 'upsert');
  journal.enqueue('removed', 'removed.txt', 'upsert');
  expect(syncView(journal, state).driveItems).toEqual([]);
});

it('shows an in-progress download against its existing cloud file', () => {
  state.active = {
    rootId: root.id,
    relativePath: 'download.txt',
    direction: 'download',
    loaded: 20,
    total: 100,
  };
  const cloud = [{ id: 'download', name: 'download.txt', type: 'FILE' as const, sizeBytes: 100 }];
  expect(mergeSyncItems(cloud, syncView(journal, state).driveItems, 'cloud')).toEqual([
    { ...cloud[0], syncStatus: 'Syncing', syncDetail: 'Downloading', syncProgress: 20 },
  ]);
});

it('removes pending state after completion and keeps stable folder aliases', () => {
  queueFile('new/report.txt');
  journal.putFile({
    rootId: root.id,
    relativePath: 'new',
    itemId: 'folder',
    revision: 1,
    hash: null,
    type: 'FOLDER',
  });
  journal.finish(journal.jobs()[0].id);
  const snapshot = syncView(journal, state);
  expect(snapshot.driveItems).toEqual([]);
  expect(snapshot.folderIds[localSyncId(root.id, 'new')]).toBe('folder');
});
