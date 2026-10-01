// Backend operations dashboard built from CloudWatch, Logs Insights, Cost Explorer
// and the R2 bucket listing.
//
//   npm run cloud:dashboard                 write a 30-day snapshot to .cloud/
//   npm run cloud:dashboard -- 14           same, 14-day window
//   npm run cloud:dashboard -- --serve      live dashboard on http://127.0.0.1:4319
//                                           (/current counts from the moment the page loads)
//
// The AWS account hosts other projects, so cost is attributed by multiplying
// harbor0's own metered usage by the account's effective rate for that usage
// type over the same window (which is $0 where the free tier absorbs it).
//
// Serve mode polls AWS while it runs: the request log every 5 s, minute metrics
// every 30 s, the full snapshot every 10 min and Cost Explorer every 6 h. Left
// running all day that is roughly $0.50 of CloudWatch and Cost Explorer calls.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const region = process.env.AWS_REGION ?? 'us-east-1';
const args = process.argv.slice(2);
const serve = args.includes('--serve');
const port = Number(args[args.indexOf('--port') + 1]) || 4319;
const windowDays = Math.max(2, Math.min(90, Number(args.find((a) => /^\d+$/.test(a))) || 30));

async function aws<T = any>(cli: string[], env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const { stdout } = await exec('aws', [...cli, '--region', region, '--output', 'json'], {
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout || 'null') as T;
}
async function attempt<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.warn(
      `! ${label}: ${String((error as Error).message)
        .split('\n')[0]!
        .slice(0, 160)}`,
    );
    return fallback;
  }
}
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// ---- resources --------------------------------------------------------------
type StackResource = {
  ResourceType: string;
  PhysicalResourceId: string;
  LogicalResourceId: string;
};
const stackResources = async (name: string) =>
  (
    await aws<{ StackResources: StackResource[] }>([
      'cloudformation',
      'describe-stack-resources',
      '--stack-name',
      name,
    ])
  ).StackResources;
const physical = (list: StackResource[], type: string) =>
  list.filter((r) => r.ResourceType === type).map((r) => r.PhysicalResourceId);

async function discover() {
  const [storage, web] = await Promise.all([
    stackResources('HarborStorage'),
    attempt('HarborWeb stack', () => stackResources('HarborWeb'), []),
  ]);
  const functions = await Promise.all(
    storage
      .filter((r) => r.ResourceType === 'AWS::Lambda::Function')
      .map(async (r) => {
        const config = await aws<{ MemorySize: number; LoggingConfig?: { LogGroup?: string } }>([
          'lambda',
          'get-function-configuration',
          '--function-name',
          r.PhysicalResourceId,
        ]);
        return {
          key: r.LogicalResourceId.replace(/[0-9A-F]{8}$/, ''),
          name: r.PhysicalResourceId,
          memoryMb: config.MemorySize,
          logGroup: config.LoggingConfig?.LogGroup ?? `/aws/lambda/${r.PhysicalResourceId}`,
        };
      }),
  );
  functions.sort((a, b) => a.key.localeCompare(b.key));
  return {
    apiId: physical(storage, 'AWS::ApiGatewayV2::Api')[0]!,
    table: physical(storage, 'AWS::DynamoDB::Table')[0]!,
    userPool: physical(storage, 'AWS::Cognito::UserPool')[0],
    queueUrl: physical(storage, 'AWS::SQS::Queue')[0],
    distribution: physical(web, 'AWS::CloudFront::Distribution')[0],
    functions,
    apiLogGroup: functions.find((f) => f.key === 'Api')?.logGroup,
  };
}
type Resources = Awaited<ReturnType<typeof discover>>;

// ---- CloudWatch metrics -----------------------------------------------------
type Dim = Record<string, string>;
type Query = { id: string; ns: string; metric: string; stat: string; dims: Dim; period: number };
function metricBatch() {
  const queries: Query[] = [];
  const results = new Map<string, Map<number, number>>();
  return {
    add(ns: string, metric: string, stat: string, dims: Dim, period = 86_400) {
      const id = `m${queries.length}`;
      queries.push({ id, ns, metric, stat, dims, period });
      return id;
    },
    // Queries are fetched per period so each batch shares one time range.
    async fetch(ranges: Record<number, [number, number]>) {
      for (const [period, [from, to]] of Object.entries(ranges)) {
        const list = queries.filter((m) => m.period === Number(period));
        for (let i = 0; i < list.length; i += 400) {
          let token: string | undefined;
          do {
            const page = await aws<{
              MetricDataResults: { Id: string; Timestamps: string[]; Values: number[] }[];
              NextToken?: string;
            }>([
              'cloudwatch',
              'get-metric-data',
              '--no-paginate',
              '--start-time',
              new Date(from).toISOString(),
              '--end-time',
              new Date(to).toISOString(),
              ...(token ? ['--next-token', token] : []),
              '--metric-data-queries',
              JSON.stringify(
                list.slice(i, i + 400).map((m) => ({
                  Id: m.id,
                  ReturnData: true,
                  MetricStat: {
                    Metric: {
                      Namespace: m.ns,
                      MetricName: m.metric,
                      Dimensions: Object.entries(m.dims).map(([Name, Value]) => ({ Name, Value })),
                    },
                    Period: m.period,
                    Stat: m.stat,
                  },
                })),
              ),
            ]);
            for (const r of page.MetricDataResults) {
              const series = results.get(r.Id) ?? new Map<number, number>();
              r.Timestamps.forEach((t, k) => series.set(Date.parse(t), r.Values[k]!));
              results.set(r.Id, series);
            }
            token = page.NextToken;
          } while (token);
        }
      }
    },
    series: (id: string, from: number, step: number, length: number) =>
      Array.from({ length }, (_, i) => results.get(id)?.get(from + i * step) ?? 0),
    single: (id: string) => [...(results.get(id)?.values() ?? [])][0] ?? null,
  };
}
const listDims = (ns: string, name: string, dims: Dim, wanted: string) =>
  attempt(
    `list ${name}`,
    async () => [
      ...new Set(
        (
          await aws<{ Metrics: { Dimensions: { Name: string; Value: string }[] }[] }>([
            'cloudwatch',
            'list-metrics',
            '--namespace',
            ns,
            '--metric-name',
            name,
            '--dimensions',
            ...Object.entries(dims).map(([k, v]) => `Name=${k},Value=${v}`),
          ])
        ).Metrics.map((m) => m.Dimensions.find((d) => d.Name === wanted)?.Value).filter(
          (v): v is string => Boolean(v),
        ),
      ),
    ],
    [],
  );

// ---- Logs Insights ----------------------------------------------------------
async function insights(logGroup: string, query: string, from: number, to: number) {
  const { queryId } = await aws<{ queryId: string }>([
    'logs',
    'start-query',
    '--log-group-name',
    logGroup,
    '--start-time',
    String(Math.floor(from / 1000)),
    '--end-time',
    String(Math.floor(to / 1000)),
    '--query-string',
    query,
  ]);
  for (let i = 0; i < 80; i++) {
    const r = await aws<{ status: string; results: { field: string; value: string }[][] }>([
      'logs',
      'get-query-results',
      '--query-id',
      queryId,
    ]);
    if (r.status === 'Complete')
      return r.results.map((row) => Object.fromEntries(row.map((f) => [f.field, f.value])));
    if (r.status !== 'Running' && r.status !== 'Scheduled') break;
    await sleep(1500);
  }
  return [] as Record<string, string>[];
}
const REPORT_QUERY =
  'filter @type="REPORT" | stats count() as n, sum(@billedDuration) as billedMs, ' +
  'max(@maxMemoryUsed)/1000000 as maxMemMb, sum(ispresent(@initDuration)) as cold, ' +
  'avg(@initDuration) as initMs';
// Matches the access log line written by the request middleware in apps/backend/src/api.ts.
const ROUTE_QUERY =
  'filter @message like /"event":"request"/ ' +
  '| parse @message /"method":"(?<method>[A-Z]+)","route":"(?<route>[^"]*)","status":(?<status>\\d+),"ms":(?<ms>\\d+)/ ' +
  '| stats count() as n, sum(status >= 400 and status < 500) as e4, sum(status >= 500) as e5, ' +
  'avg(ms) as avgMs, pct(ms, 95) as p95Ms by method, route | sort n desc | limit 300';

// ---- Cost Explorer (each call is billed, so results are cached) -----------------
type CeGroups = {
  ResultsByTime: {
    TimePeriod: { Start: string };
    Total?: Record<string, { Amount: string }>;
    Groups: { Keys: string[]; Metrics: Record<string, { Amount: string }> }[];
  }[];
};
let costCache: { at: number; key: string; value: Awaited<ReturnType<typeof loadCosts>> } | null =
  null;
async function loadCosts(firstDay: string, endDay: number) {
  const tomorrow = isoDay(endDay + DAY);
  const monthsBack = new Date(endDay);
  monthsBack.setUTCDate(1);
  monthsBack.setUTCMonth(monthsBack.getUTCMonth() - 5);
  const [ce, monthly] = await Promise.all([
    attempt(
      'cost explorer',
      () =>
        aws<CeGroups>([
          'ce',
          'get-cost-and-usage',
          '--time-period',
          `Start=${firstDay},End=${tomorrow}`,
          '--granularity',
          'MONTHLY',
          '--metrics',
          'UnblendedCost',
          'UsageQuantity',
          '--group-by',
          'Type=DIMENSION,Key=SERVICE',
          'Type=DIMENSION,Key=USAGE_TYPE',
        ]),
      { ResultsByTime: [] },
    ),
    attempt(
      'cost explorer months',
      async () =>
        (
          await aws<CeGroups>([
            'ce',
            'get-cost-and-usage',
            '--time-period',
            `Start=${isoDay(monthsBack.getTime())},End=${tomorrow}`,
            '--granularity',
            'MONTHLY',
            '--metrics',
            'UnblendedCost',
          ])
        ).ResultsByTime.map((p) => ({
          month: p.TimePeriod.Start.slice(0, 7),
          total: Number(p.Total?.UnblendedCost?.Amount ?? 0),
        })),
      [],
    ),
  ]);
  const billed = new Map<string, { cost: number; usage: number }>();
  const byService = new Map<string, number>();
  for (const period of ce.ResultsByTime)
    for (const g of period.Groups) {
      const [service, usageType] = g.Keys as [string, string];
      const cost = Number(g.Metrics.UnblendedCost!.Amount);
      const entry = billed.get(`${service}|${usageType}`) ?? { cost: 0, usage: 0 };
      entry.cost += cost;
      entry.usage += Number(g.Metrics.UsageQuantity!.Amount);
      billed.set(`${service}|${usageType}`, entry);
      byService.set(service, (byService.get(service) ?? 0) + cost);
    }
  return { billed, byService, monthly };
}
async function costs(firstDay: string, endDay: number) {
  const key = `${firstDay}|${endDay}`;
  if (!costCache || costCache.key !== key || Date.now() - costCache.at > 6 * HOUR)
    costCache = { at: Date.now(), key, value: await loadCosts(firstDay, endDay) };
  return costCache.value;
}

const LIST = {
  apiRequest: 1.0 / 1e6,
  lambdaRequest: 0.2 / 1e6,
  lambdaGbSecond: 0.0000166667,
  readUnit: 0.125 / 1e6,
  writeUnit: 0.625 / 1e6,
  secretMonth: 0.4,
  logGb: 0.5,
};
// Cloudflare R2 list prices and monthly free allowances. Egress is free.
const R2 = {
  gbMonth: 0.015,
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  freeGb: 10,
  freeClassA: 1_000_000,
  freeClassB: 10_000_000,
};

// ---- Cloudflare R2 ----------------------------------------------------------
// Listing the bucket is itself a Class A operation, so the result is cached.
let r2Cache: {
  at: number;
  value: Promise<{ bucket: string; bytes: number; objects: number } | null>;
} | null = null;
function r2Usage() {
  const env = process.env;
  if (!env.R2_BUCKET || !env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID) return Promise.resolve(null);
  if (r2Cache && Date.now() - r2Cache.at < 60_000) return r2Cache.value;
  const value = attempt<{ bucket: string; bytes: number; objects: number } | null>(
    'R2 listing',
    async () => {
      const [bytes, objects] = await aws<[number | null, number | null]>(
        [
          's3api',
          'list-objects-v2',
          '--bucket',
          env.R2_BUCKET!,
          '--endpoint-url',
          env.R2_ENDPOINT!,
          '--query',
          '[sum(Contents[].Size), length(Contents[])]',
        ],
        {
          ...env,
          AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
        },
      );
      return { bucket: env.R2_BUCKET!, bytes: bytes ?? 0, objects: objects ?? 0 };
    },
    null,
  );
  r2Cache = { at: Date.now(), value };
  return value;
}
// Billing classes per https://developers.cloudflare.com/r2/pricing/ ; anything else is free.
const CLASS_A =
  /^(ListBuckets|PutBucket|ListObjects|PutObject|CopyObject|CompleteMultipartUpload|CreateMultipartUpload|LifecycleStorageTierTransition|ListMultipartUploads|UploadPart|UploadPartCopy|ListParts|PutBucket\w+)$/;
const CLASS_B = /^(HeadBucket|HeadObject|GetObject|UsageSummary|GetBucket\w+)$/;
type R2Operations = {
  classA: number;
  classB: number;
  free: number;
  byAction: { action: string; count: number }[];
};
let r2OpsDenied = 0;
// Needs a Cloudflare token with Account Analytics: Read. Returns null when it cannot be read.
async function r2Operations(from: number, to: number): Promise<R2Operations | null> {
  const env = process.env;
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.R2_BUCKET) return null;
  if (Date.now() - r2OpsDenied < 10 * 60_000) return null;
  const query = `{viewer{accounts(filter:{accountTag:${JSON.stringify(env.CLOUDFLARE_ACCOUNT_ID)}}){r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:${JSON.stringify(new Date(from).toISOString())},datetime_leq:${JSON.stringify(new Date(to).toISOString())},bucketName:${JSON.stringify(env.R2_BUCKET)}}){sum{requests} dimensions{actionType}}}}}`;
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    const body = (await response.json()) as {
      data?: {
        viewer: {
          accounts: {
            r2OperationsAdaptiveGroups: {
              sum: { requests: number };
              dimensions: { actionType: string };
            }[];
          }[];
        };
      } | null;
      errors?: { message: string }[] | null;
    };
    const groups = body.data?.viewer.accounts[0]?.r2OperationsAdaptiveGroups;
    if (!groups) throw new Error(body.errors?.[0]?.message ?? `HTTP ${response.status}`);
    const totals = new Map<string, number>();
    for (const g of groups)
      totals.set(
        g.dimensions.actionType,
        (totals.get(g.dimensions.actionType) ?? 0) + g.sum.requests,
      );
    const byAction = [...totals]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count);
    const of = (test: (a: string) => boolean) =>
      sum(byAction.filter((a) => test(a.action)).map((a) => a.count));
    return {
      classA: of((a) => CLASS_A.test(a)),
      classB: of((a) => CLASS_B.test(a)),
      free: of((a) => !CLASS_A.test(a) && !CLASS_B.test(a)),
      byAction,
    };
  } catch (error) {
    if (!r2OpsDenied) console.warn(`! R2 operations: ${(error as Error).message}`);
    r2OpsDenied = Date.now();
    return null;
  }
}

// ---- full snapshot ----------------------------------------------------------
async function collect(res: Resources) {
  const now = Date.now();
  const endDay = Math.floor(now / DAY) * DAY;
  const startMs = endDay - (windowDays - 1) * DAY;
  const days = Array.from({ length: windowDays }, (_, i) => isoDay(startMs + i * DAY));
  const hourlyHours = 168;
  const hourlyStart = Math.floor(now / HOUR) * HOUR - (hourlyHours - 1) * HOUR;
  const total = windowDays * 86_400;
  const { apiId, table, userPool, queueUrl, distribution, functions } = res;

  const D = 'AWS/DynamoDB';
  const t = { TableName: table };
  const [gsis, ddbOps, clients] = await Promise.all([
    listDims(D, 'ConsumedReadCapacityUnits', t, 'GlobalSecondaryIndexName'),
    listDims(D, 'SuccessfulRequestLatency', t, 'Operation'),
    userPool
      ? listDims('AWS/Cognito', 'SignInSuccesses', { UserPool: userPool }, 'UserPoolClient')
      : Promise.resolve([]),
  ]);

  const m = metricBatch();
  const A = 'AWS/ApiGateway';
  const api = { ApiId: apiId };
  const scopes = [t, ...gsis.map((g) => ({ ...t, GlobalSecondaryIndexName: g }))];
  const cdnDims = distribution ? { DistributionId: distribution, Region: 'Global' } : null;
  const cognito = (name: string) =>
    clients.map((c) =>
      m.add('AWS/Cognito', name, 'Sum', { UserPool: userPool!, UserPoolClient: c }),
    );
  const q = {
    api: {
      count: m.add(A, 'Count', 'Sum', api),
      e4: m.add(A, '4xx', 'Sum', api),
      e5: m.add(A, '5xx', 'Sum', api),
      p50: m.add(A, 'Latency', 'p50', api),
      p95: m.add(A, 'Latency', 'p95', api),
      p99: m.add(A, 'Latency', 'p99', api),
      bytes: m.add(A, 'DataProcessed', 'Sum', api),
      hourly: m.add(A, 'Count', 'Sum', api, 3600),
      all50: m.add(A, 'Latency', 'p50', api, total),
      all95: m.add(A, 'Latency', 'p95', api, total),
      all99: m.add(A, 'Latency', 'p99', api, total),
    },
    fn: functions.map((f) => {
      const d = { FunctionName: f.name };
      return {
        inv: m.add('AWS/Lambda', 'Invocations', 'Sum', d),
        err: m.add('AWS/Lambda', 'Errors', 'Sum', d),
        thr: m.add('AWS/Lambda', 'Throttles', 'Sum', d),
        dur: m.add('AWS/Lambda', 'Duration', 'Sum', d),
        avg: m.add('AWS/Lambda', 'Duration', 'Average', d, total),
        p95: m.add('AWS/Lambda', 'Duration', 'p95', d, total),
        conc: m.add('AWS/Lambda', 'ConcurrentExecutions', 'Maximum', d, total),
      };
    }),
    ddb: {
      rcu: scopes.map((s) => m.add(D, 'ConsumedReadCapacityUnits', 'Sum', s)),
      wcu: scopes.map((s) => m.add(D, 'ConsumedWriteCapacityUnits', 'Sum', s)),
      ops: ddbOps.sort().map((op) => ({
        op,
        count: m.add(D, 'SuccessfulRequestLatency', 'SampleCount', { ...t, Operation: op }),
        avg: m.add(D, 'SuccessfulRequestLatency', 'Average', { ...t, Operation: op }, total),
      })),
    },
    cdn: cdnDims
      ? {
          req: m.add('AWS/CloudFront', 'Requests', 'Sum', cdnDims),
          bytes: m.add('AWS/CloudFront', 'BytesDownloaded', 'Sum', cdnDims),
          e4: m.add('AWS/CloudFront', '4xxErrorRate', 'Average', cdnDims, total),
          e5: m.add('AWS/CloudFront', '5xxErrorRate', 'Average', cdnDims, total),
        }
      : null,
    auth: userPool
      ? {
          signIn: cognito('SignInSuccesses'),
          refresh: cognito('TokenRefreshSuccesses'),
          signUp: cognito('SignUpSuccesses'),
        }
      : null,
    logs: functions.map((f) =>
      m.add('AWS/Logs', 'IncomingBytes', 'Sum', { LogGroupName: f.logGroup }),
    ),
  };

  const [, reports, routeRows, alarms, dlqDepth, tableInfo, r2, r2Ops, cost] = await Promise.all([
    // CloudFront publishes its metrics in us-east-1 only, which is also the stack's region.
    m.fetch({
      86400: [startMs, endDay + DAY],
      [total]: [startMs, endDay + DAY],
      3600: [hourlyStart, hourlyStart + hourlyHours * HOUR],
    }),
    Promise.all(
      functions.map((f) =>
        attempt(
          `insights ${f.key}`,
          async () => (await insights(f.logGroup, REPORT_QUERY, startMs, now))[0] ?? {},
          {},
        ),
      ),
    ),
    res.apiLogGroup
      ? attempt('insights routes', () => insights(res.apiLogGroup!, ROUTE_QUERY, startMs, now), [])
      : Promise.resolve([]),
    attempt(
      'alarms',
      async () =>
        (
          await aws<{ MetricAlarms: { AlarmName: string; StateValue: string }[] }>([
            'cloudwatch',
            'describe-alarms',
            '--alarm-name-prefix',
            'HarborStorage',
          ])
        ).MetricAlarms.map((a) => ({
          name: a.AlarmName.replace(/^HarborStorage-/, '').replace(/[0-9A-F]{8}-.*$/, ''),
          state: a.StateValue,
        })),
      [],
    ),
    queueUrl
      ? attempt<number | null>(
          'dlq',
          async () =>
            Number(
              (
                await aws<{ Attributes: Record<string, string> }>([
                  'sqs',
                  'get-queue-attributes',
                  '--queue-url',
                  queueUrl,
                  '--attribute-names',
                  'ApproximateNumberOfMessages',
                ])
              ).Attributes.ApproximateNumberOfMessages,
            ),
          null,
        )
      : Promise.resolve(null),
    attempt(
      'table',
      async () =>
        (
          await aws<{ Table: { ItemCount: number; TableSizeBytes: number } }>([
            'dynamodb',
            'describe-table',
            '--table-name',
            table,
          ])
        ).Table,
      { ItemCount: 0, TableSizeBytes: 0 },
    ),
    r2Usage(),
    r2Operations(startMs, now),
    costs(days[0]!, endDay),
  ]);

  const daily = (id: string) => m.series(id, startMs, DAY, windowDays);
  const dailySum = (ids: string[]) =>
    ids.map(daily).reduce(
      (acc, s) => acc.map((v, i) => v + s[i]!),
      days.map(() => 0),
    );

  // Effective account rate for a usage type; falls back to the list price when the
  // account has no billed usage of that type in the window.
  const rate = (service: string, usageType: string, list: number) => {
    const entry = cost.billed.get(`${service}|${usageType}`);
    return entry && entry.usage > 0 ? entry.cost / entry.usage : list;
  };
  const rates = {
    apiRequest: rate('Amazon API Gateway', 'USE1-ApiGatewayHttpRequest', LIST.apiRequest),
    lambdaRequest: rate('AWS Lambda', 'Request', LIST.lambdaRequest),
    lambdaGbSecond: rate('AWS Lambda', 'Lambda-GB-Second', LIST.lambdaGbSecond),
    readUnit: rate('Amazon DynamoDB', 'ReadRequestUnits', LIST.readUnit),
    writeUnit: rate('Amazon DynamoDB', 'WriteRequestUnits', LIST.writeUnit),
    secretMonth: rate('AWS Secrets Manager', 'USE1-AWSSecretsManager-Secrets', LIST.secretMonth),
    logGb: rate('AmazonCloudWatch', 'USE1-DataProcessing-Bytes', LIST.logGb),
  };

  const apiCount = daily(q.api.count);
  const rcu = dailySum(q.ddb.rcu);
  const wcu = dailySum(q.ddb.wcu);
  const fnInv = q.fn.map((f) => daily(f.inv));
  const fnGbs = q.fn.map((f, i) =>
    daily(f.dur).map((ms) => (ms / 1000) * (functions[i]!.memoryMb / 1024)),
  );
  const invDaily = days.map((_, d) => sum(fnInv.map((s) => s[d]!)));
  const gbsDaily = days.map((_, d) => sum(fnGbs.map((s) => s[d]!)));
  const logGb = sum(q.logs.map((id) => sum(daily(id)))) / 1e9;
  const cdnReq = q.cdn ? daily(q.cdn.req) : [];
  const cdnBilledReq = sum(
    [...cost.billed]
      .filter(([k]) => k.startsWith('Amazon CloudFront|') && /Requests/.test(k))
      .map(([, v]) => v.usage),
  );
  const cdnCost =
    (cost.byService.get('Amazon CloudFront') ?? 0) *
    Math.min(1, cdnBilledReq ? sum(cdnReq) / cdnBilledReq : 0);
  const months = windowDays / 30;
  // Free allowances are monthly, so they scale with the window.
  const r2Line = (
    item: string,
    usage: number | null,
    unit: string,
    free: number,
    price: number,
  ) => ({
    item,
    usage,
    unit,
    free,
    cost: usage === null ? null : Math.max(0, usage - free) * price,
    listCost: usage === null ? null : usage * price,
  });
  const cloudflare = {
    bucket: r2?.bucket ?? process.env.R2_BUCKET ?? null,
    bytes: r2?.bytes ?? null,
    objects: r2?.objects ?? null,
    operationsReadable: r2Ops !== null,
    byAction: r2Ops?.byAction ?? [],
    items: [
      r2Line(
        'Storage',
        r2 ? r2.bytes / 1e9 : null,
        'GB stored now',
        R2.freeGb,
        R2.gbMonth * months,
      ),
      r2Line(
        'Class A operations (writes, lists)',
        r2Ops?.classA ?? null,
        'operations',
        R2.freeClassA * months,
        R2.classAPerMillion / 1e6,
      ),
      r2Line(
        'Class B operations (reads)',
        r2Ops?.classB ?? null,
        'operations',
        R2.freeClassB * months,
        R2.classBPerMillion / 1e6,
      ),
    ],
  };

  type CostItem = {
    service: string;
    item: string;
    usage: number;
    unit: string;
    cost: number;
    listCost: number;
    note?: string;
  };
  const line = (
    service: string,
    item: string,
    usage: number,
    unit: string,
    effective: number,
    list: number,
  ): CostItem => ({ service, item, usage, unit, cost: usage * effective, listCost: usage * list });
  const costItems: CostItem[] = [
    line(
      'API Gateway',
      'HTTP API requests',
      sum(apiCount),
      'requests',
      rates.apiRequest,
      LIST.apiRequest,
    ),
    line('DynamoDB', 'On-demand writes', sum(wcu), 'write units', rates.writeUnit, LIST.writeUnit),
    line('DynamoDB', 'On-demand reads', sum(rcu), 'read units', rates.readUnit, LIST.readUnit),
    line(
      'Secrets Manager',
      'R2 credentials secret',
      months,
      'secret-months',
      rates.secretMonth,
      LIST.secretMonth,
    ),
    line(
      'Lambda',
      'Invocations',
      sum(invDaily),
      'requests',
      rates.lambdaRequest,
      LIST.lambdaRequest,
    ),
    line(
      'Lambda',
      'Compute',
      sum(gbsDaily),
      'GB-seconds',
      rates.lambdaGbSecond,
      LIST.lambdaGbSecond,
    ),
    line('CloudWatch', 'Log ingestion', logGb, 'GB', rates.logGb, LIST.logGb),
    {
      service: 'CloudFront',
      item: 'Web + API proxy requests',
      usage: sum(cdnReq),
      unit: 'requests',
      cost: cdnCost,
      listCost: cdnCost,
      note: 'Share of the account CloudFront bill by request count',
    },
  ];
  for (const item of costItems)
    if (!item.note && item.listCost > 0 && item.cost < item.listCost * 0.5)
      item.note = 'Covered by the AWS free tier';

  const num = (row: Record<string, string> | undefined, key: string) =>
    row?.[key] === undefined ? null : Number(row[key]);
  return {
    generatedAt: new Date(now).toISOString(),
    rates,
    windowDays,
    region,
    days,
    health: { alarms, dlqDepth },
    api: {
      count: apiCount,
      e4: daily(q.api.e4),
      e5: daily(q.api.e5),
      p50: daily(q.api.p50),
      p95: daily(q.api.p95),
      p99: daily(q.api.p99),
      bytes: sum(daily(q.api.bytes)),
      overall: {
        p50: m.single(q.api.all50),
        p95: m.single(q.api.all95),
        p99: m.single(q.api.all99),
      },
      hourly: {
        start: new Date(hourlyStart).toISOString(),
        count: m.series(q.api.hourly, hourlyStart, HOUR, hourlyHours),
      },
    },
    routes: routeRows.map((r) => ({
      method: r.method ?? '',
      route: r.route ?? '',
      count: Number(r.n ?? 0),
      e4: Number(r.e4 ?? 0),
      e5: Number(r.e5 ?? 0),
      avgMs: num(r, 'avgMs'),
      p95Ms: num(r, 'p95Ms'),
    })),
    lambda: functions.map((f, i) => ({
      key: f.key,
      memoryMb: f.memoryMb,
      invocations: sum(fnInv[i]!),
      errors: sum(daily(q.fn[i]!.err)),
      throttles: sum(daily(q.fn[i]!.thr)),
      avgMs: m.single(q.fn[i]!.avg),
      p95Ms: m.single(q.fn[i]!.p95),
      maxConcurrency: m.single(q.fn[i]!.conc),
      gbSeconds: sum(fnGbs[i]!),
      coldStarts: num(reports[i], 'cold'),
      initMs: num(reports[i], 'initMs'),
      maxMemMb: num(reports[i], 'maxMemMb'),
    })),
    ddb: {
      rcu,
      wcu,
      items: tableInfo.ItemCount,
      bytes: tableInfo.TableSizeBytes,
      ops: q.ddb.ops.map((o) => ({ op: o.op, count: sum(daily(o.count)), avgMs: m.single(o.avg) })),
    },
    cdn: q.cdn
      ? {
          req: cdnReq,
          bytes: sum(daily(q.cdn.bytes)),
          e4Rate: m.single(q.cdn.e4),
          e5Rate: m.single(q.cdn.e5),
        }
      : null,
    auth: q.auth
      ? {
          signIn: sum(dailySum(q.auth.signIn)),
          refresh: sum(dailySum(q.auth.refresh)),
          signUp: sum(dailySum(q.auth.signUp)),
        }
      : null,
    r2,
    cloudflare,
    cost: {
      items: costItems,
      daily: [
        {
          name: 'DynamoDB',
          values: days.map((_, d) => rcu[d]! * rates.readUnit + wcu[d]! * rates.writeUnit),
        },
        { name: 'API Gateway', values: apiCount.map((n) => n * rates.apiRequest) },
        { name: 'Secrets Manager', values: days.map(() => rates.secretMonth / 30) },
        {
          name: 'Lambda',
          values: days.map(
            (_, d) => invDaily[d]! * rates.lambdaRequest + gbsDaily[d]! * rates.lambdaGbSecond,
          ),
        },
      ],
      account: {
        windowTotal: sum([...cost.byService.values()]),
        byService: [...cost.byService]
          .map(([service, c]) => ({ service, cost: c }))
          .filter((s) => s.cost >= 0.005)
          .sort((a, b) => b.cost - a.cost),
        months: cost.monthly,
      },
    },
  };
}
type Snapshot = Awaited<ReturnType<typeof collect>>;

const template = () =>
  readFileSync(new URL('./ops-dashboard.template.html', import.meta.url), 'utf8');
const embed = (data: Snapshot | null) =>
  template().replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
const standalone = (fragment: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0">${fragment}</body></html>`;
const summary = (data: Snapshot) =>
  `${sum(data.api.count).toLocaleString()} API requests, est. $${sum(data.cost.items.map((i) => i.cost)).toFixed(2)} over ${windowDays} days`;

// ---- live: minute metrics and the request log tail ---------------------------
type LoggedRequest = {
  t: number;
  id: string;
  method: string;
  route: string;
  status: number;
  ms: number;
};
function liveFeed(res: Resources) {
  const MINUTES = 60;
  const recent: LoggedRequest[] = [];
  const seen = new Set<string>();
  let cursor = Date.now() - 15 * 60_000;
  let minutes = {
    start: '',
    count: [] as number[],
    e4: [] as number[],
    e5: [] as number[],
    p95: [] as number[],
  };
  return {
    async tail() {
      if (!res.apiLogGroup) return;
      const { events } = await aws<{
        events: { eventId: string; timestamp: number; message: string }[];
      }>([
        'logs',
        'filter-log-events',
        '--log-group-name',
        res.apiLogGroup,
        '--start-time',
        String(cursor),
        '--filter-pattern',
        '"\\"event\\":\\"request\\""',
        '--max-items',
        '2000',
      ]);
      for (const e of events ?? []) {
        if (seen.has(e.eventId)) continue;
        seen.add(e.eventId);
        cursor = Math.max(cursor, e.timestamp);
        try {
          const line = JSON.parse(e.message.slice(e.message.indexOf('{')));
          recent.push({
            t: e.timestamp,
            id: String(line.requestId ?? ''),
            method: String(line.method),
            route: String(line.route),
            status: Number(line.status),
            ms: Number(line.ms),
          });
        } catch {
          // Not an access log line.
        }
      }
      recent.sort((a, b) => b.t - a.t);
      recent.length = Math.min(recent.length, 100_000);
      if (seen.size > 20_000) seen.clear();
    },
    async metrics() {
      const from = Math.floor(Date.now() / 60_000) * 60_000 - (MINUTES - 1) * 60_000;
      const m = metricBatch();
      const api = { ApiId: res.apiId };
      const ids = {
        count: m.add('AWS/ApiGateway', 'Count', 'Sum', api, 60),
        e4: m.add('AWS/ApiGateway', '4xx', 'Sum', api, 60),
        e5: m.add('AWS/ApiGateway', '5xx', 'Sum', api, 60),
        p95: m.add('AWS/ApiGateway', 'Latency', 'p95', api, 60),
      };
      await m.fetch({ 60: [from, from + MINUTES * 60_000] });
      const series = (id: string) => m.series(id, from, 60_000, MINUTES);
      minutes = {
        start: new Date(from).toISOString(),
        count: series(ids.count),
        e4: series(ids.e4),
        e5: series(ids.e5),
        p95: series(ids.p95),
      };
    },
    state: () => ({ at: new Date().toISOString(), minutes, requests: recent.slice(0, 60) }),
    // Newest first, so everything at or after `since` is a prefix.
    since(since: number) {
      const end = recent.findIndex((r) => r.t < since);
      return end < 0 ? recent : recent.slice(0, end);
    },
  };
}

// ---- session: usage since a page was opened -----------------------------------
function sessionMetrics(res: Resources) {
  let dims: Promise<{ gsis: string[]; ops: string[] }> | null = null;
  const cache = new Map<number, { at: number; value: Promise<unknown> }>();
  async function load(since: number) {
    const t = { TableName: res.table };
    dims ??= Promise.all([
      listDims('AWS/DynamoDB', 'ConsumedReadCapacityUnits', t, 'GlobalSecondaryIndexName'),
      listDims('AWS/DynamoDB', 'SuccessfulRequestLatency', t, 'Operation'),
    ]).then(([gsis, ops]) => ({ gsis, ops: ops.sort() }));
    const { gsis, ops } = await dims;
    // Whole minutes after the page opened, so nothing from before it is counted.
    const from = Math.ceil(since / 60_000) * 60_000;
    const length = Math.max(0, Math.floor((Date.now() - from) / 60_000) + 1);
    if (!length)
      return {
        start: new Date(from).toISOString(),
        fn: [],
        ddb: { rcu: [], wcu: [], ops: [] },
        gateway: 0,
      };
    const m = metricBatch();
    const scopes = [t, ...gsis.map((g) => ({ ...t, GlobalSecondaryIndexName: g }))];
    const ids = {
      gateway: m.add('AWS/ApiGateway', 'Count', 'Sum', { ApiId: res.apiId }, 60),
      fn: res.functions.map((f) => {
        const d = { FunctionName: f.name };
        return {
          inv: m.add('AWS/Lambda', 'Invocations', 'Sum', d, 60),
          err: m.add('AWS/Lambda', 'Errors', 'Sum', d, 60),
          thr: m.add('AWS/Lambda', 'Throttles', 'Sum', d, 60),
          dur: m.add('AWS/Lambda', 'Duration', 'Sum', d, 60),
        };
      }),
      rcu: scopes.map((sc) => m.add('AWS/DynamoDB', 'ConsumedReadCapacityUnits', 'Sum', sc, 60)),
      wcu: scopes.map((sc) => m.add('AWS/DynamoDB', 'ConsumedWriteCapacityUnits', 'Sum', sc, 60)),
      ops: ops.map((op) =>
        m.add(
          'AWS/DynamoDB',
          'SuccessfulRequestLatency',
          'SampleCount',
          { ...t, Operation: op },
          60,
        ),
      ),
    };
    await m.fetch({ 60: [from, from + length * 60_000] });
    const series = (id: string) => m.series(id, from, 60_000, length);
    const total = (id: string) => sum(series(id));
    const stack = (list: string[]) =>
      list.map(series).reduce(
        (acc, v) => acc.map((x, i) => x + v[i]!),
        Array.from({ length }, () => 0),
      );
    return {
      start: new Date(from).toISOString(),
      gateway: total(ids.gateway),
      fn: res.functions.map((f, i) => ({
        key: f.key,
        memoryMb: f.memoryMb,
        invocations: total(ids.fn[i]!.inv),
        errors: total(ids.fn[i]!.err),
        throttles: total(ids.fn[i]!.thr),
        durationMs: total(ids.fn[i]!.dur),
      })),
      ddb: {
        rcu: stack(ids.rcu),
        wcu: stack(ids.wcu),
        ops: ops.map((op, i) => ({ op, count: total(ids.ops[i]!) })),
      },
    };
  }
  return (since: number) => {
    const hit = cache.get(since);
    if (hit && Date.now() - hit.at < 20_000) return hit.value;
    if (cache.size > 50) cache.clear();
    const value = attempt('session metrics', () => load(since) as Promise<unknown>, null);
    cache.set(since, { at: Date.now(), value });
    return value;
  };
}
const csvCell = (v: string | number) =>
  /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

// ---- entry ------------------------------------------------------------------
const resources = await discover();
if (!serve) {
  console.log(`Collecting ${windowDays} days of metrics for ${resources.apiId} …`);
  const data = await collect(resources);
  const page = embed(data);
  mkdirSync('.cloud', { recursive: true });
  // The fragment is what gets published as an artifact; the standalone file opens locally.
  writeFileSync('.cloud/ops-dashboard.fragment.html', page);
  writeFileSync('.cloud/ops-dashboard.html', standalone(page));
  console.log(`${summary(data)} → .cloud/ops-dashboard.html`);
} else {
  let snapshot: Snapshot | null = null;
  const live = liveFeed(resources);
  const session = sessionMetrics(resources);
  // Storage at the moment each page opened, so /current can show the change since then.
  const r2Baselines = new Map<number, Awaited<ReturnType<typeof r2Usage>>>();
  const sessionR2 = async (since: number) => {
    const [now, ops] = await Promise.all([r2Usage(), r2Operations(since, Date.now())]);
    if (!r2Baselines.has(since)) {
      if (r2Baselines.size > 50) r2Baselines.clear();
      r2Baselines.set(since, now);
    }
    return { now, base: r2Baselines.get(since) ?? null, ops, prices: R2 };
  };
  const every = (ms: number, label: string, run: () => Promise<void>) => {
    const tick = async () => {
      await attempt(label, run, undefined);
      setTimeout(tick, ms);
    };
    void tick();
  };
  every(10 * 60_000, 'snapshot', async () => {
    snapshot = await collect(resources);
    console.log(`${new Date().toLocaleTimeString()} ${summary(snapshot)}`);
  });
  every(30_000, 'minute metrics', live.metrics);
  every(5_000, 'request log', live.tail);

  createServer((req, response) => {
    const send = (type: string, body: string) => {
      response.writeHead(200, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
      });
      response.end(body);
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const since = Number(url.searchParams.get('since')) || 0;
    if (path === '/' || path === '/current') send('text/html', standalone(embed(snapshot)));
    else if (path === '/session.json')
      void session(since).then(async (metrics) =>
        send(
          'application/json',
          JSON.stringify({
            at: Date.now(),
            metrics,
            rates: snapshot?.rates ?? null,
            list: LIST,
            cloudflare: await sessionR2(since),
            requests: live.since(since),
          }),
        ),
      );
    else if (path === '/export.csv') {
      const rows = live
        .since(since)
        .map((r) =>
          [new Date(r.t).toISOString(), r.method, r.route, r.status, r.ms, r.id]
            .map(csvCell)
            .join(','),
        );
      response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="harbor0-requests-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.csv"`,
        'Cache-Control': 'no-store',
      });
      response.end(
        ['time,method,route,status,duration_ms,request_id', ...rows.reverse()].join('\n') + '\n',
      );
    } else if (path === '/data.json') send('application/json', JSON.stringify(snapshot));
    else if (path === '/live.json') send('application/json', JSON.stringify(live.state()));
    else {
      response.writeHead(404);
      response.end();
    }
  }).listen(port, '127.0.0.1', () => console.log(`Live dashboard on http://127.0.0.1:${port}`));
}
