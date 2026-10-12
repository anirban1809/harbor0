import { normalizeEmail } from '@harbor/contracts';
import type { Transaction } from './repository';

/**
 * Where sign-ups come from. A sign-up link can carry `?ref=<tracking id>`; the web app sends
 * it with the access request and the sign-up, and it is kept per email until the account is
 * created, when it is copied onto the profile. The first tracking id an email arrives with
 * wins, so a later visit through another link doesn't take the credit.
 */
export type SignupTracking = {
  email: string;
  trackingId: string;
  /** First seen with this tracking id: the access request, or the sign-up itself. */
  at: string;
  /** Asked for a beta sign-up link. */
  requestedAt?: string;
  /** Created the sign-in account (the email may not be verified yet). */
  signedUpAt?: string;
  /** Verified and signed in for the first time, which creates the account's profile. */
  userId?: string;
  joinedAt?: string;
};
/** Staff's name for a tracking id: the post, ad or campaign its links were shared in. */
export type Tracker = {
  id: string;
  source: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export const SIGNUP_TRACKING = 'SIGNUP_TRACKING';
export const TRACKER = 'TRACKER';

export const signupTracking = (tx: Transaction, email: string) =>
  tx.get<SignupTracking>(SIGNUP_TRACKING, normalizeEmail(email));

/**
 * Notes that `email` reached `stage` through the link `trackingId`. Without a tracking id it
 * still marks the stage for an email that came through one earlier.
 */
export async function trackSignup(
  tx: Transaction,
  rawEmail: string,
  trackingId: string | undefined,
  stage: 'requestedAt' | 'signedUpAt',
) {
  const email = normalizeEmail(rawEmail);
  const existing = await signupTracking(tx, email);
  if (!existing && !trackingId) return;
  const at = new Date().toISOString();
  const row: SignupTracking = existing ?? { email, trackingId: trackingId!, at };
  if (row[stage]) return;
  await tx.put(SIGNUP_TRACKING, email, { ...row, [stage]: at });
}

/** Links the new account to the tracking id its email signed up with; returns that id. */
export async function joinTrackedSignup(tx: Transaction, email: string, userId: string) {
  const row = await signupTracking(tx, email);
  if (!row) return undefined;
  if (!row.userId)
    await tx.put(SIGNUP_TRACKING, row.email, {
      ...row,
      userId,
      joinedAt: new Date().toISOString(),
    });
  return row.trackingId;
}
