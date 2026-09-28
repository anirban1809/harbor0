import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../src';
import { prepareFolderDownload } from '../src/archive-download';
afterEach(() => vi.useRealTimers());
it('polls status and reports overall ZIP preparation without requesting file contents', async () => {
  vi.useFakeTimers();
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      id: 'job',
      state: 'BUILDING',
      files: 1,
      bytes: 40,
      totalBytes: 100,
      currentFile: 'hello',
    })
    .mockResolvedValueOnce({
      id: 'job',
      state: 'READY',
      downloadUrl: 'https://storage.test/zip',
      sizeBytes: 200,
    });
  const progress = vi.fn();
  const result = prepareFolderDownload(new ApiClient(request), 'folder', progress);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toMatchObject({ state: 'READY', sizeBytes: 200 });
  expect(progress).toHaveBeenCalledWith({
    phase: 'building',
    files: 1,
    bytes: 40,
    fileBytes: 40,
    fileSize: 100,
    currentFile: 'hello',
  });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    '/v1/folder-downloads',
    '/v1/folder-downloads/job',
  ]);
});
it('cancels the remote job when preparation is aborted', async () => {
  const controller = new AbortController();
  const request = vi.fn().mockResolvedValue({ id: 'job', state: 'QUEUED' });
  const result = prepareFolderDownload(
    new ApiClient(request),
    'folder',
    () => controller.abort(),
    controller.signal,
  );
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenLastCalledWith('/v1/folder-downloads/job', { method: 'DELETE' });
});
it('cancels even if the user aborts while the creation request is in flight', async () => {
  const controller = new AbortController();
  const request = vi.fn(async () => {
    controller.abort();
    return { id: 'job', state: 'QUEUED' };
  });
  await expect(
    prepareFolderDownload(new ApiClient(request), 'folder', undefined, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenLastCalledWith('/v1/folder-downloads/job', { method: 'DELETE' });
});
it('shows backend errors without beginning a download', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ state: 'FAILED', error: 'File content is unavailable.' });
  await expect(prepareFolderDownload(new ApiClient(request), 'folder')).rejects.toThrow(
    'File content is unavailable.',
  );
  expect(request).toHaveBeenCalledTimes(1);
});
