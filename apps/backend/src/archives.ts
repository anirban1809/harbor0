import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createSHA256 } from 'hash-wasm';
import { filename, type FileVersion, type CompletedPart } from '@harbor/contracts';
import { StorageService, userPK } from './domain';
import { Transaction, transact } from './repository';
import { assert, DomainError } from './errors';
import {
  zipLocalHeader,
  zipDescriptor,
  zipCentralHeader,
  zipEnd,
  type ZipEntry,
} from './zip-format';

const now = () => new Date().toISOString();
const pk = (id: string) => `ARCHIVE#${id}`;
const entryKey = (index: number) => `ENTRY#${String(index).padStart(12, '0')}`;
const PART_BYTES = 16 * 1024 * 1024;
const LEASE_MS = 300_000;
type State =
  'QUEUED' | 'LISTING' | 'BUILDING' | 'FINALIZING' | 'READY' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
type Entry = ZipEntry & {
  objectId?: string;
  key?: string;
  hash?: string;
  crc?: number;
  offset?: number;
};
type Work = { id: string; path: string; cursor?: string };
export type Archive = {
  id: string;
  userId: string;
  owner: string;
  deviceId: string;
  folderId: string;
  name: string;
  state: State;
  createdAt: string;
  expiresAt: string;
  sourceSequence: number;
  totalFiles: number;
  totalBytes: number;
  files: number;
  bytes: number;
  entries: number;
  currentFile: string | null;
  error?: string;
  failures: number;
  key: string;
  uploadId?: string;
  part: number;
  position: number;
  index: number;
  fileOffset: number;
  crc: number;
  fileHash?: string;
  localOffset: number;
  headerWritten: boolean;
  archiveHash?: string;
  contentHash?: string;
  directoryOffset?: number;
  directoryIndex: number;
  pendingKey?: string;
  pendingSize: number;
  lease?: string;
  leaseUntil?: number;
};
const active = (state: State) => ['QUEUED', 'LISTING', 'BUILDING', 'FINALIZING'].includes(state);
// Characters Windows or macOS refuse in filenames, and names Windows keeps for devices.
const ILLEGAL = /[<>:"|?*]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** A name every OS can extract. Names that are paths themselves are refused, never rewritten. */
export const zipName = (name: string) => {
  assert(
    filename.safeParse(name).success,
    'UNSAFE_FILENAME',
    `Cannot archive this filename: ${name}`,
  );
  // Windows drops trailing dots and spaces, which could merge two names.
  const safe = name.replace(ILLEGAL, '_').replace(/[. ]+$/, (end) => '_'.repeat(end.length));
  return RESERVED.test(safe) ? `_${safe}` : safe;
};
/** Claims `name` within one ZIP folder, numbering it like "a (2).txt" if another entry has it. */
async function uniqueName(
  tx: Transaction,
  archiveId: string,
  folderId: string,
  name: string,
  directory: boolean,
) {
  const dot = directory ? -1 : name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${extension}`;
    const key = `NAME#${folderId}#${candidate.toLowerCase()}`;
    if (await tx.get(pk(archiveId), key)) continue;
    await tx.put(pk(archiveId), key, { name: candidate });
    return candidate;
  }
}

export class ArchiveWorkflows {
  constructor(
    private service: StorageService,
    private partBytes = PART_BYTES,
  ) {}

  async create(userId: string, deviceId: string, folderId: string, operationId: string) {
    const s = this.service;
    return s.operation(userId, operationId, { action: 'archive', folderId }, async (tx) => {
      const { item, owner } = await s.authorized(tx, userId, folderId);
      assert(item.type === 'FOLDER', 'VALIDATION_ERROR', 'Choose a folder to download.');
      const id = randomUUID();
      const root = zipName(item.name);
      const archive: Archive = {
        id,
        userId,
        deviceId,
        folderId,
        owner,
        name: root + '.zip',
        state: 'QUEUED',
        createdAt: now(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        sourceSequence: (await s.account(tx, owner)).sequence,
        totalFiles: 0,
        totalBytes: 0,
        files: 0,
        bytes: 0,
        entries: 1,
        currentFile: null,
        failures: 0,
        key: `archives/${id}/download.zip`,
        part: 1,
        position: 0,
        index: 0,
        fileOffset: 0,
        crc: 0,
        localOffset: 0,
        headerWritten: false,
        directoryIndex: 0,
        pendingSize: 0,
      };
      await tx.put(pk(id), 'META', archive);
      await tx.put(pk(id), entryKey(0), {
        path: root,
        size: 0,
        directory: true,
        modified: item.updatedAt,
      } satisfies Entry);
      await tx.put(pk(id), `WORK#${folderId}`, { id: folderId, path: root } satisfies Work);
      await s.job(tx, {
        id: `archive-${id}`,
        type: 'ARCHIVE_BUILD',
        entityId: id,
        dueAt: now(),
        attempts: 0,
      });
      await s.job(tx, {
        id: `archive-expire-${id}`,
        type: 'ARCHIVE_EXPIRE',
        entityId: id,
        dueAt: archive.expiresAt,
        attempts: 0,
      });
      return { id };
    });
  }

  async get(userId: string, id: string) {
    const archive = await new Transaction(this.service.repo).get<Archive>(pk(id), 'META');
    assert(
      archive && archive.userId === userId,
      'ITEM_NOT_FOUND',
      'ZIP download was not found.',
      404,
    );
    return archive;
  }

  async status(userId: string, id: string) {
    const m = await this.get(userId, id);
    const state = m.expiresAt <= now() ? 'EXPIRED' : m.state;
    let download: { downloadUrl: string; sizeBytes: number; contentHash: string } | undefined;
    if (state === 'READY') download = await this.download(userId, id);
    return {
      id,
      name: m.name,
      state,
      files: m.files,
      bytes: m.bytes,
      totalFiles: m.totalFiles,
      totalBytes: ['QUEUED', 'LISTING'].includes(state) ? null : m.totalBytes,
      currentFile: m.currentFile,
      error: m.error ?? null,
      expiresAt: m.expiresAt,
      ...(download ?? {}),
    };
  }

  async download(userId: string, id: string) {
    const s = this.service;
    const m = await this.get(userId, id);
    assert(
      m.expiresAt > now(),
      'DOWNLOAD_EXPIRED',
      'This ZIP expired. Download the folder again.',
      410,
    );
    assert(m.state === 'READY', 'DOWNLOAD_NOT_READY', 'The ZIP is not ready to download.', 409);
    await s.authorized(new Transaction(s.repo), userId, m.folderId);
    return {
      downloadUrl: await s.storage.download(m.key, m.name),
      sizeBytes: m.position,
      contentHash: m.contentHash!,
      contentHashAlgorithm: 'SHA256' as const,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async cancel(userId: string, id: string) {
    await this.get(userId, id);
    await transact(this.service.repo, async (tx) => {
      const m = (await tx.get<Archive>(pk(id), 'META'))!;
      if (m.state === 'EXPIRED') return;
      m.state = 'CANCELLED';
      await tx.put(pk(id), 'META', m);
      await this.service.job(tx, {
        id: `archive-expire-${id}`,
        type: 'ARCHIVE_EXPIRE',
        entityId: id,
        dueAt: now(),
        attempts: 0,
      });
    });
    return { cancelled: true };
  }

  private async authorize(m: Archive) {
    const s = this.service;
    assert(
      m.expiresAt > now(),
      'DOWNLOAD_EXPIRED',
      'The ZIP preparation expired. Please try again.',
      410,
    );
    await s.checkDevice(m.userId, m.deviceId);
    await s.authorized(new Transaction(s.repo), m.userId, m.folderId);
  }

  // A lease prevents overlapping scheduled Lambdas from preparing the same ZIP.
  // All output checkpoints reference immutable storage bytes and complete parts.
  async step(id: string, deadline = Date.now() + 120_000) {
    const s = this.service;
    const lease = randomUUID();
    let m = await transact(s.repo, async (tx) => {
      const value = await tx.get<Archive>(pk(id), 'META');
      if (!value || !active(value.state)) return undefined;
      if ((value.leaseUntil ?? 0) > Date.now()) return undefined;
      value.lease = lease;
      value.leaseUntil = Date.now() + LEASE_MS;
      await tx.put(pk(id), 'META', value);
      return value;
    });
    if (!m) {
      const current = await new Transaction(s.repo).get<Archive>(pk(id), 'META');
      return !current || !active(current.state);
    }
    try {
      await this.authorize(m);
      while (['QUEUED', 'LISTING'].includes(m.state) && Date.now() < deadline) {
        await this.listPage(m, lease);
        m = (await new Transaction(s.repo).get<Archive>(pk(id), 'META'))!;
      }
      if (!active(m.state)) return true;
      if (m.state !== 'QUEUED' && m.state !== 'LISTING' && Date.now() < deadline)
        await this.write(m, lease, deadline);
      return (await new Transaction(s.repo).get<Archive>(pk(id), 'META'))?.state === 'READY';
    } catch (error) {
      let terminal = false;
      await transact(s.repo, async (tx) => {
        const current = await tx.get<Archive>(pk(id), 'META');
        if (!current || current.lease !== lease || !active(current.state)) {
          terminal = true;
          return;
        }
        current.failures++;
        if (error instanceof DomainError || current.failures >= 3) {
          current.state = 'FAILED';
          current.error =
            error instanceof DomainError
              ? error.message
              : 'ZIP preparation failed. Please try again.';
          terminal = true;
          await s.job(tx, {
            id: `archive-expire-${id}`,
            type: 'ARCHIVE_EXPIRE',
            entityId: id,
            dueAt: now(),
            attempts: 0,
          });
        }
        await tx.put(pk(id), 'META', current);
      });
      if (!terminal) throw error;
      return true;
    } finally {
      await transact(s.repo, async (tx) => {
        const current = await tx.get<Archive>(pk(id), 'META');
        if (current?.lease === lease) {
          delete current.lease;
          delete current.leaseUntil;
          await tx.put(pk(id), 'META', current);
        }
      });
    }
  }

  private async listPage(snapshot: Archive, lease: string) {
    const s = this.service;
    const workPage = await s.repo.query(pk(snapshot.id), 'WORK#', 1);
    const row = workPage.rows[0];
    const work = row?.data as Work | undefined;
    const page = work ? await s.sharedList(snapshot.userId, work.id, 10, work.cursor) : null;
    await transact(s.repo, async (tx) => {
      const m = (await tx.get<Archive>(pk(snapshot.id), 'META'))!;
      assert(
        m.lease === lease && active(m.state),
        'DOWNLOAD_CANCELLED',
        'ZIP preparation was cancelled.',
        409,
      );
      assert(
        (await s.account(tx, m.owner)).sequence === m.sourceSequence,
        'REVISION_CONFLICT',
        'The folder changed while listing its files. Please try again.',
        409,
      );
      if (!work || !page) {
        m.state = 'BUILDING';
        await tx.put(pk(m.id), 'META', m);
        return;
      }
      m.state = 'LISTING';
      for (const item of page.items) {
        const directory = item.type === 'FOLDER';
        const name = await uniqueName(tx, m.id, work.id, zipName(item.name), directory);
        const entry: Entry = {
          path: work.path + '/' + name,
          size: 0,
          directory,
          modified: item.updatedAt,
        };
        if (entry.directory)
          await tx.put(pk(m.id), `WORK#${item.id}`, {
            id: item.id,
            path: entry.path,
          } satisfies Work);
        else {
          const version = await tx.get<FileVersion>(
            userPK(m.owner),
            `VERSION#${item.id}#${item.currentVersionId}`,
          );
          assert(version, 'ITEM_NOT_FOUND', 'File content is unavailable.', 404);
          const object = await s.reference(tx, version.storageObjectId, 1);
          Object.assign(entry, {
            size: version.sizeBytes,
            objectId: object.id,
            key: object.key,
            hash: version.contentHash,
          });
          m.totalFiles++;
          m.totalBytes += entry.size;
        }
        await tx.put(pk(m.id), entryKey(m.entries++), entry);
      }
      if (page.nextCursor) await tx.put(pk(m.id), row.sk, { ...work, cursor: page.nextCursor });
      else await tx.delete(pk(m.id), row.sk);
      await tx.put(pk(m.id), 'META', m);
    });
  }

  private async write(m: Archive, lease: string, deadline: number) {
    const s = this.service;
    const buffer = new Uint8Array(this.partBytes + 65536 + 128);
    let used = m.pendingSize;
    if (m.pendingKey) buffer.set(await s.storage.readRange(m.pendingKey, 0, used));
    const archiveHash = await createSHA256();
    archiveHash.init();
    if (m.archiveHash) archiveHash.load(Buffer.from(m.archiveHash, 'base64'));
    const fileHash = await createSHA256();
    fileHash.init();
    if (m.fileHash) fileHash.load(Buffer.from(m.fileHash, 'base64'));
    const digest = async (hash: typeof fileHash) => {
      const copy = await createSHA256();
      copy.load(hash.save());
      return copy.digest();
    };
    const save = async (part?: CompletedPart) => {
      await this.authorize(m);
      m.archiveHash = Buffer.from(archiveHash.save()).toString('base64');
      m.fileHash = Buffer.from(fileHash.save()).toString('base64');
      await transact(s.repo, async (tx) => {
        const current = await tx.get<Archive>(pk(m.id), 'META');
        assert(
          current?.lease === lease && active(current.state),
          'DOWNLOAD_CANCELLED',
          'ZIP preparation was cancelled.',
          409,
        );
        m.leaseUntil = Date.now() + LEASE_MS;
        await tx.put(pk(m.id), 'META', m);
        if (part) await tx.put(pk(m.id), `PART#${String(part.partNumber).padStart(5, '0')}`, part);
      });
    };
    if (!m.uploadId) {
      m.uploadId = await s.storage.create(m.key);
      await save();
    }
    const flush = async () => {
      if (!used) return;
      assert(
        m.part <= 10000,
        'ARCHIVE_TOO_LARGE',
        'This folder exceeds the storage provider’s ZIP size limit.',
      );
      const length = Math.min(used, this.partBytes);
      const part = await s.storage.writePart(
        m.key,
        m.uploadId!,
        m.part,
        buffer.subarray(0, length),
      );
      const prior = m.pendingKey;
      m.part++;
      m.pendingSize = used - length;
      if (m.pendingSize) {
        m.pendingKey = `archives/${m.id}/checkpoint-${randomUUID()}`;
        await s.storage.put(m.pendingKey, buffer.subarray(length, used));
      } else delete m.pendingKey;
      await save(part);
      buffer.copyWithin(0, length, used);
      used -= length;
      if (prior) await s.storage.remove(prior);
    };
    const append = async (bytes: Uint8Array) => {
      assert(bytes.length <= buffer.length, 'ARCHIVE_TOO_LARGE', 'A ZIP record is too large.');
      assert(
        used + bytes.length <= buffer.length,
        'ARCHIVE_TOO_LARGE',
        'A ZIP record is too large.',
      );
      buffer.set(bytes, used);
      used += bytes.length;
      m.position += bytes.length;
      archiveHash.update(bytes);
    };
    while (Date.now() < deadline && m.state !== 'FINALIZING') {
      if (used >= this.partBytes) await flush();
      // Recheck cancellation between files/chunks, without a write per network chunk.
      const current = await new Transaction(s.repo).get<Archive>(pk(m.id), 'META');
      assert(
        current?.lease === lease && active(current.state),
        'DOWNLOAD_CANCELLED',
        'ZIP preparation was cancelled.',
        409,
      );
      if (m.directoryOffset !== undefined) {
        if (m.directoryIndex < m.entries) {
          const entry = (await new Transaction(s.repo).get<Entry>(
            pk(m.id),
            entryKey(m.directoryIndex),
          ))!;
          await append(zipCentralHeader(entry, entry.crc!, entry.offset!));
          m.directoryIndex++;
        } else {
          await append(zipEnd(m.entries, m.directoryOffset, m.position - m.directoryOffset));
          m.state = 'FINALIZING';
        }
        continue;
      }
      if (m.index === m.entries) {
        m.directoryOffset = m.position;
        m.currentFile = null;
        continue;
      }
      const entry = (await new Transaction(s.repo).get<Entry>(pk(m.id), entryKey(m.index)))!;
      m.currentFile = entry.path;
      if (!m.headerWritten) {
        m.localOffset = m.position;
        await append(zipLocalHeader(entry));
        m.headerWritten = true;
      }
      if (m.fileOffset < entry.size) {
        const length = Math.min(entry.size - m.fileOffset, Math.max(0, this.partBytes - used));
        if (!length) continue;
        const bytes = await s.storage.readRange(entry.key!, m.fileOffset, length);
        assert(
          bytes.length === length,
          'INTEGRITY_ERROR',
          `File content is incomplete: ${entry.path}`,
        );
        m.crc = crc32(bytes, m.crc);
        fileHash.update(bytes);
        m.fileOffset += length;
        m.bytes += length;
        await append(bytes);
      } else {
        assert(
          entry.directory || (await digest(fileHash)) === entry.hash,
          'INTEGRITY_ERROR',
          `Download integrity check failed: ${entry.path}`,
        );
        await append(zipDescriptor(entry.size, m.crc));
        await transact(s.repo, async (tx) => {
          const current = await tx.get<Archive>(pk(m.id), 'META');
          assert(
            current?.lease === lease && active(current.state),
            'DOWNLOAD_CANCELLED',
            'ZIP preparation was cancelled.',
            409,
          );
          await tx.put(pk(m.id), entryKey(m.index), {
            ...entry,
            crc: m.crc,
            offset: m.localOffset,
          });
        });
        if (!entry.directory) m.files++;
        m.index++;
        m.headerWritten = false;
        m.fileOffset = 0;
        m.crc = 0;
        fileHash.init();
      }
    }
    if (m.state === 'FINALIZING') {
      while (used) await flush();
      await save();
      const parts = await new Transaction(s.repo).list<CompletedPart>(pk(m.id), 'PART#');
      await s.storage.complete(m.key, m.uploadId!, parts);
      m.contentHash = await digest(archiveHash);
      m.state = 'READY';
      m.currentFile = null;
      await save();
    } else {
      // A small tail cannot be a non-final multipart part. Persist it separately
      // so even a folder with thousands of tiny files can yield before timeout.
      const prior = m.pendingKey;
      if (used) {
        m.pendingKey = `archives/${m.id}/checkpoint-${randomUUID()}`;
        await s.storage.put(m.pendingKey, buffer.subarray(0, used));
      } else delete m.pendingKey;
      m.pendingSize = used;
      await save();
      if (prior) await s.storage.remove(prior);
    }
  }

  async cleanup(id: string, deadline = Date.now() + 30_000) {
    const m = await new Transaction(this.service.repo).get<Archive>(pk(id), 'META');
    if (!m) return true;
    if ((m.leaseUntil ?? 0) > Date.now()) return false;
    if (m.expiresAt > now() && !['FAILED', 'CANCELLED'].includes(m.state)) return false;
    do {
      if (await this.cleanupBatch(id)) return true;
    } while (Date.now() < deadline);
    return false;
  }

  private async cleanupBatch(id: string) {
    const s = this.service;
    const m = await new Transaction(s.repo).get<Archive>(pk(id), 'META');
    if (!m) return true;
    if ((m.leaseUntil ?? 0) > Date.now()) return false;
    if (m.expiresAt > now() && !['FAILED', 'CANCELLED'].includes(m.state)) return false;
    // Release source pins transactionally, in bounded batches. A crash can replay
    // cleanup without decrementing an object's reference count twice.
    const entries = await s.repo.query(pk(id), 'ENTRY#', 10);
    for (const row of entries.rows)
      await transact(s.repo, async (tx) => {
        const entry = await tx.get<Entry>(pk(id), row.sk);
        if (!entry) return;
        if (entry.objectId) await s.reference(tx, entry.objectId, -1);
        await tx.delete(pk(id), row.sk);
      });
    if (entries.rows.length) return false;
    const leftovers = await s.repo.query(pk(id), '', 50);
    for (const row of leftovers.rows.filter((row) => row.sk !== 'META'))
      await transact(s.repo, (tx) => tx.delete(pk(id), row.sk));
    if (leftovers.rows.some((row) => row.sk !== 'META')) return false;
    await s.storage.cleanupArchive(`archives/${id}/`);
    await transact(s.repo, async (tx) => {
      const current = await tx.get<Archive>(pk(id), 'META');
      if (!current) return;
      if (!['FAILED', 'CANCELLED'].includes(current.state)) current.state = 'EXPIRED';
      await tx.put(pk(id), 'META', current, { expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    });
    return true;
  }
}
