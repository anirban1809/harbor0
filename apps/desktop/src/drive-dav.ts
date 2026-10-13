import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '@harbor/api-client';
import { normalizeName } from '@harbor/contracts';

/**
 * A WebDAV server for My Drive that runs inside the app. Files are read and written through the
 * app's own API client, which on an end-to-end encrypted account decrypts and encrypts them with
 * the keys this computer holds, so nothing outside this computer sees plaintext. The server only
 * accepts connections from this computer.
 */

/** A file or folder as WebDAV clients see it. */
export type DavEntry = {
  id: string;
  parentId: string | null;
  name: string;
  folder: boolean;
  /** The original file's size. */
  size: number;
  mimeType: string;
  created: string;
  modified: string;
  /** Changes whenever the content does. */
  etag: string;
  /** Stored encrypted; reading it needs the account's keys. */
  encrypted?: boolean;
};
export type DavReader = { size: number; read(begin: number, end: number): Promise<Uint8Array> };
/** The drive behind the server; `null` is the top of My Drive. */
export interface DavDrive {
  list(folderId: string | null): Promise<DavEntry[]>;
  open(file: DavEntry): Promise<DavReader>;
  /** Uploads the file at `source` as `name`, as a new version of `existing` when given. */
  write(
    parentId: string | null,
    name: string,
    source: string,
    existing?: DavEntry,
    modifiedAt?: Date,
  ): Promise<DavEntry>;
  mkdir(parentId: string | null, name: string): Promise<DavEntry>;
  /** Moves and renames; an unchanged parent is a rename. */
  move(entry: DavEntry, parentId: string | null, name: string): Promise<void>;
  /** Moves to the trash. */
  remove(entry: DavEntry): Promise<void>;
  /** The account's storage, which Finder shows as the drive's capacity. */
  quota?(): Promise<{ usedBytes: number; availableBytes: number }>;
}
export type DriveDavOptions = {
  drive: DavDrive;
  username: string;
  password: string;
  port: number;
  /** Refuse changes. */
  readOnly?: boolean;
  /**
   * File Explorer won't send a password over plain HTTP, so it maps
   * `/<mountSecret>/harbor0/` instead, which needs none: the secret in the path stands in for it.
   */
  mountSecret?: string;
  /** Where uploads wait while they go up; emptied as each one finishes. */
  tempDir: string;
  onError?: (error: unknown) => void;
};

class DavError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const ROOT = null;
type Found = DavEntry | typeof ROOT;

// Finder and Explorer write these beside every file they touch; they are kept in memory only.
const isJunk = (name: string) =>
  name.startsWith('._') || ['.ds_store', 'thumbs.db', 'desktop.ini'].includes(name.toLowerCase());
/**
 * A file kept in memory: junk, or a new empty file. Finder and File Explorer create each file
 * empty and then write it again with its content, so the empty one waits here rather than
 * uploading twice. It goes up empty if nothing replaces it in time.
 */
type LocalFile = {
  name: string;
  data: Buffer;
  modified: string;
  pending?: { parentId: string | null; timer: NodeJS.Timeout };
};
const JUNK_MAX_BYTES = 1024 * 1024;
const EMPTY_FILE_WAIT_MS = 30_000;

const LISTING_TTL_MS = 10_000;
const READER_TTL_MS = 5 * 60_000;
const READ_CHUNK = 4 * 1024 * 1024;
const same = (a: string, b: string) => normalizeName(a) === normalizeName(b);
const folderKey = (id: string | null) => id ?? 'root';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
/**
 * My Drive is served at /harbor0/ rather than /, so Finder and File Explorer name the drive
 * harbor0. The top only lists it.
 */
export const DRIVE_SEGMENT = 'harbor0';
/** The path segments in front of My Drive for the request being answered. */
const requestBase = new AsyncLocalStorage<string[]>();
const hrefOf = (segments: string[], folder: boolean) => {
  const full = [...(requestBase.getStore() ?? []), ...segments];
  return '/' + full.map(encodeURIComponent).join('/') + (folder && full.length ? '/' : '');
};
const QUOTA_TTL_MS = 60_000;

/** Path segments of a request or Destination URL; throws on `..` and the like. */
export function davSegments(pathname: string) {
  const segments = pathname.split('/').filter(Boolean);
  return segments.map((raw) => {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      throw new DavError(400, 'Bad path.');
    }
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment))
      throw new DavError(400, 'Bad path.');
    return segment;
  });
}

/** One byte range of a file of `size` bytes, or null for the whole file; throws when unsatisfiable. */
export function parseRange(header: string | undefined, size: number) {
  const match = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges, or none we understand: answer with the whole file, as RFC 9110 allows.
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(size, Number(match[2]) + 1) : size;
  }
  if (start >= size || start >= end) throw new DavError(416, 'Range not satisfiable.');
  return { start, end };
}

export class DriveDav {
  private server?: Server;
  private folders = new Map<string, { at: number; entries: Promise<DavEntry[]> }>();
  private readers = new Map<string, { at: number; reader: Promise<DavReader> }>();
  private local = new Map<string, Map<string, LocalFile>>();
  private quota?: { at: number; value: Promise<{ usedBytes: number; availableBytes: number }> };
  constructor(private options: DriveDavOptions) {}

  get running() {
    return !!this.server?.listening;
  }
  /** The port it listens on, once started; port 0 picks a free one. */
  get port() {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  async start() {
    await this.stop();
    const server = createServer((req, res) => void this.handle(req, res));
    // Large uploads and downloads take as long as they take.
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === 'EADDRINUSE'
              ? `Port ${this.options.port} is already in use. Stop whatever is using it, or choose another port.`
              : `The WebDAV server couldn't start: ${error.message}`,
          ),
        ),
      );
      server.listen(this.options.port, '127.0.0.1', () => resolve());
    });
    this.server = server;
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    // Empty files still waiting for content stay as they were made.
    await Promise.all(
      [...this.local.values()].flatMap((files) =>
        [...files.keys()].map((key) => this.flushEmpty(files, key)),
      ),
    );
    this.forget();
    this.local.clear();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Forgets cached listings and open files, after a change made elsewhere. */
  forget() {
    this.folders.clear();
    this.readers.clear();
    this.quota = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      // A web page can't reach this server through a hostname of its own (DNS rebinding).
      const port = this.port;
      const host = req.headers.host?.toLowerCase();
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? ''))
        throw new DavError(403, 'This server only answers on 127.0.0.1.');
      const segments = davSegments(new URL(req.url ?? '/', 'http://localhost').pathname);
      const method = (req.method ?? 'GET').toUpperCase();
      const at = this.route(segments);
      // Clients look at the top before they sign in; it says nothing about the files.
      const probe = method === 'OPTIONS' || (method === 'PROPFIND' && !at.path);
      if (!at.secret && !probe && !this.authorized(req)) {
        res.setHeader('WWW-Authenticate', 'Basic realm="harbor0"');
        throw new DavError(401, 'Enter the username and password from harbor0 Settings.');
      }
      if (this.options.readOnly && ['PUT', 'MKCOL', 'DELETE', 'MOVE', 'COPY'].includes(method))
        throw new DavError(403, 'This WebDAV server is read-only.');
      if (method === 'OPTIONS')
        return this.end(res, 200, '', {
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
          Allow:
            'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK',
        });
      if (!at.path) return await requestBase.run(at.base, () => this.top(req, res, method));
      const path = at.path;
      await requestBase.run([...at.base, DRIVE_SEGMENT], async () => {
        switch (method) {
          case 'PROPFIND':
            return await this.propfind(req, res, path);
          case 'GET':
          case 'HEAD':
            return await this.get(req, res, path, method === 'HEAD');
          case 'PUT':
            return await this.put(req, res, path);
          case 'MKCOL':
            return await this.mkcol(req, res, path);
          case 'DELETE':
            return await this.delete(req, res, path);
          case 'MOVE':
          case 'COPY':
            return await this.transfer(req, res, path, method === 'MOVE');
          case 'LOCK':
            return await this.lock(req, res, path);
          case 'UNLOCK':
            await drain(req);
            return this.end(res, 204);
          case 'PROPPATCH':
            return await this.proppatch(req, res, path);
          default:
            throw new DavError(405, `${method} isn't supported.`);
        }
      });
    } catch (error) {
      this.fail(req, res, error);
    }
  }

  /**
   * Splits a request path into what comes before My Drive and the path inside it; `path` is
   * null for the top, above My Drive.
   */
  private route(segments: string[]) {
    const secret = !!this.options.mountSecret && segments[0] === this.options.mountSecret;
    const base = secret ? segments.slice(0, 1) : [];
    const rest = segments.slice(base.length);
    if (!rest.length) return { secret, base, path: null };
    if (!same(rest[0]!, DRIVE_SEGMENT)) throw new DavError(404, 'Not found.');
    return { secret, base, path: rest.slice(1) };
  }

  /** The top: a folder holding only My Drive, as harbor0. */
  private async top(req: IncomingMessage, res: ServerResponse, method: string) {
    await drain(req);
    if (method === 'GET' || method === 'HEAD') {
      const html = `<!doctype html><meta charset="utf-8"><title>harbor0</title><a href="${escape(hrefOf([DRIVE_SEGMENT], true))}">${DRIVE_SEGMENT}/</a>`;
      return this.end(res, 200, method === 'HEAD' ? '' : html, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }
    if (method !== 'PROPFIND') throw new DavError(403, `Open the ${DRIVE_SEGMENT} folder.`);
    const responses = [
      propResponse(hrefOf([], true), [
        `<D:displayname>${DRIVE_SEGMENT}</D:displayname>`,
        '<D:resourcetype><D:collection/></D:resourcetype>',
      ]),
    ];
    if (req.headers.depth !== '0')
      responses.push(
        propResponse(hrefOf([DRIVE_SEGMENT], true), [
          `<D:displayname>${DRIVE_SEGMENT}</D:displayname>`,
          '<D:resourcetype><D:collection/></D:resourcetype>',
        ]),
      );
    this.end(res, 207, multistatus(responses), {
      'Content-Type': 'application/xml; charset=utf-8',
    });
  }

  private usage() {
    if (!this.options.drive.quota) return undefined;
    if (!this.quota || Date.now() - this.quota.at > QUOTA_TTL_MS) {
      const value = this.options.drive.quota();
      this.quota = { at: Date.now(), value };
      value.catch(() => {
        if (this.quota?.value === value) this.quota = undefined;
      });
    }
    return this.quota.value.catch(() => undefined);
  }

  private authorized(req: IncomingMessage) {
    const match = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!match) return false;
    const given = Buffer.from(Buffer.from(match[1]!, 'base64').toString('utf8'));
    const expected = Buffer.from(`${this.options.username}:${this.options.password}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private fail(req: IncomingMessage, res: ServerResponse, error: unknown) {
    const [status, message] = failure(error);
    if (status >= 500) this.options.onError?.(error);
    // The body of a request that failed early would otherwise be read as the next request.
    req.resume();
    if (res.headersSent) return void res.destroy();
    this.end(res, status, message + '\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  private end(
    res: ServerResponse,
    status: number,
    body: string | Buffer = '',
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, { 'Content-Length': String(Buffer.byteLength(body)), ...headers });
    res.end(body);
  }

  // Listings and lookups

  private children(folderId: string | null) {
    const key = folderKey(folderId);
    const cached = this.folders.get(key);
    if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.entries;
    const entries = this.options.drive.list(folderId);
    this.folders.set(key, { at: Date.now(), entries });
    entries.catch(() => {
      if (this.folders.get(key)?.entries === entries) this.folders.delete(key);
    });
    return entries;
  }
  private changed(...folderIds: (string | null)[]) {
    for (const id of folderIds) this.folders.delete(folderKey(id));
  }

  /** The entry at a path: ROOT for the top, undefined when there is nothing there. */
  private async find(segments: string[]): Promise<Found | undefined> {
    let found = ROOT as Found;
    for (const name of segments) {
      if (found && !found.folder) return undefined;
      const child: DavEntry | undefined = (await this.children(found?.id ?? null)).find((e) =>
        same(e.name, name),
      );
      if (!child) return undefined;
      found = child;
    }
    return found;
  }
  /** The folder a new item at this path goes in; 409 when it doesn't exist. */
  private async parentOf(segments: string[]) {
    const parent = await this.find(segments.slice(0, -1));
    if (parent === undefined || (parent && !parent.folder))
      throw new DavError(409, 'The folder it goes in doesn’t exist.');
    return parent?.id ?? null;
  }
  private localIn(folderId: string | null) {
    const key = folderKey(folderId);
    if (!this.local.has(key)) this.local.set(key, new Map());
    return this.local.get(key)!;
  }
  /**
   * Where a file kept in memory is, or would be: for junk names, files already kept, or with
   * `any`, every name.
   */
  private async localAt(segments: string[], any = false) {
    const name = segments.at(-1);
    if (!name) return undefined;
    const parent = await this.find(segments.slice(0, -1));
    if (parent === undefined || (parent && !parent.folder)) return undefined;
    const parentId = parent?.id ?? null;
    const files = this.localIn(parentId);
    const key = normalizeName(name);
    if (!any && !isJunk(name) && !files.has(key)) return undefined;
    return { files, key, parentId, file: files.get(key) };
  }
  /** Keeps a new empty file in memory until its content arrives. */
  private holdEmpty(
    at: { files: Map<string, LocalFile>; key: string; parentId: string | null },
    name: string,
  ) {
    clearTimeout(at.files.get(at.key)?.pending?.timer);
    const timer = setTimeout(() => void this.flushEmpty(at.files, at.key), EMPTY_FILE_WAIT_MS);
    timer.unref();
    at.files.set(at.key, {
      name,
      data: Buffer.alloc(0),
      modified: new Date().toISOString(),
      pending: { parentId: at.parentId, timer },
    });
  }
  private dropLocal(files: Map<string, LocalFile>, key: string) {
    clearTimeout(files.get(key)?.pending?.timer);
    files.delete(key);
  }
  /** Uploads an empty file nothing replaced, unless a file of that name exists by now. */
  private async flushEmpty(files: Map<string, LocalFile>, key: string) {
    const file = files.get(key);
    if (!file?.pending) return;
    this.dropLocal(files, key);
    const { parentId } = file.pending;
    const temp = path.join(this.options.tempDir, randomUUID());
    try {
      if ((await this.children(parentId)).some((e) => same(e.name, file.name))) return;
      await mkdir(this.options.tempDir, { recursive: true, mode: 0o700 });
      await writeFile(temp, new Uint8Array(), { mode: 0o600 });
      await this.options.drive.write(parentId, file.name, temp);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      await rm(temp, { force: true });
      this.changed(parentId);
    }
  }

  // Methods

  private async propfind(req: IncomingMessage, res: ServerResponse, segments: string[]) {
    await drain(req);
    const depth = req.headers.depth === '0' ? 0 : 1;
    const junk = await this.localAt(segments);
    const responses: string[] = [];
    if (junk?.file) responses.push(junkProps(segments, junk.file));
    else {
      const found = await this.find(segments);
      if (found === undefined) throw new DavError(404, 'Not found.');
      responses.push(props(segments, found, found ? undefined : await this.usage()));
      if (depth === 1 && (!found || found.folder)) {
        for (const child of await this.children(found?.id ?? null))
          responses.push(props([...segments, child.name], child));
        for (const file of this.localIn(found?.id ?? null).values())
          responses.push(junkProps([...segments, file.name], file));
      }
    }
    this.end(res, 207, multistatus(responses), {
      'Content-Type': 'application/xml; charset=utf-8',
    });
  }

  private async get(req: IncomingMessage, res: ServerResponse, segments: string[], head: boolean) {
    const junk = await this.localAt(segments);
    if (junk?.file)
      return this.end(res, 200, head ? '' : junk.file.data, {
        'Content-Type': 'application/octet-stream',
        ...(head ? { 'Content-Length': String(junk.file.data.length) } : {}),
      });
    const found = await this.find(segments);
    if (found === undefined) throw new DavError(404, 'Not found.');
    if (!found || found.folder) {
      const items = await this.children(found?.id ?? null);
      const html = `<!doctype html><meta charset="utf-8"><title>harbor0</title><ul>${items
        .map(
          (i) =>
            `<li><a href="${escape(hrefOf([...segments, i.name], i.folder))}">${escape(i.name)}${i.folder ? '/' : ''}</a></li>`,
        )
        .join('')}</ul>`;
      return this.end(res, 200, head ? '' : html, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const range = parseRange(req.headers.range, found.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? found.size;
    const headers: Record<string, string> = {
      'Content-Type': found.mimeType,
      'Content-Length': String(end - start),
      'Accept-Ranges': 'bytes',
      ETag: `"${found.etag}"`,
      'Last-Modified': new Date(found.modified).toUTCString(),
      ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${found.size}` } : {}),
    };
    if (head || end === start) {
      res.writeHead(range ? 206 : 200, headers);
      return void res.end();
    }
    const reader = await this.reader(found);
    // The first chunk is read before answering, so a file that can't be read gets an error.
    let next: Promise<Uint8Array> = reader.read(start, Math.min(end, start + READ_CHUNK));
    await next;
    res.writeHead(range ? 206 : 200, headers);
    for (let at = start; at < end; at += READ_CHUNK) {
      const bytes = await next;
      const following = at + READ_CHUNK;
      if (following < end) next = reader.read(following, Math.min(end, following + READ_CHUNK));
      if (res.destroyed) {
        // The client went away; nothing waits for the chunk already being read.
        next.catch(() => {});
        return;
      }
      if (!res.write(bytes)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
    }
    res.end();
  }
  private reader(file: DavEntry) {
    const key = `${file.id}:${file.etag}`;
    const now = Date.now();
    for (const [k, v] of this.readers) if (now - v.at > READER_TTL_MS) this.readers.delete(k);
    const cached = this.readers.get(key);
    if (cached) return cached.reader;
    const reader = this.options.drive.open(file);
    this.readers.set(key, { at: now, reader });
    reader.catch(() => this.readers.delete(key));
    return reader;
  }

  private async put(req: IncomingMessage, res: ServerResponse, segments: string[]) {
    const name = segments.at(-1);
    if (!name) throw new DavError(405, 'Choose a file name.');
    const parentId = await this.parentOf(segments);
    const local = (await this.localAt(segments, true))!;
    if (isJunk(name)) {
      const data = await readBody(req, JUNK_MAX_BYTES);
      local.files.set(local.key, { name, data, modified: new Date().toISOString() });
      return this.end(res, local.file ? 204 : 201);
    }
    const existing = (await this.children(parentId)).find((e) => same(e.name, name));
    if (existing?.folder) throw new DavError(405, 'A folder has that name.');
    const modifiedAt = mtime(req.headers['x-oc-mtime']);
    await mkdir(this.options.tempDir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.options.tempDir, randomUUID());
    const replaced = !!existing || !!local.file;
    try {
      await pipeline(req, createWriteStream(temp, { mode: 0o600 }));
      if (!existing && (await stat(temp)).size === 0) this.holdEmpty(local, name);
      else {
        this.dropLocal(local.files, local.key);
        await this.options.drive.write(parentId, name, temp, existing, modifiedAt);
      }
    } finally {
      await rm(temp, { force: true });
      this.changed(parentId);
    }
    this.end(res, replaced ? 204 : 201, '', modifiedAt ? { 'X-OC-MTime': 'accepted' } : {});
  }

  private async mkcol(req: IncomingMessage, res: ServerResponse, segments: string[]) {
    await drain(req);
    const name = segments.at(-1);
    if (!name) throw new DavError(405, 'My Drive already exists.');
    const parentId = await this.parentOf(segments);
    if ((await this.children(parentId)).some((e) => same(e.name, name)))
      throw new DavError(405, 'Something already has that name.');
    try {
      await this.options.drive.mkdir(parentId, name);
    } finally {
      this.changed(parentId);
    }
    this.end(res, 201);
  }

  private async delete(req: IncomingMessage, res: ServerResponse, segments: string[]) {
    await drain(req);
    if (!segments.length) throw new DavError(403, 'My Drive can’t be deleted.');
    const junk = await this.localAt(segments);
    if (junk?.file) {
      this.dropLocal(junk.files, junk.key);
      return this.end(res, 204);
    }
    const found = await this.find(segments);
    if (!found) throw new DavError(404, 'Not found.');
    try {
      await this.options.drive.remove(found);
    } finally {
      // What was inside a folder is gone too.
      if (found.folder) this.forget();
      else this.changed(found.parentId);
    }
    this.end(res, 204);
  }

  private async transfer(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
    move: boolean,
  ) {
    await drain(req);
    let target: string[] | null = null;
    try {
      const to = this.route(davSegments(new URL(header(req, 'destination') ?? '').pathname));
      // The destination must be reached the same way, with the same secret or none.
      if (to.base.join('/') === requestBase.getStore()!.slice(0, -1).join('/')) target = to.path;
    } catch {
      /* Reported below. */
    }
    if (!target) throw new DavError(400, 'The Destination header is missing or invalid.');
    const name = target.at(-1);
    if (!segments.length || !name) throw new DavError(403, 'My Drive can’t be moved or copied.');
    const sameItem =
      target.length === segments.length && target.every((s, i) => same(s, segments[i]!));
    if (target.length > segments.length && segments.every((s, i) => same(s, target[i]!)))
      throw new DavError(403, 'A folder can’t go inside itself.');
    const local = await this.localAt(segments);
    if (local?.file?.pending) {
      // A new empty file: it moves in memory, unless it would replace a stored file.
      const parentId = await this.parentOf(target);
      if ((await this.children(parentId)).some((e) => same(e.name, name)))
        await this.flushEmpty(local.files, local.key);
      else {
        const to = (await this.localAt(target, true))!;
        if (to.file && header(req, 'overwrite')?.toUpperCase() === 'F')
          throw new DavError(412, 'Something already has that name.');
        if (move) this.dropLocal(local.files, local.key);
        this.holdEmpty(to, name);
        return this.end(res, to.file && !sameItem ? 204 : 201);
      }
    } else if (local?.file) {
      const to = await this.localAt(target);
      if (!to) throw new DavError(403, 'That file can only be kept under a name like it.');
      to.files.set(to.key, { ...local.file, name });
      if (move && !sameItem) local.files.delete(local.key);
      return this.end(res, to.file ? 204 : 201);
    }
    const source = await this.find(segments);
    if (!source) throw new DavError(404, 'Not found.');
    // Moving onto itself only changes the name's case; anything else onto itself is an error.
    if (sameItem && (!move || source.name === name))
      throw new DavError(403, 'The source and destination are the same.');
    const parentId = await this.parentOf(target);
    const existing = sameItem
      ? undefined
      : (await this.children(parentId)).find((e) => same(e.name, name));
    if (existing && header(req, 'overwrite')?.toUpperCase() === 'F')
      throw new DavError(412, 'Something already has that name.');
    const from = source.parentId;
    try {
      if (existing) await this.options.drive.remove(existing);
      if (move) await this.options.drive.move(source, parentId, name);
      else await this.copy(source, parentId, name, req.headers.depth !== '0');
    } finally {
      if (source.folder || existing?.folder) this.forget();
      else this.changed(from, parentId);
    }
    this.end(res, existing ? 204 : 201);
  }
  /** Copies by reading and uploading again: encrypted files are sealed afresh. */
  private async copy(source: DavEntry, parentId: string | null, name: string, deep: boolean) {
    const drive = this.options.drive;
    if (source.folder) {
      const folder = await drive.mkdir(parentId, name);
      if (deep)
        for (const child of await drive.list(source.id))
          await this.copy(child, folder.id, child.name, true);
      return;
    }
    await mkdir(this.options.tempDir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.options.tempDir, randomUUID());
    try {
      const reader = await drive.open(source);
      await writeFile(temp, new Uint8Array(), { mode: 0o600 });
      const out = createWriteStream(temp, { flags: 'a' });
      try {
        for (let at = 0; at < reader.size; at += READ_CHUNK)
          if (!out.write(await reader.read(at, Math.min(reader.size, at + READ_CHUNK))))
            await once(out, 'drain');
      } finally {
        out.end();
        await once(out, 'close');
      }
      await drive.write(parentId, name, temp, undefined, new Date(source.modified));
    } finally {
      await rm(temp, { force: true });
    }
  }

  // Clients such as Finder only write to a server that grants locks. One person on one computer
  // uses this server, so the locks are granted but not enforced.
  private async lock(req: IncomingMessage, res: ServerResponse, segments: string[]) {
    await drain(req);
    const refreshed = /<(opaquelocktoken:[^>]+)>/.exec(header(req, 'if') ?? '')?.[1];
    const token = refreshed ?? `opaquelocktoken:${randomUUID()}`;
    const found = await this.find(segments);
    const body =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
      '<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>' +
      `<D:depth>${req.headers.depth === '0' ? '0' : 'infinity'}</D:depth>` +
      '<D:timeout>Second-3600</D:timeout>' +
      `<D:locktoken><D:href>${escape(token)}</D:href></D:locktoken>` +
      `<D:lockroot><D:href>${escape(hrefOf(segments, found !== undefined && (!found || found.folder)))}</D:href></D:lockroot>` +
      '</D:activelock></D:lockdiscovery></D:prop>';
    this.end(res, 200, body, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${token}>`,
    });
  }

  // Properties such as Windows file attributes are accepted and not kept.
  private async proppatch(req: IncomingMessage, res: ServerResponse, segments: string[]) {
    await drain(req);
    const junk = await this.localAt(segments);
    const found = junk?.file ? undefined : await this.find(segments);
    if (!junk?.file && found === undefined) throw new DavError(404, 'Not found.');
    const href = hrefOf(segments, !junk?.file && (!found || found.folder));
    this.end(
      res,
      207,
      multistatus([
        `<D:response><D:href>${escape(href)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
      ]),
      { 'Content-Type': 'application/xml; charset=utf-8' },
    );
  }
}

function failure(error: unknown): [number, string] {
  if (error instanceof DavError) return [error.status, error.message];
  if (error instanceof ApiError) {
    if (error.code === 'E2EE_LOCKED')
      return [503, 'Unlock your encrypted files in the harbor0 app, then try again.'];
    if (error.status === 507 || /QUOTA|STORAGE_FULL/.test(error.code)) return [507, error.message];
    // The app's own session; the WebDAV client's password was fine.
    if (error.status === 401) return [503, 'Sign in to the harbor0 app again.'];
    if ([400, 403, 404, 409, 412, 413, 423].includes(error.status))
      return [error.status, error.message];
    return [502, error.message];
  }
  return [500, 'Something went wrong in the harbor0 app.'];
}

function multistatus(responses: string[]) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
}
const SUPPORTED_LOCK =
  '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';
function props(
  segments: string[],
  found: Found,
  quota?: { usedBytes: number; availableBytes: number },
) {
  const folder = !found || found.folder;
  const fields = [
    `<D:displayname>${escape(found?.name ?? DRIVE_SEGMENT)}</D:displayname>`,
    folder ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    SUPPORTED_LOCK,
  ];
  if (quota)
    fields.push(
      `<D:quota-used-bytes>${quota.usedBytes}</D:quota-used-bytes>`,
      `<D:quota-available-bytes>${Math.max(0, quota.availableBytes)}</D:quota-available-bytes>`,
    );
  if (found) {
    fields.push(
      `<D:creationdate>${new Date(found.created).toISOString()}</D:creationdate>`,
      `<D:getlastmodified>${new Date(found.modified).toUTCString()}</D:getlastmodified>`,
    );
    if (!found.folder)
      fields.push(
        `<D:getcontentlength>${found.size}</D:getcontentlength>`,
        `<D:getcontenttype>${escape(found.mimeType)}</D:getcontenttype>`,
        `<D:getetag>"${escape(found.etag)}"</D:getetag>`,
      );
  }
  return propResponse(hrefOf(segments, folder), fields);
}
function junkProps(segments: string[], file: LocalFile) {
  return propResponse(hrefOf(segments, false), [
    `<D:displayname>${escape(file.name)}</D:displayname>`,
    '<D:resourcetype/>',
    SUPPORTED_LOCK,
    `<D:getcontentlength>${file.data.length}</D:getcontentlength>`,
    `<D:getlastmodified>${new Date(file.modified).toUTCString()}</D:getlastmodified>`,
    '<D:getcontenttype>application/octet-stream</D:getcontenttype>',
  ]);
}
const propResponse = (href: string, fields: string[]) =>
  `<D:response><D:href>${escape(href)}</D:href><D:propstat><D:prop>${fields.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;

/** `X-OC-Mtime`, which rclone and ownCloud clients send with uploads: seconds since 1970. */
function mtime(header: string | string[] | undefined) {
  const seconds = Number(Array.isArray(header) ? header[0] : header);
  return header !== undefined && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000)
    : undefined;
}
const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
/** Request bodies this server ignores, read so the connection can be reused. */
async function drain(req: IncomingMessage) {
  await readBody(req, JUNK_MAX_BYTES);
}
async function readBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new DavError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
