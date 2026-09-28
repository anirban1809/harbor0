import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { DriveItem } from '@harbor/contracts';
import type { BackupRoot, BackupEntry } from '../../../packages/contracts/src/backups';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { Backups } from '../src/backups';
let service: StorageService, storage: MemoryStorage, backups: Backups, root: BackupRoot;
async function upload(data: string, parentId = root.remoteRootDriveItemId, previous?: DriveItem) {
  const hash = createHash('sha256').update(data).digest('hex');
  const { upload } = await service.createUpload('alice', {
    operationId: randomUUID(),
    name: 'notes.txt',
    parentId,
    sizeBytes: Buffer.byteLength(data),
    mimeType: 'text/plain',
    contentHash: hash,
    ...(previous ? { driveItemId: previous.id, baseRevision: previous.revision } : {}),
  });
  const stored = await service.getUpload('alice', upload.id);
  storage.uploads.get(stored.providerUploadId!)!.parts.set(1, Buffer.from(data));
  return (await service.completeUpload('alice', upload.id, [{ partNumber: 1, etag: 'one' }], hash))
    .item;
}
beforeEach(async () => {
  storage = new MemoryStorage();
  service = new StorageService(new MemoryRepository(), storage);
  backups = new Backups(service);
  for (const id of ['alice', 'bob'])
    await service.ensureUser({
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      username: id,
      displayName: id,
    });
  for (const id of ['mac', 'pc'])
    await service.registerDevice('alice', { name: id, platform: 'MACOS', devicePublicId: id }, id);
  root = (
    await service.backupRoot('alice', {
      operationId: randomUUID(),
      deviceId: 'mac',
      name: 'Documents',
    })
  ).root as BackupRoot;
});
it('records exact versions per run, counts entries once on retries, and keeps old bytes downloadable', async () => {
  const first = await upload('first');
  const second = await upload('second version', root.remoteRootDriveItemId, first);
  await backups.start('alice', root.id, 'mac', { id: 'run1', trigger: 'MANUAL' });
  const entry: BackupEntry = {
    relativePath: 'notes.txt',
    itemId: first.id,
    versionId: first.currentVersionId!,
    sizeBytes: 999,
    modifiedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
  await backups.entry('alice', root.id, 'mac', 'run1', entry);
  await backups.entry('alice', root.id, 'mac', 'run1', entry);
  const { run } = await backups.finish('alice', root.id, 'mac', 'run1');
  expect(run).toMatchObject({ state: 'COMPLETED', fileCount: 1, sizeBytes: 5, trigger: 'MANUAL' });
  expect((await backups.page('alice', root.id, 'ENTRY#run1#')).items).toEqual([
    expect.objectContaining({ versionId: first.currentVersionId, sizeBytes: 5 }),
  ]);
  expect((await service.versions('alice', first.id)).items).toHaveLength(2);
  expect(
    await service.download('alice', { driveItemId: first.id, versionId: first.currentVersionId! }),
  ).toMatchObject({ sizeBytes: 5 });
  expect(second.currentVersionId).not.toBe(first.currentVersionId);
  expect((await backups.finish('alice', root.id, 'mac', 'run1')).run).toEqual(run);
});
it('validates backup ownership, device ownership, file ancestry and version identity', async () => {
  const item = await upload('hello');
  const outside = await upload(
    'outside',
    (
      await service.createFolder('alice', {
        operationId: randomUUID(),
        name: 'Elsewhere',
        parentId: null,
      })
    ).item.id,
  );
  await expect(backups.page('bob', root.id, 'RUN#')).rejects.toMatchObject({
    code: 'ITEM_NOT_FOUND',
  });
  await expect(
    backups.start('alice', root.id, 'pc', { id: 'run', trigger: 'MANUAL' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    backups.restore('alice', root.id, {
      id: 'r',
      itemId: outside.id,
      versionId: outside.currentVersionId!,
    }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    backups.restore('alice', root.id, {
      id: 'r',
      itemId: item.id,
      versionId: outside.currentVersionId!,
    }),
  ).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
});
it('queues restores without changing cloud history and acknowledges only from the owning computer', async () => {
  const folder = (
    await service.createFolder('alice', {
      operationId: randomUUID(),
      name: 'Nested',
      parentId: root.remoteRootDriveItemId,
    })
  ).item;
  const item = await upload('hello', folder.id);
  const input = { id: 'restore1', itemId: item.id, versionId: item.currentVersionId! };
  const { restore } = await backups.restore('alice', root.id, input);
  expect(restore).toMatchObject({ relativePath: 'Nested/notes.txt', state: 'PENDING' });
  expect((await backups.restore('alice', root.id, input)).restore).toEqual(restore);
  await expect(backups.restored('alice', root.id, 'pc', input.id)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect((await backups.page('alice', root.id, 'PENDING#')).items).toHaveLength(1);
  await backups.restored('alice', root.id, 'mac', input.id);
  await backups.restored('alice', root.id, 'mac', input.id);
  expect((await backups.page('alice', root.id, 'PENDING#')).items).toHaveLength(0);
  expect((await backups.page('alice', root.id, 'RESTORE#')).items[0]).toMatchObject({
    state: 'COMPLETED',
  });
  expect((await service.versions('alice', item.id)).items).toHaveLength(1);
});
it('accepts a new sign-in on the same installation and rejects a different computer', async () => {
  await service.revokeSession('alice', 'mac');
  await service.registerDevice(
    'alice',
    { name: 'Mac again', platform: 'MACOS', devicePublicId: 'mac' },
    'new-session',
  );
  expect(
    (await backups.start('alice', root.id, 'new-session', { id: 'new-run', trigger: 'AUTOMATIC' }))
      .run.deviceId,
  ).toBe('new-session');
  await expect(
    backups.start('alice', root.id, 'mac', { id: 'revoked', trigger: 'AUTOMATIC' }),
  ).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
});
it('supports folders with identical display names without cloud name collisions', async () => {
  const other = await service.backupRoot('alice', {
    operationId: randomUUID(),
    deviceId: 'mac',
    name: 'Documents',
  });
  expect(other.root.id).not.toBe(root.id);
});
