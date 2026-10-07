import { useSyncExternalStore } from 'react';
import { ApiError, type Transport } from '@harbor/api-client';

/** Why a signed-in session ended without the user signing out. */
export type SessionEnd = 'expired';

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

// These answer 401 for wrong passwords and codes rather than for an ended session.
const publicAuth = /^\/v1\/auth\/(signup|confirm|resend|login|forgot|reset|request-access)\b/;
let renewing: Promise<void> | null = null;

/**
 * Trades the refresh cookie for new tokens. Each use rotates the refresh token, so this tab's
 * requests share one renewal and a Web Lock keeps other tabs from spending the same cookie.
 * Throws ApiError 401 when the sign-in is gone; any other failure leaves it in place.
 */
export function renewSession(fetcher: typeof fetch = fetch): Promise<void> {
  const renew = async () => {
    const response = await fetcher('/api/v1/auth/renew', { method: 'POST', cache: 'no-store' });
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(
      response.status === 401 ? 'AUTH_INVALID' : 'BACKEND_UNAVAILABLE',
      body.error?.message ?? 'harbor0 is temporarily unavailable. Try again in a moment.',
      response.status === 401 ? 401 : 503,
    );
  };
  renewing ??= (
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('harbor-session-renew', renew).then(() => {})
      : renew()
  ).finally(() => {
    renewing = null;
  });
  return renewing;
}

/**
 * Renews the session when a signed-in request comes back 401 and retries it once; if the
 * renewal is refused too, the sign-in is gone. Auth forms handle their own 401s.
 */
export function guardTransport(
  transport: Transport,
  renew: () => Promise<void> = renewSession,
): Transport {
  return async (path, init) => {
    try {
      try {
        return await transport(path, init);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401) || publicAuth.test(path)) throw e;
        await renew();
        return await transport(path, init);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && !path.startsWith('/v1/auth/'))
        endSession('expired');
      throw e;
    }
  };
}
