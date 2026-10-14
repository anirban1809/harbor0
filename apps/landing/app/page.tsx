import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { FitCheck } from './fit-check';
import { ProductStage } from './product-stage';
import { loginUrl, SignupButton, signupUrl, SiteFoot, SiteNav } from './site-chrome';

const facts = [
  { value: '50 GB', label: 'Free for beta members, kept after launch' },
  { value: '$0', label: 'No payment until the beta ends' },
  { value: 'More', label: 'Storage on request' },
];

const details: [string, string, string?][] = [
  [
    'End-to-end encryption',
    'Optional. Your devices encrypt files and names before upload, so harbor0 can’t read them.',
    '/encryption',
  ],
  [
    'Local WebDAV',
    'Open My Drive in Finder, File Explorer or any WebDAV app without syncing it.',
    '/webdav',
  ],
  ['Backups', 'Pick a folder; new versions are saved as you work.'],
  ['Version history', 'Go back to any earlier copy of a file.'],
  ['Trash', 'Deleted files wait until you restore or remove them.'],
  ['Previews', 'View files in place, or download a folder as a ZIP.'],
  ['Devices', 'No limit. See every session and sign any of them out.'],
  ['Themes', 'Light, dark, and colour presets.'],
];

const questions = [
  [
    'Do I keep the 50 GB after the beta?',
    'Yes. Every account created during the beta gets 50 GB, and it stays free after the beta ends.',
  ],
  ['Do I need to pay or add a card?', 'No. There is nothing to pay until the beta program ends.'],
  ['What if I need more?', 'Ask. More storage is available on request.'],
  [
    'Who can see my files?',
    'Only you, unless you share them — and sharing is with signed-in people, not public links.',
  ],
  [
    'Are my files end-to-end encrypted?',
    'If you turn it on. With end-to-end encryption, your devices encrypt files and file names with a passphrase only you know, and harbor0 can’t read them. Without it, files are encrypted on our servers, which keeps sending and shared folders available.',
  ],
  [
    'Can I open my files in Finder or File Explorer?',
    'Yes. The desktop app runs a WebDAV server on your computer that shows My Drive as a drive, without syncing it. Files download when you open them.',
  ],
  [
    'Where does it run?',
    'In your browser. Sync, automatic backups and the local WebDAV drive run through the desktop app.',
  ],
];

export default function LandingPage() {
  return (
    <main className="landing">
      <SiteNav />

      <section className="hero wrap" id="top">
        <p className="label">
          <span className="dot" />
          Beta — no payment required
        </p>
        <h1>
          A safe harbor
          <br />
          for your files.
        </h1>
        <div className="hero-foot">
          <p className="lede">
            50 GB of private storage, <Link href="/encryption">end-to-end encrypted</Link> if you
            want it — <em>free for beta members.</em>
          </p>
          <div className="hero-cta">
            <SignupButton />
            <a href={loginUrl} className="text-link">
              Sign in <ArrowUpRight size={16} />
            </a>
          </div>
        </div>
        <dl className="facts">
          {facts.map(({ value, label }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section" id="product">
        <p className="label">01 — Product</p>
        <ProductStage />
      </section>

      <section className="wrap section" id="fit">
        <p className="label">02 — Storage</p>
        <FitCheck signupUrl={signupUrl} />
      </section>

      <section className="wrap section">
        <p className="label">03 — Also on board</p>
        <dl className="details">
          {details.map(([name, text, href], index) => (
            <div key={name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <dt>{href ? <Link href={href}>{name}</Link> : name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="wrap section beta" id="beta">
        <p className="label">04 — Beta</p>
        <div className="beta-grid">
          <p className="beta-price">$0</p>
          <div>
            <h2>Nothing to pay until the beta program ends.</h2>
            <ul>
              <li>
                <strong>50 GB free</strong> — beta members keep it after launch
              </li>
              <li>No payment required while the beta runs</li>
              <li>More storage available on request</li>
            </ul>
            <SignupButton />
          </div>
        </div>
      </section>

      <section className="wrap section" id="faq">
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

      <SiteFoot />
    </main>
  );
}
