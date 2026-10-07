import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeEmail, type EmailSubscription } from '@harbor/contracts';
import { userPK, type StorageService } from './domain';
import { assert } from './errors';
import { Transaction, transact, type Repository } from './repository';
import type { Unsubscribe } from './emails';

/**
 * Signed links that let an email's recipient stop product updates without signing in. The token
 * names the account, not the address, so it keeps working after the email changes.
 */
export class EmailLinks {
  constructor(
    private secret: string,
    private webOrigin: string,
  ) {}
  private sign(userId: string) {
    return createHmac('sha256', this.secret)
      .update(`unsubscribe:PRODUCT:${userId}`)
      .digest('base64url');
  }
  token(userId: string) {
    return `${userId}.${this.sign(userId)}`;
  }
  /** The account a token was issued for, or undefined if it was not signed with our secret. */
  verify(token: string) {
    const [userId, signature, ...rest] = token.split('.');
    if (!userId || !signature || rest.length) return undefined;
    const expected = Buffer.from(this.sign(userId));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected) ? userId : undefined;
  }
  unsubscribe(userId: string): Unsubscribe {
    const t = encodeURIComponent(this.token(userId));
    return {
      page: `${this.webOrigin}/unsubscribe?t=${t}`,
      oneClick: `${this.webOrigin}/api/v1/email/unsubscribe?t=${t}`,
    };
  }
}

/** "alice@example.com" → "a•••@example.com": enough for the owner to recognise, no more. */
export const maskEmail = (email: string) => {
  const at = email.lastIndexOf('@');
  return at < 1 ? '•••' : `${email[0]}•••${email.slice(at)}`;
};

export async function emailSubscription(
  service: StorageService,
  userId: string,
): Promise<EmailSubscription> {
  const account = await service.account(new Transaction(service.repo), userId);
  return {
    email: maskEmail(account.email),
    productUpdates: account.emailPreferences?.productUpdates !== false,
  };
}

export async function setProductUpdates(
  service: StorageService,
  userId: string,
  productUpdates: boolean,
): Promise<EmailSubscription> {
  return transact(service.repo, async (tx) => {
    const account = await service.account(tx, userId);
    if ((account.emailPreferences?.productUpdates !== false) !== productUpdates) {
      account.emailPreferences = { ...account.emailPreferences, productUpdates };
      account.updatedAt = new Date().toISOString();
      await tx.put(userPK(userId), 'PROFILE', account);
      await service.record(tx, userId, 'PROFILE_UPDATED', userId);
    }
    return { email: maskEmail(account.email), productUpdates };
  });
}

export type SuppressionSource = 'BOUNCE' | 'COMPLAINT';
export type Suppression = {
  email: string;
  source: SuppressionSource;
  at: string;
  /** The SES message that bounced or was marked as spam. */
  messageId?: string;
};

/**
 * Addresses that hard-bounced or marked our mail as spam. Optional email (campaigns) is never sent
 * to them; SES's own suppression list also stops everything else.
 */
export class EmailSuppressions {
  constructor(private repo: Repository) {}
  async add(rawEmail: string, source: SuppressionSource, messageId?: string) {
    const email = normalizeEmail(rawEmail);
    const row: Suppression = { email, source, at: new Date().toISOString(), messageId };
    await transact(this.repo, (tx) => tx.put('EMAIL_SUPPRESSION', email, row));
  }
  get(rawEmail: string) {
    return new Transaction(this.repo).get<Suppression>(
      'EMAIL_SUPPRESSION',
      normalizeEmail(rawEmail),
    );
  }
}

/** The part of an SES delivery event (via EventBridge) that says who to suppress. */
export type SesEventDetail = {
  eventType?: string;
  mail?: { messageId?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
};

/** Records hard bounces and complaints; soft bounces may deliver next time and are ignored. */
export async function recordMailEvent(suppressions: EmailSuppressions, detail: SesEventDetail) {
  const messageId = detail.mail?.messageId;
  const recipients =
    detail.eventType === 'Bounce' && detail.bounce?.bounceType === 'Permanent'
      ? { source: 'BOUNCE' as const, list: detail.bounce.bouncedRecipients }
      : detail.eventType === 'Complaint'
        ? { source: 'COMPLAINT' as const, list: detail.complaint?.complainedRecipients }
        : undefined;
  const emails = (recipients?.list ?? []).flatMap((r) => (r.emailAddress ? [r.emailAddress] : []));
  for (const email of emails) await suppressions.add(email, recipients!.source, messageId);
  return emails.length;
}

export const unsubscribeUser = (links: EmailLinks | undefined, token: string | undefined) => {
  const userId = links && token ? links.verify(token) : undefined;
  assert(userId, 'INVALID_LINK', 'This unsubscribe link is not valid.', 400);
  return userId;
};
