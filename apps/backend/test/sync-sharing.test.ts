import { beforeEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { SyncSharing } from '../src/sync-sharing';
import { SyncRelay } from '../src/sync-relay';
import type { DriveItem, ShareGrant } from '@harbor/contracts';
let service: StorageService,
  storage: MemoryStorage,
  sharing: SyncSharing,
  relay: SyncRelay,
  folder: DriveItem,
  share: ShareGrant;
const op = () => ({ operationId: randomUUID() });
const hash = createHash('sha256').update('hello').digest('hex');
beforeEach(async () => {
  storage = new MemoryStorage();
  service = new StorageService(new MemoryRepository(), storage);
  sharing = new SyncSharing(service);
  relay = new SyncRelay(service);
  for (const user of ['alice', 'bob', 'eve']) {
    await service.ensureUser({
      id: user,
      email: user + '@example.test',
      emailVerified: true,
      username: user,
      displayName: user,
    });
    // Deliberately equal installation IDs across accounts must not merge receipts.
    await service.registerDevice(
      user,
      { name: user, platform: 'MACOS', devicePublicId: 'same-installation' },
      user,
    );
  }
  folder = (await service.createFolder('alice', { ...op(), name: 'Together', parentId: null }))
    .item;
  await service.setSyncFolders('alice', 'alice', [folder.id]);
  share = (
    await sharing.invite('alice', {
      ...op(),
      driveItemId: folder.id,
      recipient: { type: 'USERNAME', value: 'bob' },
    })
  ).share;
});
async function accept() {
  await sharing.respond('bob', share.id, 'ACCEPTED');
  await service.setSyncFolders('bob', 'bob', [folder.id]);
}
async function startUpload(user = 'bob', previous?: DriveItem) {
  return (
    await service.createUpload(user, {
      ...op(),
      parentId: folder.id,
      name: 'hello.txt',
      sizeBytes: 5,
      mimeType: 'text/plain',
      contentHash: hash,
      ...(previous ? { driveItemId: previous.id, baseRevision: previous.revision } : {}),
    })
  ).upload;
}
async function complete(user: string, id: string) {
  const u = await service.getUpload(user, id);
  storage.uploads.get(u.providerUploadId!)!.parts.set(1, Buffer.from('hello'));
  return (await service.completeUpload(user, id, [{ partNumber: 1, etag: 'one' }], hash)).item;
}
const ack = (user: string, item: DriveItem) =>
  relay.acknowledge(user, user, item.id, {
    versionId: item.currentVersionId,
    revision: item.revision,
    contentHash: hash,
  });
it('requires recipient acceptance and keeps unrelated accounts and owner folders private', async () => {
  await expect(service.metadata('bob', folder.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(sharing.respond('eve', share.id, 'ACCEPTED')).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(startUpload()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await accept();
  expect((await service.syncFolders('bob')).items[0].id).toBe(folder.id);
  expect((await sharing.list('bob')).items[0]).toMatchObject({
    name: 'Together',
    direction: 'RECEIVED',
    syncState: 'ACCEPTED',
  });
  const privateFolder = (
    await service.createFolder('alice', { ...op(), parentId: null, name: 'Private' })
  ).item;
  await expect(service.metadata('bob', privateFolder.id)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(sharing.status('eve', share.id)).rejects.toMatchObject({
    code: 'SYNC_ACCESS_REMOVED',
  });
});
it('writes one owner tree, charges the owner, propagates revisions and preserves revision conflicts', async () => {
  await accept();
  const before = (await sharing.status('bob', share.id)).sequence;
  const nested = (
    await service.createFolder('bob', { ...op(), parentId: folder.id, name: 'Nested' })
  ).item;
  expect(nested.ownerUserId).toBe('alice');
  const item = await complete('bob', (await startUpload()).id);
  expect((await service.list('alice', folder.id)).items.map((i) => i.id)).toContain(item.id);
  expect((await service.me('alice')).storage.usedBytes).toBe(5);
  expect((await service.me('bob')).storage.usedBytes).toBe(0);
  expect((await sharing.status('bob', share.id)).sequence).toBeGreaterThan(before);
  const updated = (
    await service.mutate('alice', item.id, {
      ...op(),
      baseRevision: item.revision,
      name: 'renamed.txt',
    })
  ).item;
  await expect(
    service.mutate('bob', item.id, { ...op(), baseRevision: item.revision, name: 'stale.txt' }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await service.mutate('bob', item.id, {
    ...op(),
    baseRevision: updated.revision,
    action: 'trash',
  });
  expect((await service.list('alice', folder.id)).items.map((i) => i.id)).not.toContain(item.id);
});
it('waits for both accounts before releasing cloud bytes and supports rehydration', async () => {
  await accept();
  const item = await complete('bob', (await startUpload()).id);
  await ack('alice', item);
  await relay.release('alice', item.id);
  expect((await service.me('alice')).storage.usedBytes).toBe(5);
  expect((await relay.statuses('bob', [item.id], 'bob')).items[0]).toMatchObject({
    requiredDevices: 2,
    confirmedDevices: 1,
    deviceConfirmed: false,
  });
  await ack('bob', item);
  await relay.release('alice', item.id);
  expect((await service.me('alice')).storage.usedBytes).toBe(0);
  expect((await relay.requestContent('bob', 'bob', item.id)).item.cloudState).toBe('REQUESTED');
  const replacement = await complete('alice', (await startUpload('alice', item)).id);
  expect(replacement.revision).toBe(item.revision + 1);
});
it('revocation blocks outstanding uploads, mappings, receipts and new content access; refunds the owner', async () => {
  await accept();
  const upload = await startUpload();
  await service.revokeShare('alice', share.id, randomUUID());
  await expect(complete('bob', upload.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(service.uploadParts('bob', upload.id, [1])).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(sharing.status('bob', share.id)).rejects.toMatchObject({
    code: 'SYNC_ACCESS_REMOVED',
  });
  expect(await service.setSyncFolders('bob', 'bob', [folder.id])).toMatchObject({
    removedFolderIds: [folder.id],
  });
  await service.abortUpload('bob', upload.id);
  expect((await service.me('alice')).storage.reservedBytes).toBe(0);
  expect((await service.me('bob')).storage.reservedBytes).toBe(0);
});
it('only the owner can share, revoke, or remove the shared root; decline grants no access', async () => {
  await sharing.respond('bob', share.id, 'DECLINED');
  await expect(service.metadata('bob', folder.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  share = (
    await sharing.invite('alice', {
      ...op(),
      driveItemId: folder.id,
      recipient: { type: 'USERNAME', value: 'bob' },
    })
  ).share;
  await accept();
  await expect(service.revokeShare('bob', share.id, randomUUID())).rejects.toMatchObject({
    code: 'SHARE_NOT_ALLOWED',
  });
  await expect(
    sharing.invite('bob', {
      ...op(),
      driveItemId: folder.id,
      recipient: { type: 'USERNAME', value: 'eve' },
    }),
  ).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  await expect(
    service.mutate('bob', folder.id, { ...op(), baseRevision: folder.revision, action: 'trash' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('a reinvitation requires acceptance and fresh mapping receipts', async () => {
  await accept();
  const item = await complete('bob', (await startUpload()).id);
  await ack('alice', item);
  await ack('bob', item);
  await service.revokeShare('alice', share.id, randomUUID());
  const oldId = share.id;
  share = (
    await sharing.invite('alice', {
      ...op(),
      driveItemId: folder.id,
      recipient: { type: 'USERNAME', value: 'bob' },
    })
  ).share;
  expect(share.id).not.toBe(oldId);
  await accept();
  expect((await relay.statuses('bob', [item.id], 'bob')).items[0]).toMatchObject({
    requiredDevices: 2,
    confirmedDevices: 1,
    deviceConfirmed: false,
  });
});
