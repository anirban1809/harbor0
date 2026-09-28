import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { createHash, randomUUID } from 'node:crypto';
import { DynamoRepository, transact } from '../src/repository';
import { ArchiveWorkflows } from '../src/archives';
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { R2Storage } from '../src/storage';
import { StorageService, userPK } from '../src/domain';
const enabled = process.env.RUN_INTEGRATION === 'true';
describe.skipIf(!enabled)('real DynamoDB and S3-compatible protocol', () => {
  const table = 'harbor-test-' + Date.now();
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8100';
  let db: DynamoDBClient, repo: DynamoRepository, service: StorageService;
  beforeAll(async () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    db = new DynamoDBClient({ endpoint });
    await db.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'gpk', AttributeType: 'S' },
          { AttributeName: 'gsk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'jobs',
            KeySchema: [
              { AttributeName: 'gpk', KeyType: 'HASH' },
              { AttributeName: 'gsk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    repo = new DynamoRepository(table, endpoint);
    service = new StorageService(
      repo,
      new R2Storage(
        'harbor-local',
        'http://127.0.0.1:9100',
        'local-storage',
        'local-development-secret',
      ),
    );
    for (const name of ['alice', 'bob'])
      await service.ensureUser({
        id: name,
        email: `${name}@example.test`,
        emailVerified: true,
        username: name,
        displayName: name,
      });
  });
  afterAll(async () => {
    if (db) await db.send(new DeleteTableCommand({ TableName: table }));
  });
  it('executes actual multipart signed PUT, HEAD validation, acceptance, save and ranged download', async () => {
    const bytes = Buffer.from('Actual bytes through the storage service.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const response = await service.createUpload('alice', {
      operationId: randomUUID(),
      name: 'real.txt',
      parentId: null,
      sizeBytes: bytes.length,
      mimeType: 'text/plain',
      contentHash: hash,
    });
    const signed = await service.uploadParts('alice', response.upload.id, [1]);
    const put = await fetch(signed.parts[0].uploadUrl, { method: 'PUT', body: bytes });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag')!;
    expect((await service.uploadStatus('alice', response.upload.id)).parts).toEqual([
      { partNumber: 1, etag },
    ]);
    const completed = await service.completeUpload(
      'alice',
      response.upload.id,
      [{ partNumber: 1, etag }],
      hash,
    );
    const { transfer } = await service.createTransfer('alice', {
      operationId: randomUUID(),
      recipient: { type: 'USERNAME', value: 'bob' },
      items: [{ driveItemId: completed.item.id }],
    });
    await service.transferAction('bob', transfer.id, 'accept', randomUUID());
    const saved = await service.saveTransfer('bob', transfer.id, {
      operationId: randomUUID(),
      targetParentId: null,
    });
    const download = await service.download('bob', { driveItemId: saved.items[0].id });
    const content = Buffer.from(await (await fetch(download.downloadUrl)).arrayBuffer());
    expect(createHash('sha256').update(content).digest('hex')).toBe(hash);
    const partial = await fetch(download.downloadUrl, { headers: { Range: 'bytes=7-11' } });
    expect(partial.status).toBe(206);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(7, 12));
  });
  it('prepares a multipart ZIP through real DynamoDB and S3 and cleans it up', async () => {
    await service.registerDevice('bob', { name: 'ZIP test', platform: 'WEB' }, 'archive-device');
    const folder = (
      await service.createFolder('bob', {
        name: 'Archive test',
        parentId: null,
        operationId: randomUUID(),
      })
    ).item;
    const bytes = Buffer.alloc(18 * 1024 * 1024, 97);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const { upload } = await service.createUpload('bob', {
      operationId: randomUUID(),
      parentId: folder.id,
      name: 'large.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      contentHash: hash,
    });
    const u = await service.getUpload('bob', upload.id);
    const parts: { partNumber: number; etag: string }[] = [];
    for (let offset = 0; offset < bytes.length; offset += u.partSizeBytes) {
      const partNumber = parts.length + 1;
      const signed = await service.uploadParts('bob', u.id, [partNumber]);
      const response = await fetch(signed.parts[0].uploadUrl, {
        method: 'PUT',
        body: bytes.subarray(offset, offset + u.partSizeBytes),
      });
      expect(response.ok).toBe(true);
      parts.push({ partNumber, etag: response.headers.get('etag')! });
    }
    await service.completeUpload('bob', u.id, parts, hash);
    const worker = new ArchiveWorkflows(service);
    const { id } = await worker.create('bob', 'archive-device', folder.id, randomUUID());
    try {
      expect(await worker.step(id)).toBe(true);
      const signed = await worker.download('bob', id);
      const response = await fetch(signed.downloadUrl);
      expect(response.headers.get('content-disposition')).toContain('attachment');
      const archive = new Uint8Array(await response.arrayBuffer());
      expect(createHash('sha256').update(archive).digest('hex')).toBe(signed.contentHash);
      const reader = new ZipReader(new Uint8ArrayReader(archive), {
        useWebWorkers: false,
        checkSignature: true,
      });
      const entry = (await reader.getEntries()).find((entry) =>
        entry.filename.endsWith('/large.txt'),
      )!;
      expect(entry.directory).toBe(false);
      if (!entry.directory) {
        const extracted = await entry.getData(new Uint8ArrayWriter());
        expect(extracted.length).toBe(bytes.length);
        expect(createHash('sha256').update(extracted).digest('hex')).toBe(hash);
      }
      await reader.close();
      const m = await worker.get('bob', id);
      expect(m.part).toBe(3);
      await worker.cancel('bob', id);
      expect(await worker.cleanup(id)).toBe(true);
      expect(await service.storage.head(m.key)).toBe(null);
    } finally {
      await worker.cancel('bob', id);
      await worker.cleanup(id);
      await service.storage.remove(u.objectKey);
    }
  }, 60000);
  it('enforces quota under real concurrent transactions and retries', async () => {
    await transact(repo, async (tx) => {
      const user = await service.account(tx, 'alice');
      user.storageQuotaBytes = user.storageUsedBytes + 10;
      await tx.put(userPK('alice'), 'PROFILE', user);
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        service.createUpload('alice', {
          operationId: randomUUID(),
          parentId: null,
          name: `race${i}`,
          sizeBytes: 7,
          mimeType: 'text/plain',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const usage = (await service.me('alice')).storage;
    expect(usage.reservedBytes).toBe(7);
    expect(usage.availableBytes).toBe(3);
    for (const r of results)
      if (r.status === 'fulfilled') await service.abortUpload('alice', r.value.upload.id);
  });
});
