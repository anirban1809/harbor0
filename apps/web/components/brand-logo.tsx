import { useId } from 'react';
import { brandName } from '../lib/brand';
import { brandIconSrc } from '../lib/brand-icon';

export function BrandLogo() {
  const maskId = useId();
  return (
    <>
      <svg
        className="brand-mark"
        width="32"
        height="32"
        viewBox="0 0 128 128"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <mask id={maskId} style={{ maskType: 'alpha' }}>
            <image href={brandIconSrc} width="128" height="128" />
          </mask>
        </defs>
        <rect width="128" height="128" fill="currentColor" mask={`url(#${maskId})`} />
      </svg>
      <span className="brand-wordmark">{brandName}</span>
    </>
  );
}
