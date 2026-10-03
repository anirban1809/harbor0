import { ArrowRight, ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
// The logo and the stylesheet's tokens are shared with the web app.
import { BrandLogo } from '../../web/components/brand-logo';
import { ThemeToggle } from './theme-toggle';

// Accounts live in the web app, which is deployed separately.
export const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.harbor0.com').replace(
  /\/$/,
  '',
);
export const signupUrl = `${appUrl}/signup`;
export const loginUrl = `${appUrl}/login`;

export function SignupButton() {
  return (
    <a href={signupUrl} className="btn signup" data-variant="primary" data-size="lg">
      Sign up free
      <ArrowRight />
    </a>
  );
}

export function SiteNav() {
  return (
    <header className="nav">
      <div className="wrap">
        <Link href="/" className="brand">
          <BrandLogo />
        </Link>
        <nav aria-label="Sections">
          <Link href="/#product">Product</Link>
          <Link href="/apps">Apps</Link>
          <Link href="/#fit">Storage</Link>
          <Link href="/#beta">Beta</Link>
          <Link href="/#faq">FAQ</Link>
        </nav>
        <div className="nav-actions">
          <ThemeToggle />
          <a href={loginUrl} className="btn" data-variant="ghost" data-size="md">
            Sign in
          </a>
          <a href={signupUrl} className="btn" data-variant="primary" data-size="md">
            Sign up
          </a>
        </div>
      </div>
    </header>
  );
}

export function SiteFoot() {
  return (
    <footer className="wrap foot">
      <span className="brand">
        <BrandLogo />
      </span>
      <span>50 GB free during the beta. Files are private unless you share them.</span>
      <a href={signupUrl} className="text-link">
        Sign up free <ArrowUpRight size={16} />
      </a>
    </footer>
  );
}
