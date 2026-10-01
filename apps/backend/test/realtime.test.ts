import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository, transact } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { Realtime, interests, type RealtimeMessage } from '../src/realtime';

function setup() {
  const repo = new MemoryRepository();
  const sent: { connectionId: string; message: RealtimeMessage }[] = [];
  const gone = new Set<string>();
  const realtime = new Realtime(repo, 'wss://live.example.test/live', {
    async send(connectionId, message) {
      if (gone.has(connectionId)) return false;
      sent.push({ connectionId, message });
      return true;
    },
  });
  const connect = async (connectionId: string, userId: string) => {
    const { ticket } = await realtime.ticket(userId, `device-${userId}`);
    await realtime.connect(connectionId, ticket);
  };
  return { repo, realtime, sent, gone, connect };
}
afterEach(() => vi.useRealTimers());

describe('realtime interests', () => {
  it('wakes the feed owner for changes and notifications, and owners for shared folders', () => {
    expect(
      interests([
        { pk: 'USER#a', sk: 'CHANGE#0000000000000001' },
        { pk: 'USER#a', sk: 'NOTIFICATION#2026-10-01#n1' },
        { pk: 'USER#a', sk: 'NOTIFICATION_ID#n1' },
        { pk: 'USER#b', sk: 'ACCESS#folder' },
        { pk: 'USER#a', sk: 'SYNCFOLDERREV#folder' },
        { pk: 'USER#a', sk: 'PROFILE' },
        { pk: 'OBJECT', sk: 'x' },
      ]),
    ).toEqual([
      { userId: 'a', type: 'changes' },
      { userId: 'a', type: 'notification' },
      { userId: 'b', type: 'changes' },
      { ownerId: 'a', folderId: 'folder' },
    ]);
  });
});

describe('realtime connections', () => {
  it('accepts a ticket once and delivers each kind of hint once per connection', async () => {
    const { realtime, sent, connect } = setup();
    await connect('c1', 'alice');
    await connect('c2', 'alice');
    await connect('c3', 'bob');
    await realtime.publish([
      { pk: 'USER#alice', sk: 'CHANGE#0000000000000001' },
      { pk: 'USER#alice', sk: 'CHANGE#0000000000000002' },
      { pk: 'USER#alice', sk: 'NOTIFICATION#2026-10-01#n1' },
    ]);
    expect(sent.map((s) => `${s.connectionId}:${s.message.type}`).sort()).toEqual([
      'c1:changes',
      'c1:notification',
      'c2:changes',
      'c2:notification',
    ]);
  });
  it('rejects missing, reused and expired tickets', async () => {
    const { realtime } = setup();
    await expect(realtime.connect('c1', undefined)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    const { ticket } = await realtime.ticket('alice', 'device');
    await realtime.connect('c1', ticket);
    await expect(realtime.connect('c2', ticket)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const late = await realtime.ticket('alice', 'device');
    vi.setSystemTime(Date.now() + 61_000);
    await expect(realtime.connect('c3', late.ticket)).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });
  it('forgets disconnected and vanished connections', async () => {
    const { repo, realtime, sent, gone, connect } = setup();
    await connect('c1', 'alice');
    await connect('c2', 'alice');
    await realtime.disconnect('c1');
    gone.add('c2');
    await realtime.publish([{ pk: 'USER#alice', sk: 'CHANGE#0000000000000001' }]);
    expect(sent).toEqual([]);
    expect([...repo.rows.keys()].filter((key) => key.includes('RTCONN'))).toEqual([]);
  });
  it('wakes accepted recipients of a shared sync folder only', async () => {
    const { repo, realtime, sent, connect } = setup();
    for (const user of ['alice', 'bob', 'carol', 'dave']) await connect(`c-${user}`, user);
    const share = (id: string, recipientUserId: string, extra: object) => ({
      id,
      driveItemId: 'folder',
      ownerUserId: 'alice',
      recipientUserId,
      permission: 'EDITOR',
      createdAt: '2026-10-01T00:00:00.000Z',
      revokedAt: null,
      ...extra,
    });
    await transact(repo, async (tx) => {
      await tx.put('USER#alice', 'SHARE#s1', share('s1', 'bob', { syncState: 'ACCEPTED' }));
      await tx.put('USER#alice', 'SHARE#s2', share('s2', 'carol', { syncState: 'PENDING' }));
      await tx.put(
        'USER#alice',
        'SHARE#s3',
        share('s3', 'dave', { syncState: 'ACCEPTED', revokedAt: '2026-10-01T01:00:00.000Z' }),
      );
    });
    await realtime.publish([{ pk: 'USER#alice', sk: 'SYNCFOLDERREV#folder' }]);
    expect(sent).toEqual([{ connectionId: 'c-bob', message: { type: 'changes' } }]);
  });
});

describe('realtime tickets route', () => {
  async function app(realtime?: Realtime) {
    const repo = new MemoryRepository();
    const service = new StorageService(repo, new MemoryStorage());
    const { app } = createApp(service, new DevelopmentAuth(), [], undefined, realtime);
    const login = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password: 'Development-only-123!' }),
    });
    const headers = { Authorization: `Bearer ${(await login.json()).accessToken}` };
    return { app, repo, headers };
  }
  it('issues a ticket the socket can redeem for the signed-in user', async () => {
    const repo = new MemoryRepository();
    const realtime = new Realtime(repo, 'wss://live.example.test/live');
    const { app: api, headers } = await app(realtime);
    const response = await api.request('/v1/realtime/tickets', { method: 'POST', headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.url).toBe('wss://live.example.test/live');
    await expect(realtime.connect('c1', body.ticket)).resolves.toEqual({ userId: 'alice' });
  });
  it('reports live updates as unavailable when not configured, and requires sign-in', async () => {
    const { app: api, headers } = await app();
    const response = await api.request('/v1/realtime/tickets', { method: 'POST', headers });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('REALTIME_UNAVAILABLE');
    const anonymous = await api.request('/v1/realtime/tickets', { method: 'POST' });
    expect(anonymous.status).toBe(401);
  });
});
