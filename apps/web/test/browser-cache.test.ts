import { afterEach, expect, it, vi } from 'vitest';
import {
  BrowserCache,
  applyOptimisticItems,
  browserSession,
  clearBrowserCaches,
} from '../lib/browser-cache';
import { previewCacheKey } from '../lib/preview-cache';
afterEach(() => vi.useRealTimers());

it('deduplicates reads, expires values and bounds least recently used entries', async () => {
  vi.useFakeTimers();
  const cache = new BrowserCache<number>(2, 100);
  const fetch = vi.fn(async () => 1);
  expect(await Promise.all([cache.load('a', fetch), cache.load('a', fetch)])).toEqual([1, 1]);
  expect(fetch).toHaveBeenCalledTimes(1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toBe(1);
  vi.advanceTimersByTime(101);
  expect(cache.get('a')).toBeUndefined();
});

it('does not repopulate invalidated data when an old request finishes', async () => {
  const cache = new BrowserCache<string>();
  let resolve!: (value: string) => void;
  const stale = cache.load(
    'folder',
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  cache.clear();
  await cache.load('folder', async () => 'new');
  resolve('old');
  await stale;
  expect(cache.get('folder')).toBe('new');
});

it('retries failures and invalidated preview URLs rather than caching errors', async () => {
  const cache = new BrowserCache<string>();
  await expect(
    cache.load('preview', async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
  expect(await cache.load('preview', async () => 'url')).toBe('url');
  cache.delete('preview');
  expect(await cache.load('preview', async () => 'fresh-url')).toBe('fresh-url');
});

it('isolates users and transports and clears sessions on logout', () => {
  const transport = {};
  browserSession(transport, 'a').views.set('root', ['private']);
  expect(browserSession(transport, 'b').views.get('root')).toBeUndefined();
  expect(browserSession({}, 'a').views.get('root')).toBeUndefined();
  clearBrowserCaches();
  expect(browserSession(transport, 'a').views.get('root')).toBeUndefined();
});

it('keys previews by account and content version', () => {
  const item = { id: 'file', name: 'file.txt', sizeBytes: 2, type: 'FILE' as const, revision: 1 };
  expect(previewCacheKey('a', item)).not.toBe(previewCacheKey('b', item));
  expect(previewCacheKey('a', item)).not.toBe(previewCacheKey('a', { ...item, revision: 2 }));
});

it('keeps independent optimistic edits while rolling back only the failed item', () => {
  const original = [
    { id: 'a', name: 'A', parentId: null },
    { id: 'b', name: 'B', parentId: null },
  ];
  const changes = new Map([
    ['a', { item: { ...original[0], name: 'Renamed A' }, pending: true }],
    ['b', { item: { ...original[1], name: 'Renamed B' }, pending: false }],
  ]);
  changes.delete('a');
  expect(applyOptimisticItems(original, changes, null).map((item) => item.name)).toEqual([
    'A',
    'Renamed B',
  ]);
});

it('moves items out of the source and into the destination while preserving unrelated rows', () => {
  const item = { id: 'a', parentId: null as string | null };
  const changes = new Map([['a', { item: { ...item, parentId: 'destination' }, pending: true }]]);
  expect(applyOptimisticItems([item], changes, null)).toEqual([]);
  expect(applyOptimisticItems([], changes, 'destination')).toEqual([
    { ...item, parentId: 'destination' },
  ]);
  expect(
    applyOptimisticItems(
      [item],
      new Map([['a', { item: { ...item, deletedAt: 'today' }, pending: true }]]),
      null,
    ),
  ).toEqual([]);
});
it('prunes listings while keeping catalogs, and stops stale loads from repopulating', async () => {
  const cache = new BrowserCache<string>();
  cache.set('/v1/backups', 'catalog');
  cache.set('/v1/drive/folders/root/children', 'listing');
  let finish!: (value: string) => void;
  const inflight = cache.load('/v1/search?q=a', () => new Promise((r) => (finish = r)));
  await Promise.resolve();
  cache.prune((key) => key.startsWith('/v1/backups'));
  finish('stale');
  await inflight;
  expect(cache.get('/v1/backups')).toBe('catalog');
  expect(cache.get('/v1/drive/folders/root/children')).toBeUndefined();
  expect(cache.get('/v1/search?q=a')).toBeUndefined();
});
