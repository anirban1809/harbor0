import { describe, expect, it } from 'vitest';
import { rendererRequestSchema } from '../src/request-schema';

describe('renderer request permissions', () => {
  it('allows My Drive to read synced folders with the default GET method', () => {
    expect(rendererRequestSchema.parse({ path: '/v1/sync/folders' })).toEqual({
      path: '/v1/sync/folders',
      method: 'GET',
    });
    expect(
      rendererRequestSchema.safeParse({ path: '/v1/sync/folders?cursor=next', method: 'GET' })
        .success,
    ).toBe(true);
    expect(rendererRequestSchema.safeParse({ path: '/v1/sync/status?ids=file' }).success).toBe(
      true,
    );
    expect(
      rendererRequestSchema.safeParse({ path: '/v1/sync/status?ids=file', method: 'POST' }).success,
    ).toBe(false);
    expect(
      rendererRequestSchema.safeParse({ path: '/v1/drive/folders/root/children' }).success,
    ).toBe(true);
    expect(
      rendererRequestSchema.safeParse({
        path: '/v1/drive/items/file',
        method: 'PATCH',
        body: { name: 'Notes' },
      }).success,
    ).toBe(true);
  });
  it('does not grant the renderer sync mutations or unrelated endpoints', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(rendererRequestSchema.safeParse({ path: '/v1/sync/folders', method }).success).toBe(
        false,
      );
    for (const path of [
      '/v1/sync/operations',
      '/v1/sync/items/file/acknowledge',
      '/v1/sync/items/file/request-content',
      '/v1/sync/checkpoints',
      '/v1/sync/changes',
      '/v1/sync/folders/child',
      '/v1/auth/session',
      '/v1/drive/../sync/operations',
      '/v1/drive/items#x',
      'https://example.test/v1/drive',
    ])
      expect(rendererRequestSchema.safeParse({ path }).success).toBe(false);
  });
});
