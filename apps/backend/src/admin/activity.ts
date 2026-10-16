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
  type AdminUsage,
  type AdminUsageEvents,
  USAGE_ACTIONS,
  USAGE_DETAIL_FIELDS,
  USAGE_GROUP_ACTIONS,
  usageAction,
  type UsageAction,
  type UsageGroup,
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
  const { page, nextCursor } = paged(rows, after, pageSize);
  return {
    requests: page.map((r) => {
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
    }),
    nextCursor,
  };
}

/** The page of newest-first rows after a cursor, and the cursor of the page after it. */
function paged(rows: ActivityRows, after: Cursor | undefined, pageSize: number) {
  const at = (r: Record<string, string>) => Date.parse(iso(r['@timestamp']));
  const fresh = rows.filter(
    (r) => !after || at(r) < after.t || !after.ids.includes(r.requestId ?? ''),
  );
  const page = fresh.slice(0, pageSize);
  const last = page.at(-1);
  if (fresh.length <= pageSize || !last) return { page, nextCursor: null };
  const t = at(last);
  const ids = page.filter((r) => at(r) === t).map((r) => r.requestId ?? '');
  // Rows at that millisecond shown on earlier pages are still behind the cursor.
  if (after?.t === t) ids.push(...after.ids);
  return { page, nextCursor: encodeCursor({ t, ids }) };
}

const usageKeys = (actions?: readonly UsageAction[]) =>
  Object.entries(USAGE_ACTIONS)
    .filter(([, action]) => !actions || actions.includes(action))
    .map(([key]) => JSON.stringify(key));
/**
 * The account's successful usage requests. A desktop app re-sends its sync folder list on
 * every start, so that one only counts when its line says folders were added or removed.
 */
const usageFilter = (userId: string | null, actions?: readonly UsageAction[]) =>
  `${userId ? mine(userId) : 'filter ispresent(userId)'} and event = "request" and status < 400` +
  ` and concat(method, " ", route) in [${usageKeys(actions).join(', ')}]` +
  ' and (concat(method, " ", route) != "PUT /v1/sync/folders" or ispresent(usage.added))';

/** Each account's latest usage, by account ID. */
export type RecentUsage = Map<string, { at: string; action: UsageAction | null }>;
/**
 * Every account's latest usage in the 30 days the request log keeps: one query over the whole
 * log (about 3 GB, so around $0.015), which the console reuses for a couple of minutes.
 */
export async function recentUsage(source: ActivitySource, now = Date.now()): Promise<RecentUsage> {
  const { start, end } = bounds('30d', now);
  const rows = await source(
    `${usageFilter(null)}` +
      ' | stats max(@timestamp) as lastAt, latest(method) as m, latest(route) as r by userId',
    start,
    end,
  );
  return new Map(
    rows
      .filter((r) => r.userId && r.lastAt)
      .map((r) => [r.userId!, { at: iso(r.lastAt), action: usageAction(r.m ?? '', r.r ?? '') }]),
  );
}
const UPLOADED_KEY = 'POST /v1/uploads/:id/complete';
const DOWNLOADED_KEY = 'POST /v1/downloads';

/**
 * What an account uploaded, downloaded and set up over a range, by hour and by device, read
 * from the request log. Sizes are on lines since 11 Oct 2026; earlier lines count but weigh 0.
 */
export async function userUsage(
  source: ActivitySource,
  userId: string,
  range: AdminActivityRange,
  backups: AdminUsage['backups'],
  now = Date.now(),
): Promise<AdminUsage> {
  const { start, end } = bounds(range, now);
  const rows = await source(
    `${usageFilter(userId)}` +
      ' | stats count(*) as n, sum(usage.sizeBytes) as b, max(@timestamp) as lastAt' +
      ' by bin(1h), method, route, deviceId, platform, usage.fileKey',
    start,
    end,
  );
  // Each downloaded file once, at the largest size it was logged with.
  const files = new Map<string, number>();
  let untracked = 0;
  const totals = new Map<string, { action: string; count: number; bytes: number }>();
  const hours = new Map<string, { at: string; action: string; count: number; bytes: number }>();
  const devices = new Map<string, AdminUsage['devices'][number]>();
  for (const r of rows) {
    const action = usageAction(r.method ?? '', r.route ?? '');
    if (!action) continue;
    const count = Number(r.n) || 0;
    const size = Number(r.b) || 0;
    const add = <T extends { count: number; bytes: number }>(
      map: Map<string, T>,
      key: string,
      fresh: T,
    ) => {
      const seen = map.get(key) ?? map.set(key, fresh).get(key)!;
      seen.count += count;
      seen.bytes += size;
    };
    add(totals, action, { action, count: 0, bytes: 0 });
    const at = iso(r['bin(1h)']);
    add(hours, `${at} ${action}`, { at, action, count: 0, bytes: 0 });
    const deviceKey = `${r.deviceId ?? ''} ${r.platform ?? ''}`;
    const device =
      devices.get(deviceKey) ??
      devices
        .set(deviceKey, {
          deviceId: r.deviceId || null,
          platform: r.platform || null,
          uploads: { count: 0, bytes: 0 },
          downloads: { count: 0, bytes: 0 },
          other: 0,
          lastAt: '',
        })
        .get(deviceKey)!;
    const key = `${r.method} ${r.route}`;
    const bucket =
      key === UPLOADED_KEY ? device.uploads : key === DOWNLOADED_KEY ? device.downloads : null;
    if (bucket) {
      bucket.count += count;
      bucket.bytes += size;
    } else device.other += count;
    if (key === DOWNLOADED_KEY) {
      const fileKey = r['usage.fileKey'];
      if (fileKey) files.set(fileKey, Math.max(files.get(fileKey) ?? 0, size / (count || 1)));
      else untracked += count;
    }
    const lastAt = iso(r.lastAt);
    if (lastAt > device.lastAt) device.lastAt = lastAt;
  }
  return {
    range,
    since: new Date(start * 1000).toISOString(),
    totals: [...totals.values()].sort((a, b) => b.count - a.count),
    hours: [...hours.values()].sort((a, b) => a.at.localeCompare(b.at)),
    distinctDownloads: {
      files: files.size,
      bytes: [...files.values()].reduce((sum, bytes) => sum + bytes, 0),
      untracked,
    },
    devices: [...devices.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    backups,
  };
}

/** A page of an account's usage, newest first, with each action's sizes and counts. */
export async function usageLog(
  source: ActivitySource,
  userId: string,
  options: { range: AdminActivityRange; group: UsageGroup; cursor?: string; pageSize?: number },
  now = Date.now(),
): Promise<AdminUsageEvents> {
  const { start, end } = bounds(options.range, now);
  const pageSize = options.pageSize ?? ADMIN_REQUEST_PAGE;
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  const actions = options.group === 'all' ? undefined : USAGE_GROUP_ACTIONS[options.group];
  const rows = await source(
    usageFilter(userId, actions) +
      (after ? ` and @timestamp <= ${after.t}` : '') +
      ' | fields @timestamp, requestId, method, route, deviceId, platform, appVersion, ' +
      USAGE_DETAIL_FIELDS.map((f) => `usage.${f}`).join(', ') +
      ` | sort @timestamp desc | limit ${pageSize + (after?.ids.length ?? 0) + 1}`,
    start,
    end,
  );
  const { page, nextCursor } = paged(rows, after, pageSize);
  return {
    events: page.map((r) => {
      const method = r.method ?? '';
      const route = r.route ?? '';
      const platform = r.platform ?? null;
      const text = (f: string) => r[`usage.${f}`] || null;
      const flag = (f: string) => (text(f) === null ? null : text(f) === 'true' || text(f) === '1');
      return {
        at: iso(r['@timestamp']),
        requestId: r.requestId ?? '',
        action: usageAction(method, route) ?? `${method} ${route}`,
        automated: isAutomatedRequest(method, route, platform),
        deviceId: r.deviceId ?? null,
        platform,
        appVersion: r.appVersion ?? null,
        details: {
          sizeBytes: num(r['usage.sizeBytes']),
          mimeType: text('mimeType'),
          itemType: text('itemType'),
          backup: flag('backup'),
          source: text('source'),
          fileKey: text('fileKey'),
          files: num(r['usage.files']),
          added: num(r['usage.added']),
          removed: num(r['usage.removed']),
          trigger: text('trigger'),
          state: text('state'),
          permission: text('permission'),
        },
      };
    }),
    nextCursor,
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
