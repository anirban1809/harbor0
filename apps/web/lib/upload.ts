import { ApiClient } from '@harbor/api-client';
import type { CompletedPart, DriveItem } from '@harbor/contracts';
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
function put(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      signal.removeEventListener('abort', abort);
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error('The storage upload failed. Retry to resume.'));
    };
    xhr.onerror = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Network interrupted. Retry to resume.'));
    };
    xhr.onabort = () => reject(new DOMException('Paused', 'AbortError'));
    xhr.send(blob);
  });
}
export class BrowserUpload {
  controller = new AbortController();
  uploadId?: string;
  constructor(
    private api: ApiClient,
    private userId: string,
  ) {}
  pause() {
    this.controller.abort();
  }
  async cancel() {
    this.pause();
    if (this.uploadId) await this.api.request(`/v1/uploads/${this.uploadId}`, { method: 'DELETE' });
  }
  async run(
    file: File,
    parentId: string | null,
    progress: (p: UploadProgress) => void,
  ): Promise<DriveItem> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    progress({ name: file.name, size: file.size, loaded: 0, phase: 'hashing' });
    const contentHash = await hashFile(file, signal);
    const key = `harbor-upload:${this.userId}:${parentId ?? 'root'}:${contentHash}:${file.name}`;
    let saved = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      id: string;
      partSizeBytes: number;
    } | null;
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
    if (!saved) {
      const result = await this.api.createUpload({
        operationId: crypto.randomUUID(),
        parentId,
        name: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
        contentHash,
      });
      saved = { id: result.upload.id, partSizeBytes: result.upload.partSizeBytes };
      localStorage.setItem(key, JSON.stringify(saved));
    }
    this.uploadId = saved.id;
    const session = saved;
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
      const { item } = await this.api.complete(
        session.id,
        parts.sort((a, b) => a.partNumber - b.partNumber),
        contentHash,
      );
      localStorage.removeItem(key);
      progress({ name: file.name, size: file.size, loaded: file.size, phase: 'done' });
      return item;
    } catch (e) {
      this.controller.abort();
      throw e;
    }
  }
}
