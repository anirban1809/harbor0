import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalEmail, deviceProofMessage } from '@harbor/contracts';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { Beta } from '../src/beta';
import { StorageService } from '../src/domain';
import type { Email } from '../src/emails';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { accountsOnDevice } from '../src/signup-guard';

let service: StorageService;
let beta: Beta;
const sent: Email[] = [];
const codeFor = async (to: string) => {
  sent.length = 0;
  await service.runJobs(async (email) => void sent.push(email));
  const email = sent.find((e) => e.to === to && e.template === 'BETA_INVITE');
  return (email as Extract<Email, { template: 'BETA_INVITE' }> | undefined)?.code;
};
const identity = (id: string, email: string) => ({
  id,
  email,
  emailVerified: true,
  username: id,
  displayName: id,
});
const newKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKey: spki.toString('base64url'),
    fingerprint: createHash('sha256').update(spki).digest('base64url'),
  };
};
/** Signs `user` in with `key` the way the web app does after sign-up. */
const proveKey = async (user: string, key: ReturnType<typeof newKey>) => {
  const session = `${user}-session`;
  const { challenge } = await service.deviceChallenge(user, session);
  const message = deviceProofMessage(challenge, user, key.fingerprint);
  await service.registerDevice(
    user,
    {
      name: 'Firefox on Linux',
      platform: 'WEB',
      devicePublicId: key.fingerprint,
      proof: {
        publicKey: key.publicKey,
        challenge,
        signature: sign('sha256', Buffer.from(message), key.privateKey).toString('base64url'),
      },
    },
    session,
  );
};

beforeEach(() => {
  service = new StorageService(new MemoryRepository(), new MemoryStorage());
  beta = new Beta(service.repo, true);
});

describe('canonical email', () => {
  it('drops +tags everywhere, and dots and googlemail for Gmail', () => {
    expect(canonicalEmail('W.Ekefuj+harbor0j@Gmail.com')).toBe('wekefuj@gmail.com');
    expect(canonicalEmail('w.e.kefuj@googlemail.com')).toBe('wekefuj@gmail.com');
    expect(canonicalEmail('ann+drive@example.test')).toBe('ann@example.test');
    // Other providers treat dots as part of the address.
    expect(canonicalEmail('a.nn@example.test')).toBe('a.nn@example.test');
    expect(canonicalEmail('+x@example.test')).toBe('+x@example.test');
  });
});

describe('one inbox, one beta seat and account', () => {
  it('answers another spelling of an invited inbox with the original link', async () => {
    expect(await beta.request('wekefuj+a@gmail.com')).toEqual({ status: 'INVITED' });
    const code = await codeFor('wekefuj+a@gmail.com');
    expect(await beta.request('w.ekefuj+b@gmail.com')).toEqual({ status: 'INVITED' });
    // No link for the new spelling; the original address (same inbox) holds the only one.
    expect(await codeFor('w.ekefuj+b@gmail.com')).toBeUndefined();
    await beta.claim('wekefuj+a@gmail.com', code);
    expect((await beta.summary()).used).toBe(1);
  });

  it('refuses a seat to another spelling of an inbox that has one', async () => {
    await beta.request('ann@example.test');
    await beta.claim('ann@example.test', await codeFor('ann@example.test'));
    const test = await beta.createTestInvite(async () => undefined);
    await expect(beta.claim('ann+2@example.test', test)).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
    });
  });

  it('reports another spelling of a registered inbox as registered', async () => {
    await service.ensureUser(identity('ann', 'ann@gmail.com'));
    expect(await beta.request('a.nn+x@gmail.com')).toEqual({ status: 'REGISTERED' });
  });

  it('refuses a second account for one inbox even after the beta', async () => {
    await service.ensureUser(identity('ann', 'ann@gmail.com'));
    await expect(service.ensureUser(identity('ann2', 'a.nn+2@gmail.com'))).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
    });
    const { app } = createApp(service, new DevelopmentAuth());
    const res = await app.request('/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ann+3@gmail.com',
        password: 'Development-only-123!',
        username: 'ann3',
        displayName: 'Ann',
      }),
    });
    expect(res.status).toBe(409);
  });

  it('frees the inbox when its account is deleted', async () => {
    await service.ensureUser(identity('ann', 'ann@gmail.com'));
    await service.deleteAccount('ann', { operationId: crypto.randomUUID(), email: 'ann@gmail.com' });
    await service.ensureUser(identity('ann2', 'a.nn@gmail.com'));
  });
});

describe('accounts per browser', () => {
  const signup = (app: ReturnType<typeof createApp>['app'], n: number, deviceKey?: string) =>
    app.request('/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `user${n}@example.test`,
        password: 'Development-only-123!',
        username: `user${n}`,
        displayName: `User ${n}`,
        ...(deviceKey ? { deviceKey } : {}),
      }),
    });

  it('lists each account under the device key it proves, once', async () => {
    const key = newKey();
    await service.ensureUser(identity('ann', 'ann@example.test'));
    await proveKey('ann', key);
    await proveKey('ann', key);
    expect(await accountsOnDevice(service.repo, key.fingerprint)).toEqual([
      expect.objectContaining({ userId: 'ann', email: 'ann@example.test' }),
    ]);
  });

  it('refuses sign-up from a browser that recently made the limit of accounts', async () => {
    const { app } = createApp(service, new DevelopmentAuth());
    const key = newKey();
    for (const id of ['one', 'two']) {
      await service.ensureUser(identity(id, `${id}@example.test`));
      await proveKey(id, key);
    }
    const refused = await signup(app, 3, key.publicKey);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe('SIGNUP_LIMIT');
    // Another browser is fine.
    expect((await signup(app, 4, newKey().publicKey)).status).toBe(200);
  });
});
