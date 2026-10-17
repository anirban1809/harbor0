import { ArrowLeft, ArrowRight, Eye, EyeOff } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { SignupButton, SiteFoot, SiteNav } from '../site-chrome';

export const metadata: Metadata = {
  title: 'End-to-end encryption — harbor0',
  description:
    'Turn on end-to-end encryption and your devices encrypt every file and file name before it is uploaded. How it works, what harbor0 can still see, and what changes.',
};

const steps = [
  [
    'Turn it on',
    'In Settings › Encryption on the web, create a passphrase of at least 12 characters and save your recovery key. Neither ever reaches harbor0.',
  ],
  [
    'Your files are encrypted',
    'The browser encrypts the files you already have and uploads them again, then deletes the unencrypted copies from our servers. New uploads are encrypted straight away.',
  ],
  [
    'Unlock each device once',
    'A new browser or the desktop app asks for your passphrase once. Devices that are already unlocked stay unlocked.',
  ],
];

const keys: [string, string][] = [
  [
    'Master key',
    'One random 256-bit key per account. It never leaves your devices unwrapped: harbor0 only stores copies of it locked by keys we never see.',
  ],
  [
    'Passphrase',
    'Stretched with Argon2id (64 MiB of memory, 3 passes) into a key that unlocks one copy of the master key. Guessing it means paying that cost on every try.',
  ],
  [
    'Recovery key',
    '160 random bits, shown once as 8 groups of 4 characters. It unlocks its own copy of the master key, so it still works if you forget your passphrase.',
  ],
  [
    'Device copies',
    'An unlocked browser or computer keeps its own copy. Half of its key stays on the device, half on our servers, so removing a device from Settings locks it out for good.',
  ],
  [
    'File keys',
    'Every version of every file gets its own random key, stored in the file’s 80-byte header, wrapped by a key derived from the master key.',
  ],
  [
    'Content',
    'Encrypted with AES-256-GCM in 4 MiB chunks. Each chunk is bound to its file and position, so chunks can’t be swapped, reordered or cut off without it showing.',
  ],
  [
    'Names',
    'File and folder names are encrypted too. The same name always encrypts the same way, which lets the server stop two files sharing a name in one folder.',
  ],
  [
    'Changing keys',
    'Changing your passphrase or recovery key re-wraps one copy of the master key. Your files aren’t encrypted again, and the old passphrase or key stops working.',
  ],
];

const hidden = [
  'What’s inside your files',
  'File and folder names',
  'File types — every file is stored as plain bytes',
  'Your passphrase, recovery key and master key',
];
const visible = [
  'How many files and folders you have, and how they nest',
  'Roughly how big each file is, and when it changed',
  'Which items in a folder share a name, but not the name',
  'The names of your computers, and of the top folders you sync or back up',
  'Your email address, sign-in activity and storage use',
];

const changes: [string, string][] = [
  [
    'Works as before',
    'Upload, folders, version history, trash, previews, search and downloads. Search, previews and downloads now happen on your device instead of our servers.',
  ],
  [
    'Desktop app',
    'Sync, backups and the local WebDAV server encrypt and decrypt on your computer. It needs version 0.1.7 or later; older builds are refused so they can never upload a file unencrypted.',
  ],
  [
    'Not available',
    'Sending files, shared folders, shared sync, folder ZIP downloads and rclone access tokens. Folders you’ve shared with others are paused for them.',
  ],
  [
    'Storage',
    'Encrypted files are a few bytes bigger: 80 bytes per file and 16 per 4 MiB. While existing files are converted, an account may briefly go over its storage by at most its largest file.',
  ],
  [
    'Converting',
    'Existing files are encrypted by one browser tab in the background. Keep it open until it finishes; if it closes, the next tab picks up where it stopped.',
  ],
  [
    'Earlier versions',
    'Once a file is encrypted, its unencrypted versions are deleted from our servers.',
  ],
];

const questions: [string, string][] = [
  [
    'What if I forget my passphrase?',
    'Enter your recovery key on the unlock screen and choose a new passphrase. An unlocked device can also change it from Settings.',
  ],
  [
    'What if I lose both?',
    'Your files can’t be recovered — not by you and not by harbor0. That is what end-to-end means. If a device is still unlocked, use it to set a new passphrase or recovery key straight away.',
  ],
  [
    'Is the passphrase my sign-in password?',
    'No. You sign in exactly as before, and the passphrase is a separate secret that only unlocks your files. Make it different from your password.',
  ],
  [
    'Can I turn it off?',
    'Yes. Confirm with your passphrase and the browser decrypts every file and name, including the trash, then deletes the encrypted versions. Your keys are deleted once nothing encrypted is left. You can turn it on again later.',
  ],
  [
    'Can I encrypt only some folders?',
    'No. Encryption is per account: either everything is encrypted or nothing is.',
  ],
  [
    'Should I tick Remember this browser?',
    'On your own computer, yes: it stays unlocked until you sign out. On a shared computer, leave it off and the browser locks when the tab closes.',
  ],
  [
    'Does it work on phones?',
    'Not yet. Encryption works on the web and in the desktop app for Mac and Windows.',
  ],
];

export default function EncryptionPage() {
  return (
    <main className="landing learn" style={{ '--tint': '#6d28d9' } as CSSProperties}>
      <SiteNav />

      <section className="wrap learn-hero">
        <Link href="/drive" className="label">
          <ArrowLeft size={14} />
          Drive — End-to-end encryption
        </Link>
        <h1>Files only your devices can read.</h1>
        <div className="hero-foot">
          <p className="lede">
            Turn on end-to-end encryption and your devices encrypt every file and file name before
            it is uploaded. harbor0 stores them, but can’t read them.
          </p>
          <SignupButton />
        </div>
        <ul className="platforms" aria-label="Available on">
          <li>Web</li>
          <li>Desktop 0.1.7+</li>
          <li>Optional, per account</li>
        </ul>
      </section>

      <section className="wrap section">
        <p className="label">01 — How it works</p>
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
        <p className="label">02 — Under the hood</p>
        <div className="learn-split">
          <div>
            <h2>One key, locked three ways.</h2>
            <p>
              Your files are encrypted with keys that come from one master key. Your passphrase,
              your recovery key and each unlocked device can each open a copy of it — any one is
              enough. harbor0 holds only the locked copies.
            </p>
          </div>
          <figure className="keys" aria-label="How the keys fit together">
            <div className="keys-row">
              <div>
                <strong>Passphrase</strong>
                <small>Argon2id</small>
              </div>
              <div>
                <strong>Recovery key</strong>
                <small>HKDF</small>
              </div>
              <div>
                <strong>Each device</strong>
                <small>HKDF, device half + server half</small>
              </div>
            </div>
            <p className="keys-step">each unlocks its own copy of</p>
            <div className="keys-row">
              <div data-main>
                <strong>Master key</strong>
                <small>256-bit, stored only wrapped</small>
              </div>
            </div>
            <p className="keys-step">derives, with HKDF</p>
            <div className="keys-row">
              <div>
                <strong>File-key wrapping</strong>
                <small>AES-256-GCM</small>
              </div>
              <div>
                <strong>Name key</strong>
                <small>Names → h0e1.…</small>
              </div>
              <div>
                <strong>Key proof</strong>
                <small>Guards key changes</small>
              </div>
            </div>
            <p className="keys-step">wraps a new key for every file version</p>
            <div className="keys-row">
              <div>
                <strong>File content</strong>
                <small>AES-256-GCM, 4 MiB chunks</small>
              </div>
            </div>
          </figure>
        </div>
        <dl className="details spaced">
          {keys.map(([name, text], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section">
        <p className="label">03 — What harbor0 can see</p>
        <div className="compare">
          <div>
            <h3>Hidden from us</h3>
            <ul>
              {hidden.map((item) => (
                <li key={item}>
                  <EyeOff size={18} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Still visible to us</h3>
            <ul>
              {visible.map((item) => (
                <li key={item}>
                  <Eye size={18} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="fine">
          The server needs these to store your files, keep folders in order and count your storage.
          Encrypting and decrypting happen only in your browser and the desktop app, never on our
          servers.
        </p>
      </section>

      <section className="wrap section">
        <p className="label">04 — What changes</p>
        <dl className="details">
          {changes.map(([name, text], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section">
        <p className="label">05 — Questions</p>
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
        <p className="label">06 — More of harbor0</p>
        <div className="others">
          <Link href="/webdav" style={{ '--tint': '#b45309' } as CSSProperties}>
            <strong>Local WebDAV</strong>
            <span>
              Open your encrypted Drive in Finder or File Explorer, decrypted on your computer.
            </span>
            <ArrowRight size={18} />
          </Link>
          <Link href="/drive" style={{ '--tint': 'var(--primary)' } as CSSProperties}>
            <strong>Drive</strong>
            <span>Every file in one place, with search, previews and version history.</span>
            <ArrowRight size={18} />
          </Link>
          <Link href="/backups" style={{ '--tint': '#0e7490' } as CSSProperties}>
            <strong>Backups</strong>
            <span>Every version saved on its own, encrypted on your computer first.</span>
            <ArrowRight size={18} />
          </Link>
        </div>
      </section>

      <section className="wrap section learn-cta">
        <h2>10 GB free from 31 October. Encrypted if you want it.</h2>
        <SignupButton />
      </section>

      <SiteFoot />
    </main>
  );
}
