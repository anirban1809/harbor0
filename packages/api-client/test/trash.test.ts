import { expect, it, vi } from 'vitest';
import { ApiClient } from '../src';

it('empties all pages even when a page contains no trash', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ count: 0, nextCursor: 'second' })
    .mockResolvedValueOnce({ count: 10, nextCursor: 'third' })
    .mockResolvedValueOnce({ count: 1, nextCursor: null });
  await new ApiClient(request).emptyTrash();
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls.map(([, init]) => init.body.cursor)).toEqual([
    undefined,
    'second',
    'third',
  ]);
  expect(new Set(request.mock.calls.map(([, init]) => init.body.operationId)).size).toBe(3);
  for (const [path, init] of request.mock.calls) {
    expect(path).toBe('/v1/drive/trash/empty');
    expect(init.method).toBe('POST');
  }
});

it('reports a failed batch instead of claiming the trash is empty', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ count: 10, nextCursor: 'second' })
    .mockRejectedValueOnce(new Error('Connection lost'));
  await expect(new ApiClient(request).emptyTrash()).rejects.toThrow('Connection lost');
  expect(request).toHaveBeenCalledTimes(2);
});
