import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ApiClient } from '@harbor/api-client';
import { downloadFile, uploadFile, type UploadState } from '../src/transfers';

let directory: string;
const checksum = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-transfers-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

function uploadApi(parts: { partNumber: number; etag: string }[] = []) {
  const batches: number[][] = [];
  const complete = vi.fn();
  const api = new ApiClient(async (endpoint, options) => {
    if (endpoint.endsWith('/parts')) {
      const numbers = (options?.body as { partNumbers: number[] }).partNumbers;
      batches.push(numbers);
      return {
        parts: numbers.map((n) => ({ partNumber: n, uploadUrl: `https://storage.test/${n}` })),
      };
    }
    if (endpoint.endsWith('/complete')) {
      complete(options?.body);
      return { item: { id: 'file' } };
    }
    if (endpoint === '/v1/uploads') return { upload: { id: 'upload', partSizeBytes: 4 } };
    return { upload: { state: 'UPLOADING' }, parts: [...parts] };
  });
  return { api, batches, complete };
}

it('uploads four parts concurrently, batches signing, and reports byte-accurate resumed progress', async () => {
  const source = Buffer.from('abcdefghijklmnopqrstuv');
  const filename = path.join(directory, 'upload');
  await writeFile(filename, source);
  const { api, batches, complete } = uploadApi([{ partNumber: 2, etag: 'existing' }]);
  let active = 0,
    peak = 0;
  const sent = new Map<number, Buffer>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      const n = Number(url.split('/').pop());
      sent.set(n, Buffer.from(options.body as Buffer));
      await delay(n === 1 ? 30 : 5);
      active--;
      return new Response(null, { headers: { etag: `part-${n}` } });
    }),
  );
  const progress: number[] = [];
  await uploadFile(
    api,
    filename,
    'upload',
    null,
    { operationId: 'op' },
    () => {},
    undefined,
    (n) => progress.push(n),
  );
  expect(peak).toBe(4);
  expect(batches).toEqual([[1, 3, 4, 5], [6]]);
  for (const [n, buffer] of sent) expect(buffer).toEqual(source.subarray((n - 1) * 4, n * 4));
  expect(progress[0]).toBe(4);
  expect(progress.at(-1)).toBe(source.length);
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
  expect(complete.mock.calls[0][0].parts.map((p: { partNumber: number }) => p.partNumber)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
});

it('waits for in-flight uploads after failure and preserves successful receipts for retry', async () => {
  const filename = path.join(directory, 'upload');
  await writeFile(filename, 'abcdefghijklmnop');
  const { api, complete } = uploadApi();
  let active = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      active++;
      await delay(url.endsWith('/1') ? 1 : 20);
      active--;
      if (url.endsWith('/1')) throw new TypeError('Connection reset');
      return new Response(null, { headers: { etag: url } });
    }),
  );
  const state: UploadState = { operationId: 'op' };
  await expect(uploadFile(api, filename, 'upload', null, state, () => {})).rejects.toThrow(
    'Connection reset',
  );
  expect(active).toBe(0);
  expect(state.parts?.map((p) => p.partNumber).sort()).toEqual([2, 3, 4]);
  expect(complete).not.toHaveBeenCalled();
});

function downloadApi(data: Buffer, hash = checksum(data)) {
  return new ApiClient(async () => ({
    downloadUrl: 'https://storage.test/file',
    sizeBytes: data.length,
    contentHash: hash,
  }));
}
function rangeResponse(data: Buffer, options: RequestInit) {
  const range = (options.headers as Record<string, string>).Range;
  const match = /bytes=(\d+)-(\d*)/.exec(range);
  const start = Number(match![1]);
  const end = match![2] ? Number(match![2]) : data.length - 1;
  return new Response(new Uint8Array(data.subarray(start, end + 1)), {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${data.length}` },
  });
}

it('downloads large files with bounded parallel ranges and verifies the complete checksum', async () => {
  const data = Buffer.alloc(42 * 1024 * 1024, 71);
  data[data.length - 1] = 19;
  let active = 0,
    peak = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return rangeResponse(data, options);
    }),
  );
  const destination = path.join(directory, 'download');
  const progress: number[] = [];
  const beforeReplace = vi.fn(async () => {
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  await downloadFile(downloadApi(data), {}, destination, (n) => progress.push(n), beforeReplace);
  expect(peak).toBe(4);
  expect(checksum(await readFile(destination))).toBe(checksum(data));
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
  expect(progress.at(-1)).toBe(data.length);
  expect(beforeReplace).toHaveBeenCalledOnce();
});

it('resumes only the contiguous prefix after an interrupted parallel download', async () => {
  const chunk = 8 * 1024 * 1024;
  const data = Buffer.alloc(34 * 1024 * 1024, 37);
  const destination = path.join(directory, 'download');
  await writeFile(destination, 'original');
  let fail = true;
  const starts: number[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      const start = Number(
        /bytes=(\d+)/.exec((options.headers as Record<string, string>).Range)![1],
      );
      starts.push(start);
      if (fail && start === 2 * chunk) throw new TypeError('Disconnected');
      return rangeResponse(data, options);
    }),
  );
  await expect(downloadFile(downloadApi(data), {}, destination)).rejects.toThrow('Disconnected');
  expect((await stat(destination + '.harbor-part')).size).toBe(2 * chunk);
  expect(await readFile(destination, 'utf8')).toBe('original');
  fail = false;
  starts.length = 0;
  await downloadFile(downloadApi(data), {}, destination);
  expect(Math.min(...starts)).toBe(2 * chunk);
  expect(checksum(await readFile(destination))).toBe(checksum(data));
});

it('falls back to streaming when storage ignores ranges, including a resumed file', async () => {
  const data = Buffer.alloc(18 * 1024 * 1024, 63);
  const destination = path.join(directory, 'download');
  await writeFile(destination + '.harbor-part', 'stale prefix');
  const fetcher = vi.fn(async () => new Response(data));
  vi.stubGlobal('fetch', fetcher);
  await downloadFile(downloadApi(data), {}, destination);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(checksum(await readFile(destination))).toBe(checksum(data));
});

it('rejects incorrect range metadata and never replaces the original file', async () => {
  const data = Buffer.alloc(18 * 1024 * 1024, 63);
  const destination = path.join(directory, 'download');
  await writeFile(destination, 'original');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('invalid', { status: 206, headers: { 'content-range': 'bytes 0-6/7' } }),
    ),
  );
  await expect(downloadFile(downloadApi(data), {}, destination)).rejects.toThrow(
    'unexpected download range',
  );
  expect(await readFile(destination, 'utf8')).toBe('original');
});

it('keeps the original file on checksum failure and handles empty files', async () => {
  const destination = path.join(directory, 'download');
  await writeFile(destination, 'original');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('bad')),
  );
  await expect(downloadFile(downloadApi(Buffer.from('new')), {}, destination)).rejects.toThrow(
    'integrity',
  );
  expect(await readFile(destination, 'utf8')).toBe('original');
  await expect(stat(destination + '.harbor-part')).rejects.toMatchObject({ code: 'ENOENT' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('')),
  );
  await downloadFile(downloadApi(Buffer.alloc(0)), {}, destination);
  expect((await stat(destination)).size).toBe(0);
});
