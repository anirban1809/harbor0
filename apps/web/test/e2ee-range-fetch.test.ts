import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINK_REUSE_MS, rangeFetcher } from '../lib/e2ee-files';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Storage that serves ranges of a 100-byte file for links in `valid`. */
function storage(valid: Set<string>) {
  const file = Uint8Array.from({ length: 100 }, (_, i) => i);
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    urls.push(url);
    // An expired link's 403 has no CORS headers, so the browser throws instead of answering.
    if (!valid.has(url)) throw new TypeError('Failed to fetch');
    const [begin, end] = (init.headers as Record<string, string>).Range.slice(6)
      .split('-')
      .map(Number);
    return new Response(file.slice(begin, end + 1), { status: 206 });
  });
  vi.stubGlobal('fetch', fetch);
  return { urls };
}

describe('download link renewal', () => {
  it('signs a new link before the old one is too old, once for parallel reads', async () => {
    vi.useFakeTimers();
    const { urls } = storage(new Set(['link-1', 'link-2']));
    const renew = vi.fn(async () => 'link-2');
    const read = rangeFetcher('link-1', renew);
    expect([...(await read(0, 3))]).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(LINK_REUSE_MS);
    await Promise.all([read(10, 12), read(20, 22)]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(urls).toEqual(['link-1', 'link-2', 'link-2']);
  });

  it('renews when an expired link shows up as a network error', async () => {
    const valid = new Set(['link-2']);
    const { urls } = storage(valid);
    const read = rangeFetcher('link-1', async () => 'link-2');
    expect([...(await read(5, 7))]).toEqual([5, 6]);
    expect(urls).toEqual(['link-1', 'link-2']);
  });

  it('gives up after one renewal when storage stays unreachable', async () => {
    storage(new Set());
    const renew = vi.fn(async () => 'link-2');
    await expect(rangeFetcher('link-1', renew)(0, 2)).rejects.toThrow('Failed to fetch');
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
