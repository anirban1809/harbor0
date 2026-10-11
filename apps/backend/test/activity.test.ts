import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import { userActivity, type ActivitySource } from '../src/admin/activity';

afterEach(() => vi.restoreAllMocks());

describe('request log', () => {
  it('names the account, device and error code on each request line', async () => {
    const service = new StorageService(new MemoryRepository(), new MemoryStorage());
    const auth = new DevelopmentAuth();
    const app = createApp(service, auth).app;
    const alice = [...auth.users.values()].find((u) => u.id === 'alice')!;
    await service.ensureUser(alice);
    await service.registerDevice('alice', { name: 'Browser', platform: 'WEB' }, alice.deviceId);
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(JSON.parse(line));
    });
    const get = (path: string, token?: string) =>
      app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

    expect((await get('/v1/drive/items/missing', 'dev-alice')).status).toBe(404);
    expect((await get('/v1/users/me')).status).toBe(401);
    expect(lines).toEqual([
      expect.objectContaining({
        event: 'request',
        route: '/v1/drive/items/:id',
        status: 404,
        userId: 'alice',
        deviceId: 'dev-alice',
        platform: 'WEB',
        code: 'ITEM_NOT_FOUND',
      }),
      expect.objectContaining({ status: 401, code: 'AUTH_REQUIRED' }),
    ]);
    // Without a session there is no account to name.
    expect(lines[1]).not.toHaveProperty('userId');
  });
});

describe('account activity', () => {
  const now = Date.parse('2026-10-11T06:00:00Z');
  const source = (groups: Record<string, string>[], rows: Record<string, string>[]) => {
    const queries: string[] = [];
    const run: ActivitySource = async (query) => {
      queries.push(query);
      return query.includes('stats') ? groups : rows;
    };
    return { run, queries };
  };

  it('totals requests, groups failures with server errors first, and lists the latest', async () => {
    const { run, queries } = source(
      [
        {
          method: 'GET',
          route: '/v1/users/me',
          status: '200',
          n: '40',
          lastAt: '2026-10-11 05:00:00.000',
        },
        {
          method: 'GET',
          route: '/v1/users/me',
          status: '401',
          code: 'AUTH_INVALID',
          n: '9',
          lastAt: '2026-10-11 05:10:00.000',
        },
        {
          method: 'GET',
          route: '/v1/uploads/:id',
          status: '500',
          code: 'INTERNAL_ERROR',
          n: '1',
          lastAt: '2026-10-11 04:42:22.088',
        },
      ],
      [
        {
          '@timestamp': '2026-10-11 04:42:22.088',
          requestId: 'r1',
          method: 'GET',
          route: '/v1/uploads/:id',
          status: '500',
          code: 'INTERNAL_ERROR',
          ms: '772',
          deviceId: 'd1',
          platform: 'WEB',
        },
      ],
    );
    const activity = await userActivity(run, 'user-1', '24h', true, now);
    expect(queries[0]).toContain('userId = "user-1"');
    expect(queries[1]).toContain('status >= 400');
    expect(activity.since).toBe('2026-10-10T06:00:00.000Z');
    expect(activity.totals).toEqual({ requests: 50, failed: 10, serverErrors: 1, unauthorized: 9 });
    expect(activity.problems.map((p) => p.status)).toEqual([500, 401]);
    expect(activity.problems[0].lastAt).toBe('2026-10-11T04:42:22.088Z');
    expect(activity.requests).toEqual([
      {
        at: '2026-10-11T04:42:22.088Z',
        requestId: 'r1',
        method: 'GET',
        route: '/v1/uploads/:id',
        status: 500,
        code: 'INTERNAL_ERROR',
        ms: 772,
        deviceId: 'd1',
        platform: 'WEB',
        appVersion: null,
      },
    ]);
    // 10 failures matched but only one came back.
    expect(activity.truncated).toBe(true);
  });

  it('refuses ids that could change the query', async () => {
    const { run } = source([], []);
    await expect(userActivity(run, 'x" or userId != "', '1h', false, now)).rejects.toThrow();
  });
});
