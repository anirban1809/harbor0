import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { platformCostsSchema, type PlatformCosts } from '../../../packages/contracts/src/admin';
import { transact, type Repository } from './repository';
import type { StoredObject } from './storage';

/** The day harbor0's running costs are counted from. */
export const COSTS_SINCE = '2026-10-04';
/** Cloudflare's standard R2 storage rate, USD per decimal GB-month, before the free tier. */
export const R2_STORAGE_RATE = 0.015;
const KEY = { pk: 'ADMIN_STATS', sk: 'COSTS' };
const DAY_MS = 86400_000;
// 00:30 UTC is 06:00 IST.
const REFRESH_AFTER_MS = 30 * 60_000;
const RETRY_MS = 15 * 60_000;

type Stored = PlatformCosts & {
    /** Bucket bytes measured at each refresh, by the UTC day that had just ended. */
    measured: Record<string, number>;
};
type Attempt = { attemptedAt: string; failedFor: string; error: string };
export type CostSources = {
    /** AWS cost per UTC day and service for [start, end), before credits, refunds and tax. */
    aws(start: string, end: string): Promise<{ date: string; service: string; usd: number }[]>;
    objects(): Promise<StoredObject[]>;
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysInMonth = (day: string) => {
    const [y, m] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Cost Explorer reads for the whole AWS account; each call costs $0.01. */
export function costExplorerSource(): CostSources['aws'] {
    const client = new CostExplorerClient({ region: 'us-east-1' });
    return async (start, end) => {
        const out: { date: string; service: string; usd: number }[] = [];
        let token: string | undefined;
        do {
            const page = await client.send(
                new GetCostAndUsageCommand({
                    TimePeriod: { Start: start, End: end },
                    Granularity: 'DAILY',
                    Metrics: ['UnblendedCost'],
                    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
                    Filter: {
                        Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund', 'Tax'] } },
                    },
                    NextPageToken: token,
                }),
            );
            for (const day of page.ResultsByTime ?? [])
                for (const group of day.Groups ?? [])
                    out.push({
                        date: day.TimePeriod!.Start!,
                        service: group.Keys?.[0] ?? 'Other',
                        usd: Number(group.Metrics?.UnblendedCost?.Amount ?? 0),
                    });
            token = page.NextPageToken;
        } while (token);
        return out;
    };
}

/** The costs as last refreshed, or null before the first refresh. */
export async function platformCosts(repo: Repository): Promise<PlatformCosts | null> {
    const row = await repo.get(KEY);
    const data = row?.data as Partial<Stored> | undefined;
    // Parsing drops the measurements and any failed attempt's details.
    return data?.computedAt ? platformCostsSchema.parse(data) : null;
}

/**
 * Works out the costs from `COSTS_SINCE` through the UTC day before `now`. Each day's R2 storage
 * is the bucket size measured when that day ended, or for days before measuring began, the size
 * of objects already written by then (files deleted since are missed).
 */
export async function computeCosts(
    sources: CostSources,
    measuredBefore: Record<string, number>,
    now = Date.now(),
): Promise<Stored> {
    const today = isoDay(now);
    const through = isoDay(now - DAY_MS);
    const [aws, objects] = await Promise.all([sources.aws(COSTS_SINCE, today), sources.objects()]);
    const storedBytes = objects.reduce((sum, o) => sum + o.size, 0);
    const measured = { ...measuredBefore, [through]: storedBytes };
    const services = new Map<string, number>();
    const awsByDay = new Map<string, number>();
    for (const row of aws) {
        services.set(row.service, (services.get(row.service) ?? 0) + row.usd);
        awsByDay.set(row.date, (awsByDay.get(row.date) ?? 0) + row.usd);
    }
    const daily: PlatformCosts['daily'] = [];
    let reconstructedDays = 0;
    for (let at = Date.parse(COSTS_SINCE); at < Date.parse(today); at += DAY_MS) {
        const date = isoDay(at);
        const end = new Date(at + DAY_MS).toISOString();
        let bytes = measured[date];
        if (bytes === undefined) {
            reconstructedDays++;
            bytes = objects.reduce((sum, o) => (o.modifiedAt < end ? sum + o.size : sum), 0);
        }
        const r2Usd = (bytes / 1e9) * (R2_STORAGE_RATE / daysInMonth(date));
        daily.push({ date, awsUsd: awsByDay.get(date) ?? 0, r2Usd });
    }
    const awsUsd = daily.reduce((sum, d) => sum + d.awsUsd, 0);
    const r2Usd = daily.reduce((sum, d) => sum + d.r2Usd, 0);
    return {
        computedAt: new Date(now).toISOString(),
        since: COSTS_SINCE,
        through,
        totalUsd: awsUsd + r2Usd,
        aws: {
            totalUsd: awsUsd,
            services: [...services]
                .map(([service, usd]) => ({ service, usd }))
                .filter((s) => s.usd >= 0.005)
                .sort((a, b) => b.usd - a.usd),
        },
        r2: { totalUsd: r2Usd, rate: R2_STORAGE_RATE, storedBytes, reconstructedDays },
        daily,
        measured,
    };
}

/**
 * Refreshes the costs once a day after 06:00 IST. The maintenance worker calls this every
 * minute; between refreshes it costs one read. A failed refresh is retried every 15 minutes.
 */
export async function refreshCostsIfDue(repo: Repository, sources: CostSources, now = Date.now()) {
    const today = isoDay(now);
    if (now - Date.parse(today) < REFRESH_AFTER_MS) return false;
    const row = await repo.get(KEY);
    const data = (row?.data ?? {}) as Partial<Stored> & Partial<Attempt>;
    if (data.computedAt && data.computedAt.slice(0, 10) === today) return false;
    if (data.failedFor === today && now - Date.parse(data.attemptedAt!) < RETRY_MS) return false;
    let next: Stored | (Partial<Stored> & Attempt);
    let refreshed = false;
    try {
        next = await computeCosts(sources, data.measured ?? {}, now);
        refreshed = true;
    } catch (error) {
        console.error('Platform cost refresh failed', error);
        next = {
            ...data,
            attemptedAt: new Date(now).toISOString(),
            failedFor: today,
            error: (error as Error).message,
        };
    }
    // Two workers can race; either result is the same day's figures.
    await transact(repo, async (tx) => {
        await tx.put(KEY.pk, KEY.sk, next);
    }).catch(() => undefined);
    return refreshed;
}
