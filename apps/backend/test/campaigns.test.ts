import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, type Job } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { createAdminApp } from '../src/admin/api';
import { DevelopmentDirectory } from '../src/admin/directory';
import { DevelopmentStaffAuth } from '../src/admin/staff-auth';
import { contentProblems, renderCampaign, renderMarkdown, sampleVars } from '../src/campaign-content';
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
  const first = await (await post('/auth/login', { email, password: 'Development-only-123!' })).json();
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
  markdown: '# Hello {{name}}\n\nYou use **{{storageUsed}}**.\n\n[[Open harbor0]](https://app.harbor0.com)',
});

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  userAuth = new DevelopmentAuth();
  userApp = createApp(service, userAuth, [], undefined, undefined, undefined, links).app;
  adminApp = createAdminApp(service, new DevelopmentDirectory(userAuth), new DevelopmentStaffAuth(), {
    origins: [ORIGIN],
    secureCookies: false,
    webOrigin: 'https://app.test',
  }).app;
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
    const preview = await ok(support, 'POST', '/email/preview', { ...content, sampleUserId: 'alice' });
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
      identifiers: ['ALICE@example.test', 'bob', 'nobody@example.test'],
      userIds: ['alice'],
    });
    expect(added).toMatchObject({ added: 2, alreadyMembers: 0, unmatched: ['nobody@example.test'] });
    expect(added.group.memberCount).toBe(2);
    const again = await ok(admin, 'POST', `/email/groups/${group.id}/members`, { userIds: ['bob'] });
    expect(again).toMatchObject({ added: 0, alreadyMembers: 1 });
    const members = await ok(admin, 'GET', `/email/groups/${group.id}/members`);
    expect(members.items.map((m: { email: string }) => m.email).sort()).toEqual([
      'alice@example.test',
      'bob@example.test',
    ]);
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
    expect(detail.groups).toEqual([{ id: campaign.audience.groupIds[0], name: 'Everyone', memberCount: 2 }]);
    expect(detail.history[0]).toMatchObject({ action: 'CAMPAIGN_SENT_NOW', reason: 'Launch announcement' });
    const skipped = await ok(admin, 'GET', `/email/campaigns/${campaign.id}/recipients?status=SKIPPED`);
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
      await ok(admin, 'POST', '/email/audience/count', { audience: campaign.audience, category: 'SERVICE' }),
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
    expect((await schedule(cancelled, new Date(Date.now() - 3600_000).toISOString())).status).toBe(400);
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
    expect(await campaignStep(service, campaign.id, Date.now() + 10_000, { ratePerSecond: 1000 })).toBe(true);
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
      if (email.to === 'bob@example.test') throw Object.assign(new Error('bad'), { name: 'MessageRejected' });
    });
    expect(sent.map((e) => e.to)).toEqual(['alice@example.test']);
    const failed = await ok(admin, 'GET', `/email/campaigns/${campaign.id}/recipients?status=FAILED`);
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
    const stored = (await service.repo.get({ pk: CAMPAIGN_PK, sk: campaign.id }))!.data as StoredCampaign;
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
    expect(groups.map((g: { id: string }) => g.id)).toEqual(['everyone', mine.id]);
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
      await ok(admin, 'POST', '/email/audience/count', { audience: campaign.audience, category: 'SERVICE' }),
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
