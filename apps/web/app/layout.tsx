import type { Metadata } from 'next';
import { brandDescription, brandName } from '../lib/brand';
import './globals.css';
import './workspace-layout.css';
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.WEB_ORIGIN ?? process.env.APP_ORIGIN ?? 'https://d1bpha1d51nhxy.cloudfront.net',
  ),
  title: 'harbor0 — File storage and sync',
  applicationName: brandName,
  description: brandDescription,
  appleWebApp: { title: brandName },
  openGraph: {
    title: 'harbor0 — File storage and sync',
    siteName: brandName,
    description: brandDescription,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'harbor0 — File storage and sync',
    description: brandDescription,
  },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
