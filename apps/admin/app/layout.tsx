import type { Metadata } from 'next';
import { Providers } from '../components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'harbor0 console',
  description: 'Internal management console for harbor0 staff.',
  robots: { index: false, follow: false },
};

// Follows the system theme, and is applied before paint so dark mode doesn't flash light.
const themeScript = `try{var m=matchMedia('(prefers-color-scheme: dark)');var a=function(){document.documentElement.classList.toggle('dark',m.matches)};a();m.addEventListener('change',a)}catch{}`;

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
