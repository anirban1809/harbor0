import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, lstat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiClient } from '@harbor/api-client';
import type { DriveItem, CompletedPart } from '@harbor/contracts';
import {
  prepareFolderDownload,
  type FolderDownloadProgress,
} from '../../../packages/api-client/src/archive-download';

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

export async function hashFile(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 }))
    hash.update(chunk);
  return hash.digest('hex');
}
export type UploadState = {
  operationId: string;
  uploadId?: string;
  partSize?: number;
  hash?: string;
  size?: number;
  mtime?: number;
  parts?: CompletedPart[];
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
  const info = await stat(filename);
  if (state.mtime !== undefined && (state.mtime !== info.mtimeMs || state.size !== info.size)) {
    if (state.uploadId) await api.request(`/v1/uploads/${state.uploadId}`, { method: 'DELETE' });
    Object.assign(state, {
      operationId: crypto.randomUUID(),
      uploadId: undefined,
      partSize: undefined,
      hash: undefined,
      parts: undefined,
    });
  }
  state.mtime = info.mtimeMs;
  state.size = info.size;
  if (!state.hash) state.hash = await hashFile(filename);
  persist();
  // A freshly created upload has no parts yet; only a resumed one needs its server status.
  let created = false;
  if (!state.uploadId) {
    const input = {
      operationId: state.operationId,
      parentId,
      name,
      sizeBytes: info.size,
      mimeType: 'application/octet-stream',
      contentHash: state.hash,
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
    persist();
    return uploadFile(
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
    );
  }
  const parts: CompletedPart[] =
    status?.upload.state === 'COMPLETING' ? (state.parts ?? []) : (status?.parts ?? []);
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
          let url = urls.parts.find((part) => part.partNumber === n)!.uploadUrl;
          let etag: string | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              if (attempt) url = (await api.parts(state.uploadId!, [n])).parts[0].uploadUrl;
              const response = await fetch(url, { method: 'PUT', body: buffer });
              etag = response.ok ? response.headers.get('etag') : null;
              await response.body?.cancel();
              if (!etag) throw new Error('Storage upload failed. It will resume automatically.');
              break;
            } catch (error) {
              if (attempt === 2) throw error;
            }
          }
          parts.push({ partNumber: n, etag: etag! });
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
  return (
    await api.complete(
      state.uploadId!,
      parts.sort((a, b) => a.partNumber - b.partNumber),
      state.hash!,
    )
  ).item;
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
  const signed = await api.download(input);
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
    const response = await fetch(signed.downloadUrl, {
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
        const first = await readRange(response, offset, end, signed.sizeBytes);
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
      await beforeReplace?.();
      await rename(part, destination);
      return signed.contentHash;
    }
  }
  if ((await stat(part)).size !== signed.sizeBytes || hash.digest('hex') !== signed.contentHash) {
    await rm(part, { force: true });
    throw new Error('Download integrity check failed. The original local file was kept.');
  }
  await beforeReplace?.();
  await rename(part, destination);
  return signed.contentHash;
}

async function readRange(response: Response, start: number, end: number, total: number) {
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
  }
  if (offset !== buffer.length)
    throw new Error('Download interrupted. It will resume automatically.');
  return buffer;
}
