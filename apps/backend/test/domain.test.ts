import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { StorageService, type Upload, type StoredObject, userPK } from '../src/domain';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import type { Identity } from '@harbor/contracts';
let repo: MemoryRepository, storage: MemoryStorage, service: StorageService;
const alice: Identity = {
  id: 'alice',
  email: 'alice@example.test',
  emailVerified: true,
  username: 'alice',
  displayName: 'Alice',
};
const bob: Identity = {
  id: 'bob',
  email: 'bob@example.test',
  emailVerified: true,
  username: 'bob',
  displayName: 'Bob',
};
const op = () => randomUUID();
async function uploaded(name = 'hello.txt', data = 'hello world', parentId: string | null = null) {
  const hash = createHash('sha256').update(data).digest('hex');
  const r = await service.createUpload('alice', {
    operationId: op(),
    parentId,
    name,
    sizeBytes: Buffer.byteLength(data),
    mimeType: 'text/plain',
    contentHash: hash,
  });
  const u = await service.getUpload('alice', r.upload.id);
  storage.uploads.get(u.providerUploadId!)!.parts.set(1, Buffer.from(data));
  const parts = [{ partNumber: 1, etag: 'part-1' }];
  const result = await service.completeUpload('alice', u.id, parts, hash);
  return { ...result, upload: u, parts, hash };
}
beforeEach(async () => {
  repo = new MemoryRepository();
  storage = new MemoryStorage();
  service = new StorageService(repo, storage);
  await service.ensureUser(alice);
  await service.ensureUser(bob);
});
describe('quota and upload recovery', () => {
  it('atomically prevents concurrent reservations exceeding quota', async () => {
    await transact(repo, async (tx) => {
      const u = await service.account(tx, 'alice');
      u.storageQuotaBytes = 10;
      await tx.put(userPK('alice'), 'PROFILE', u);
    });
    const responses = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        service.createUpload('alice', {
          operationId: op(),
          parentId: null,
          name: `file-${i}`,
          sizeBytes: 6,
          mimeType: 'text/plain',
        }),
      ),
    );
    expect(responses.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.me('alice')).storage).toEqual({
      quotaBytes: 10,
      usedBytes: 0,
      reservedBytes: 6,
      availableBytes: 4,
    });
  });
  it('replays upload creation and completion without charging twice', async () => {
    const a = await uploaded();
    await service.completeUpload('alice', a.upload.id, a.parts, a.hash);
    expect((await service.me('alice')).storage.usedBytes).toBe(11);
    expect((await service.list('alice', null)).items).toHaveLength(1);
    await expect(
      service.completeUpload('alice', a.upload.id, a.parts, '0'.repeat(64)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('releases aborted reservations exactly once and rejects completion', async () => {
    const r = await service.createUpload('alice', {
      operationId: op(),
      parentId: null,
      name: 'abort',
      sizeBytes: 99,
      mimeType: 'text/plain',
    });
    await Promise.all([
      service.abortUpload('alice', r.upload.id),
      service.abortUpload('alice', r.upload.id),
    ]);
    expect((await service.me('alice')).storage.reservedBytes).toBe(0);
    await expect(
      service.completeUpload('alice', r.upload.id, [{ partNumber: 1, etag: 'x' }], '0'.repeat(64)),
    ).rejects.toMatchObject({ code: 'INVALID_UPLOAD_STATE' });
  });
  it('verifies provider size before committing metadata', async () => {
    const r = await service.createUpload('alice', {
      operationId: op(),
      parentId: null,
      name: 'bad',
      sizeBytes: 2,
      mimeType: 'text/plain',
    });
    const u = await service.getUpload('alice', r.upload.id);
    storage.uploads.get(u.providerUploadId!)!.parts.set(1, Buffer.from('oversized'));
    await expect(
      service.completeUpload('alice', u.id, [{ partNumber: 1, etag: 'x' }], '0'.repeat(64)),
    ).rejects.toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH' });
    expect((await service.me('alice')).storage.usedBytes).toBe(0);
    expect((await service.me('alice')).storage.reservedBytes).toBe(0);
    expect(storage.objects.size).toBe(0);
  });
  it('expires abandoned uploads through the durable cleanup queue', async () => {
    const r = await service.createUpload('alice', {
      operationId: op(),
      parentId: null,
      name: 'expired',
      sizeBytes: 20,
      mimeType: 'text/plain',
    });
    await transact(repo, async (tx) => {
      const u = (await tx.get<Upload>(userPK('alice'), `UPLOAD#${r.upload.id}`))!;
      u.expiresAt = '2000-01-01T00:00:00.000Z';
      await tx.put(userPK('alice'), `UPLOAD#${u.id}`, u);
      await service.job(tx, {
        id: `upload-${u.id}`,
        type: 'UPLOAD_EXPIRE',
        userId: 'alice',
        entityId: u.id,
        dueAt: u.expiresAt,
        attempts: 0,
      });
    });
    await service.runJobs();
    expect((await service.me('alice')).storage.reservedBytes).toBe(0);
  });
});
describe('filesystem consistency', () => {
  it('enforces Unicode-normalized names, stale revisions, cycle checks and idempotency', async () => {
    const create = { operationId: op(), parentId: null, name: 'Café' };
    const { item } = await service.createFolder('alice', create);
    expect((await service.createFolder('alice', create)).item.id).toBe(item.id);
    await expect(
      service.createFolder('alice', { ...create, operationId: op(), name: 'Cafe\u0301' }),
    ).rejects.toMatchObject({ code: 'NAME_CONFLICT' });
    const child = (
      await service.createFolder('alice', { operationId: op(), parentId: item.id, name: 'child' })
    ).item;
    await expect(
      service.mutate('alice', item.id, { operationId: op(), baseRevision: 1, parentId: child.id }),
    ).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    await service.mutate('alice', item.id, { operationId: op(), baseRevision: 1, name: 'New' });
    await expect(
      service.mutate('alice', item.id, { operationId: op(), baseRevision: 1, name: 'Stale' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('hides descendants of trashed folders, then restores them', async () => {
    const folder = (
      await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Docs' })
    ).item;
    const f = await uploaded('nested', 'secret', folder.id);
    const deleted = (
      await service.mutate('alice', folder.id, {
        operationId: op(),
        baseRevision: 1,
        action: 'trash',
      })
    ).item;
    await expect(service.download('alice', { driveItemId: f.item.id })).rejects.toMatchObject({
      code: 'PARENT_NOT_FOUND',
    });
    await expect(service.metadata('bob', f.item.id)).rejects.toBeDefined();
    expect((await service.browseSpecial('alice', { q: 'nested' })).items).toHaveLength(0);
    await service.mutate('alice', folder.id, {
      operationId: op(),
      baseRevision: deleted.revision,
      action: 'restore',
    });
    expect((await service.download('alice', { driveItemId: f.item.id })).sizeBytes).toBe(6);
  });
  it('preserves old file versions and checks revision at content commit', async () => {
    const a = await uploaded();
    const r = await service.createUpload('alice', {
      operationId: op(),
      parentId: null,
      name: a.item.name,
      sizeBytes: 3,
      mimeType: 'text/plain',
      driveItemId: a.item.id,
      baseRevision: 1,
    });
    const u = await service.getUpload('alice', r.upload.id);
    storage.uploads.get(u.providerUploadId!)!.parts.set(1, Buffer.from('new'));
    await service.mutate('alice', a.item.id, {
      operationId: op(),
      baseRevision: 1,
      name: 'renamed',
    });
    await expect(
      service.completeUpload(
        'alice',
        u.id,
        [{ partNumber: 1, etag: 'x' }],
        createHash('sha256').update('new').digest('hex'),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await service.versions('alice', a.item.id)).items).toHaveLength(1);
    await service.abortUpload('alice', u.id);
    expect((await service.me('alice')).storage.reservedBytes).toBe(0);
  });
  it('keeps change cursors monotonic under concurrency', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        service.createFolder('alice', { operationId: op(), parentId: null, name: `Folder ${i}` }),
      ),
    );
    const first = await service.changes('alice', 0, 2);
    expect(first.changes.map((c) => c.sequence)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const rest = await service.changes('alice', first.nextCursor, 100);
    expect(rest.changes.map((c) => c.sequence)).toEqual([3, 4, 5]);
  });
});
describe('authenticated transfers and sharing', () => {
  it('sends, accepts, downloads and saves without reupload or duplicate quota', async () => {
    const a = await uploaded();
    const { transfer } = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: a.item.id }],
    });
    const inbox = await service.listTransfers('bob', 'received');
    expect(inbox.items).toHaveLength(1);
    const entry = inbox.items[0].items[0];
    await expect(
      service.download('bob', { transferId: transfer.id, entryId: entry.id }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_ALLOWED' });
    await expect(
      service.transferAction('alice', transfer.id, 'accept', op()),
    ).rejects.toMatchObject({ code: 'TRANSFER_NOT_ALLOWED' });
    await service.transferAction('bob', transfer.id, 'accept', op());
    expect((await service.me('bob')).storage.usedBytes).toBe(0);
    const signed = await service.download('bob', { transferId: transfer.id, entryId: entry.id });
    expect(signed.contentHash).toBe(a.hash);
    const saved = await service.saveTransfer('bob', transfer.id, {
      operationId: op(),
      targetParentId: null,
    });
    await service.saveTransfer('bob', transfer.id, { operationId: op(), targetParentId: null });
    expect((await service.me('bob')).storage.usedBytes).toBe(11);
    expect(
      (await service.changes('bob', 0, 100)).changes.some((c) => c.entityId === saved.items[0].id),
    ).toBe(true);
    const object = (await repo.get({ pk: 'OBJECT', sk: a.upload.objectId }))!.data as StoredObject;
    expect(object.references).toBe(3);
  });
  it('claims invitations only through matching verified identity', async () => {
    const a = await uploaded();
    const { transfer } = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'EMAIL', value: 'CHARLIE@example.test' },
      items: [{ driveItemId: a.item.id }],
    });
    expect(transfer.state).toBe('PENDING_RECIPIENT_SIGNUP');
    await service.claimPending('bob');
    expect((await service.listTransfers('bob', 'received')).items).toHaveLength(0);
    const charlie = {
      id: 'charlie',
      email: 'charlie@example.test',
      emailVerified: false,
      username: 'charlie',
      displayName: 'Charlie',
    };
    await expect(service.ensureUser(charlie)).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    await service.ensureUser({ ...charlie, emailVerified: true });
    await Promise.all([service.claimPending('charlie'), service.claimPending('charlie')]);
    expect((await service.listTransfers('charlie', 'received')).items[0].state).toBe('PENDING');
  });
  it('retains and charges sent content until its transfer expires', async () => {
    const a = await uploaded();
    const { transfer } = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: a.item.id }],
    });
    await service.transferAction('bob', transfer.id, 'accept', op());
    const deleted = (
      await service.mutate('alice', a.item.id, {
        operationId: op(),
        baseRevision: 1,
        action: 'trash',
      })
    ).item;
    await service.permanentDelete('alice', a.item.id, {
      operationId: op(),
      baseRevision: deleted.revision,
    });
    expect((await service.me('alice')).storage.usedBytes).toBe(11);
    const t = (await service.listTransfers('bob', 'received')).items[0];
    expect(
      (await service.download('bob', { transferId: t.id, entryId: t.items[0].id })).contentHash,
    ).toBe(a.hash);
    const { TransferWorkflows } = await import('../src/workflows');
    const { DeletionWorkflows } = await import('../src/deletion');
    await transact(repo, (tx) =>
      tx.put('TRANSFER', t.id, { ...t, expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    const workflow = new TransferWorkflows(service);
    await workflow.expire(t.id);
    await workflow.release(t.id);
    const deletion = new DeletionWorkflows(service);
    for (let i = 0; i < 5; i++) if (await deletion.step('alice', a.item.id)) break;
    expect((await service.me('alice')).storage.usedBytes).toBe(0);
  });
  it('enforces recipient quota without partially saving a transfer', async () => {
    const a = await uploaded();
    const { transfer } = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: a.item.id }],
    });
    await service.transferAction('bob', transfer.id, 'accept', op());
    await transact(repo, async (tx) => {
      const u = await service.account(tx, 'bob');
      u.storageQuotaBytes = 1;
      await tx.put(userPK('bob'), 'PROFILE', u);
    });
    await expect(
      service.saveTransfer('bob', transfer.id, { operationId: op(), targetParentId: null }),
    ).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
    expect((await service.list('bob', null)).items).toHaveLength(0);
  });
  it('pins folder manifests and preserves hierarchy when saved', async () => {
    const folder = (
      await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Folder' })
    ).item;
    await uploaded('nested.txt', 'content', folder.id);
    const { transfer } = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: folder.id }],
    });
    await service.transferAction('bob', transfer.id, 'accept', op());
    const saved = await service.saveTransfer('bob', transfer.id, {
      operationId: op(),
      targetParentId: null,
    });
    const parent = saved.items.find((i) => i.type === 'FOLDER')!;
    expect(saved.items.find((i) => i.type === 'FILE')!.parentId).toBe(parent.id);
  });
  it('applies inherited viewer permissions and immediately revokes API access', async () => {
    const folder = (
      await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Shared' })
    ).item;
    const a = await uploaded('shared.txt', 'yes', folder.id);
    await expect(service.download('bob', { driveItemId: a.item.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const { share } = await service.createShare('alice', {
      operationId: op(),
      driveItemId: folder.id,
      recipient: { type: 'USERNAME', value: 'bob' },
      permission: 'VIEWER',
    });
    expect((await service.sharedList('bob', folder.id, 100)).items).toHaveLength(1);
    expect((await service.download('bob', { driveItemId: a.item.id })).sizeBytes).toBe(3);
    await expect(
      service.mutate('bob', a.item.id, { operationId: op(), baseRevision: 1, name: 'forbidden' }),
    ).rejects.toBeDefined();
    await service.revokeShare('alice', share.id, op());
    await expect(service.download('bob', { driveItemId: a.item.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
describe('API security contract', () => {
  it('rejects missing authentication, invalid paths and revoked devices', async () => {
    const auth = new DevelopmentAuth();
    const { app } = createApp(service, auth);
    const response = await app.request('/v1/users/me');
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('AUTH_REQUIRED');
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password: 'Development-only-123!' }),
    });
    expect(login.status).toBe(200);
    const session = await login.json();
    const headers = {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    };
    const bad = await app.request('/v1/drive/folders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '../escape', parentId: null, operationId: op() }),
    });
    expect(bad.status).toBe(400);
    await service.revokeDevice('alice', session.device.id);
    expect((await app.request('/v1/users/me', { headers })).status).toBe(403);
    expect(
      (
        await app.request('/v1/auth/session', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'try again', platform: 'WEB' }),
        })
      ).status,
    ).toBe(403);
  });
  it('generates an OpenAPI operation for every public API route', () => {
    const { document } = createApp(service, new DevelopmentAuth());
    const spec = document();
    expect(spec.paths['/v1/uploads/{id}/complete'].post).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
  });
});

describe('durable folder transfer workflows', () => {
  it('prepares and saves a large manifest across transactions without exposing partial files', async () => {
    const { TransferWorkflows } = await import('../src/workflows');
    const workflows = new TransferWorkflows(service);
    const folder = (
      await service.createFolder('alice', {
        operationId: op(),
        parentId: null,
        name: 'Large collection',
      })
    ).item;
    for (let i = 0; i < 24; i++) await uploaded(`part-${i}.txt`, 'data', folder.id);
    const result = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: folder.id }],
    });
    const id = result.transfer.id;
    expect((await service.listTransfers('bob', 'received')).items).toHaveLength(0);
    await expect(service.transferAction('bob', id, 'accept', op())).rejects.toMatchObject({
      code: 'TRANSFER_PREPARING',
    });
    let ready = false;
    for (let i = 0; i < 10 && !ready; i++) ready = await workflows.build(id);
    expect(ready).toBe(true);
    const received = (await service.listTransfers('bob', 'received')).items[0];
    expect(received.items).toHaveLength(25);
    expect(received.totalSizeBytes).toBe(96);
    await service.transferAction('bob', id, 'accept', op());
    const saving = await service.saveTransfer('bob', id, {
      operationId: op(),
      targetParentId: null,
    });
    expect(saving).toMatchObject({ jobId: id, state: 'SAVING' });
    expect((await service.me('bob')).storage.reservedBytes).toBe(96);
    await workflows.saveBatch(id);
    expect((await service.list('bob', null)).items).toHaveLength(0);
    let finished = false;
    for (let i = 0; i < 10 && !finished; i++) finished = await workflows.saveBatch(id);
    expect(finished).toBe(true);
    const root = (await service.list('bob', null)).items[0];
    expect(root.name).toBe('Large collection');
    expect((await service.list('bob', root.id)).items).toHaveLength(24);
    expect((await service.me('bob')).storage.usedBytes).toBe(96);
    expect((await service.me('bob')).storage.reservedBytes).toBe(0);
    await workflows.saveBatch(id);
    expect((await service.me('bob')).storage.usedBytes).toBe(96);
  });
  it('releases all transfer pins after cancellation without a giant transaction', async () => {
    const { TransferWorkflows } = await import('../src/workflows');
    const workflows = new TransferWorkflows(service);
    const folder = (
      await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Folder' })
    ).item;
    const objects = [];
    for (let i = 0; i < 20; i++) objects.push(await uploaded(`file-${i}`, 'data', folder.id));
    const { transfer } = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: folder.id }],
    });
    for (let i = 0; i < 5; i++) if (await workflows.build(transfer.id)) break;
    await service.transferAction('alice', transfer.id, 'cancel', op());
    for (let i = 0; i < 5; i++) if (await workflows.release(transfer.id)) break;
    for (const object of objects)
      expect(
        ((await repo.get({ pk: 'OBJECT', sk: object.upload.objectId }))!.data as StoredObject)
          .references,
      ).toBe(1);
  });
  it('rolls back a failed staged save and releases its full reservation', async () => {
    const { TransferWorkflows } = await import('../src/workflows');
    const workflows = new TransferWorkflows(service);
    const folder = (
      await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Duplicate' })
    ).item;
    for (let i = 0; i < 18; i++) await uploaded(`file-${i}`, 'data', folder.id);
    const { transfer } = await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: folder.id }],
    });
    for (let i = 0; i < 5; i++) if (await workflows.build(transfer.id)) break;
    await service.transferAction('bob', transfer.id, 'accept', op());
    await service.createFolder('bob', { operationId: op(), parentId: null, name: 'Duplicate' });
    await service.saveTransfer('bob', transfer.id, { operationId: op(), targetParentId: null });
    for (let i = 0; i < 10; i++) if (await workflows.saveBatch(transfer.id)) break;
    expect((await service.me('bob')).storage.reservedBytes).toBe(0);
    expect((await service.me('bob')).storage.usedBytes).toBe(0);
    expect((await service.list('bob', null)).items).toHaveLength(1);
  });
});

describe('storage-only entitlements', () => {
  it('deduplicates billing events, ignores older events, and never deletes over-quota data', async () => {
    const { applyEntitlement } = await import('../src/billing');
    const event = {
      eventId: op(),
      userId: 'alice',
      totalQuotaBytes: 500_000_000_000,
      occurredAt: '2026-01-02T00:00:00Z',
    };
    await applyEntitlement(service, event);
    await applyEntitlement(service, event);
    expect((await service.me('alice')).storage.quotaBytes).toBe(500_000_000_000);
    await applyEntitlement(service, {
      ...event,
      eventId: op(),
      totalQuotaBytes: 100_000_000_000,
      occurredAt: '2026-01-01T00:00:00Z',
    });
    expect((await service.me('alice')).storage.quotaBytes).toBe(500_000_000_000);
    await transact(repo, async (tx) => {
      const u = await service.account(tx, 'alice');
      u.storageUsedBytes = 200_000_000_000;
      await tx.put(userPK('alice'), 'PROFILE', u);
    });
    await applyEntitlement(service, {
      ...event,
      eventId: op(),
      totalQuotaBytes: 100_000_000_000,
      occurredAt: '2026-01-03T00:00:00Z',
    });
    expect((await service.me('alice')).storage.usedBytes).toBe(200_000_000_000);
    expect((await service.me('alice')).storage.availableBytes).toBe(0);
  });
});

it('permanently deletes nested folders in durable batches while preserving accepted transfers', async () => {
  const { DeletionWorkflows } = await import('../src/deletion');
  const root = (
    await service.createFolder('alice', { operationId: op(), parentId: null, name: 'Purge me' })
  ).item;
  const nested = (
    await service.createFolder('alice', { operationId: op(), parentId: root.id, name: 'nested' })
  ).item;
  const files = [];
  for (let i = 0; i < 16; i++) files.push(await uploaded(`file-${i}`, 'data', nested.id));
  const transfer = (
    await service.createTransfer('alice', {
      operationId: op(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: files[0].item.id }],
    })
  ).transfer;
  await service.transferAction('bob', transfer.id, 'accept', op());
  const deleted = (
    await service.mutate('alice', root.id, { operationId: op(), baseRevision: 1, action: 'trash' })
  ).item;
  await service.permanentDelete('alice', root.id, {
    operationId: op(),
    baseRevision: deleted.revision,
  });
  const workflow = new DeletionWorkflows(service);
  for (let i = 0; i < 10; i++) if (await workflow.step('alice', root.id)) break;
  expect((await service.me('alice')).storage.usedBytes).toBe(4);
  expect((await service.list('alice', null)).items).toHaveLength(0);
  expect((await service.browseSpecial('alice', { trash: 'true' })).items).toHaveLength(0);
  const received = (await service.listTransfers('bob', 'received')).items[0];
  expect(
    (await service.download('bob', { transferId: transfer.id, entryId: received.items[0].id }))
      .contentHash,
  ).toBe(files[0].hash);
});

describe('metadata-only trash', () => {
  it('keeps object keys and bytes unchanged through trash, restore, and permanent deletion', async () => {
    const { item, upload } = await uploaded();
    const before = new Map([...storage.objects].map(([key, bytes]) => [key, Buffer.from(bytes)]));
    // A trash request must succeed even when every object-storage operation is unavailable.
    service.storage = new Proxy(storage, {
      get() {
        throw new Error('Trash must not access object storage');
      },
    });
    const trash = async (revision: number) =>
      (
        await service.mutate('alice', item.id, {
          operationId: op(),
          baseRevision: revision,
          action: 'trash',
        })
      ).item;
    const trashed = await trash(item.revision);
    expect((await service.list('alice', null)).items).toHaveLength(0);
    const restored = (
      await service.mutate('alice', item.id, {
        operationId: op(),
        baseRevision: trashed.revision,
        action: 'restore',
      })
    ).item;
    expect(restored.currentVersionId).toBe(item.currentVersionId);
    const again = await trash(restored.revision);
    const input = { operationId: op(), baseRevision: again.revision };
    await expect(
      service.permanentDelete('alice', item.id, { ...input, baseRevision: 1 }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const result = await service.permanentDelete('alice', item.id, input);
    expect(await service.permanentDelete('alice', item.id, input)).toEqual(result);
    expect((await service.browseSpecial('alice', { trash: 'true' })).items).toHaveLength(0);
    await expect(
      service.mutate('alice', item.id, {
        operationId: op(),
        baseRevision: again.revision,
        action: 'restore',
      }),
    ).rejects.toMatchObject({ code: 'ITEM_DELETING' });
    // Reference cleanup is asynchronous and still does not read, copy, or move file bytes.
    const { DeletionWorkflows } = await import('../src/deletion');
    for (let i = 0; i < 5; i++)
      if (await new DeletionWorkflows(service).step('alice', item.id)) break;
    expect((await service.me('alice')).storage.usedBytes).toBe(0);
    expect((await repo.get({ pk: 'OBJECT', sk: upload.objectId }))?.data).toMatchObject({
      key: upload.objectKey,
      references: 0,
    });
    expect(storage.objects).toEqual(before);
    expect(await service.permanentDelete('alice', item.id, input)).toEqual(result);
  });

  it('empties every page, replays each batch safely, and leaves live and other users’ items alone', async () => {
    for (let i = 0; i < 23; i++) {
      const { item } = await service.createFolder('alice', {
        operationId: op(),
        parentId: null,
        name: `Trash ${i}`,
      });
      await service.mutate('alice', item.id, {
        operationId: op(),
        baseRevision: 1,
        action: 'trash',
      });
    }
    const live = (await uploaded()).item;
    const other = (
      await service.createFolder('bob', { operationId: op(), parentId: null, name: 'Other trash' })
    ).item;
    await service.mutate('bob', other.id, { operationId: op(), baseRevision: 1, action: 'trash' });
    service.storage = new Proxy(storage, {
      get() {
        throw new Error('No storage I/O');
      },
    });
    let cursor: string | undefined;
    let count = 0;
    let pages = 0;
    do {
      const input = { operationId: op(), ...(cursor ? { cursor } : {}) };
      const page = await service.emptyTrash('alice', input);
      expect(await service.emptyTrash('alice', input)).toEqual(page);
      count += page.count;
      pages++;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(count).toBe(23);
    expect((await service.browseSpecial('alice', { trash: 'true' })).items).toHaveLength(0);
    expect((await service.list('alice', null)).items.map((i) => i.id)).toEqual([live.id]);
    expect((await service.browseSpecial('bob', { trash: 'true' })).items).toHaveLength(1);
    expect((await service.emptyTrash('alice', { operationId: op() })).count).toBe(0);
  });
});
