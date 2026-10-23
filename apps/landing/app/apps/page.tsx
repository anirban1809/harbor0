import { ArrowDownToLine, ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { features } from '../features';
import { Shot } from '../shot';
import { appUrl, SignupButton, SiteFoot, SiteNav } from '../site-chrome';

type Download = { version: string; size: string; url: string; sha256: string };

// The published installers; `npm run release:desktop` updates them with each GitHub release.
const mac: Download | null = {
  version: '0.1.12',
  size: '132 MB',
  url: 'https://github.com/anirban1809/harbor0/releases/download/v0.1.12/harbor0-0.1.12-mac-arm64.dmg',
  sha256: '3c070302babd22f66c27672b44a8a25cf6986046e1d226e1f6c50276f164cb39',
};
const windows: Download | null = {
  version: '0.1.12',
  size: '115 MB',
  url: 'https://github.com/anirban1809/harbor0/releases/download/v0.1.12/harbor0-0.1.12-win-x64.exe',
  sha256: '81ccee34e164fcd40f6d2db35c21cad8329ac1b74f897e46f4219d10072b0aeb',
};

// x64 is the same build that Debian calls amd64 and Fedora calls x86_64.
const linuxDeb: Download | null = null;
const linuxRpm: Download | null = null;
const linuxAppImage: Download | null = null;
const linuxDebArm64: Download | null = null;
const linuxAppImageArm64: Download | null = null;
const linux: { package: string; for: string; arch: string; download: Download | null }[] = [
  { package: 'deb', for: 'Ubuntu, Debian, Mint', arch: 'x64', download: linuxDeb },
  { package: 'deb', for: 'Ubuntu, Debian, Mint', arch: 'arm64', download: linuxDebArm64 },
  { package: 'rpm', for: 'Fedora', arch: 'x64', download: linuxRpm },
  { package: 'AppImage', for: 'Most other distributions', arch: 'x64', download: linuxAppImage },
  {
    package: 'AppImage',
    for: 'Most other distributions',
    arch: 'arm64',
    download: linuxAppImageArm64,
  },
].filter((row) => row.download);
// Cast so the page type-checks while the Linux downloads are still null.
const linuxMain = linuxDeb as Download | null;

const computers = linuxMain
  ? 'on Mac, Windows and Linux'
  : windows
    ? 'on Mac and Windows'
    : 'on your Mac';

export const metadata: Metadata = {
  title: 'Apps — harbor0',
  description: `harbor0 in the browser and ${computers}.`,
};

const desktop: [string, string, string?][] = [
  ['Sync', 'Keep folders in step across your computers, and share a folder for two-way sync.'],
  ['Automatic backups', 'Save new versions of a folder as you work, and restore them in place.'],
  [
    'Incoming files',
    'Checks for files and invitations every 10 seconds, even with the window closed, and notifies you.',
  ],
  ['Your whole Drive', 'Browse, upload, preview and download, exactly as on the web.'],
  [
    'Local WebDAV',
    'Open My Drive in Finder or File Explorer, or connect Cyberduck or rclone, without syncing it. Only your computer can connect.',
    '/webdav',
  ],
  [
    'End-to-end encryption',
    'Sync, backups and WebDAV encrypt and decrypt on your computer. Enter your passphrase once per device.',
    '/encryption',
  ],
  ['Several accounts', 'Each account keeps its own sync folders and settings on the computer.'],
  ['Sign-in', 'Your password is never saved. The session is encrypted with the system keychain.'],
];
const installMac = [
  [
    'Install',
    'Download the disk image with the button above, open it, and drag harbor0 into Applications.',
  ],
  [
    'First open',
    'The beta build is not yet signed with Apple, so macOS stops it with “harbor0” Not Opened. Click Done, not Move to Bin.',
  ],
  [
    'Open Anyway',
    'In System Settings → Privacy & Security, scroll to Security and click Open Anyway next to harbor0, confirm with your password or Touch ID, then click Open. You only do this once.',
  ],
];
const installWindows = [
  ['Install', 'Download the installer with the button above and open it.'],
  [
    'SmartScreen',
    'The beta build is not yet code-signed, so Windows shows “Windows protected your PC”. Click More info, then Run anyway.',
  ],
  [
    'Finish',
    'Choose where to install harbor0, or keep the suggested folder. You only do this once: new versions install from Settings in the app.',
  ],
];
const installLinux = [
  [
    'Pick a package',
    'Ubuntu, Debian and Mint use the .deb, Fedora the .rpm. On anything else, the AppImage runs without installing.',
  ],
  [
    'Pick x64 or arm64',
    'x64 is for ordinary Intel and AMD PCs; it is the same build that Ubuntu calls amd64 and Fedora calls x86_64. arm64 is for ARM computers, including Linux VMs on Apple silicon Macs. Not sure? Run uname -m: x86_64 means x64, aarch64 means arm64.',
  ],
  [
    'Install',
    'Open a terminal in the download folder and run the command for your package below. The app doesn’t update itself on Linux yet: install a new version the same way.',
  ],
];
const sync = features.find(({ id }) => id === 'sync')!;

export default function AppsPage() {
  return (
    <main className="landing learn" style={{ '--tint': 'var(--primary)' } as CSSProperties}>
      <SiteNav />

      <section className="wrap learn-hero">
        <p className="label">Apps</p>
        <h1>harbor0 in the browser and {computers}.</h1>
        <div className="hero-foot">
          <p className="lede">
            Use it in the browser, and install the desktop app for sync and automatic backups.
          </p>
          <SignupButton />
        </div>
      </section>

      <section className="wrap section" id="get">
        <p className="label">01 — Get harbor0</p>
        <div
          className="get"
          style={
            {
              '--get-columns': 1 + Number(!!mac) + Number(!!windows) + Number(!!linuxMain),
            } as CSSProperties
          }
        >
          <div>
            <h3>Web</h3>
            <p>Any modern browser. Nothing to install.</p>
            <a href={appUrl} className="btn" data-variant="outline" data-size="md">
              Open the web app <ArrowUpRight />
            </a>
          </div>
          {mac && (
            <div>
              <h3>Mac</h3>
              <p>
                Version {mac.version} · Apple silicon · {mac.size}
              </p>
              <a href={mac.url} className="btn" data-variant="primary" data-size="md">
                <ArrowDownToLine /> Download for Mac
              </a>
            </div>
          )}
          {windows && (
            <div>
              <h3>Windows</h3>
              <p>
                Version {windows.version} · Windows 10 and 11, 64-bit · {windows.size}
              </p>
              <a href={windows.url} className="btn" data-variant="primary" data-size="md">
                <ArrowDownToLine /> Download for Windows
              </a>
            </div>
          )}
          {linuxMain && (
            <div>
              <h3>Linux</h3>
              <p>Version {linuxMain.version} · x64 and arm64 · deb, rpm and AppImage</p>
              <a href={linuxMain.url} className="btn" data-variant="primary" data-size="md">
                <ArrowDownToLine /> Download .deb (x64)
              </a>
              <a href="#install-linux" className="get-more">
                arm64, rpm and AppImage
              </a>
            </div>
          )}
        </div>
        <p className="fine">
          {linuxMain
            ? 'The desktop app is for Macs with Apple silicon, 64-bit Windows 10 and 11 (including Windows on Arm), and 64-bit Linux on x64 or arm64. Intel Macs are not available yet.'
            : windows
              ? 'The desktop app is for Macs with Apple silicon and for 64-bit Windows 10 and 11, including Windows on Arm. Intel Macs and Linux are not available yet.'
              : 'The desktop app is for Macs with Apple silicon. Intel Macs, Windows and Linux are not available yet.'}
        </p>
      </section>

      <section className="wrap section" id="desktop">
        <p className="label">02 — Desktop</p>
        <div className="learn-split">
          <div>
            <h2>The app that does the work in the background.</h2>
            <p>
              Sync and automatic backups need the desktop app. It keeps running after you close its
              window, so folders stay current and backups happen on their own.
            </p>
          </div>
          <Shot picture={sync} tint="var(--primary)" flat />
        </div>
        <dl className="details spaced">
          {desktop.map(([name, text, href], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{href ? <Link href={href}>{name}</Link> : name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      {[
        { id: 'install', name: 'on a Mac', download: mac, steps: installMac },
        { id: 'install-windows', name: 'on Windows', download: windows, steps: installWindows },
      ]
        .filter((platform) => platform.download)
        .map(({ id, name, download, steps }, index) => (
          <section className="wrap section" id={id} key={id}>
            <p className="label">
              {String(index + 3).padStart(2, '0')} — Install {name}
            </p>
            <ol className="steps">
              {steps.map(([title, text], step) => (
                <li key={title}>
                  <span>{String(step + 1).padStart(2, '0')}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
            <p className="fine">
              To verify the download, its SHA-256 checksum is <code>{download!.sha256}</code>
            </p>
          </section>
        ))}

      {linuxMain && (
        <section className="wrap section" id="install-linux">
          <p className="label">
            {String(3 + Number(!!mac) + Number(!!windows)).padStart(2, '0')} — Install on Linux
          </p>
          <ol className="steps">
            {installLinux.map(([title, text], step) => (
              <li key={title}>
                <span>{String(step + 1).padStart(2, '0')}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
          <div className="linux-downloads">
            {linux.map(({ package: kind, for: distros, arch, download }) => {
              const file = download!.url.split('/').pop()!;
              return (
                <div key={file}>
                  <div>
                    <h3>
                      {kind} · {arch}
                    </h3>
                    <p>
                      {distros} · {download!.size}
                    </p>
                  </div>
                  <code>
                    {kind === 'deb'
                      ? `sudo apt install ./${file}`
                      : kind === 'rpm'
                        ? `sudo dnf install ./${file}`
                        : `chmod +x ${file} && ./${file}`}
                  </code>
                  <a href={download!.url} className="btn" data-variant="outline" data-size="md">
                    <ArrowDownToLine /> Download
                  </a>
                </div>
              );
            })}
          </div>
          <p className="fine">
            Made for Ubuntu 22.04 and later, Debian 12 and later, and current Fedora. On GNOME,
            harbor0’s tray icon needs the AppIndicator extension (Ubuntu has it already); without
            it, closing the window asks whether to keep syncing in the background. The AppImage
            needs FUSE 2, which Ubuntu 22.04 and later leave out: install it with sudo apt install
            libfuse2t64 (libfuse2 on 22.04).
          </p>
          <p className="fine">
            To verify a download, its SHA-256 checksum is listed with it on the{' '}
            <a href={linuxMain.url.replace(/\/download\/(v[^/]+)\/.*$/, '/tag/$1')}>
              GitHub release
            </a>
            .
          </p>
        </section>
      )}

      <section className="wrap section learn-cta">
        <h2>10 GB free from 31 October. Join the waitlist today.</h2>
        <SignupButton />
      </section>

      <SiteFoot />
    </main>
  );
}
