import { randomUUID } from 'node:crypto';
import { normalizeEmail } from '@harbor/contracts';
import type { AdminUserEmail, AuditEntry, Staff } from '../../../../packages/contracts/src/admin';
import {
  BUILT_IN_GROUPS,
  EVERYONE_GROUP,
  MAC_USERS_GROUP,
} from '../../../../packages/contracts/src/campaigns';
import type {
  CampaignBody,
  CampaignContent,
  EmailGroupBody,
  EmailTemplateBody,
  Recipient,
} from '../../../../packages/contracts/src/campaigns';
import { campaignVars, contentProblems, sampleVars } from '../campaign-content';
import {
  addressKey,
  allRows,
  CAMPAIGN_PK,
  campaignJobId,
  countAudience,
  emptyCounts,
  getRow,
  GROUP_PK,
  macUserIds,
  memberPK,
  memberSK,
  read,
  recipientKey,
  recipientPage,
  TEMPLATE_PK,
  type StoredCampaign,
  type StoredGroup,
  type StoredMember,
  type StoredTemplate,
} from '../campaigns';
import { queueEmail, userPK, type Account, type Job } from '../domain';
import { composeEmail, type Email } from '../emails';
import { EmailSuppressions } from '../email-preferences';
import { assert } from '../errors';
import { transact, type Transaction } from '../repository';
import type { AdminService } from './service';

const history = (kind: 'TEMPLATE' | 'GROUP' | 'CAMPAIGN', id: string) =>
  `ADMIN_AUDIT#${kind}#${id}`;
/**
 * The new updatedAt and updatedBy for a change to `row`. updatedAt always moves forward, even
 * for two saves in the same millisecond, since editors use it to detect a change made since.
 */
const stamp = (staff: Staff, row: { updatedAt: string }) => {
  const now = Date.now();
  const previous = Date.parse(row.updatedAt);
  return {
    updatedAt: new Date(previous >= now ? previous + 1 : now).toISOString(),
    updatedBy: staff.email,
  };
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The Mac users group's accounts as last worked out, for the console; sends always rescan. */
type MacUsersCache = { computedAt: string; userIds: string[] };
const MAC_USERS_CACHE = { pk: 'ADMIN_STATS', sk: 'MAC_USERS' };
const MAC_USERS_MAX_AGE_MS = 15 * 60_000;
const MAC_MEMBER_PAGE = 50;
const MAX_SCHEDULE_AHEAD_MS = 90 * 86400_000;
// Group writes go in chunks; a transaction holds at most 100 items.
const CHUNK = 40;
const changedSince = (what: string, row: { updatedAt: string; updatedBy: string }, expected: string | null) =>
  assert(
    row.updatedAt === expected,
    'CHANGED',
    `${row.updatedBy} changed this ${what} since you opened it. Reload to see their change.`,
    409,
  );
const newest = <T extends { updatedAt: string }>(items: T[]) =>
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/**
 * Email templates, groups of accounts, and campaigns as console staff manage them. Every
 * change is audited, globally and in the item's own history. Sending happens in the jobs
 * function (see campaignStep); the console only schedules it.
 */
export class AdminCampaigns {
  constructor(
    private admin: AdminService,
    private webOrigin: string,
  ) {}
  private get repo() {
    return this.admin.repo;
  }
  private async log(kind: 'TEMPLATE' | 'GROUP' | 'CAMPAIGN', id: string) {
    const page = await this.repo.query(history(kind, id), '', 30);
    return page.rows.map((r) => r.data as AuditEntry);
  }
  private audit(
    tx: Transaction,
    staff: Staff,
    kind: 'TEMPLATE' | 'GROUP' | 'CAMPAIGN',
    id: string,
    action: string,
    details: Record<string, unknown>,
    reason: string | null = null,
  ) {
    return this.admin.audit(tx, staff, { action, reason, details, scope: history(kind, id) });
  }

  // Templates -------------------------------------------------------------------------------
  async templates() {
    return { items: newest(await allRows<StoredTemplate>(this.repo, TEMPLATE_PK)) };
  }
  async template(id: string) {
    const [template, log] = await Promise.all([
      getRow<StoredTemplate>(read(this.repo), TEMPLATE_PK, id, 'template'),
      this.log('TEMPLATE', id),
    ]);
    return { template, history: log };
  }
  private checkContent(content: Pick<CampaignContent, 'subject' | 'preheader' | 'markdown'>) {
    const problems = contentProblems(content);
    assert(!problems.length, 'INVALID_TEMPLATE', problems.join(' '), 400);
  }
  async createTemplate(staff: Staff, input: Omit<EmailTemplateBody, 'expectedUpdatedAt'>) {
    this.checkContent(input);
    const id = randomUUID();
    const at = new Date().toISOString();
    const template: StoredTemplate = {
      id,
      name: input.name,
      category: input.category,
      subject: input.subject,
      preheader: input.preheader,
      markdown: input.markdown,
      createdAt: at,
      createdBy: staff.email,
      updatedAt: at,
      updatedBy: staff.email,
    };
    await transact(this.repo, async (tx) => {
      await tx.put(TEMPLATE_PK, id, template);
      await this.audit(tx, staff, 'TEMPLATE', id, 'EMAIL_TEMPLATE_CREATED', { name: input.name });
    });
    return template;
  }
  async updateTemplate(staff: Staff, id: string, input: EmailTemplateBody) {
    this.checkContent(input);
    return transact(this.repo, async (tx) => {
      const template = await getRow<StoredTemplate>(tx, TEMPLATE_PK, id, 'template');
      changedSince('template', template, input.expectedUpdatedAt);
      const { expectedUpdatedAt: _, ...fields } = input;
      const next: StoredTemplate = { ...template, ...fields, ...stamp(staff, template) };
      await tx.put(TEMPLATE_PK, id, next);
      await this.audit(tx, staff, 'TEMPLATE', id, 'EMAIL_TEMPLATE_CHANGED', {
        name: next.name,
        changed: (['name', 'category', 'subject', 'preheader', 'markdown'] as const).filter(
          (k) => template[k] !== next[k],
        ),
      });
      return next;
    });
  }
  async deleteTemplate(staff: Staff, id: string) {
    const drafts = (await allRows<StoredCampaign>(this.repo, CAMPAIGN_PK)).filter(
      (c) => c.templateId === id && c.state === 'DRAFT',
    );
    assert(
      !drafts.length,
      'TEMPLATE_IN_USE',
      `Draft campaigns use this template: ${drafts.map((c) => c.name).join(', ')}. Change or delete them first.`,
      409,
    );
    await transact(this.repo, async (tx) => {
      const template = await getRow<StoredTemplate>(tx, TEMPLATE_PK, id, 'template');
      await tx.delete(TEMPLATE_PK, id);
      await this.audit(tx, staff, 'TEMPLATE', id, 'EMAIL_TEMPLATE_DELETED', { name: template.name });
    });
    return { deleted: true };
  }
  private async vars(sampleUserId?: string) {
    if (!sampleUserId) return sampleVars;
    const account = (await this.repo.get({ pk: userPK(sampleUserId), sk: 'PROFILE' }))?.data as
      | Account
      | undefined;
    assert(account, 'USER_NOT_FOUND', 'No account has this ID.', 404);
    return campaignVars(account, `${this.webOrigin}/signup`);
  }
  /** The email as a recipient would get it: product updates show the unsubscribe footer. */
  private compose(content: CampaignContent, vars: Awaited<ReturnType<AdminCampaigns['vars']>>, to: string): Email {
    return {
      template: 'CAMPAIGN',
      to,
      content,
      vars,
      ...(content.category === 'PRODUCT'
        ? { unsubscribe: { page: `${this.webOrigin}/settings`, oneClick: '' } }
        : {}),
    };
  }
  async preview(content: CampaignContent, sampleUserId?: string) {
    const vars = await this.vars(sampleUserId);
    const message = composeEmail(this.compose(content, vars, vars.email), this.webOrigin);
    return {
      subject: message.subject,
      html: message.html,
      text: message.text,
      problems: contentProblems(content),
    };
  }
  /** Queues the content to the staff member's own address; the jobs function sends it within a minute. */
  async test(staff: Staff, content: CampaignContent, sampleUserId?: string) {
    this.checkContent(content);
    const vars = await this.vars(sampleUserId);
    await transact(this.repo, async (tx) => {
      await queueEmail(
        tx,
        `CAMPAIGN_TEST#${randomUUID()}`,
        this.compose({ ...content, subject: `[Test] ${content.subject}` }, vars, staff.email),
      );
      await this.admin.audit(tx, staff, {
        action: 'EMAIL_TEST_SENT',
        details: { subject: content.subject, to: staff.email },
      });
    });
    return { sentTo: staff.email };
  }

  // Groups ----------------------------------------------------------------------------------
  /** The built-in group of every account; its count is the cached live-account total. */
  private async everyone(): Promise<StoredGroup> {
    const accounts = await this.admin
      .storageTotals()
      .then((t) => t.accounts)
      .catch(() => 0);
    return {
      id: EVERYONE_GROUP,
      name: 'Everyone',
      description: 'Every account, worked out when a campaign starts sending.',
      memberCount: accounts,
      builtIn: true,
      createdAt: '',
      createdBy: 'Built in',
      updatedAt: '',
      updatedBy: 'Built in',
    };
  }
  /** Accounts that have used a Mac, rescanned when the cached list is over 15 minutes old. */
  private async macUserIds(): Promise<MacUsersCache> {
    const cached = (await this.repo.get(MAC_USERS_CACHE))?.data as MacUsersCache | undefined;
    if (cached && Date.now() - Date.parse(cached.computedAt) < MAC_USERS_MAX_AGE_MS)
      return cached;
    const fresh = { computedAt: new Date().toISOString(), userIds: (await macUserIds(this.repo)).sort() };
    await transact(this.repo, (tx) => tx.put(MAC_USERS_CACHE.pk, MAC_USERS_CACHE.sk, fresh)).catch(
      () => undefined,
    );
    return fresh;
  }
  /** The built-in group of accounts that have used the Mac app or a browser on macOS. */
  private async macUsers(): Promise<StoredGroup> {
    const { computedAt, userIds } = await this.macUserIds();
    return {
      id: MAC_USERS_GROUP,
      name: 'Mac users',
      description:
        'Accounts that have used the Mac app or a browser on macOS, worked out when a campaign starts sending.',
      memberCount: userIds.length,
      builtIn: true,
      createdAt: '',
      createdBy: 'Built in',
      updatedAt: computedAt,
      updatedBy: 'Built in',
    };
  }
  private builtIn(id: string) {
    return id === EVERYONE_GROUP ? this.everyone() : this.macUsers();
  }
  private notBuiltIn(id: string) {
    assert(
      !BUILT_IN_GROUPS.includes(id),
      'BUILT_IN_GROUP',
      'This group is built in: its members are worked out for you, and it cannot be changed.',
      409,
    );
  }
  async groups() {
    const [everyone, macUsers, groups] = await Promise.all([
      this.everyone(),
      this.macUsers(),
      allRows<StoredGroup>(this.repo, GROUP_PK),
    ]);
    return {
      items: [everyone, macUsers, ...groups.sort((a, b) => a.name.localeCompare(b.name))],
    };
  }
  async group(id: string) {
    if (BUILT_IN_GROUPS.includes(id)) return { group: await this.builtIn(id), history: [] };
    const [group, log] = await Promise.all([
      getRow<StoredGroup>(read(this.repo), GROUP_PK, id, 'group'),
      this.log('GROUP', id),
    ]);
    return { group, history: log };
  }
  async createGroup(staff: Staff, input: { name: string; description: string }) {
    const id = randomUUID();
    const at = new Date().toISOString();
    const group: StoredGroup = {
      id,
      name: input.name,
      description: input.description,
      memberCount: 0,
      createdAt: at,
      createdBy: staff.email,
      updatedAt: at,
      updatedBy: staff.email,
    };
    await transact(this.repo, async (tx) => {
      await tx.put(GROUP_PK, id, group);
      await this.audit(tx, staff, 'GROUP', id, 'EMAIL_GROUP_CREATED', { name: input.name });
    });
    return group;
  }
  async updateGroup(staff: Staff, id: string, input: EmailGroupBody) {
    this.notBuiltIn(id);
    return transact(this.repo, async (tx) => {
      const group = await getRow<StoredGroup>(tx, GROUP_PK, id, 'group');
      changedSince('group', group, input.expectedUpdatedAt);
      const next: StoredGroup = {
        ...group,
        name: input.name,
        description: input.description,
        ...stamp(staff, group),
      };
      await tx.put(GROUP_PK, id, next);
      await this.audit(tx, staff, 'GROUP', id, 'EMAIL_GROUP_CHANGED', {
        name: next.name,
        ...(group.name !== next.name ? { renamedFrom: group.name } : {}),
      });
      return next;
    });
  }
  /** Campaigns that will still read this group's members when they send. */
  private async pendingCampaignsUsing(groupId: string) {
    return (await allRows<StoredCampaign>(this.repo, CAMPAIGN_PK)).filter(
      (c) =>
        (c.state === 'DRAFT' || c.state === 'SCHEDULED' || (c.state === 'SENDING' && !c.resolvedAt)) &&
        c.audience.groupIds.includes(groupId),
    );
  }
  async deleteGroup(staff: Staff, id: string) {
    this.notBuiltIn(id);
    const group = await getRow<StoredGroup>(read(this.repo), GROUP_PK, id, 'group');
    const using = await this.pendingCampaignsUsing(id);
    assert(
      !using.length,
      'GROUP_IN_USE',
      `Campaigns not yet sent use this group: ${using.map((c) => c.name).join(', ')}. Remove it from them first.`,
      409,
    );
    const members = await allRows<StoredMember>(this.repo, memberPK(id), 'MEMBER#');
    for (let i = 0; i < members.length; i += CHUNK)
      await transact(this.repo, async (tx) => {
        for (const m of members.slice(i, i + CHUNK))
          await tx.delete(memberPK(id), memberSK(recipientKey(m)));
      });
    await transact(this.repo, async (tx) => {
      await tx.delete(GROUP_PK, id);
      await this.audit(tx, staff, 'GROUP', id, 'EMAIL_GROUP_DELETED', {
        name: group.name,
        members: members.length,
      });
    });
    return { deleted: true };
  }
  async members(id: string, cursor?: string) {
    // Everyone has no stored members; the console lists accounts on the Users page.
    if (id === EVERYONE_GROUP) return { items: [], nextCursor: null };
    if (id === MAC_USERS_GROUP) {
      const { computedAt, userIds } = await this.macUserIds();
      const start = Number(cursor ?? 0) || 0;
      const items = await Promise.all(
        userIds.slice(start, start + MAC_MEMBER_PAGE).map(async (userId): Promise<StoredMember> => {
          const account = (await this.repo.get({ pk: userPK(userId), sk: 'PROFILE' }))?.data as
            | Account
            | undefined;
          return {
            userId,
            email: account?.email ?? null,
            name: account?.displayName ?? null,
            addedAt: computedAt,
            addedBy: 'Built in',
          };
        }),
      );
      const next = start + MAC_MEMBER_PAGE;
      return { items, nextCursor: next < userIds.length ? String(next) : null };
    }
    await getRow<StoredGroup>(read(this.repo), GROUP_PK, id, 'group');
    const page = await this.repo.query(memberPK(id), 'MEMBER#', 50, cursor);
    return { items: page.rows.map((r) => r.data as StoredMember), nextCursor: page.cursor };
  }
  /** The account an email, username or account ID names, if any. */
  private async findAccount(identifier: string) {
    const value = identifier.trim();
    let userId: string | undefined;
    if (value.includes('@'))
      userId = ((await this.repo.get({ pk: 'EMAIL', sk: normalizeEmail(value) }))?.data as
        | { userId: string }
        | undefined)?.userId;
    else {
      userId = ((await this.repo.get({ pk: 'USERNAME', sk: value.toLowerCase() }))?.data as
        | { userId: string }
        | undefined)?.userId;
      if (!userId && (await this.repo.get({ pk: userPK(value), sk: 'PROFILE' }))) userId = value;
    }
    if (!userId) return undefined;
    return (await this.repo.get({ pk: userPK(userId), sk: 'PROFILE' }))?.data as Account | undefined;
  }
  /**
   * Adds accounts, by ID or by email or username, to a group. An email that no account uses is
   * added as an address on its own; usernames and IDs must name an account.
   */
  async addMembers(staff: Staff, id: string, userIds: string[], identifiers: string[]) {
    this.notBuiltIn(id);
    await getRow<StoredGroup>(read(this.repo), GROUP_PK, id, 'group');
    const unmatched: string[] = [];
    const found = new Map<string, Omit<StoredMember, 'addedAt' | 'addedBy'>>();
    const addAccount = (account: Account) =>
      found.set(account.id, { userId: account.id, email: account.email, name: account.displayName });
    for (const userId of userIds) {
      const account = (await this.repo.get({ pk: userPK(userId), sk: 'PROFILE' }))?.data as
        | Account
        | undefined;
      if (account) addAccount(account);
      else unmatched.push(userId);
    }
    for (const identifier of identifiers) {
      const account = await this.findAccount(identifier);
      if (account) addAccount(account);
      else if (EMAIL.test(identifier.trim())) {
        const email = normalizeEmail(identifier);
        found.set(addressKey(email), { userId: null, email, name: null });
      } else unmatched.push(identifier);
    }
    const list = [...found.values()];
    let added = 0;
    let addedEmails = 0;
    let alreadyMembers = 0;
    let group: StoredGroup | undefined;
    for (let i = 0; i < list.length || (i === 0 && !group); i += CHUNK) {
      group = await transact(this.repo, async (tx) => {
        const g = await getRow<StoredGroup>(tx, GROUP_PK, id, 'group');
        let fresh = 0;
        for (const entry of list.slice(i, i + CHUNK)) {
          const key = recipientKey(entry);
          if (await tx.get(memberPK(id), memberSK(key))) {
            alreadyMembers++;
            continue;
          }
          const member: StoredMember = {
            ...entry,
            addedAt: new Date().toISOString(),
            addedBy: staff.email,
          };
          await tx.put(memberPK(id), memberSK(key), member);
          if (!entry.userId) addedEmails++;
          fresh++;
        }
        if (fresh) {
          g.memberCount += fresh;
          Object.assign(g, stamp(staff, g));
          await tx.put(GROUP_PK, id, g);
        }
        added += fresh;
        return g;
      });
      if (!list.length) break;
    }
    if (added)
      await transact(this.repo, (tx) =>
        this.audit(tx, staff, 'GROUP', id, 'EMAIL_GROUP_MEMBERS_ADDED', {
          name: group!.name,
          added,
          ...(added <= 20 ? { emails: list.map((a) => a.email).slice(0, 20) } : {}),
        }),
      );
    return { group: group!, added, addedEmails, alreadyMembers, unmatched };
  }
  /** Removes members: accounts by ID, and addresses without an account by email. */
  async removeMembers(staff: Staff, id: string, userIds: string[], addresses: string[] = []) {
    this.notBuiltIn(id);
    let removed = 0;
    let group: StoredGroup | undefined;
    const emails: string[] = [];
    const keys = [...new Set([...userIds, ...addresses.map(addressKey)])];
    for (let i = 0; i < keys.length; i += CHUNK)
      group = await transact(this.repo, async (tx) => {
        const g = await getRow<StoredGroup>(tx, GROUP_PK, id, 'group');
        let gone = 0;
        for (const key of keys.slice(i, i + CHUNK)) {
          const member = await tx.get<StoredMember>(memberPK(id), memberSK(key));
          if (!member) continue;
          await tx.delete(memberPK(id), memberSK(key));
          emails.push(member.email ?? key);
          gone++;
        }
        if (gone) {
          g.memberCount = Math.max(0, g.memberCount - gone);
          Object.assign(g, stamp(staff, g));
          await tx.put(GROUP_PK, id, g);
        }
        removed += gone;
        return g;
      });
    if (removed)
      await transact(this.repo, (tx) =>
        this.audit(tx, staff, 'GROUP', id, 'EMAIL_GROUP_MEMBERS_REMOVED', {
          name: group!.name,
          removed,
          ...(removed <= 20 ? { emails } : {}),
        }),
      );
    return { group: group!, removed };
  }
  /** One account's email settings and groups, for its page in the console. */
  async forUser(userId: string): Promise<AdminUserEmail> {
    const [account, groups] = await Promise.all([
      this.repo.get({ pk: userPK(userId), sk: 'PROFILE' }).then((r) => r?.data as Account | undefined),
      allRows<StoredGroup>(this.repo, GROUP_PK),
    ]);
    const member = await Promise.all(
      groups.map((g) => this.repo.get({ pk: memberPK(g.id), sk: memberSK(userId) })),
    );
    const suppressed = account ? await new EmailSuppressions(this.repo).get(account.email) : undefined;
    return {
      productUpdates: account?.emailPreferences?.productUpdates !== false,
      suppressed: suppressed ? { source: suppressed.source, at: suppressed.at } : null,
      groups: groups
        .filter((_, i) => member[i])
        .map((g) => ({ id: g.id, name: g.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // Campaigns -------------------------------------------------------------------------------
  private async view(c: StoredCampaign) {
    const template = (await this.repo.get({ pk: TEMPLATE_PK, sk: c.templateId }))?.data as
      | StoredTemplate
      | undefined;
    const { resolvedAt: _r, cursor: _c, leaseUntil: _l, ...campaign } = c;
    return { ...campaign, templateName: template?.name ?? c.templateName };
  }
  async campaigns() {
    const items = await allRows<StoredCampaign>(this.repo, CAMPAIGN_PK);
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: await Promise.all(items.map((c) => this.view(c))) };
  }
  async campaign(id: string) {
    const c = await getRow<StoredCampaign>(read(this.repo), CAMPAIGN_PK, id, 'campaign');
    const [view, log, groups, users] = await Promise.all([
      this.view(c),
      this.log('CAMPAIGN', id),
      Promise.all(
        c.audience.groupIds.map(async (groupId) => {
          if (BUILT_IN_GROUPS.includes(groupId)) {
            const group = await this.builtIn(groupId);
            return { id: groupId, name: group.name, memberCount: group.memberCount };
          }
          const g = (await this.repo.get({ pk: GROUP_PK, sk: groupId }))?.data as StoredGroup | undefined;
          return { id: groupId, name: g?.name ?? null, memberCount: g?.memberCount ?? 0 };
        }),
      ),
      Promise.all(
        c.audience.userIds.map(async (userId) => ({
          id: userId,
          email: await this.admin.email(userId),
        })),
      ),
    ]);
    return { campaign: view, groups, users, emails: c.audience.emails ?? [], history: log };
  }
  private async checkTemplate(templateId: string) {
    return getRow<StoredTemplate>(read(this.repo), TEMPLATE_PK, templateId, 'template');
  }
  async createCampaign(staff: Staff, input: Omit<CampaignBody, 'expectedUpdatedAt'>) {
    const template = await this.checkTemplate(input.templateId);
    const id = randomUUID();
    const at = new Date().toISOString();
    const campaign: StoredCampaign = {
      id,
      name: input.name,
      templateId: input.templateId,
      templateName: template.name,
      audience: input.audience,
      state: 'DRAFT',
      scheduledAt: null,
      startedAt: null,
      finishedAt: null,
      counts: emptyCounts(),
      content: null,
      scheduledBy: null,
      createdAt: at,
      createdBy: staff.email,
      updatedAt: at,
      updatedBy: staff.email,
    };
    await transact(this.repo, async (tx) => {
      await tx.put(CAMPAIGN_PK, id, campaign);
      await this.audit(tx, staff, 'CAMPAIGN', id, 'CAMPAIGN_CREATED', { name: input.name });
    });
    return this.view(campaign);
  }
  async updateCampaign(staff: Staff, id: string, input: CampaignBody) {
    const template = await this.checkTemplate(input.templateId);
    const campaign = await transact(this.repo, async (tx) => {
      const c = await getRow<StoredCampaign>(tx, CAMPAIGN_PK, id, 'campaign');
      changedSince('campaign', c, input.expectedUpdatedAt);
      assert(c.state === 'DRAFT', 'INVALID_STATE', 'Only a draft can be edited. Cancel the schedule first.', 409);
      const next: StoredCampaign = {
        ...c,
        name: input.name,
        templateId: input.templateId,
        templateName: template.name,
        audience: input.audience,
        ...stamp(staff, c),
      };
      await tx.put(CAMPAIGN_PK, id, next);
      await this.audit(tx, staff, 'CAMPAIGN', id, 'CAMPAIGN_CHANGED', {
        name: next.name,
        template: template.name,
        groups: next.audience.groupIds.length,
        accounts: next.audience.userIds.length,
        addresses: next.audience.emails.length,
      });
      return next;
    });
    return this.view(campaign);
  }
  async deleteCampaign(staff: Staff, id: string) {
    await transact(this.repo, async (tx) => {
      const c = await getRow<StoredCampaign>(tx, CAMPAIGN_PK, id, 'campaign');
      assert(c.state === 'DRAFT', 'INVALID_STATE', 'Only a draft can be deleted.', 409);
      await tx.delete(CAMPAIGN_PK, id);
      await this.audit(tx, staff, 'CAMPAIGN', id, 'CAMPAIGN_DELETED', { name: c.name });
    });
    return { deleted: true };
  }
  async count(audience: StoredCampaign['audience'], category: CampaignContent['category']) {
    return countAudience(this.repo, audience, category);
  }
  /**
   * Freezes the template into the campaign and queues its send for `at` (now when null). The
   * jobs function picks it up within a minute of that time.
   */
  async schedule(staff: Staff, id: string, at: string | null, reason: string, expectedUpdatedAt: string | null) {
    const current = await getRow<StoredCampaign>(read(this.repo), CAMPAIGN_PK, id, 'campaign');
    const template = await this.checkTemplate(current.templateId);
    this.checkContent(template);
    const when = at ? new Date(at) : new Date();
    assert(
      when.getTime() >= Date.now() - 60_000,
      'VALIDATION_ERROR',
      'Choose a time in the future, or send now.',
    );
    assert(
      when.getTime() <= Date.now() + MAX_SCHEDULE_AHEAD_MS,
      'VALIDATION_ERROR',
      'Campaigns can be scheduled up to 90 days ahead.',
    );
    const count = await countAudience(this.repo, current.audience, template.category);
    assert(count.eligible > 0, 'EMPTY_AUDIENCE', 'No one in this audience can get this email.', 409);
    const campaign = await transact(this.repo, async (tx) => {
      const c = await getRow<StoredCampaign>(tx, CAMPAIGN_PK, id, 'campaign');
      changedSince('campaign', c, expectedUpdatedAt);
      assert(c.state === 'DRAFT', 'INVALID_STATE', 'This campaign is already scheduled or sent.', 409);
      const content: CampaignContent = {
        subject: template.subject,
        preheader: template.preheader,
        markdown: template.markdown,
        category: template.category,
      };
      const scheduledAt = when.toISOString();
      const next: StoredCampaign = {
        ...c,
        content,
        templateName: template.name,
        state: 'SCHEDULED',
        scheduledAt,
        scheduledBy: staff.email,
        ...stamp(staff, c),
      };
      await tx.put(CAMPAIGN_PK, id, next);
      const job: Job = {
        id: campaignJobId(id),
        type: 'CAMPAIGN_SEND',
        entityId: id,
        dueAt: scheduledAt,
        attempts: 0,
      };
      await tx.put('JOB', job.id, job, { gpk: 'JOB', gsk: job.dueAt });
      await this.audit(
        tx,
        staff,
        'CAMPAIGN',
        id,
        at ? 'CAMPAIGN_SCHEDULED' : 'CAMPAIGN_SENT_NOW',
        {
          name: c.name,
          template: template.name,
          category: template.category,
          scheduledAt,
          eligible: count.eligible,
        },
        reason,
      );
      return next;
    });
    return this.view(campaign);
  }
  /** Takes a scheduled campaign back to a draft before it starts sending. */
  async cancel(staff: Staff, id: string, reason: string) {
    const campaign = await transact(this.repo, async (tx) => {
      const c = await getRow<StoredCampaign>(tx, CAMPAIGN_PK, id, 'campaign');
      assert(
        c.state === 'SCHEDULED',
        'INVALID_STATE',
        c.state === 'SENDING' ? 'It has started sending. Stop it instead.' : 'Only a scheduled campaign can be cancelled.',
        409,
      );
      const next: StoredCampaign = {
        ...c,
        state: 'DRAFT',
        content: null,
        scheduledAt: null,
        scheduledBy: null,
        ...stamp(staff, c),
      };
      await tx.put(CAMPAIGN_PK, id, next);
      if (await tx.get('JOB', campaignJobId(id))) await tx.delete('JOB', campaignJobId(id));
      await this.audit(tx, staff, 'CAMPAIGN', id, 'CAMPAIGN_CANCELLED', { name: c.name }, reason);
      return next;
    });
    return this.view(campaign);
  }
  /** Stops a campaign mid-send; everyone not yet sent to is skipped. */
  async stop(staff: Staff, id: string, reason: string) {
    const campaign = await transact(this.repo, async (tx) => {
      const c = await getRow<StoredCampaign>(tx, CAMPAIGN_PK, id, 'campaign');
      assert(c.state === 'SENDING', 'INVALID_STATE', 'Only a campaign that is sending can be stopped.', 409);
      const next: StoredCampaign = { ...c, state: 'STOPPED', ...stamp(staff, c) };
      await tx.put(CAMPAIGN_PK, id, next);
      await this.audit(
        tx,
        staff,
        'CAMPAIGN',
        id,
        'CAMPAIGN_STOPPED',
        { name: c.name, sent: c.counts.sent, pending: c.counts.pending },
        reason,
      );
      return next;
    });
    return this.view(campaign);
  }
  async recipients(id: string, status?: Recipient['status'], cursor?: string) {
    await getRow<StoredCampaign>(read(this.repo), CAMPAIGN_PK, id, 'campaign');
    return recipientPage(this.repo, id, status, cursor);
  }
}
