import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, stat, lstat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiClient, ApiError, describeProblem } from '@harbor/api-client';
import type { DriveItem, CompletedPart, ClientEventStage } from '@harbor/contracts';
import {
  prepareFolderDownload,
  type FolderDownloadProgress,
} from '../../../packages/api-client/src/archive-download';
import {
  FileCipher,
  HEADER_SIZE,
  b64url,
  encryptedSize,
  fromB64url,
  plainSize,
  type AccountKeys,
} from '../../../packages/api-client/src/e2ee';

/**
 * The account's keys on an end-to-end encrypted account, once this app is unlocked: uploads are
 * encrypted with `upload` keys, and encrypted downloads are decrypted with `read` keys (still
 * there while encryption is being turned off, when uploads go up unencrypted).
 */
export const transferKeys: {
  upload: () => AccountKeys | undefined;
  read: () => AccountKeys | undefined;
} = { upload: () => undefined, read: () => undefined };
const lockedError = () => new ApiError('E2EE_LOCKED', 'Unlock your files to continue.', 423);

export async function downloadFolderZip(
  api: ApiClient,
  folder: Pick<DriveItem, 'id' | 'name'>,
  destination: string,
  onProgress?: (progress: FolderDownloadProgress) => void,
) {
  try {
    if ((await lstat(destination)).isSymbolicLink())
      throw new Error('Refusing to write through a symbolic link.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const archive = await prepareFolderDownload(api, folder.id, onProgress);
  await downloadFile(api, { folderDownloadId: archive.id }, destination, (bytes, total) =>
    onProgress?.({
      phase: 'downloading',
      bytes,
      files: archive.files,
      currentFile: null,
      fileBytes: bytes,
      fileSize: total,
    }),
  );
}
const TRANSFER_CONCURRENCY = 4;
const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_BUFFER_BUDGET = 64 * 1024 * 1024;
// Storage requests must end: a transfer slower than 32 KiB/s (or silent for a minute while
// streaming) fails and resumes on the next attempt instead of holding up sync forever.
// AbortSignal.timeout rejects fractional delays, so round up to whole milliseconds.
const sizedTimeout = (bytes: number) =>
  AbortSignal.timeout(Math.max(120_000, Math.ceil((bytes / (32 * 1024)) * 1000)));
function idleTimeout(ms = 60_000) {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      Object.assign(new Error('Download stalled. It will resume automatically.'), {
        name: 'TimeoutError',
      }),
    );
  let timer = setTimeout(abort, ms);
  return {
    signal: controller.signal,
    touch() {
      clearTimeout(timer);
      timer = setTimeout(abort, ms);
    },
    done: () => clearTimeout(timer),
  };
}

export async function hashFile(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 }))
    hash.update(chunk);
  return hash.digest('hex');
}
/** Cancels an unfinished upload, freeing its reserved storage; one already gone needs nothing. */
export async function cancelUpload(api: ApiClient, uploadId: string) {
  try {
    await api.request(`/v1/uploads/${uploadId}`, { method: 'DELETE' });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) throw error;
  }
}
export type UploadState = {
  operationId: string;
  uploadId?: string;
  partSize?: number;
  /** SHA-256 of the file on disk. */
  hash?: string;
  size?: number;
  mtime?: number;
  parts?: CompletedPart[];
  /** An encrypted upload's H0E1 header: resuming re-seals the same bytes with it. */
  header?: string;
  /** SHA-256 of the encrypted bytes as stored, once every part is sealed. */
  storedHash?: string;
};
export async function uploadFile(
  api: ApiClient,
  filename: string,
  name: string,
  parentId: string | null,
  state: UploadState,
  persist: () => void,
  existing?: { itemId: string; revision: number },
  progress?: (loaded: number, total: number) => void,
  beforeComplete?: () => Promise<void>,
  backup?: { rootId: string; runId: string },
) {
  // Where the upload got to, for the problem report if it fails.
  const at = { stage: 'hash' as ClientEventStage };
  try {
    return await upload(
      api,
      filename,
      name,
      parentId,
      state,
      persist,
      existing,
      progress,
      beforeComplete,
      backup,
      at,
    );
  } catch (error) {
    api.reportProblem({
      kind: 'UPLOAD_FAILED',
      stage: at.stage,
      uploadId: state.uploadId,
      sizeBytes: state.size,
      ...describeProblem(error),
    });
    throw error;
  }
}
async function upload(
  api: ApiClient,
  filename: string,
  name: string,
  parentId: string | null,
  state: UploadState,
  persist: () => void,
  existing: { itemId: string; revision: number } | undefined,
  progress: ((loaded: number, total: number) => void) | undefined,
  beforeComplete: (() => Promise<void>) | undefined,
  backup: { rootId: string; runId: string } | undefined,
  at: { stage: ClientEventStage },
): Promise<DriveItem> {
  at.stage = 'hash';
  const info = await stat(filename);
  const keys = transferKeys.upload();
  // A changed file, or encryption turned on or off since the upload started, starts over.
  if (
    (state.mtime !== undefined && (state.mtime !== info.mtimeMs || state.size !== info.size)) ||
    (state.uploadId && !!state.header !== !!keys)
  ) {
    if (state.uploadId) await cancelUpload(api, state.uploadId);
    Object.assign(state, {
      operationId: crypto.randomUUID(),
      uploadId: undefined,
      partSize: undefined,
      hash: undefined,
      parts: undefined,
      header: undefined,
      storedHash: undefined,
    });
  }
  state.mtime = info.mtimeMs;
  state.size = info.size;
  if (!state.hash) state.hash = await hashFile(filename);
  persist();
  at.stage = 'create';
  // A freshly created upload has no parts yet; only a resumed one needs its server status.
  let created = false;
  let cipher: FileCipher | undefined;
  if (!state.uploadId) {
    if (keys) {
      cipher = await FileCipher.create(keys);
      state.header = b64url(cipher.header);
    }
    const input = {
      operationId: state.operationId,
      parentId,
      name,
      // The server only ever sees the encrypted size and hash of an encrypted file.
      ...(cipher
        ? { sizeBytes: encryptedSize(info.size), encrypted: true }
        : { sizeBytes: info.size, contentHash: state.hash }),
      mimeType: 'application/octet-stream',
      ...(existing ? { driveItemId: existing.itemId, baseRevision: existing.revision } : {}),
    };
    const result = backup
      ? await api.request(`/v1/backups/${backup.rootId}/runs/${backup.runId}/uploads`, {
          method: 'POST',
          body: input,
        })
      : await api.createUpload(input);
    state.uploadId = result.upload.id;
    state.partSize = result.upload.partSizeBytes;
    persist();
    created = true;
  }
  const status = created ? undefined : await api.request(`/v1/uploads/${state.uploadId}`);
  if (status?.upload.state === 'COMPLETED') return status.upload.item as DriveItem;
  if (status && ['ABORTED', 'FAILED', 'EXPIRED'].includes(status.upload.state)) {
    state.uploadId = undefined;
    state.operationId = crypto.randomUUID();
    state.header = undefined;
    state.storedHash = undefined;
    persist();
    return upload(
      api,
      filename,
      name,
      parentId,
      state,
      persist,
      existing,
      progress,
      beforeComplete,
      backup,
      at,
    );
  }
  const parts: CompletedPart[] =
    status?.upload.state === 'COMPLETING' ? (state.parts ?? []) : (status?.parts ?? []);
  if (state.header) {
    if (!keys) throw lockedError();
    cipher ??= await FileCipher.open(keys, fromB64url(state.header));
    return uploadEncrypted(
      api,
      filename,
      info,
      state,
      persist,
      parts,
      cipher,
      progress,
      beforeComplete,
      at,
    );
  }
  const count = Math.max(1, Math.ceil(info.size / state.partSize!));
  const completed = new Set(parts.map((part) => part.partNumber));
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !completed.has(n));
  const partBytes = (n: number) => Math.min(state.partSize!, info.size - (n - 1) * state.partSize!);
  let loaded = parts.reduce((sum, part) => sum + partBytes(part.partNumber), 0);
  progress?.(loaded, info.size);
  const concurrency = Math.max(
    1,
    Math.min(TRANSFER_CONCURRENCY, Math.floor(UPLOAD_BUFFER_BUDGET / state.partSize!)),
  );
  at.stage = 'storage';
  const handle = await open(filename, 'r');
  try {
    for (let start = 0; start < missing.length; start += concurrency) {
      const batch = missing.slice(start, start + concurrency);
      const urls = await api.parts(state.uploadId!, batch);
      // Settle every worker before closing the shared file or retrying the job.
      const results = await Promise.allSettled(
        batch.map(async (n) => {
          const size = partBytes(n);
          const buffer = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const result = await handle.read(
              buffer,
              offset,
              size - offset,
              (n - 1) * state.partSize! + offset,
            );
            if (!result.bytesRead)
              throw new Error('File changed during upload. Retry to preserve the latest content.');
            offset += result.bytesRead;
          }
          const etag = await putPart(
            api,
            state,
            n,
            buffer,
            urls.parts.find((part) => part.partNumber === n)!.uploadUrl,
            info.size,
          );
          parts.push({ partNumber: n, etag });
          state.parts = parts;
          persist();
          loaded += size;
          progress?.(loaded, info.size);
        }),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  } finally {
    await handle.close();
  }
  const after = await stat(filename);
  if (after.mtimeMs !== state.mtime || after.size !== state.size)
    throw new Error('File changed while uploading. The next attempt will restart safely.');
  await beforeComplete?.();
  at.stage = 'complete';
  return (
    await api.complete(
      state.uploadId!,
      parts.sort((a, b) => a.partNumber - b.partNumber),
      state.hash!,
    )
  ).item;
}
/** PUTs one part to storage, signing a new link for each retry; returns its ETag. */
async function putPart(
  api: ApiClient,
  state: UploadState,
  n: number,
  buffer: Uint8Array,
  firstUrl: string | undefined,
  fileSize: number,
) {
  let url = firstUrl;
  for (let attempt = 0; ; attempt++) {
    try {
      if (!url || attempt) url = (await api.parts(state.uploadId!, [n])).parts[0].uploadUrl;
      const response = await fetch(url, {
        method: 'PUT',
        body: buffer as Uint8Array<ArrayBuffer>,
        signal: sizedTimeout(buffer.length),
      });
      const etag = response.ok ? response.headers.get('etag') : null;
      await response.body?.cancel();
      if (!etag)
        throw Object.assign(new Error('Storage upload failed. It will resume automatically.'), {
          code: response.ok ? 'NO_ETAG' : 'STORAGE_REJECTED',
          httpStatus: response.status,
        });
      return etag;
    } catch (error) {
      api.reportProblem({
        kind: 'UPLOAD_PART_RETRY',
        // Signing the URL is an API call; the PUT itself goes to storage.
        stage: error instanceof ApiError ? 'parts' : 'storage',
        uploadId: state.uploadId,
        sizeBytes: fileSize,
        partNumber: n,
        attempt,
        ...describeProblem(error),
      });
      if (attempt === 2) throw error;
    }
  }
}

/**
 * The parts of an encrypted upload. They are sealed in order, so the stored bytes' SHA-256 is
 * known at the end without reading the file twice, and upload a few at a time while the next is
 * sealed. Sealing is deterministic for the saved header, so a resumed upload re-seals the parts
 * storage already has only to hash them.
 */
async function uploadEncrypted(
  api: ApiClient,
  filename: string,
  info: { size: number },
  state: UploadState,
  persist: () => void,
  parts: CompletedPart[],
  cipher: FileCipher,
  progress: ((loaded: number, total: number) => void) | undefined,
  beforeComplete: (() => Promise<void>) | undefined,
  at: { stage: ClientEventStage },
): Promise<DriveItem> {
  const stored = encryptedSize(info.size);
  const partSize = state.partSize!;
  const count = Math.max(1, Math.ceil(stored / partSize));
  const partBytes = (n: number) => Math.min(partSize, stored - (n - 1) * partSize);
  const completed = new Set(parts.map((part) => part.partNumber));
  // Progress is shown against the file's own size.
  const shown = (bytes: number) => Math.round((bytes / stored) * info.size);
  let loaded = parts.reduce((sum, part) => sum + partBytes(part.partNumber), 0);
  progress?.(shown(loaded), info.size);
  if (!state.storedHash || parts.length < count) {
    at.stage = 'storage';
    const hash = createHash('sha256');
    const concurrency = Math.max(
      1,
      Math.min(TRANSFER_CONCURRENCY, Math.floor(UPLOAD_BUFFER_BUDGET / partSize)),
    );
    const handle = await open(filename, 'r');
    const read = async (begin: number, end: number) => {
      const buffer = Buffer.alloc(end - begin);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, begin + offset);
        if (!result.bytesRead)
          throw new Error('File changed during upload. Retry to preserve the latest content.');
        offset += result.bytesRead;
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
    };
    const running = new Set<Promise<void>>();
    let failure: unknown;
    try {
      for (let n = 1; n <= count; n++) {
        if (failure) break;
        const start = (n - 1) * partSize;
        const bytes = await cipher.encryptedRange(info.size, start, start + partBytes(n), read);
        hash.update(bytes);
        if (completed.has(n)) continue;
        while (running.size >= concurrency) await Promise.race(running);
        if (failure) break;
        const job = putPart(api, state, n, bytes, undefined, stored).then(
          (etag) => {
            parts.push({ partNumber: n, etag });
            state.parts = parts;
            persist();
            loaded += bytes.length;
            progress?.(shown(loaded), info.size);
          },
          (error) => {
            failure ??= error;
          },
        );
        running.add(job);
        void job.finally(() => running.delete(job));
      }
      await Promise.all(running);
    } finally {
      await handle.close();
    }
    if (failure) throw failure;
    state.storedHash = hash.digest('hex');
    persist();
  }
  const after = await stat(filename);
  if (after.mtimeMs !== state.mtime || after.size !== state.size)
    throw new Error('File changed while uploading. The next attempt will restart safely.');
  await beforeComplete?.();
  at.stage = 'complete';
  return (
    await api.complete(
      state.uploadId!,
      parts.sort((a, b) => a.partNumber - b.partNumber),
      state.storedHash!,
    )
  ).item;
}

/**
 * Decrypts a downloaded encrypted file into `target`, chunk by chunk; returns the SHA-256 of
 * the decrypted file. Any damaged or swapped chunk fails the whole file.
 */
async function decryptFile(source: string, target: string, keys: AccountKeys) {
  const input = await open(source, 'r');
  const output = await open(target, 'w', 0o600);
  const hash = createHash('sha256');
  try {
    const stored = (await input.stat()).size;
    const header = Buffer.alloc(HEADER_SIZE);
    await input.read(header, 0, HEADER_SIZE, 0);
    const cipher = await FileCipher.open(keys, new Uint8Array(header));
    const total = plainSize(stored);
    const chunks = Math.max(1, Math.ceil(total / cipher.chunkSize));
    let at = HEADER_SIZE;
    for (let i = 0; i < chunks; i++) {
      const length = Math.min(cipher.chunkSize, total - i * cipher.chunkSize) + 16;
      const sealed = Buffer.alloc(length);
      const { bytesRead } = await input.read(sealed, 0, length, at);
      if (bytesRead !== length) throw new Error('The downloaded file is incomplete.');
      at += length;
      const plain = await cipher.decryptChunk(i, new Uint8Array(sealed), i === chunks - 1);
      await output.write(plain);
      hash.update(plain);
    }
  } finally {
    await input.close();
    await output.close();
  }
  return hash.digest('hex');
}

export async function downloadFile(
  api: ApiClient,
  input: {
    folderDownloadId?: string;
    driveItemId?: string;
    versionId?: string;
    transferId?: string;
    entryId?: string;
  },
  destination: string,
  onProgress?: (bytes: number, total: number) => void,
  beforeReplace?: () => Promise<void>,
) {
  const part = destination + '.harbor-part';
  for (const target of [destination, part]) {
    try {
      if ((await lstat(target)).isSymbolicLink())
        throw new Error('Refusing to write through a symbolic link.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  let offset = 0;
  try {
    offset = (await stat(part)).size;
  } catch {}
  const signed: Awaited<ReturnType<ApiClient['download']>> & { encrypted?: boolean } =
    await api.download(input);
  const keys = signed.encrypted ? transferKeys.read() : undefined;
  if (signed.encrypted && !keys) throw lockedError();
  /**
   * Puts the checked download in place; an encrypted one is decrypted first. Returns the
   * SHA-256 of the file as written, which is the stored hash unless it was encrypted.
   */
  const finish = async () => {
    let written = part;
    let localHash = signed.contentHash;
    if (keys) {
      written = destination + '.harbor-plain';
      try {
        localHash = await decryptFile(part, written, keys);
      } catch (error) {
        await rm(written, { force: true });
        // Damaged bytes come down again next time rather than failing for good.
        await rm(part, { force: true });
        throw error;
      }
    }
    await beforeReplace?.();
    await replaceWith(written, destination);
    if (written !== part) await rm(part, { force: true });
    return localHash;
  };
  if (offset > signed.sizeBytes) {
    await rm(part, { force: true });
    offset = 0;
  }
  const hash = createHash('sha256');
  if (offset) {
    for await (const chunk of createReadStream(part, { highWaterMark: 1024 * 1024 }))
      hash.update(chunk);
  }
  if (offset < signed.sizeBytes || signed.sizeBytes === 0) {
    const parallel = signed.sizeBytes - offset > DOWNLOAD_CHUNK_BYTES * 2;
    const end = Math.min(offset + DOWNLOAD_CHUNK_BYTES, signed.sizeBytes) - 1;
    const idle = idleTimeout();
    try {
      const response = await fetch(signed.downloadUrl, {
        signal: idle.signal,
        headers: parallel
          ? { Range: `bytes=${offset}-${end}` }
          : offset
            ? { Range: `bytes=${offset}-` }
            : {},
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Download interrupted. It will resume automatically.');
      }
      if (parallel && response.status === 206) {
        const handle = await open(part, offset ? 'a' : 'w', 0o600);
        try {
          const first = await readRange(response, offset, end, signed.sizeBytes, idle.touch);
          idle.done();
          await handle.writeFile(first);
          hash.update(first);
          offset += first.length;
          onProgress?.(offset, signed.sizeBytes);
          while (offset < signed.sizeBytes) {
            const ranges = Array.from(
              {
                length: Math.min(
                  TRANSFER_CONCURRENCY,
                  Math.ceil((signed.sizeBytes - offset) / DOWNLOAD_CHUNK_BYTES),
                ),
              },
              (_, i) => {
                const start = offset + i * DOWNLOAD_CHUNK_BYTES;
                return { start, end: Math.min(start + DOWNLOAD_CHUNK_BYTES, signed.sizeBytes) - 1 };
              },
            );
            const results = await Promise.allSettled(
              ranges.map(async (range) => {
                for (let attempt = 0; ; attempt++) {
                  try {
                    const chunk = await fetch(signed.downloadUrl, {
                      headers: { Range: `bytes=${range.start}-${range.end}` },
                      signal: sizedTimeout(range.end - range.start + 1),
                    });
                    return await readRange(chunk, range.start, range.end, signed.sizeBytes);
                  } catch (error) {
                    if (attempt === 2) throw error;
                  }
                }
              }),
            );
            // Commit only a contiguous prefix so interrupted downloads remain resumable.
            for (const result of results) {
              if (result.status === 'rejected') throw result.reason;
              await handle.writeFile(result.value);
              hash.update(result.value);
              offset += result.value.length;
              onProgress?.(offset, signed.sizeBytes);
            }
          }
        } finally {
          await handle.close();
        }
      } else {
        // Servers that ignore Range can still send the complete file in one stream.
        if (
          response.status === 206 &&
          response.headers.get('content-range') !==
            `bytes ${offset}-${signed.sizeBytes - 1}/${signed.sizeBytes}`
        ) {
          await response.body.cancel();
          throw new Error('Storage returned an unexpected download range.');
        }
        if (offset && response.status !== 206) offset = 0;
        const streamHash = offset ? hash : createHash('sha256');
        let loaded = offset;
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            idle.touch();
            loaded += chunk.length;
            streamHash.update(chunk);
            onProgress?.(loaded, signed.sizeBytes);
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(response.body as any),
          meter,
          createWriteStream(part, { flags: offset ? 'a' : 'w', mode: 0o600 }),
        );
        if (
          (await stat(part)).size !== signed.sizeBytes ||
          streamHash.digest('hex') !== signed.contentHash
        ) {
          await rm(part, { force: true });
          throw new Error('Download integrity check failed. The original local file was kept.');
        }
        return await finish();
      }
    } finally {
      idle.done();
    }
  }
  if ((await stat(part)).size !== signed.sizeBytes || hash.digest('hex') !== signed.contentHash) {
    await rm(part, { force: true });
    throw new Error('Download integrity check failed. The original local file was kept.');
  }
  return finish();
}

/**
 * Puts a finished download in place of the local file. Windows refuses to replace a read-only
 * file, which macOS and Linux allow; clearing the flag first gives the same result everywhere.
 */
async function replaceWith(part: string, destination: string) {
  try {
    await rename(part, destination);
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
      throw error;
    const current = await lstat(destination).catch(() => undefined);
    if (!current?.isFile() || current.mode & 0o200) throw error;
    await chmod(destination, current.mode | 0o200);
    await rename(part, destination);
  }
}

async function readRange(
  response: Response,
  start: number,
  end: number,
  total: number,
  touch?: () => void,
) {
  if (
    response.status !== 206 ||
    !response.body ||
    response.headers.get('content-range') !== `bytes ${start}-${end}/${total}`
  ) {
    await response.body?.cancel();
    throw new Error('Storage returned an unexpected download range.');
  }
  const buffer = Buffer.alloc(end - start + 1);
  let offset = 0;
  for await (const chunk of Readable.fromWeb(response.body as any)) {
    if (offset + chunk.length > buffer.length)
      throw new Error('Download range exceeded its expected size.');
    buffer.set(chunk, offset);
    offset += chunk.length;
    touch?.();
  }
  if (offset !== buffer.length)
    throw new Error('Download interrupted. It will resume automatically.');
  return buffer;
}
