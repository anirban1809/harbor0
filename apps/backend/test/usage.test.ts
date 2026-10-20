import { beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { DriveItem } from '@harbor/contracts';
import { StorageService, userPK } from '../src/domain';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { USAGE_CACHE_MS, USAGE_COUNTING_MS, UsageService } from '../src/usage';
import { vi } from 'vitest';

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

it('keeps the last count while another request is counting the folder again', async () => {
  const root = await folder('Backup');
  await upload(root.id, 'a.txt', 'hello');
  await usage.usage('alice', [root.id]);
  await upload(root.id, 'b.txt', 'abc');
  const now = Date.now();
  const { vi } = await import('vitest');
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now + USAGE_CACHE_MS + 1);
  // Another request has just started counting.
  await transact(service.repo, async (tx) => {
    const cached = await tx.get<object>(userPK('alice'), `USAGE#${root.id}`);
    await tx.put(userPK('alice'), `USAGE#${root.id}`, { ...cached, countingAt: Date.now() });
  });
  expect((await usage.usage('alice', [root.id])).items[0].bytes).toBe(5);
  spy.mockReturnValue(now + USAGE_CACHE_MS + USAGE_COUNTING_MS + 2);
  expect((await usage.usage('alice', [root.id])).items[0].bytes).toBe(8);
  spy.mockRestore();
});

it('counts a folder seen for the first time once, however many requests ask at once', async () => {
  const root = await folder('Backup');
  await upload(root.id, 'a.txt', 'hello');
  // Another request has just started the first count: there's nothing to reuse yet.
  await transact(service.repo, (tx) =>
    tx.put(userPK('alice'), `USAGE#${root.id}`, {
      bytes: 0,
      files: 0,
      complete: false,
      sequence: -1,
      computedAt: 0,
      countingAt: Date.now(),
    }),
  );
  expect((await usage.usage('alice', [root.id])).items[0]).toEqual({
    itemId: root.id,
    bytes: 0,
    files: 0,
    complete: false,
  });
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + USAGE_COUNTING_MS + 1);
  expect((await usage.usage('alice', [root.id])).items[0]).toMatchObject({
    bytes: 5,
    complete: true,
  });
  spy.mockRestore();
});

it('marks a first count so a request arriving meanwhile does not count too', async () => {
  const root = await folder('Backup');
  await upload(root.id, 'a.txt', 'hello');
  const slow = service.repo.query.bind(service.repo);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const query = vi.spyOn(service.repo, 'query').mockImplementation(async (...args) => {
    if (String(args[1]).startsWith('CHILD#')) await held;
    return slow(...args);
  });
  const first = usage.usage('alice', [root.id]);
  await vi.waitFor(() => expect(query).toHaveBeenCalled());
  expect((await usage.usage('alice', [root.id])).items[0]).toMatchObject({
    bytes: 0,
    complete: false,
  });
  release();
  expect((await first).items[0]).toMatchObject({ bytes: 5, complete: true });
  query.mockRestore();
});

it('stops counting when its time runs out, keeps the lower bound, and counts again later', async () => {
  const root = await folder('Backup');
  const nested = await folder('Nested', root.id);
  const other = await folder('Other');
  await upload(root.id, 'a.txt', 'hello');
  await upload(nested.id, 'b.txt', 'abc');
  await upload(other.id, 'c.txt', 'xy');
  // Each folder listing takes a second; the request has half of one.
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const list = service.repo.query.bind(service.repo);
  const query = vi.spyOn(service.repo, 'query').mockImplementation(async (...args) => {
    if (String(args[1]).startsWith('CHILD#')) now += 1000;
    return list(...args);
  });
  const rushed = new UsageService(service, undefined, 500);
  // The first folder is cut short after its first level; the second isn't started.
  expect((await rushed.usage('alice', [root.id, other.id])).items).toEqual([
    { itemId: root.id, bytes: 5, files: 1, complete: false },
    { itemId: other.id, bytes: 0, files: 0, complete: false },
  ]);
  query.mockRestore();
  // The folder that wasn't started was left unmarked, so it's counted straight away.
  expect((await usage.usage('alice', [other.id])).items[0]).toMatchObject({
    bytes: 2,
    complete: true,
  });
  // The cut-short count is kept for a while, then counted again though nothing changed.
  expect((await usage.usage('alice', [root.id])).items[0]).toMatchObject({
    bytes: 5,
    complete: false,
  });
  now += USAGE_CACHE_MS + 1;
  expect((await usage.usage('alice', [root.id])).items[0]).toMatchObject({
    bytes: 8,
    complete: true,
  });
  clock.mockRestore();
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
