import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { Backups } from '../src/backups';

let service: StorageService, storage: MemoryStorage, backups: Backups, root: BackupRoot;
const run = () => ({ rootId: root.id, runId: 'run', deviceId: 'mac' });

/** Backs up `data` as a new file in `parentId`, as a backup run does. */
async function backedUp(name: string, data: string, parentId: string, sourceName?: string) {
  const hash = createHash('sha256').update(data).digest('hex');
  const { upload } = await service.createUpload(
    'alice',
    {
      operationId: randomUUID(),
      name,
      parentId,
      sizeBytes: Buffer.byteLength(data),
      mimeType: 'video/quicktime',
      contentHash: hash,
      ...(sourceName ? { sourceName } : {}),
    },
    'mac',
    run(),
  );
  const stored = await service.getUpload('alice', upload.id);
  storage.uploads.get(stored.providerUploadId!)!.parts.set(1, Buffer.from(data));
  return (await service.completeUpload('alice', upload.id, [{ partNumber: 1, etag: 'e' }], hash))
    .item;
}
const entry = (relativePath: string, item: { id: string; currentVersionId: string | null }) => ({
  relativePath,
  itemId: item.id,
  versionId: item.currentVersionId!,
  sizeBytes: 1,
  modifiedAt: new Date().toISOString(),
  savedAt: new Date().toISOString(),
});

beforeEach(async () => {
  storage = new MemoryStorage();
  service = new StorageService(new MemoryRepository(), storage);
  backups = new Backups(service);
  await service.ensureUser({
    id: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    username: 'alice',
    displayName: 'Alice',
  });
  await service.registerDevice(
    'alice',
    { name: 'mac', platform: 'MACOS', devicePublicId: 'mac' },
    'mac',
  );
  root = (
    await service.backupRoot('alice', {
      operationId: randomUUID(),
      deviceId: 'mac',
      name: 'library',
    })
  ).root as BackupRoot;
  await backups.start('alice', root.id, 'mac', { id: 'run', trigger: 'AUTOMATIC' });
});

it('keeps both of two files whose names differ only in capitalization, each with its own name', async () => {
  const upper = await backedUp('IMG_8692.MOV', 'the first video', root.remoteRootDriveItemId);
  // The same name in other capitals is still taken here.
  await expect(
    backedUp('IMG_8692.mov', 'another video', root.remoteRootDriveItemId),
  ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
  const lower = await backedUp(
    'IMG_8692 (Case Conflict).mov',
    'another video',
    root.remoteRootDriveItemId,
    'IMG_8692.mov',
  );
  expect(lower).toMatchObject({ name: 'IMG_8692 (Case Conflict).mov', sourceName: 'IMG_8692.mov' });
  expect(upper.sourceName).toBeUndefined();

  // The backup records each under the path its computer has.
  await backups.entry('alice', root.id, 'mac', 'run', entry('IMG_8692.MOV', upper));
  await expect(
    backups.entry('alice', root.id, 'mac', 'run', entry('IMG_8692 (Case Conflict).mov', lower)),
  ).rejects.toMatchObject({ message: 'Backup file path does not match.' });

  await backups.entry('alice', root.id, 'mac', 'run', entry('IMG_8692.mov', lower));
  // And restores each to it.
  const { restore } = await backups.restore('alice', root.id, {
    id: 'restore-lower',
    itemId: lower.id,
    versionId: lower.currentVersionId!,
  });
  expect(restore.relativePath).toBe('IMG_8692.mov');

  // A new version keeps the file's own name.
  const hash = createHash('sha256').update('edited').digest('hex');
  const { upload } = await service.createUpload(
    'alice',
    {
      operationId: randomUUID(),
      name: lower.name,
      parentId: root.remoteRootDriveItemId,
      driveItemId: lower.id,
      baseRevision: lower.revision,
      sizeBytes: 6,
      mimeType: 'video/quicktime',
      contentHash: hash,
    },
    'mac',
    run(),
  );
  const stored = await service.getUpload('alice', upload.id);
  storage.uploads.get(stored.providerUploadId!)!.parts.set(1, Buffer.from('edited'));
  const { item } = await service.completeUpload(
    'alice',
    upload.id,
    [{ partNumber: 1, etag: 'e' }],
    hash,
  );
  expect(item).toMatchObject({ revision: 2, sourceName: 'IMG_8692.mov' });
});

it('does the same for folders, so the files inside keep their paths', async () => {
  await service.createFolder(
    'alice',
    { operationId: randomUUID(), parentId: root.remoteRootDriveItemId, name: 'Photos' },
    run(),
  );
  const { item: folder } = await service.createFolder(
    'alice',
    {
      operationId: randomUUID(),
      parentId: root.remoteRootDriveItemId,
      name: 'photos (Case Conflict)',
      sourceName: 'photos',
    },
    run(),
  );
  expect(folder.sourceName).toBe('photos');
  const file = await backedUp('a.jpg', 'a photo', folder.id);
  await backups.entry('alice', root.id, 'mac', 'run', entry('photos/a.jpg', file));
  const { restore } = await backups.restore('alice', root.id, {
    id: 'restore-folder',
    itemId: folder.id,
  });
  expect(restore.relativePath).toBe('photos');
});

it('keeps a different name only for backups', async () => {
  const folder = (
    await service.createFolder('alice', { operationId: randomUUID(), parentId: null, name: 'Work' })
  ).item;
  await expect(
    service.createUpload('alice', {
      operationId: randomUUID(),
      name: 'b.txt',
      parentId: folder.id,
      sizeBytes: 1,
      mimeType: 'text/plain',
      sourceName: 'B.txt',
    }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  await expect(
    service.createFolder('alice', {
      operationId: randomUUID(),
      parentId: null,
      name: 'Other',
      sourceName: 'other',
    }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
});

it('forgets the computer’s name once the person renames the file', async () => {
  await backedUp('IMG_1.MOV', 'one', root.remoteRootDriveItemId);
  const lower = await backedUp(
    'IMG_1 (Case Conflict).mov',
    'two',
    root.remoteRootDriveItemId,
    'IMG_1.mov',
  );
  await backups.disconnect('alice', root.id);
  const { item } = await service.mutate('alice', lower.id, {
    operationId: randomUUID(),
    baseRevision: lower.revision,
    name: 'IMG_1 second.mov',
  });
  expect(item.name).toBe('IMG_1 second.mov');
  expect(item.sourceName).toBeUndefined();
});
