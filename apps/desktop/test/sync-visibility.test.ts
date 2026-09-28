import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiClient } from '@harbor/api-client';
import { Journal, type Root } from '../src/journal';
import { SyncEngine } from '../src/sync';
import { syncView } from '../src/sync-view';
import type { SyncRuntime } from '../src/sync-state';
import { uploadFile } from '../src/transfers';

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: { watch: () => Object.assign(new EventEmitter(), { close: async () => {} }) } };
});
vi.mock('../src/transfers', () => ({
  hashFile: vi.fn(async () => 'hash'),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
}));

it('publishes the current file before transfer and removes each completed job immediately', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-sync-visibility-'));
  const journal = new Journal(':memory:');
  const root: Root = {
    id: 'root',
    localPath: directory,
    remoteId: 'cloud',
    mode: 'sync',
    paused: false,
    excluded: [],
  };
  const snapshots: ReturnType<typeof syncView>[] = [];
  const api = new ApiClient(async (endpoint) =>
    endpoint.includes('/changes') ? { changes: [], nextCursor: 0, hasMore: false } : {},
  );
  const engine = new SyncEngine(api, journal, 'device', (state) =>
    snapshots.push(structuredClone(syncView(journal, state as SyncRuntime))),
  );
  try {
    journal.root(root);
    for (const name of ['first.txt', 'second.txt']) {
      await writeFile(path.join(directory, name), 'hello');
      journal.enqueue(root.id, name, 'upsert', {
        type: 'FILE',
        sizeBytes: 5,
        updatedAt: new Date().toISOString(),
      });
    }
    const [firstName, secondName] = journal.jobs().map((job) => job.relativePath);
    vi.mocked(uploadFile).mockImplementation(
      async (_api, _filename, name, parentId, state, _persist, _existing, progress) => {
        const latest = snapshots.at(-1)!;
        expect(latest.active).toMatchObject({ relativePath: name, loaded: 0, total: 5 });
        expect(latest.driveItems.find((item) => item.name === name)?.syncStatus).toBe('Syncing');
        state.hash = 'hash';
        progress?.(3, 5);
        return {
          id: `cloud-${name}`,
          parentId,
          name,
          type: 'FILE',
          sizeBytes: 5,
          revision: 1,
        } as any;
      },
    );
    await engine.tick();
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(2);
    const first = snapshots.find((snapshot) => snapshot.active?.relativePath === firstName)!;
    expect(first.driveItems.find((item) => item.name === secondName)?.syncStatus).toBe('Pending');
    const completedFirst = snapshots.find(
      (snapshot) => !snapshot.active && snapshot.recent[0]?.relativePath === firstName,
    )!;
    expect(completedFirst.jobs.map((job) => job.relativePath)).toEqual([secondName]);
    expect(completedFirst.recent[0].item?.id).toBe(`cloud-${firstName}`);
    expect(snapshots.at(-1)?.driveItems).toEqual([]);
    expect(journal.jobCount()).toBe(0);
  } finally {
    await engine.stop();
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
