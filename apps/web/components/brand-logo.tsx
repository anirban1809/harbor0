import { brandName } from '../lib/brand';

// Keep the geometry in sync with assets/branding/logo.svg.
export function BrandLogo() {
  return (
    <>
      <svg
        className="brand-mark"
        width="32"
        height="32"
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="24"
          cy="24"
          r="15"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray="72.25 22"
          transform="rotate(-10 24 24)"
        />
        <circle cx="24" cy="24" r="5" fill="currentColor" />
      </svg>
      <span className="brand-wordmark">{brandName}</span>
    </>
  );
}
