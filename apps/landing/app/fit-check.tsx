'use client';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';

const included = 50;
const max = 200;
const count = new Intl.NumberFormat('en');

/** Lets a visitor check their own storage needs against the free 50 GB. */
export function FitCheck({ signupUrl }: { signupUrl: string }) {
  const [need, setNeed] = useState(30);
  const fits = need <= included;
  const scale = Math.max(need, included);
  return (
    <div className="fit">
      <div>
        <h2>Will your files fit?</h2>
        <label htmlFor="fit-need">How much do you need to store?</label>
        <div className="fit-input">
          <input
            id="fit-need"
            type="range"
            min={1}
            max={max}
            value={need}
            onChange={(event) => setNeed(Number(event.target.value))}
          />
          <output htmlFor="fit-need">{need} GB</output>
        </div>
        <p className="fit-equal">
          Roughly {count.format(need * 250)} photos, or {count.format(Math.round(need / 2))} hours
          of HD video.
        </p>
      </div>
      <div className="fit-result" data-fits={fits} aria-live="polite">
        <div className="fit-bar" aria-hidden="true">
          <i style={{ width: `${(Math.min(need, included) / scale) * 100}%` }} />
          {!fits && <i style={{ width: `${((need - included) / scale) * 100}%` }} />}
        </div>
        <div className="fit-scale" aria-hidden="true">
          <span>0</span>
          <span style={{ left: `${(included / scale) * 100}%` }}>{included} GB free</span>
        </div>
        {fits ? (
          <p>
            <strong>It fits.</strong> {included - need} GB to spare, and beta members keep it after
            launch.
          </p>
        ) : (
          <p>
            <strong>
              {need - included} GB over the free {included} GB.
            </strong>{' '}
            Sign up, then ask us — more storage is available on request.
          </p>
        )}
        <a href={signupUrl} className="btn signup" data-variant="primary" data-size="lg">
          Sign up free
          <ArrowRight />
        </a>
      </div>
    </div>
  );
}
