import type { FileEntry } from './file-metadata';
export const isSystemFile = (name: string) =>
  ['.ds_store', 'thumbs.db', 'desktop.ini'].includes(name.toLowerCase());
export type DriveFilters = {
  type: string;
  modified: string;
  sort: string;
  foldersFirst: boolean;
  showSystem: boolean;
};
export const defaultDriveFilters: DriveFilters = {
  type: 'all',
  modified: 'all',
  sort: 'modified-desc',
  foldersFirst: true,
  showSystem: false,
};
export function driveView<T extends FileEntry>(
  items: T[],
  filters: DriveFilters,
  now = Date.now(),
): T[] {
  const days = Number(filters.modified);
  const result = items.filter(
    (item) =>
      (filters.showSystem || !isSystemFile(item.name)) &&
      (filters.type === 'all' ||
        (filters.type === 'folders'
          ? item.type === 'FOLDER'
          : filters.type === 'files'
            ? item.type === 'FILE'
            : item.mimeType?.startsWith(filters.type + '/'))) &&
      (filters.modified === 'all' ||
        (!!item.updatedAt && new Date(item.updatedAt).getTime() >= now - days * 86400000)),
  );
  const [field, direction] = filters.sort.split('-');
  return result.sort((a, b) => {
    if (filters.foldersFirst && a.type !== b.type) return a.type === 'FOLDER' ? -1 : 1;
    const order =
      field === 'name'
        ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        : field === 'size'
          ? a.sizeBytes - b.sizeBytes
          : (Date.parse((field === 'created' ? a.createdAt : a.updatedAt) ?? '') || 0) -
            (Date.parse((field === 'created' ? b.createdAt : b.updatedAt) ?? '') || 0);
    return (direction === 'desc' ? -order : order) || a.name.localeCompare(b.name);
  });
}
