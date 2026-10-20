import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASES_URL,
  SWAP_SCRIPT,
  TEST_RELEASES_URL,
  Updater,
  compareVersions,
  isTestVersion,
  runningBundle,
  type UpdateStatus,
} from '../src/updater';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'harbor-updater-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const installer = Buffer.from('a new harbor0 installer');
const sha256 = createHash('sha256').update(installer).digest('hex');
function release(
  version: string,
  extra: Partial<{ digest: string | null; arch: string; windows: boolean }> = {},
) {
  const asset = (name: string) => ({
    name,
    size: installer.length,
    digest: extra.digest === undefined ? `sha256:${sha256}` : extra.digest,
    browser_download_url: `https://github.com/download/${name}`,
  });
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/anirban1809/harbor0/releases/tag/v${version}`,
    assets: [
      asset(`harbor0-${version}-mac-${extra.arch ?? 'arm64'}.dmg`),
      ...(extra.windows ? [asset(`harbor0-${version}-win-${extra.arch ?? 'x64'}.exe`)] : []),
    ],
  };
}
function github(latest: object, body: Buffer = installer, recent: object[] = [latest]) {
  return vi.fn(async (url: string | URL | Request) =>
    String(url) === RELEASES_URL
      ? Response.json(latest)
      : String(url) === TEST_RELEASES_URL
        ? Response.json(recent)
        : new Response(new Uint8Array(body)),
  ) as unknown as typeof fetch;
}
const testRelease = (version: string) => ({ ...release(version), prerelease: true });

it('compares versions numerically', () => {
  expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
  expect(compareVersions('v0.2.0', '0.10.0')).toBe(-1);
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
});

it('orders test builds before the release they lead up to', () => {
  expect(compareVersions('0.1.9-test', '0.1.8')).toBe(1);
  expect(compareVersions('0.1.9-test', '0.1.9')).toBe(-1);
  expect(compareVersions('0.1.9-test.2', '0.1.9-test')).toBe(1);
  expect(compareVersions('0.1.9-test.10', '0.1.9-test.9')).toBe(1);
  expect(compareVersions('v0.1.9-test.1', '0.1.9-test')).toBe(0);
  expect(isTestVersion('0.1.9-test.2')).toBe(true);
  expect(isTestVersion('0.1.9')).toBe(false);
});

it('never offers a test build to a production build', async () => {
  const fetch = github(testRelease('0.1.9-test'), installer, [testRelease('0.1.9-test')]);
  const updater = new Updater({
    current: '0.1.8',
    bundle: { path: '/Applications/harbor0.app' },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch,
  });
  expect((await updater.check()).state).toBe('current');
  // Even one GitHub reports as the latest release without the pre-release mark.
  const unmarked = new Updater({
    current: '0.1.8',
    bundle: { path: '/Applications/harbor0.app' },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch: github(release('0.1.9-test')),
  });
  expect((await unmarked.check()).state).toBe('current');
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([RELEASES_URL]);
});

it.each([
  ['the next test build', [release('0.1.8'), testRelease('0.1.9-test.2')], '0.1.9-test.2'],
  ['the release it was testing', [release('0.1.9'), testRelease('0.1.9-test.2')], '0.1.9'],
  [
    'the newest of several',
    [testRelease('0.1.9-test.3'), testRelease('0.1.9-test.2')],
    '0.1.9-test.3',
  ],
])('offers a test build %s', async (_, recent, expected) => {
  const fetch = github(release('0.1.8'), installer, recent);
  const updater = new Updater({
    current: '0.1.9-test',
    bundle: { path: '/Applications/harbor0.app' },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch,
  });
  expect(await updater.check()).toMatchObject({
    state: 'available',
    latest: { version: expected },
  });
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(TEST_RELEASES_URL);
});

it('keeps a test build when nothing newer has an installer', async () => {
  const updater = new Updater({
    current: '0.1.9-test.2',
    bundle: { path: '/Applications/harbor0.app' },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch: github(release('0.1.8'), installer, [
      testRelease('0.1.9-test'),
      release('0.1.8'),
      { ...release('0.1.9'), draft: true },
      release('0.1.10', { arch: 'x64' }),
    ]),
  });
  expect((await updater.check()).state).toBe('current');
});

it('finds the Mac bundle only for packaged Mac builds', () => {
  expect(runningBundle(true, 'darwin', '/Applications/harbor0.app/Contents/MacOS/harbor0')).toEqual(
    { path: path.resolve('/Applications/harbor0.app') },
  );
  expect(runningBundle(false, 'darwin', '/x')).toHaveProperty('unsupported');
  expect(runningBundle(true, 'linux', '/opt/harbor0/harbor0')).toHaveProperty('unsupported');
});

it('updates a Windows app only when it was installed with the installer', async () => {
  const exe = path.join(directory, 'harbor0.exe');
  expect(runningBundle(true, 'win32', exe)).toEqual({
    unsupported: expect.stringContaining('installer'),
  });
  await writeFile(path.join(directory, 'Uninstall harbor0.exe'), '');
  expect(runningBundle(true, 'win32', exe)).toEqual({ path: exe, platform: 'win32' });
  expect(runningBundle(false, 'win32', exe)).toHaveProperty('unsupported');
});

it('reports a newer release that has an installer for this Mac', async () => {
  const changes: UpdateStatus[] = [];
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: '/Applications/harbor0.app' },
    arch: 'arm64',
    onChange: (status) => changes.push(status),
    quit: async () => {},
    fetch: github(release('0.1.7')),
  });
  const status = await updater.check();
  expect(status).toMatchObject({
    state: 'available',
    latest: { version: '0.1.7', bytes: installer.length },
  });
  expect(changes.map((c) => c.state)).toEqual(['checking', 'available']);
});

it.each([
  ['the same version', release('0.1.6')],
  ['an older version', release('0.1.5')],
  ['no installer for this Mac', release('0.1.7', { arch: 'x64' })],
  ['no checksum', release('0.1.7', { digest: null })],
])('stays current for %s', async (_, latest) => {
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: '/Applications/harbor0.app' },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch: github(latest),
  });
  expect((await updater.check()).state).toBe('current');
});

it('offers the Windows installer to a Windows app', async () => {
  const windows = (latest: object) =>
    new Updater({
      current: '0.1.6',
      bundle: { path: 'C:\\harbor0\\harbor0.exe', platform: 'win32' },
      arch: 'x64',
      onChange: () => {},
      quit: async () => {},
      fetch: github(latest),
    });
  expect((await windows(release('0.1.7')).check()).state).toBe('current');
  expect(await windows(release('0.1.7', { windows: true })).check()).toMatchObject({
    state: 'available',
    latest: { version: '0.1.7', bytes: installer.length },
  });
});

it('keeps an available update when a later check fails', async () => {
  let fail = false;
  const ok = github(release('0.1.7'));
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: '/Applications/harbor0.app' },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch: (async (url: string) =>
      fail ? new Response(null, { status: 503 }) : ok(url)) as typeof fetch,
  });
  await updater.check();
  fail = true;
  expect(await updater.check()).toMatchObject({
    state: 'available',
    latest: { version: '0.1.7' },
    error: expect.stringContaining('503'),
  });
});

/** A fake harbor0.app beside a fake running one, with stubbed hdiutil, ditto, plutil and codesign. */
async function installSetup(
  options: { body?: Buffer; version?: string; bundleId?: string; codesign?: boolean } = {},
) {
  const apps = path.join(directory, 'Applications');
  const bundle = path.join(apps, 'harbor0.app');
  await mkdir(bundle, { recursive: true });
  const commands: string[] = [];
  const launched: string[][] = [];
  // What is left in the temp folder when the app quits; the app exits before any later cleanup.
  const leftAtQuit: string[] = [];
  const quit = vi.fn(async () => {
    leftAtQuit.push(...(await readdir(directory)).filter((n) => n.startsWith('harbor0-update-')));
  });
  const run = vi.fn(async (command: string, args: string[]) => {
    commands.push(command === 'ditto' ? command : `${command} ${args[0]}`);
    if (command === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1];
      await mkdir(path.join(mount, 'harbor0.app', 'Contents'), { recursive: true });
      await mkdir(path.join(mount, 'Applications'), { recursive: true });
    }
    if (command === 'ditto') await mkdir(args[1], { recursive: true });
    if (command === 'plutil')
      return args[1] === 'CFBundleIdentifier'
        ? (options.bundleId ?? 'com.harbor.storage')
        : (options.version ?? '0.1.7');
    if (command === 'codesign' && options.codesign === false)
      throw new Error('code object is not signed at all');
    return '';
  });
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: bundle },
    arch: 'arm64',
    onChange: () => {},
    quit,
    fetch: github(release('0.1.7'), options.body),
    run,
    launch: (script, args) => launched.push([script, ...args]),
    temp: directory,
  });
  await updater.check();
  return { updater, apps, bundle, commands, launched, quit, leftAtQuit };
}

it('downloads, verifies and stages the update, then hands over to the swap script and quits', async () => {
  const { updater, apps, bundle, commands, launched, quit, leftAtQuit } = await installSetup();
  await updater.install();
  expect(commands).toEqual([
    'hdiutil attach',
    'ditto',
    'hdiutil detach',
    'plutil -extract',
    'plutil -extract',
    'codesign --verify',
  ]);
  expect(launched).toHaveLength(1);
  const [script, pid, target, staged, opener] = launched[0];
  expect(await readFile(script, 'utf8')).toBe(SWAP_SCRIPT);
  expect([pid, target, opener]).toEqual([String(process.pid), bundle, '/usr/bin/open']);
  expect(path.dirname(staged)).toBe(apps);
  expect(existsSync(staged)).toBe(true);
  expect(quit).toHaveBeenCalledOnce();
  // Only the swap script is left: the installer and mount point are gone before the app quits.
  expect(leftAtQuit).toEqual([path.basename(script)]);
});

it.each([
  ['a damaged download', { body: Buffer.from('tampered installer bytes') }, 'damaged'],
  ['another app', { bundleId: 'com.example.other' }, 'not harbor0'],
  ['the wrong version', { version: '0.1.8' }, 'not version 0.1.7'],
  ['a broken signature', { codesign: false }, 'not signed'],
])('refuses %s and leaves the installed app alone', async (_, options, message) => {
  const { updater, apps, launched, quit } = await installSetup(options);
  await expect(updater.install()).rejects.toThrow(message);
  expect(updater.status).toMatchObject({
    state: 'failed',
    error: expect.stringContaining(message),
  });
  expect(await readdir(apps)).toEqual(['harbor0.app']);
  expect(launched).toEqual([]);
  expect(quit).not.toHaveBeenCalled();
});

it('asks to move the app when it cannot replace itself', async () => {
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: '/Volumes/harbor0/harbor0.app' },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch: github(release('0.1.7')),
  });
  await updater.check();
  await expect(updater.install()).rejects.toThrow('Move it to your Applications folder');
});

async function windowsSetup(body?: Buffer) {
  const launched: string[][] = [];
  const quit = vi.fn(async () => {});
  const app = path.join(directory, 'Programs', 'harbor0', 'harbor0.exe');
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: app, platform: 'win32' },
    arch: 'x64',
    onChange: () => {},
    quit,
    fetch: github(release('0.1.7', { windows: true }), body),
    launch: (script, args) => launched.push([script, ...args]),
    temp: directory,
  });
  await updater.check();
  return { updater, app, launched, quit };
}

it('downloads the Windows installer, then starts it silently and quits', async () => {
  const { updater, launched, quit } = await windowsSetup();
  await updater.install();
  expect(launched).toHaveLength(1);
  const [setup, ...args] = launched[0];
  expect(args).toEqual(['/S', '--updated', '--force-run']);
  expect(path.dirname(setup)).toBe(directory);
  expect(await readFile(setup)).toEqual(installer);
  expect(quit).toHaveBeenCalledOnce();
  expect(updater.status.state).toBe('installing');
});

it('removes installers left over from earlier Windows updates when it starts', async () => {
  const { updater } = await windowsSetup();
  const id = '6a478879-0ca1-4ae4-9ec9-a3c75cdda44b';
  for (const name of [`harbor0-update-${id}.exe`, `harbor0-update-${id}.ps1`, 'other.exe'])
    await writeFile(path.join(directory, name), '');
  updater.start();
  updater.stop();
  await vi.waitFor(async () => expect(await readdir(directory)).toEqual(['other.exe']));
});

it('refuses a damaged Windows installer and removes it', async () => {
  const { updater, launched, quit } = await windowsSetup(Buffer.from('tampered installer bytes'));
  await expect(updater.install()).rejects.toThrow('damaged');
  expect(await readdir(directory)).toEqual([]);
  expect(launched).toEqual([]);
  expect(quit).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')(
  'swap script replaces the bundle once the app exits, then opens it',
  async () => {
    const apps = path.join(directory, 'Applications');
    const bundle = path.join(apps, 'harbor0.app');
    const staged = path.join(apps, '.harbor0-update-x.app');
    await mkdir(bundle, { recursive: true });
    await writeFile(path.join(bundle, 'version'), 'old');
    await mkdir(staged);
    await writeFile(path.join(staged, 'version'), 'new');
    const opened = path.join(directory, 'opened');
    const opener = path.join(directory, 'open.sh');
    await writeFile(opener, `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
    const script = path.join(directory, 'swap.sh');
    await writeFile(script, SWAP_SCRIPT, { mode: 0o700 });
    // Stands in for the running app: the swap waits for it to exit.
    const app = spawn('sleep', ['0.5']);
    const swap = spawn('/bin/sh', [script, String(app.pid), bundle, staged, opener]);
    const code = await new Promise((resolve) => swap.on('exit', resolve));
    expect(code).toBe(0);
    expect(app.exitCode).toBe(0);
    expect(await readFile(path.join(bundle, 'version'), 'utf8')).toBe('new');
    expect(await readdir(apps)).toEqual(['harbor0.app']);
    expect((await readFile(opened, 'utf8')).trim()).toBe(bundle);
    expect(existsSync(script)).toBe(false);
  },
);

it('downloads a new version in the background, then restarts into it only when asked', async () => {
  const apps = path.join(directory, 'Applications');
  const bundle = path.join(apps, 'harbor0.app');
  await mkdir(bundle, { recursive: true });
  const launched: string[][] = [];
  const quit = vi.fn(async () => {});
  const states: string[] = [];
  let latest = release('0.1.7');
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: bundle },
    arch: 'arm64',
    autoDownload: true,
    onChange: (status) => {
      if (states.at(-1) !== status.state) states.push(status.state);
    },
    quit,
    fetch: (async (url: string) => github(latest)(url)) as typeof fetch,
    run: async (command: string, args: string[]) => {
      if (command === 'hdiutil' && args[0] === 'attach')
        await mkdir(path.join(args[args.indexOf('-mountpoint') + 1], 'harbor0.app'), {
          recursive: true,
        });
      if (command === 'ditto') await mkdir(args[1], { recursive: true });
      if (command === 'plutil')
        return args[1] === 'CFBundleIdentifier' ? 'com.harbor.storage' : latest.tag_name.slice(1);
      return '';
    },
    launch: (script, args) => launched.push([script, ...args]),
    temp: directory,
  });
  await updater.check();
  await vi.waitFor(() => expect(updater.status.state).toBe('ready'));
  expect(states).toEqual(['checking', 'available', 'downloading', 'ready']);
  const staged = (await readdir(apps)).find((name) => name.startsWith('.harbor0-update-'));
  expect(staged).toBeDefined();
  // Nothing is installed until the person restarts.
  expect(launched).toEqual([]);
  expect(quit).not.toHaveBeenCalled();

  // A later check finding the same version keeps it ready, without downloading again.
  await updater.check();
  expect(updater.status).toMatchObject({ state: 'ready', latest: { version: '0.1.7' } });

  // A newer version replaces the staged one.
  latest = release('0.1.8');
  await updater.check();
  await vi.waitFor(() =>
    expect(updater.status).toMatchObject({ state: 'ready', latest: { version: '0.1.8' } }),
  );
  const now = (await readdir(apps)).filter((name) => name.startsWith('.harbor0-update-'));
  expect(now).toHaveLength(1);
  expect(now[0]).not.toBe(staged);

  await updater.restart();
  expect(launched).toHaveLength(1);
  expect(launched[0]!.slice(2, 4)).toEqual([bundle, path.join(apps, now[0]!)]);
  expect(quit).toHaveBeenCalledOnce();
  expect(updater.status.state).toBe('installing');
});

it('removes staged apps left by sessions that quit without restarting', async () => {
  const apps = path.join(directory, 'Applications');
  const bundle = path.join(apps, 'harbor0.app');
  const left = path.join(apps, '.harbor0-update-6a478879-0ca1-4ae4-9ec9-a3c75cdda44b.app');
  await mkdir(bundle, { recursive: true });
  await mkdir(left);
  await mkdir(path.join(apps, 'Other.app'));
  const updater = new Updater({
    current: '0.1.6',
    bundle: { path: bundle },
    arch: 'arm64',
    onChange: () => {},
    quit: async () => {},
    fetch: github(release('0.1.6')),
  });
  updater.start();
  updater.stop();
  await vi.waitFor(async () =>
    expect((await readdir(apps)).sort()).toEqual(['Other.app', 'harbor0.app']),
  );
});

it('refuses to restart before an update is ready', async () => {
  const { updater } = await installSetup();
  await expect(updater.restart()).rejects.toThrow('No update is ready yet.');
});
