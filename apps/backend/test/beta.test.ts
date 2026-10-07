import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { Beta } from '../src/beta';
import { StorageService } from '../src/domain';
import type { Email } from '../src/emails';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';

let service: StorageService;
let beta: Beta;
const sent: Email[] = [];
const deliver = async () => {
  sent.length = 0;
  await service.runJobs(async (email) => void sent.push(email));
  return sent;
};
const codeFor = async (to: string) => {
  const email = (await deliver()).find((e) => e.to === to && e.template === 'BETA_INVITE');
  return (email as Extract<Email, { template: 'BETA_INVITE' }> | undefined)?.code;
};
const setCap = (cap: number) =>
  transact(service.repo, async (tx) => {
    const seats = await tx.get<{ used: number }>('BETA', 'SEATS');
    await tx.put('BETA', 'SEATS', { used: seats?.used ?? 0, cap });
  });
const noAudit = async () => undefined;

beforeEach(() => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  beta = new Beta(service.repo, true);
});

describe('beta sign-up', () => {
  it('emails a sign-up link at once while the wave has seats', async () => {
    expect(await beta.status()).toEqual({ inviteRequired: true, open: true });
    expect(await beta.request('Ann@Example.test')).toEqual({ status: 'INVITED' });
    const code = await codeFor('ann@example.test');
    expect(code).toBeTruthy();
    expect(await beta.inviteEmail(code!)).toEqual({ email: 'ann@example.test' });
    await beta.claim('ann@example.test', code);
    expect(await beta.summary()).toMatchObject({ used: 1, cap: 50, invited: 0, waitlisted: 0 });
    // Claiming again (a retried sign-up, then Cognito's trigger) takes no second seat.
    await beta.claim('ann@example.test', code);
    expect((await beta.summary()).used).toBe(1);
  });

  it('resends the same link at most once a minute', async () => {
    await beta.request('ann@example.test');
    const code = await codeFor('ann@example.test');
    await beta.request('ann@example.test');
    expect(await deliver()).toHaveLength(0);
    await transact(service.repo, async (tx) => {
      const entry = await tx.get<{ sentAt: string }>('BETA_EMAIL', 'ann@example.test');
      await tx.put('BETA_EMAIL', 'ann@example.test', { ...entry, sentAt: '2000-01-01T00:00:00Z' });
    });
    await beta.request('ann@example.test');
    expect(await codeFor('ann@example.test')).toBe(code);
  });

  it('refuses sign-up without a link, or with someone else’s', async () => {
    await expect(beta.claim('ann@example.test', undefined)).rejects.toMatchObject({
      code: 'INVITE_REQUIRED',
    });
    await beta.request('ann@example.test');
    const code = await codeFor('ann@example.test');
    await expect(beta.claim('bob@example.test', code)).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    });
  });

  it('waitlists requests once the wave is full, then invites them in order', async () => {
    await setCap(1);
    await beta.request('ann@example.test');
    await beta.claim('ann@example.test', await codeFor('ann@example.test'));
    expect(await beta.status()).toEqual({ inviteRequired: true, open: false });
    expect(await beta.request('bob@example.test')).toEqual({ status: 'WAITLISTED' });
    expect(await beta.request('cat@example.test')).toEqual({ status: 'WAITLISTED' });
    expect((await deliver()).map((e) => e.template)).toEqual(['BETA_WAITLIST', 'BETA_WAITLIST']);

    const wave = await beta.openWave(2, noAudit);
    expect(wave).toMatchObject({ used: 1, cap: 2, invited: 1, waitlisted: 1, newlyInvited: 1 });
    expect(await codeFor('bob@example.test')).toBeTruthy();
    // Someone is still waiting, so a new request queues behind them even with a seat free.
    expect(await beta.request('dan@example.test')).toEqual({ status: 'WAITLISTED' });
  });

  it('puts a link back on the waitlist when the wave filled before it was used', async () => {
    await beta.request('ann@example.test');
    await beta.request('bob@example.test');
    const codes = (await deliver()) as Extract<Email, { template: 'BETA_INVITE' }>[];
    const [ann, bob] = codes.map((e) => e.code);
    await setCap(1);
    await beta.claim('ann@example.test', ann);
    await expect(beta.claim('bob@example.test', bob)).rejects.toMatchObject({ code: 'BETA_FULL' });
    expect(await beta.summary()).toMatchObject({ used: 1, invited: 0, waitlisted: 1 });
    await expect(beta.inviteEmail(bob!)).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    await beta.openWave(2, noAudit);
    const next = await codeFor('bob@example.test');
    expect(next).toBeTruthy();
    expect(next).not.toBe(bob);
  });

  it('signs up through the API only with a link for that email', async () => {
    const { app } = createApp(service, new DevelopmentAuth(), [], undefined, undefined, beta);
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const account = {
      email: 'ann@example.test',
      password: 'Development-only-123!',
      username: 'ann',
      displayName: 'Ann',
    };
    expect((await post('/v1/auth/signup', account)).status).toBe(403);
    const requested = await post('/v1/auth/request-access', { email: account.email });
    expect(await requested.json()).toEqual({ status: 'INVITED' });
    const code = await codeFor(account.email);
    expect(await (await app.request(`/v1/beta/invites/${code}`)).json()).toEqual({
      email: account.email,
    });
    expect((await post('/v1/auth/signup', { ...account, inviteCode: code })).status).toBe(200);
    expect((await beta.summary()).used).toBe(1);
  });

  it('lets a test link sign up any email once, without a seat', async () => {
    await setCap(0);
    const code = await beta.createTestInvite(noAudit);
    expect(await beta.inviteEmail(code)).toEqual({ email: null });
    await beta.claim('Tess@Example.test', code);
    // A retried sign-up with the same email still works; the link is now tied to it.
    await beta.claim('tess@example.test', code);
    expect(await beta.inviteEmail(code)).toEqual({ email: 'tess@example.test' });
    await expect(beta.claim('bob@example.test', code)).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    });
    expect(await beta.summary()).toMatchObject({ used: 0, cap: 0, testAccounts: 1 });
  });

  it('takes a waitlisted email off the waitlist when it joins with a test link', async () => {
    await setCap(0);
    expect(await beta.request('ann@example.test')).toEqual({ status: 'WAITLISTED' });
    await beta.claim('ann@example.test', await beta.createTestInvite(noAudit));
    expect(await beta.summary()).toMatchObject({ used: 0, waitlisted: 0, testAccounts: 1 });
  });

  it('reports an email that already has an account', async () => {
    await service.ensureUser({
      id: 'ann',
      email: 'ann@example.test',
      emailVerified: true,
      username: 'ann',
      displayName: 'Ann',
    });
    expect(await beta.request('ann@example.test')).toEqual({ status: 'REGISTERED' });
  });

  it('lets anyone sign up once the beta is over', async () => {
    const open = new Beta(service.repo, false);
    expect(await open.status()).toEqual({ inviteRequired: false, open: true });
    await open.claim('ann@example.test', undefined);
  });
});
