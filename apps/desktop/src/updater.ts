// Updates the installed Mac or Windows app from the latest GitHub release.
//
// The app is ad-hoc signed, so Squirrel.Mac (and electron-updater on top of it) won't accept it.
// Instead the release DMG is downloaded and checked against GitHub's SHA-256, its harbor0.app is
// copied next to the running bundle and checked, and a detached script swaps the bundles once
// the app has quit and opens the new one.
//
// On Windows the release's NSIS installer is downloaded and checked the same way, and a detached
// PowerShell script runs it silently over the installed app once the app has quit. The installer
// keeps the existing install location and opens the app when it is done.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { access, constants, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

export const RELEASES_URL = 'https://api.github.com/repos/anirban1809/harbor0/releases/latest';
const BUNDLE_ID = 'com.harbor.storage';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALL_MS = 60_000;

export type UpdateStatus = {
  current: string;
  state:
    | 'unsupported'
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'installing'
    | 'failed';
  /** Why this build can't update itself. */
  reason?: string;
  latest?: { version: string; bytes: number; releaseUrl: string };
  received?: number;
  error?: string;
  checkedAt?: number;
};

type Release = {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: { name: string; size: number; digest?: string | null; browser_download_url: string }[];
};
type Asset = { url: string; bytes: number; sha256: string; name: string };

/** -1, 0 or 1 as `a` is older than, the same as, or newer than `b` (x.y.z only). */
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The release's installer for this computer, if it has one with a checksum. */
export function releaseAsset(release: Release, arch: string, platform = 'darwin'): Asset | null {
  const version = release.tag_name.replace(/^v/, '');
  const name =
    platform === 'win32'
      ? `harbor0-${version}-win-${arch}.exe`
      : `harbor0-${version}-mac-${arch}.dmg`;
  const asset = release.assets.find((a) => a.name === name);
  const sha256 = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (!asset || !sha256) return null;
  return { url: asset.browser_download_url, bytes: asset.size, sha256, name };
}

/** Waits for the app to quit, swaps in the new bundle (restoring the old one on failure), and opens it. */
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; bundle="$2"; staged="$3"; opener="$4"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 3000 ] && exit 1
  sleep 0.1
done
old="$(dirname "$bundle")/.harbor0-previous-$$.app"
if mv "$bundle" "$old"; then
  if mv "$staged" "$bundle"; then
    rm -rf "$old"
  else
    mv "$old" "$bundle"
    rm -rf "$staged"
  fi
else
  rm -rf "$staged"
fi
"$opener" "$bundle"
rm -f "$0"
`;

/**
 * Waits for the app to quit, runs the installer silently over it (the installer opens the app
 * again), and opens the old app if the installer fails or is refused elevation.
 */
export const WINDOWS_INSTALL_SCRIPT = `param([int]$AppPid, [string]$Installer, [string]$App)
$deadline = (Get-Date).AddMinutes(5)
try {
  while (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { exit 1 }
    Start-Sleep -Milliseconds 100
  }
  try {
    $setup = Start-Process -FilePath $Installer -ArgumentList '/S', '--updated', '--force-run' -Wait -PassThru
    $installed = $setup.ExitCode -eq 0
  } catch {
    $installed = $false
  }
  if (-not $installed) { Start-Process -FilePath $App }
} finally {
  Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

export type UpdaterOptions = {
  current: string;
  /**
   * Path of the running harbor0.app, or of harbor0.exe in its install folder on Windows, or why
   * this build can't update itself.
   */
  bundle: { path: string; platform?: 'darwin' | 'win32' } | { unsupported: string };
  arch: string;
  onChange: (status: UpdateStatus) => void;
  /** Called once the new app is in place; it must stop work and quit. */
  quit: () => Promise<void>;
  fetch?: typeof fetch;
  run?: (command: string, args: string[]) => Promise<string>;
  launch?: (script: string, args: string[]) => void;
  opener?: string;
  temp?: string;
};

const runFile = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    ),
  );
const launchDetached = (script: string, args: string[]) =>
  (script.endsWith('.ps1')
    ? spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          script,
          ...args,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
    : spawn('/bin/sh', [script, ...args], { detached: true, stdio: 'ignore' })
  ).unref();

export class Updater {
  status: UpdateStatus;
  private asset: Asset | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<UpdateStatus>;
  private readonly fetch: typeof fetch;
  private readonly run: NonNullable<UpdaterOptions['run']>;
  private readonly launch: NonNullable<UpdaterOptions['launch']>;

  constructor(private readonly options: UpdaterOptions) {
    this.fetch = options.fetch ?? fetch;
    this.run = options.run ?? runFile;
    this.launch = options.launch ?? launchDetached;
    this.status =
      'unsupported' in options.bundle
        ? { current: options.current, state: 'unsupported', reason: options.bundle.unsupported }
        : { current: options.current, state: 'idle' };
  }

  /** Checks shortly after start and then every six hours. */
  start() {
    if (this.status.state === 'unsupported') return;
    setTimeout(() => void this.check().catch(() => {}), 10_000).unref?.();
    this.timer = setInterval(() => void this.check().catch(() => {}), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  check(): Promise<UpdateStatus> {
    if (this.status.state === 'unsupported' || this.busy) return Promise.resolve(this.status);
    this.checking ??= this.lookup().finally(() => (this.checking = undefined));
    return this.checking;
  }

  private get platform() {
    const bundle = this.options.bundle;
    return ('platform' in bundle && bundle.platform) || 'darwin';
  }

  private get busy() {
    return this.status.state === 'downloading' || this.status.state === 'installing';
  }

  private set(status: Partial<UpdateStatus>, replace = false) {
    this.status = replace
      ? ({ current: this.options.current, ...status } as UpdateStatus)
      : { ...this.status, ...status };
    this.options.onChange(this.status);
  }

  private async lookup() {
    const previous = this.status;
    this.set({ state: 'checking', error: undefined });
    try {
      const response = await this.fetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'harbor0-desktop' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
      const release = (await response.json()) as Release;
      const version = release.tag_name.replace(/^v/, '');
      const asset =
        !release.draft && !release.prerelease && compareVersions(version, this.options.current) > 0
          ? releaseAsset(release, this.options.arch, this.platform)
          : null;
      this.asset = asset;
      this.set(
        asset
          ? {
              state: 'available',
              latest: { version, bytes: asset.bytes, releaseUrl: release.html_url },
              checkedAt: Date.now(),
            }
          : { state: 'current', checkedAt: Date.now() },
        true,
      );
    } catch (error) {
      // A failed background check keeps showing what was last known.
      this.set({
        ...previous,
        state: previous.state === 'available' ? 'available' : 'failed',
        error: `Couldn't check for updates: ${(error as Error).message}`,
      });
    }
    return this.status;
  }

  /** Downloads and stages the update, then hands over to the swap script and quits. */
  async install() {
    const bundleOption = this.options.bundle;
    const asset = this.asset;
    const latest = this.status.latest;
    if ('unsupported' in bundleOption) throw new Error(bundleOption.unsupported);
    if (this.busy) throw new Error('The update is already being installed.');
    if (!asset || !latest) throw new Error('No update is available.');
    if (this.platform === 'win32') return this.installWindows(bundleOption.path, asset);
    const bundle = bundleOption.path;
    const parent = path.dirname(bundle);
    let work: string | undefined;
    const staged = path.join(parent, `.harbor0-update-${randomUUID()}.app`);
    let handedOver = false;
    try {
      try {
        await access(parent, constants.W_OK);
        await access(bundle, constants.W_OK);
      } catch {
        throw new Error(
          `harbor0 can't replace itself in ${parent}. Move it to your Applications folder, open it from there, and try again.`,
        );
      }
      work = await mkdtemp(path.join(this.options.temp ?? os.tmpdir(), 'harbor0-update-'));
      this.set({ state: 'downloading', received: 0, error: undefined });
      const dmg = path.join(work, asset.name);
      await this.download(asset, dmg);

      this.set({ state: 'installing' });
      const mount = path.join(work, 'mount');
      await this.run('hdiutil', [
        'attach',
        dmg,
        '-nobrowse',
        '-readonly',
        '-noautoopen',
        '-mountpoint',
        mount,
      ]);
      try {
        const app = (await readdir(mount)).find((name) => name.endsWith('.app'));
        if (!app) throw new Error('The downloaded installer has no app in it.');
        await this.run('ditto', [path.join(mount, app), staged]);
      } finally {
        await this.run('hdiutil', ['detach', mount, '-force']).catch(() => {});
      }
      const plist = path.join(staged, 'Contents', 'Info.plist');
      const read = async (key: string) =>
        (await this.run('plutil', ['-extract', key, 'raw', '-o', '-', plist])).trim();
      if ((await read('CFBundleIdentifier')) !== BUNDLE_ID)
        throw new Error('The downloaded app is not harbor0.');
      if ((await read('CFBundleShortVersionString')) !== latest.version)
        throw new Error(`The downloaded app is not version ${latest.version}.`);
      await this.run('codesign', ['--verify', '--deep', '--strict', staged]);
      // The app quits right after the hand-over, before `finally` could run.
      await rm(work, { recursive: true, force: true });

      const script = path.join(work, '..', `harbor0-update-${randomUUID()}.sh`);
      await writeFile(script, SWAP_SCRIPT, { mode: 0o700 });
      this.launch(script, [
        String(process.pid),
        bundle,
        staged,
        this.options.opener ?? '/usr/bin/open',
      ]);
      handedOver = true;
      await this.options.quit();
    } catch (error) {
      if (!handedOver) await rm(staged, { recursive: true, force: true });
      this.set({ state: 'failed', error: (error as Error).message });
      throw error;
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Downloads the installer, then hands it to the install script and quits. */
  private async installWindows(app: string, asset: Asset) {
    const temp = this.options.temp ?? os.tmpdir();
    const id = randomUUID();
    const installer = path.join(temp, `harbor0-update-${id}.exe`);
    let handedOver = false;
    try {
      this.set({ state: 'downloading', received: 0, error: undefined });
      await this.download(asset, installer);
      this.set({ state: 'installing' });
      const script = path.join(temp, `harbor0-update-${id}.ps1`);
      await writeFile(script, WINDOWS_INSTALL_SCRIPT);
      this.launch(script, [String(process.pid), installer, app]);
      handedOver = true;
      await this.options.quit();
    } catch (error) {
      if (!handedOver) await rm(installer, { force: true });
      this.set({ state: 'failed', error: (error as Error).message });
      throw error;
    }
  }

  private async download(asset: Asset, file: string) {
    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), STALL_MS);
    const response = await this.fetch(asset.url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    let received = 0;
    let reported = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), STALL_MS);
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
        if (Date.now() - reported > 250) {
          reported = Date.now();
          this.set({ received });
        }
      }
      out.end();
      await once(out, 'finish');
    } catch (error) {
      out.destroy();
      throw controller.signal.aborted ? new Error('The download stalled. Try again.') : error;
    } finally {
      clearTimeout(stall);
    }
    this.set({ received });
    if (received !== asset.bytes || hash.digest('hex') !== asset.sha256)
      throw new Error('The download was incomplete or damaged. Try again.');
  }
}

/** The running app, when it is a packaged Mac app or an installed Windows app that can update itself. */
export function runningBundle(
  packaged: boolean,
  platform: string,
  execPath: string,
): UpdaterOptions['bundle'] {
  if (!packaged) return { unsupported: "Development builds don't update themselves." };
  if (platform === 'win32') {
    // Only the installer's copy can be updated by running the next installer over it.
    const folder = path.dirname(execPath);
    if (!existsSync(path.join(folder, 'Uninstall harbor0.exe')))
      return { unsupported: 'Install harbor0 with its installer to get updates in the app.' };
    return { path: execPath, platform: 'win32' };
  }
  if (platform !== 'darwin')
    return { unsupported: 'Download new versions of harbor0 from the harbor0 website.' };
  const bundle = path.resolve(execPath, '..', '..', '..');
  if (!bundle.endsWith('.app')) return { unsupported: "harbor0 can't find its app bundle." };
  return { path: bundle };
}
