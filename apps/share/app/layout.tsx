import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shared with harbor0',
  description: 'A file or folder someone shared from harbor0.',
  applicationName: 'harbor0',
  // Links are private to whoever has them; none of these pages belong in search results.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// Runs before paint so a dark system theme doesn't flash light.
const themeScript = `try{if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch{}`;

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
