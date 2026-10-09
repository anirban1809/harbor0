import type {
  AudienceCount,
  Campaign,
  CampaignAudience,
  CampaignCategory,
  CampaignCounts,
  EmailGroup,
  EmailTemplate,
  Recipient,
  RecipientSkipReason,
} from '../../../packages/contracts/src/campaigns';
import { normalizeEmail } from '@harbor/contracts';
import { EVERYONE_GROUP, MAC_USERS_GROUP } from '../../../packages/contracts/src/campaigns';
import { signupLinkFor } from './beta';
import { campaignVars } from './campaign-content';
import { userPK, type Account, type StorageService } from './domain';
import type { Email } from './emails';
import { addressOptedOut, EmailSuppressions, type EmailLinks } from './email-preferences';
import { assert } from './errors';
import { Transaction, transact, type DeviceSighting, type Repository } from './repository';

/*
 * Rows (pk / sk):
 *   EMAIL_TEMPLATE / <id>              a template
 *   EMAIL_GROUP / <id>                 a group, with its member count
 *   EMAIL_GROUP#<id> / MEMBER#<key>    one member
 *   CAMPAIGN / <id>                    a campaign, with its counts and send progress
 *   CAMPAIGN#<id> / RCPT#<key>         one recipient and what happened to their email
 *   CAMPAIGN#<id> / SURVEY#<key>       one recipient's survey answers (see surveys.ts)
 * A member's or recipient's key is the account ID, or "@" and the address for an address
 * without an account.
 */
export const TEMPLATE_PK = 'EMAIL_TEMPLATE';
export const GROUP_PK = 'EMAIL_GROUP';
export const CAMPAIGN_PK = 'CAMPAIGN';
export const memberPK = (groupId: string) => `EMAIL_GROUP#${groupId}`;
export const addressKey = (email: string) => `@${normalizeEmail(email)}`;
/** The key of a member or recipient: its account, or its address when it has none. */
export const recipientKey = (r: { userId: string | null; email: string | null }) =>
  r.userId ?? addressKey(r.email!);
export const memberSK = (key: string) => `MEMBER#${key}`;
export const recipientPK = (campaignId: string) => `CAMPAIGN#${campaignId}`;
export const recipientSK = (key: string) => `RCPT#${key}`;
export const campaignJobId = (campaignId: string) => `CAMPAIGN#${campaignId}`;

export type StoredTemplate = EmailTemplate;
export type StoredGroup = EmailGroup;
export type StoredMember = {
  /** Null for an address without an account. */
  userId: string | null;
  email: string | null;
  name: string | null;
  addedAt: string;
  addedBy: string;
};
export type StoredCampaign = Campaign & {
  /** Set once every recipient row is written. */
  resolvedAt?: string | null;
  /** Where sending has reached in the recipient rows. */
  cursor?: string | null;
  /** A job run holds the campaign until then, so two runs never send at once. */
  leaseUntil?: string | null;
};
export type StoredRecipient = Recipient;

export const emptyCounts = (): CampaignCounts => ({
  total: 0,
  pending: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
});

/** Every row of a partition, page by page, without adding them to a transaction. */
export async function allRows<T>(repo: Repository, pk: string, prefix = '') {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.query(pk, prefix, 100, cursor);
    out.push(...page.rows.map((r) => r.data as T));
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return out;
}

/** The account that uses an address now, if any. */
export async function accountIdFor(repo: Repository, email: string) {
  return ((await repo.get({ pk: 'EMAIL', sk: normalizeEmail(email) }))?.data as
    | { userId: string }
    | undefined)?.userId;
}

/**
 * Whether a device session was a Mac: the desktop app on macOS, or a browser the web app named
 * "<browser> on macOS" (browserName in apps/web/lib/device-key.ts).
 */
export const isMacDevice = (device: DeviceSighting) =>
  device.platform === 'MACOS' || (device.platform === 'WEB' && / on macOS$/.test(device.name ?? ''));

/** Accounts that have used a Mac, signed out or not; the Mac users group. */
export async function macUserIds(repo: Repository) {
  const ids = new Set<string>();
  for (const device of await repo.scanDevices())
    if (device.userId && isMacDevice(device)) ids.add(device.userId);
  return [...ids];
}

/**
 * The distinct recipients in an audience, and any groups that no longer exist. An address
 * that an account uses now counts as that account.
 */
export async function audienceRecipients(repo: Repository, audience: CampaignAudience) {
  const ids = new Set(audience.userIds);
  const addresses = new Set((audience.emails ?? []).map(normalizeEmail));
  const missingGroups: string[] = [];
  for (const groupId of audience.groupIds) {
    if (groupId === EVERYONE_GROUP) {
      // Every account with a profile; eligibility then skips deleted and suspended ones.
      for (const profile of await repo.scanProfiles()) if (profile.id) ids.add(profile.id);
      continue;
    }
    if (groupId === MAC_USERS_GROUP) {
      for (const id of await macUserIds(repo)) ids.add(id);
      continue;
    }
    if (!(await repo.get({ pk: GROUP_PK, sk: groupId }))) {
      missingGroups.push(groupId);
      continue;
    }
    for (const member of await allRows<StoredMember>(repo, memberPK(groupId), 'MEMBER#'))
      if (member.userId) ids.add(member.userId);
      else addresses.add(normalizeEmail(member.email!));
  }
  const emails: string[] = [];
  for (const email of addresses) {
    const userId = await accountIdFor(repo, email);
    if (userId) ids.add(userId);
    else emails.push(email);
  }
  return { ids: [...ids], emails, missingGroups };
}

/** Whether an account can get a campaign of this category now, and if not, why. */
export async function eligibility(
  repo: Repository,
  userId: string,
  category: CampaignCategory,
): Promise<{ account?: Account; reason?: RecipientSkipReason }> {
  const account = (await repo.get({ pk: userPK(userId), sk: 'PROFILE' }))?.data as
    | Account
    | undefined;
  if (!account) return { reason: 'NO_ACCOUNT' };
  if (account.deletedAt) return { account, reason: 'DELETED' };
  if (account.suspendedAt) return { account, reason: 'SUSPENDED' };
  if (!account.emailVerified) return { account, reason: 'UNVERIFIED' };
  if (category === 'PRODUCT' && account.emailPreferences?.productUpdates === false)
    return { account, reason: 'UNSUBSCRIBED' };
  if (await new EmailSuppressions(repo).get(account.email))
    return { account, reason: 'SUPPRESSED' };
  return { account };
}

/** Whether an address without an account can get a campaign of this category now. */
export async function addressEligibility(
  repo: Repository,
  email: string,
  category: CampaignCategory,
): Promise<RecipientSkipReason | undefined> {
  if (await new EmailSuppressions(repo).get(email)) return 'SUPPRESSED';
  if (category === 'PRODUCT' && (await addressOptedOut(repo, email))) return 'UNSUBSCRIBED';
  return undefined;
}

export async function countAudience(
  repo: Repository,
  audience: CampaignAudience,
  category: CampaignCategory,
): Promise<AudienceCount> {
  const { ids, emails } = await audienceRecipients(repo, audience);
  const skipped: AudienceCount['skipped'] = {};
  let eligible = 0;
  const reasons = [
    ...(await Promise.all(ids.map(async (id) => (await eligibility(repo, id, category)).reason))),
    ...(await Promise.all(emails.map((email) => addressEligibility(repo, email, category)))),
  ];
  for (const reason of reasons) {
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    else eligible++;
  }
  return { total: reasons.length, eligible, skipped };
}

/** Counts every recipient row; used when a campaign finishes so its totals are exact. */
async function recount(repo: Repository, campaignId: string) {
  const counts = emptyCounts();
  for (const r of await allRows<StoredRecipient>(repo, recipientPK(campaignId), 'RCPT#')) {
    counts.total++;
    counts[r.status === 'PENDING' ? 'pending' : (r.status.toLowerCase() as 'sent')]++;
  }
  return counts;
}

export type CampaignSendOptions = {
  sendEmail?: (email: Email) => Promise<void>;
  emailLinks?: EmailLinks;
  /** Emails a second, kept under the SES sending rate. */
  ratePerSecond?: number;
};
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Errors that mean "slow down", not "this address failed": the run stops and resumes later.
const THROTTLED = new Set(['TooManyRequestsException', 'ThrottlingException', 'Throttling']);
const CHUNK = 20;

/**
 * One job run of a scheduled campaign: claim it, write its recipient rows, then send to them
 * until `deadline`. Returns true once the campaign is finished; the job runs again otherwise.
 * Every step can be repeated: a row is only sent while it is PENDING, so a crash between a send
 * and its row update re-sends at most that one email.
 */
export async function campaignStep(
  service: StorageService,
  campaignId: string,
  deadline: number,
  options: CampaignSendOptions,
): Promise<boolean> {
  const { repo } = service;
  const claimed = await transact(repo, async (tx) => {
    const c = await tx.get<StoredCampaign>(CAMPAIGN_PK, campaignId);
    // A campaign cancelled back to a draft (or deleted) leaves nothing to do.
    if (!c || c.state === 'DRAFT' || c.finishedAt) return 'done' as const;
    if (c.state === 'SCHEDULED' && c.scheduledAt && c.scheduledAt > now()) return 'done' as const;
    if (c.leaseUntil && c.leaseUntil > now()) return 'busy' as const;
    if (c.state === 'SCHEDULED') {
      c.state = 'SENDING';
      c.startedAt = now();
    }
    c.leaseUntil = new Date(deadline + 60_000).toISOString();
    await tx.put(CAMPAIGN_PK, campaignId, c);
    return c;
  });
  if (claimed === 'done') return true;
  if (claimed === 'busy') return false;
  let campaign = claimed;
  const release = (update: (c: StoredCampaign) => void = () => {}) =>
    transact(repo, async (tx) => {
      const c = (await tx.get<StoredCampaign>(CAMPAIGN_PK, campaignId))!;
      update(c);
      c.leaseUntil = null;
      await tx.put(CAMPAIGN_PK, campaignId, c);
      return c;
    });

  if (!campaign.resolvedAt) {
    const resolved = await resolve(service, campaign, deadline);
    if (!resolved) {
      await release();
      return false;
    }
    campaign = await release((c) => {
      c.resolvedAt = now();
      c.counts = resolved;
    });
    if (Date.now() >= deadline) return false;
    campaign = await transact(repo, async (tx) => {
      const c = (await tx.get<StoredCampaign>(CAMPAIGN_PK, campaignId))!;
      c.leaseUntil = new Date(deadline + 60_000).toISOString();
      await tx.put(CAMPAIGN_PK, campaignId, c);
      return c;
    });
  }

  const gap = 1000 / Math.max(1, options.ratePerSecond ?? 10);
  const origin = options.emailLinks?.webOrigin ?? '';
  let cursor = campaign.cursor ?? undefined;
  for (;;) {
    const page = await repo.query(recipientPK(campaignId), 'RCPT#', 25, cursor);
    const delta = emptyCounts();
    let paused = false;
    // Stop is checked once a page, so it takes effect within 25 emails.
    const state = ((await repo.get({ pk: CAMPAIGN_PK, sk: campaignId }))?.data as StoredCampaign)
      .state;
    for (const row of page.rows) {
      const r = row.data as StoredRecipient;
      if (r.status !== 'PENDING') continue;
      if (Date.now() >= deadline) {
        paused = true;
        break;
      }
      let update: Partial<StoredRecipient>;
      if (state === 'STOPPED') {
        update = { status: 'SKIPPED', reason: 'STOPPED' };
      } else {
        // Checked again at send time: the account may have unsubscribed since the list was made,
        // and an address may have signed up, so it gets the email as that account.
        const target = await sendTarget(repo, r, campaign.content!.category, origin);
        if (target.reason) update = { status: 'SKIPPED', reason: target.reason };
        else {
          const started = Date.now();
          try {
            assert(options.sendEmail, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured.', 503);
            const product = campaign.content!.category === 'PRODUCT';
            assert(
              (!product && !campaign.content!.survey) || options.emailLinks,
              'EMAIL_NOT_CONFIGURED',
              'Unsubscribe and survey links are not configured.',
              503,
            );
            await options.sendEmail({
              template: 'CAMPAIGN',
              to: target.to,
              content: campaign.content!,
              vars: target.vars,
              ...(campaign.content!.survey
                ? { survey: options.emailLinks!.survey(campaignId, recipientKey(r)) }
                : {}),
              ...(product
                ? {
                    unsubscribe: target.userId
                      ? options.emailLinks!.unsubscribe(target.userId)
                      : options.emailLinks!.unsubscribeAddress(target.to),
                  }
                : {}),
            });
            update = { status: 'SENT', email: target.to };
          } catch (error) {
            const name = (error as { name?: string; code?: string }).name ?? 'Error';
            if (THROTTLED.has(name) || (error as { code?: string }).code === 'EMAIL_NOT_CONFIGURED') {
              paused = true;
              break;
            }
            update = { status: 'FAILED', error: name };
          }
          await sleep(Math.max(0, gap - (Date.now() - started)));
        }
      }
      await transact(repo, (tx) =>
        tx.put(recipientPK(campaignId), recipientSK(recipientKey(r)), {
          ...r,
          ...update,
          at: now(),
        } satisfies StoredRecipient),
      );
      delta.pending--;
      const key = update.status === 'SENT' ? 'sent' : update.status === 'FAILED' ? 'failed' : 'skipped';
      delta[key]++;
    }
    const finished = !paused && !page.cursor;
    // The cursor only moves past a page once every row on it is done.
    const next = paused ? cursor : (page.cursor ?? undefined);
    campaign = await transact(repo, async (tx) => {
      const c = (await tx.get<StoredCampaign>(CAMPAIGN_PK, campaignId))!;
      for (const k of ['pending', 'sent', 'skipped', 'failed'] as const) c.counts[k] += delta[k];
      c.cursor = next ?? null;
      if (paused) c.leaseUntil = null;
      await tx.put(CAMPAIGN_PK, campaignId, c);
      return c;
    });
    if (paused) return false;
    if (finished) {
      const counts = await recount(repo, campaignId);
      await release((c) => {
        c.counts = counts;
        c.finishedAt = now();
        if (c.state === 'SENDING') c.state = 'SENT';
      });
      return true;
    }
    cursor = next;
  }
}

type SendTarget =
  | { reason: RecipientSkipReason; to?: undefined; userId?: undefined; vars?: undefined }
  | { reason?: undefined; to: string; userId: string | null; vars: ReturnType<typeof campaignVars> };
/** Where one recipient's email goes and what fills its variables, or why it is skipped. */
async function sendTarget(
  repo: Repository,
  r: StoredRecipient,
  category: CampaignCategory,
  origin: string,
): Promise<SendTarget> {
  const userId = r.userId ?? (await accountIdFor(repo, r.email!));
  if (userId) {
    const { account, reason } = await eligibility(repo, userId, category);
    if (reason) return { reason };
    return { to: account!.email, userId, vars: campaignVars(account!, `${origin}/signup`) };
  }
  const reason = await addressEligibility(repo, r.email!, category);
  if (reason) return { reason };
  return {
    to: r.email!,
    userId: null,
    vars: campaignVars({ email: r.email! }, await signupLinkFor(repo, origin, r.email!)),
  };
}

/**
 * Writes a PENDING or SKIPPED row for every recipient in the audience. Rows already written are
 * kept, so a run cut short by its deadline picks up where it stopped. Undefined if cut short.
 */
async function resolve(service: StorageService, campaign: StoredCampaign, deadline: number) {
  const { repo } = service;
  const { ids, emails } = await audienceRecipients(repo, campaign.audience);
  const targets = [
    ...ids.map((userId) => ({ userId, email: null })),
    ...emails.map((email) => ({ userId: null, email })),
  ];
  const category = campaign.content!.category;
  const counts = emptyCounts();
  for (let i = 0; i < targets.length; i += CHUNK) {
    if (Date.now() >= deadline) return undefined;
    const chunk = await Promise.all(
      targets.slice(i, i + CHUNK).map(async (target) => {
        const key = recipientKey(target);
        const existing = (await repo.get({ pk: recipientPK(campaign.id), sk: recipientSK(key) }))
          ?.data as StoredRecipient | undefined;
        if (existing) return { row: existing, isNew: false };
        let reason: RecipientSkipReason | undefined;
        let account: Account | undefined;
        if (target.userId) ({ account, reason } = await eligibility(repo, target.userId, category));
        else reason = await addressEligibility(repo, target.email!, category);
        const row: StoredRecipient = {
          userId: target.userId,
          email: account?.email ?? target.email,
          name: account?.displayName ?? null,
          status: reason ? 'SKIPPED' : 'PENDING',
          reason: reason ?? null,
          error: null,
          at: reason ? now() : null,
        };
        return { row, isNew: true };
      }),
    );
    const fresh = chunk.filter((c) => c.isNew);
    if (fresh.length)
      await transact(repo, async (tx) => {
        for (const { row } of fresh)
          await tx.put(recipientPK(campaign.id), recipientSK(recipientKey(row)), row);
      });
    for (const { row } of chunk) {
      counts.total++;
      counts[row.status === 'PENDING' ? 'pending' : (row.status.toLowerCase() as 'sent')]++;
    }
  }
  return counts;
}

/** A page of a campaign's recipients, optionally only those with one status. */
export async function recipientPage(
  repo: Repository,
  campaignId: string,
  status?: Recipient['status'],
  cursor?: string,
) {
  const items: StoredRecipient[] = [];
  let next: string | undefined = cursor;
  // Filtering by status can leave a page short; keep reading until it is full or done.
  do {
    const page = await repo.query(recipientPK(campaignId), 'RCPT#', 100, next);
    for (const row of page.rows) {
      const r = row.data as StoredRecipient;
      if (!status || r.status === status) items.push(r);
    }
    next = page.cursor ?? undefined;
  } while (next && items.length < 50);
  return { items, nextCursor: next ?? null };
}

/** The template, group or campaign row, or a 404. */
export async function getRow<T>(tx: Transaction, pk: string, id: string, what: string) {
  const row = await tx.get<T>(pk, id);
  assert(row, 'NOT_FOUND', `This ${what} was not found.`, 404);
  return row;
}
export const read = (repo: Repository) => new Transaction(repo);
