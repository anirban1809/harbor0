import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { DriveItem } from '@harbor/contracts';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { USAGE_CACHE_MS, UsageService } from '../src/usage';

let service: StorageService, storage: MemoryStorage, usage: UsageService;
const op = () => randomUUID();
async function folder(name: string, parentId: string | null = null) {
  return (await service.createFolder('alice', { parentId, name, operationId: op() })).item;
}
async function upload(parentId: string, name: string, body: string, previous?: DriveItem) {
  const hash = createHash('sha256').update(body).digest('hex');
  const { upload } = await service.createUpload('alice', {
    operationId: op(),
    name,
    parentId,
    sizeBytes: body.length,
    mimeType: 'text/plain',
    contentHash: hash,
    ...(previous ? { driveItemId: previous.id, baseRevision: previous.revision } : {}),
  });
  const stored = await service.getUpload('alice', upload.id);
  storage.uploads.get(stored.providerUploadId!)!.parts.set(1, Buffer.from(body));
  return (await service.completeUpload('alice', upload.id, [{ partNumber: 1, etag: 'e' }], hash))
    .item;
}
beforeEach(async () => {
  storage = new MemoryStorage();
  service = new StorageService(new MemoryRepository(), storage);
  usage = new UsageService(service);
  for (const id of ['alice', 'bob'])
    await service.ensureUser({
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      username: id,
      displayName: id,
    });
});

it('adds up every stored version in the subtree and skips the trash', async () => {
  const root = await folder('Backup');
  const nested = await folder('Nested', root.id);
  const first = await upload(root.id, 'a.txt', 'hello');
  await upload(root.id, 'a.txt', 'hello world', first); // a second version: 5 + 11 bytes
  await upload(nested.id, 'b.txt', 'abc');
  const trashed = await upload(nested.id, 'c.txt', 'trashed!');
  await service.mutate('alice', trashed.id, {
    operationId: op(),
    baseRevision: trashed.revision,
    action: 'trash',
  });
  expect((await usage.usage('alice', [root.id, nested.id])).items).toEqual([
    { itemId: root.id, bytes: 19, files: 2, complete: true },
    { itemId: nested.id, bytes: 3, files: 1, complete: true },
  ]);
});

it('reuses a recent count, then recounts once the drive changed and it has aged', async () => {
  const root = await folder('Sync');
  await upload(root.id, 'a.txt', 'hello');
  expect((await usage.usage('alice', [root.id])).items[0].bytes).toBe(5);
  await upload(root.id, 'b.txt', 'abc');
  expect((await usage.usage('alice', [root.id])).items[0].bytes).toBe(5);
  const now = Date.now();
  const spy = await import('vitest').then(({ vi }) =>
    vi.spyOn(Date, 'now').mockReturnValue(now + USAGE_CACHE_MS + 1),
  );
  expect((await usage.usage('alice', [root.id])).items[0]).toMatchObject({ bytes: 8, files: 2 });
  spy.mockRestore();
});

it('reports a lower bound for trees larger than the budget', async () => {
  const root = await folder('Big');
  const nested = await folder('Nested', root.id);
  await upload(root.id, 'a.txt', 'hello');
  await upload(nested.id, 'b.txt', 'abc');
  // Two items fit: the first level is counted, the nested folder is not reached.
  expect((await new UsageService(service, 2).usage('alice', [root.id])).items[0]).toEqual({
    itemId: root.id,
    bytes: 5,
    files: 1,
    complete: false,
  });
});

it('leaves out folders that are gone or belong to someone else', async () => {
  const root = await folder('Private');
  expect(await usage.usage('bob', [root.id])).toEqual({ items: [] });
  expect((await usage.usage('alice', [root.id, randomUUID()])).items.map((i) => i.itemId)).toEqual([
    root.id,
  ]);
});
