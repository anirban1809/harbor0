import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, redact } from '../src/api';
import { ApiClient } from '@harbor/api-client';
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

describe('app problem reports', () => {
  async function setup() {
    const service = new StorageService(new MemoryRepository(), new MemoryStorage());
    const auth = new DevelopmentAuth();
    const app = createApp(service, auth).app;
    const alice = [...auth.users.values()].find((u) => u.id === 'alice')!;
    await service.ensureUser(alice);
    await service.registerDevice(
      'alice',
      { name: 'Mac', platform: 'MACOS', appVersion: '0.1.6' },
      alice.deviceId,
    );
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(JSON.parse(line));
    });
    const post = (body: unknown) =>
      app.request('/v1/client-events', {
        method: 'POST',
        headers: { Authorization: 'Bearer dev-alice', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { post, lines };
  }

  it('logs each reported problem under the account and device, without URLs or paths', async () => {
    const { post, lines } = await setup();
    const res = await post({
      events: [
        {
          kind: 'UPLOAD_PART_RETRY',
          at: '2026-10-11T04:00:00.000Z',
          stage: 'storage',
          uploadId: 'up1',
          partNumber: 3,
          attempt: 1,
          httpStatus: 0,
          code: 'STALLED',
          message:
            'PUT https://bucket.r2.test/x?X-Amz-Signature=abc failed for /Users/a/Movies/film.mkv',
          online: true,
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(lines.find((l) => l.event === 'client_error')).toEqual(
      expect.objectContaining({
        userId: 'alice',
        deviceId: 'dev-alice',
        platform: 'MACOS',
        appVersion: '0.1.6',
        kind: 'UPLOAD_PART_RETRY',
        code: 'STALLED',
        partNumber: 3,
        message: 'PUT <url> failed for <path>',
      }),
    );
  });

  it('refuses unknown fields, unknown kinds and oversized batches', async () => {
    const { post } = await setup();
    const event = { kind: 'UPLOAD_FAILED', at: '2026-10-11T04:00:00.000Z', stage: 'complete' };
    expect((await post({ events: [{ ...event, fileName: 'secret.pdf' }] })).status).toBe(400);
    expect((await post({ events: [{ ...event, kind: 'ANYTHING' }] })).status).toBe(400);
    expect((await post({ events: Array(21).fill(event) })).status).toBe(400);
  });

  it('redacts URLs and Windows or Unix paths', () => {
    expect(redact('ENOENT: no such file, open C:\\Users\\a\\film.mkv')).toBe(
      'ENOENT: no such file, open <path>',
    );
    expect(redact('Network interrupted. Retry to resume.')).toBe(
      'Network interrupted. Retry to resume.',
    );
  });

  it('the API client batches reports, drops repeats, and survives a failed send', async () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[][] = [];
      let fail = true;
      const api = new ApiClient(async (_path, init) => {
        sent.push((init?.body as { events: unknown[] }).events);
        if (fail) throw new Error('offline');
        return { accepted: 1 };
      });
      const problem = {
        kind: 'UPLOAD_PART_RETRY',
        stage: 'storage',
        uploadId: 'u',
        partNumber: 1,
      } as const;
      api.reportProblem(problem);
      api.reportProblem(problem);
      api.reportProblem({ ...problem, partNumber: 2 });
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveLength(2);
      fail = false;
      for (let n = 3; n < 25; n++) api.reportProblem({ ...problem, partNumber: n });
      await vi.advanceTimersByTimeAsync(0);
      // A full batch goes at once; the rest waits for the timer.
      expect(sent[1]).toHaveLength(20);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent[2]).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('account activity', () => {
  const now = Date.parse('2026-10-11T06:00:00Z');
  const source = (
    groups: Record<string, string>[],
    rows: Record<string, string>[],
    events: Record<string, string>[] = [],
  ) => {
    const queries: string[] = [];
    const run: ActivitySource = async (query) => {
      queries.push(query);
      if (query.includes('stats')) return groups;
      return query.includes('"client_error" |') ? events : rows;
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
    expect(queries[2]).toContain('event = "client_error"');
    expect(activity.since).toBe('2026-10-10T06:00:00.000Z');
    expect(activity.totals).toEqual({
      requests: 50,
      failed: 10,
      serverErrors: 1,
      unauthorized: 9,
      appRetries: 0,
      appFailures: 0,
    });
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
  it('counts and lists the problems the apps reported', async () => {
    const { run } = source(
      [
        {
          event: 'client_error',
          kind: 'UPLOAD_PART_RETRY',
          stage: 'storage',
          code: 'STALLED',
          httpStatus: '0',
          n: '6',
          lastAt: '2026-10-11 03:00:00.000',
        },
        {
          event: 'client_error',
          kind: 'UPLOAD_FAILED',
          stage: 'storage',
          code: 'STALLED',
          httpStatus: '0',
          n: '2',
          lastAt: '2026-10-11 03:01:00.000',
        },
      ],
      [],
      [
        {
          '@timestamp': '2026-10-11 03:01:00.000',
          kind: 'UPLOAD_FAILED',
          stage: 'storage',
          code: 'STALLED',
          httpStatus: '0',
          uploadId: 'up1',
          sizeBytes: '2465790883',
          online: 'true',
          deviceId: 'd1',
          platform: 'WEB',
        },
      ],
    );
    const activity = await userActivity(run, 'user-1', '24h', false, now);
    expect(activity.totals).toMatchObject({ requests: 0, appRetries: 6, appFailures: 2 });
    expect(activity.appProblems.map((p) => p.kind)).toEqual(['UPLOAD_FAILED', 'UPLOAD_PART_RETRY']);
    expect(activity.appEvents[0]).toMatchObject({
      at: '2026-10-11T03:01:00.000Z',
      httpStatus: 0,
      sizeBytes: 2465790883,
      online: true,
      partNumber: null,
    });
  });
});
