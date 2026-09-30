import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { DriveItem } from '@harbor/contracts';
import type { BackupRoot, BackupEntry } from '../../../packages/contracts/src/backups';
import { StorageService } from '../src/domain';
import { MemoryRepository, Transaction, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { Backups } from '../src/backups';
let service: StorageService, storage: MemoryStorage, backups: Backups, root: BackupRoot;
async function upload(
  data: string,
  parentId = root.remoteRootDriveItemId,
  previous?: DriveItem,
  outside = false,
) {
  const hash = createHash('sha256').update(data).digest('hex');
  const { upload } = await service.createUpload(
    'alice',
    {
      operationId: randomUUID(),
      name: 'notes.txt',
      parentId,
      sizeBytes: Buffer.byteLength(data),
      mimeType: 'text/plain',
      contentHash: hash,
      ...(previous ? { driveItemId: previous.id, baseRevision: previous.revision } : {}),
    },
    undefined,
    outside ? undefined : { rootId: root.id, runId: 'seed', deviceId: 'mac' },
  );
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
  await backups.start('alice', root.id, 'mac', { id: 'seed', trigger: 'MANUAL' });
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
    undefined,
    true,
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
    await service.createFolder(
      'alice',
      {
        operationId: randomUUID(),
        name: 'Nested',
        parentId: root.remoteRootDriveItemId,
      },
      { rootId: root.id, runId: 'seed', deviceId: 'mac' },
    )
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

it('blocks edits throughout connected backups but permits reading every saved version', async () => {
  const item = await upload('first');
  const nested = (
    await service.createFolder(
      'alice',
      {
        operationId: randomUUID(),
        name: 'Nested',
        parentId: root.remoteRootDriveItemId,
      },
      { rootId: root.id, runId: 'seed', deviceId: 'mac' },
    )
  ).item;
  for (const target of [
    item,
    nested,
    (await service.metadata('alice', root.remoteRootDriveItemId)).item,
  ]) {
    for (const edit of [
      { name: 'Renamed' },
      { parentId: null },
      { action: 'trash' as const },
      { favorite: true },
    ])
      await expect(
        service.mutate('alice', target.id, {
          operationId: randomUUID(),
          baseRevision: target.revision,
          ...edit,
        }),
      ).rejects.toMatchObject({ code: 'BACKUP_IMMUTABLE' });
  }
  await expect(
    service.createFolder('alice', {
      operationId: randomUUID(),
      name: 'Injected',
      parentId: nested.id,
    }),
  ).rejects.toMatchObject({ code: 'BACKUP_IMMUTABLE' });
  await expect(upload('overwrite', root.remoteRootDriveItemId, item, true)).rejects.toMatchObject({
    code: 'BACKUP_IMMUTABLE',
  });
  await expect(
    service.restoreVersion('alice', item.id, item.currentVersionId!, {
      operationId: randomUUID(),
      baseRevision: item.revision,
    }),
  ).rejects.toMatchObject({ code: 'BACKUP_IMMUTABLE' });
  const ordinary = (
    await service.createFolder('alice', {
      operationId: randomUUID(),
      name: 'Ordinary',
      parentId: null,
    })
  ).item;
  await expect(
    service.mutate('alice', ordinary.id, {
      operationId: randomUUID(),
      baseRevision: ordinary.revision,
      parentId: nested.id,
    }),
  ).rejects.toMatchObject({ code: 'BACKUP_IMMUTABLE' });
  expect((await service.metadata('alice', item.id)).item.backupRootId).toBe(root.id);
  expect(
    (await service.list('alice', root.remoteRootDriveItemId)).items.every(
      (i) => i.backupRootId === root.id,
    ),
  ).toBe(true);
  expect(
    await service.download('alice', { driveItemId: item.id, versionId: item.currentVersionId! }),
  ).toMatchObject({ sizeBytes: 5 });
});
it('allows append only from the source computer, inside its backup, during an open run', async () => {
  const folder = {
    operationId: randomUUID(),
    name: 'Nested',
    parentId: root.remoteRootDriveItemId,
  };
  const scope = { rootId: root.id, runId: 'seed', deviceId: 'mac' };
  await expect(
    service.createFolder('alice', folder, { ...scope, deviceId: 'pc' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    service.createFolder('alice', { ...folder, parentId: null }, scope),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await backups.finish('alice', root.id, 'mac', 'seed');
  await expect(service.createFolder('alice', folder, scope)).rejects.toMatchObject({
    code: 'BACKUP_RUN_CLOSED',
  });
});
it('disconnects idempotently, preserves history, unlocks cloud files and stops pending writes', async () => {
  const first = await upload('first');
  const second = await upload('second', root.remoteRootDriveItemId, first);
  const { upload: pending } = await service.createUpload(
    'alice',
    {
      operationId: randomUUID(),
      name: 'pending.txt',
      parentId: root.remoteRootDriveItemId,
      sizeBytes: 5,
      mimeType: 'text/plain',
      contentHash: createHash('sha256').update('hello').digest('hex'),
    },
    'mac',
    { rootId: root.id, runId: 'seed', deviceId: 'mac' },
  );
  await expect(backups.disconnect('bob', root.id)).rejects.toMatchObject({
    code: 'ITEM_NOT_FOUND',
  });
  const result = await backups.disconnect('alice', root.id);
  expect(result.root.state).toBe('REMOVED');
  expect(await backups.disconnect('alice', root.id)).toEqual(result);
  await expect(service.uploadParts('alice', pending.id, [1])).rejects.toMatchObject({
    code: 'BACKUP_DISCONNECTED',
  });
  await expect(
    backups.start('alice', root.id, 'mac', { id: 'later', trigger: 'MANUAL' }),
  ).rejects.toMatchObject({ code: 'BACKUP_DISCONNECTED' });
  await expect(
    backups.restore('alice', root.id, {
      id: 'later',
      itemId: first.id,
      versionId: first.currentVersionId!,
    }),
  ).rejects.toMatchObject({ code: 'BACKUP_DISCONNECTED' });
  expect((await service.metadata('alice', first.id)).item.backupRootId).toBeUndefined();
  expect((await service.versions('alice', first.id)).items).toHaveLength(2);
  expect(
    await service.download('alice', { driveItemId: first.id, versionId: first.currentVersionId! }),
  ).toMatchObject({ sizeBytes: 5 });
  expect(
    (
      await service.mutate('alice', second.id, {
        operationId: randomUUID(),
        baseRevision: second.revision,
        name: 'Editable.txt',
      })
    ).item.name,
  ).toBe('Editable.txt');
  const current = (await service.metadata('alice', second.id)).item;
  await upload('third', root.remoteRootDriveItemId, current, true);
  expect((await service.versions('alice', first.id)).items).toHaveLength(3);
});

// Model an older installation that had moved/shared its backup folder before immutability existed.
it('protects paused legacy backups from ancestor operations and existing shared editors', async () => {
  const file = await upload('history');
  const parent = (
    await service.createFolder('alice', {
      operationId: randomUUID(),
      name: 'Legacy parent',
      parentId: null,
    })
  ).item;
  await transact(service.repo, async (tx) => {
    await tx.put('USER#alice', `BACKUP#${root.id}`, { ...root, state: 'PAUSED' });
    const folder = (await tx.get<DriveItem>('USER#alice', `ITEM#${root.remoteRootDriveItemId}`))!;
    await tx.put('USER#alice', `ITEM#${folder.id}`, { ...folder, parentId: parent.id });
    await tx.put('USER#bob', `ACCESS#${parent.id}`, { permission: 'EDITOR', revokedAt: null });
  });
  for (const id of [parent.id, root.remoteRootDriveItemId, file.id]) {
    const item = (await new Transaction(service.repo).get<DriveItem>('USER#alice', `ITEM#${id}`))!;
    await expect(
      service.mutate('alice', id, {
        operationId: randomUUID(),
        baseRevision: item.revision,
        action: 'trash',
      }),
    ).rejects.toMatchObject({ code: 'BACKUP_IMMUTABLE' });
  }
  await expect(
    service.createFolder('bob', {
      operationId: randomUUID(),
      name: 'Editor injection',
      parentId: root.remoteRootDriveItemId,
    }),
  ).rejects.toMatchObject({ code: 'BACKUP_IMMUTABLE' });
  await expect(service.setSyncFolders('alice', 'pc', [parent.id])).rejects.toMatchObject({
    code: 'BACKUP_IMMUTABLE',
  });
  expect((await service.metadata('bob', file.id)).item.backupRootId).toBe(root.id);
  expect((await service.download('bob', { driveItemId: file.id })).sizeBytes).toBe(7);
});
it('forgets a stopped backup with its history but keeps the cloud files', async () => {
  const file = await upload('first');
  await backups.entry('alice', root.id, 'mac', 'seed', {
    relativePath: 'notes.txt',
    itemId: file.id,
    versionId: file.currentVersionId!,
    sizeBytes: 5,
    modifiedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
  });
  await expect(backups.forget('alice', root.id)).rejects.toMatchObject({ status: 409 });
  await backups.disconnect('alice', root.id);
  expect(await backups.forget('bob', root.id)).toEqual({ removed: true });
  expect((await service.backups('alice')).items).toHaveLength(1);
  expect(await backups.forget('alice', root.id)).toEqual({ removed: true });
  expect((await service.backups('alice')).items).toHaveLength(0);
  for (const prefix of ['ENTRY#', 'RUN#'])
    expect(
      (await service.repo.query(`USER#alice#BACKUP#${root.id}`, prefix, 10)).rows,
    ).toHaveLength(0);
  expect((await service.metadata('alice', file.id)).item.name).toBe('notes.txt');
  expect(await backups.forget('alice', root.id)).toEqual({ removed: true });
});
