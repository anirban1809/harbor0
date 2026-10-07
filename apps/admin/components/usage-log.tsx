'use client';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { FlagUsage } from '../../../packages/contracts/src/flags';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { DataTable } from '../../web/components/ui/table';
import { Skeleton } from '../../web/components/ui/skeleton';
import { api } from '../lib/api';
import { date, relative } from '../lib/format';

const values: Record<string, string> = {
  TOTP: 'Authenticator app',
  EMAIL: 'Email codes',
  WEB: 'Web',
  MACOS: 'macOS',
  WINDOWS: 'Windows',
  LINUX: 'Linux',
  IOS: 'iOS',
  ANDROID: 'Android',
};
const names: Record<string, string> = { replaced: 'Replaced' };
const show = (value: unknown) => values[String(value)] ?? String(value);

/** The event's details in a line, e.g. "Email codes · Web · Replaced: Authenticator app". */
function details(entry: FlagUsage) {
  return Object.entries(entry.details)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => (names[k] ? `${names[k]}: ${show(v)}` : show(v)))
    .join(' · ');
}

/** Who used a flagged feature and how, newest first; entries are kept for 180 days. */
export function UsageLog({ flagKey }: { flagKey: string }) {
  const log = useInfiniteQuery({
    queryKey: ['flag-usage', flagKey],
    queryFn: ({ pageParam }) => api.flagUsage(flagKey, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const accounts = new Set(items.map((e) => e.userId ?? e.email).filter(Boolean)).size;
  return (
    <Card
      title="Usage logs"
      description={
        items.length
          ? `What accounts did with this feature, newest first. Showing ${items.length} event${items.length === 1 ? '' : 's'} from ${accounts} account${accounts === 1 ? '' : 's'}; entries are kept for 180 days.`
          : 'What accounts did with this feature, newest first. Entries are kept for 180 days.'
      }
    >
      {log.isPending ? (
        <Skeleton className="admin-skeleton-block" />
      ) : log.error ? (
        <p className="admin-empty">{log.error.message}</p>
      ) : !items.length ? (
        <p className="admin-empty">No one has used this feature yet.</p>
      ) : (
        <DataTable label="Usage logs">
          <thead>
            <tr>
              <th>Event</th>
              <th>Account</th>
              <th>Details</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id} data-event={entry.event}>
                <td>{entry.label}</td>
                <td>
                  {entry.userId ? (
                    <Link href={`/user?id=${encodeURIComponent(entry.userId)}`}>
                      {entry.email ?? entry.userId}
                    </Link>
                  ) : (
                    (entry.email ?? '—')
                  )}
                </td>
                <td className="admin-muted">{details(entry) || '—'}</td>
                <td className="admin-nowrap">
                  <time dateTime={entry.at} title={date(entry.at)}>
                    {relative(entry.at)}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {log.hasNextPage && (
        <div className="admin-more">
          <Button
            variant="outline"
            onClick={() => log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
          >
            Load older entries
          </Button>
        </div>
      )}
    </Card>
  );
}
