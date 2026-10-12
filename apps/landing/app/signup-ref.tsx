'use client';
import { useEffect } from 'react';
import { signupUrl } from './site-chrome';

const KEY = 'harbor0.signup-ref';

/**
 * Carries a tracking link's `?ref=` from any landing page to the web app's sign-up page, even
 * after moving between pages here, by adding it to sign-up links as they are clicked.
 */
export function SignupRef() {
  useEffect(() => {
    const store = (() => {
      try {
        return sessionStorage;
      } catch {
        return undefined;
      }
    })();
    const fromUrl = new URLSearchParams(location.search).get('ref')?.trim();
    const ref = fromUrl || store?.getItem(KEY) || '';
    if (fromUrl) store?.setItem(KEY, fromUrl);
    if (!ref) return;
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a');
      if (!link || !link.href.startsWith(signupUrl)) return;
      const url = new URL(link.href);
      if (!url.searchParams.has('ref')) url.searchParams.set('ref', ref);
      link.href = url.toString();
    };
    // Capture runs before the browser follows the link, middle-clicks included.
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', onClick, true);
    };
  }, []);
  return null;
}
