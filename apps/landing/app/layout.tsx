import type { Metadata } from 'next';
import './globals.css';
import { SignupRef } from './signup-ref';

const title = 'harbor0 — private and encrypted cloud storage, launching 31 October';
const description =
  'A private cloud drive with optional end-to-end encryption, desktop sync, versioned backups, a local WebDAV drive and person-to-person sharing. Launching 31 October 2026: 10 GB free for everyone, plans from 200 GB to 5 TB, with the waitlist open until then.';
export const metadata: Metadata = {
  title,
  description,
  applicationName: 'harbor0',
  openGraph: { title, description, siteName: 'harbor0', type: 'website' },
};

// Runs before paint so a saved or system dark theme doesn't flash light.
const themeScript = `try{var t=localStorage.getItem('harbor-landing-theme');if(t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch{}`;

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <SignupRef />
        {children}
      </body>
    </html>
  );
}
