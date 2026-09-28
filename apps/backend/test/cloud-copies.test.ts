import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { DriveItem, FileVersion } from '@harbor/contracts';
import { StorageService, userPK } from '../src/domain';
import { MemoryRepository, Transaction, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { CloudCopies } from '../src/cloud-copies';
import { SyncRelay } from '../src/sync-relay';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { DeletionWorkflows } from '../src/deletion';

let repo: MemoryRepository,
  storage: MemoryStorage,
  service: StorageService,
  copies: CloudCopies,
  folder: DriveItem;
const op = () => randomUUID();
const checksum = (data: string) => createHash('sha256').update(data).digest('hex');
async function upload(name: string, data: string, parentId = folder.id, previous?: DriveItem) {
  const { upload } = await service.createUpload('alice', {
    operationId: op(),
    name,
    parentId,
    sizeBytes: Buffer.byteLength(data),
    mimeType: 'text/plain',
    contentHash: checksum(data),
    ...(previous ? { driveItemId: previous.id, baseRevision: previous.revision } : {}),
  });
  const stored = await service.getUpload('alice', upload.id);
  storage.uploads.get(stored.providerUploadId!)!.parts.set(1, Buffer.from(data));
  return (
    await service.completeUpload(
      'alice',
      upload.id,
      [{ partNumber: 1, etag: 'one' }],
      checksum(data),
    )
  ).item;
}
async function finish(id: string) {
  for (let i = 0; i < 100; i++) if (await copies.step(id)) return;
  throw new Error('Copy did not finish');
}
const start = () =>
  copies.create('alice', folder.id, { operationId: op(), baseRevision: folder.revision });
beforeEach(async () => {
  repo = new MemoryRepository();
  storage = new MemoryStorage();
  service = new StorageService(repo, storage);
  copies = new CloudCopies(service);
  for (const id of ['alice', 'bob'])
    await service.ensureUser({
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      username: id,
      displayName: id,
    });
  folder = (
    await service.createFolder('alice', { operationId: op(), name: 'Sync', parentId: null })
  ).item;
  await service.registerDevice(
    'alice',
    { name: 'Mac', platform: 'MACOS', devicePublicId: 'mac' },
    'mac',
  );
  await service.setSyncFolders('alice', 'mac', [folder.id]);
});

it('publishes a complete independent snapshot, including nested and empty folders and only current versions', async () => {
  const child = (
    await service.createFolder('alice', { operationId: op(), name: 'Nested', parentId: folder.id })
  ).item;
  await service.createFolder('alice', { operationId: op(), name: 'Empty', parentId: child.id });
  const old = await upload('notes.txt', 'old', child.id);
  const current = await upload('notes.txt', 'current', child.id, old);
  const removed = await upload('deleted.txt', 'deleted');
  await service.mutate('alice', removed.id, {
    operationId: op(),
    baseRevision: removed.revision,
    action: 'trash',
  });
  const input = { operationId: op(), baseRevision: folder.revision };
  const { copy } = await copies.create('alice', folder.id, input);
  expect((await copies.create('alice', folder.id, input)).copy.id).toBe(copy.id);
  expect((await service.list('alice', null)).items.map((item) => item.name)).toEqual(['Sync']);
  await expect(service.metadata('alice', copy.rootId)).rejects.toMatchObject({
    code: 'ITEM_NOT_FOUND',
  });
  await finish(copy.id);
  const root = (await service.metadata('alice', copy.rootId)).item;
  expect(root).toMatchObject({ name: 'Sync (cloud copy)', parentId: null, type: 'FOLDER' });
  const nested = (await service.list('alice', root.id)).items;
  expect(nested.map((item) => item.name)).toEqual(['Nested']);
  const contents = (await service.list('alice', nested[0].id)).items;
  expect(contents.map((item) => item.name)).toEqual(['Empty', 'notes.txt']);
  const file = contents[1];
  const versions = (await service.versions('alice', file.id)).items;
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({ contentHash: checksum('current'), versionNumber: 1 });
  expect(file.id).not.toBe(current.id);
  await upload('notes.txt', 'later change', child.id, current);
  await service.removeSyncFolder('alice', folder.id);
  expect((await service.download('alice', { driveItemId: file.id })).contentHash).toBe(
    checksum('current'),
  );
  expect((await service.me('alice')).storage.reservedBytes).toBe(0);
  expect((await copies.list('alice')).items[0].state).toBe('COMPLETED');
  expect((await service.syncFolders('alice')).items).toHaveLength(0);
});

it('copies a large paginated tree using bounded transactions and replays safely', async () => {
  for (let i = 0; i < 105; i++)
    await service.createFolder('alice', {
      operationId: op(),
      name: `Folder ${i}`,
      parentId: folder.id,
    });
  const { copy } = await start();
  await finish(copy.id);
  const first = await service.list('alice', copy.rootId);
  const second = await service.list('alice', copy.rootId, 100, first.nextCursor!);
  expect(first.items.length + second.items.length).toBe(105);
  await finish(copy.id);
  expect((await service.list('alice', null)).items).toHaveLength(2);
  const next = await start();
  expect(next.copy.name).toBe('Sync (cloud copy 2)');
});

it('retrieves device-only bytes, holds them against sync cleanup, and completes without linking the copy', async () => {
  const item = await upload('notes.txt', 'hello');
  const relay = new SyncRelay(service);
  await relay.acknowledge('alice', 'mac', item.id, {
    revision: item.revision,
    versionId: item.currentVersionId,
    contentHash: checksum('hello'),
  });
  await relay.release('alice', item.id);
  expect((await service.me('alice')).storage.usedBytes).toBe(0);
  const { copy } = await start();
  expect(await copies.step(copy.id)).toBe(false);
  expect((await copies.list('alice')).items[0]).toMatchObject({ state: 'SAVING', waiting: true });
  const requested = (await service.metadata('alice', item.id)).item;
  expect(requested.cloudState).toBe('REQUESTED');
  expect(await relay.release('alice', item.id)).toBe(false);
  const restored = await upload('notes.txt', 'hello', folder.id, requested);
  await relay.acknowledge('alice', 'mac', restored.id, {
    revision: restored.revision,
    versionId: restored.currentVersionId,
    contentHash: checksum('hello'),
  });
  expect(await relay.release('alice', item.id)).toBe(false);
  await finish(copy.id);
  const cloned = (await service.list('alice', copy.rootId)).items[0];
  expect((await service.download('alice', { driveItemId: cloned.id })).contentHash).toBe(
    checksum('hello'),
  );
  expect(
    await new Transaction(repo).get(userPK('alice'), `CLOUDCOPYWAIT#${item.id}`),
  ).toBeUndefined();
  expect((await service.syncFolders('alice')).items.map((item) => item.id)).toEqual([folder.id]);
});

it('fails without exposing a partial tree when an offline file changes and cleans up quota and holds', async () => {
  const item = await upload('notes.txt', 'hello');
  const relay = new SyncRelay(service);
  await relay.acknowledge('alice', 'mac', item.id, {
    revision: item.revision,
    versionId: item.currentVersionId,
    contentHash: checksum('hello'),
  });
  await relay.release('alice', item.id);
  const { copy } = await start();
  await copies.step(copy.id);
  await upload('notes.txt', 'changed', folder.id, (await service.metadata('alice', item.id)).item);
  await finish(copy.id);
  expect((await copies.list('alice')).items[0]).toMatchObject({
    state: 'FAILED',
    error: expect.stringContaining('changed'),
  });
  expect((await service.me('alice')).storage.reservedBytes).toBe(0);
  expect((await service.list('alice', null)).items.map((item) => item.id)).toEqual([folder.id]);
  expect(
    await new Transaction(repo).get(userPK('alice'), `CLOUDCOPYWAIT#${item.id}`),
  ).toBeUndefined();
});

it('rolls back partial reservations and references when quota is exhausted', async () => {
  await upload('a.txt', 'hello');
  await upload('b.txt', 'world');
  await transact(repo, async (tx) => {
    const account = await service.account(tx, 'alice');
    account.storageQuotaBytes = 15;
    await tx.put(userPK('alice'), 'PROFILE', account);
  });
  const { copy } = await start();
  await finish(copy.id);
  expect((await copies.list('alice')).items[0]).toMatchObject({
    state: 'FAILED',
    error: expect.stringContaining('storage'),
  });
  expect((await service.me('alice')).storage).toMatchObject({ usedBytes: 10, reservedBytes: 0 });
  expect((await service.list('alice', null)).items).toHaveLength(1);
  for (const row of repo.rows.values())
    if (row.pk === 'OBJECT') expect(row.data).toMatchObject({ references: 1 });
});

it('detects source changes during capture and rejects unauthorized or stale requests', async () => {
  await expect(
    copies.create('bob', folder.id, { operationId: op(), baseRevision: 1 }),
  ).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  await expect(
    copies.create('alice', folder.id, { operationId: op(), baseRevision: 2 }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const plain = (
    await service.createFolder('alice', { operationId: op(), name: 'Cloud', parentId: null })
  ).item;
  await expect(
    copies.create('alice', plain.id, { operationId: op(), baseRevision: 1 }),
  ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  const { copy } = await start();
  await upload('new.txt', 'change');
  await finish(copy.id);
  expect((await copies.list('alice')).items[0].state).toBe('FAILED');
  expect((await copies.list('bob')).items).toHaveLength(0);
});

it('expires an offline copy and releases reservations', async () => {
  const item = await upload('notes.txt', 'hello');
  const relay = new SyncRelay(service);
  await relay.acknowledge('alice', 'mac', item.id, {
    revision: item.revision,
    versionId: item.currentVersionId,
    contentHash: checksum('hello'),
  });
  await relay.release('alice', item.id);
  const { copy } = await start();
  await copies.step(copy.id);
  await transact(repo, async (tx) => {
    const stored = (await tx.get<Record<string, unknown>>(`SAVE#${copy.id}`, 'META'))!;
    await tx.put(`SAVE#${copy.id}`, 'META', { ...stored, expiresAt: '2000-01-01T00:00:00Z' });
  });
  await finish(copy.id);
  expect((await copies.list('alice')).items[0].state).toBe('FAILED');
  expect((await service.me('alice')).storage.reservedBytes).toBe(0);
});

it('runs through the durable job queue and keeps copied content after original deletion', async () => {
  const original = await upload('notes.txt', 'hello');
  const { copy } = await start();
  await service.runJobs();
  expect((await copies.list('alice')).items[0].state).toBe('COMPLETED');
  const cloned = (await service.list('alice', copy.rootId)).items[0];
  const trashed = (
    await service.mutate('alice', original.id, {
      operationId: op(),
      baseRevision: original.revision,
      action: 'trash',
    })
  ).item;
  await service.permanentDelete('alice', original.id, {
    operationId: op(),
    baseRevision: trashed.revision,
  });
  const deletion = new DeletionWorkflows(service);
  for (let i = 0; i < 5; i++) if (await deletion.step('alice', original.id)) break;
  expect((await service.download('alice', { driveItemId: cloned.id })).contentHash).toBe(
    checksum('hello'),
  );
  const version = (await service.versions('alice', cloned.id)).items[0] as FileVersion;
  expect(await new Transaction(repo).get('OBJECT', version.storageObjectId)).toMatchObject({
    references: 1,
  });
});

it('exposes validated API routes and requires authentication', async () => {
  const auth = new DevelopmentAuth();
  auth.identity = async () => ({
    id: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    username: 'alice',
    displayName: 'alice',
    deviceId: 'mac',
    sessionId: 'mac',
  });
  const { app, document } = createApp(service, auth);
  expect(
    (
      await app.request(`/v1/drive/folders/${folder.id}/copy-to-cloud`, {
        method: 'POST',
        body: JSON.stringify({ operationId: op(), baseRevision: 1 }),
      })
    ).status,
  ).toBe(401);
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  const response = await app.request(`/v1/drive/folders/${folder.id}/copy-to-cloud`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operationId: op(), baseRevision: 1 }),
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.copy).toMatchObject({ state: 'SAVING', name: 'Sync (cloud copy)' });
  await finish(result.copy.id);
  const progress = await app.request('/v1/drive/cloud-copies', { headers });
  expect(progress.status).toBe(200);
  expect((await progress.json()).items[0]).toMatchObject({
    state: 'COMPLETED',
    id: result.copy.id,
  });
  const schema = document() as { paths: Record<string, unknown> };
  expect(schema.paths['/v1/drive/folders/{id}/copy-to-cloud']).toBeDefined();
  expect(schema.paths['/v1/drive/cloud-copies']).toBeDefined();
});

async function syncCopy(id: string) {
  for (let i = 0; i < 100; i++) {
    await new CloudCopies(service).mirror(id);
    const copy = (await copies.list('alice')).items.find((copy) => copy.id === id)!;
    if (copy.syncStatus === 'SYNCED') return;
    if (copy.syncStatus === 'ERROR' || copy.syncStatus === 'STOPPED') throw new Error(copy.error);
  }
  throw new Error('Mirror did not finish');
}
const startSynced = () =>
  copies.create('alice', folder.id, {
    operationId: op(),
    baseRevision: folder.revision,
    mode: 'SYNC',
  });

it('keeps a cloud copy updated with local additions, versions, moves, renames, and deletions while snapshots stay unchanged', async () => {
  const original = await upload('notes.txt', 'first');
  const snapshot = (await start()).copy;
  await finish(snapshot.id);
  const ongoing = (await startSynced()).copy;
  await finish(ongoing.id);
  await syncCopy(ongoing.id);
  const clone = (await service.list('alice', ongoing.rootId)).items[0];
  const updated = await upload('notes.txt', 'second', folder.id, original);
  const subfolder = (
    await service.createFolder('alice', { name: 'Nested', parentId: folder.id, operationId: op() })
  ).item;
  const renamed = (
    await service.mutate('alice', updated.id, {
      operationId: op(),
      baseRevision: updated.revision,
      name: 'renamed.txt',
      parentId: subfolder.id,
    })
  ).item;
  await upload('added.txt', 'new');
  await syncCopy(ongoing.id);
  const children = (await service.list('alice', ongoing.rootId)).items;
  expect(children.map((item) => item.name).sort()).toEqual(['Nested', 'added.txt']);
  const nested = children.find((item) => item.name === 'Nested')!;
  const mirrored = (await service.list('alice', nested.id)).items[0];
  expect(mirrored).toMatchObject({ id: clone.id, name: 'renamed.txt' });
  expect((await service.download('alice', { driveItemId: clone.id })).contentHash).toBe(
    checksum('second'),
  );
  expect((await service.versions('alice', clone.id)).items).toHaveLength(2);
  await syncCopy(ongoing.id);
  expect((await service.versions('alice', clone.id)).items).toHaveLength(2);
  const frozen = (await service.list('alice', snapshot.rootId)).items[0];
  expect(frozen.name).toBe('notes.txt');
  expect((await service.download('alice', { driveItemId: frozen.id })).contentHash).toBe(
    checksum('first'),
  );
  await service.mutate('alice', renamed.id, {
    operationId: op(),
    baseRevision: renamed.revision,
    action: 'trash',
  });
  await syncCopy(ongoing.id);
  expect((await service.list('alice', nested.id)).items).toHaveLength(0);
  expect(
    (await service.browseSpecial('alice', { trash: 'true' })).items.some(
      (item) => item.id === clone.id,
    ),
  ).toBe(true);
});

it('retains newly uploaded sync content for ongoing copies and stops safely when sync is removed', async () => {
  const copy = (await startSynced()).copy;
  await finish(copy.id);
  const item = await upload('new.txt', 'hello');
  const relay = new SyncRelay(service);
  await relay.acknowledge('alice', 'mac', item.id, {
    revision: item.revision,
    versionId: item.currentVersionId,
    contentHash: checksum('hello'),
  });
  await relay.release('alice', item.id);
  expect((await service.metadata('alice', item.id)).item.cloudState).toBe('AVAILABLE');
  await syncCopy(copy.id);
  const cloned = (await service.list('alice', copy.rootId)).items[0];
  await service.removeSyncFolder('alice', folder.id);
  expect(await copies.mirror(copy.id)).toBe(true);
  expect((await copies.list('alice')).items[0]).toMatchObject({
    mode: 'SYNC',
    syncStatus: 'STOPPED',
  });
  expect((await service.download('alice', { driveItemId: cloned.id })).contentHash).toBe(
    checksum('hello'),
  );
  expect(
    await new Transaction(repo).get(userPK('alice'), `CLOUDMIRROR#${folder.id}`),
  ).toBeUndefined();
});

it('resumes ongoing updates after quota is increased and never writes cloud edits back to the source', async () => {
  const source = await upload('notes.txt', 'hello');
  const copy = (await startSynced()).copy;
  await finish(copy.id);
  await syncCopy(copy.id);
  const cloned = (await service.list('alice', copy.rootId)).items[0];
  await service.mutate('alice', cloned.id, {
    operationId: op(),
    baseRevision: cloned.revision,
    name: 'cloud-only-name.txt',
  });
  expect((await service.metadata('alice', source.id)).item.name).toBe('notes.txt');
  await upload('notes.txt', 'updated', folder.id, source);
  await transact(repo, async (tx) => {
    const account = await service.account(tx, 'alice');
    account.storageQuotaBytes = account.storageUsedBytes;
    await tx.put(userPK('alice'), 'PROFILE', account);
  });
  await copies.mirror(copy.id);
  expect((await copies.list('alice')).items[0]).toMatchObject({
    syncStatus: 'ERROR',
    error: expect.stringContaining('storage'),
  });
  expect((await service.download('alice', { driveItemId: cloned.id })).contentHash).toBe(
    checksum('hello'),
  );
  await transact(repo, async (tx) => {
    const account = await service.account(tx, 'alice');
    account.storageQuotaBytes = 100000;
    await tx.put(userPK('alice'), 'PROFILE', account);
  });
  await syncCopy(copy.id);
  expect((await service.metadata('alice', cloned.id)).item.name).toBe('notes.txt');
  expect((await service.download('alice', { driveItemId: cloned.id })).contentHash).toBe(
    checksum('updated'),
  );
});

it('handles source rename swaps and paginated ongoing folder additions', async () => {
  const first = await upload('a.txt', 'aaa');
  const second = await upload('b.txt', 'bbb');
  const copy = (await startSynced()).copy;
  await finish(copy.id);
  await syncCopy(copy.id);
  const temp = (
    await service.mutate('alice', first.id, {
      operationId: op(),
      baseRevision: first.revision,
      name: 'temp.txt',
    })
  ).item;
  await service.mutate('alice', second.id, {
    operationId: op(),
    baseRevision: second.revision,
    name: 'a.txt',
  });
  await service.mutate('alice', first.id, {
    operationId: op(),
    baseRevision: temp.revision,
    name: 'b.txt',
  });
  for (let i = 0; i < 40; i++)
    await service.createFolder('alice', {
      operationId: op(),
      parentId: folder.id,
      name: `Folder ${i}`,
    });
  await syncCopy(copy.id);
  const entries = (await service.list('alice', copy.rootId)).items;
  expect(entries).toHaveLength(42);
  expect(
    (
      await service.download('alice', {
        driveItemId: entries.find((item) => item.name === 'a.txt')!.id,
      })
    ).contentHash,
  ).toBe(checksum('bbb'));
  expect(
    (
      await service.download('alice', {
        driveItemId: entries.find((item) => item.name === 'b.txt')!.id,
      })
    ).contentHash,
  ).toBe(checksum('aaa'));
});
