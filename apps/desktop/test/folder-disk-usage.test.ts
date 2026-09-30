import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, lstat, link, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { folderDiskUsage, FolderDiskUsageCache } from '../src/folder-disk-usage';

it('measures allocated space including hidden files without following links or double-counting hard links', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'harbor-disk-size-'));
  try {
    const root = path.join(temp, 'root');
    await mkdir(root);
    await mkdir(path.join(root, '.hidden'));
    await writeFile(path.join(root, '.hidden', 'file'), Buffer.alloc(8192));
    await writeFile(path.join(temp, 'outside'), Buffer.alloc(1024 * 1024));
    await link(path.join(root, '.hidden', 'file'), path.join(root, 'hard-link'));
    await symlink(temp, path.join(root, 'outside-link'));
    const entries = [
      root,
      path.join(root, '.hidden'),
      path.join(root, '.hidden', 'file'),
      path.join(root, 'outside-link'),
    ];
    const expected = (await Promise.all(entries.map((entry) => lstat(entry)))).reduce(
      (sum, info) => sum + info.blocks * 512,
      0,
    );
    expect(await folderDiskUsage(root)).toBe(expected);
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
