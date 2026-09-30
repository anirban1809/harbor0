import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { internalPath } from './paths';

/**
 * Total size of the files that sync, so every linked device reports the same figure. Allocated
 * blocks, directory entries, and files the engine ignores differ between filesystems and devices.
 */
export async function folderDiskUsage(directory: string, excluded: string[] = []): Promise<number> {
  const pending = [''];
  let bytes = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    const info = await lstat(path.join(directory, relative));
    if (info.isFile()) bytes += info.size;
    if (!info.isDirectory()) continue;
    const entries = await opendir(path.join(directory, relative));
    for await (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        !internalPath(child) &&
        !excluded.some((item) => child === item || child.startsWith(item + '/'))
      )
        pending.push(child);
    }
  }
  return bytes;
}

/** Status requests never wait for a filesystem scan; each folder refreshes at most once a minute. */
export class FolderDiskUsageCache {
  private entries = new Map<string, { bytes?: number | null; checked: number; pending: boolean }>();
  read(directory: string, excluded: string[] = []): number | null | undefined {
    const key = JSON.stringify([directory, excluded]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { checked: 0, pending: false };
      this.entries.set(key, entry);
    }
    if (!entry.pending && Date.now() - entry.checked >= 60_000) {
      entry.pending = true;
      const current = entry;
      void folderDiskUsage(directory, excluded)
        .then((bytes) => {
          current.bytes = bytes;
        })
        .catch(() => {
          current.bytes = null;
        })
        .finally(() => {
          current.checked = Date.now();
          current.pending = false;
        });
    }
    return entry.bytes;
  }
}
