import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { Realtime } from '../src/realtime';
import {
  ApnsSender,
  PushDelivery,
  PushRegistrations,
  type PushRegistration,
  type PushResult,
} from '../src/push';

const registration = (deviceId: string, token: string): Omit<PushRegistration, 'updatedAt'> => ({
  deviceId,
  token,
  environment: 'sandbox',
  kind: 'FILE_PROVIDER',
  domain: 'alice',
});

describe('push delivery', () => {
  it('wakes each registered device once per burst and forgets tokens APNs rejects', async () => {
    const repo = new MemoryRepository();
    const registrations = new PushRegistrations(repo);
    await registrations.register('alice', registration('phone', 'aa11'));
    await registrations.register('alice', registration('ipad', 'bb22'));
    const sent: string[] = [];
    const delivery = new PushDelivery(registrations, {
      async send(r): Promise<PushResult> {
        sent.push(r.token);
        return r.token === 'bb22' ? 'gone' : 'sent';
      },
    });
    expect(await delivery.changed('alice', 1000)).toBe(2);
    expect(sent.sort()).toEqual(['aa11', 'bb22']);
    expect((await registrations.list('alice')).map((r) => r.deviceId)).toEqual(['phone']);
    // More changes within the debounce window do not send again.
    expect(await delivery.changed('alice', 3000)).toBe(0);
    expect(await delivery.changed('alice', 7000)).toBe(1);
  });

  it('is triggered by change-feed rows, not notifications, even without live sockets', async () => {
    const repo = new MemoryRepository();
    const registrations = new PushRegistrations(repo);
    await registrations.register('alice', registration('phone', 'aa11'));
    const woken: string[] = [];
    const realtime = new Realtime(repo, 'wss://live.example.test/live', undefined, {
      changed: async (userId: string) => {
        woken.push(userId);
        return 1;
      },
    } as unknown as PushDelivery);
    await realtime.publish([{ pk: 'USER#alice', sk: 'NOTIFICATION#2026-10-01#n1' }]);
    expect(woken).toEqual([]);
    await realtime.publish([{ pk: 'USER#alice', sk: 'CHANGE#0000000000000001' }]);
    expect(woken).toEqual(['alice']);
  });
});

describe('APNs sender', () => {
  let server: Http2Server | undefined;
  afterEach(() => server?.close());

  it('sends a File Provider push with a signed provider token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const requests: { headers: IncomingHttpHeaders; body: string }[] = [];
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requests.push({ headers: request.headers, body });
        if (request.headers[':path']!.endsWith('/dead')) {
          response.writeHead(410);
          response.end(JSON.stringify({ reason: 'Unregistered' }));
        } else if (request.headers[':path']!.endsWith('/broken')) {
          response.writeHead(400);
          response.end(JSON.stringify({ reason: 'BadTopic' }));
        } else {
          response.writeHead(200);
          response.end();
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sender = new ApnsSender(
      {
        keyId: 'KEY123',
        teamId: 'TEAM456',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      'app.harbor0.ios',
      { sandbox: host, production: host },
    );
    const base = { ...registration('phone', 'abc'), updatedAt: '' };
    await expect(sender.send({ ...base, token: 'abc' })).resolves.toBe('sent');
    await expect(sender.send({ ...base, token: 'dead' })).resolves.toBe('gone');
    await expect(sender.send({ ...base, token: 'broken' })).rejects.toThrow('APNs 400 BadTopic');
    sender.close();

    const { headers, body } = requests[0];
    expect(headers[':path']).toBe('/3/device/abc');
    expect(headers['apns-push-type']).toBe('fileprovider');
    expect(headers['apns-topic']).toBe('app.harbor0.ios.pushkit.fileprovider');
    expect(JSON.parse(body)).toEqual({
      'container-identifier': 'NSFileProviderWorkingSetContainerItemIdentifier',
      domain: 'alice',
    });
    const [header, claims, signature] = String(headers.authorization)
      .replace(/^bearer /, '')
      .split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: 'TEAM456',
    });
    const verified = createVerify('SHA256')
      .update(`${header}.${claims}`)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);
    // One provider token is reused across requests.
    expect(new Set(requests.map((r) => r.headers.authorization)).size).toBe(1);
  });
});

describe('push registration routes', () => {
  it('registers this device, validates tokens, and forgets it on sign-out', async () => {
    const repo = new MemoryRepository();
    const service = new StorageService(repo, new MemoryStorage());
    const { app } = createApp(service, new DevelopmentAuth(), []);
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password: 'Development-only-123!' }),
    });
    const tokens = await login.json();
    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const put = (token: string) =>
      app.request('/v1/devices/current/push', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          token,
          environment: 'sandbox',
          kind: 'FILE_PROVIDER',
          domain: 'alice',
        }),
      });
    expect((await put('not a token')).status).toBe(400);
    expect((await put('ABCDEF0123456789ABCDEF')).status).toBe(200);
    const { user } = await (await app.request('/v1/users/me', { headers })).json();
    const stored = await new PushRegistrations(repo).list(user.id);
    expect(stored).toMatchObject([{ token: 'abcdef0123456789abcdef', domain: 'alice' }]);
    const logout = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    expect(logout.status).toBe(200);
    expect(await new PushRegistrations(repo).list(user.id)).toEqual([]);
  });
});
