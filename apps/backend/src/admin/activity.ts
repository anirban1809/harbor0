import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import * as c from '@harbor/contracts';
import type { AdminActivity, AdminActivityRange } from '../../../../packages/contracts/src/admin';
import { DomainError } from '../errors';

/** Rows of a Logs Insights query, each field by name. */
export type ActivityRows = Record<string, string>[];
/** Runs a Logs Insights query over the API request log between two epoch-second bounds. */
export type ActivitySource = (query: string, start: number, end: number) => Promise<ActivityRows>;

const RANGE_SECONDS: Record<AdminActivityRange, number> = {
  '1h': 3600,
  '24h': 86_400,
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
};
/** The most requests one lookup lists; totals and problems still count every request. */
export const ACTIVITY_LIMIT = 200;
/** The most app-reported problems one lookup lists. */
export const APP_EVENT_LIMIT = 100;
// The console Lambda answers within 29 s, so a query gets a little over 20.
const QUERY_DEADLINE_MS = 22_000;

/** Logs Insights prints times as "2026-10-11 04:33:00.049" in UTC. */
const iso = (value: string | undefined) =>
  value ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : '';
const num = (value: string | undefined) => (value === undefined ? null : Number(value));

/**
 * One account's API requests, read from the request log: every line names the calling account,
 * device and error code (since 11 Oct 2026), so nothing extra is written per request.
 */
export async function userActivity(
  source: ActivitySource,
  userId: string,
  range: AdminActivityRange,
  failedOnly: boolean,
  now = Date.now(),
): Promise<AdminActivity> {
  // Ids are only letters, digits, "-" and "_", so the filter value never needs escaping.
  const id = c.id.parse(userId);
  const end = Math.floor(now / 1000);
  const start = end - RANGE_SECONDS[range];
  const mine = `filter userId = "${id}"`;
  const [groups, rows, events] = await Promise.all([
    source(
      `${mine} and event in ["request", "client_error"]` +
        ' | stats count(*) as n, max(@timestamp) as lastAt' +
        ' by event, method, route, status, code, kind, stage, httpStatus',
      start,
      end,
    ),
    source(
      `${mine} and event = "request"${failedOnly ? ' and status >= 400' : ''}` +
        ' | fields @timestamp, requestId, method, route, status, code, ms, deviceId, platform, appVersion' +
        ` | sort @timestamp desc | limit ${ACTIVITY_LIMIT}`,
      start,
      end,
    ),
    source(
      `${mine} and event = "client_error"` +
        ' | fields @timestamp, kind, stage, code, httpStatus, message, uploadId, sizeBytes, partNumber,' +
        ' attempt, online, deviceId, platform, appVersion' +
        ` | sort @timestamp desc | limit ${APP_EVENT_LIMIT}`,
      start,
      end,
    ),
  ]);
  const totals = {
    requests: 0,
    failed: 0,
    serverErrors: 0,
    unauthorized: 0,
    appRetries: 0,
    appFailures: 0,
  };
  const problems: AdminActivity['problems'] = [];
  const appProblems: AdminActivity['appProblems'] = [];
  for (const g of groups) {
    const count = Number(g.n);
    if (g.event === 'client_error') {
      if (g.kind === 'UPLOAD_FAILED') totals.appFailures += count;
      else totals.appRetries += count;
      appProblems.push({
        kind: g.kind ?? '',
        stage: g.stage ?? '',
        code: g.code ?? null,
        httpStatus: num(g.httpStatus),
        count,
        lastAt: iso(g.lastAt),
      });
      continue;
    }
    const status = Number(g.status);
    totals.requests += count;
    if (status < 400) continue;
    totals.failed += count;
    if (status >= 500) totals.serverErrors += count;
    if (status === 401) totals.unauthorized += count;
    problems.push({
      method: g.method ?? '',
      route: g.route ?? '',
      status,
      code: g.code ?? null,
      count,
      lastAt: iso(g.lastAt),
    });
  }
  // Our faults first, then the most frequent.
  problems.sort((a, b) => Number(b.status >= 500) - Number(a.status >= 500) || b.count - a.count);
  // Failed uploads first, then the most frequent.
  appProblems.sort(
    (a, b) =>
      Number(b.kind === 'UPLOAD_FAILED') - Number(a.kind === 'UPLOAD_FAILED') || b.count - a.count,
  );
  return {
    range,
    since: new Date(start * 1000).toISOString(),
    totals,
    problems,
    requests: rows.map((r) => ({
      at: iso(r['@timestamp']),
      requestId: r.requestId ?? '',
      method: r.method ?? '',
      route: r.route ?? '',
      status: Number(r.status),
      code: r.code ?? null,
      ms: num(r.ms),
      deviceId: r.deviceId ?? null,
      platform: r.platform ?? null,
      appVersion: r.appVersion ?? null,
    })),
    truncated: (failedOnly ? totals.failed : totals.requests) > rows.length,
    appProblems,
    appEvents: events.map((e) => ({
      at: iso(e['@timestamp']),
      kind: e.kind ?? '',
      stage: e.stage ?? '',
      code: e.code ?? null,
      httpStatus: num(e.httpStatus),
      message: e.message ?? null,
      uploadId: e.uploadId ?? null,
      sizeBytes: num(e.sizeBytes),
      partNumber: num(e.partNumber),
      attempt: num(e.attempt),
      online: e.online === undefined ? null : e.online === 'true' || e.online === '1',
      deviceId: e.deviceId ?? null,
      platform: e.platform ?? null,
      appVersion: e.appVersion ?? null,
    })),
  };
}

/** Logs Insights over the API log group, polled until the query finishes. */
export function cloudWatchActivity(logGroupName: string): ActivitySource {
  const client = new CloudWatchLogsClient({});
  return async (queryString, startTime, endTime) => {
    const { queryId } = await client.send(
      new StartQueryCommand({ logGroupName, queryString, startTime, endTime, limit: 10_000 }),
    );
    const deadline = Date.now() + QUERY_DEADLINE_MS;
    for (let wait = 300; ; wait = Math.min(wait * 1.5, 2000)) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      const result = await client.send(new GetQueryResultsCommand({ queryId }));
      if (result.status === 'Complete')
        return (result.results ?? []).map((row) =>
          Object.fromEntries(row.map((f) => [f.field ?? '', f.value ?? ''])),
        );
      if (result.status !== 'Running' && result.status !== 'Scheduled')
        throw new DomainError('UNAVAILABLE', 'The request log could not be read.', 503);
      if (Date.now() > deadline) {
        await client.send(new StopQueryCommand({ queryId })).catch(() => undefined);
        throw new DomainError(
          'UNAVAILABLE',
          'Reading the request log took too long. Try a shorter range.',
          503,
        );
      }
    }
  };
}
