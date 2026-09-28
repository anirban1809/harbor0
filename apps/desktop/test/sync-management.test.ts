import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';
import { cloudLocation } from '../src/sync-mapping';
import {
  folderState,
  globalSyncState,
  syncIssueCode,
  type SyncRuntime,
  type SyncFolder,
} from '../src/sync-state';

const state: SyncRuntime = {
  running: false,
  paused: false,
  online: true,
  queued: 0,
  lastSync: null,
  active: null,
  issues: [],
  recent: [],
  message: '',
};
const root: SyncFolder = {
  id: 'selected',
  mode: 'sync',
  remoteId: 'cloud-selected',
  localPath: '/fixture',
  localPathDisplayName: 'Selected',
  paused: false,
  excluded: [],
  fileCount: 5,
  folderCount: 0,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-sync-management-'));
  const journal = new Journal(':memory:');
  cleanup.push(async () => {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, journal };
}
function engineFor(api: ApiClient, journal: Journal) {
  const engine = new SyncEngine(api, journal, 'device', () => {});
  cleanup.push(async () => {
    await engine.stop();
    await vi.waitFor(() => expect(engine.state.running).toBe(false));
  });
  return engine;
}
const feed = { changes: [], nextCursor: 1, hasMore: false };

describe('selective sync management', () => {
  it('does not fetch cloud contents when no sync folders are configured', async () => {
    const { journal } = await setup();
    const calls: string[] = [];
    const api = new ApiClient(async (endpoint) => {
      calls.push(endpoint);
      return endpoint.includes('/changes')
        ? { ...feed, changes: [{ item: { id: 'cloud-only' } }] }
        : {};
    });
    await engineFor(api, journal).tick();
    expect(calls.every((endpoint) => endpoint.startsWith('/v1/sync/'))).toBe(true);
  });
  it('ignores content outside an explicitly mapped cloud subtree', async () => {
    const { journal, directory } = await setup();
    const calls: string[] = [];
    const item = {
      id: 'cloud-only',
      name: 'file.pdf',
      parentId: 'unselected',
      type: 'FILE',
      revision: 1,
    } as DriveItem;
    const api = new ApiClient(async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith('/cloud-only')) return { item };
      if (endpoint.endsWith('/unselected'))
        return { item: { id: 'unselected', parentId: null, name: 'Other folder' } };
      throw new Error('Unexpected content request: ' + endpoint);
    });
    await engineFor(api, journal).remoteItem({ ...root, localPath: directory }, item);
    expect(
      calls.some((endpoint) => endpoint.includes('downloads') || endpoint.includes('versions')),
    ).toBe(false);
    expect(journal.fileCounts(root.id).fileCount).toBe(0);
  });
  it('never propagates deletion jobs while the local folder is missing', async () => {
    const { journal, directory } = await setup();
    journal.root({ ...root, localPath: path.join(directory, 'missing') });
    journal.enqueue(root.id, 'important.txt', 'delete');
    journal.putFile({
      rootId: root.id,
      relativePath: 'important.txt',
      itemId: 'remote-file',
      revision: 1,
      type: 'FILE',
      hash: 'hash',
    });
    const calls: string[] = [];
    const engine = engineFor(
      new ApiClient(async (endpoint) => {
        calls.push(endpoint);
        return endpoint.includes('/changes') ? feed : {};
      }),
      journal,
    );
    await engine.tick();
    expect(calls.some((endpoint) => endpoint.startsWith('/v1/drive/'))).toBe(false);
    expect(journal.jobs()).toHaveLength(1);
    expect(engine.state.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rootId: root.id, code: 'FOLDER_MISSING' }),
      ]),
    );
  });
  it('stop syncing removes the mapping and queued work while preserving local and cloud copies', async () => {
    const { journal, directory } = await setup();
    await writeFile(path.join(directory, 'keep.txt'), 'do not remove');
    journal.root({ ...root, localPath: directory });
    journal.enqueue(root.id, 'keep.txt', 'upsert');
    const calls: { endpoint: string; method?: string }[] = [];
    const engine = engineFor(
      new ApiClient(async (endpoint, input) => {
        calls.push({ endpoint, method: input?.method });
        return endpoint.includes('/changes') ? feed : {};
      }),
      journal,
    );
    await engine.removeRoot(root.id);
    expect(journal.roots()).toHaveLength(0);
    expect(journal.jobs()).toHaveLength(0);
    expect(await readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe('do not remove');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
  it('a paused folder downloads missed cloud changes when resumed', async () => {
    const { journal, directory } = await setup();
    const paused: Root = { ...root, localPath: directory, paused: true };
    journal.root(paused);
    const calls: string[] = [];
    const item = {
      id: 'child',
      name: 'Created while paused',
      parentId: root.remoteId,
      type: 'FOLDER',
      revision: 1,
    } as DriveItem;
    const api = new ApiClient(async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.includes('/sync/changes')) return { ...feed, changes: [{ item }] };
      if (endpoint.includes(`/folders/${root.remoteId}/children`))
        return { items: [item], nextCursor: null };
      if (endpoint.includes('/folders/child/children')) return { items: [], nextCursor: null };
      if (endpoint.endsWith('/drive/items/child')) return { item };
      return {};
    });
    const engine = engineFor(api, journal);
    await engine.tick();
    expect(calls.some((endpoint) => endpoint.startsWith('/v1/drive/'))).toBe(false);
    await engine.updateRoot({ ...paused, paused: false });
    await vi.waitFor(() => expect(journal.file(root.id, item.name)?.itemId).toBe('child'));
    expect(journal.roots()[0].paused).toBe(false);
  });
  it('rejects overlapping local mappings without changing configuration', async () => {
    const { journal, directory } = await setup();
    journal.root({ ...root, localPath: directory });
    const nested = path.join(directory, 'nested');
    await mkdir(nested);
    const engine = engineFor(new ApiClient(async () => ({})), journal);
    await expect(
      engine.addRoot({ ...root, id: 'second', remoteId: 'another', localPath: nested }),
    ).rejects.toThrow('overlap');
    expect(journal.roots()).toHaveLength(1);
  });
  it('pauses legacy whole-drive mappings until the user selects a cloud folder', async () => {
    const { journal, directory } = await setup();
    journal.root({ ...root, localPath: directory, remoteId: null });
    const calls: string[] = [];
    const engine = engineFor(
      new ApiClient(async (endpoint) => {
        calls.push(endpoint);
        return endpoint.includes('/changes') ? feed : {};
      }),
      journal,
    );
    await engine.start();
    await vi.waitFor(() => expect(engine.state.running).toBe(false));
    expect(journal.roots()[0].paused).toBe(true);
    expect(engine.state.issues.some((issue) => issue.code === 'MAPPING_REQUIRED')).toBe(true);
    expect(calls.some((endpoint) => endpoint.startsWith('/v1/drive/'))).toBe(false);
    await expect(engine.updateRoot({ ...journal.roots()[0], paused: false })).rejects.toThrow(
      'Choose a cloud folder',
    );
  });
  it('resolves and validates the full cloud folder path', async () => {
    const api = new ApiClient(async (endpoint) => ({
      item: endpoint.endsWith('/editor')
        ? { id: 'editor', name: 'editor', type: 'FOLDER', parentId: 'projects' }
        : { id: 'projects', name: 'Projects', type: 'FOLDER', parentId: null },
    }));
    expect((await cloudLocation(api, 'editor')).path).toBe('My Drive / Projects / editor');
    await expect(
      cloudLocation(new ApiClient(async () => ({ item: { type: 'FILE' } })), 'file'),
    ).rejects.toThrow('available folder');
  });
});

describe('sync states and error actions', () => {
  it('distinguishes idle, active, paused, offline, conflict, missing, and error states', () => {
    expect(folderState(root, state, [])).toBe('Up to date');
    expect(
      folderState(
        root,
        {
          ...state,
          active: {
            rootId: root.id,
            direction: 'download',
            relativePath: 'a',
            loaded: 10,
            total: 100,
          },
        },
        [],
      ),
    ).toBe('Syncing');
    expect(folderState(root, { ...state, paused: true }, [])).toBe('Paused');
    expect(folderState(root, { ...state, online: false }, [])).toBe('Offline');
    for (const [code, label] of [
      ['CONFLICT', 'Conflict'],
      ['FOLDER_MISSING', 'Folder unavailable'],
      ['DISK_FULL', 'Action required'],
    ] as const) {
      const next = { ...state, issues: [{ id: 'i', rootId: root.id, code, message: '', at: '' }] };
      expect(folderState(root, next, [])).toBe(label);
      expect(globalSyncState([root], next, [])).toBe('Action required');
    }
  });
  it.each([
    ['ENOENT', 'FOLDER_MISSING'],
    ['EACCES', 'PERMISSION_DENIED'],
    ['EPERM', 'PERMISSION_DENIED'],
    ['ENOSPC', 'DISK_FULL'],
    ['AUTH_INVALID', 'AUTH_INVALID'],
    ['STORAGE_QUOTA_EXCEEDED', 'STORAGE_QUOTA_EXCEEDED'],
  ])('classifies %s for an actionable recovery', (code, expected) => {
    expect(syncIssueCode(new ApiError(code, 'fixture', 400))).toBe(expected);
  });
});

it('keeps excluded local files when a remote deletion arrives', async () => {
  const { journal, directory } = await setup();
  const relative = 'Excluded/keep.txt';
  await mkdir(path.join(directory, 'Excluded'));
  await writeFile(path.join(directory, relative), 'keep this copy');
  journal.putFile({
    rootId: root.id,
    relativePath: relative,
    itemId: 'keep',
    revision: 1,
    type: 'FILE',
    hash: null,
  });
  const engine = engineFor(
    new ApiClient(async () => {
      throw new Error('No API call expected');
    }),
    journal,
  );
  await engine.remoteItem({ ...root, localPath: directory, excluded: ['Excluded'] }, {
    id: 'keep',
    revision: 2,
    deletedAt: new Date().toISOString(),
  } as DriveItem);
  expect(await readFile(path.join(directory, relative), 'utf8')).toBe('keep this copy');
  expect(journal.file(root.id, relative)?.itemId).toBe('keep');
});
