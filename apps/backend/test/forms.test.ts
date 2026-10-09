import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { createAdminApp } from '../src/admin/api';
import { DevelopmentDirectory } from '../src/admin/directory';
import { DevelopmentStaffAuth } from '../src/admin/staff-auth';
import { composeEmail, type Email } from '../src/emails';
import { EmailLinks } from '../src/email-preferences';

const ORIGIN = 'http://console.test';
const links = new EmailLinks('form-test-secret-long-enough-for-signing-links', 'https://app.test');
let service: StorageService;
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
/** The public form API, as the web app's form page calls it. */
const view = async (id: string, query: Record<string, string> = {}, token?: string) => {
  const response = await userApp.request(`/v1/forms/${id}?${new URLSearchParams(query)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, data: await response.json() };
};
const answer = async (id: string, body: Record<string, unknown>, token?: string) => {
  const response = await userApp.request(`/v1/forms/${id}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
};
const BROWSER_A = 'browser-aaaaaaaaaaaaaaaa';
const BROWSER_B = 'browser-bbbbbbbbbbbbbbbb';
const questions = [
  { id: 'nps', kind: 'RATING', prompt: 'How likely are you to recommend harbor0?', scale: 10, required: true },
  { id: 'apps', kind: 'MULTI', prompt: 'Which apps do you use?', options: ['Web', 'Mac', 'Android'] },
  { id: 'next', kind: 'TEXT', prompt: 'What should we build next?' },
];
async function openForm(settings: Record<string, unknown> = {}) {
  const form = await ok(admin, 'POST', '/forms', { title: 'Feedback', questions, ...settings });
  await ok(admin, 'POST', `/forms/${form.id}/accepting`, { accepting: true });
  return form as { id: string };
}

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  const userAuth = new DevelopmentAuth();
  userApp = createApp(service, userAuth, [], undefined, undefined, undefined, links).app;
  adminApp = createAdminApp(service, new DevelopmentDirectory(userAuth), new DevelopmentStaffAuth(), {
    origins: [ORIGIN],
    secureCookies: false,
    webOrigin: 'https://app.test',
  }).app;
  for (const identity of userAuth.users.values()) await service.ensureUser(identity);
  admin = await signIn('admin@example.test');
  support = await signIn('support@example.test');
  await service.runJobs(async () => {});
});

describe('forms in the console', () => {
  it('start closed, check their questions, and only open for admins', async () => {
    const form = await ok(admin, 'POST', '/forms', { title: 'Feedback', questions });
    expect(form).toMatchObject({ accepting: false, audience: 'ANYONE', limit: 'ONE_PER_PERSON', responseCount: 0 });
    expect(form.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const bad = await call(admin, 'POST', '/forms', {
      title: 'Bad',
      questions: [{ id: 'q', kind: 'CHOICE', prompt: 'Pick', options: ['Only'] }],
    });
    expect(bad).toMatchObject({ status: 400, data: { error: { code: 'INVALID_FORM' } } });
    expect((await call(support, 'POST', `/forms/${form.id}/accepting`, { accepting: true })).status).toBe(403);
    expect((await ok(support, 'GET', '/forms')).items).toHaveLength(1);

    const opened = await ok(admin, 'POST', `/forms/${form.id}/accepting`, { accepting: true });
    expect(opened.accepting).toBe(true);
    const detail = await ok(support, 'GET', `/forms/${form.id}`);
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(['FORM_OPENED', 'FORM_CREATED']);
    // An editor working from an old copy is refused.
    const stale = await call(admin, 'PUT', `/forms/${form.id}`, {
      title: 'Renamed',
      questions,
      expectedUpdatedAt: form.updatedAt,
    });
    expect(stale.status).toBe(409);
  });

  it('delete a form with its responses', async () => {
    const form = await openForm();
    await answer(form.id, { answers: { nps: 9 }, browser: BROWSER_A });
    await ok(admin, 'DELETE', `/forms/${form.id}`);
    expect((await call(support, 'GET', `/forms/${form.id}/responses`)).status).toBe(404);
    expect((await view(form.id)).status).toBe(404);
  });
});

describe('answering a form', () => {
  it('take answers only while open', async () => {
    const form = await ok(admin, 'POST', '/forms', { title: 'Feedback', questions });
    expect((await view(form.id, { b: BROWSER_A })).data.view).toMatchObject({
      blocked: 'CLOSED',
      form: { title: 'Feedback', questions: [{ id: 'nps' }, { id: 'apps' }, { id: 'next' }] },
    });
    expect((await answer(form.id, { answers: { nps: 9 }, browser: BROWSER_A })).status).toBe(409);
    await ok(admin, 'POST', `/forms/${form.id}/accepting`, { accepting: true });
    expect((await answer(form.id, { answers: { nps: 9 }, browser: BROWSER_A })).status).toBe(200);
    await ok(admin, 'POST', `/forms/${form.id}/accepting`, { accepting: false });
    expect((await answer(form.id, { answers: { nps: 3 }, browser: BROWSER_A })).status).toBe(409);
  });

  it('keep one response per browser, replaced when answered again', async () => {
    const form = await openForm();
    expect((await answer(form.id, { answers: { apps: [0] }, browser: BROWSER_A })).status).toBe(400);
    expect((await answer(form.id, { answers: { nps: 11 }, browser: BROWSER_A })).status).toBe(400);
    expect((await answer(form.id, { answers: { nps: 9, other: 1 }, browser: BROWSER_A })).status).toBe(400);
    // Without any ID there is no way to keep it to one each.
    expect((await answer(form.id, { answers: { nps: 9 } })).status).toBe(400);

    const first = await answer(form.id, { answers: { nps: 9, apps: [2, 0], next: ' Linux ' }, browser: BROWSER_A });
    expect(first.data.replaced).toBe(false);
    const again = await answer(form.id, { answers: { nps: 7 }, browser: BROWSER_A });
    expect(again.data.replaced).toBe(true);
    await answer(form.id, { answers: { nps: 10 }, browser: BROWSER_B });
    expect((await view(form.id, { b: BROWSER_A })).data.view).toMatchObject({
      respondent: { via: 'BROWSER', label: null },
      response: { answers: { nps: 7 } },
      blocked: null,
    });
    const responses = await ok(support, 'GET', `/forms/${form.id}/responses`);
    expect(responses.items.map((r: { answers: { nps: number } }) => r.answers.nps).sort((a: number, b: number) => a - b)).toEqual([7, 10]);
    expect((await ok(support, 'GET', `/forms/${form.id}`)).form.responseCount).toBe(2);
  });

  it('take a new response every time when unlimited', async () => {
    const form = await openForm({ limit: 'UNLIMITED' });
    await answer(form.id, { answers: { nps: 1 }, browser: BROWSER_A });
    await answer(form.id, { answers: { nps: 2 }, browser: BROWSER_A });
    await answer(form.id, { answers: { nps: 3 } });
    const responses = await ok(support, 'GET', `/forms/${form.id}/responses`);
    expect(responses.items.map((r: { via: string }) => r.via).sort()).toEqual(['ANONYMOUS', 'BROWSER', 'BROWSER']);
  });

  it('know signed-in accounts and email recipients, and require them when asked to', async () => {
    const form = await openForm({ audience: 'IDENTIFIED' });
    expect((await view(form.id, { b: BROWSER_A })).data.view.blocked).toBe('SIGN_IN');
    expect((await answer(form.id, { answers: { nps: 9 }, browser: BROWSER_A })).status).toBe(403);

    // A campaign email's link names the account; signed in, the same account answers again.
    const r = links.respondentToken({ userId: 'alice' });
    expect((await view(form.id, { r })).data.view.respondent).toEqual({ via: 'EMAIL', label: 'a•••@example.test' });
    expect((await answer(form.id, { answers: { nps: 6 }, r })).status).toBe(200);
    const signedIn = await answer(form.id, { answers: { nps: 8 }, browser: BROWSER_A }, 'dev-alice');
    expect(signedIn.data.replaced).toBe(true);
    // An address without an account answers as itself.
    const guest = links.respondentToken({ email: 'Guest@Example.test' });
    expect((await answer(form.id, { answers: { nps: 4 }, r: guest })).status).toBe(200);
    // A link that wasn't signed by us, or reworked, is refused.
    expect((await answer(form.id, { answers: { nps: 4 }, r: `bob.${r.split('.')[1]}` })).status).toBe(400);

    const responses = await ok(support, 'GET', `/forms/${form.id}/responses`);
    expect(
      responses.items.map((x: { via: string; userId: string; email: string; answers: { nps: number } }) => [
        x.via,
        x.userId,
        x.email,
        x.answers.nps,
      ]),
    ).toEqual([
      ['EMAIL', null, 'guest@example.test', 4],
      ['ACCOUNT', 'alice', 'alice@example.test', 8],
    ]);
  });
});

describe('forms in campaign emails', () => {
  const template = (markdown: string) => ({
    name: 'Feedback request',
    category: 'PRODUCT',
    subject: 'A quick question',
    preheader: '',
    markdown,
  });

  it('refuse links to forms that do not exist', async () => {
    const r = await call(admin, 'POST', '/email/templates', template('[[Answer]]({{form:nope}})'));
    expect(r.status).toBe(400);
    expect(r.data.error.message).toContain("{{form:nope}} links to a form that doesn't exist.");
  });

  it('give each recipient their own link, and test sends a link that saves nothing', async () => {
    const form = await openForm();
    const t = await ok(admin, 'POST', '/email/templates', template(`Hi\n\n[[Answer]]({{form:${form.id}}})`));
    const preview = await ok(admin, 'POST', '/email/preview', {
      subject: t.subject,
      preheader: '',
      markdown: t.markdown,
      category: t.category,
    });
    expect(preview.problems).toEqual([]);
    expect(preview.html).toContain(`https://app.test/form?id=${form.id}&amp;r=test`);
    expect((await view(form.id, { r: 'test' })).data.view.blocked).toBe('TEST');
    expect((await answer(form.id, { answers: { nps: 1 }, r: 'test' })).status).toBe(409);

    const campaign = await ok(admin, 'POST', '/email/campaigns', {
      name: 'Feedback',
      templateId: t.id,
      audience: { groupIds: [], userIds: ['alice'] },
    });
    await ok(admin, 'POST', `/email/campaigns/${campaign.id}/schedule`, {
      at: null,
      reason: 'Ask for feedback',
      expectedUpdatedAt: campaign.updatedAt,
    });
    const sent: Email[] = [];
    await service.runJobs(async (e) => void sent.push(e), { emailLinks: links, ratePerSecond: 1000 });
    const email = sent.find((e) => e.template === 'CAMPAIGN')!;
    const html = composeEmail(email, 'https://app.test').html;
    const link = html.match(/href="(https:\/\/app\.test\/form\?[^"]+)"/)![1]!.replace(/&amp;/g, '&');
    const r = new URL(link).searchParams.get('r')!;
    expect(r).toBe(links.respondentToken({ userId: 'alice' }));
    expect((await answer(form.id, { answers: { nps: 10 }, r })).data.replaced).toBe(false);
  });
});
