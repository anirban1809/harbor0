import { Card } from '../../web/components/ui/card';
import { Skeleton } from '../../web/components/ui/skeleton';
import { DataTable } from '../../web/components/ui/table';
import type { PlatformCosts } from '../../../packages/contracts/src/admin';
import { bytes, date, day, relative, usd } from '../lib/format';
import { Stat } from './storage-totals';

/** What harbor0 has cost to run so far: the AWS bill plus R2 storage, refreshed daily. */
export function RunningCostsCard({
  costs,
  pending,
}: {
  costs: PlatformCosts | null;
  pending: boolean;
}) {
  const days = costs?.daily.length ?? 0;
  return (
    <Card
      title={costs ? `Running costs since ${day(costs.since)}` : 'Running costs'}
      description={
        costs ? (
          <span title={date(costs.computedAt)}>
            Through {day(costs.through)} (UTC) · updated {relative(costs.computedAt)}, daily at
            06:00 IST
          </span>
        ) : (
          'Updated daily at 06:00 IST.'
        )
      }
    >
      {pending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : !costs ? (
        <p className="admin-empty">The first figures arrive after the next 06:00 IST refresh.</p>
      ) : (
        <>
          <div className="admin-stats">
            <Stat label="Total" value={usd(costs.totalUsd)} hint={`Over ${days} days`} />
            <Stat label="AWS" value={usd(costs.aws.totalUsd)} hint="From Cost Explorer" />
            <Stat
              label="Cloudflare R2"
              value={usd(costs.r2.totalUsd)}
              hint={`Storage at $${costs.r2.rate}/GB-month · ${bytes(costs.r2.storedBytes)} stored now`}
            />
            <Stat
              label="Average per day"
              value={usd(days ? costs.totalUsd / days : 0)}
              hint={`About ${usd(days ? (costs.totalUsd / days) * 30 : 0)} a month`}
            />
          </div>
          <DataTable label="Cost by service">
            <thead>
              <tr>
                <th>Service</th>
                <th className="admin-number">Cost</th>
                <th className="admin-number">Share</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...costs.aws.services,
                { service: 'Cloudflare R2 storage', usd: costs.r2.totalUsd },
              ]
                .sort((a, b) => b.usd - a.usd)
                .map((s) => (
                  <tr key={s.service}>
                    <td>{s.service}</td>
                    <td className="admin-number">{usd(s.usd)}</td>
                    <td className="admin-number admin-muted">
                      {costs.totalUsd ? `${Math.round((s.usd / costs.totalUsd) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </DataTable>
          <p className="admin-muted admin-totals-note">
            AWS is the whole account&apos;s bill before credits, refunds and tax; the latest day
            can still rise as AWS finalises it. R2 is storage only at the standard rate with no
            free tier; operations are not counted.
            {costs.r2.reconstructedDays > 0 &&
              ` ${costs.r2.reconstructedDays} early day${costs.r2.reconstructedDays === 1 ? ' is' : 's are'} priced from the files still stored, so slightly low.`}
          </p>
        </>
      )}
    </Card>
  );
}
