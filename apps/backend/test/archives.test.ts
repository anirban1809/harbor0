import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { ZipReader, Uint8ArrayReader, TextWriter } from '@zip.js/zip.js';
import { MemoryRepository, Transaction, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { StorageService, type StoredObject } from '../src/domain';
import { ArchiveWorkflows, type Archive } from '../src/archives';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { zipCentralHeader, zipEnd } from '../src/zip-format';

let repo: MemoryRepository,
  storage: MemoryStorage,
  service: StorageService,
  worker: ArchiveWorkflows;
let folder: string;
const op = () => randomUUID();
beforeEach(async () => {
  repo = new MemoryRepository();
  storage = new MemoryStorage();
  service = new StorageService(repo, storage);
  await service.ensureUser({
    id: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    username: 'alice',
    displayName: 'Alice',
  });
  await service.registerDevice('alice', { name: 'Browser', platform: 'WEB' }, 'browser');
  folder = (
    await service.createFolder('alice', { name: 'Project 🌍', parentId: null, operationId: op() })
  ).item.id;
  worker = new ArchiveWorkflows(service, 1024);
});
afterEach(() => vi.restoreAllMocks());
async function upload(name: string, data: string, parentId = folder) {
  const hash = createHash('sha256').update(data).digest('hex');
  const { upload } = await service.createUpload('alice', {
    operationId: op(),
    parentId,
    name,
    sizeBytes: Buffer.byteLength(data),
    mimeType: 'text/plain',
    contentHash: hash,
  });
  const u = await service.getUpload('alice', upload.id);
  storage.uploads.get(u.providerUploadId!)!.parts.set(1, Buffer.from(data));
  await service.completeUpload('alice', u.id, [{ partNumber: 1, etag: 'part-1' }], hash);
  return u;
}
async function create() {
  return (await worker.create('alice', 'browser', folder, op())).id;
}
async function content(id: string) {
  const m = await worker.get('alice', id);
  expect(m.state).toBe('READY');
  const bytes = storage.objects.get(m.key)!;
  expect(m.position).toBe(bytes.length);
  expect(m.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    checkSignature: true,
  });
  const result: Record<string, string | null> = {};
  for (const entry of await reader.getEntries())
    result[entry.filename] = entry.directory ? null : await entry.getData(new TextWriter());
  await reader.close();
  return result;
}
it('creates one valid ZIP with nested, empty, Unicode and paginated files', async () => {
  const nested = (
    await service.createFolder('alice', { name: 'Nested', parentId: folder, operationId: op() })
  ).item.id;
  await service.createFolder('alice', { name: 'Empty', parentId: nested, operationId: op() });
  await upload('résumé.txt', 'Hello 🌍', nested);
  await upload('zero', '');
  for (let i = 0; i < 12; i++) await upload(`file${i}`, `${i}`);
  const id = await create();
  expect(await worker.step(id)).toBe(true);
  const entries = await content(id);
  expect(entries['Project 🌍/Nested/résumé.txt']).toBe('Hello 🌍');
  expect(entries['Project 🌍/Nested/Empty/']).toBe(null);
  expect(entries['Project 🌍/zero']).toBe('');
  expect(Object.keys(entries)).toHaveLength(17);
  expect(await worker.status('alice', id)).toMatchObject({
    state: 'READY',
    files: 14,
    totalFiles: 14,
    downloadUrl: expect.any(String),
  });
});
it('checkpoints and resumes in the middle of a file without losing or repeating bytes', async () => {
  const data = 'abcdefghij'.repeat(1000);
  await upload('large', data);
  const id = await create();
  const deadline = Date.now() + 10000;
  const realRead = storage.readRange.bind(storage);
  const read = vi.spyOn(storage, 'readRange').mockImplementation(async (...args) => {
    const bytes = await realRead(...args);
    if (!args[0].startsWith('archives/')) vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    return bytes;
  });
  expect(await worker.step(id, deadline)).toBe(false);
  const checkpoint = await worker.get('alice', id);
  expect(checkpoint.bytes).toBeGreaterThan(0);
  expect(checkpoint.bytes).toBeLessThan(data.length);
  expect(checkpoint.pendingSize).toBeGreaterThan(0);
  vi.restoreAllMocks();
  expect(read).toHaveBeenCalled();
  expect(await new ArchiveWorkflows(service, 1024).step(id)).toBe(true);
  expect((await content(id))['Project 🌍/large']).toBe(data);
});
it('retries an interrupted multipart write from the last committed checkpoint', async () => {
  await upload('large', 'x'.repeat(5000));
  const id = await create();
  const original = storage.writePart.bind(storage);
  let writes = 0;
  vi.spyOn(storage, 'writePart').mockImplementation(async (...args) => {
    const receipt = await original(...args);
    if (++writes === 2) throw new Error('lost response after provider write');
    return receipt;
  });
  await expect(worker.step(id)).rejects.toThrow('lost response');
  expect((await worker.get('alice', id)).bytes).toBeGreaterThan(0);
  expect(await worker.step(id)).toBe(true);
  expect((await content(id))['Project 🌍/large']).toBe('x'.repeat(5000));
});
it('recovers after completion succeeds but its response is lost', async () => {
  await upload('notes', 'hello');
  const id = await create();
  const complete = storage.complete.bind(storage);
  vi.spyOn(storage, 'complete').mockImplementationOnce(async (...args) => {
    await complete(...args);
    throw new Error('lost completion');
  });
  await expect(worker.step(id)).rejects.toThrow('lost completion');
  expect(await worker.step(id)).toBe(true);
  expect((await content(id))['Project 🌍/notes']).toBe('hello');
});
it('cancels and releases pinned content and temporary objects exactly once', async () => {
  const u = await upload('notes', 'hello');
  const id = await create();
  await worker.step(id);
  const refs = async () =>
    (await new Transaction(repo).get<StoredObject>('OBJECT', u.objectId))!.references;
  expect(await refs()).toBe(2);
  await worker.cancel('alice', id);
  for (let i = 0; i < 10 && !(await worker.cleanup(id)); i++) {
    /* bounded cleanup */
  }
  expect(await worker.cleanup(id)).toBe(true);
  expect(await refs()).toBe(1);
  expect([...storage.objects.keys()].filter((key) => key.startsWith('archives/'))).toEqual([]);
  expect([...storage.uploads.values()].filter((u) => u.key.startsWith('archives/'))).toEqual([]);
  await expect(worker.download('alice', id)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_READY' });
});
it('rejects corrupt source bytes and never publishes a partial archive', async () => {
  const u = await upload('notes', 'hello');
  storage.objects.set(u.objectKey, Buffer.from('wrong'));
  const id = await create();
  expect(await worker.step(id)).toBe(true);
  expect(await worker.status('alice', id)).toMatchObject({
    state: 'FAILED',
    error: expect.stringContaining('integrity'),
  });
  await expect(worker.download('alice', id)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_READY' });
});
it('authorizes downloads, rejects expired jobs and prevents overlapping workers', async () => {
  const id = await create();
  await expect(worker.status('bob', id)).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  await transact(repo, async (tx) => {
    const m = (await tx.get<Archive>(`ARCHIVE#${id}`, 'META'))!;
    m.lease = 'another-worker';
    m.leaseUntil = Date.now() + 100000;
    await tx.put(`ARCHIVE#${id}`, 'META', m);
  });
  expect(await worker.step(id)).toBe(false);
  await transact(repo, async (tx) => {
    const m = (await tx.get<Archive>(`ARCHIVE#${id}`, 'META'))!;
    m.expiresAt = '2000-01-01T00:00:00Z';
    m.leaseUntil = 0;
    await tx.put(`ARCHIVE#${id}`, 'META', m);
  });
  await expect(worker.download('alice', id)).rejects.toMatchObject({ code: 'DOWNLOAD_EXPIRED' });
});
it('writes ZIP64 sizes, offsets and entry counts beyond classic ZIP limits', () => {
  const header = zipCentralHeader(
    { path: 'large', size: 5 * 1024 ** 3, directory: false, modified: '2026-01-01' },
    123,
    6 * 1024 ** 3,
  );
  const view = new DataView(header.buffer);
  expect(view.getBigUint64(46 + 5 + 4, true)).toBe(5n * 1024n ** 3n);
  expect(view.getBigUint64(46 + 5 + 20, true)).toBe(6n * 1024n ** 3n);
  const end = new DataView(zipEnd(70000, 7 * 1024 ** 3, 1000).buffer);
  expect(end.getBigUint64(24, true)).toBe(70000n);
  expect(end.getBigUint64(48, true)).toBe(7n * 1024n ** 3n);
});

it('exposes authenticated creation, progress, single-download authorization and cancellation', async () => {
  const wake = vi.fn(async () => {});
  const { app } = createApp(service, new DevelopmentAuth(), [], wake);
  expect((await app.request('/v1/folder-downloads', { method: 'POST' })).status).toBe(401);
  const login = await app.request('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.test', password: 'Development-only-123!' }),
  });
  const session = await login.json();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
  };
  const request = {
    method: 'POST',
    headers,
    body: JSON.stringify({ driveItemId: folder, operationId: op() }),
  };
  const response = await app.request('/v1/folder-downloads', request);
  expect(response.status).toBe(200);
  const job = await response.json();
  expect(job).toMatchObject({ state: 'QUEUED', totalBytes: null });
  expect(wake).toHaveBeenCalledOnce();
  expect((await (await app.request('/v1/folder-downloads', request)).json()).id).toBe(job.id);
  await worker.step(job.id);
  const status = await app.request(`/v1/folder-downloads/${job.id}`, { headers });
  expect(await status.json()).toMatchObject({
    state: 'READY',
    downloadUrl: expect.any(String),
    sizeBytes: expect.any(Number),
  });
  const download = await app.request('/v1/downloads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ folderDownloadId: job.id }),
  });
  expect(download.status).toBe(200);
  expect(await download.json()).toMatchObject({ contentHashAlgorithm: 'SHA256' });
  expect(
    (await app.request(`/v1/folder-downloads/${job.id}`, { method: 'DELETE', headers })).status,
  ).toBe(200);
});
it('does not publish a ZIP after the initiating device is revoked', async () => {
  const id = await create();
  await service.revokeDevice('alice', 'browser');
  expect(await worker.step(id)).toBe(true);
  expect(await worker.status('alice', id)).toMatchObject({ state: 'FAILED' });
});
it('rejects a changed listing before pinning a mixed set of versions', async () => {
  const id = await create();
  await upload('new', 'changed');
  await worker.step(id);
  expect(await worker.status('alice', id)).toMatchObject({
    state: 'FAILED',
    error: expect.stringContaining('folder changed'),
  });
});
it('uses equal-size nonfinal multipart parts even when records cross a boundary', async () => {
  for (let i = 0; i < 15; i++) await upload(`file${i}`, 'x'.repeat(83));
  const parts: number[] = [];
  const write = storage.writePart.bind(storage);
  vi.spyOn(storage, 'writePart').mockImplementation(async (...args) => {
    parts.push(args[3].length);
    return write(...args);
  });
  const id = await create();
  await worker.step(id);
  await content(id);
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.slice(0, -1).every((size) => size === 1024)).toBe(true);
  expect(parts.at(-1)).toBeLessThanOrEqual(1024);
});
it('renames entries other systems cannot extract instead of failing the ZIP', async () => {
  await upload('a:b.txt', 'colon');
  await upload('a_b.txt', 'underscore');
  await upload('why?.txt', 'question');
  await upload('CON.txt', 'device');
  await upload('trailing.', 'dot');
  const id = await create();
  expect(await worker.step(id)).toBe(true);
  const entries = await content(id);
  // Which of the two "a_b.txt" names gets numbered depends on listing order.
  expect([entries['Project 🌍/a_b.txt'], entries['Project 🌍/a_b (2).txt']].sort()).toEqual([
    'colon',
    'underscore',
  ]);
  expect(entries).toMatchObject({
    'Project 🌍/why_.txt': 'question',
    'Project 🌍/_CON.txt': 'device',
    'Project 🌍/trailing_': 'dot',
  });
  expect(Object.keys(entries)).toHaveLength(6);
});
