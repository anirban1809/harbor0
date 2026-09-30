import electronPath from 'electron';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url));

export async function developmentExecutable() {
  if (process.platform !== 'darwin') return electronPath as unknown as string;
  const source = path.resolve(electronPath as unknown as string, '../../..');
  const version = await readFile(path.resolve(source, '../version'), 'utf8');
  const directory = path.join(desktop, '.dev-runtime');
  const bundle = path.join(directory, 'harbor0 Development.app');
  const stamp = path.join(directory, 'version');
  const revision = `1:${version}`;
  try {
    if ((await readFile(stamp, 'utf8')) !== revision) throw new Error('Runtime changed');
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
      stdio: 'pipe',
    });
  } catch {
    await mkdir(directory, { recursive: true });
    await rm(bundle, { recursive: true, force: true });
    await cp(source, bundle, { recursive: true, verbatimSymlinks: true });
    const plist = path.join(bundle, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: 'com.harbor.storage.dev',
      CFBundleName: 'harbor0 Development',
      CFBundleDisplayName: 'harbor0 Development',
    })) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    }
    // UNUserNotificationCenter rejects Electron's unsealed development binary.
    // Sign a private copy; never alter the npm dependency or require a release key.
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {
      stdio: 'pipe',
    });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
      stdio: 'pipe',
    });
    await writeFile(stamp, revision);
  }
  return path.join(bundle, 'Contents/MacOS/Electron');
}
