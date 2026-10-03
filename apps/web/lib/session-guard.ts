import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, type Transport } from '@harbor/api-client';

/** Why a signed-in session ended without the user signing out. */
export type SessionEnd = 'expired' | 'updated';

// Baked into the static export by scripts/build-web-static.ts; unset in development.
const buildId = process.env.NEXT_PUBLIC_BUILD_ID;
const VERSION_CHECK_MS = 5 * 60_000;

let signedIn = false;
let ended: SessionEnd | null = null;
const listeners = new Set<() => void>();

export function setSignedIn(value: boolean) {
  signedIn = value;
}

export function endSession(reason: SessionEnd) {
  if (!signedIn || ended) return;
  ended = reason;
  for (const listener of listeners) listener();
}

export function useSessionEnd() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ended,
    () => null,
  );
}

/**
 * Ends the session when a signed-in request comes back 401. The session proxy has already
 * tried to refresh the tokens by then, so the sign-in is gone. Auth endpoints answer 401 for
 * wrong passwords and codes, so they're left to their forms.
 */
export function guardTransport(transport: Transport): Transport {
  return async (path, init) => {
    try {
      return await transport(path, init);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && !path.startsWith('/v1/auth/'))
        endSession('expired');
      throw e;
    }
  };
}

/** Signs the user out when a newer web release has been published since this page loaded. */
export function useDeploymentCheck(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !buildId) return;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/version.json', { cache: 'no-store' });
        const latest = response.ok ? ((await response.json()) as { buildId?: string }) : null;
        if (latest?.buildId && latest.buildId !== buildId) endSession('updated');
      } catch {
        // Offline, or a release without version.json: try again later.
      }
    };
    const timer = setInterval(check, VERSION_CHECK_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [enabled]);
}
