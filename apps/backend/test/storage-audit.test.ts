import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { DriveItem } from '@harbor/contracts';
import type { BackupRoot } from '../../../packages/contracts/src/backups';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { Backups } from '../src/backups';
import { DeletionWorkflows } from '../src/deletion';
import { storageAudit } from '../src/storage-audit';
import { storageAuditCsv } from '../../web/lib/storage-audit';
let service: StorageService, storage: MemoryStorage, root: BackupRoot;
const op = () => randomUUID();
async function upload(
  data: string,
  name: string,
  parentId: string | null,
  options: { previous?: DriveItem; backup?: boolean; device?: string } = {},
) {
  const hash = createHash('sha256').update(data).digest('hex');
  const { upload } = await service.createUpload(
    'alice',
    {
      operationId: op(),
      name,
      parentId,
      sizeBytes: Buffer.byteLength(data),
      mimeType: 'text/plain',
      contentHash: hash,
      ...(options.previous
        ? { driveItemId: options.previous.id, baseRevision: options.previous.revision }
        : {}),
    },
    options.device,
    options.backup ? { rootId: root.id, runId: 'seed', deviceId: 'mac' } : undefined,
  );
  const stored = await service.getUpload('alice', upload.id);
  storage.uploads.get(stored.providerUploadId!)!.parts.set(1, Buffer.from(data));
  return (await service.completeUpload('alice', upload.id, [{ partNumber: 1, etag: 'one' }], hash))
    .item;
}
async function audit(limit = 2) {
  const rows = [];
  let cursor: string | undefined;
  let page;
  do {
    page = await storageAudit(service, 'alice', limit, cursor);
    rows.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { rows, storage: page.storage };
}
beforeEach(async () => {
  storage = new MemoryStorage();
  service = new StorageService(new MemoryRepository(), storage);
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
    await service.backupRoot('alice', { operationId: op(), deviceId: 'mac', name: 'Documents' })
  ).root as BackupRoot;
  await new Backups(service).start('alice', root.id, 'mac', { id: 'seed', trigger: 'MANUAL' });
});
it('lists every counted version by location and adds up to the storage ledger', async () => {
  const folder = (
    await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Work' })
  ).item;
  const first = await upload('draft', 'plan.txt', folder.id, { device: 'pc' });
  await upload('final draft', 'plan.txt', null, { previous: first });
  await upload('backed up', 'notes.txt', root.remoteRootDriveItemId, { backup: true });
  const synced = (
    await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Photos' })
  ).item;
  await service.setSyncFolders('alice', 'pc', [synced.id]);
  await upload('jpeg', 'a.jpg', synced.id);
  const old = await upload('=SUM(1,2)', '=bad, "name".txt', null);
  const trashed = (
    await service.mutate('alice', old.id, {
      operationId: op(),
      baseRevision: old.revision,
      action: 'trash',
    })
  ).item;

  const { rows, storage: usage } = await audit();
  expect(rows.reduce((n, r) => n + r.countedBytes, 0)).toBe(usage.usedBytes);
  expect(usage.usedBytes).toBe(5 + 11 + 9 + 4 + 9);
  const by = (path: string) => rows.filter((r) => r.path === path);
  expect(by('/Work/plan.txt').map((r) => [r.state, r.sizeBytes, r.uploadedFrom])).toEqual([
    ['CURRENT', 11, null],
    ['PREVIOUS_VERSION', 5, 'pc'],
  ]);
  expect(rows.find((r) => r.path.endsWith('/notes.txt'))).toMatchObject({
    location: 'BACKUP',
    locationDetail: expect.stringContaining('mac'),
  });
  expect(by('/Photos/a.jpg')[0]).toMatchObject({ location: 'SYNC', locationDetail: 'Photos (pc)' });
  expect(by('/=bad, "name".txt')[0]).toMatchObject({ location: 'TRASH' });

  const csv = storageAuditCsv(rows, usage);
  expect(csv).toContain(`Unaccounted difference,0,0 B`);
  expect(csv).toContain(`"/=bad, ""name"".txt",Trash`);
  expect(storageAuditCsv([{ ...rows[0], path: '=cmd' }], usage)).toContain(`'=cmd,`);

  // Permanently deleted files leave the audit together with their bytes.
  await service.permanentDelete('alice', old.id, {
    operationId: op(),
    baseRevision: trashed.revision,
  });
  const deletion = new DeletionWorkflows(service);
  for (let i = 0; i < 5; i++) if (await deletion.step('alice', old.id)) break;
  const after = await audit(100);
  expect(after.rows.some((r) => r.itemId === old.id)).toBe(false);
  expect(after.rows.reduce((n, r) => n + r.countedBytes, 0)).toBe(after.storage.usedBytes);
});
it('counts a deleted file’s bytes while a sent transfer still holds them', async () => {
  const sent = await upload('for bob', 'gift.txt', null);
  await service.createTransfer('alice', {
    operationId: op(),
    recipient: { type: 'USERNAME', value: 'bob' },
    items: [{ driveItemId: sent.id }],
  });
  const trashed = (
    await service.mutate('alice', sent.id, {
      operationId: op(),
      baseRevision: sent.revision,
      action: 'trash',
    })
  ).item;
  await service.permanentDelete('alice', sent.id, {
    operationId: op(),
    baseRevision: trashed.revision,
  });
  const deletion = new DeletionWorkflows(service);
  for (let i = 0; i < 5; i++) if (await deletion.step('alice', sent.id)) break;
  const { rows, storage: usage } = await audit(100);
  expect(rows.find((r) => r.itemId === sent.id)).toMatchObject({
    state: 'RETAINED_FOR_TRANSFER',
    countedBytes: 7,
  });
  expect(usage.usedBytes).toBe(7);
  expect(rows.reduce((n, r) => n + r.countedBytes, 0)).toBe(usage.usedBytes);
});
