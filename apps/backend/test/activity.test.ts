import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, redact } from '../src/api';
import { ApiClient } from '@harbor/api-client';
import { DevelopmentAuth } from '../src/auth';
import { StorageService } from '../src/domain';
import { MemoryRepository } from '../src/repository';
import { MemoryStorage } from '../src/storage';
import {
  requestLog,
  usageLog,
  userActivity,
  userUsage,
  type ActivitySource,
} from '../src/admin/activity';
import { usageDetails } from '../src/usage-events';
import { isAutomatedRequest } from '../../../packages/contracts/src/admin';

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
  const source = (groups: Record<string, string>[], events: Record<string, string>[] = []) => {
    const queries: string[] = [];
    const run: ActivitySource = async (query) => {
      queries.push(query);
      return query.includes('stats') ? groups : events;
    };
    return { run, queries };
  };

  it('tells requests people made from ones the apps make by themselves', () => {
    expect(isAutomatedRequest('GET', '/v1/sync/status', 'WEB')).toBe(true);
    expect(isAutomatedRequest('POST', '/v1/uploads', 'WEB')).toBe(false);
    expect(isAutomatedRequest('POST', '/v1/uploads', 'ANDROID')).toBe(true);
    // Desktop apps have no file browser; their sync engine renames and moves.
    expect(isAutomatedRequest('PATCH', '/v1/drive/items/:id', 'MACOS')).toBe(true);
    expect(isAutomatedRequest('PATCH', '/v1/drive/items/:id', 'IOS')).toBe(false);
    expect(isAutomatedRequest('POST', '/v1/drive/trash/empty', 'WINDOWS')).toBe(false);
  });

  it('totals requests by who made them and groups failures with server errors first', async () => {
    const { run, queries } = source([
      {
        event: 'request',
        method: 'GET',
        route: '/v1/users/me',
        status: '200',
        platform: 'WEB',
        n: '40',
        lastAt: '2026-10-11 05:00:00.000',
      },
      {
        event: 'request',
        method: 'POST',
        route: '/v1/uploads',
        status: '200',
        platform: 'WEB',
        n: '5',
        lastAt: '2026-10-11 05:00:00.000',
      },
      {
        event: 'request',
        method: 'GET',
        route: '/v1/users/me',
        status: '401',
        code: 'AUTH_INVALID',
        platform: 'WEB',
        n: '6',
        lastAt: '2026-10-11 05:10:00.000',
      },
      {
        event: 'request',
        method: 'GET',
        route: '/v1/users/me',
        status: '401',
        code: 'AUTH_INVALID',
        platform: 'MACOS',
        n: '3',
        lastAt: '2026-10-11 05:20:00.000',
      },
      {
        event: 'request',
        method: 'GET',
        route: '/v1/uploads/:id',
        status: '500',
        code: 'INTERNAL_ERROR',
        platform: 'WEB',
        n: '1',
        lastAt: '2026-10-11 04:42:22.088',
      },
    ]);
    const activity = await userActivity(run, 'user-1', '24h', now);
    expect(queries[0]).toContain('userId = "user-1"');
    expect(activity.since).toBe('2026-10-10T06:00:00.000Z');
    expect(activity.totals).toEqual({
      requests: 55,
      failed: 10,
      serverErrors: 1,
      unauthorized: 9,
      appRetries: 0,
      appFailures: 0,
      manual: 5,
      automated: 50,
    });
    // The 401s from two platforms are one row.
    expect(activity.problems).toEqual([
      expect.objectContaining({ status: 500, count: 1, automated: true }),
      expect.objectContaining({ status: 401, count: 9, lastAt: '2026-10-11T05:20:00.000Z' }),
    ]);
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
      [
        {
          '@timestamp': '2026-10-11 03:01:00.000',
          kind: 'UPLOAD_FAILED',
          stage: 'storage',
          code: 'STALLED',
          httpStatus: '0',
          sizeBytes: '2465790883',
          online: 'true',
        },
      ],
    );
    const activity = await userActivity(run, 'user-1', '24h', now);
    expect(activity.totals).toMatchObject({ requests: 0, appRetries: 6, appFailures: 2 });
    expect(activity.appProblems.map((p) => p.kind)).toEqual(['UPLOAD_FAILED', 'UPLOAD_PART_RETRY']);
    expect(activity.appEvents[0]).toMatchObject({
      httpStatus: 0,
      sizeBytes: 2465790883,
      online: true,
    });
  });

  it('refuses ids that could change the query', async () => {
    const { run } = source([]);
    await expect(userActivity(run, 'x" or userId != "', '1h', now)).rejects.toThrow();
  });
});

describe('request log pages', () => {
  const now = Date.parse('2026-10-11T06:00:00Z');
  // A fake log: the newest first, honouring the cursor's time and the limit like Insights.
  const log = Array.from({ length: 7 }, (_, i) => ({
    '@timestamp': `2026-10-11 05:00:0${i < 4 ? 0 : i}.000`,
    requestId: `r${i}`,
    method: 'GET',
    route: '/v1/drive/folders/:id/children',
    status: '200',
    platform: 'WEB',
  })).reverse();
  const queries: string[] = [];
  const run: ActivitySource = async (query) => {
    queries.push(query);
    const t = query.match(/@timestamp <= (\d+)/)?.[1];
    const limit = Number(query.match(/limit (\d+)/)![1]);
    return log
      .filter((r) => !t || Date.parse(r['@timestamp'].replace(' ', 'T') + 'Z') <= Number(t))
      .slice(0, limit);
  };

  it('pages newest first without losing or repeating requests that share a millisecond', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await requestLog(
        run,
        'user-1',
        { range: '24h', origin: 'manual', failedOnly: false, cursor, pageSize: 2 },
        now,
      );
      seen.push(...page.requests.map((r) => r.requestId));
      expect(page.requests.every((r) => !r.automated)).toBe(true);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(seen.sort()).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(pages).toBe(4);
    expect(queries[0]).toContain('and not (');
  });

  it('filters by origin and failures, and refuses a forged cursor', async () => {
    await requestLog(run, 'user-1', { range: '1h', origin: 'automated', failedOnly: true }, now);
    expect(queries.at(-1)).toMatch(
      /and \(concat\(method, " ", route\) in \[.*\]\)\) and status >= 400/,
    );
    await expect(
      requestLog(
        run,
        'user-1',
        { range: '1h', origin: 'all', failedOnly: false, cursor: 'nope' },
        now,
      ),
    ).rejects.toThrow('cursor');
  });
});

describe('usage on request lines', () => {
  it('logs sizes and counts of usage requests, never names', async () => {
    const service = new StorageService(new MemoryRepository(), new MemoryStorage());
    const auth = new DevelopmentAuth();
    const app = createApp(service, auth).app;
    const alice = [...auth.users.values()].find((u) => u.id === 'alice')!;
    await service.ensureUser(alice);
    await service.registerDevice('alice', { name: 'Mac', platform: 'MACOS' }, alice.deviceId);
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(JSON.parse(line));
    });
    const send = (method: string, path: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { Authorization: 'Bearer dev-alice', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const created = await send('POST', '/v1/drive/folders', {
      operationId: crypto.randomUUID(),
      name: 'Private plans',
    });
    const { item } = (await created.json()) as { item: { id: string; revision: number } };
    expect((await send('PUT', '/v1/sync/folders', { folderIds: [item.id] })).status).toBe(200);
    // The desktop app re-sends the same list on every start: not usage.
    expect((await send('PUT', '/v1/sync/folders', { folderIds: [item.id] })).status).toBe(200);
    expect(
      (
        await send('DELETE', `/v1/drive/items/${item.id}`, {
          operationId: crypto.randomUUID(),
          baseRevision: item.revision,
        })
      ).status,
    ).toBe(200);

    const requests = lines.filter((l) => l.event === 'request');
    expect(requests.map((l) => l.usage)).toEqual([
      {},
      { added: 1, removed: 0 },
      undefined,
      { itemType: 'FOLDER' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('Private plans');
  });

  it('reads sizes from uploads, downloads and backup runs', () => {
    expect(
      usageDetails(
        'POST',
        '/v1/uploads/:id/complete',
        {},
        { item: { sizeBytes: 5, mimeType: 'image/png', backupRootId: 'b1', name: 'x.png' } },
      ),
    ).toEqual({ sizeBytes: 5, mimeType: 'image/png', backup: true });
    expect(usageDetails('POST', '/v1/downloads', { transferId: 't1' }, { sizeBytes: 9 })).toEqual({
      sizeBytes: 9,
      source: 'TRANSFER',
    });
    expect(
      usageDetails(
        'POST',
        '/v1/backups/:id/runs/:runId/complete',
        {},
        { run: { state: 'COMPLETED', fileCount: 3, sizeBytes: 30 } },
      ),
    ).toEqual({ state: 'COMPLETED', files: 3, sizeBytes: 30 });
    expect(usageDetails('GET', '/v1/drive/items/:id', {}, {})).toBeUndefined();
  });
});

describe('account usage', () => {
  const now = Date.parse('2026-10-11T06:00:00Z');

  it('totals usage by action, hour and device', async () => {
    const queries: string[] = [];
    const run: ActivitySource = async (query) => {
      queries.push(query);
      const row = (method: string, route: string, n: string, b: string, deviceId = 'd1') => ({
        'bin(1h)': '2026-10-11 04:00:00.000',
        method,
        route,
        deviceId,
        platform: 'WEB',
        n,
        b,
        lastAt: '2026-10-11 04:30:00.000',
      });
      return [
        row('POST', '/v1/uploads/:id/complete', '3', '300'),
        row('POST', '/v1/downloads', '2', '50'),
        row('POST', '/v1/drive/folders', '1', ''),
        row('POST', '/v1/backups/:id/runs', '1', '', 'd2'),
      ];
    };
    const usage = await userUsage(run, 'user-1', '24h', [], now);
    expect(usage.totals).toEqual([
      { action: 'UPLOADED', count: 3, bytes: 300 },
      { action: 'DOWNLOADED', count: 2, bytes: 50 },
      { action: 'FOLDER_CREATED', count: 1, bytes: 0 },
      { action: 'BACKUP_STARTED', count: 1, bytes: 0 },
    ]);
    expect(usage.hours[0]).toEqual({
      at: '2026-10-11T04:00:00.000Z',
      action: 'UPLOADED',
      count: 3,
      bytes: 300,
    });
    expect(usage.devices.find((d) => d.deviceId === 'd1')).toEqual(
      expect.objectContaining({
        uploads: { count: 3, bytes: 300 },
        downloads: { count: 2, bytes: 50 },
        other: 1,
      }),
    );
    expect(queries[0]).toContain('filter userId = "user-1"');
    expect(queries[0]).toContain('ispresent(usage.added)');
  });

  it('lists usage newest first with its details, filtered by group', async () => {
    const queries: string[] = [];
    const run: ActivitySource = async (query) => {
      queries.push(query);
      return [
        {
          '@timestamp': '2026-10-11 05:00:00.000',
          requestId: 'r1',
          method: 'POST',
          route: '/v1/uploads/:id/complete',
          platform: 'MACOS',
          'usage.sizeBytes': '1200',
          'usage.mimeType': 'video/mp4',
          'usage.backup': 'true',
        },
      ];
    };
    const page = await usageLog(run, 'user-1', { range: '7d', group: 'transfers' }, now);
    expect(page.events[0]).toEqual(
      expect.objectContaining({
        action: 'UPLOADED',
        automated: true,
        details: expect.objectContaining({ sizeBytes: 1200, mimeType: 'video/mp4', backup: true }),
      }),
    );
    expect(queries[0]).toContain('"POST /v1/downloads"');
    expect(queries[0]).not.toContain('"POST /v1/drive/folders"');
  });
});
