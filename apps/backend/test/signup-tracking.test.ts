import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, type Account } from '../src/domain';
import { MemoryRepository, Transaction } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { userPK } from '../src/domain';
import { createAdminApp } from '../src/admin/api';
import { DevelopmentDirectory } from '../src/admin/directory';
import { DevelopmentStaffAuth } from '../src/admin/staff-auth';

const ORIGIN = 'http://console.test';
let auth: DevelopmentAuth;
let service: StorageService;
let userApp: ReturnType<typeof createApp>['app'];
let adminApp: ReturnType<typeof createAdminApp>['app'];

beforeEach(() => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  auth = new DevelopmentAuth();
  userApp = createApp(service, auth).app;
  adminApp = createAdminApp(service, new DevelopmentDirectory(auth), new DevelopmentStaffAuth(), {
    origins: [ORIGIN],
    secureCookies: false,
    webOrigin: 'https://app.example.test',
  }).app;
});

const post = (path: string, body: unknown) =>
  userApp.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const account = (email: string) => ({
  email,
  password: 'Development-only-123!',
  username: email.split('@')[0],
  displayName: 'Ann',
});
/** Verifies the email and signs in once, which creates the profile. */
async function join(email: string) {
  await auth.confirm(email, '123456');
  const identity = auth.users.get(email)!;
  await service.ensureUser(identity);
  return new Transaction(service.repo).get<Account>(userPK(identity.id), 'PROFILE');
}
async function staff(email: string) {
  const res = await adminApp.request('/api/v1/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password: 'Development-only-123!' }),
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return (method: string, path: string, body?: unknown) =>
    adminApp.request(`/api/v1/admin${path}`, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe('sign-up tracking', () => {
  it('follows a tracking id from the access request to the account', async () => {
    expect(
      (
        await post('/v1/auth/request-access', {
          email: 'ann@example.test',
          trackingId: 'Reddit-Oct',
        })
      ).status,
    ).toBe(200);
    // The emailed link has no ref; the first tracking id still counts.
    expect(
      (await post('/v1/auth/signup', { ...account('ann@example.test'), trackingId: 'other' }))
        .status,
    ).toBe(200);
    expect((await join('ann@example.test'))?.trackingId).toBe('reddit-oct');

    const admin = await staff('admin@example.test');
    const list = await (await admin('GET', '/trackers')).json();
    expect(list.signupUrl).toBe('https://app.example.test/signup');
    expect(list.items).toEqual([
      expect.objectContaining({
        id: 'reddit-oct',
        source: null,
        requests: 1,
        signups: 1,
        accounts: 1,
      }),
    ]);

    const saved = await admin('PUT', '/trackers/reddit-oct', {
      source: 'r/selfhosted post',
      expectedUpdatedAt: null,
    });
    expect(saved.status).toBe(200);
    const detail = await saved.json();
    expect(detail.tracker).toMatchObject({
      source: 'r/selfhosted post',
      updatedBy: 'admin@example.test',
    });
    expect(detail.people).toEqual([
      expect.objectContaining({ email: 'ann@example.test', userId: expect.any(String) }),
    ]);
    // A stale editor can't overwrite someone else's change.
    expect(
      (await admin('PUT', '/trackers/reddit-oct', { source: 'x', expectedUpdatedAt: null })).status,
    ).toBe(409);

    const user = await (await admin('GET', `/users/${detail.people[0].userId}`)).json();
    expect(user.signup).toMatchObject({ trackingId: 'reddit-oct', source: 'r/selfhosted post' });
  });

  it('signs up without one, or with a malformed one, and records nothing', async () => {
    expect(
      (await post('/v1/auth/signup', { ...account('cal@example.test'), trackingId: 'no spaces!' }))
        .status,
    ).toBe(200);
    expect((await join('cal@example.test'))?.trackingId).toBeUndefined();
    const admin = await staff('admin@example.test');
    expect((await (await admin('GET', '/trackers')).json()).items).toEqual([]);
    const id = auth.users.get('cal@example.test')!.id;
    expect((await (await admin('GET', `/users/${id}`)).json()).signup).toBeNull();
  });

  it('lets support look but not name tracking ids', async () => {
    const support = await staff('support@example.test');
    expect((await support('GET', '/trackers')).status).toBe(200);
    expect(
      (await support('PUT', '/trackers/ads', { source: 'Ads', expectedUpdatedAt: null })).status,
    ).toBe(403);
  });
});
