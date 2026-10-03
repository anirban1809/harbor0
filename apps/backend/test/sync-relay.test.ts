import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { StorageService, userPK } from '../src/domain';
import { MemoryRepository, Transaction, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { SyncRelay } from '../src/sync-relay';
import type { DriveItem, FileVersion } from '@harbor/contracts';

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
// A file whose bytes were released before synced files stayed in the cloud.
async function markReleased(item: DriveItem) {
  await transact(repo, async (tx) => {
    const stored = (await tx.get<DriveItem>(userPK('alice'), `ITEM#${item.id}`))!;
    const key = `VERSION#${item.id}#${stored.currentVersionId}`;
    const version = (await tx.get<FileVersion>(userPK('alice'), key))!;
    await service.reference(tx, version.storageObjectId, -1);
    await tx.put(userPK('alice'), key, { ...version, cloudState: 'RELEASED' });
    await tx.put(userPK('alice'), `ITEM#${item.id}`, { ...stored, cloudState: 'RELEASED' });
    const account = await service.account(tx, 'alice');
    account.storageUsedBytes -= version.sizeBytes;
    await tx.put(userPK('alice'), 'PROFILE', account);
  });
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
it('keeps cloud bytes after every linked device confirms, so any device can fetch them', async () => {
  const item = await upload();
  expect((await relay.statuses('alice', [item.id])).items[0].state).toBe('PENDING');
  await ack('mac', item);
  await service.revokeSession('alice', 'pc');
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
  expect((await relay.statuses('alice', [folder.id, item.id])).items.map((i) => i.state)).toEqual([
    'SYNCED',
    'SYNCED',
  ]);
  expect((await service.list('alice', folder.id)).items[0]).toMatchObject({
    id: item.id,
    cloudState: 'AVAILABLE',
  });
  expect((await service.me('alice')).storage.usedBytes).toBe(5);
  await expect(service.download('alice', { driveItemId: item.id })).resolves.toMatchObject({
    sizeBytes: 5,
  });
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
  expect((await relay.statuses('alice', [item.id])).items[0]).toMatchObject({
    confirmedDevices: 1,
    requiredDevices: 2,
    cloudState: 'AVAILABLE',
  });
});
it('rehydrates a legacy released file for a newly linked device', async () => {
  const item = await upload();
  await ack('mac', item);
  await ack('pc', item);
  await markReleased(item);
  await service.registerDevice(
    'alice',
    { name: 'Third', platform: 'MACOS', devicePublicId: 'third' },
    'third',
  );
  await service.setSyncFolders('alice', 'third', [folder.id]);
  expect((await relay.requestContent('alice', 'third', item.id)).item.cloudState).toBe('REQUESTED');
  const replacement = await upload(item);
  expect(replacement.currentVersionId).not.toBe(item.currentVersionId);
  expect((await relay.statuses('alice', [item.id])).items[0]).toMatchObject({
    confirmedDevices: 0,
    requiredDevices: 3,
    cloudState: 'AVAILABLE',
  });
  await expect(ack('mac', item)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('asks devices to upload legacy released files again', async () => {
  const item = await upload();
  await markReleased(item);
  expect(await relay.rehydrate('alice', false)).toBe(1);
  expect(
    (await new Transaction(repo).get<DriveItem>(userPK('alice'), 'ITEM#' + item.id))?.cloudState,
  ).toBe('RELEASED');
  expect(await relay.rehydrate('alice', true)).toBe(1);
  expect(
    (await new Transaction(repo).get<DriveItem>(userPK('alice'), 'ITEM#' + item.id))?.cloudState,
  ).toBe('REQUESTED');
  expect((await service.changes('alice', 0, 100)).changes.at(-1)?.type).toBe(
    'SYNC_CONTENT_REQUESTED',
  );
  const provided = await upload({ ...item, cloudState: 'REQUESTED' });
  expect(provided.cloudState).toBe('AVAILABLE');
  expect(await relay.rehydrate('alice', true)).toBe(0);
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
  await markReleased(item);
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

it('rejects mapping a connected backup folder for sync', async () => {
  const { root } = await service.backupRoot('alice', {
    operationId: randomUUID(),
    deviceId: 'mac',
    name: 'Backup',
  });
  await expect(
    service.setSyncFolders('alice', 'mac', [root.remoteRootDriveItemId]),
  ).rejects.toMatchObject({ code: 'BACKUP_IMMUTABLE' });
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
it('lets the owner’s other app devices request a legacy released file', async () => {
  const item = await upload();
  await ack('mac', item);
  await ack('pc', item);
  await markReleased(item);
  expect(
    (await new Transaction(repo).get<DriveItem>(userPK('alice'), 'ITEM#' + item.id))?.cloudState,
  ).toBe('RELEASED');
  // A phone that opens the file on demand without syncing the folder.
  await service.registerDevice('alice', { name: 'phone', platform: 'IOS', devicePublicId: 'phone' }, 'phone');
  expect((await relay.requestContent('alice', 'phone', item.id)).item.cloudState).toBe('REQUESTED');
  const provided = await upload(item);
  expect(provided.cloudState).toBe('AVAILABLE');
  // Web sessions still cannot ask linked devices for content.
  await service.registerDevice('alice', { name: 'web', platform: 'WEB' }, 'web');
  await expect(relay.requestContent('alice', 'web', item.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('reports the latest change position without replaying the feed', async () => {
  await upload();
  const all = await service.changes('alice', 0, 500);
  const latest = await service.latestChanges('alice');
  expect(latest).toEqual({ changes: [], nextCursor: all.nextCursor, hasMore: false });
  expect((await service.changes('alice', latest.nextCursor, 10)).changes).toEqual([]);
});
