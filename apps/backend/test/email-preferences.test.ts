import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { composeEmail } from '../src/emails';
import {
  EmailLinks,
  EmailSuppressions,
  maskEmail,
  recordMailEvent,
} from '../src/email-preferences';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';

const links = new EmailLinks('test-secret-that-is-long-enough-for-hmac-signing', 'https://app.test');

async function setup() {
  const repo = new MemoryRepository();
  const service = new StorageService(repo, new MemoryStorage());
  const { app } = createApp(service, new DevelopmentAuth(), [], undefined, undefined, undefined, links);
  const response = await app.request('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.test', password: 'Development-only-123!' }),
  });
  const headers = {
    Authorization: `Bearer ${(await response.json()).accessToken}`,
    'Content-Type': 'application/json',
  };
  const me = async () => (await (await app.request('/v1/users/me', { headers })).json()).user;
  const userId = (await me()).id as string;
  const t = encodeURIComponent(links.token(userId));
  return { app, repo, service, headers, me, userId, t };
}

describe('unsubscribe links', () => {
  it('are signed for one account and refuse anything altered', () => {
    const token = links.token('alice');
    expect(links.verify(token)).toBe('alice');
    expect(links.verify(token.replace('alice', 'bob'))).toBeUndefined();
    expect(links.verify(`${token}x`)).toBeUndefined();
    expect(links.verify('alice')).toBeUndefined();
    expect(new EmailLinks('a-different-secret-entirely-for-signing', 'https://app.test').verify(token)).toBeUndefined();
    expect(links.unsubscribe('alice')).toEqual({
      page: `https://app.test/unsubscribe?t=${encodeURIComponent(token)}`,
      oneClick: `https://app.test/api/v1/email/unsubscribe?t=${encodeURIComponent(token)}`,
    });
  });

  it('show, stop and restore product updates without signing in', async () => {
    const { app, me, t } = await setup();
    expect((await me()).emailPreferences).toBeUndefined();
    const status = await app.request(`/v1/email/unsubscribe?t=${t}`);
    expect(await status.json()).toEqual({
      subscription: { email: 'a•••@example.test', productUpdates: true },
    });
    // A mail app's one-click request: a form body, no JSON, no session.
    const oneClick = await app.request(`/v1/email/unsubscribe?t=${t}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status).toBe(200);
    expect((await oneClick.json()).subscription.productUpdates).toBe(false);
    expect((await me()).emailPreferences).toEqual({ productUpdates: false });
    // Repeating it changes nothing.
    expect((await app.request(`/v1/email/unsubscribe?t=${t}`, { method: 'POST' })).status).toBe(200);
    const back = await app.request(`/v1/email/resubscribe?t=${t}`, { method: 'POST' });
    expect((await back.json()).subscription.productUpdates).toBe(true);
    expect((await me()).emailPreferences).toEqual({ productUpdates: true });
  });

  it('refuse a missing or forged token', async () => {
    const { app, userId } = await setup();
    for (const query of ['', '?t=', `?t=${userId}.forged`]) {
      const response = await app.request(`/v1/email/unsubscribe${query}`, { method: 'POST' });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_LINK');
    }
  });

  it('are refused when the server has no signing secret', async () => {
    const { app } = createApp(
      new StorageService(new MemoryRepository(), new MemoryStorage()),
      new DevelopmentAuth(),
    );
    const response = await app.request(`/v1/email/unsubscribe?t=${links.token('alice')}`);
    expect(response.status).toBe(400);
  });
});

describe('email preferences in settings', () => {
  it('are saved with the profile and validated', async () => {
    const { app, headers, me } = await setup();
    const patch = (body: unknown) =>
      app.request('/v1/users/me', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ operationId: randomUUID(), ...(body as object) }),
      });
    expect((await patch({ emailPreferences: { productUpdates: false } })).status).toBe(200);
    expect((await me()).emailPreferences).toEqual({ productUpdates: false });
    expect((await patch({ emailPreferences: { productUpdates: 'no' } })).status).toBe(400);
    expect((await patch({ emailPreferences: { marketing: true } })).status).toBe(400);
  });
});

describe('optional email', () => {
  it('carries an unsubscribe footer and one-click headers', () => {
    const unsubscribe = links.unsubscribe('alice');
    const message = composeEmail(
      { template: 'PASSWORD_CHANGED', to: 'alice@example.test', at: new Date().toISOString(), unsubscribe },
      'https://app.test',
    );
    expect(message.html).toContain('Unsubscribe</a>');
    expect(message.html).toContain(unsubscribe.page.replaceAll('&', '&amp;'));
    expect(message.text).toContain(`Unsubscribe from product updates: ${unsubscribe.page}`);
    expect(message.headers).toEqual([
      { name: 'List-Unsubscribe', value: `<${unsubscribe.oneClick}>` },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ]);
    const plain = composeEmail(
      { template: 'PASSWORD_CHANGED', to: 'alice@example.test', at: new Date().toISOString() },
      'https://app.test',
    );
    expect(plain.headers).toEqual([]);
    expect(plain.html).not.toContain('Unsubscribe');
  });
});

describe('mail events', () => {
  it('suppress hard bounces and complaints, not soft bounces or deliveries', async () => {
    const suppressions = new EmailSuppressions(new MemoryRepository());
    const bounce = (bounceType: string, emailAddress: string) => ({
      eventType: 'Bounce',
      mail: { messageId: 'm1' },
      bounce: { bounceType, bouncedRecipients: [{ emailAddress }] },
    });
    expect(await recordMailEvent(suppressions, bounce('Permanent', 'Gone@Example.test'))).toBe(1);
    expect(await recordMailEvent(suppressions, bounce('Transient', 'full@example.test'))).toBe(0);
    expect(
      await recordMailEvent(suppressions, {
        eventType: 'Complaint',
        complaint: { complainedRecipients: [{ emailAddress: 'angry@example.test' }] },
      }),
    ).toBe(1);
    expect(await recordMailEvent(suppressions, { eventType: 'Delivery' })).toBe(0);
    expect(await suppressions.get('gone@example.test')).toMatchObject({
      source: 'BOUNCE',
      messageId: 'm1',
    });
    expect(await suppressions.get('ANGRY@example.test')).toMatchObject({ source: 'COMPLAINT' });
    expect(await suppressions.get('full@example.test')).toBeUndefined();
  });

  it('mask addresses for the unsubscribe page', () => {
    expect(maskEmail('alice@example.com')).toBe('a•••@example.com');
    expect(maskEmail('nobody')).toBe('•••');
  });
});
