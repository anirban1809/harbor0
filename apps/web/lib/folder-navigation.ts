import { ApiError, type ApiClient } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';

export async function loadFolderTrail(api: ApiClient, folderId: string, signal: AbortSignal) {
  const trail: { id: string; name: string }[] = [];
  const visited = new Set<string>();
  let id: string | null = folderId;
  while (id) {
    if (visited.has(id) || visited.size >= 32) throw new Error('Could not load the folder path.');
    visited.add(id);
    let item: DriveItem;
    try {
      ({ item } = await api.request(`/v1/drive/items/${encodeURIComponent(id)}`, { signal }));
    } catch (error) {
      // A shared folder can be accessible even when its ancestors are private.
      if (trail.length && error instanceof ApiError && [403, 404].includes(error.status)) break;
      throw error;
    }
    if (item.type !== 'FOLDER' || item.deletedAt) throw new Error('This folder is unavailable.');
    trail.unshift({ id: item.id, name: item.name });
    id = item.parentId;
  }
  return trail;
}
