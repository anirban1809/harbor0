import type { Metadata, Viewport } from 'next';
import { brandDescription, brandName } from '../lib/brand';
import './globals.css';
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.WEB_ORIGIN ?? process.env.APP_ORIGIN ?? 'https://app.harbor0.com',
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
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets the phone layout paint under the notch and home indicator; padding uses safe-area insets.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#141518' },
  ],
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
