import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { StorageService, userPK } from '../src/domain';
import { MemoryRepository, Transaction } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { SyncRelay } from '../src/sync-relay';
import type { DriveItem } from '@harbor/contracts';

let service: StorageService,
  relay: SyncRelay,
  repo: MemoryRepository,
  storage: MemoryStorage,
  folder: DriveItem;
const hash = createHash('sha256').update('hello').digest('hex');
async function upload(previous?: DriveItem) {
  const { upload } = await service.createUpload('alice', {
    operationId: randomUUID(),
    name: 'hello.txt',
    parentId: folder.id,
    sizeBytes: 5,
    mimeType: 'text/plain',
    contentHash: hash,
    ...(previous ? { driveItemId: previous.id, baseRevision: previous.revision } : {}),
  });
  const stored = await service.getUpload('alice', upload.id);
  storage.uploads.get(stored.providerUploadId!)!.parts.set(1, Buffer.from('hello'));
  return (await service.completeUpload('alice', upload.id, [{ partNumber: 1, etag: 'one' }], hash))
    .item;
}
const ack = (device: string, item: DriveItem, contentHash = hash) =>
  relay.acknowledge('alice', device, item.id, {
    versionId: item.currentVersionId,
    revision: item.revision,
    contentHash,
  });
beforeEach(async () => {
  repo = new MemoryRepository();
  storage = new MemoryStorage();
  service = new StorageService(repo, storage);
  relay = new SyncRelay(service);
  await service.ensureUser({
    id: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    username: 'alice',
    displayName: 'Alice',
  });
  folder = (
    await service.createFolder('alice', { parentId: null, name: 'Sync', operationId: randomUUID() })
  ).item;
  for (const id of ['mac', 'pc']) {
    await service.registerDevice('alice', { name: id, platform: 'MACOS', devicePublicId: id }, id);
    await service.setSyncFolders('alice', id, [folder.id]);
  }
});
it('keeps cloud bytes for offline devices, releases only after all confirmations, and preserves metadata', async () => {
  const item = await upload();
  expect((await relay.statuses('alice', [item.id])).items[0].state).toBe('PENDING');
  await ack('mac', item);
  await service.revokeSession('alice', 'pc');
  await relay.release('alice', item.id);
  expect((await service.me('alice')).storage.usedBytes).toBe(5);
  expect((await relay.statuses('alice', [folder.id, item.id])).items.map((i) => i.state)).toEqual([
    'SYNCING',
    'SYNCING',
  ]);
  await service.registerDevice(
    'alice',
    { name: 'PC', platform: 'MACOS', devicePublicId: 'pc' },
    'pc-new',
  );
  await ack('pc-new', item);
  await service.runJobs();
  await service.runJobs();
  expect((await service.list('alice', folder.id)).items[0]).toMatchObject({
    id: item.id,
    cloudState: 'RELEASED',
    deletedAt: null,
  });
  expect((await service.me('alice')).storage.usedBytes).toBe(0);
  expect((await relay.statuses('alice', [folder.id, item.id])).items.map((i) => i.state)).toEqual([
    'SYNCED',
    'SYNCED',
  ]);
  await expect(service.download('alice', { driveItemId: item.id })).rejects.toMatchObject({
    code: 'SYNC_CONTENT_OFFLINE',
  });
  await relay.release('alice', item.id);
  expect((await service.me('alice')).storage.usedBytes).toBe(0);
  expect(
    (await service.changes('alice', 0, 100)).changes.some((c) => c.type === 'FILE_DELETED'),
  ).toBe(false);
  const versions = await service.versions('alice', item.id);
  expect(
    await new Transaction(repo).get('OBJECT', versions.items[0].storageObjectId),
  ).toBeUndefined();
});
it('rejects wrong hashes, stale revisions and unlinked devices', async () => {
  const item = await upload();
  await expect(ack('mac', item, '0'.repeat(64))).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  await expect(ack('mac', { ...item, revision: item.revision + 1 })).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  await service.setSyncFolders('alice', 'pc', []);
  await expect(ack('pc', item)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('invalidates confirmations after unlinking and relinking the same installation', async () => {
  const item = await upload();
  await ack('mac', item);
  await ack('pc', item);
  await service.setSyncFolders('alice', 'pc', []);
  await service.setSyncFolders('alice', 'pc', [folder.id]);
  await relay.release('alice', item.id);
  expect((await relay.statuses('alice', [item.id])).items[0]).toMatchObject({
    confirmedDevices: 1,
    requiredDevices: 2,
    cloudState: 'AVAILABLE',
  });
});
it('rehydrates for a newly linked device and requires new-version confirmations', async () => {
  const item = await upload();
  await ack('mac', item);
  await ack('pc', item);
  await relay.release('alice', item.id);
  await service.registerDevice(
    'alice',
    { name: 'Third', platform: 'MACOS', devicePublicId: 'third' },
    'third',
  );
  await service.setSyncFolders('alice', 'third', [folder.id]);
  expect((await relay.requestContent('alice', 'third', item.id)).item.cloudState).toBe('REQUESTED');
  const replacement = await upload(item);
  expect(replacement.currentVersionId).not.toBe(item.currentVersionId);
  await relay.release('alice', replacement.id);
  expect((await relay.statuses('alice', [item.id])).items[0]).toMatchObject({
    confirmedDevices: 0,
    requiredDevices: 3,
    cloudState: 'AVAILABLE',
  });
  await expect(ack('mac', item)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('never releases ordinary cloud files or files with another storage reference', async () => {
  const item = await upload();
  const version = (await service.versions('alice', item.id)).items[0];
  const { transact } = await import('../src/repository');
  await transact(repo, (tx) => service.reference(tx, version.storageObjectId, 1));
  await ack('mac', item);
  await ack('pc', item);
  expect(await relay.release('alice', item.id)).toBe(false);
  expect((await service.me('alice')).storage.usedBytes).toBe(5);
  await service.setSyncFolders('alice', 'mac', []);
  await service.setSyncFolders('alice', 'pc', []);
  expect((await relay.statuses('alice', [item.id])).items).toEqual([]);
  expect(
    (await new Transaction(repo).get<DriveItem>(userPK('alice'), 'ITEM#' + item.id))?.cloudState,
  ).toBe('AVAILABLE');
});

it('cleans restored versions that share an object without leaking references or quota', async () => {
  const original = await upload();
  const { item } = await service.restoreVersion('alice', original.id, original.currentVersionId!, {
    operationId: randomUUID(),
    baseRevision: original.revision,
  });
  expect((await service.me('alice')).storage.usedBytes).toBe(10);
  await ack('mac', item);
  await ack('pc', item);
  expect(await relay.release('alice', item.id)).toBe(true);
  expect((await service.me('alice')).storage.usedBytes).toBe(0);
  expect(
    (await service.versions('alice', item.id)).items.every((v) => v.cloudState === 'RELEASED'),
  ).toBe(true);
});

it('keeps mappings visible after sign-out while the offline installation still owes a copy', async () => {
  await service.revokeSession('alice', 'mac');
  await service.revokeSession('alice', 'pc');
  expect((await service.syncFolders('alice')).items.map((i) => i.id)).toEqual([folder.id]);
});

it('does not charge storage twice when a released file is permanently deleted', async () => {
  const item = await upload();
  await ack('mac', item);
  await ack('pc', item);
  await relay.release('alice', item.id);
  const deleted = (
    await service.mutate('alice', item.id, {
      operationId: randomUUID(),
      baseRevision: item.revision,
      action: 'trash',
    })
  ).item;
  await service.permanentDelete('alice', item.id, {
    operationId: randomUUID(),
    baseRevision: deleted.revision,
  });
  const { DeletionWorkflows } = await import('../src/deletion');
  for (let i = 0; i < 5; i++)
    if (await new DeletionWorkflows(service).step('alice', item.id)) break;
  expect((await service.me('alice')).storage.usedBytes).toBe(0);
  expect(await new Transaction(repo).get(userPK('alice'), 'ITEM#' + item.id)).toBeUndefined();
});

it('preserves backup contents even when that folder is also mapped for sync', async () => {
  const { root } = await service.backupRoot('alice', {
    operationId: randomUUID(),
    deviceId: 'mac',
    name: 'Backup',
  });
  folder = (await new Transaction(repo).get<DriveItem>(
    userPK('alice'),
    'ITEM#' + root.remoteRootDriveItemId,
  ))!;
  await service.setSyncFolders('alice', 'mac', [folder.id]);
  const item = await upload();
  await ack('mac', item);
  expect(await relay.release('alice', item.id)).toBe(true);
  expect((await service.me('alice')).storage.usedBytes).toBe(5);
  expect((await service.download('alice', { driveItemId: item.id })).contentHash).toBe(hash);
});

it('reports confirmation for the authenticated installation separately from the overall folder summary', async () => {
  const item = await upload();
  await ack('mac', item);
  expect((await relay.statuses('alice', [item.id], 'mac', false)).items[0]).toMatchObject({
    deviceConfirmed: true,
    revision: item.revision,
    state: 'SYNCING',
  });
  expect((await relay.statuses('alice', [item.id], 'pc', false)).items[0].deviceConfirmed).toBe(
    false,
  );
  await ack('pc', item);
  expect((await relay.statuses('alice', [folder.id], 'mac')).items[0]).toMatchObject({
    state: 'SYNCED',
    deviceConfirmed: false,
  });
  expect((await relay.statuses('alice', [folder.id], 'mac', false)).items[0]).toMatchObject({
    state: 'PENDING',
    deviceConfirmed: false,
  });
  await relay.acknowledge('alice', 'mac', folder.id, {
    versionId: null,
    revision: folder.revision,
    contentHash: null,
  });
  expect((await relay.statuses('alice', [folder.id], 'mac', false)).items[0].deviceConfirmed).toBe(
    true,
  );
  await service.setSyncFolders('alice', 'mac', []);
  await service.setSyncFolders('alice', 'mac', [folder.id]);
  expect((await relay.statuses('alice', [item.id], 'mac', false)).items[0].deviceConfirmed).toBe(
    false,
  );
});

it('removes a sync folder account-wide without file deletion and rejects stale device registrations', async () => {
  const item = await upload();
  await relay.acknowledge('alice', 'mac', item.id, {
    versionId: item.currentVersionId,
    revision: item.revision,
    contentHash: hash,
  });
  const before = (await service.me('alice')).storage.usedBytes;
  await service.removeSyncFolder('alice', folder.id);
  await service.removeSyncFolder('alice', folder.id); // Retry after a lost response.
  expect((await service.syncFolders('alice')).items).toEqual([]);
  expect((await service.list('alice', null)).items).toEqual([]);
  expect((await service.browseSpecial('alice', { q: 'hello' })).items).toEqual([]);
  for (const device of ['mac', 'pc']) {
    expect(await service.setSyncFolders('alice', device, [folder.id])).toEqual({
      ok: true,
      removedFolderIds: [folder.id],
    });
  }
  await expect(service.metadata('alice', item.id)).rejects.toMatchObject({ code: 'SYNC_REMOVED' });
  await expect(
    service.createFolder('alice', {
      parentId: folder.id,
      name: 'late-upload',
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'SYNC_REMOVED' });
  const retained = await new Transaction(repo).get<DriveItem>(userPK('alice'), 'ITEM#' + item.id);
  expect(retained?.deletedAt).toBeNull();
  expect((await service.me('alice')).storage.usedBytes).toBe(before);
  const changes = (await service.changes('alice', 0, 100)).changes;
  expect(changes.some((c) => c.type === 'SYNC_FOLDER_REMOVED' && c.entityId === folder.id)).toBe(
    true,
  );
  expect(changes.some((c) => c.type === 'FILE_DELETED')).toBe(false);
});

it('does not remove unrelated cloud folders or another account’s folder', async () => {
  const cloud = (
    await service.createFolder('alice', {
      parentId: null,
      name: 'Cloud',
      operationId: randomUUID(),
    })
  ).item;
  await expect(service.removeSyncFolder('alice', cloud.id)).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
  await expect(service.removeSyncFolder('bob', folder.id)).rejects.toMatchObject({
    code: 'ITEM_NOT_FOUND',
  });
  expect((await service.list('alice', null)).items).toHaveLength(2);
});

it('also retires nested mappings when an ancestor sync folder is removed', async () => {
  const nested = (
    await service.createFolder('alice', {
      parentId: folder.id,
      name: 'Nested',
      operationId: randomUUID(),
    })
  ).item;
  await service.setSyncFolders('alice', 'pc', [nested.id]);
  await service.removeSyncFolder('alice', folder.id);
  expect(await service.setSyncFolders('alice', 'pc', [nested.id])).toEqual({
    ok: true,
    removedFolderIds: [nested.id],
  });
  expect((await service.syncFolders('alice')).items).toEqual([]);
});
