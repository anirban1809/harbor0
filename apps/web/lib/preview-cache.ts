import { BrowserCache, onBrowserCacheClear } from './browser-cache';
import type { FileEntry } from './file-metadata';
import type { PreviewContent, PreviewLoader } from './file-preview';

let caches = new WeakMap<PreviewLoader, BrowserCache<PreviewContent>>();
onBrowserCacheClear(() => {
  caches = new WeakMap();
});
export function previewCache(load: PreviewLoader) {
  let cache = caches.get(load);
  if (!cache) caches.set(load, (cache = new BrowserCache<PreviewContent>(16, 30_000)));
  return cache;
}
export function previewCacheKey(scope: string, item: FileEntry) {
  return JSON.stringify([
    scope,
    item.ownerUserId,
    item.id,
    item.currentVersionId,
    item.revision,
    item.updatedAt,
    item.name,
    item.mimeType,
    item.sizeBytes,
  ]);
}
