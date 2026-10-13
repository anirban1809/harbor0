import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { DRIVE_SEGMENT } from './drive-dav';

const run = promisify(execFile);
const MOUNT_TIMEOUT_MS = 30_000;

/** The local WebDAV server as a drive in Finder or File Explorer. */
export type WebdavMount = { kind: 'finder' | 'explorer'; location: string };
export const canMount = () => process.platform === 'darwin' || process.platform === 'win32';

/** Where `mount` lists a WebDAV URL as mounted, or undefined. */
export function macMountPoint(listing: string, url: string) {
  for (const line of listing.split('\n')) {
    const match = /^(\S+) on (.+) \(webdav[,)]/.exec(line);
    if (match?.[1] === url) return match[2];
  }
  return undefined;
}

/**
 * Mounts the server in Finder with mount_webdav. The password is typed at its prompt through a
 * terminal that `script` provides, so it never appears in a process list; `-S` keeps the system
 * from showing dialogs, and unmounts the drive by itself if the server stops answering.
 */
export async function mountInFinder(options: {
  url: string;
  username: string;
  password: string;
  mountPoint: string;
}): Promise<WebdavMount> {
  const mounted = macMountPoint((await run('/sbin/mount')).stdout, options.url);
  if (mounted) return { kind: 'finder', location: mounted };
  await mkdir(options.mountPoint, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    // `script` needs a pipe for input, not the socket Node gives a child, hence `cat`.
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        'cat | /usr/bin/script -q /dev/null /sbin/mount_webdav -S -i -v "$0" "$1" "$2"',
        DRIVE_SEGMENT,
        options.url,
        options.mountPoint,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let answered = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (answered === 0 && /Username:\s*$/.test(output)) {
        child.stdin.write(options.username + '\n');
        answered = 1;
      } else if (answered === 1 && /Password:\s*$/.test(output)) {
        child.stdin.write(options.password + '\n');
        child.stdin.end();
        answered = 2;
      }
    });
    const timer = setTimeout(() => child.kill(), MOUNT_TIMEOUT_MS);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(new Error(`Finder couldn’t connect to the WebDAV server (mount_webdav ${code}).`));
    });
  });
  return { kind: 'finder', location: options.mountPoint };
}

/** The drive letter File Explorer has mapped to a WebDAV URL, as `Z:`, or undefined. */
export function windowsDrive(listing: string, url: string) {
  // `net use` shows http://127.0.0.1:6810/a/b as \\127.0.0.1@6810\a\b.
  const { hostname, port, pathname } = new URL(url);
  const unc = `\\\\${hostname}@${port || 80}${decodeURIComponent(pathname).replace(/\/+$/, '').replace(/\//g, '\\')}`;
  for (const line of listing.split(/\r?\n/)) {
    const match = /\b([A-Z]:)\s+(\\\\\S+)/i.exec(line);
    if (match && match[2]!.toLowerCase() === unc.toLowerCase()) return match[1]!.toUpperCase();
  }
  return undefined;
}

/**
 * Maps the server as a drive in File Explorer. Windows sends passwords over plain HTTP only after
 * a registry change, so this maps the server's secret mount path, which needs none.
 */
export async function mapInExplorer(url: string): Promise<WebdavMount> {
  const mapped = windowsDrive((await run('net', ['use'])).stdout, url);
  if (mapped) return { kind: 'explorer', location: mapped + '\\' };
  try {
    await run('net', ['use', '*', url, '/persistent:no'], { timeout: MOUNT_TIMEOUT_MS });
  } catch (error) {
    const text = String((error as { stderr?: string }).stderr ?? (error as Error).message);
    // System error 67: the WebClient service, which maps WebDAV drives, is off or missing.
    throw new Error(
      /\b67\b/.test(text)
        ? 'File Explorer can’t map WebDAV drives because the Windows WebClient service is off. Turn it on in Services, or use a WebDAV app instead.'
        : `File Explorer couldn’t map the WebDAV drive: ${text.trim().split(/\r?\n/).at(-1)}`,
    );
  }
  const drive = windowsDrive((await run('net', ['use'])).stdout, url);
  if (!drive) throw new Error('File Explorer mapped the drive, but harbor0 couldn’t find it.');
  return { kind: 'explorer', location: drive + '\\' };
}

/** Disconnects the drive; best effort, as it may already be gone. */
export async function unmount(mount: WebdavMount) {
  try {
    if (mount.kind === 'finder') {
      await run('/sbin/umount', [mount.location]).catch(() =>
        run('/usr/sbin/diskutil', ['unmount', 'force', mount.location]),
      );
      await rmdir(mount.location).catch(() => {});
    } else await run('net', ['use', mount.location.slice(0, 2), '/delete', '/y']);
  } catch {
    /* Already disconnected. */
  }
}
/** For quitting, which can't wait. */
export function unmountNow(mount: WebdavMount) {
  try {
    if (mount.kind === 'finder') execFileSync('/sbin/umount', [mount.location], { timeout: 5000 });
    else
      execFileSync('net', ['use', mount.location.slice(0, 2), '/delete', '/y'], { timeout: 5000 });
  } catch {
    /* Already disconnected, or it will be when the server stops answering. */
  }
}
