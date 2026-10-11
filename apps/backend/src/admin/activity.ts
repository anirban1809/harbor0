import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import * as c from '@harbor/contracts';
import {
  ADMIN_REQUEST_PAGE,
  automatedRequestQuery,
  isAutomatedRequest,
  type AdminActivity,
  type AdminActivityOrigin,
  type AdminActivityRange,
  type AdminRequestLog,
} from '../../../../packages/contracts/src/admin';
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
/** The most app-reported problems one lookup lists. */
export const APP_EVENT_LIMIT = 100;
// The console Lambda answers within 29 s, so a query gets a little over 20.
const QUERY_DEADLINE_MS = 22_000;

/** Logs Insights prints times as "2026-10-11 04:33:00.049" in UTC. */
const iso = (value: string | undefined) =>
  value ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : '';
const num = (value: string | undefined) => (value === undefined ? null : Number(value));
const bounds = (range: AdminActivityRange, now: number) => {
  const end = Math.floor(now / 1000);
  return { start: end - RANGE_SECONDS[range], end };
};
// Ids are only letters, digits, "-" and "_", so the filter value never needs escaping.
const mine = (userId: string) => `filter userId = "${c.id.parse(userId)}"`;

/**
 * One account's activity, read from the request log: every line names the calling account,
 * device and error code (since 11 Oct 2026), and the apps' own problem reports are logged the
 * same way, so nothing extra is written per request.
 */
export async function userActivity(
  source: ActivitySource,
  userId: string,
  range: AdminActivityRange,
  now = Date.now(),
): Promise<AdminActivity> {
  const { start, end } = bounds(range, now);
  const filter = mine(userId);
  const [groups, events] = await Promise.all([
    source(
      `${filter} and event in ["request", "client_error"]` +
        ' | stats count(*) as n, max(@timestamp) as lastAt' +
        ' by event, method, route, status, code, platform, kind, stage, httpStatus',
      start,
      end,
    ),
    source(
      `${filter} and event = "client_error"` +
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
    manual: 0,
    automated: 0,
  };
  const problems = new Map<string, AdminActivity['problems'][number]>();
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
    const method = g.method ?? '';
    const route = g.route ?? '';
    const status = Number(g.status);
    const automated = isAutomatedRequest(method, route, g.platform ?? null);
    totals.requests += count;
    totals[automated ? 'automated' : 'manual'] += count;
    if (status < 400) continue;
    totals.failed += count;
    if (status >= 500) totals.serverErrors += count;
    if (status === 401) totals.unauthorized += count;
    // Groups split by platform; a failure is listed once per route, status and error.
    const key = [method, route, status, g.code, automated].join(' ');
    const lastAt = iso(g.lastAt);
    const seen = problems.get(key);
    if (seen) {
      seen.count += count;
      if (lastAt > seen.lastAt) seen.lastAt = lastAt;
    } else
      problems.set(key, { method, route, status, code: g.code ?? null, count, lastAt, automated });
  }
  // Our faults first, then the most frequent.
  const listed = [...problems.values()].sort(
    (a, b) => Number(b.status >= 500) - Number(a.status >= 500) || b.count - a.count,
  );
  // Failed uploads first, then the most frequent.
  appProblems.sort(
    (a, b) =>
      Number(b.kind === 'UPLOAD_FAILED') - Number(a.kind === 'UPLOAD_FAILED') || b.count - a.count,
  );
  return {
    range,
    since: new Date(start * 1000).toISOString(),
    totals,
    problems: listed,
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

/**
 * Where the next page starts: the oldest time shown, and the requests at exactly that
 * millisecond already shown, since several can share one and their order isn't fixed.
 */
type Cursor = { t: number; ids: string[] };
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decodeCursor(value: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (Number.isSafeInteger(cursor.t) && Array.isArray(cursor.ids) && cursor.ids.length <= 1000)
      return { t: cursor.t, ids: cursor.ids.map(String) };
  } catch {}
  throw new DomainError('VALIDATION_ERROR', 'The page cursor is not valid.', 400);
}

/** A page of one account's requests, newest first, by who made them. */
export async function requestLog(
  source: ActivitySource,
  userId: string,
  options: {
    range: AdminActivityRange;
    origin: AdminActivityOrigin;
    failedOnly: boolean;
    cursor?: string;
    pageSize?: number;
  },
  now = Date.now(),
): Promise<AdminRequestLog> {
  const { start, end } = bounds(options.range, now);
  const pageSize = options.pageSize ?? ADMIN_REQUEST_PAGE;
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  const automated = automatedRequestQuery();
  const rows = await source(
    `${mine(userId)} and event = "request"` +
      (options.origin === 'automated' ? ` and ${automated}` : '') +
      (options.origin === 'manual' ? ` and not ${automated}` : '') +
      (options.failedOnly ? ' and status >= 400' : '') +
      (after ? ` and @timestamp <= ${after.t}` : '') +
      ' | fields @timestamp, requestId, method, route, status, code, ms, deviceId, platform, appVersion' +
      // One more than a page says whether there is another.
      ` | sort @timestamp desc | limit ${pageSize + (after?.ids.length ?? 0) + 1}`,
    start,
    end,
  );
  const fresh = rows.filter(
    (r) =>
      !after ||
      Date.parse(iso(r['@timestamp'])) < after.t ||
      !after.ids.includes(r.requestId ?? ''),
  );
  const page = fresh.slice(0, pageSize);
  const requests = page.map((r) => {
    const method = r.method ?? '';
    const route = r.route ?? '';
    const platform = r.platform ?? null;
    return {
      automated: isAutomatedRequest(method, route, platform),
      at: iso(r['@timestamp']),
      requestId: r.requestId ?? '',
      method,
      route,
      status: Number(r.status),
      code: r.code ?? null,
      ms: num(r.ms),
      deviceId: r.deviceId ?? null,
      platform,
      appVersion: r.appVersion ?? null,
    };
  });
  const last = requests.at(-1);
  if (fresh.length <= pageSize || !last) return { requests, nextCursor: null };
  const t = Date.parse(last.at);
  const ids = requests.filter((r) => Date.parse(r.at) === t).map((r) => r.requestId);
  // Requests at that millisecond shown on earlier pages are still behind the cursor.
  if (after?.t === t) ids.push(...after.ids);
  return { requests, nextCursor: encodeCursor({ t, ids }) };
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
