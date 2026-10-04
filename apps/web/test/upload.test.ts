import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@harbor/api-client';
import {
  BrowserUpload,
  numberedName,
  permanentUploadError,
  uploadErrorMessage,
} from '../lib/upload';

class FakeWorker {
  onmessage?: (e: { data: { hash: string } }) => void;
  postMessage() {
    queueMicrotask(() => this.onmessage?.({ data: { hash: 'a'.repeat(64) } }));
  }
  terminate() {}
}
class FakeXhr {
  status = 200;
  upload: { onprogress?: (e: { loaded: number }) => void } = {};
  onload?: () => void;
  open() {}
  getResponseHeader() {
    return '"etag"';
  }
  send() {
    queueMicrotask(() => this.onload?.());
  }
}
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

function fakeApi(options: { create?: (input: any) => void; complete?: () => unknown }) {
  const calls: { method: string; path: string }[] = [];
  const created: any[] = [];
  const api = {
    request: vi.fn(async (path: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', path });
      return { upload: { state: 'UPLOADING' }, parts: [] };
    }),
    createUpload: vi.fn(async (input: any) => {
      created.push(input);
      options.create?.(input);
      return { upload: { id: 'up1', partSizeBytes: 1024 } };
    }),
    parts: vi.fn(async () => ({ parts: [{ partNumber: 1, uploadUrl: 'https://r2/put' }] })),
    complete: vi.fn(async () => options.complete?.() ?? { item: { id: 'item1' } }),
  };
  return { api: api as any, calls, created };
}
const file = new File(['hello'], 'Report.pdf', { type: 'application/pdf' });

describe('upload helpers', () => {
  it('numbers a kept copy before its extension', () => {
    expect(numberedName('Report.pdf', 2)).toBe('Report (2).pdf');
    expect(numberedName('archive.tar.gz', 3)).toBe('archive.tar (3).gz');
    expect(numberedName('README', 2)).toBe('README (2)');
    expect(numberedName('.env', 2)).toBe('.env (2)');
  });
  it('treats conflicts and lost access as permanent, but not network or rate limits', () => {
    expect(permanentUploadError(new ApiError('REVISION_CONFLICT', 'x', 409))).toBe(true);
    expect(permanentUploadError(new ApiError('FORBIDDEN', 'x', 403))).toBe(true);
    expect(permanentUploadError(new ApiError('RATE_LIMITED', 'x', 429))).toBe(false);
    expect(permanentUploadError(new ApiError('UNAUTHORIZED', 'x', 401))).toBe(false);
    expect(permanentUploadError(new ApiError('INTERNAL', 'x', 500))).toBe(false);
    expect(permanentUploadError(new Error('Network interrupted.'))).toBe(false);
  });
  it('blames the shared folder’s owner when their storage is full', () => {
    expect(uploadErrorMessage(new ApiError('OWNER_STORAGE_FULL', 'Storage full', 409))).toBe(
      'The owner of this shared folder is out of storage.',
    );
    expect(uploadErrorMessage(new ApiError('STORAGE_QUOTA_EXCEEDED', 'x', 409))).toMatch(
      /Your storage is full/,
    );
    expect(uploadErrorMessage(new ApiError('ODD', 'Server said so.', 400))).toBe('Server said so.');
  });
});

describe('BrowserUpload', () => {
  it('releases the reserved storage when completing hits a conflict', async () => {
    const { api, calls } = fakeApi({
      complete: () => {
        throw new ApiError('REVISION_CONFLICT', 'File changed before upload started.', 409);
      },
    });
    await expect(new BrowserUpload(api, 'u1').run(file, 'folder', () => {})).rejects.toThrow(
      /File changed/,
    );
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/uploads/up1' });
    expect(store.size).toBe(0);
  });
  it('keeps a transient failure resumable', async () => {
    const { api, calls } = fakeApi({
      complete: () => {
        throw new Error('Network interrupted. Retry to resume.');
      },
    });
    await expect(new BrowserUpload(api, 'u1').run(file, null, () => {})).rejects.toThrow();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(store.size).toBe(1);
  });
  it('cancel aborts the server upload and forgets the resume point', async () => {
    const { api, calls } = fakeApi({
      complete: () => {
        throw new Error('Network interrupted.');
      },
    });
    const upload = new BrowserUpload(api, 'u1');
    await expect(upload.run(file, null, () => {})).rejects.toThrow();
    await upload.cancel();
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/uploads/up1' });
    expect(store.size).toBe(0);
  });
  it('uploads a replacement as a new version of the existing file', async () => {
    const { api, created } = fakeApi({});
    await new BrowserUpload(api, 'u1').run(file, 'folder', () => {}, {
      kind: 'replace',
      item: { id: 'existing', revision: 7 },
    });
    expect(created[0]).toMatchObject({ driveItemId: 'existing', baseRevision: 7 });
  });
  it('keeps both by trying numbered names until one is free', async () => {
    const { api, created } = fakeApi({
      create: (input) => {
        if (input.name !== 'Report (3).pdf')
          throw new ApiError('NAME_CONFLICT', 'An item with this name already exists.', 409);
      },
    });
    await new BrowserUpload(api, 'u1').run(file, null, () => {}, { kind: 'keep-both' });
    expect(created.map((input) => input.name)).toEqual([
      'Report.pdf',
      'Report (2).pdf',
      'Report (3).pdf',
    ]);
  });
  it('does not rename a plain upload on a name conflict', async () => {
    const { api, created } = fakeApi({
      create: () => {
        throw new ApiError('NAME_CONFLICT', 'An item with this name already exists.', 409);
      },
    });
    await expect(new BrowserUpload(api, 'u1').run(file, null, () => {})).rejects.toMatchObject({
      code: 'NAME_CONFLICT',
    });
    expect(created).toHaveLength(1);
  });
});
