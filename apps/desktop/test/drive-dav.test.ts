import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@harbor/api-client';
import {
  DriveDav,
  davSegments,
  parseRange,
  type DavDrive,
  type DavEntry,
  type DavUploadView,
} from '../src/drive-dav';

/** My Drive in memory; contents are plain bytes, as the API client hands them over decrypted. */
function memoryDrive() {
  const entries = new Map<string, DavEntry & { data?: Buffer }>();
  let next = 1;
  const add = (parentId: string | null, name: string, data?: Buffer) => {
    const id = `item-${next++}`;
    const now = new Date('2026-10-01T10:00:00Z').toISOString();
    const entry = {
      id,
      parentId,
      name,
      folder: !data,
      size: data?.length ?? 0,
      mimeType: 'application/octet-stream',
      created: now,
      modified: now,
      etag: `${id}-v1`,
      data,
    };
    entries.set(id, entry);
    return entry;
  };
  const calls: string[] = [];
  let locked = false;
  const drive: DavDrive = {
    async list(folderId) {
      calls.push(`list ${folderId}`);
      return [...entries.values()].filter((e) => e.parentId === folderId);
    },
    async open(file) {
      if (locked) throw new ApiError('E2EE_LOCKED', 'Unlock your files to continue.', 423);
      const data = entries.get(file.id)!.data!;
      return {
        size: data.length,
        read: async (begin, end) => new Uint8Array(data.subarray(begin, end)),
      };
    },
    async write(parentId, name, source, existing, modifiedAt) {
      const data = await readFile(source);
      calls.push(`write ${name}${existing ? ' over ' + existing.id : ''}`);
      const entry = existing ? entries.get(existing.id)! : add(parentId, name, data);
      Object.assign(entry, { data, size: data.length, etag: `${entry.id}-${Date.now()}` });
      if (modifiedAt) entry.modified = modifiedAt.toISOString();
      return entry;
    },
    async mkdir(parentId, name) {
      return add(parentId, name);
    },
    async move(entry, parentId, name) {
      calls.push(`move ${entry.id} ${parentId} ${name}`);
      Object.assign(entries.get(entry.id)!, { parentId, name });
    },
    async remove(entry) {
      calls.push(`remove ${entry.id}`);
      entries.delete(entry.id);
    },
  };
  return { drive, entries, add, calls, lock: (value: boolean) => (locked = value) };
}

let memory: ReturnType<typeof memoryDrive>;
let dav: DriveDav;
let base: string;
/** Where My Drive is served. */
let root: string;
const auth = 'Basic ' + Buffer.from('harbor0:secret').toString('base64');
const request = (pathname: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(root + pathname, { ...init, headers: { Authorization: auth, ...init.headers } });

beforeEach(async () => {
  memory = memoryDrive();
  const docs = memory.add(null, 'Docs');
  memory.add(docs.id, 'notes & plans.txt', Buffer.from('hello world'));
  dav = new DriveDav({
    drive: memory.drive,
    username: 'harbor0',
    password: 'secret',
    port: 0,
    tempDir: await mkdtemp(path.join(os.tmpdir(), 'drive-dav-')),
  });
  await dav.start();
  base = `http://127.0.0.1:${dav.port}`;
  root = base + '/harbor0';
});
afterEach(() => dav.stop());

describe('WebDAV server inside the app', () => {
  it('asks for the password and refuses other hostnames', async () => {
    const anonymous = await fetch(root + '/', { method: 'PROPFIND' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Basic/);
    const wrong = await fetch(root + '/', {
      method: 'PROPFIND',
      headers: { Authorization: 'Basic ' + Buffer.from('harbor0:nope').toString('base64') },
    });
    expect(wrong.status).toBe(401);
    // fetch won't send a Host header of our choosing, so ask node:http directly.
    const { request: raw } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) =>
      raw(
        {
          host: '127.0.0.1',
          port: dav.port,
          method: 'PROPFIND',
          path: '/',
          headers: { Host: 'evil.example:80', Authorization: auth },
        },
        (res) => resolve(res.statusCode!),
      )
        .on('error', reject)
        .end(),
    );
    expect(status).toBe(403);
  });

  it('lists folders with decoded names and file sizes', async () => {
    const top = await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
    expect(top.status).toBe(207);
    const xml = await top.text();
    expect(xml).toContain('<D:href>/harbor0/Docs/</D:href>');
    expect(xml).toContain('<D:collection/>');
    const docs = await (
      await request('/Docs/', { method: 'PROPFIND', headers: { Depth: '1' } })
    ).text();
    expect(docs).toContain('<D:href>/harbor0/Docs/notes%20%26%20plans.txt</D:href>');
    expect(docs).toContain('<D:displayname>notes &amp; plans.txt</D:displayname>');
    expect(docs).toContain('<D:getcontentlength>11</D:getcontentlength>');
    expect((await request('/Missing', { method: 'PROPFIND' })).status).toBe(404);
  });

  it('serves whole files and byte ranges, matching names without case', async () => {
    const whole = await request('/docs/NOTES%20%26%20plans.txt');
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('hello world');
    const part = await request('/Docs/notes%20%26%20plans.txt', { headers: { Range: 'bytes=6-' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 6-10/11');
    expect(await part.text()).toBe('world');
    const tail = await request('/Docs/notes%20%26%20plans.txt', { headers: { Range: 'bytes=-3' } });
    expect(await tail.text()).toBe('rld');
  });

  it('uploads new files and new versions, keeping the client’s modification time', async () => {
    const created = await request('/Docs/new.txt', {
      method: 'PUT',
      body: 'fresh',
      headers: { 'X-OC-Mtime': '1700000000' },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('x-oc-mtime')).toBe('accepted');
    await dav.settled();
    const replaced = await request('/Docs/new.txt', { method: 'PUT', body: 'fresher' });
    expect(replaced.status).toBe(204);
    await dav.settled();
    expect(memory.calls.filter((c) => c.startsWith('write'))).toEqual([
      'write new.txt',
      expect.stringMatching(/^write new\.txt over item-/),
    ]);
    expect(await (await request('/Docs/new.txt')).text()).toBe('fresher');
    expect((await request('/Nowhere/new.txt', { method: 'PUT', body: 'x' })).status).toBe(409);
  });

  it('keeps Finder’s metadata files in memory instead of uploading them', async () => {
    expect((await request('/Docs/._new.txt', { method: 'PUT', body: 'meta' })).status).toBe(201);
    expect((await request('/Docs/.DS_Store', { method: 'PUT', body: 'ds' })).status).toBe(201);
    expect(memory.calls.some((c) => c.startsWith('write'))).toBe(false);
    expect(await (await request('/Docs/._new.txt')).text()).toBe('meta');
    const listing = await (
      await request('/Docs/', { method: 'PROPFIND', headers: { Depth: '1' } })
    ).text();
    expect(listing).toContain('/harbor0/Docs/.DS_Store');
    expect((await request('/Docs/.DS_Store', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/Docs/.DS_Store')).status).toBe(404);
  });

  it('creates, renames, moves and deletes', async () => {
    expect((await request('/Archive', { method: 'MKCOL' })).status).toBe(201);
    expect((await request('/Archive', { method: 'MKCOL' })).status).toBe(405);
    const moved = await request('/Docs/notes%20%26%20plans.txt', {
      method: 'MOVE',
      headers: { Destination: root + '/Archive/plans.txt' },
    });
    expect(moved.status).toBe(201);
    expect(await (await request('/Archive/plans.txt')).text()).toBe('hello world');
    // A case-only rename is a move onto itself.
    const renamed = await request('/Archive/plans.txt', {
      method: 'MOVE',
      headers: { Destination: root + '/Archive/Plans.txt' },
    });
    expect(renamed.status).toBe(201);
    expect([...memory.entries.values()].some((e) => e.name === 'Plans.txt')).toBe(true);
    const intoItself = await request('/Archive', {
      method: 'MOVE',
      headers: { Destination: root + '/Archive/inner' },
    });
    expect(intoItself.status).toBe(403);
    expect((await request('/Archive/Plans.txt', { method: 'DELETE' })).status).toBe(204);
    expect((await request('/Archive/Plans.txt')).status).toBe(404);
  });

  it('respects Overwrite: F, and replaces the destination otherwise', async () => {
    await request('/Docs/other.txt', { method: 'PUT', body: 'other' });
    const refused = await request('/Docs/other.txt', {
      method: 'MOVE',
      headers: { Destination: root + '/Docs/notes%20%26%20plans.txt', Overwrite: 'F' },
    });
    expect(refused.status).toBe(412);
    const replaced = await request('/Docs/other.txt', {
      method: 'MOVE',
      headers: { Destination: root + '/Docs/notes%20%26%20plans.txt' },
    });
    expect(replaced.status).toBe(204);
    expect(await (await request('/Docs/notes%20%26%20plans.txt')).text()).toBe('other');
  });

  it('copies files and folders by reading and uploading them again', async () => {
    const copied = await request('/Docs', {
      method: 'COPY',
      headers: { Destination: root + '/Docs%20copy' },
    });
    expect(copied.status).toBe(201);
    expect(await (await request('/Docs%20copy/notes%20%26%20plans.txt')).text()).toBe(
      'hello world',
    );
    expect(await (await request('/Docs/notes%20%26%20plans.txt')).text()).toBe('hello world');
  });

  it('grants locks so Finder will write, and accepts property changes', async () => {
    const options = await request('/', { method: 'OPTIONS' });
    expect(options.headers.get('dav')).toBe('1, 2');
    const lock = await request('/Docs/new.txt', { method: 'LOCK', body: '<lockinfo/>' });
    expect(lock.status).toBe(200);
    expect(lock.headers.get('lock-token')).toMatch(/^<opaquelocktoken:/);
    expect(await lock.text()).toContain('<D:lockdiscovery>');
    expect((await request('/Docs/new.txt', { method: 'UNLOCK' })).status).toBe(204);
    const patch = await request('/Docs/notes%20%26%20plans.txt', {
      method: 'PROPPATCH',
      body: '<x/>',
    });
    expect(patch.status).toBe(207);
  });

  it('refuses changes when read-only', async () => {
    await dav.stop();
    dav = new DriveDav({
      drive: memory.drive,
      username: 'harbor0',
      password: 'secret',
      port: 0,
      readOnly: true,
      tempDir: os.tmpdir(),
    });
    await dav.start();
    base = `http://127.0.0.1:${dav.port}`;
    root = base + '/harbor0';
    expect((await request('/Docs/new.txt', { method: 'PUT', body: 'x' })).status).toBe(403);
    expect((await request('/Docs', { method: 'DELETE' })).status).toBe(403);
    expect(await (await request('/Docs/notes%20%26%20plans.txt')).text()).toBe('hello world');
  });

  it('uploads a file Finder or Explorer creates empty only once, with its content', async () => {
    expect((await request('/Docs/new.txt', { method: 'PUT', body: '' })).status).toBe(201);
    const listing = await (
      await request('/Docs/', { method: 'PROPFIND', headers: { Depth: '1' } })
    ).text();
    expect(listing).toContain('/harbor0/Docs/new.txt');
    expect((await request('/Docs/new.txt', { method: 'PUT', body: 'content' })).status).toBe(204);
    await dav.settled();
    expect(memory.calls.filter((c) => c.startsWith('write'))).toEqual(['write new.txt']);
    expect(await (await request('/Docs/new.txt')).text()).toBe('content');
  });

  it('keeps an empty file that is renamed before its content arrives, and uploads it in the end', async () => {
    await request('/Docs/untitled', { method: 'PUT', body: '' });
    const moved = await request('/Docs/untitled', {
      method: 'MOVE',
      headers: { Destination: root + '/Docs/empty.txt' },
    });
    expect(moved.status).toBe(201);
    expect((await request('/Docs/untitled')).status).toBe(404);
    expect(memory.calls.some((c) => c.startsWith('write'))).toBe(false);
    // Stopping the server keeps it as it was made: an empty file.
    await dav.stop();
    expect(memory.calls.filter((c) => c.startsWith('write'))).toEqual(['write empty.txt']);
    expect([...memory.entries.values()].find((e) => e.name === 'empty.txt')?.size).toBe(0);
  });

  it('lists only harbor0 at the top, to anyone who asks', async () => {
    const top = await fetch(base + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
    expect(top.status).toBe(207);
    const xml = await top.text();
    expect(xml).toContain('<D:href>/harbor0/</D:href>');
    expect(xml).not.toContain('Docs');
    expect((await fetch(base + '/', { method: 'OPTIONS' })).headers.get('dav')).toBe('1, 2');
    expect(
      (await fetch(base + '/Docs/', { method: 'PROPFIND', headers: { Authorization: auth } }))
        .status,
    ).toBe(404);
  });

  it('serves the mount path without a password, and only with the right secret', async () => {
    await dav.stop();
    dav = new DriveDav({
      drive: memory.drive,
      username: 'harbor0',
      password: 'secret',
      port: 0,
      mountSecret: 'k3y',
      tempDir: os.tmpdir(),
    });
    await dav.start();
    base = `http://127.0.0.1:${dav.port}`;
    const listing = await fetch(base + '/k3y/harbor0/Docs/', {
      method: 'PROPFIND',
      headers: { Depth: '1' },
    });
    expect(listing.status).toBe(207);
    expect(await listing.text()).toContain(
      '<D:href>/k3y/harbor0/Docs/notes%20%26%20plans.txt</D:href>',
    );
    expect((await fetch(base + '/k3y/harbor0/new.txt', { method: 'PUT', body: 'x' })).status).toBe(
      201,
    );
    expect((await fetch(base + '/nope/harbor0/Docs/', { method: 'PROPFIND' })).status).toBe(404);
    // A move can't leave the mount path for the password-protected one, or the other way round.
    const escape = await fetch(base + '/k3y/harbor0/new.txt', {
      method: 'MOVE',
      headers: { Destination: base + '/harbor0/moved.txt' },
    });
    expect(escape.status).toBe(400);
    const moved = await fetch(base + '/k3y/harbor0/new.txt', {
      method: 'MOVE',
      headers: { Destination: base + '/k3y/harbor0/moved.txt' },
    });
    expect(moved.status).toBe(201);
  });

  it('reports the account’s storage on My Drive', async () => {
    memory.drive.quota = async () => ({ usedBytes: 100, availableBytes: 900 });
    const xml = await (await request('/', { method: 'PROPFIND', headers: { Depth: '0' } })).text();
    expect(xml).toContain('<D:quota-available-bytes>900</D:quota-available-bytes>');
    expect(xml).toContain('<D:quota-used-bytes>100</D:quota-used-bytes>');
  });

  it('answers 503 while the account is locked', async () => {
    memory.lock(true);
    const response = await request('/Docs/notes%20%26%20plans.txt');
    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/Unlock/);
  });

  it('re-reads folders after forget()', async () => {
    await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
    memory.add(null, 'Elsewhere');
    expect(
      await (await request('/', { method: 'PROPFIND', headers: { Depth: '1' } })).text(),
    ).not.toContain('Elsewhere');
    dav.forget();
    expect(
      await (await request('/', { method: 'PROPFIND', headers: { Depth: '1' } })).text(),
    ).toContain('/harbor0/Elsewhere/');
  });
});

describe('WebDAV uploads in the background', () => {
  const listing = async (pathname: string) =>
    (await request(pathname, { method: 'PROPFIND', headers: { Depth: '1' } })).text();
  const writes = () => memory.calls.filter((c) => c.startsWith('write'));
  /** Holds uploads until released. */
  function holdWrites() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const write = memory.drive.write;
    memory.drive.write = async (...args) => {
      await gate;
      return write(...args);
    };
    return release;
  }
  async function restart(options: {
    uploadRetryMs?: number;
    onError?: (e: unknown) => void;
    onUploads?: (uploads: DavUploadView[]) => void;
  }) {
    await dav.stop();
    dav = new DriveDav({
      drive: memory.drive,
      username: 'harbor0',
      password: 'secret',
      port: 0,
      tempDir: await mkdtemp(path.join(os.tmpdir(), 'drive-dav-')),
      ...options,
    });
    await dav.start();
    base = `http://127.0.0.1:${dav.port}`;
    root = base + '/harbor0';
  }

  it('answers at once and serves the file while it goes up', async () => {
    const release = holdWrites();
    await listing('/Docs/');
    const put = await request('/Docs/report.pdf', { method: 'PUT', body: 'pdf bytes' });
    expect(put.status).toBe(201);
    expect(writes()).toEqual([]);
    const during = await listing('/Docs/');
    expect(during).toContain('/harbor0/Docs/report.pdf');
    expect(during).toContain('<D:getcontentlength>9</D:getcontentlength>');
    expect(await (await request('/Docs/report.pdf')).text()).toBe('pdf bytes');
    const range = await request('/Docs/report.pdf', { headers: { Range: 'bytes=4-' } });
    expect(await range.text()).toBe('bytes');
    const lists = memory.calls.filter((c) => c.startsWith('list')).length;
    release();
    await dav.settled();
    expect(writes()).toEqual(['write report.pdf']);
    // The upload goes into the listing held; the folder isn't read again.
    expect(await listing('/Docs/')).toContain('/harbor0/Docs/report.pdf');
    expect(await (await request('/Docs/report.pdf')).text()).toBe('pdf bytes');
    expect(memory.calls.filter((c) => c.startsWith('list')).length).toBe(lists);
  });

  it('uploads only the latest of versions saved before the first one starts', async () => {
    const release = holdWrites();
    await request('/Docs/a.txt', { method: 'PUT', body: 'one' });
    // The first is under way; the second waits, and the third replaces it.
    expect((await request('/Docs/a.txt', { method: 'PUT', body: 'two' })).status).toBe(204);
    expect((await request('/Docs/a.txt', { method: 'PUT', body: 'three' })).status).toBe(204);
    expect(await (await request('/Docs/a.txt')).text()).toBe('three');
    release();
    await dav.settled();
    expect(writes()).toEqual(['write a.txt', expect.stringMatching(/^write a\.txt over item-/)]);
    expect(await (await request('/Docs/a.txt')).text()).toBe('three');
  });

  it('deletes and moves a file once its upload is done', async () => {
    const release = holdWrites();
    await request('/Docs/gone.txt', { method: 'PUT', body: 'x' });
    await request('/Docs/moved.txt', { method: 'PUT', body: 'y' });
    const deleted = request('/Docs/gone.txt', { method: 'DELETE' });
    const moved = request('/Docs/moved.txt', {
      method: 'MOVE',
      headers: { Destination: root + '/kept.txt' },
    });
    release();
    expect((await deleted).status).toBe(204);
    expect((await moved).status).toBe(201);
    expect(memory.calls).toEqual(
      expect.arrayContaining(['write gone.txt', expect.stringMatching(/^remove item-/)]),
    );
    expect(await (await request('/kept.txt')).text()).toBe('y');
    expect((await request('/Docs/gone.txt')).status).toBe(404);
  });

  it('tries again after a failure that passes, and drops an upload the drive refuses', async () => {
    const errors: unknown[] = [];
    await restart({ uploadRetryMs: 1, onError: (e) => errors.push(e) });
    const write = memory.drive.write;
    let failures = 1;
    memory.drive.write = async (...args) => {
      if (args[1] === 'big.bin') throw new ApiError('STORAGE_FULL', 'Your storage is full.', 507);
      if (failures-- > 0) throw new ApiError('UNAVAILABLE', 'Try again.', 503);
      return write(...args);
    };
    await request('/Docs/flaky.txt', { method: 'PUT', body: 'ok' });
    await request('/Docs/big.bin', { method: 'PUT', body: 'too much' });
    await dav.settled();
    expect(await (await request('/Docs/flaky.txt')).text()).toBe('ok');
    expect((await request('/Docs/big.bin')).status).toBe(404);
    expect(errors.map((e) => (e as ApiError).status).sort()).toEqual([503, 507]);
  });

  it('finishes uploads before stopping', async () => {
    const release = holdWrites();
    await request('/Docs/last.txt', { method: 'PUT', body: 'z' });
    const stopped = dav.stop();
    release();
    await stopped;
    expect(writes()).toEqual(['write last.txt']);
  });

  it('reports uploads to the app, and each finished one with its stored id', async () => {
    const reports: DavUploadView[][] = [];
    await restart({ onUploads: (uploads) => reports.push(uploads) });
    const release = holdWrites();
    await request('/Docs/report.pdf', { method: 'PUT', body: 'pdf bytes' });
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0));
    expect(reports.at(-1)).toEqual([
      expect.objectContaining({ name: 'report.pdf', size: 9, loaded: 0 }),
    ]);
    expect(reports.at(-1)![0]!.done).toBeUndefined();
    release();
    await dav.settled();
    const stored = [...memory.entries.values()].find((e) => e.name === 'report.pdf')!;
    await vi.waitFor(() =>
      expect(reports.at(-1)).toEqual([
        expect.objectContaining({ id: stored.id, name: 'report.pdf', done: true }),
      ]),
    );
  });

  it('lists the app’s own uploads from where they are, until they land', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'app-upload-'));
    const source = path.join(folder, 'photo.jpg');
    await writeFile(source, 'jpeg bytes');
    const docs = [...memory.entries.values()].find((e) => e.name === 'Docs')!;
    await listing('/Docs/');
    dav.setAppUploads([{ parentId: docs.id, name: 'photo.jpg', size: 10, path: source }]);
    const during = await listing('/Docs/');
    expect(during).toContain('/harbor0/Docs/photo.jpg');
    expect(during).toContain('<D:getcontentlength>10</D:getcontentlength>');
    expect(await (await request('/Docs/photo.jpg')).text()).toBe('jpeg bytes');
    const refused = await request('/Docs/photo.jpg', { method: 'DELETE' });
    expect(refused.status).toBe(423);
    // It lands: the stored file is listed at once, without reading the folder again.
    const lists = memory.calls.filter((c) => c.startsWith('list')).length;
    const stored = memory.add(docs.id, 'photo.jpg', Buffer.from('jpeg bytes'));
    dav.landed(stored);
    expect(await listing('/Docs/')).toContain('/harbor0/Docs/photo.jpg');
    expect(await (await request('/Docs/photo.jpg', { method: 'DELETE' })).status).toBe(204);
    expect(memory.calls).toContain(`remove ${stored.id}`);
    expect(memory.calls.filter((c) => c.startsWith('list')).length).toBe(lists);
  });

  it('serves listings held while reading them again after refresh()', async () => {
    await listing('/');
    memory.add(null, 'Elsewhere');
    dav.refresh();
    expect(await listing('/')).not.toContain('Elsewhere');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await listing('/')).toContain('/harbor0/Elsewhere/');
  });
});

describe('WebDAV request parsing', () => {
  it('rejects paths that climb out', () => {
    expect(davSegments('/a/b%20c/')).toEqual(['a', 'b c']);
    expect(() => davSegments('/a/%2e%2e/b')).toThrow();
    expect(() => davSegments('/a%2Fb')).toThrow();
  });
  it('reads single byte ranges', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=8-', 10)).toEqual({ start: 8, end: 10 });
    expect(parseRange('bytes=-20', 10)).toEqual({ start: 0, end: 10 });
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(() => parseRange('bytes=10-', 10)).toThrow();
  });
});
