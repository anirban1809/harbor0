import { ApiClient, ApiError, describeProblem } from '@harbor/api-client';
import type { ClientEventStage, CompletedPart, DriveItem } from '@harbor/contracts';
import type { AccountKeys } from '../../../packages/api-client/src/e2ee';
import { fileSource, uploadEncrypted, type EncryptedResume } from './e2ee-files';
/** How a file lands: under its own name, as a new version of an item, or beside a same-named one. */
export type UploadTarget =
  | { kind: 'new' }
  | { kind: 'replace'; item: Pick<DriveItem, 'id' | 'revision'> }
  | { kind: 'keep-both' };
/** “Report.pdf” → “Report (2).pdf”; dotfiles and names without an extension get the suffix last. */
export function numberedName(name: string, n: number) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}
/** Errors retrying cannot fix, so the server upload is released instead of kept for a resume. */
export function permanentUploadError(e: unknown) {
  return (
    e instanceof ApiError &&
    e.status >= 400 &&
    e.status < 500 &&
    ![401, 408, 429].includes(e.status)
  );
}
export const isNameConflict = (e: unknown) => e instanceof ApiError && e.code === 'NAME_CONFLICT';
export function uploadErrorMessage(e: unknown) {
  if (!(e instanceof ApiError)) return (e as Error).message;
  return (
    {
      OWNER_STORAGE_FULL: 'The owner of this shared folder is out of storage.',
      STORAGE_QUOTA_EXCEEDED: 'Your storage is full. Free up space, then retry.',
      NAME_CONFLICT: 'A file with this name is already here.',
      REVISION_CONFLICT:
        'The file changed while uploading. Replace it again to upload over the latest version.',
      FORBIDDEN: 'You can’t upload to this folder.',
    }[e.code] ?? e.message
  );
}
export type UploadProgress = {
  name: string;
  size: number;
  loaded: number;
  phase: 'hashing' | 'uploading' | 'paused' | 'done' | 'failed';
  error?: string;
};
function hashFile(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/hash.ts', import.meta.url));
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      reject(new DOMException('Paused', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (e) => {
      if (e.data.hash) {
        cleanup();
        resolve(e.data.hash);
      }
      if (e.data.error) {
        cleanup();
        reject(new Error(e.data.error));
      }
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error('File hashing failed.'));
    };
    worker.postMessage(file);
  });
}
// A storage PUT that sends nothing for this long is given up and retried; without it a
// dropped connection can leave the browser waiting forever with the upload stuck.
const STALL_MS = 60_000;
/** A storage failure with what the problem report needs. */
const storageError = (message: string, code: string, httpStatus: number) =>
  Object.assign(new Error(message), { code, httpStatus });
// Storage speaks HTTP/1.1, so the browser opens at most 6 connections to it and queues the
// rest unsent. Capping PUTs across all uploads below that keeps every PUT on the wire, so
// the stall timer only ever times bytes that should be moving.
export const STORAGE_PUT_SLOTS = 5;
let putsRunning = 0;
const waitingPuts: (() => void)[] = [];
/** Waits for a free storage PUT slot; resolves to the function that gives it back. */
function putSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Paused', 'AbortError'));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      putsRunning--;
      waitingPuts.shift()?.();
    };
    const take = () => {
      signal.removeEventListener('abort', cancel);
      putsRunning++;
      resolve(release);
    };
    const cancel = () => {
      const i = waitingPuts.indexOf(take);
      if (i >= 0) waitingPuts.splice(i, 1);
      reject(new DOMException('Paused', 'AbortError'));
    };
    if (putsRunning < STORAGE_PUT_SLOTS) return take();
    waitingPuts.push(take);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export async function put(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  const release = await putSlot(signal);
  try {
    return await send(url, blob, signal, onProgress);
  } finally {
    release();
  }
}
function send(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    let stalled = false;
    const stall = () => {
      stalled = true;
      xhr.abort();
    };
    let timer = setTimeout(stall, STALL_MS);
    const abort = () => xhr.abort();
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    xhr.upload.onprogress = (e) => {
      clearTimeout(timer);
      timer = setTimeout(stall, STALL_MS);
      onProgress(e.loaded);
    };
    xhr.onload = () => {
      settle();
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else
        reject(
          storageError(
            'The storage upload failed. Retry to resume.',
            etag ? 'STORAGE_REJECTED' : 'NO_ETAG',
            xhr.status,
          ),
        );
    };
    xhr.onerror = () => {
      settle();
      reject(storageError('Network interrupted. Retry to resume.', 'NETWORK', 0));
    };
    xhr.onabort = () => {
      settle();
      reject(
        stalled
          ? storageError('The upload stalled. Retry to resume.', 'STALLED', 0)
          : new DOMException('Paused', 'AbortError'),
      );
    };
    xhr.send(blob);
  });
}
const paused = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
export class BrowserUpload {
  controller = new AbortController();
  uploadId?: string;
  /** The localStorage key that lets the same file resume this upload after a reload. */
  resumeKey?: string;
  constructor(
    private api: ApiClient,
    private userId: string,
    /** Set on an end-to-end encrypted account, for files going into its own folders. */
    private keys?: AccountKeys,
  ) {}
  pause() {
    this.controller.abort();
  }
  /** Stops the upload and releases the storage the server reserved for it. */
  async cancel() {
    this.pause();
    if (this.resumeKey) localStorage.removeItem(this.resumeKey);
    const id = this.uploadId;
    this.uploadId = undefined;
    if (id)
      await this.api.request(`/v1/uploads/${id}`, { method: 'DELETE' }).catch((e) => {
        // Already finished, expired or aborted: nothing is reserved any more.
        if (!(e instanceof ApiError && [404, 409].includes(e.status))) throw e;
      });
  }
  /** Where the upload got to, for the problem report if it fails. */
  private stage: ClientEventStage = 'hash';
  async run(
    file: File,
    parentId: string | null,
    progress: (p: UploadProgress) => void,
    target: UploadTarget = { kind: 'new' },
  ): Promise<DriveItem> {
    try {
      return await this.attempt(file, parentId, progress, target);
    } catch (e) {
      if (!paused(e))
        this.api.reportProblem({
          kind: 'UPLOAD_FAILED',
          stage: this.stage,
          uploadId: this.uploadId,
          sizeBytes: file.size,
          online: navigator.onLine,
          ...describeProblem(e),
        });
      throw e;
    }
  }
  private async attempt(
    file: File,
    parentId: string | null,
    progress: (p: UploadProgress) => void,
    target: UploadTarget,
  ): Promise<DriveItem> {
    this.stage = 'hash';
    this.controller = new AbortController();
    const signal = this.controller.signal;
    if (this.keys) return this.encrypted(file, parentId, progress, target, signal, this.keys);
    progress({ name: file.name, size: file.size, loaded: 0, phase: 'hashing' });
    const contentHash = await hashFile(file, signal);
    const into = target.kind === 'replace' ? `item:${target.item.id}` : (parentId ?? 'root');
    let name = file.name;
    let key = `harbor-upload:${this.userId}:${into}:${contentHash}:${name}`;
    let saved = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      id: string;
      partSizeBytes: number;
    } | null;
    this.stage = 'create';
    if (saved) {
      try {
        const status = await this.api.request(`/v1/uploads/${saved.id}`);
        if (status.upload.state === 'COMPLETED') {
          localStorage.removeItem(key);
          return status.upload.item;
        }
        if (!['UPLOADING', 'COMPLETING'].includes(status.upload.state)) saved = null;
      } catch {
        saved = null;
      }
    }
    for (let n = 2; !saved; n++) {
      try {
        const result = await this.api.createUpload({
          operationId: crypto.randomUUID(),
          parentId,
          name,
          sizeBytes: file.size,
          mimeType: file.type || 'application/octet-stream',
          contentHash,
          ...(target.kind === 'replace'
            ? { driveItemId: target.item.id, baseRevision: target.item.revision }
            : {}),
        });
        saved = { id: result.upload.id, partSizeBytes: result.upload.partSizeBytes };
        key = `harbor-upload:${this.userId}:${into}:${contentHash}:${name}`;
        localStorage.setItem(key, JSON.stringify(saved));
      } catch (e) {
        // Keeping both tries “name (2)”, “name (3)” and so on until a name is free.
        if (target.kind !== 'keep-both' || !isNameConflict(e) || n > 50) throw e;
        name = numberedName(file.name, n);
      }
    }
    this.uploadId = saved.id;
    this.resumeKey = key;
    const session = saved;
    this.stage = 'storage';
    const status = await this.api.request(`/v1/uploads/${session.id}`);
    const parts: CompletedPart[] = status.parts ?? [];
    const uploaded = new Set(parts.map((p) => p.partNumber));
    const completedBytes = () =>
      parts.reduce(
        (n, p) =>
          n +
          Math.min(session.partSizeBytes, file.size - (p.partNumber - 1) * session.partSizeBytes),
        0,
      );
    const inflight = new Map<number, number>();
    const report = () =>
      progress({
        name: file.name,
        size: file.size,
        loaded: completedBytes() + [...inflight.values()].reduce((n, b) => n + b, 0),
        phase: 'uploading',
      });
    const count = Math.max(1, Math.ceil(file.size / session.partSizeBytes));
    const queue = Array.from({ length: count }, (_, i) => i + 1).filter((p) => !uploaded.has(p));
    const work = async () => {
      while (queue.length) {
        if (signal.aborted) throw new DOMException('Paused', 'AbortError');
        const partNumber = queue.shift()!;
        let etag: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { parts: urls } = await this.api.parts(session.id, [partNumber]);
            etag = await put(
              urls[0].uploadUrl,
              file.slice(
                (partNumber - 1) * session.partSizeBytes,
                partNumber * session.partSizeBytes,
              ),
              signal,
              (bytes) => {
                inflight.set(partNumber, bytes);
                report();
              },
            );
            break;
          } catch (e) {
            if (signal.aborted && paused(e)) throw e;
            this.api.reportProblem({
              kind: 'UPLOAD_PART_RETRY',
              // Signing the URL is an API call; the PUT itself goes to storage.
              stage: e instanceof ApiError ? 'parts' : 'storage',
              uploadId: session.id,
              sizeBytes: file.size,
              partNumber,
              attempt,
              online: navigator.onLine,
              ...describeProblem(e),
            });
            if (signal.aborted || attempt === 2) throw e;
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          }
        }
        inflight.delete(partNumber);
        parts.push({ partNumber, etag: etag! });
        report();
      }
    };
    try {
      await Promise.all([work(), work(), work()]);
      this.stage = 'complete';
      const { item } = await this.api.complete(
        session.id,
        parts.sort((a, b) => a.partNumber - b.partNumber),
        contentHash,
      );
      localStorage.removeItem(key);
      this.uploadId = undefined;
      progress({ name: file.name, size: file.size, loaded: file.size, phase: 'done' });
      return item;
    } catch (e) {
      this.controller.abort();
      // A conflict or lost access can't be resumed; release the reserved storage now.
      if (permanentUploadError(e)) await this.cancel().catch(() => {});
      throw e;
    }
  }

  /** The same upload, encrypted in this browser; see uploadEncrypted. */
  private async encrypted(
    file: File,
    parentId: string | null,
    progress: (p: UploadProgress) => void,
    target: UploadTarget,
    signal: AbortSignal,
    keys: AccountKeys,
  ): Promise<DriveItem> {
    const into = target.kind === 'replace' ? `item:${target.item.id}` : (parentId ?? 'root');
    const keyFor = (name: string) =>
      `harbor-upload:${this.userId}:${into}:e2ee:${file.size}:${file.lastModified}:${name}`;
    progress({ name: file.name, size: file.size, loaded: 0, phase: 'uploading' });
    this.stage = 'create';
    for (let n = 2; ; n++) {
      const name = n === 2 || target.kind !== 'keep-both' ? file.name : numberedName(file.name, n - 1);
      const key = keyFor(name);
      const resume = JSON.parse(localStorage.getItem(key) ?? 'null') as EncryptedResume | null;
      try {
        const item = await uploadEncrypted({
          api: this.api,
          keys,
          source: fileSource(file),
          name,
          parentId,
          replace: target.kind === 'replace' ? target.item : undefined,
          signal,
          resume: resume ?? undefined,
          onCreated: (saved) => {
            this.uploadId = saved.id;
            this.resumeKey = key;
            this.stage = 'storage';
            localStorage.setItem(key, JSON.stringify(saved));
          },
          put,
          onProgress: (loaded, total) =>
            progress({
              name: file.name,
              size: file.size,
              loaded: Math.round((loaded / total) * file.size),
              phase: 'uploading',
            }),
        });
        localStorage.removeItem(key);
        this.uploadId = undefined;
        progress({ name: file.name, size: file.size, loaded: file.size, phase: 'done' });
        return item;
      } catch (e) {
        if (!this.uploadId && target.kind === 'keep-both' && isNameConflict(e) && n <= 50) continue;
        this.controller.abort();
        if (permanentUploadError(e)) await this.cancel().catch(() => {});
        throw e;
      }
    }
  }

}
