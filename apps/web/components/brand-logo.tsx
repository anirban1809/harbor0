import { brandMarkPath, brandName } from '../lib/brand';

export function BrandLogo() {
  return (
    <>
      <svg
        className="brand-mark"
        width="32"
        height="32"
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
      >
        <path
          d={brandMarkPath}
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="brand-wordmark">{brandName}</span>
    </>
  );
}
