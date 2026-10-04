import { ApiError } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
export type DriveLocation = 'Cloud' | 'Backup' | 'Sync';
// Resolve ancestry for deep links and search results, not just the current folder.
export function driveLocations(
  backupFolders: Map<string, string>,
  syncFolders: Set<string>,
  load: (id: string) => Promise<Pick<DriveItem, 'id' | 'parentId' | 'backupRootId'>>,
) {
  const cache = new Map<string, Promise<Pick<DriveItem, 'id' | 'parentId' | 'backupRootId'>>>();
  return async (
    item: Pick<DriveItem, 'id' | 'parentId' | 'backupRootId'>,
  ): Promise<{ location: DriveLocation; backupRootId?: string }> => {
    let current = item;
    let sync = false;
    const seen = new Set<string>();
    for (;;) {
      if (current.backupRootId || backupFolders.has(current.id))
        return {
          location: 'Backup',
          backupRootId: current.backupRootId ?? backupFolders.get(current.id),
        };
      if (syncFolders.has(current.id)) sync = true;
      if (!current.parentId) return { location: sync ? 'Sync' : 'Cloud' };
      if (seen.has(current.parentId) || seen.size >= 33)
        throw new Error('Could not identify this folder location.');
      seen.add(current.parentId);
      if (!cache.has(current.parentId)) cache.set(current.parentId, load(current.parentId));
      try {
        current = await cache.get(current.parentId)!;
      } catch (error) {
        // A folder shared from inside someone's private folder: the walk stops at the share.
        if (error instanceof ApiError && [403, 404].includes(error.status))
          return { location: sync ? 'Sync' : 'Cloud' };
        throw error;
      }
    }
  };
}
