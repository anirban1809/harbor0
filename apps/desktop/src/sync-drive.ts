import type { FileEntry } from '../../web/lib/file-metadata';

export type SyncDriveItem = FileEntry & {
  parentId: string | null;
  localId?: string;
  localOnly?: boolean;
  syncStatus?: 'Pending' | 'Syncing';
  syncDetail?: string;
  syncProgress?: number;
};

export const localSyncId = (rootId: string, relativePath: string) =>
  `local-sync:${encodeURIComponent(rootId)}:${encodeURIComponent(relativePath)}`;

// Match by cloud identity first, then by name while a new upload is being committed.
export function mergeSyncItems<T extends FileEntry>(
  cloud: T[],
  pending: SyncDriveItem[],
  parentId: string | null,
): (T | SyncDriveItem)[] {
  const result: (T | SyncDriveItem)[] = [...cloud];
  for (const item of pending.filter((entry) => entry.parentId === parentId)) {
    const index = result.findIndex(
      (entry) => entry.id === item.id || (entry.name === item.name && entry.type === item.type),
    );
    if (index < 0) result.push(item);
    else
      result[index] = {
        ...result[index],
        syncStatus: item.syncStatus,
        syncDetail: item.syncDetail,
        syncProgress: item.syncProgress,
      };
  }
  return result;
}
