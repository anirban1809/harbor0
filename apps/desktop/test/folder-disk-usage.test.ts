import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { folderDiskUsage, FolderDiskUsageCache } from '../src/folder-disk-usage';

it('sums synced file sizes, skipping links, internal files, and excluded folders', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harbor-disk-size-'));
  try {
    const root = path.join(temp, 'root');
    await mkdir(path.join(root, '.hidden'), { recursive: true });
    await mkdir(path.join(root, 'skipped'));
    await writeFile(path.join(root, '.hidden', 'file'), Buffer.alloc(8193));
    await writeFile(path.join(root, 'note.txt'), 'abc');
    await writeFile(path.join(root, 'download.harbor-part'), Buffer.alloc(500));
    await writeFile(path.join(root, 'skipped', 'big'), Buffer.alloc(4096));
    await writeFile(path.join(temp, 'outside'), Buffer.alloc(1024 * 1024));
    await symlink(temp, path.join(root, 'outside-link'));
    expect(await folderDiskUsage(root, ['skipped'])).toBe(8193 + 3);
    expect(await folderDiskUsage(root)).toBe(8193 + 3 + 4096);
    await expect(folderDiskUsage(path.join(temp, 'missing'))).rejects.toThrow();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it('returns immediately, caches measurements, and refreshes changed or unavailable folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-disk-cache-'));
  const cache = new FolderDiskUsageCache();
  try {
    expect(cache.read(root)).toBeUndefined();
    const initial = await folderDiskUsage(root);
    await vi.waitFor(() => expect(cache.read(root)).toBe(initial));
    await writeFile(path.join(root, 'new'), Buffer.alloc(16384));
    expect(cache.read(root)).toBe(initial);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    const updated = await folderDiskUsage(root);
    expect(cache.read(root)).toBe(initial);
    await vi.waitFor(() => expect(cache.read(root)).toBe(updated));
    const missing = path.join(root, 'missing');
    expect(cache.read(missing)).toBeUndefined();
    await vi.waitFor(() => expect(cache.read(missing)).toBeNull());
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
