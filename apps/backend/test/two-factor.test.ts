import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { FLAG_PK, emptyFlag } from '../src/flags';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

const PASSWORD = 'Development-only-123!';
let service: StorageService;
let auth: DevelopmentAuth;
let app: ReturnType<typeof createApp>['app'];

const post = (path: string, body?: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const login = async (email = 'alice@example.test', twoFactor = true) =>
  post('/v1/auth/login', { email, password: PASSWORD, twoFactor });
const tokenFor = async (email = 'alice@example.test') =>
  (await (await login(email)).json()).accessToken as string;
const flagOn = (userIds: string[]) =>
  transact(service.repo, (tx) =>
    tx.put(FLAG_PK, 'two-factor', { ...emptyFlag('two-factor'), mode: 'TARGETED', userIds }),
  );
const queuedEmails = async () =>
  (await service.repo.query('JOB', '', 100)).rows
    .map((row) => (row.data as { email?: { template: string } }).email?.template)
    .filter(Boolean);

beforeEach(async () => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  auth = new DevelopmentAuth();
  app = createApp(service, auth).app;
});

describe('two-step verification', () => {
  it('turns on only for accounts with the flag', async () => {
    await flagOn(['alice']);
    const bob = await tokenFor('bob@example.test');
    expect((await post('/v1/users/me/two-factor/email', undefined, bob)).status).toBe(403);
    const on = await post('/v1/users/me/two-factor/email', undefined, await tokenFor());
    expect(await on.json()).toEqual({ twoFactor: { totp: false, email: true } });
    expect(await queuedEmails()).toContain('TWO_FACTOR_CHANGED');
  });

  it('sets up an authenticator app with its first code', async () => {
    await flagOn(['alice']);
    const token = await tokenFor();
    const setup = await (await post('/v1/users/me/two-factor/totp/setup', undefined, token)).json();
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/harbor0%3Aalice%40example.test\?secret=/);
    const wrong = await post('/v1/users/me/two-factor/totp/verify', { code: '000000' }, token);
    expect(wrong.status).toBe(400);
    const right = await post('/v1/users/me/two-factor/totp/verify', { code: '123456' }, token);
    expect(await right.json()).toEqual({ twoFactor: { totp: true, email: false } });
  });

  it('asks for the code at sign-in and issues tokens only after it', async () => {
    auth.twoFactor.set('alice', { totp: true, email: false });
    const first = await (await login()).json();
    expect(first.accessToken).toBeUndefined();
    expect(first.twoFactor).toMatchObject({ methods: ['TOTP'], method: 'TOTP' });
    const verify = (code: string, session = first.twoFactor.session) =>
      post('/v1/auth/login/verify', {
        email: 'alice@example.test',
        session,
        method: 'TOTP',
        code,
      });
    const wrong = await verify('000000');
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.details.session).toBe(first.twoFactor.session);
    const done = await (await verify('123456')).json();
    expect(done.accessToken).toBeTruthy();
    expect(done.device.platform).toBe('WEB');
    // The session cannot be spent twice.
    expect((await (await verify('123456')).json()).error.code).toBe('AUTH_EXPIRED');
  });

  // Accounts that turned both on before one method became the limit still sign in.
  it('lets an older account with both methods choose email', async () => {
    auth.twoFactor.set('alice', { totp: true, email: true });
    const first = await (await login()).json();
    expect(first.twoFactor).toMatchObject({ methods: ['TOTP', 'EMAIL'], method: null });
    const chosen = await (
      await post('/v1/auth/login/method', {
        email: 'alice@example.test',
        session: first.twoFactor.session,
        method: 'EMAIL',
      })
    ).json();
    expect(chosen.twoFactor).toMatchObject({ method: 'EMAIL', destination: 'a***@e***' });
    const done = await post('/v1/auth/login/verify', {
      email: 'alice@example.test',
      session: chosen.twoFactor.session,
      method: 'EMAIL',
      code: '123456',
    });
    expect(done.status).toBe(200);
  });

  it('tells apps without two-step support to update', async () => {
    auth.twoFactor.set('alice', { totp: true, email: false });
    const r = await login('alice@example.test', false);
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('TWO_FACTOR_UNSUPPORTED');
  });

  it('can be turned off after the flag is taken away', async () => {
    const token = await tokenFor();
    auth.twoFactor.set('alice', { totp: true, email: false });
    const off = await post('/v1/users/me/two-factor/disable', { method: 'TOTP' }, token);
    expect(await off.json()).toEqual({ twoFactor: { totp: false, email: false } });
  });

  it('keeps one method at a time: turning one on replaces the other', async () => {
    await flagOn(['alice']);
    const token = await tokenFor();
    await post('/v1/users/me/two-factor/email', undefined, token);
    await post('/v1/users/me/two-factor/totp/setup', undefined, token);
    const app = await post('/v1/users/me/two-factor/totp/verify', { code: '123456' }, token);
    expect(await app.json()).toEqual({ twoFactor: { totp: true, email: false } });
    const back = await post('/v1/users/me/two-factor/email', undefined, token);
    expect(await back.json()).toEqual({ twoFactor: { totp: false, email: true } });
    const jobs = (await service.repo.query('JOB', '', 100)).rows.map(
      (row) => (row.data as { email?: { replaced?: string } }).email?.replaced,
    );
    expect(jobs).toEqual(expect.arrayContaining(['EMAIL', 'TOTP']));
  });
});
