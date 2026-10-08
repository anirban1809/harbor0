import { randomBytes } from 'node:crypto';
import { BETA_FIRST_WAVE, normalizeEmail, type AccessRequestResult } from '@harbor/contracts';
import type { Job } from './domain';
import type { Email } from './emails';
import { assert, DomainError } from './errors';
import { transact, type Repository, type Transaction } from './repository';
import { assertInboxFree, inboxClaim, putInboxClaim } from './signup-guard';

/**
 * Invite-only sign-up for the beta. Anyone can ask for access with their email. While the
 * current wave has seats and nobody is waiting, the request is answered at once with a sign-up
 * link; otherwise the email joins the waitlist, and staff invite the waitlist in order when
 * they open the next wave. A seat is taken when the account is created, never before.
 */
type Seats = { used: number; cap: number };
type Entry = {
  email: string;
  state: 'INVITED' | 'WAITLISTED' | 'JOINED';
  requestedAt: string;
  code?: string;
  invitedAt?: string;
  sentAt?: string;
  joinedAt?: string;
  /** Joined through a staff test link, so it took no seat. */
  test?: boolean;
};
/**
 * A sign-up link. Links sent to someone are for their email only. A test link from staff
 * works for any email, takes no seat, and is used up by the first sign-up: `usedBy` then
 * holds that email, so a retried sign-up with it still works.
 */
type Invite = { email: string } | { test: true; createdAt: string; usedBy?: string };
export type BetaSummary = Seats & {
  inviteRequired: boolean;
  invited: number;
  waitlisted: number;
  testAccounts: number;
};

const SEATS = 'SEATS';
const ENTRY = 'BETA_EMAIL';
const INVITE = 'BETA_INVITE';
const WAITLIST = 'BETA_WAITLIST';
// The waitlist is ordered by when each email first asked.
const waitlistKey = (entry: Entry) => `${entry.requestedAt}#${entry.email}`;
// A repeated request resends the link, but not more than once a minute.
const RESEND_AFTER_MS = 60_000;
const now = () => new Date().toISOString();
const newCode = () => randomBytes(15).toString('base64url');
/** Queues an email for the maintenance job; a queued one with the same id is replaced. */
async function queueEmail(tx: Transaction, id: string, email: Email) {
  const job: Job = { id, type: 'EMAIL', email, dueAt: now(), attempts: 0 };
  await tx.put('JOB', id, job, { gpk: 'JOB', gsk: job.dueAt });
}

/**
 * Where someone without an account signs up: their own link while they hold an unused beta
 * invite, otherwise the sign-up page.
 */
export async function signupLinkFor(repo: Repository, webOrigin: string, rawEmail: string) {
  return transact(repo, async (tx) => {
    const entry = await tx.get<Entry>(ENTRY, normalizeEmail(rawEmail));
    const live = entry?.state === 'INVITED' && entry.code && (await tx.get(INVITE, entry.code));
    return live
      ? `${webOrigin}/signup?invite=${encodeURIComponent(entry.code!)}`
      : `${webOrigin}/signup`;
  });
}

export class Beta {
  constructor(
    private repo: Repository,
    /** False once the beta ends, and in tests and local development unless asked for. */
    readonly inviteRequired: boolean,
  ) {}
  private async seats(tx: Transaction): Promise<Seats> {
    return (await tx.get<Seats>('BETA', SEATS)) ?? { used: 0, cap: BETA_FIRST_WAVE };
  }
  private async waitlistEmpty() {
    return (await this.repo.query(WAITLIST, '', 1)).rows.length === 0;
  }
  async status() {
    if (!this.inviteRequired) return { inviteRequired: false, open: true };
    const [seats, empty] = await Promise.all([
      transact(this.repo, (tx) => this.seats(tx)),
      this.waitlistEmpty(),
    ]);
    return { inviteRequired: true, open: seats.used < seats.cap && empty };
  }
  /** Emails a sign-up link, or adds the email to the waitlist when the wave is full. */
  async request(rawEmail: string): Promise<AccessRequestResult> {
    const typed = normalizeEmail(rawEmail);
    const empty = await this.waitlistEmpty();
    return transact(this.repo, async (tx) => {
      // Another spelling of an inbox already in the beta is that address: same inbox, same link.
      const holder = await inboxClaim(tx, typed);
      if (holder?.userId) return { status: 'REGISTERED' };
      const email = holder?.email ?? typed;
      if (!holder) await putInboxClaim(tx, { email });
      if (await tx.get('EMAIL', email)) return { status: 'REGISTERED' };
      const entry = await tx.get<Entry>(ENTRY, email);
      if (entry?.state === 'WAITLISTED') return { status: 'WAITLISTED' };
      if (entry?.code) {
        if (Date.now() - Date.parse(entry.sentAt ?? '') >= RESEND_AFTER_MS)
          await this.sendInvite(tx, entry);
        return { status: 'INVITED' };
      }
      const fresh: Entry = { email, state: 'WAITLISTED', requestedAt: now() };
      const seats = await this.seats(tx);
      if (!this.inviteRequired || (seats.used < seats.cap && empty)) {
        await this.invite(tx, fresh);
        return { status: 'INVITED' };
      }
      await this.waitlist(tx, fresh);
      return { status: 'WAITLISTED' };
    });
  }
  /** The email a sign-up link was sent to; null for an unused test link, which takes any. */
  async inviteEmail(code: string) {
    const invite = await transact(this.repo, (tx) => tx.get<Invite>(INVITE, code));
    assert(invite, 'INVITE_INVALID', 'This sign-up link is not valid. Request a new one.', 404);
    return { email: 'test' in invite ? (invite.usedBy ?? null) : invite.email };
  }
  /** Makes a single-use test sign-up link that works for any email and takes no seat. */
  async createTestInvite(audit: (tx: Transaction) => Promise<unknown>) {
    const code = newCode();
    await transact(this.repo, async (tx) => {
      const invite: Invite = { test: true, createdAt: now() };
      await tx.put(INVITE, code, invite);
      await audit(tx);
    });
    return code;
  }
  /**
   * Takes a seat for the account being created. Repeating it for the same email is free, so a
   * failed or retried sign-up never takes two. When the wave filled up before the link was
   * used, the email goes back on the waitlist in its original place.
   */
  async claim(rawEmail: string, code: string | undefined) {
    if (!this.inviteRequired) return;
    const email = normalizeEmail(rawEmail);
    assert(
      code,
      'INVITE_REQUIRED',
      'harbor0 is invite-only during the beta. Request a sign-up link to join.',
      403,
    );
    const full = await transact(this.repo, async (tx) => {
      await assertInboxFree(tx, email);
      const invite = await tx.get<Invite>(INVITE, code);
      if (invite && 'test' in invite) {
        assert(
          !invite.usedBy || invite.usedBy === email,
          'INVITE_INVALID',
          'This sign-up link has already been used.',
          403,
        );
        const entry = await tx.get<Entry>(ENTRY, email);
        if (entry?.state === 'JOINED') return false;
        await tx.put(INVITE, code, { ...invite, usedBy: email });
        await tx.put(ENTRY, email, {
          email,
          state: 'JOINED',
          requestedAt: entry?.requestedAt ?? now(),
          joinedAt: now(),
          test: true,
        } satisfies Entry);
        if (entry?.state === 'WAITLISTED') await tx.delete(WAITLIST, waitlistKey(entry));
        return false;
      }
      assert(
        invite?.email === email,
        'INVITE_INVALID',
        'This sign-up link is for a different email address, or is no longer valid.',
        403,
      );
      const entry = await tx.get<Entry>(ENTRY, email);
      assert(entry, 'INVITE_INVALID', 'This sign-up link is no longer valid.', 403);
      if (entry.state === 'JOINED') return false;
      const seats = await this.seats(tx);
      if (seats.used >= seats.cap) {
        await tx.delete(INVITE, code);
        await this.waitlist(tx, entry);
        return true;
      }
      await tx.put('BETA', SEATS, { ...seats, used: seats.used + 1 });
      await tx.put(ENTRY, email, { ...entry, state: 'JOINED', joinedAt: now() });
      return false;
    });
    if (full)
      throw new DomainError(
        'BETA_FULL',
        'This beta wave filled up before you signed up. You’re on the waitlist, and we’ll email you a new link when the next wave opens.',
        409,
      );
  }
  async summary(): Promise<BetaSummary> {
    return transact(this.repo, async (tx) => {
      const [seats, entries] = await Promise.all([this.seats(tx), tx.list<Entry>(ENTRY, '')]);
      return {
        ...seats,
        inviteRequired: this.inviteRequired,
        invited: entries.filter((e) => e.state === 'INVITED').length,
        waitlisted: entries.filter((e) => e.state === 'WAITLISTED').length,
        testAccounts: entries.filter((e) => e.test).length,
      };
    });
  }
  /**
   * Opens a wave: raises the seat limit to `cap` and invites people from the front of the
   * waitlist, as many as there are seats not already promised to an unused link.
   */
  async openWave(cap: number, audit: (tx: Transaction, invited: number) => Promise<unknown>) {
    const before = await this.summary();
    assert(cap >= before.used, 'VALIDATION_ERROR', `${before.used} people have already joined.`);
    await transact(this.repo, async (tx) => {
      await tx.put('BETA', SEATS, { ...(await this.seats(tx)), cap });
    });
    const room = Math.max(0, cap - before.used - before.invited);
    const waiting = room ? (await this.repo.query(WAITLIST, '', room)).rows : [];
    let invited = 0;
    for (const row of waiting)
      await transact(this.repo, async (tx) => {
        const entry = await tx.get<Entry>(ENTRY, (row.data as Entry).email);
        if (entry?.state !== 'WAITLISTED') return tx.delete(WAITLIST, row.sk);
        await this.invite(tx, entry);
        invited++;
      });
    await transact(this.repo, (tx) => audit(tx, invited));
    return { ...(await this.summary()), newlyInvited: invited };
  }
  private async invite(tx: Transaction, entry: Entry) {
    const code = newCode();
    await tx.delete(WAITLIST, waitlistKey(entry));
    await tx.put(INVITE, code, { email: entry.email });
    await this.sendInvite(tx, { ...entry, state: 'INVITED', code, invitedAt: now() });
  }
  private async sendInvite(tx: Transaction, entry: Entry) {
    const sentAt = now();
    await tx.put(ENTRY, entry.email, { ...entry, sentAt });
    await queueEmail(tx, `beta-invite-${entry.email}`, {
      template: 'BETA_INVITE',
      to: entry.email,
      code: entry.code!,
    });
  }
  private async waitlist(tx: Transaction, entry: Entry) {
    const listed: Entry = {
      email: entry.email,
      state: 'WAITLISTED',
      requestedAt: entry.requestedAt,
    };
    await tx.put(ENTRY, entry.email, listed);
    await tx.put(WAITLIST, waitlistKey(listed), { email: entry.email });
    await queueEmail(tx, `beta-waitlist-${entry.email}`, {
      template: 'BETA_WAITLIST',
      to: entry.email,
    });
  }
}
