import { EventEmitter } from 'node:events';
import { watch, type FSWatcher, type Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

// Editors save in bursts (temp file, rename, metadata); report a path once it has settled.
const SETTLE_MS = 300;

export type TreeEvent = 'add' | 'addDir' | 'change' | 'unlink';
export interface TreeWatcher {
  on(event: TreeEvent, listener: (full: string, info?: Stats) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  close(): Promise<void>;
}

/**
 * One recursive OS watch per folder (FSEvents on macOS, ReadDirectoryChangesW on Windows).
 * Events only say "look here": every reported path is checked on disk, and a directory is
 * walked, so renames and bulk moves are seen even when the OS coalesces their events.
 * The engine's periodic full scan covers whatever happened while nothing was watching.
 */
export function watchTree(root: string, ignored: (full: string) => boolean): TreeWatcher {
  const emitter = new EventEmitter() as EventEmitter & TreeWatcher;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let watcher: FSWatcher | undefined;

  const report = async (full: string) => {
    if (closed || ignored(full)) return;
    let info: Stats;
    try {
      info = await lstat(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') emitter.emit('unlink', full);
      else emitter.emit('error', error);
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (full !== root) emitter.emit('addDir', full, info);
      await walk(full);
    } else if (info.isFile()) emitter.emit('change', full, info);
  };
  const walk = async (directory: string) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // The folder vanished mid-walk; its own event reports the removal.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') emitter.emit('error', error);
      return;
    }
    for (const entry of entries) {
      if (closed) return;
      const full = path.join(directory, entry.name);
      if (ignored(full) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        try {
          emitter.emit('addDir', full, await lstat(full));
        } catch {
          continue;
        }
        await walk(full);
      } else if (entry.isFile()) {
        try {
          emitter.emit('add', full, await lstat(full));
        } catch {
          /* Removed during the walk. */
        }
      }
    }
  };
  const flush = async () => {
    timer = undefined;
    const paths = [...pending];
    pending.clear();
    for (const full of paths) await report(full);
  };
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (closed) return;
      // Some platforms omit the name when many changes coalesce; look at everything.
      pending.add(filename ? path.join(root, filename.toString()) : root);
      // A fixed window, not a trailing debounce: a file written nonstop must still be seen.
      timer ??= setTimeout(() => void flush(), SETTLE_MS);
    });
    watcher.on('error', (error) => emitter.emit('error', error));
  } catch (error) {
    queueMicrotask(() => emitter.emit('error', error));
  }
  emitter.close = async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
  return emitter;
}
