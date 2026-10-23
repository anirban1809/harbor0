import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WATCHER = 'org.kde.StatusNotifierWatcher';

/**
 * Whether the desktop shows tray icons. Linux trays are StatusNotifierItems, which appear only
 * while a StatusNotifierWatcher owns its D-Bus name: KDE, Cinnamon, XFCE and Ubuntu's GNOME do,
 * stock GNOME (Fedora, Debian) only with the AppIndicator extension. macOS and Windows always do.
 */
export async function trayShown(): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  const attempts: [string, string[], RegExp][] = [
    [
      'dbus-send',
      [
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.NameHasOwner',
        `string:${WATCHER}`,
      ],
      /boolean true/,
    ],
    [
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        WATCHER,
      ],
      /\(true,?\)/,
    ],
  ];
  for (const [command, args, shown] of attempts) {
    try {
      const { stdout } = await run(command, args, { timeout: 5_000 });
      return shown.test(stdout);
    } catch {
      // Not installed, or no session bus; try the next way of asking.
    }
  }
  return false;
}
