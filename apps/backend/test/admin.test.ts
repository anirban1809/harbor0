import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService, type Job } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { createAdminApp } from '../src/admin/api';
import { DevelopmentDirectory } from '../src/admin/directory';
import { DevelopmentStaffAuth } from '../src/admin/staff-auth';

const ORIGIN = 'http://console.test';
let userAuth: DevelopmentAuth;
let service: StorageService;
let userApp: ReturnType<typeof createApp>['app'];
let adminApp: ReturnType<typeof createAdminApp>['app'];

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  userAuth = new DevelopmentAuth();
  userApp = createApp(service, userAuth).app;
  adminApp = createAdminApp(
    service,
    new DevelopmentDirectory(userAuth),
    new DevelopmentStaffAuth(),
    {
      origins: [ORIGIN],
      secureCookies: false,
    },
  ).app;
  for (const identity of userAuth.users.values()) {
    await service.ensureUser(identity);
    await service.registerDevice(
      identity.id,
      { name: 'Browser', platform: 'WEB' },
      identity.deviceId,
    );
  }
});

/** Signs a staff member in through both steps and returns their session cookie header. */
async function signIn(email: string) {
  const post = (path: string, body: unknown) =>
    adminApp.request(`/api/v1/admin${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    });
  const first = await post('/auth/login', { email, password: 'Development-only-123!' });
  const challenge = await first.json();
  expect(challenge).toMatchObject({ status: 'CHALLENGE', challenge: 'MFA' });
  const second = await post('/auth/challenge', {
    email,
    session: challenge.session,
    challenge: 'MFA',
    code: '123456',
  });
  expect(await second.json()).toMatchObject({ status: 'SIGNED_IN', staff: { email } });
  const cookies = second.headers.getSetCookie().map((c) => c.split(';')[0]);
  expect(cookies.join(' ')).toContain('harbor_staff_access=');
  expect(second.headers.getSetCookie().join(' ')).toContain('HttpOnly');
  return cookies.join('; ');
}
function call(cookie: string, method: string, path: string, body?: unknown) {
  return adminApp.request(`/api/v1/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const asUser = (path: string) =>
  userApp.request(path, { headers: { Authorization: 'Bearer dev-alice' } });

describe('management console API', () => {
  it('requires staff sign-in with a second factor, and refuses customer tokens', async () => {
    expect((await adminApp.request('/api/v1/admin/users')).status).toBe(401);
    const customer = await adminApp.request('/api/v1/admin/users', {
      headers: { Cookie: 'harbor_staff_access=dev-alice' },
    });
    expect(customer.status).toBe(401);
    const wrongCode = await adminApp.request('/api/v1/admin/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({
        email: 'admin@example.test',
        session: 'dev-mfa:admin@example.test',
        challenge: 'MFA',
        code: '000000',
      }),
    });
    expect(wrongCode.status).toBe(400);
    const cookie = await signIn('admin@example.test');
    expect(await (await call(cookie, 'GET', '/me')).json()).toMatchObject({
      staff: { role: 'ADMIN' },
    });
  });

  it('refuses state changes from another origin', async () => {
    const cookie = await signIn('admin@example.test');
    const response = await adminApp.request('/api/v1/admin/users/alice/notes', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(response.status).toBe(403);
  });

  it('searches accounts with their storage', async () => {
    const cookie = await signIn('support@example.test');
    const page = await (await call(cookie, 'GET', '/users?q=ali')).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: 'alice',
      email: 'alice@example.test',
      status: 'CONFIRMED',
      quotaBytes: 50_000_000_000,
      usedBytes: 0,
      suspended: false,
    });
    const detail = await (await call(cookie, 'GET', '/users/alice')).json();
    expect(detail.profile.storage.quotaBytes).toBe(50_000_000_000);
    expect(detail.devices).toHaveLength(1);
  });

  it('sorts accounts by storage used and by creation time', async () => {
    const cookie = await signIn('support@example.test');
    const repo = service.repo as MemoryRepository;
    (repo.rows.get('USER#bob|PROFILE')!.data as Record<string, number>).storageUsedBytes = 5;
    const ids = async (query: string) =>
      ((await (await call(cookie, 'GET', `/users?${query}`)).json()).items as { id: string }[]).map(
        (u) => u.id,
      );
    expect(await ids('sort=storage&order=desc')).toEqual(['bob', 'alice']);
    expect(await ids('sort=storage&order=asc')).toEqual(['alice', 'bob']);
    expect(await ids('sort=storage')).toEqual(['bob', 'alice']);
    expect((await ids('sort=created&order=asc')).sort()).toEqual(['alice', 'bob']);
    expect(await ids('q=b&sort=storage')).toEqual(['bob']);
    expect((await call(cookie, 'GET', '/users?sort=size')).status).toBe(400);
  });

  it('lets admins change the storage limit, audited, and the user sees it', async () => {
    const support = await signIn('support@example.test');
    expect(
      (await call(support, 'PUT', '/users/alice/quota', { quotaBytes: 1, reason: 'Testing' }))
        .status,
    ).toBe(403);
    const admin = await signIn('admin@example.test');
    const response = await call(admin, 'PUT', '/users/alice/quota', {
      quotaBytes: 500_000_000_000,
      reason: 'Beta tester upgrade',
    });
    expect(response.status).toBe(200);
    const me = await (await asUser('/v1/users/me')).json();
    expect(me.storage.quotaBytes).toBe(500_000_000_000);
    const changes = await (await asUser('/v1/sync/changes?cursor=0')).json();
    expect(JSON.stringify(changes)).toContain('PROFILE_UPDATED');
    const detail = await (await call(admin, 'GET', '/users/alice')).json();
    expect(detail.activity[0]).toMatchObject({
      action: 'QUOTA_CHANGED',
      actor: { email: 'admin@example.test' },
      reason: 'Beta tester upgrade',
      details: { previousBytes: 50_000_000_000, quotaBytes: 500_000_000_000 },
    });
    const audit = await (await call(admin, 'GET', '/audit')).json();
    expect(audit.items[0].action).toBe('QUOTA_CHANGED');
    expect(
      (await call(admin, 'PUT', '/users/alice/quota', { quotaBytes: -1, reason: 'Oops' })).status,
    ).toBe(400);
    expect((await call(admin, 'PUT', '/users/alice/quota', { quotaBytes: 1 })).status).toBe(400);
  });

  it('suspends an account at once and restores it', async () => {
    const admin = await signIn('admin@example.test');
    expect((await asUser('/v1/users/me')).status).toBe(200);
    await call(admin, 'POST', '/users/alice/suspend', { reason: 'Abuse report #12' });
    // The sign-in is disabled, and the profile blocks any token still cached by a warm Lambda.
    expect((await asUser('/v1/users/me')).status).toBe(401);
    await expect(
      service.ensureUser(userAuth.users.get('alice@example.test')!),
    ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
    const detail = await (await call(admin, 'GET', '/users/alice')).json();
    expect(detail.account.enabled).toBe(false);
    expect(detail.profile.suspendedReason).toBe('Abuse report #12');
    await call(admin, 'POST', '/users/alice/unsuspend', { reason: 'Resolved' });
    const login = await userApp.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password: 'Development-only-123!' }),
    });
    expect(login.status).toBe(200);
  });

  it('signs a user out everywhere', async () => {
    const support = await signIn('support@example.test');
    const result = await (
      await call(support, 'POST', '/users/alice/sign-out', { reason: 'Lost laptop' })
    ).json();
    expect(result.sessions).toBe(1);
    expect((await asUser('/v1/users/me')).status).toBe(401);
    const emails = [...(service.repo as MemoryRepository).rows.values()]
      .map((row) => (row.data as Job).email)
      .filter((email) => email?.template === 'SIGNED_OUT');
    expect(emails).toEqual([
      { template: 'SIGNED_OUT', to: 'alice@example.test', name: 'Alice Morgan' },
    ]);
  });

  it('only resets passwords for verified accounts, and confirms unverified ones', async () => {
    const admin = await signIn('admin@example.test');
    expect(
      (await call(admin, 'POST', '/users/alice/password-reset', { reason: 'Locked out' })).status,
    ).toBe(200);
    expect((await (await call(admin, 'GET', '/users/alice')).json()).account.status).toBe(
      'RESET_REQUIRED',
    );
    await userAuth.signup({ email: 'carol@example.test', username: 'carol', displayName: 'Carol' });
    const carol = [...userAuth.users.values()].find((u) => u.username === 'carol')!;
    expect(
      (await call(admin, 'POST', `/users/${carol.id}/password-reset`, { reason: 'Help' })).status,
    ).toBe(409);
    const detail = await (await call(admin, 'GET', `/users/${carol.id}`)).json();
    expect(detail).toMatchObject({ account: { status: 'UNCONFIRMED' }, profile: null });
    await call(admin, 'POST', `/users/${carol.id}/verification/confirm`, { reason: 'No email' });
    expect(carol.emailVerified).toBe(true);
  });

  it('deletes an account only with the email typed back', async () => {
    const admin = await signIn('admin@example.test');
    const support = await signIn('support@example.test');
    expect(
      (
        await call(support, 'POST', '/users/bob/delete', {
          confirmEmail: 'bob@example.test',
          reason: 'Requested',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(admin, 'POST', '/users/bob/delete', {
          confirmEmail: 'alice@example.test',
          reason: 'Requested',
          category: 'USER_REQUEST',
        })
      ).status,
    ).toBe(400);
    const deleted = await call(admin, 'POST', '/users/bob/delete', {
      confirmEmail: 'BOB@example.test',
      reason: 'GDPR erasure request',
      category: 'USER_REQUEST',
    });
    expect(await deleted.json()).toMatchObject({ deleted: true });
    const job = await service.repo.get({ pk: 'JOB', sk: 'account-deleted-bob' });
    expect((job?.data as Job).email).toMatchObject({
      template: 'ACCOUNT_CLOSED',
      reason: 'USER_REQUEST',
      to: 'bob@example.test',
    });
    const detail = await (await call(admin, 'GET', '/users/bob')).json();
    expect(detail.profile.deletedAt).toBeTruthy();
    expect(detail.activity[0].action).toBe('ACCOUNT_DELETED');
  });

  it('purges every deleted account now, admins only', async () => {
    const admin = await signIn('admin@example.test');
    const support = await signIn('support@example.test');
    await call(admin, 'POST', '/users/bob/delete', {
      confirmEmail: 'bob@example.test',
      reason: 'Requested',
      category: 'USER_REQUEST',
    });
    const before = await (await call(admin, 'GET', '/overview')).json();
    expect(before.storage.awaitingPurge).toEqual({ accounts: 1, usedBytes: 0 });
    expect(
      (await call(support, 'POST', '/deleted-accounts/purge', { reason: 'Free space' })).status,
    ).toBe(403);
    const purged = await call(admin, 'POST', '/deleted-accounts/purge', { reason: 'Free space' });
    expect(await purged.json()).toEqual({ accounts: 1, usedBytes: 0 });
    const job = (await service.repo.get({ pk: 'JOB', sk: 'account-bob' }))!;
    expect(Date.parse(job.gsk!)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse((job.data as Job).dueAt)).toBeLessThanOrEqual(Date.now());
    const detail = await (await call(admin, 'GET', '/users/bob')).json();
    expect(Date.parse(detail.profile.purgeAt)).toBeLessThanOrEqual(Date.now());
    expect(detail.activity[0]).toMatchObject({ action: 'ACCOUNT_PURGED', reason: 'Free space' });
    const after = await (await call(admin, 'GET', '/overview')).json();
    expect(after.storage.awaitingPurge.accounts).toBe(0);
    // Already due, so a second run has nothing to do.
    const again = await call(admin, 'POST', '/deleted-accounts/purge', { reason: 'Again' });
    expect(await again.json()).toEqual({ accounts: 0, usedBytes: 0 });
    await service.runJobs();
    expect(await service.repo.get({ pk: 'JOB', sk: 'account-bob' })).toBeUndefined();
  });

  it('records support notes', async () => {
    const support = await signIn('support@example.test');
    await call(support, 'POST', '/users/alice/notes', { text: 'Called about sync on Windows.' });
    const detail = await (await call(support, 'GET', '/users/alice')).json();
    expect(detail.activity[0]).toMatchObject({
      action: 'NOTE',
      details: { text: 'Called about sync on Windows.' },
    });
  });

  it('totals storage used and allocated across accounts, excluding deleted ones', async () => {
    const admin = await signIn('admin@example.test');
    const repo = service.repo as MemoryRepository;
    const profile = repo.rows.get('USER#alice|PROFILE')!;
    (profile.data as Record<string, number>).storageUsedBytes = 3_000_000_000;
    (profile.data as Record<string, number>).trashBytes = 1_000_000_000;
    const first = await (await call(admin, 'GET', '/overview')).json();
    expect(first.storage).toMatchObject({
      accounts: 2,
      usedBytes: 3_000_000_000,
      allocatedBytes: 100_000_000_000,
      trashBytes: 1_000_000_000,
      deletedAccounts: 0,
    });
    // A quota change clears the cached totals so allocation is current at once.
    await call(admin, 'PUT', '/users/bob/quota', { quotaBytes: 1_000_000_000_000, reason: 'Pro' });
    const afterQuota = await (await call(admin, 'GET', '/overview')).json();
    expect(afterQuota.storage.allocatedBytes).toBe(1_050_000_000_000);
    await call(admin, 'POST', '/users/alice/delete', {
      confirmEmail: 'alice@example.test',
      reason: 'Requested',
      category: 'DUPLICATE',
      notify: false,
    });
    expect(await repo.get({ pk: 'JOB', sk: 'account-deleted-alice' })).toBeUndefined();
    const afterDelete = await (await call(admin, 'GET', '/overview')).json();
    expect(afterDelete.storage).toMatchObject({
      accounts: 1,
      usedBytes: 0,
      allocatedBytes: 1_000_000_000_000,
      pendingDeletionBytes: 3_000_000_000,
      deletedAccounts: 1,
      orphans: { accounts: 0 },
    });
    // Removing only the sign-in (as old validation scripts did) leaves an orphaned profile.
    userAuth.users.delete('bob@example.test');
    repo.rows.delete('ADMIN_STATS|STORAGE');
    const orphaned = await (await call(admin, 'GET', '/overview')).json();
    expect(orphaned.storage).toMatchObject({
      accounts: 0,
      allocatedBytes: 0,
      orphans: { accounts: 1, usedBytes: 0, allocatedBytes: 1_000_000_000_000 },
    });
  });
});
