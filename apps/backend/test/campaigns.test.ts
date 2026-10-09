import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, type Job } from '../src/domain';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { createAdminApp } from '../src/admin/api';
import { DevelopmentDirectory } from '../src/admin/directory';
import { DevelopmentStaffAuth } from '../src/admin/staff-auth';
import {
  contentProblems,
  renderCampaign,
  renderMarkdown,
  sampleVars,
} from '../src/campaign-content';
import { campaignStep, CAMPAIGN_PK, type StoredCampaign } from '../src/campaigns';
import { composeEmail, type Email } from '../src/emails';
import { EmailLinks, EmailSuppressions } from '../src/email-preferences';

const ORIGIN = 'http://console.test';
const links = new EmailLinks('campaign-test-secret-long-enough-for-signing', 'https://app.test');
let service: StorageService;
let userAuth: DevelopmentAuth;
let adminApp: ReturnType<typeof createAdminApp>['app'];
let userApp: ReturnType<typeof createApp>['app'];
let admin: string;
let support: string;

async function signIn(email: string) {
  const post = (path: string, body: unknown) =>
    adminApp.request(`/api/v1/admin${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    });
  const first = await (
    await post('/auth/login', { email, password: 'Development-only-123!' })
  ).json();
  const second = await post('/auth/challenge', {
    email,
    session: first.session,
    challenge: 'MFA',
    code: '123456',
  });
  return second.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const response = await adminApp.request(`/api/v1/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(cookie: string, method: string, path: string, body?: unknown) {
  const r = await call(cookie, method, path, body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
}
/** Runs the job queue, returning the campaign emails it sent. */
async function runJobs(send?: (email: Email) => Promise<void>) {
  const sent: Email[] = [];
  await service.runJobs(
    async (email) => {
      await send?.(email);
      sent.push(email);
    },
    { emailLinks: links, ratePerSecond: 1000 },
  );
  return sent.filter((e) => e.template === 'CAMPAIGN');
}
const template = (category: 'PRODUCT' | 'SERVICE' = 'PRODUCT') => ({
  name: 'Launch news',
  category,
  subject: 'News for {{firstName}}',
  preheader: 'What changed in harbor0',
  markdown:
    '# Hello {{name}}\n\nYou use **{{storageUsed}}**.\n\n[[Open harbor0]](https://app.harbor0.com)',
  survey: null,
});

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  userAuth = new DevelopmentAuth();
  userApp = createApp(service, userAuth, [], undefined, undefined, undefined, links).app;
  adminApp = createAdminApp(
    service,
    new DevelopmentDirectory(userAuth),
    new DevelopmentStaffAuth(),
    {
      origins: [ORIGIN],
      secureCookies: false,
      webOrigin: 'https://app.test',
    },
  ).app;
  for (const identity of userAuth.users.values()) await service.ensureUser(identity);
  admin = await signIn('admin@example.test');
  support = await signIn('support@example.test');
  // Drain sign-up email so tests only see what campaigns send.
  await service.runJobs(async () => {});
});

describe('campaign content', () => {
  it('renders a safe subset of Markdown and escapes everything else', () => {
    const { html, text } = renderMarkdown(
      [
        '## Title <b>',
        'Line one with **bold**, *em* and `code <x>`',
        'line two',
        '',
        '- one',
        '- [two](https://example.com/?a=1&b=2)',
        '',
        '1. first',
        '',
        '[bad](javascript:alert(1))',
        '<script>alert(1)</script>',
        '---',
        '[[Go]](https://example.com)',
      ].join('\n'),
    );
    expect(html).toContain('<h2 style="');
    expect(html).toContain('Title &lt;b&gt;');
    expect(html).toContain('<strong style="color:#16181d;">bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('code &lt;x&gt;</code>');
    expect(html).toContain('<br>line two');
    expect(html).toMatch(/<ul style="[^"]*"><li style="[^"]*">one<\/li>/);
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(html).toContain('<ol');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<hr');
    expect(html).toContain('>Go</a>');
    expect(text).toContain('- two (https://example.com/?a=1&b=2)');
    expect(text).toContain('Go: https://example.com');
    expect(text).toContain('<script>alert(1)</script>');
  });

  it("fills variables after rendering, so an account's name can't add markup", () => {
    const rendered = renderCampaign(template(), {
      ...sampleVars,
      name: '[evil](https://evil.test) <img src=x>',
      firstName: '<b>Al</b>',
    });
    expect(rendered.subject).toBe('News for <b>Al</b>');
    expect(rendered.html).toContain('Hello [evil](https://evil.test) &lt;img src=x&gt;');
    expect(rendered.html).not.toContain('href="https://evil.test"');
  });

  it('reports unknown variables and unsafe links', () => {
    expect(contentProblems(template())).toEqual([]);
    const problems = contentProblems({
      subject: 'Hi {{nmae}}',
      preheader: '',
      markdown: '[x](ftp://files)',
    });
    expect(problems[0]).toContain('{{nmae}} is not a variable');
    expect(problems[1]).toContain('ftp://files');
  });

  it('puts campaigns in the branded layout with an unsubscribe footer for product updates', () => {
    const message = composeEmail(
      {
        template: 'CAMPAIGN',
        to: 'alice@example.test',
        content: template(),
        vars: sampleVars,
        unsubscribe: links.unsubscribe('alice'),
      },
      'https://app.test',
    );
    expect(message.subject).toBe('News for Alex');
    expect(message.html).toContain('https://harbor0.com/icon.png');
    expect(message.html).toContain('What changed in harbor0');
    expect(message.html).toContain('Unsubscribe</a>');
    expect(message.text).toContain('Hello Alex Morgan');
    expect(message.headers.map((h) => h.name)).toContain('List-Unsubscribe');
  });
});

describe('templates', () => {
  it('are created, edited over the version loaded, previewed and deleted by admins', async () => {
    const created = await ok(admin, 'POST', '/email/templates', template());
    expect(created).toMatchObject({ name: 'Launch news', createdBy: 'admin@example.test' });
    const edit = { ...template(), name: 'Launch', expectedUpdatedAt: created.updatedAt };
    const saved = await ok(admin, 'PUT', `/email/templates/${created.id}`, edit);
    const stale = await call(admin, 'PUT', `/email/templates/${created.id}`, edit);
    expect(stale.status).toBe(409);
    const detail = await ok(admin, 'GET', `/email/templates/${created.id}`);
    expect(detail.template.name).toBe('Launch');
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual([
      'EMAIL_TEMPLATE_CHANGED',
      'EMAIL_TEMPLATE_CREATED',
    ]);
    const { name: _, ...content } = template();
    const preview = await ok(support, 'POST', '/email/preview', {
      ...content,
      sampleUserId: 'alice',
    });
    expect(preview.subject).toBe('News for Alice');
    expect(preview.html).toContain('Hello Alice Morgan');
    expect(preview.problems).toEqual([]);
    expect((await ok(admin, 'DELETE', `/email/templates/${saved.id}`)).deleted).toBe(true);
    expect((await ok(admin, 'GET', '/email/templates')).items).toEqual([]);
  });

  it('refuse support staff and content with problems', async () => {
    expect((await call(support, 'POST', '/email/templates', template())).status).toBe(403);
    const bad = await call(admin, 'POST', '/email/templates', {
      ...template(),
      subject: 'Hi {{nope}}',
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('INVALID_TEMPLATE');
  });

  it('send a test to the staff member through the job queue', async () => {
    const { name: _, ...content } = template();
    expect((await ok(admin, 'POST', '/email/test', content)).sentTo).toBe('admin@example.test');
    const [email] = await runJobs();
    expect(email).toMatchObject({ to: 'admin@example.test', template: 'CAMPAIGN' });
    expect((email as Extract<Email, { template: 'CAMPAIGN' }>).content.subject).toBe(
      '[Test] News for {{firstName}}',
    );
    // A test has a footer link but no one-click header.
    expect(composeEmail(email!, 'https://app.test').headers).toEqual([]);
  });
});

describe('groups', () => {
  it('hold accounts added by email, username or ID, and show on the account page', async () => {
    const group = await ok(admin, 'POST', '/email/groups', { name: 'Testers' });
    const added = await ok(admin, 'POST', `/email/groups/${group.id}/members`, {
      identifiers: ['ALICE@example.test', 'bob', 'Nobody@example.test', 'no-such-user'],
      userIds: ['alice'],
    });
    expect(added).toMatchObject({
      added: 3,
      addedEmails: 1,
      alreadyMembers: 0,
      unmatched: ['no-such-user'],
    });
    expect(added.group.memberCount).toBe(3);
    const again = await ok(admin, 'POST', `/email/groups/${group.id}/members`, {
      userIds: ['bob'],
      identifiers: ['nobody@example.test'],
    });
    expect(again).toMatchObject({ added: 0, alreadyMembers: 2 });
    const members = await ok(admin, 'GET', `/email/groups/${group.id}/members`);
    expect(members.items.map((m: { email: string }) => m.email).sort()).toEqual([
      'alice@example.test',
      'bob@example.test',
      'nobody@example.test',
    ]);
    expect(
      members.items.find((m: { email: string }) => m.email === 'nobody@example.test').userId,
    ).toBeNull();
    const gone = await ok(admin, 'POST', `/email/groups/${group.id}/members/remove`, {
      emails: ['nobody@example.test'],
    });
    expect(gone).toMatchObject({ removed: 1, group: { memberCount: 2 } });
    expect((await ok(support, 'GET', '/users/alice')).email).toEqual({
      productUpdates: true,
      suppressed: null,
      groups: [{ id: group.id, name: 'Testers' }],
    });
    const removed = await ok(admin, 'POST', `/email/groups/${group.id}/members/remove`, {
      userIds: ['alice'],
    });
    expect(removed).toMatchObject({ removed: 1, group: { memberCount: 1 } });
    expect((await ok(admin, 'GET', '/users/alice')).email.groups).toEqual([]);
  });

  it("add every account the user list's search and filters match, audited with them", async () => {
    const group = await ok(admin, 'POST', '/email/groups', { name: 'Quiet ones' });
    const path = `/email/groups/${group.id}/members/matching`;
    const one = await ok(admin, 'POST', path, { q: 'al', filters: { storage: 'empty' } });
    expect(one).toMatchObject({ added: 1, alreadyMembers: 0, group: { memberCount: 1 } });
    const all = await ok(admin, 'POST', path, { filters: { joined: '7d', storage: 'gb-0' } });
    expect(all).toMatchObject({ added: 1, alreadyMembers: 1, group: { memberCount: 2 } });
    expect((await ok(admin, 'POST', path, { filters: { state: 'deleted' } })).added).toBe(0);
    const detail = await ok(admin, 'GET', `/email/groups/${group.id}`);
    expect(detail.history[0].details.source).toMatchObject({
      from: 'users',
      filters: { joined: '7d' },
      matched: 2,
    });
    expect((await call(support, 'POST', path, {})).status).toBe(403);
    expect((await call(admin, 'POST', path, { filters: { seen: '0d' } })).status).toBe(400);
    expect(
      (await call(admin, 'POST', '/email/groups/everyone/members/matching', {})).status,
    ).not.toBe(200);
  });

  it('cannot be deleted while a campaign not yet sent uses them', async () => {
    const group = await ok(admin, 'POST', '/email/groups', { name: 'Testers' });
    const t = await ok(admin, 'POST', '/email/templates', template());
    const campaign = await ok(admin, 'POST', '/email/campaigns', {
      name: 'Launch',
      templateId: t.id,
      audience: { groupIds: [group.id], userIds: [] },
    });
    expect((await call(admin, 'DELETE', `/email/groups/${group.id}`)).status).toBe(409);
    expect((await call(admin, 'DELETE', `/email/templates/${t.id}`)).status).toBe(409);
    await ok(admin, 'DELETE', `/email/campaigns/${campaign.id}`);
    await ok(admin, 'DELETE', `/email/groups/${group.id}`);
  });
});

describe('campaigns', () => {
  async function draft(category: 'PRODUCT' | 'SERVICE' = 'PRODUCT') {
    const group = await ok(admin, 'POST', '/email/groups', { name: 'Everyone' });
    await ok(admin, 'POST', `/email/groups/${group.id}/members`, { userIds: ['alice', 'bob'] });
    const t = await ok(admin, 'POST', '/email/templates', template(category));
    return ok(admin, 'POST', '/email/campaigns', {
      name: 'Launch',
      templateId: t.id,
      audience: { groupIds: [group.id], userIds: ['alice'] },
    });
  }
  const schedule = (c: { id: string; updatedAt: string }, at: string | null = null) =>
    call(admin, 'POST', `/email/campaigns/${c.id}/schedule`, {
      at,
      reason: 'Launch announcement',
      expectedUpdatedAt: c.updatedAt,
    });
  const unsubscribeBob = () =>
    userApp.request(`/v1/email/unsubscribe?t=${encodeURIComponent(links.token('bob'))}`, {
      method: 'POST',
    });

  it('send product updates once to each subscribed account, with unsubscribe links', async () => {
    const campaign = await draft();
    await unsubscribeBob();
    const count = await ok(support, 'POST', '/email/audience/count', {
      audience: campaign.audience,
      category: 'PRODUCT',
    });
    expect(count).toEqual({ total: 2, eligible: 1, skipped: { UNSUBSCRIBED: 1 } });
    const scheduled = await schedule(campaign);
    expect(scheduled.data).toMatchObject({ state: 'SCHEDULED', scheduledBy: 'admin@example.test' });
    expect(scheduled.data.content.subject).toBe('News for {{firstName}}');
    // A scheduled campaign is no longer editable.
    const edit = await call(admin, 'PUT', `/email/campaigns/${campaign.id}`, {
      name: 'x',
      templateId: campaign.templateId,
      audience: campaign.audience,
      expectedUpdatedAt: scheduled.data.updatedAt,
    });
    expect(edit.status).toBe(409);

    const sent = await runJobs();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'alice@example.test', vars: { firstName: 'Alice' } });
    expect(sent[0]!.unsubscribe).toEqual(links.unsubscribe('alice'));
    expect(await runJobs()).toEqual([]);

    const detail = await ok(admin, 'GET', `/email/campaigns/${campaign.id}`);
    expect(detail.campaign).toMatchObject({
      state: 'SENT',
      counts: { total: 2, pending: 0, sent: 1, skipped: 1, failed: 0 },
    });
    expect(detail.campaign.startedAt).toBeTruthy();
    expect(detail.campaign.finishedAt).toBeTruthy();
    expect(detail.groups).toEqual([
      { id: campaign.audience.groupIds[0], name: 'Everyone', memberCount: 2 },
    ]);
    expect(detail.history[0]).toMatchObject({
      action: 'CAMPAIGN_SENT_NOW',
      reason: 'Launch announcement',
    });
    const skipped = await ok(
      admin,
      'GET',
      `/email/campaigns/${campaign.id}/recipients?status=SKIPPED`,
    );
    expect(skipped.items).toEqual([
      expect.objectContaining({ userId: 'bob', status: 'SKIPPED', reason: 'UNSUBSCRIBED' }),
    ]);
  });

  it('send service notices even to unsubscribed accounts, without unsubscribe links', async () => {
    const campaign = await draft('SERVICE');
    await unsubscribeBob();
    await new EmailSuppressions(service.repo).add('nobody@example.test', 'BOUNCE');
    await schedule(campaign);
    const sent = await runJobs();
    expect(sent.map((e) => e.to).sort()).toEqual(['alice@example.test', 'bob@example.test']);
    expect(sent.every((e) => !e.unsubscribe)).toBe(true);
  });

  it('skip suppressed, suspended and unverified accounts', async () => {
    const campaign = await draft('SERVICE');
    await new EmailSuppressions(service.repo).add('Bob@Example.test', 'COMPLAINT');
    expect(
      await ok(admin, 'POST', '/email/audience/count', {
        audience: campaign.audience,
        category: 'SERVICE',
      }),
    ).toMatchObject({ eligible: 1, skipped: { SUPPRESSED: 1 } });
    await schedule(campaign);
    expect((await runJobs()).map((e) => e.to)).toEqual(['alice@example.test']);
  });

  it('wait for their time and can be cancelled back to a draft before it', async () => {
    const campaign = await draft();
    const at = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = await schedule(campaign, at);
    expect(scheduled.data.scheduledAt).toBe(at);
    expect(await runJobs()).toEqual([]);
    const job = await service.repo.get({ pk: 'JOB', sk: `CAMPAIGN#${campaign.id}` });
    expect((job!.data as Job).dueAt).toBe(at);
    const cancelled = await ok(admin, 'POST', `/email/campaigns/${campaign.id}/cancel`, {
      reason: 'Wrong date',
    });
    expect(cancelled).toMatchObject({ state: 'DRAFT', scheduledAt: null, content: null });
    expect(await service.repo.get({ pk: 'JOB', sk: `CAMPAIGN#${campaign.id}` })).toBeUndefined();
    expect((await schedule(cancelled, new Date(Date.now() - 3600_000).toISOString())).status).toBe(
      400,
    );
  });

  it('refuse an audience no one in can receive', async () => {
    const t = await ok(admin, 'POST', '/email/templates', template());
    const campaign = await ok(admin, 'POST', '/email/campaigns', {
      name: 'Empty',
      templateId: t.id,
      audience: { groupIds: [], userIds: [] },
    });
    const r = await schedule(campaign);
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('EMPTY_AUDIENCE');
  });

  it('pause when SES throttles, and skip everyone left once stopped', async () => {
    const campaign = await draft('SERVICE');
    await schedule(campaign);
    const throttled = Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' });
    expect(
      await runJobs(async () => {
        throw throttled;
      }),
    ).toEqual([]);
    const paused = await ok(admin, 'GET', `/email/campaigns/${campaign.id}`);
    expect(paused.campaign).toMatchObject({ state: 'SENDING', counts: { pending: 2, sent: 0 } });
    await ok(admin, 'POST', `/email/campaigns/${campaign.id}/stop`, { reason: 'Typo in subject' });
    // The paused job comes back a second later; run its next step directly.
    expect(
      await campaignStep(service, campaign.id, Date.now() + 10_000, { ratePerSecond: 1000 }),
    ).toBe(true);
    const stopped = await ok(admin, 'GET', `/email/campaigns/${campaign.id}`);
    expect(stopped.campaign).toMatchObject({
      state: 'STOPPED',
      counts: { total: 2, pending: 0, skipped: 2 },
    });
    expect(stopped.campaign.finishedAt).toBeTruthy();
  });

  it('record a failed address and carry on', async () => {
    const campaign = await draft('SERVICE');
    await schedule(campaign);
    const sent = await runJobs(async (email) => {
      if (email.to === 'bob@example.test')
        throw Object.assign(new Error('bad'), { name: 'MessageRejected' });
    });
    expect(sent.map((e) => e.to)).toEqual(['alice@example.test']);
    const failed = await ok(
      admin,
      'GET',
      `/email/campaigns/${campaign.id}/recipients?status=FAILED`,
    );
    expect(failed.items).toEqual([
      expect.objectContaining({ userId: 'bob', status: 'FAILED', error: 'MessageRejected' }),
    ]);
    expect((await ok(admin, 'GET', `/email/campaigns/${campaign.id}`)).campaign.state).toBe('SENT');
  });

  it('never send twice when two job runs overlap', async () => {
    const campaign = await draft('SERVICE');
    await schedule(campaign);
    const sent: string[] = [];
    const options = {
      ratePerSecond: 1000,
      sendEmail: async (email: Email) => {
        await new Promise((r) => setTimeout(r, 5));
        sent.push(email.to);
      },
    };
    const deadline = Date.now() + 10_000;
    const results = await Promise.all([
      campaignStep(service, campaign.id, deadline, options),
      campaignStep(service, campaign.id, deadline, options),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(sent.sort()).toEqual(['alice@example.test', 'bob@example.test']);
    const stored = (await service.repo.get({ pk: CAMPAIGN_PK, sk: campaign.id }))!
      .data as StoredCampaign;
    expect(stored.leaseUntil).toBeNull();
  });

  it('are only editable and deletable as drafts, by admins', async () => {
    const campaign = await draft();
    const body = {
      name: 'Renamed',
      templateId: campaign.templateId,
      audience: { groupIds: [], userIds: ['bob'] },
      expectedUpdatedAt: campaign.updatedAt,
    };
    expect((await call(support, 'PUT', `/email/campaigns/${campaign.id}`, body)).status).toBe(403);
    const saved = await ok(admin, 'PUT', `/email/campaigns/${campaign.id}`, body);
    expect(saved).toMatchObject({ name: 'Renamed', audience: { userIds: ['bob'] } });
    await schedule(saved);
    expect((await call(admin, 'DELETE', `/email/campaigns/${campaign.id}`)).status).toBe(409);
    expect((await ok(support, 'GET', '/email/campaigns')).items).toHaveLength(1);
  });
});

describe('the Everyone group', () => {
  it('is listed first, holds every account, and cannot be changed', async () => {
    const mine = await ok(admin, 'POST', '/email/groups', { name: 'Testers' });
    const groups = (await ok(support, 'GET', '/email/groups')).items;
    expect(groups.map((g: { id: string }) => g.id)).toEqual(['everyone', 'mac-users', mine.id]);
    expect(groups[0]).toMatchObject({ name: 'Everyone', builtIn: true, memberCount: 2 });
    expect((await ok(admin, 'GET', '/email/groups/everyone')).group.builtIn).toBe(true);
    for (const [method, path, body] of [
      ['PUT', '/email/groups/everyone', { name: 'x', description: '', expectedUpdatedAt: '' }],
      ['DELETE', '/email/groups/everyone', undefined],
      ['POST', '/email/groups/everyone/members', { userIds: ['alice'] }],
      ['POST', '/email/groups/everyone/members/remove', { userIds: ['alice'] }],
    ] as const) {
      const r = await call(admin, method, path, body);
      expect(r.status, path).toBe(409);
      expect(r.data.error.code).toBe('BUILT_IN_GROUP');
    }
    // Account pages list only the groups staff made.
    expect((await ok(admin, 'GET', '/users/alice')).email.groups).toEqual([]);
  });

  it('sends to every account, including ones that join after scheduling', async () => {
    const t = await ok(admin, 'POST', '/email/templates', template('SERVICE'));
    const campaign = await ok(admin, 'POST', '/email/campaigns', {
      name: 'Everyone',
      templateId: t.id,
      audience: { groupIds: ['everyone'], userIds: ['alice'] },
    });
    expect(
      await ok(admin, 'POST', '/email/audience/count', {
        audience: campaign.audience,
        category: 'SERVICE',
      }),
    ).toMatchObject({ total: 2, eligible: 2 });
    expect((await ok(admin, 'GET', `/email/campaigns/${campaign.id}`)).groups).toEqual([
      { id: 'everyone', name: 'Everyone', memberCount: 2 },
    ]);
    await ok(admin, 'POST', `/email/campaigns/${campaign.id}/schedule`, {
      at: null,
      reason: 'Announcement',
      expectedUpdatedAt: campaign.updatedAt,
    });
    await service.ensureUser({
      id: 'carol',
      email: 'carol@example.test',
      emailVerified: true,
      username: 'carol',
      displayName: 'Carol',
    });
    await service.runJobs(async () => {});
    const campaignJob = await service.repo.get({ pk: 'JOB', sk: `CAMPAIGN#${campaign.id}` });
    expect(campaignJob).toBeUndefined();
    const sent = await ok(admin, 'GET', `/email/campaigns/${campaign.id}/recipients?status=SENT`);
    expect(sent.items.map((r: { email: string }) => r.email).sort()).toEqual([
      'alice@example.test',
      'bob@example.test',
      'carol@example.test',
    ]);
  });
});

describe('the Mac users group', () => {
  it('holds accounts that used the Mac app or a browser on macOS, and cannot be changed', async () => {
    await service.registerDevice('alice', { name: 'Safari on macOS', platform: 'WEB' });
    await service.registerDevice('bob', { name: 'Chrome on Windows', platform: 'WEB' });
    await service.registerDevice('bob', { name: 'Pixel 9', platform: 'ANDROID' });
    const groups = (await ok(support, 'GET', '/email/groups')).items;
    expect(groups.map((g: { id: string }) => g.id)).toEqual(['everyone', 'mac-users']);
    expect(groups[1]).toMatchObject({ name: 'Mac users', builtIn: true, memberCount: 1 });
    const members = await ok(admin, 'GET', '/email/groups/mac-users/members');
    expect(members.items.map((m: { email: string }) => m.email)).toEqual(['alice@example.test']);
    for (const [method, path, body] of [
      ['PUT', '/email/groups/mac-users', { name: 'x', description: '', expectedUpdatedAt: '' }],
      ['DELETE', '/email/groups/mac-users', undefined],
      ['POST', '/email/groups/mac-users/members', { userIds: ['bob'] }],
    ] as const) {
      const r = await call(admin, method, path, body);
      expect(r.status, path).toBe(409);
      expect(r.data.error.code).toBe('BUILT_IN_GROUP');
    }

    // A campaign rescans when it sends, so a Mac first seen after scheduling is included.
    const t = await ok(admin, 'POST', '/email/templates', template('SERVICE'));
    const campaign = await ok(admin, 'POST', '/email/campaigns', {
      name: 'Mac app',
      templateId: t.id,
      audience: { groupIds: ['mac-users'], userIds: [] },
    });
    await ok(admin, 'POST', `/email/campaigns/${campaign.id}/schedule`, {
      at: null,
      reason: 'Mac release',
      expectedUpdatedAt: campaign.updatedAt,
    });
    await service.registerDevice('bob', { name: 'MacBook Air', platform: 'MACOS' });
    await service.runJobs(async () => {});
    const sent = await ok(admin, 'GET', `/email/campaigns/${campaign.id}/recipients?status=SENT`);
    expect(sent.items.map((r: { email: string }) => r.email).sort()).toEqual([
      'alice@example.test',
      'bob@example.test',
    ]);
  });
});

describe('addresses without an account', () => {
  async function invite(email: string, code: string) {
    await transact(service.repo, async (tx) => {
      await tx.put('BETA_EMAIL', email, {
        email,
        state: 'INVITED',
        code,
        requestedAt: '2026-10-01T00:00:00.000Z',
      });
      await tx.put('BETA_INVITE', code, { email });
    });
  }
  async function draft(audience: { groupIds?: string[]; emails?: string[] }) {
    const t = await ok(admin, 'POST', '/email/templates', {
      ...template(),
      markdown: 'Hi {{name}}\n\n[[Create your account]]({{signupLink}})',
    });
    return ok(admin, 'POST', '/email/campaigns', {
      name: 'Nudge',
      templateId: t.id,
      audience: { groupIds: [], userIds: [], ...audience },
    });
  }
  const send = (c: { id: string; updatedAt: string }) =>
    ok(admin, 'POST', `/email/campaigns/${c.id}/schedule`, {
      at: null,
      reason: 'Nudge invitees',
      expectedUpdatedAt: c.updatedAt,
    });

  it('get their own sign-up link and an unsubscribe link for the address', async () => {
    await invite('invitee@example.test', 'code-1');
    const group = await ok(admin, 'POST', '/email/groups', { name: 'Invitees' });
    await ok(admin, 'POST', `/email/groups/${group.id}/members`, {
      identifiers: ['invitee@example.test', 'stranger@example.test', 'alice@example.test'],
    });
    const campaign = await draft({ groupIds: [group.id], emails: ['INVITEE@example.test'] });
    const count = await ok(support, 'POST', '/email/audience/count', {
      audience: campaign.audience,
      category: 'PRODUCT',
    });
    expect(count).toEqual({ total: 3, eligible: 3, skipped: {} });
    await send(campaign);
    const sent = await runJobs();
    const to = (email: string) => sent.find((e) => e.to === email)!;
    expect(sent).toHaveLength(3);
    expect(to('invitee@example.test')).toMatchObject({
      vars: { name: 'invitee', signupLink: 'https://app.test/signup?invite=code-1' },
      unsubscribe: links.unsubscribeAddress('invitee@example.test'),
    });
    expect(to('stranger@example.test').vars.signupLink).toBe('https://app.test/signup');
    expect(to('alice@example.test').unsubscribe).toEqual(links.unsubscribe('alice'));
    const html = composeEmail(to('invitee@example.test'), 'https://app.test').html;
    expect(html).toContain('href="https://app.test/signup?invite=code-1"');
    const recipients = await ok(admin, 'GET', `/email/campaigns/${campaign.id}/recipients`);
    expect(recipients.items).toContainEqual(
      expect.objectContaining({ userId: null, email: 'stranger@example.test', status: 'SENT' }),
    );
  });

  it('can unsubscribe from product updates and back with the address link', async () => {
    const token = encodeURIComponent(links.addressToken('stranger@example.test'));
    const unsubscribed = await userApp.request(`/v1/email/unsubscribe?t=${token}`, {
      method: 'POST',
    });
    expect(await unsubscribed.json()).toEqual({
      subscription: { email: 's•••@example.test', productUpdates: false },
    });
    const campaign = await draft({ emails: ['stranger@example.test', 'other@example.test'] });
    const count = await ok(support, 'POST', '/email/audience/count', {
      audience: campaign.audience,
      category: 'PRODUCT',
    });
    expect(count).toEqual({ total: 2, eligible: 1, skipped: { UNSUBSCRIBED: 1 } });
    const page = await userApp.request(`/v1/email/unsubscribe?t=${token}`);
    expect((await page.json()).subscription.productUpdates).toBe(false);
    expect(links.verify(decodeURIComponent(token))).toBeUndefined();
    const forged = links.addressToken('a@example.test').replace(/\.[^.]+$/, '.x');
    expect((await userApp.request(`/v1/email/unsubscribe?t=${forged}`)).status).toBe(400);
  });

  it('are sent to as the account once one uses the address', async () => {
    const campaign = await draft({ emails: ['alice@example.test'] });
    expect(
      await ok(support, 'POST', '/email/audience/count', {
        audience: campaign.audience,
        category: 'PRODUCT',
      }),
    ).toEqual({ total: 1, eligible: 1, skipped: {} });
    await send(campaign);
    const sent = await runJobs();
    expect(sent[0]).toMatchObject({
      to: 'alice@example.test',
      unsubscribe: links.unsubscribe('alice'),
    });
    const recipients = await ok(admin, 'GET', `/email/campaigns/${campaign.id}/recipients`);
    expect(recipients.items[0]).toMatchObject({ userId: 'alice' });
  });
});

describe('surveys', () => {
  const survey = {
    questions: [
      {
        id: 'nps',
        kind: 'RATING',
        prompt: 'How likely are you to recommend harbor0?',
        scale: 10,
        required: true,
      },
      {
        id: 'use',
        kind: 'MULTI',
        prompt: 'What do you use?',
        options: ['Sync', 'Backups', 'Sharing'],
      },
      { id: 'more', kind: 'TEXT', prompt: 'Anything else?' },
    ],
  };
  const parsed = {
    questions: survey.questions.map((q) => ({ options: [], scale: 5, required: false, ...q })),
  } as Parameters<typeof renderCampaign>[0]['survey'];

  it('place the survey where the message says, with one-click answers for the first question', () => {
    const content = {
      ...template(),
      markdown: 'Hi\n\n{{survey}}\n\nThanks!',
      survey: parsed,
    };
    expect(contentProblems(content)).toEqual([]);
    const rendered = renderCampaign(content, sampleVars, 'https://app.test/survey?t=abc');
    expect(rendered.html.indexOf('a=0')).toBeLessThan(rendered.html.indexOf('Thanks!'));
    expect(rendered.html).toContain('href="https://app.test/survey?t=abc&amp;a=10"');
    expect(rendered.html).toContain('2 more short questions');
    expect(rendered.text).toContain('10: https://app.test/survey?t=abc&a=10');
    // Without a placeholder it goes at the end; without a link (no survey) nothing is added.
    const end = renderCampaign({ ...content, markdown: 'Hi' }, sampleVars, 'https://app.test/s');
    expect(end.html.indexOf('Hi')).toBeLessThan(end.html.indexOf('app.test/s?a=0'));
    expect(renderCampaign({ ...content, survey: null }, sampleVars).html).not.toContain('\u0001');
  });

  it('refuse a misplaced placeholder or a survey that cannot be answered', () => {
    expect(contentProblems({ ...template(), markdown: 'Hi\n\n{{survey}}' })).toEqual([
      'The message places a survey with {{survey}}, but it has no questions.',
    ]);
    expect(
      contentProblems({ ...template(), markdown: 'Answer {{survey}} now', survey: parsed }),
    ).toEqual(['Put {{survey}} on a line of its own to place the survey there.']);
    const lonely = { questions: [{ ...parsed!.questions[1]!, options: ['Only'] }] };
    expect(contentProblems({ ...template(), survey: lonely })).toEqual([
      'Survey question 1 needs at least two choices.',
    ]);
  });

  it('take answers from each recipient’s own link and show them in the console', async () => {
    const t = await ok(admin, 'POST', '/email/templates', { ...template(), survey });
    expect(t.survey.questions[0]).toMatchObject({ id: 'nps', scale: 10, required: true });
    const campaign = await ok(admin, 'POST', '/email/campaigns', {
      name: 'NPS',
      templateId: t.id,
      audience: { groupIds: [], userIds: ['alice', 'bob'] },
    });
    await call(admin, 'POST', `/email/campaigns/${campaign.id}/schedule`, {
      at: null,
      reason: 'Quarterly survey',
      expectedUpdatedAt: campaign.updatedAt,
    });
    const sent = await runJobs();
    const linkFor = (to: string) => {
      const email = sent.find((e) => e.to === to) as Extract<Email, { template: 'CAMPAIGN' }>;
      expect(composeEmail(email, 'https://app.test').html).toContain('a=7');
      return new URL(email.survey!).searchParams.get('t')!;
    };
    const alice = linkFor('alice@example.test');
    const bob = linkFor('bob@example.test');
    const form = async (token: string) =>
      (await userApp.request(`/v1/email/survey?t=${encodeURIComponent(token)}`)).json();
    const answer = (token: string, answers: unknown) =>
      userApp.request(`/v1/email/survey?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });

    expect((await form(alice)).form).toMatchObject({
      title: 'News for',
      answers: null,
      open: true,
      survey: { questions: [{ id: 'nps' }, { id: 'use' }, { id: 'more' }] },
    });
    // Required questions, ranges, choices and unknown questions are checked.
    expect((await answer(alice, { more: 'hi' })).status).toBe(400);
    expect((await answer(alice, { nps: 11 })).status).toBe(400);
    expect((await answer(alice, { nps: 9, use: [3] })).status).toBe(400);
    expect((await answer(alice, { nps: 9, other: 1 })).status).toBe(400);
    expect((await answer(alice, { nps: 9, use: [2, 0], more: '  Love it ' })).status).toBe(200);
    // Answering again replaces the earlier answers.
    expect((await answer(bob, { nps: 3 })).status).toBe(200);
    expect((await answer(bob, { nps: 4, more: '' })).status).toBe(200);
    expect((await form(bob)).form.answers).toEqual({ nps: 4 });
    // A link only works for its own campaign and recipient.
    const forged = `${alice.split('.')[0]}.${Buffer.from('bob').toString('base64url')}.${alice.split('.')[2]}`;
    expect((await answer(forged, { nps: 0 })).status).toBe(400);
    expect((await userApp.request('/v1/email/survey?t=test')).status).toBe(400);

    const results = await ok(support, 'GET', `/email/campaigns/${campaign.id}/survey`);
    expect(results.sent).toBe(2);
    expect(results.survey.questions).toHaveLength(3);
    expect(
      results.items.map((r: { userId: string; answers: unknown }) => [r.userId, r.answers]).sort(),
    ).toEqual([
      ['alice', { nps: 9, use: [0, 2], more: 'Love it' }],
      ['bob', { nps: 4 }],
    ]);
  });

  it('point previews and test sends at a notice instead of a real survey', async () => {
    const preview = await ok(admin, 'POST', '/email/preview', {
      ...template(),
      name: undefined,
      survey,
    });
    expect(preview.problems).toEqual([]);
    expect(preview.html).toContain('https://app.test/survey?t=test&amp;a=0');
  });
});
