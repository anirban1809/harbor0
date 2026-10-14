import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { SignupButton, SiteFoot, SiteNav } from '../site-chrome';

export const metadata: Metadata = {
  title: 'Local WebDAV — harbor0',
  description:
    'Open My Drive in Finder, File Explorer, Cyberduck or rclone without syncing it. How to set up the desktop app’s local WebDAV server, and how it behaves.',
};

const steps = [
  [
    'Turn it on',
    'In the desktop app, open Settings and find Local WebDAV server. Click Turn on. The server starts on this computer and keeps running while the app does.',
  ],
  [
    'Open it',
    'Click Open in Finder on a Mac, or Open in File Explorer on Windows. My Drive appears as a drive named harbor0, with nothing downloaded yet.',
  ],
  [
    'Use your files',
    'Open, save, rename, move and delete as with any folder. A file downloads when you open it, and what you save goes up to harbor0 in the background.',
  ],
];

const apps: [string, ReactNode][] = [
  [
    'Finder (Mac)',
    'Open in Finder connects the drive for you; no address or password to type. Disconnect in the app, or eject harbor0 in Finder.',
  ],
  [
    'File Explorer (Windows)',
    'Open in File Explorer maps the drive to the next free letter. It is mapped for this session only, so after a restart click Open in File Explorer again.',
  ],
  [
    'Cyberduck, Transmit and others',
    <>
      Make a WebDAV (HTTP) connection to <code>127.0.0.1</code>, port <code>6810</code>, path{' '}
      <code>/harbor0/</code>, with the username and password the app shows.
    </>,
  ],
  [
    'rclone',
    <>
      Add a <code>webdav</code> remote with vendor <code>other</code>, the address{' '}
      <code>http://127.0.0.1:6810/harbor0/</code> and the app’s username and password. Then{' '}
      <code>rclone ls harbor0:</code>, <code>rclone copy</code> or <code>rclone mount</code> work as
      usual.
    </>,
  ],
  [
    'From a terminal',
    <>
      Run the app’s own executable with <code>webdav</code> to serve My Drive without a window — the
      app shows the exact command. Add <code>--read-only</code> to refuse changes, or{' '}
      <code>--port 7000</code> for another port. Not available on encrypted accounts.
    </>,
  ],
  [
    'The password',
    'Each account gets its own random password, kept in the system keychain. The app and the terminal command share it, and Show password reveals it.',
  ],
];

const behaviour: [string, string][] = [
  [
    'Only this computer',
    'The server only answers on 127.0.0.1. Nothing else on your network can connect, even with the password.',
  ],
  [
    'Nothing is synced',
    'Files download when an app opens them and aren’t kept afterwards. Use Sync for folders you want on disk, or offline.',
  ],
  [
    'Saving makes a version',
    'Saving over a file uploads it as a new version, so the previous copy stays in Version history.',
  ],
  ['Deleting is safe', 'Deleted files and folders go to the harbor0 trash, not straight away.'],
  [
    'Uploads in the background',
    'Your app is answered as soon as a file is saved on this computer; the upload follows. It shows in the app and in the drive until it lands, and retries if the connection drops.',
  ],
  [
    'Still uploading',
    'A file that is still uploading can be opened and saved again, but not moved or renamed until it finishes.',
  ],
  [
    'System clutter stays local',
    '.DS_Store, ._ files, Thumbs.db and desktop.ini are kept in memory on this computer and never uploaded.',
  ],
  [
    'Changes from elsewhere',
    'Folder listings are reused for about 10 seconds, so a file added on another device can take a moment to appear. Your own changes show at once.',
  ],
  [
    'No file locking',
    'Apps that ask to lock a file are told yes, but the lock isn’t enforced. If two apps save the same file, the last save is the current version and the other stays in Version history.',
  ],
  [
    'My Drive only',
    'The drive shows My Drive. Files shared with you and the trash are in the app and on the web. Backed-up folders stay read-only, as everywhere in My Drive.',
  ],
  [
    'Storage full',
    'When your storage is full, saving a new file fails with a disk-full error in your app. Free some space, or ask for more, and save again.',
  ],
  [
    'Encrypted accounts',
    'With end-to-end encryption on, files are decrypted on this computer as apps read them and encrypted before upload. Unlock your files in the app first.',
  ],
];

const questions: [string, string][] = [
  [
    'File Explorer says the WebClient service is off.',
    'Windows maps WebDAV drives with its WebClient service. Open Services, set WebClient to Automatic and start it, then click Open in File Explorer again — or use Cyberduck or rclone, which don’t need it.',
  ],
  [
    'File Explorer won’t open a large file.',
    'File Explorer refuses files over 50 MB on WebDAV drives. Open it with a WebDAV app, or sync its folder instead.',
  ],
  [
    'My apps get “service unavailable”.',
    'The app is locked or signed out. On an encrypted account, unlock your files in the app; otherwise sign in again. The drive works again straight away.',
  ],
  [
    'The drive disappeared from Finder.',
    'Finder disconnects the drive by itself if the server stops answering, for example when you quit the app. Open the app and click Open in Finder again.',
  ],
  [
    'Can I use a different port?',
    'The app uses port 6810. The terminal command takes --port with any number from 1024 to 65535.',
  ],
  [
    'Does it work if the app’s window is closed?',
    'Yes. The app keeps running in the background, and so does the server. Quitting the app stops it and disconnects the drive.',
  ],
  [
    'Is this the same as Sync?',
    'No. Sync keeps a real folder on your disk in step with harbor0. WebDAV shows your whole Drive without using disk space, and needs the app running to open anything.',
  ],
];

export default function WebdavPage() {
  return (
    <main className="landing learn" style={{ '--tint': '#b45309' } as CSSProperties}>
      <SiteNav />

      <section className="wrap learn-hero">
        <Link href="/apps" className="label">
          <ArrowLeft size={14} />
          Apps — Local WebDAV
        </Link>
        <h1>Your whole Drive in Finder and File Explorer.</h1>
        <div className="hero-foot">
          <p className="lede">
            The desktop app runs a WebDAV server on your computer, so Finder, File Explorer and any
            WebDAV app can open My Drive without syncing it.
          </p>
          <SignupButton />
        </div>
        <ul className="platforms" aria-label="Available on">
          <li>Mac</li>
          <li>Windows</li>
          <li>Desktop 0.1.9+</li>
          <li>
            <Link href="/apps">Get the apps</Link>
          </li>
        </ul>
      </section>

      <section className="wrap section">
        <p className="label">01 — Set it up</p>
        <ol className="steps">
          {steps.map(([title, text], index) => (
            <li key={title}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="wrap section">
        <p className="label">02 — Connect your app</p>
        <div className="learn-split">
          <div>
            <h2>One click, or three fields.</h2>
            <p>
              Once the server is running, the app shows its address, username and password, each
              with a copy button.
            </p>
          </div>
          <dl className="connect">
            <div>
              <dt>Address</dt>
              <dd>
                <code>http://127.0.0.1:6810/harbor0/</code>
              </dd>
            </div>
            <div>
              <dt>Username</dt>
              <dd>Shown in the app</dd>
            </div>
            <div>
              <dt>Password</dt>
              <dd>Shown in the app, hidden until you click Show</dd>
            </div>
          </dl>
        </div>
        <dl className="details spaced">
          {apps.map(([name, text], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section">
        <p className="label">03 — How it behaves</p>
        <dl className="details">
          {behaviour.map(([name, text], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section">
        <p className="label">04 — Troubleshooting</p>
        <div className="faq">
          {questions.map(([question, answer]) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="wrap section">
        <p className="label">05 — More of harbor0</p>
        <div className="others">
          <Link href="/sync" style={{ '--tint': 'var(--success)' } as CSSProperties}>
            <strong>Sync</strong>
            <span>Keep a real folder on your disk in step on all your computers.</span>
            <ArrowRight size={18} />
          </Link>
          <Link href="/encryption" style={{ '--tint': '#6d28d9' } as CSSProperties}>
            <strong>End-to-end encryption</strong>
            <span>Files and names encrypted on your devices before they’re uploaded.</span>
            <ArrowRight size={18} />
          </Link>
          <Link href="/apps" style={{ '--tint': 'var(--primary)' } as CSSProperties}>
            <strong>Apps</strong>
            <span>Get the desktop app for Mac and Windows.</span>
            <ArrowRight size={18} />
          </Link>
        </div>
      </section>

      <section className="wrap section learn-cta">
        <h2>50 GB free for beta members. Nothing to pay during the beta.</h2>
        <SignupButton />
      </section>

      <SiteFoot />
    </main>
  );
}
