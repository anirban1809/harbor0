import { ArrowLeft, CalendarClock } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { SignupButton, SiteFoot, SiteNav } from '../site-chrome';
import { betaDiscount, offerEnds } from './offer';
import { Plans } from './plans';

export const metadata: Metadata = {
  title: 'Pricing — harbor0',
  description:
    'harbor0 plans: 10 GB free, then 200 GB, 500 GB, 2 TB or 5 TB with every feature included. Paid plans and new accounts open on 31 October 2026.',
};

const questions: [string, string][] = [
  [
    'Can I buy a plan now?',
    'Not yet. Paid plans open on Saturday 31 October. Until then harbor0 is in beta and there is nothing to pay.',
  ],
  [
    'Can I sign up before launch?',
    'Join the waitlist. New accounts open on 31 October, and we’ll email you when yours is ready.',
  ],
  [
    'Who gets the beta discount?',
    `Every beta member — anyone with an account from before launch — who starts an annual plan by ${offerEnds}. It takes ${betaDiscount}% off the first year; after that the plan renews at its normal price. Your personal code arrives by email on 31 October. Monthly plans and accounts created after launch aren’t included.`,
  ],
  [
    'What do I get for free?',
    'Every account gets 10 GB free, with every feature — end-to-end encryption, sync, backups and the local WebDAV drive included.',
  ],
  [
    'What’s the difference between plans?',
    'Only the storage. Every plan, free included, gets the same features and unlimited devices.',
  ],
  [
    'Can I change or cancel my plan?',
    'Yes. Move up or down a plan, or cancel, from your account at any time. A cancelled plan runs until the end of the period you paid for.',
  ],
  [
    'What happens if I run out of space?',
    'Your files stay where they are and you can still open, download and delete them. New uploads pause until you free up space or move to a bigger plan.',
  ],
  [
    'Do prices include tax?',
    'Prices are in US dollars. Depending on where you live, sales tax or VAT may be added at checkout.',
  ],
];

export default function PricingPage() {
  return (
    <main className="landing learn" style={{ '--tint': 'var(--primary)' } as CSSProperties}>
      <SiteNav />

      <div className="wrap">
        <p className="soon" role="status">
          <CalendarClock size={18} />
          <span>
            <strong>Coming soon.</strong> Paid plans launch on Saturday 31 October. Beta members get{' '}
            {betaDiscount}% off their first year — <a href="#beta-offer">see the offer</a>.
          </span>
        </p>
      </div>

      <section className="wrap learn-hero">
        <Link href="/" className="label">
          <ArrowLeft size={14} />
          Pricing
        </Link>
        <h1>Pay for storage. Nothing else.</h1>
        <div className="hero-foot">
          <p className="lede">
            <em>10 GB free, for good.</em> Every plan gets every feature, including{' '}
            <Link href="/encryption">end-to-end encryption</Link> — move up only when you need more
            space.
          </p>
        </div>
      </section>

      <section className="wrap section">
        <p className="label">01 — Plans</p>
        <Plans />
      </section>

      <section className="wrap section beta offer" id="beta-offer">
        <p className="label">02 — For beta members</p>
        <div className="beta-grid">
          <p className="beta-price">
            {betaDiscount}%<small>off your first year</small>
          </p>
          <div>
            <h2>Thanks for testing harbor0. Your first year costs less.</h2>
            <ul>
              <li>
                <strong>{betaDiscount}% off</strong> the first year of any annual plan
              </li>
              <li>
                <strong>Every beta member</strong> — start your plan by {offerEnds}
              </li>
              <li>
                <strong>Renews</strong> at the normal annual price after the first year
              </li>
            </ul>
            <p className="offer-terms">
              For accounts created before launch. Your personal code arrives by email on 31 October.
              Monthly plans aren’t included.
            </p>
          </div>
        </div>
      </section>

      <section className="wrap section">
        <p className="label">03 — Questions</p>
        <div className="faq">
          {questions.map(([question, answer]) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="wrap section learn-cta">
        <h2>10 GB free and plans from 31 October.</h2>
        <SignupButton />
      </section>

      <SiteFoot />
    </main>
  );
}
