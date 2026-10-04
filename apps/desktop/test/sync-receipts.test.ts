import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { Journal, type Root } from '../src/journal';
import { SyncReceipts } from '../src/sync-receipts';
import { SyncEngine } from '../src/sync';
const hash = createHash('sha256').update('hello').digest('hex');
const item = {
  id: 'file',
  parentId: 'remote',
  name: 'hello.txt',
  type: 'FILE',
  revision: 1,
  currentVersionId: 'version',
  sizeBytes: 5,
} as DriveItem;
async function fixture(run: (journal: Journal, root: Root) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-'));
  const journal = new Journal(path.join(dir, 'journal.sqlite'));
  const root: Root = {
    id: 'root',
    localPath: dir,
    remoteId: 'remote',
    mode: 'sync',
    paused: false,
    excluded: [],
  };
  journal.root(root);
  try {
    await run(journal, root);
  } finally {
    journal.close();
    await rm(dir, { recursive: true, force: true });
  }
}
it('persists offline confirmations and confirms only matching durable local bytes', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'hello');
    let offline = true;
    const calls: unknown[] = [];
    const api = new ApiClient(async (_path, options) => {
      if (offline) throw new TypeError('offline');
      calls.push(options?.body);
      return { ok: true };
    });
    const receipts = new SyncReceipts(api, journal);
    receipts.queue(root, item.name, item, hash);
    await receipts.flush();
    expect(Object.keys(journal.get('syncReceipts')!)).toEqual(['file']);
    offline = false;
    await new SyncReceipts(api, journal).flush();
    expect(calls).toHaveLength(1);
    expect(journal.get('syncReceipts')).toEqual({});
    receipts.queue(root, item.name, item, hash);
    await writeFile(path.join(root.localPath, item.name), 'changed');
    await receipts.flush();
    expect(calls).toHaveLength(1);
  }));
it('does not confirm excluded, paused or unlinked roots', async () =>
  fixture(async (journal, root) => {
    const calls: string[] = [];
    const receipts = new SyncReceipts(
      new ApiClient(async (p) => {
        calls.push(p);
        return {};
      }),
      journal,
    );
    receipts.queue(root, item.name, item, hash);
    journal.root({ ...root, paused: true });
    await receipts.flush();
    expect(Object.keys(journal.get('syncReceipts')!)).toHaveLength(1);
    journal.root({ ...root, excluded: [item.name] });
    await receipts.flush();
    expect(journal.get('syncReceipts')).toEqual({});
    expect(calls).toEqual([]);
  }));
it('drops a confirmation whose folder was deleted without recreating the folder', async () =>
  fixture(async (journal, root) => {
    const calls: string[] = [];
    const receipts = new SyncReceipts(
      new ApiClient(async (p) => {
        calls.push(p);
        return { ok: true };
      }),
      journal,
    );
    // The user deleted Docs before this copy's confirmation was sent.
    receipts.queue(root, 'Docs/Inner/hello.txt', item, hash);
    await receipts.flush();
    expect(journal.get('syncReceipts')).toEqual({});
    expect(calls).toEqual([]);
    await expect(stat(path.join(root.localPath, 'Docs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }));
it('requests a released copy and queues verified sources for rehydration without deleting local files', async () =>
  fixture(async (journal, root) => {
    let cloudState = 'RELEASED';
    const calls: string[] = [];
    const api = new ApiClient(async (p) => {
      calls.push(p);
      if (p.endsWith('/versions')) return { items: [{ id: 'version', contentHash: hash }] };
      if (p.endsWith('/request-content')) {
        cloudState = 'REQUESTED';
        return {};
      }
      return { item: { ...item, cloudState } };
    });
    const engine = new SyncEngine(api, journal, 'device', () => {});
    await engine.remoteItem(root, { ...item, cloudState: 'RELEASED' });
    expect(calls).toContain('/v1/sync/items/file/request-content');
    await writeFile(path.join(root.localPath, item.name), 'hello');
    await engine.remoteItem(root, { ...item, cloudState: 'REQUESTED' });
    expect(journal.jobs()[0].payload.relayVersion).toBe('version');
    expect(journal.file(root.id, item.name)?.hash).toBe(hash);
    await engine.stop();
  }));

it('uploads a local edit normally if it arrives while a relay copy is queued', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'hello');
    journal.enqueue(root.id, item.name, 'upsert');
    const existing = journal.jobs()[0];
    existing.payload.upload = { operationId: 'old-operation', uploadId: 'completed-old-upload' };
    journal.saveJob(existing);
    let uploadedHash: string | undefined;
    const api = new ApiClient(async (p, options) => {
      if (p.endsWith('/versions')) return { items: [{ id: 'version', contentHash: hash }] };
      if (p === '/v1/uploads') {
        uploadedHash = (options?.body as any).contentHash;
        throw new Error('Stopped before sending bytes');
      }
      return { item: { ...item, cloudState: 'REQUESTED' } };
    });
    const engine = new SyncEngine(api, journal, 'device', () => {});
    try {
      await engine.remoteItem(root, { ...item, cloudState: 'REQUESTED' });
      const relay = journal.jobs()[0];
      expect(relay.payload.upload.operationId).not.toBe('old-operation');
      expect(relay.payload.upload.uploadId).toBeUndefined();
      await writeFile(path.join(root.localPath, item.name), 'edited');
      await expect((engine as any).localJob(root, relay)).rejects.toThrow(
        'Stopped before sending bytes',
      );
      expect(relay.payload.relayVersion).toBeUndefined();
      expect(uploadedHash).toBe(createHash('sha256').update('edited').digest('hex'));
    } finally {
      await engine.stop();
    }
  }));

it('audits idle copies and empty roots, and repairs a missing backend confirmation on a later heartbeat', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'hello');
    journal.putFile({
      rootId: root.id,
      relativePath: item.name,
      itemId: item.id,
      revision: item.revision,
      hash,
      type: 'FILE',
    });
    const folder = {
      ...item,
      id: root.remoteId!,
      type: 'FOLDER',
      currentVersionId: null,
    } as DriveItem;
    const confirmed = new Set<string>();
    const posted: string[] = [];
    const api = new ApiClient(async (p) => {
      if (p.startsWith('/v1/sync/status'))
        return {
          items: [item, folder].map((i) => ({
            itemId: i.id,
            revision: i.revision,
            deviceConfirmed: confirmed.has(i.id),
          })),
        };
      if (p.endsWith('/acknowledge')) {
        const id = p.split('/')[4];
        confirmed.add(id);
        posted.push(id);
        return { ok: true };
      }
      return { item: p.endsWith('/remote') ? folder : item };
    });
    const receipts = new SyncReceipts(api, journal);
    await receipts.audit();
    await receipts.flush();
    expect(new Set(posted)).toEqual(new Set(['remote', 'file']));
    expect(receipts.pendingRoots()).toEqual([]);
    confirmed.delete('file');
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16000);
    try {
      await receipts.audit();
      await receipts.flush();
    } finally {
      now.mockRestore();
    }
    expect(posted.filter((id) => id === 'file')).toHaveLength(2);
    expect(posted.filter((id) => id === 'remote')).toHaveLength(1);
  }));

it('keeps retrying until the backend explicitly confirms acceptance', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'hello');
    let accepted = false;
    const receipts = new SyncReceipts(
      new ApiClient(async () => (accepted ? { ok: true } : {})),
      journal,
    );
    receipts.queue(root, item.name, item, hash);
    await receipts.flush();
    expect(receipts.pendingRoots()).toEqual([root.id]);
    accepted = true;
    await receipts.flush();
    expect(receipts.pendingRoots()).toEqual([]);
  }));

it('preserves newer receipts queued while an older acknowledgement is in flight', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'hello');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const receipts = new SyncReceipts(
      new ApiClient(async () => {
        entered();
        await hold;
        return { ok: true };
      }),
      journal,
    );
    receipts.queue(root, item.name, item, hash);
    const flushing = receipts.flush();
    await started;
    receipts.queue(root, item.name, { ...item, revision: 2, currentVersionId: 'next' }, hash);
    release();
    await flushing;
    expect(journal.get<any>('syncReceipts').file.item.revision).toBe(2);
  }));

it('reconciles stale revisions instead of silently abandoning confirmation', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'hello');
    const receipts = new SyncReceipts(
      new ApiClient(async () => {
        throw new ApiError('REVISION_CONFLICT', 'stale', 409);
      }),
      journal,
    );
    receipts.queue(root, item.name, item, hash);
    await receipts.flush();
    expect(journal.roots()[0].needsReconcile).toBe(true);
    expect(receipts.pendingRoots()).toEqual([]);
  }));

it('removes sync locally only after backend acceptance and preserves the directory and edited files', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'local unsynced edit');
    journal.putFile({
      rootId: root.id,
      relativePath: item.name,
      itemId: item.id,
      revision: 1,
      hash,
      type: 'FILE',
    });
    journal.enqueue(root.id, item.name, 'upsert');
    let accepted = false;
    const api = new ApiClient(async (p) => {
      if (p === '/v1/sync/folders/remote' && !accepted) throw new TypeError('offline');
      if (p.includes('/changes')) return { changes: [], nextCursor: 0, hasMore: false };
      return { ok: true };
    });
    const engine = new SyncEngine(api, journal, 'device', () => {});
    await expect(engine.removeSyncedFolder(root.remoteId!)).rejects.toThrow('offline');
    expect(journal.roots()).toHaveLength(1);
    accepted = true;
    await engine.removeSyncedFolder(root.remoteId!);
    await engine.stop();
    expect(journal.roots()).toEqual([]);
    expect(journal.jobCount()).toBe(0);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(root.localPath, item.name), 'utf8')).toBe(
      'local unsynced edit',
    );
  }));

it('honors remote removal after reconnecting, including when paused, without deleting files', async () =>
  fixture(async (journal, root) => {
    await writeFile(path.join(root.localPath, item.name), 'hello');
    const engine = new SyncEngine(
      new ApiClient(async (p) => {
        if (p === '/v1/sync/folders') return { ok: true, removedFolderIds: [root.remoteId] };
        return {};
      }),
      journal,
      'device',
      () => {},
    );
    engine.state.paused = true;
    await engine.tick();
    await engine.tick();
    await engine.stop();
    expect(journal.roots()).toEqual([]);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path.join(root.localPath, item.name), 'utf8')).toBe('hello');
  }));
