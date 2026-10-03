import type { Metadata } from 'next';
import './globals.css';

const title = 'harbor0 — 50 GB of free storage for beta members.';
const description =
  'A private cloud drive with desktop sync, versioned backups, and person-to-person sharing. 50 GB free for beta members, kept after launch; no payment during the beta, and more storage on request.';
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
      <body>{children}</body>
    </html>
  );
}
