import { ArrowDownToLine, ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import { features } from '../features';
import { Shot } from '../shot';
import { appUrl, SignupButton, SiteFoot, SiteNav } from '../site-chrome';

export const metadata: Metadata = {
  title: 'Apps — harbor0',
  description: 'harbor0 in the browser and on your Mac.',
};

// The published installer; `npm run release:desktop` updates it with each GitHub release.
const mac = {
  version: '0.1.6',
  size: '128 MB',
  url: 'https://github.com/anirban1809/harbor0/releases/download/v0.1.6/harbor0-0.1.6-mac-arm64.dmg',
  sha256: 'b02354f2876fea0a1e43465b813678600b4ff9100e5af8f08aee7ab4d06be681',
};

const desktop = [
  ['Sync', 'Keep folders in step across your computers, and share a folder for two-way sync.'],
  ['Automatic backups', 'Save new versions of a folder as you work, and restore them in place.'],
  [
    'Incoming files',
    'Checks for files and invitations every 10 seconds, even with the window closed, and notifies you.',
  ],
  ['Your whole Drive', 'Browse, upload, preview and download, exactly as on the web.'],
  ['Several accounts', 'Each account keeps its own sync folders and settings on the computer.'],
  ['Sign-in', 'Your password is never saved. The session is encrypted with the system keychain.'],
];
const install = [
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
const sync = features.find(({ id }) => id === 'sync')!;

export default function AppsPage() {
  return (
    <main className="landing learn" style={{ '--tint': 'var(--primary)' } as CSSProperties}>
      <SiteNav />

      <section className="wrap learn-hero">
        <p className="label">Apps</p>
        <h1>harbor0 in the browser and on your Mac.</h1>
        <div className="hero-foot">
          <p className="lede">
            Use it in the browser, and install the desktop app for sync and automatic backups.
          </p>
          <SignupButton />
        </div>
      </section>

      <section className="wrap section" id="get">
        <p className="label">01 — Get harbor0</p>
        <div className="get">
          <div>
            <h3>Web</h3>
            <p>Any modern browser. Nothing to install.</p>
            <a href={appUrl} className="btn" data-variant="outline" data-size="md">
              Open the web app <ArrowUpRight />
            </a>
          </div>
          <div>
            <h3>Mac</h3>
            <p>
              Version {mac.version} · Apple silicon · {mac.size}
            </p>
            <a href={mac.url} className="btn" data-variant="primary" data-size="md">
              <ArrowDownToLine /> Download for Mac
            </a>
          </div>
        </div>
        <p className="fine">
          The desktop app is for Macs with Apple silicon. Intel Macs, Windows and Linux are not
          available yet.
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
          {desktop.map(([name, text], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section" id="install">
        <p className="label">03 — Install on a Mac</p>
        <ol className="steps">
          {install.map(([title, text], index) => (
            <li key={title}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
        <p className="fine">
          To verify the download, its SHA-256 checksum is <code>{mac.sha256}</code>
        </p>
      </section>

      <section className="wrap section learn-cta">
        <h2>50 GB free for beta members. Nothing to pay during the beta.</h2>
        <SignupButton />
      </section>

      <SiteFoot />
    </main>
  );
}
