import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../src/repository';
import { computeCosts, platformCosts, refreshCostsIfDue, type CostSources } from '../src/platform-costs';

const at = (iso: string) => Date.parse(iso);
const GB = 1e9;

function sources(overrides: Partial<CostSources> = {}): CostSources {
  return {
    aws: async () => [
      { date: '2026-10-04', service: 'Amazon DynamoDB', usd: 0.5 },
      { date: '2026-10-04', service: 'AWS Lambda', usd: 0.001 },
      { date: '2026-10-05', service: 'Amazon DynamoDB', usd: 1 },
      { date: '2026-10-05', service: 'Amazon API Gateway', usd: 0.25 },
    ],
    // 31 GB written before 4 Oct, 31 GB more on 5 Oct.
    objects: async () => [
      { size: 31 * GB, modifiedAt: '2026-10-01T00:00:00.000Z' },
      { size: 31 * GB, modifiedAt: '2026-10-05T12:00:00.000Z' },
    ],
    ...overrides,
  };
}

describe('platform costs', () => {
  it('adds the AWS bill to R2 storage priced per day', async () => {
    const costs = await computeCosts(sources(), {}, at('2026-10-06T00:30:00Z'));
    expect(costs.through).toBe('2026-10-05');
    expect(costs.daily.map((d) => d.date)).toEqual(['2026-10-04', '2026-10-05']);
    // October has 31 days: 31 GB for a day is $0.015, 62 GB is $0.03.
    expect(costs.daily[0].r2Usd).toBeCloseTo(0.015);
    expect(costs.daily[1].r2Usd).toBeCloseTo(0.03);
    expect(costs.r2).toMatchObject({ storedBytes: 62 * GB, reconstructedDays: 1 });
    expect(costs.aws.totalUsd).toBeCloseTo(1.751);
    expect(costs.totalUsd).toBeCloseTo(1.751 + 0.045);
    // Under half a cent is left out of the service list but kept in the total.
    expect(costs.aws.services.map((s) => s.service)).toEqual([
      'Amazon DynamoDB',
      'Amazon API Gateway',
    ]);
    expect(costs.measured).toEqual({ '2026-10-05': 62 * GB });
  });

  it('prices measured days from the measurement, not from what is left in the bucket', async () => {
    const costs = await computeCosts(
      sources(),
      { '2026-10-04': 93 * GB },
      at('2026-10-06T00:30:00Z'),
    );
    expect(costs.daily[0].r2Usd).toBeCloseTo(0.045);
    expect(costs.r2.reconstructedDays).toBe(0);
  });

  it('refreshes once a day after 06:00 IST and retries a failure after 15 minutes', async () => {
    const repo = new MemoryRepository();
    const aws = vi.fn(sources().aws);
    const s = sources({ aws });
    expect(await refreshCostsIfDue(repo, s, at('2026-10-06T00:29:00Z'))).toBe(false);
    expect(await platformCosts(repo)).toBeNull();
    expect(await refreshCostsIfDue(repo, s, at('2026-10-06T00:31:00Z'))).toBe(true);
    expect(await refreshCostsIfDue(repo, s, at('2026-10-06T12:00:00Z'))).toBe(false);
    expect(aws).toHaveBeenCalledTimes(1);
    const first = await platformCosts(repo);
    expect(first).toMatchObject({ through: '2026-10-05' });
    expect(first).not.toHaveProperty('measured');

    aws.mockRejectedValueOnce(new Error('Throttled'));
    expect(await refreshCostsIfDue(repo, s, at('2026-10-07T00:31:00Z'))).toBe(false);
    // The previous day's figures stay up while the refresh is retried.
    expect(await platformCosts(repo)).toEqual(first);
    expect(await refreshCostsIfDue(repo, s, at('2026-10-07T00:40:00Z'))).toBe(false);
    expect(await refreshCostsIfDue(repo, s, at('2026-10-07T00:47:00Z'))).toBe(true);
    const second = await computeCosts(s, {}, at('2026-10-07T00:47:00Z'));
    const stored = await platformCosts(repo);
    expect(stored?.through).toBe('2026-10-06');
    // 5 Oct was measured at the first refresh, so only 4 Oct is reconstructed.
    expect(stored?.r2.reconstructedDays).toBe(1);
    expect(second.r2.reconstructedDays).toBe(2);
  });
});
