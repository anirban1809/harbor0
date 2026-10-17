'use client';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { appUrl, signupUrl } from '../site-chrome';
import { CustomPlanButton } from './custom-plan';
import { betaDiscount } from './offer';

type Plan = { id: string; size: string; monthly: number; note: string; popular?: boolean };

// Set to `true` where the app takes payments (the Polar sandbox while testing).
const checkoutOpen = process.env.NEXT_PUBLIC_CHECKOUT === 'true';

// Annual billing is ten times the monthly price: two months free.
const plans: Plan[] = [
  { id: '200gb', size: '200 GB', monthly: 2.49, note: 'Phone photos and documents' },
  { id: '500gb', size: '500 GB', monthly: 4.99, note: 'A whole computer’s backups', popular: true },
  { id: '2tb', size: '2 TB', monthly: 11.99, note: 'Photo and video libraries' },
  { id: '5tb', size: '5 TB', monthly: 29.99, note: 'Archives and media collections' },
];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** The free tier and paid plans, with a monthly / annual switch. */
export function Plans() {
  const [annual, setAnnual] = useState(true);
  return (
    <>
      <div className="billing" role="radiogroup" aria-label="Billing period">
        <button type="button" role="radio" aria-checked={!annual} onClick={() => setAnnual(false)}>
          Monthly
        </button>
        <button type="button" role="radio" aria-checked={annual} onClick={() => setAnnual(true)}>
          Annual <small>2 months free</small>
        </button>
      </div>

      <div className="plans">
        <article className="plan" data-free>
          <span className="plan-tag">Always free</span>
          <h3>10 GB</h3>
          <p className="plan-note">Every feature, encryption included</p>
          <p className="plan-price">
            <strong>$0</strong>
            <span>/ forever</span>
          </p>
          <p className="plan-bill">No card needed</p>
          <a href={signupUrl} className="btn" data-variant="primary" data-size="lg">
            Join the waitlist
          </a>
        </article>
        {plans.map(({ id, size, monthly, note, popular }) => (
          <article key={size} className="plan" data-popular={popular || undefined}>
            {popular && <span className="plan-tag">Recommended</span>}
            <h3>{size}</h3>
            <p className="plan-note">{note}</p>
            <p className="plan-price">
              <strong>{usd.format(annual ? (monthly * 10) / 12 : monthly)}</strong>
              <span>/ month</span>
            </p>
            <p className="plan-bill">
              {annual ? `${usd.format(monthly * 10)} billed yearly` : 'Billed monthly'}
            </p>
            <p className="plan-beta">
              {annual
                ? `Beta members: ${usd.format((monthly * 10 * (100 - betaDiscount)) / 100)} first year`
                : 'Beta offer on annual billing'}
            </p>
            {checkoutOpen ? (
              // The app signs people in (or up) first, then opens checkout for this plan.
              <a
                href={`${appUrl}/storage?${new URLSearchParams({ plan: id, interval: annual ? 'year' : 'month' })}`}
                className="btn"
                data-variant={popular ? 'primary' : 'outline'}
                data-size="lg"
              >
                Choose {size}
              </a>
            ) : (
              <span className="btn plan-soon" data-variant="outline" data-size="lg" aria-disabled>
                Coming 31 October
              </span>
            )}
          </article>
        ))}
      </div>

      <div className="custom-plan">
        <div>
          <h3>Need more than 5 TB, or something different?</h3>
          <p>
            Larger archives, a team, or a setup that doesn’t fit these plans — tell us what you need
            and we’ll put a plan together.
          </p>
        </div>
        <CustomPlanButton />
      </div>

      <ul className="included">
        {[
          'End-to-end encryption, optional',
          'Desktop sync and versioned backups',
          'Local WebDAV drive',
          'Version history and trash',
          'Unlimited devices',
        ].map((item) => (
          <li key={item}>
            <Check size={16} />
            {item}
          </li>
        ))}
      </ul>
      <p className="fine">
        Every plan, free included, gets every feature — plans differ only in storage. Prices are in
        US dollars; sales tax or VAT may be added at checkout depending on where you live.
      </p>
    </>
  );
}
