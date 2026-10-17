import { ArrowRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { betaDiscount, offerEnds } from './pricing/offer';
import { ProductStage } from './product-stage';
import { loginUrl, SignupButton, SiteFoot, SiteNav } from './site-chrome';

const facts = [
  { value: '31 Oct', label: 'Launch day — paid plans open' },
  { value: '10 GB', label: 'Free for every account, for good' },
  { value: `${betaDiscount}% off`, label: 'First year for beta members, until 15 November' },
];

const launch: [string, string][] = [
  [
    'Paid plans open',
    '200 GB, 500 GB, 2 TB and 5 TB, from $2.49 a month. Annual billing gets two months free.',
  ],
  [
    'Free stays free',
    'Accounts created from launch day get 10 GB free, with every feature, encryption included.',
  ],
  [
    'Waitlist until launch',
    'New sign-ups join the waitlist until 31 October. We’ll email you when your account is ready.',
  ],
  [
    `${betaDiscount}% off for beta members`,
    `Every beta member gets ${betaDiscount}% off the first year of any annual plan started by ${offerEnds}. Codes go out by email on launch day.`,
  ],
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
    'When does harbor0 launch?',
    'Saturday 31 October 2026. Paid plans open that day, and new accounts get 10 GB free.',
  ],
  [
    'Can I sign up now?',
    'Join the waitlist. New accounts open on 31 October, and we’ll email you when yours is ready.',
  ],
  [
    'Do I need to pay or add a card?',
    'No. The free storage stays free. You only pay if you choose a plan for more space.',
  ],
  [
    'What if I need more?',
    'Choose a plan. From 31 October there are plans of 200 GB, 500 GB, 2 TB and 5 TB.',
  ],
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
        <a href="#beta" className="launch-pill">
          <span className="dot" />
          <strong>Launching Saturday 31 October</strong>
          <span>See what’s changing</span>
          <ArrowRight size={16} />
        </a>
        <h1>
          A safe harbor
          <br />
          for your files.
        </h1>
        <div className="hero-foot">
          <p className="lede">
            <strong>10 GB</strong> of private storage,{' '}
            <Link href="/encryption">end-to-end encrypted</Link> if you want it —{' '}
            <em>free, for good.</em>
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

      <section className="wrap section">
        <p className="label">02 — Also on board</p>
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

      <section className="wrap section beta launch" id="beta">
        <p className="label">03 — Launch</p>
        <div className="beta-grid">
          <p className="beta-price">
            31 Oct<small>Saturday — launch day</small>
          </p>
          <div>
            <h2>harbor0 leaves beta on 31 October.</h2>
            <dl className="launch-list">
              {launch.map(([name, text]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
            <div className="hero-cta">
              <SignupButton />
              <Link href="/pricing" className="text-link">
                See pricing <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap section" id="faq">
        <p className="label">04 — Questions</p>
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
