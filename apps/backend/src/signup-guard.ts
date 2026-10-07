import {
  canonicalEmail,
  normalizeEmail,
  SIGNUP_DEVICE_LIMIT,
  SIGNUP_DEVICE_WINDOW_MS,
} from '@harbor/contracts';
import { keyFingerprint } from './device-identity';
import { assert, DomainError } from './errors';
import type { Repository, Transaction } from './repository';

/**
 * Limits on making extra accounts for more free storage. One inbox holds one account: the
 * `EMAIL_CANON` claim names the address (and, once it exists, the account) that holds each
 * canonical inbox. And one browser makes only a few accounts: every account that proves a
 * device key is listed under that key, and sign-up from a browser over the limit is refused.
 */
export type InboxClaim = { email: string; userId?: string };
const INBOX = 'EMAIL_CANON';
const deviceAccounts = (fingerprint: string) => `DEVICE_ACCOUNTS#${fingerprint}`;
export type DeviceAccount = { userId: string; email: string; boundAt: string };

export const inboxClaim = (tx: Transaction, email: string) =>
  tx.get<InboxClaim>(INBOX, canonicalEmail(email));
export const putInboxClaim = (tx: Transaction, claim: InboxClaim) =>
  tx.put(INBOX, canonicalEmail(claim.email), claim);
/** Frees the inbox for a new account, if this account holds it. */
export async function releaseInboxClaim(tx: Transaction, email: string, userId: string) {
  const claim = await inboxClaim(tx, email);
  if (claim?.userId === userId) await tx.delete(INBOX, canonicalEmail(email));
}
export const inboxTaken = () =>
  new DomainError(
    'EMAIL_ALREADY_REGISTERED',
    'An account already uses this email address. Sign in to it instead.',
    409,
  );
/** Refuses an address whose inbox another address already holds. */
export async function assertInboxFree(tx: Transaction, email: string, userId?: string) {
  const claim = await inboxClaim(tx, email);
  if (!claim || claim.email === normalizeEmail(email)) return;
  if (userId && claim.userId === userId) return;
  throw inboxTaken();
}

/** Lists `userId` under the device key it just proved, once per key. */
export async function recordDeviceAccount(
  tx: Transaction,
  fingerprint: string,
  account: Omit<DeviceAccount, 'boundAt'>,
) {
  const pk = deviceAccounts(fingerprint);
  if (await tx.get(pk, account.userId)) return;
  await tx.put(pk, account.userId, { ...account, boundAt: new Date().toISOString() });
}
export async function accountsOnDevice(repo: Repository, fingerprint: string) {
  const rows: DeviceAccount[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.query(deviceAccounts(fingerprint), '', 100, cursor);
    rows.push(...page.rows.map((r) => r.data as DeviceAccount));
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return rows;
}
/**
 * Refuses sign-up from a browser that made `SIGNUP_DEVICE_LIMIT` accounts in the window.
 * The key comes unproven, so this only slows people down; the console still lists accounts by
 * the keys they later prove.
 */
export async function assertDeviceMayRegister(repo: Repository, publicKey: string) {
  const fingerprint = keyFingerprint(Buffer.from(publicKey, 'base64url'));
  const since = new Date(Date.now() - SIGNUP_DEVICE_WINDOW_MS).toISOString();
  const recent = (await accountsOnDevice(repo, fingerprint)).filter((a) => a.boundAt >= since);
  assert(
    recent.length < SIGNUP_DEVICE_LIMIT,
    'SIGNUP_LIMIT',
    'Too many harbor0 accounts were made in this browser recently. Write to contact@harbor0.com if you need another.',
    429,
  );
}
