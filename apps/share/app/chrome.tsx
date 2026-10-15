import type { ReactNode } from 'react';
import { Flag } from 'lucide-react';
import { BrandLogo } from '../../web/components/brand-logo';

/** The page frame: who hosts this, what harbor0 is, and how to report a link. */
export function Chrome({ children, reportUrl }: { children: ReactNode; reportUrl?: string }) {
  const report = `mailto:contact@harbor0.com?subject=${encodeURIComponent('Report a public link')}${
    reportUrl ? `&body=${encodeURIComponent(`Link: ${reportUrl}\n\nWhat's wrong with it:\n`)}` : ''
  }`;
  return (
    <div className="share-frame">
      <header className="share-header">
        <a className="brand" href="https://harbor0.com" rel="noopener">
          <BrandLogo />
        </a>
        <a
          className="btn"
          data-variant="outline"
          data-size="sm"
          href="https://harbor0.com"
          rel="noopener"
        >
          Get harbor0 free
        </a>
      </header>
      <main className="share-main">{children}</main>
      <footer className="share-footer">
        <span>
          harbor0 is a private cloud drive with optional end-to-end encryption. This link was made
          by one of its users; harbor0 doesn’t check what people share.
        </span>
        <a href={report} className="share-report">
          <Flag aria-hidden="true" />
          Report this link
        </a>
      </footer>
    </div>
  );
}
