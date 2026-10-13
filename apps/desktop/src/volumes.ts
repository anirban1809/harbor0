import path from 'node:path';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

/** The drive a folder was chosen on, so another drive mounted in its place is never taken for it. */
export type Volume = { root: string; id: string };

/**
 * Where the drive holding this path is mounted, for drives that can be swapped: anything under
 * /Volumes on macOS; any drive letter but the system drive, or a \\server\share path, on
 * Windows. Null for the startup disk.
 */
export function volumeRoot(localPath: string, platform = process.platform): string | null {
  if (platform === 'win32') {
    const root = path.win32.parse(localPath).root.toUpperCase();
    // A network path (\\server\share\) is its own volume.
    if (/^\\\\[^\\]+\\[^\\]+\\$/.test(root)) return root;
    if (!/^[A-Z]:\\$/.test(root)) return null;
    return root === `${(process.env.SystemDrive ?? 'C:').toUpperCase()}\\` ? null : root;
  }
  if (platform === 'darwin') {
    const [, top, name] = localPath.split('/');
    return top === 'Volumes' && name ? `/Volumes/${name}` : null;
  }
  return null;
}

/** How the drive is named to the user: its volume name on macOS, its letter on Windows. */
export function volumeLabel(root: string) {
  if (/^[A-Z]:\\$/i.test(root)) return root.slice(0, 2);
  return root.startsWith('\\\\') ? root.slice(0, -1) : path.basename(root);
}

const run = promisify(execFile);
const NETWORK_FS = new Set(['smbfs', 'afpfs', 'nfs', 'webdav', 'cifs']);
let mounts: { at: number; text: Promise<string> } | undefined;
/** The mount table (macOS) or mapped drives (Windows); neither touches the shares themselves. */
function mountTable() {
  if (!mounts || Date.now() - mounts.at > 30_000) {
    const command: [string, string[]] =
      process.platform === 'win32' ? ['net', ['use']] : ['/sbin/mount', []];
    const text = run(...command, { timeout: 10_000 }).then(
      ({ stdout }) => stdout,
      () => '',
    );
    mounts = { at: Date.now(), text };
  }
  return mounts.text;
}
/**
 * Whether the drive is a network share. Those can stop responding rather than disappear, so
 * every look at them is time-limited, and they are rescanned less often.
 */
export async function isNetwork(root: string): Promise<boolean> {
  if (process.platform === 'win32') {
    if (root.startsWith('\\\\')) return true;
    const letter = root.slice(0, 2).toUpperCase();
    return (await mountTable())
      .split(/\r?\n/)
      .some((line) => new RegExp(`(^|\\s)${letter}\\s+\\\\\\\\`, 'i').test(line));
  }
  if (process.platform !== 'darwin') return false;
  const line = (await mountTable()).split('\n').find((l) => l.includes(` on ${root} (`));
  return NETWORK_FS.has(line?.match(/ \(([^,)]+)/)?.[1] ?? '');
}

const known = new Map<string, { key: string; id: string | null }>();
/** A stable id for the mounted drive: the volume serial on Windows, the volume UUID on macOS. */
export async function volumeId(root: string): Promise<string | null> {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return null;
  // Node reports the volume serial number as the device id on Windows.
  if (process.platform === 'win32') return info.dev ? info.dev.toString(16).padStart(8, '0') : null;
  if (process.platform !== 'darwin') return null;
  // diskutil is slow; ask again only when something else is mounted there.
  const key = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  const cached = known.get(root);
  if (cached?.key === key) return cached.id;
  let id: string | null = null;
  try {
    const { stdout } = await run('diskutil', ['info', '-plist', root], { timeout: 10_000 });
    const value = (name: string) =>
      stdout.match(new RegExp(`<key>${name}</key>\\s*<string>([^<]+)</string>`))?.[1];
    id = value('VolumeUUID') ?? value('DiskUUID') ?? null;
  } catch {
    // Network shares and some file systems have no id; they are not checked.
  }
  known.set(root, { key, id });
  return id;
}

/** Where a drive is mounted now, if it is connected at all. */
export async function findVolume(id: string): Promise<string | null> {
  const roots =
    process.platform === 'win32'
      ? [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`)
      : (await readdir('/Volumes').catch(() => [])).map((name) => `/Volumes/${name}`);
  for (const root of roots)
    if (volumeRoot(root) === root && (await volumeId(root)) === id) return root;
  return null;
}
