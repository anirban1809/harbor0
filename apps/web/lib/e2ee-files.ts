import { ApiError, type ApiClient } from '@harbor/api-client';
import type { CompletedPart, DriveItem } from '@harbor/contracts';
import {
  CHUNK_SIZE,
  FileCipher,
  HEADER_SIZE,
  b64url,
  encryptName,
  encryptedSize,
  isEncryptedName,
  fromB64url,
  plainSize,
  sha256Stream,
  type AccountKeys,
} from '../../../packages/api-client/src/e2ee';
import { TEXT_PREVIEW_BYTES, type TextPreview } from '../../../packages/api-client/src/preview';
import { requireKeys } from './e2ee-vault';
import { guessMime } from './e2ee-transport';

/** Plaintext bytes [begin, end) of a stored file. */
export type PlainReader = {
  size: number;
  read: (begin: number, end: number) => Promise<Uint8Array>;
};

/** Byte ranges of a download link, signing a new link when the old one expires. */
export function rangeFetcher(first: string, renew: () => Promise<string>) {
  let url = first;
  return async (begin: number, end: number, signal?: AbortSignal) => {
    if (end <= begin) return new Uint8Array();
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        headers: { Range: `bytes=${begin}-${end - 1}` },
        signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if ((response.status === 403 || response.status === 400) && attempt === 0) {
        url = await renew();
        continue;
      }
      if (!response.ok) throw new Error(`The download failed (${response.status}). Try again.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Storage that ignores Range sends the whole file.
      return response.status === 200 ? bytes.subarray(begin, end) : bytes;
    }
  };
}

/** Opens an encrypted file version for reading, decrypting only the ranges asked for. */
export async function openEncrypted(
  api: ApiClient,
  input: { driveItemId: string; versionId?: string },
  keys: AccountKeys = requireKeys(),
): Promise<PlainReader> {
  const link = await api.download(input);
  const fetchRange = rangeFetcher(
    link.downloadUrl,
    async () => (await api.download(input)).downloadUrl,
  );
  const cipher = await FileCipher.open(keys, await fetchRange(0, HEADER_SIZE));
  const size = plainSize(link.sizeBytes);
  return {
    size,
    read: async (begin, end) => {
      end = Math.min(end, size);
      if (end <= begin) return new Uint8Array();
      const r = cipher.cipherRange(size, begin, end);
      return cipher.decryptRange(size, begin, end, await fetchRange(r.start, r.end));
    },
  };
}

/** Reads a whole file in large windows, for downloads and previews. */
export async function readAll(
  reader: PlainReader,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
  write?: (bytes: Uint8Array) => Promise<void>,
) {
  const window = 4 * CHUNK_SIZE;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 0; at < reader.size || (at === 0 && !parts.length); at += window) {
    signal?.throwIfAborted();
    const bytes = (await reader.read(at, Math.min(reader.size, at + window))).slice();
    if (write) await write(bytes);
    else parts.push(bytes);
    onProgress?.(Math.min(reader.size, at + window));
    if (reader.size === 0) break;
  }
  return parts;
}

export const isEncrypted = (item: Pick<DriveItem, 'encrypted'>) => item.encrypted === true;

/** A decrypted preview: text for text files, an object URL for everything else. */
export async function encryptedPreview(api: ApiClient, item: DriveItem, text: boolean) {
  const reader = await openEncrypted(api, { driveItemId: item.id });
  if (text) {
    const bytes = await reader.read(0, Math.min(reader.size, TEXT_PREVIEW_BYTES));
    return {
      text: new TextDecoder().decode(bytes),
      truncated: reader.size > TEXT_PREVIEW_BYTES,
    } satisfies TextPreview;
  }
  const blob = new Blob(await readAll(reader), { type: item.mimeType ?? guessMime(item.name) });
  return { url: URL.createObjectURL(blob) };
}

// Larger downloads stream straight to disk where the browser can; others are built in memory.
const STREAM_ABOVE = 256 * 1024 * 1024;
type SavePicker = (options: { suggestedName: string }) => Promise<{
  createWritable: () => Promise<{
    write: (b: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

/** Downloads and decrypts a file in the browser, then saves it under its real name. */
export async function saveEncrypted(
  api: ApiClient,
  item: Pick<DriveItem, 'id' | 'name' | 'mimeType'>,
  versionId?: string,
  onProgress?: (loaded: number, total: number) => void,
) {
  const reader = await openEncrypted(api, { driveItemId: item.id, versionId });
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker && reader.size > STREAM_ABOVE) {
    let handle;
    try {
      handle = await picker({ suggestedName: item.name });
    } catch {
      return false;
    }
    const out = await handle.createWritable();
    await readAll(
      reader,
      (n) => onProgress?.(n, reader.size),
      undefined,
      (b) => out.write(b),
    );
    await out.close();
    return true;
  }
  const blob = new Blob(await readAll(reader, (n) => onProgress?.(n, reader.size)), {
    type: item.mimeType ?? guessMime(item.name),
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = item.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export type EncryptedUploadInput = {
  api: ApiClient;
  keys: AccountKeys;
  source: PlainReader;
  name: string;
  parentId: string | null;
  /** A new version of this item instead of a new file. */
  replace?: Pick<DriveItem, 'id' | 'revision'>;
  signal: AbortSignal;
  onProgress: (storedLoaded: number, storedTotal: number) => void;
  /** Saves what resuming after a reload needs; called once the upload exists. */
  onCreated?: (resume: EncryptedResume) => void;
  resume?: EncryptedResume;
  /** Stored-byte PUT of one part; returns its ETag. */
  put: (
    url: string,
    data: Blob,
    signal: AbortSignal,
    onProgress: (n: number) => void,
  ) => Promise<string>;
};
export type EncryptedResume = { id: string; partSizeBytes: number; header: string };

/**
 * Uploads a file encrypted. Parts are encrypted in order so the stored bytes' SHA-256 is known
 * at the end without reading the file twice; up to two parts upload while the next is sealed.
 * Encryption is deterministic for a header, so a resumed upload re-seals parts already sent
 * only to hash them.
 */
export async function uploadEncrypted(input: EncryptedUploadInput): Promise<DriveItem> {
  const { api, keys, source, signal } = input;
  const total = encryptedSize(source.size);
  let resume = input.resume;
  let cipher: FileCipher;
  if (resume) {
    try {
      const status = await api.request(`/v1/uploads/${resume.id}`);
      if (status.upload.state === 'COMPLETED') return status.upload.item;
      if (!['UPLOADING', 'COMPLETING'].includes(status.upload.state)) resume = undefined;
    } catch {
      resume = undefined;
    }
  }
  if (resume) cipher = await FileCipher.open(keys, fromB64url(resume.header));
  else {
    cipher = await FileCipher.create(keys);
    const created = await api.createUpload({
      operationId: crypto.randomUUID(),
      parentId: input.parentId,
      name: isEncryptedName(input.name) ? input.name : await encryptName(keys, input.name),
      sizeBytes: total,
      mimeType: 'application/octet-stream',
      encrypted: true,
      ...(input.replace
        ? { driveItemId: input.replace.id, baseRevision: input.replace.revision }
        : {}),
    });
    resume = {
      id: created.upload.id,
      partSizeBytes: created.upload.partSizeBytes,
      header: b64url(cipher.header),
    };
    input.onCreated?.(resume);
  }
  const session = resume;
  const status = await api.request(`/v1/uploads/${session.id}`);
  const done = new Map<number, string>(
    (status.parts ?? []).map((p: CompletedPart) => [p.partNumber, p.etag]),
  );
  const count = Math.max(1, Math.ceil(total / session.partSizeBytes));
  const hash = await sha256Stream();
  const inflight = new Map<number, number>();
  const partBytes = (n: number) =>
    Math.min(session.partSizeBytes, total - (n - 1) * session.partSizeBytes);
  const report = () => {
    let loaded = 0;
    for (const n of done.keys()) loaded += partBytes(n);
    for (const b of inflight.values()) loaded += b;
    input.onProgress(Math.min(total, loaded), total);
  };
  const running = new Set<Promise<void>>();
  let failure: unknown;
  for (let n = 1; n <= count; n++) {
    signal.throwIfAborted();
    if (failure) throw failure;
    const start = (n - 1) * session.partSizeBytes;
    const bytes = await cipher.encryptedRange(
      source.size,
      start,
      start + partBytes(n),
      source.read,
    );
    hash.update(bytes);
    if (done.has(n)) continue;
    while (running.size >= 2) await Promise.race(running);
    if (failure) throw failure;
    const job = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const { parts } = await api.parts(session.id, [n]);
          const etag = await input.put(
            parts[0].uploadUrl,
            new Blob([bytes.slice()]),
            signal,
            (b) => {
              inflight.set(n, b);
              report();
            },
          );
          inflight.delete(n);
          done.set(n, etag);
          report();
          return;
        } catch (e) {
          if (signal.aborted || attempt === 2 || (e instanceof ApiError && e.status < 500)) throw e;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    })().catch((e) => {
      failure ??= e;
    });
    running.add(job);
    void job.finally(() => running.delete(job));
  }
  await Promise.all(running);
  if (failure) throw failure;
  const parts = [...done.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([partNumber, etag]) => ({ partNumber, etag }));
  const { item } = await api.complete(session.id, parts, hash.hex());
  return item;
}

/** A local file as a plaintext source. */
export const fileSource = (file: Blob): PlainReader => ({
  size: file.size,
  read: async (b, e) => new Uint8Array(await file.slice(b, e).arrayBuffer()),
});
