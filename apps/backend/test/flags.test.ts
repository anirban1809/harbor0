import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, flagged } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { createAdminApp } from '../src/admin/api';
import { DevelopmentDirectory } from '../src/admin/directory';
import { DevelopmentStaffAuth } from '../src/admin/staff-auth';
import { featureFlags, type FlagKey } from '@harbor/contracts';
import { atLeast, bucket, decide, emptyFlag, featureFlagsFor } from '../src/flags';

const ORIGIN = 'http://console.test';
// No real flags may exist yet, so the tests define their own.
const KEY = 'test-flag' as FlagKey;
(featureFlags as Record<string, { description: string }>)[KEY] = { description: 'For tests' };
let service: StorageService;
let userApp: ReturnType<typeof createApp>['app'];
let adminApp: ReturnType<typeof createAdminApp>['app'];

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  const userAuth = new DevelopmentAuth();
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
function call(cookie: string, method: string, path: string, body?: unknown) {
  return adminApp.request(`/api/v1/admin${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const flagsOf = async (user: string) =>
  (
    await (
      await userApp.request('/v1/users/me', { headers: { Authorization: `Bearer dev-${user}` } })
    ).json()
  ).flags;
const rule = (overrides: Record<string, unknown> = {}) => ({
  mode: 'TARGETED',
  userIds: ['alice'],
  percent: 0,
  minVersions: {},
  reason: 'Early access for testers',
  expectedUpdatedAt: null,
  ...overrides,
});

describe('feature flag rules', () => {
  it('places each account at a fixed point in a percentage rollout', () => {
    expect(bucket(KEY, 'alice')).toBe(bucket(KEY, 'alice'));
    const flag = { ...emptyFlag(KEY), mode: 'TARGETED' as const, percent: 0 };
    const ids = Array.from({ length: 400 }, (_, i) => `user-${i}`);
    const at = (percent: number) =>
      ids.filter((id) => decide({ ...flag, percent }, id) === 'PERCENT');
    // Raising the share only ever adds accounts.
    expect(at(10).every((id) => at(25).includes(id))).toBe(true);
    expect(at(25).length).toBeGreaterThan(60);
    expect(at(25).length).toBeLessThan(140);
    expect(at(100)).toHaveLength(400);
  });

  it('keeps flags off on app builds older than the minimum', () => {
    expect(atLeast('1.4.0', '1.4.0')).toBe(true);
    expect(atLeast('1.10.0', '1.9.2')).toBe(true);
    expect(atLeast('1.3.9', '1.4')).toBe(false);
    expect(atLeast(null, '1.0.0')).toBe(false);
    const flag = { ...emptyFlag(KEY), mode: 'ON' as const, minVersions: { DESKTOP: '0.9.0' } };
    expect(decide(flag, 'alice', { platform: 'MACOS', appVersion: '0.8.5' })).toBe('APP_TOO_OLD');
    expect(decide(flag, 'alice', { platform: 'WINDOWS', appVersion: '0.9.1' })).toBe('EVERYONE');
    expect(decide(flag, 'alice', { platform: 'WEB', appVersion: null })).toBe('EVERYONE');
    // Without an app, as on the console's account page, versions are not considered.
    expect(decide(flag, 'alice')).toBe('EVERYONE');
  });
});

describe('feature flags in the console', () => {
  it('turns a flag on for chosen accounts only, and audits the change', async () => {
    expect(await flagsOf('alice')).toEqual({ [KEY]: false });
    const cookie = await signIn('admin@example.test');
    const saved = await call(cookie, 'PUT', `/flags/${KEY}`, rule());
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      mode: 'TARGETED',
      users: [{ id: 'alice', email: 'alice@example.test' }],
      updatedBy: 'admin@example.test',
    });
    expect((await flagsOf('alice'))[KEY]).toBe(true);
    expect((await flagsOf('bob'))[KEY]).toBe(false);

    const detail = await (await call(cookie, 'GET', `/flags/${KEY}`)).json();
    expect(detail.history[0]).toMatchObject({
      action: 'FLAG_CHANGED',
      reason: 'Early access for testers',
      details: { key: KEY, added: ['alice@example.test'], removed: [] },
    });
    const list = await (await call(cookie, 'GET', '/flags')).json();
    expect(list.items.map((f: { key: string }) => f.key)).toEqual([KEY]);
    expect(list.accounts).toBe(2);
  });

  it('refuses a save over someone else’s newer change', async () => {
    const cookie = await signIn('admin@example.test');
    const first = await (await call(cookie, 'PUT', `/flags/${KEY}`, rule())).json();
    const stale = await call(cookie, 'PUT', `/flags/${KEY}`, rule({ mode: 'ON' }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('FLAG_CHANGED');
    const fresh = await call(
      cookie,
      'PUT',
      `/flags/${KEY}`,
      rule({ mode: 'ON', expectedUpdatedAt: first.updatedAt }),
    );
    expect(fresh.status).toBe(200);
    expect((await flagsOf('bob'))[KEY]).toBe(true);
  });

  it('rejects unknown flags and accounts, and lets support only look', async () => {
    const cookie = await signIn('admin@example.test');
    expect((await call(cookie, 'PUT', '/flags/nope', rule())).status).toBe(404);
    const unknown = await call(cookie, 'PUT', `/flags/${KEY}`, rule({ userIds: ['ghost'] }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe('USER_NOT_FOUND');
    const support = await signIn('support@example.test');
    expect((await call(support, 'GET', '/flags')).status).toBe(200);
    expect((await call(support, 'PUT', `/flags/${KEY}`, rule())).status).toBe(403);
  });

  it('adds and removes one account from its page', async () => {
    const cookie = await signIn('admin@example.test');
    await call(cookie, 'PUT', `/flags/${KEY}`, rule({ userIds: [] }));
    const before = await (await call(cookie, 'GET', '/users/bob')).json();
    expect(before.flags).toContainEqual({ key: KEY, enabled: false, reason: 'NOT_SELECTED' });

    const added = await call(cookie, 'POST', `/flags/${KEY}/users`, {
      userId: 'bob',
      reason: 'Asked to try it',
    });
    expect(added.status).toBe(200);
    expect((await flagsOf('bob'))[KEY]).toBe(true);
    const after = await (await call(cookie, 'GET', '/users/bob')).json();
    expect(after.flags).toContainEqual({ key: KEY, enabled: true, reason: 'ALLOWLIST' });
    expect(after.activity[0]).toMatchObject({
      action: 'FLAG_USER_ADDED',
      details: { key: KEY },
    });

    expect(
      (await call(cookie, 'POST', `/flags/${KEY}/users`, { userId: 'bob', reason: 'Twice' }))
        .status,
    ).toBe(409);
    await call(cookie, 'POST', `/flags/${KEY}/users/bob/remove`, { reason: 'Done testing' });
    expect((await flagsOf('bob'))[KEY]).toBe(false);
  });
});

describe('flagged routes', () => {
  it('refuses accounts without the flag', async () => {
    const guarded = flagged(featureFlagsFor(service.repo), KEY, async () => ({ ok: true }));
    const ctx = (id: string) =>
      ({ get: (k: string) => (k === 'identity' ? { id } : undefined) }) as never;
    await expect(guarded(ctx('alice'), {})).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
    const cookie = await signIn('admin@example.test');
    await call(cookie, 'PUT', `/flags/${KEY}`, rule());
    await expect(guarded(ctx('alice'), {})).resolves.toEqual({ ok: true });
    await expect(guarded(ctx('bob'), {})).rejects.toMatchObject({ status: 403 });
  });
});
