import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

/** The drive a folder was chosen on, so another drive mounted in its place is never taken for it. */
export type Volume = { root: string; id: string };

/**
 * Where the drive holding this path is mounted, for drives that can be swapped: anything under
 * /Volumes on macOS; any drive letter but the system drive, or a \\server\share path, on
 * Windows; on Linux, the places drives are mounted: /media/<user>/<name> and
 * /run/media/<user>/<name> (desktop automounts), /media/<name> and /mnt/<name>. Null for the
 * startup disk.
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
  if (platform === 'linux') {
    const [, top, second, third, fourth] = localPath.split('/');
    if (top === 'run' && second === 'media' && third && fourth)
      return `/run/media/${third}/${fourth}`;
    if (top === 'media' && second)
      return second !== userName()
        ? `/media/${second}`
        : third
          ? `/media/${second}/${third}`
          : null;
    return top === 'mnt' && second ? `/mnt/${second}` : null;
  }
  return null;
}
function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER;
  }
}

/** How the drive is named to the user: its volume name on macOS and Linux, its letter on Windows. */
export function volumeLabel(root: string) {
  if (/^[A-Z]:\\$/i.test(root)) return root.slice(0, 2);
  return root.startsWith('\\\\') ? root.slice(0, -1) : path.basename(root);
}

const run = promisify(execFile);
const NETWORK_FS = new Set(['smbfs', 'afpfs', 'nfs', 'webdav', 'cifs']);
const LINUX_NETWORK_FS = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  '9p',
  'ceph',
  'glusterfs',
  'davfs',
  'fuse.sshfs',
  'fuse.rclone',
]);
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
/** Linux's mount table, read from the kernel: it never touches the drives or shares. */
async function linuxMounts() {
  const text = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
  // Spaces and other awkward characters in paths are written as octal escapes (\040).
  const unescape = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
  return text.split('\n').flatMap((line) => {
    // id parent major:minor root mountpoint options [optional…] - type source superoptions
    const fields = line.split(' ');
    const dash = fields.indexOf('-', 6);
    if (dash < 0) return [];
    return [
      { at: unescape(fields[4]), type: fields[dash + 1], source: unescape(fields[dash + 2]) },
    ];
  });
}
/** The mount at this exact place; when several are stacked there, the visible (last) one. */
const linuxMount = async (root: string) =>
  (await linuxMounts()).findLast((mount) => mount.at === root);

/**
 * Whether a drive is mounted at its place. On Linux the folder a drive is mounted on usually
 * stays behind when it is unmounted (always under /mnt), so the mount table decides.
 */
export async function volumeConnected(root: string): Promise<boolean> {
  if (process.platform === 'linux') return !!(await linuxMount(root));
  return !!(await stat(root).catch(() => null))?.isDirectory();
}

/**
 * Whether the drive is a network share. Those can stop responding rather than disappear, so
 * every look at them is time-limited, and they are rescanned less often.
 */
export async function isNetwork(root: string): Promise<boolean> {
  if (process.platform === 'linux')
    return LINUX_NETWORK_FS.has((await linuxMount(root))?.type ?? '');
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
/**
 * A stable id for the mounted drive: the volume serial on Windows, the volume UUID on macOS, the
 * file system UUID on Linux.
 */
export async function volumeId(root: string): Promise<string | null> {
  if (process.platform === 'linux') return linuxVolumeId(root);
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

/**
 * The UUID of the file system mounted at this place, found by matching its device against
 * /dev/disk/by-uuid. Null when nothing is mounted there, or for shares and file systems without
 * one: those are not checked.
 */
async function linuxVolumeId(root: string): Promise<string | null> {
  const mount = await linuxMount(root);
  if (!mount?.source.startsWith('/dev/')) return null;
  const device = await realpath(mount.source).catch(() => null);
  if (!device) return null;
  const directory = '/dev/disk/by-uuid';
  for (const uuid of await readdir(directory).catch(() => [])) {
    if ((await realpath(path.join(directory, uuid)).catch(() => null)) === device) return uuid;
  }
  return null;
}

/** Where a drive is mounted now, if it is connected at all. */
export async function findVolume(id: string): Promise<string | null> {
  const roots =
    process.platform === 'win32'
      ? [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => `${letter}:\\`)
      : process.platform === 'linux'
        ? (await linuxMounts()).map((mount) => mount.at)
        : (await readdir('/Volumes').catch(() => [])).map((name) => `/Volumes/${name}`);
  for (const root of roots)
    if (volumeRoot(root) === root && (await volumeId(root)) === id) return root;
  return null;
}
