import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';

/** Allocated disk space, including excluded/hidden files, without following symlinks. */
export async function folderDiskUsage(directory: string): Promise<number> {
  const pending = [directory];
  const seen = new Set<string>();
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const info = await lstat(current);
    const identity = `${info.dev}:${info.ino}`;
    if (info.ino && seen.has(identity)) continue;
    if (info.ino) seen.add(identity);
    bytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
    if (info.isDirectory()) {
      const entries = await opendir(current);
      for await (const entry of entries) pending.push(path.join(current, entry.name));
    }
  }
  return bytes;
}

/** Status requests never wait for a filesystem scan; each folder refreshes at most once a minute. */
export class FolderDiskUsageCache {
  private entries = new Map<string, { bytes?: number | null; checked: number; pending: boolean }>();
  read(directory: string): number | null | undefined {
    let entry = this.entries.get(directory);
    if (!entry) {
      entry = { checked: 0, pending: false };
      this.entries.set(directory, entry);
    }
    if (!entry.pending && Date.now() - entry.checked >= 60_000) {
      entry.pending = true;
      const current = entry;
      void folderDiskUsage(directory)
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
