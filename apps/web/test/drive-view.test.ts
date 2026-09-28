import { describe, expect, it } from 'vitest';
import { defaultDriveFilters, driveView, isSystemFile } from '../lib/drive-view';
import type { FileEntry } from '../lib/file-metadata';
const items: FileEntry[] = [
  {
    id: 'a',
    name: 'Old.md',
    type: 'FILE',
    sizeBytes: 99,
    updatedAt: '2026-01-01T00:00:00Z',
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: 'b',
    name: 'New.png',
    type: 'FILE',
    sizeBytes: 12,
    mimeType: 'image/png',
    updatedAt: '2026-09-27T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
  },
  { id: 'c', name: 'Projects', type: 'FOLDER', sizeBytes: 0, updatedAt: '2025-01-01T00:00:00Z' },
  { id: 'd', name: '.DS_Store', type: 'FILE', sizeBytes: 12 },
];
describe('Drive filtering and sorting', () => {
  it('hides only common system metadata and keeps normal dotfiles', () => {
    for (const name of ['.DS_Store', 'THUMBS.DB', 'desktop.ini'])
      expect(isSystemFile(name)).toBe(true);
    expect(isSystemFile('.env')).toBe(false);
    expect(driveView(items, defaultDriveFilters).map((item) => item.id)).toEqual(['c', 'b', 'a']);
    expect(items[0].id).toBe('a');
  });
  it('can show system files, disable folders first, and sort created or size independently', () => {
    expect(driveView(items, { ...defaultDriveFilters, showSystem: true })).toHaveLength(4);
    expect(
      driveView(items, { ...defaultDriveFilters, foldersFirst: false, sort: 'created-desc' }).map(
        (item) => item.id,
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(
      driveView(items, { ...defaultDriveFilters, foldersFirst: false, sort: 'size-desc' }).map(
        (item) => item.id,
      ),
    ).toEqual(['a', 'b', 'c']);
  });
  it('combines type and date filters', () => {
    expect(
      driveView(
        items,
        { ...defaultDriveFilters, type: 'image', modified: '7' },
        Date.parse('2026-09-27T12:00:00Z'),
      ).map((item) => item.id),
    ).toEqual(['b']);
    expect(
      driveView(
        items,
        { ...defaultDriveFilters, type: 'folders', modified: '7' },
        Date.parse('2026-09-27T12:00:00Z'),
      ),
    ).toEqual([]);
  });
});
