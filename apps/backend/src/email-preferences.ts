import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeEmail, type EmailSubscription } from '@harbor/contracts';
import { userPK, type StorageService } from './domain';
import { assert } from './errors';
import { Transaction, transact, type Repository } from './repository';
import type { Unsubscribe } from './emails';

/** Who an unsubscribe link is for: an account, or an address that has no account. */
export type LinkSubject = { userId: string } | { email: string };
// Address tokens start with this, which account IDs never contain.
const ADDRESS = '~';

/**
 * Signed links that let an email's recipient stop product updates without signing in. An
 * account's token names the account, not the address, so it keeps working after the email
 * changes; an address without an account gets a token naming the address.
 */
export class EmailLinks {
  constructor(
    private secret: string,
    readonly webOrigin: string,
  ) {}
  private sign(subject: string) {
    return createHmac('sha256', this.secret)
      .update(`unsubscribe:PRODUCT:${subject}`)
      .digest('base64url');
  }
  token(userId: string) {
    return `${userId}.${this.sign(userId)}`;
  }
  addressToken(rawEmail: string) {
    const subject = `${ADDRESS}${Buffer.from(normalizeEmail(rawEmail)).toString('base64url')}`;
    return `${subject}.${this.sign(subject)}`;
  }
  /** Who a token was issued for, or undefined if it was not signed with our secret. */
  verifySubject(token: string): LinkSubject | undefined {
    const [subject, signature, ...rest] = token.split('.');
    if (!subject || !signature || rest.length) return undefined;
    const expected = Buffer.from(this.sign(subject));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return subject.startsWith(ADDRESS)
      ? { email: Buffer.from(subject.slice(ADDRESS.length), 'base64url').toString() }
      : { userId: subject };
  }
  /** The account a token was issued for, or undefined if not signed by us or for an address. */
  verify(token: string) {
    const subject = this.verifySubject(token);
    return subject && 'userId' in subject ? subject.userId : undefined;
  }
  private links(token: string): Unsubscribe {
    const t = encodeURIComponent(token);
    return {
      page: `${this.webOrigin}/unsubscribe?t=${t}`,
      oneClick: `${this.webOrigin}/api/v1/email/unsubscribe?t=${t}`,
    };
  }
  private signRespondent(subject: string) {
    return createHmac('sha256', this.secret).update(`respondent:${subject}`).digest('base64url');
  }
  /**
   * Names who a campaign email went to, for the form links in it: an account, or an address
   * without one. It is signed apart from unsubscribe tokens, so neither works as the other.
   */
  respondentToken(to: LinkSubject) {
    const subject =
      'userId' in to
        ? to.userId
        : `${ADDRESS}${Buffer.from(normalizeEmail(to.email)).toString('base64url')}`;
    return `${subject}.${this.signRespondent(subject)}`;
  }
  verifyRespondent(token: string): LinkSubject | undefined {
    const [subject, signature, ...rest] = token.split('.');
    if (!subject || !signature || rest.length) return undefined;
    const expected = Buffer.from(this.signRespondent(subject));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return subject.startsWith(ADDRESS)
      ? { email: Buffer.from(subject.slice(ADDRESS.length), 'base64url').toString() }
      : { userId: subject };
  }
  unsubscribe(userId: string): Unsubscribe {
    return this.links(this.token(userId));
  }
  unsubscribeAddress(email: string): Unsubscribe {
    return this.links(this.addressToken(email));
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

/**
 * Addresses without an account that turned product updates off from an unsubscribe link.
 * Row: EMAIL_OPTOUT / <normalized email>.
 */
export const OPTOUT_PK = 'EMAIL_OPTOUT';
export const addressOptedOut = async (repo: Repository, rawEmail: string) =>
  !!(await new Transaction(repo).get(OPTOUT_PK, normalizeEmail(rawEmail)));

/** What a link's subject gets now: an account's preference, or an address's opt-out. */
export async function linkSubscription(
  service: StorageService,
  subject: LinkSubject,
): Promise<EmailSubscription> {
  if ('userId' in subject) return emailSubscription(service, subject.userId);
  return {
    email: maskEmail(subject.email),
    productUpdates: !(await addressOptedOut(service.repo, subject.email)),
  };
}
export async function setLinkProductUpdates(
  service: StorageService,
  subject: LinkSubject,
  productUpdates: boolean,
): Promise<EmailSubscription> {
  if ('userId' in subject) return setProductUpdates(service, subject.userId, productUpdates);
  const email = normalizeEmail(subject.email);
  await transact(service.repo, async (tx) => {
    if (productUpdates) {
      if (await tx.get(OPTOUT_PK, email)) await tx.delete(OPTOUT_PK, email);
    } else await tx.put(OPTOUT_PK, email, { email, at: new Date().toISOString() });
  });
  return { email: maskEmail(email), productUpdates };
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

export const unsubscribeSubject = (links: EmailLinks | undefined, token: string | undefined) => {
  const subject = links && token ? links.verifySubject(token) : undefined;
  assert(subject, 'INVALID_LINK', 'This unsubscribe link is not valid.', 400);
  return subject;
};
