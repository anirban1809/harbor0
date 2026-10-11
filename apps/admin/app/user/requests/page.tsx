'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import {
  adminActivityOrigins,
  ADMIN_REQUEST_PAGE,
  type AdminActivityOrigin,
  type AdminActivityRange,
} from '../../../../../packages/contracts/src/admin';
import { Alert } from '../../../../web/components/ui/alert';
import { Badge } from '../../../../web/components/ui/badge';
import { Button } from '../../../../web/components/ui/button';
import { Card } from '../../../../web/components/ui/card';
import { Checkbox } from '../../../../web/components/ui/checkbox';
import { DataTable } from '../../../../web/components/ui/table';
import { Skeleton } from '../../../../web/components/ui/skeleton';
import { Tab, TabList, TabPanel, Tabs } from '../../../../web/components/ui/tabs';
import {
  deviceLabel,
  isRange,
  RangeSelect,
  rangeNames,
  Route,
  statusTone,
} from '../../../components/activity-parts';
import { PageHeader, Shell } from '../../../components/shell';
import { api } from '../../../lib/api';
import { date } from '../../../lib/format';

const originNames: Record<AdminActivityOrigin, string> = {
  manual: 'Manual actions',
  automated: 'Automatic',
  all: 'All requests',
};
const originHints: Record<AdminActivityOrigin, string> = {
  manual: 'Requests a person made: browsing, uploads, renames, settings.',
  automated:
    'Requests the apps make by themselves: polling, session upkeep, and desktop and mobile sync and backups. Judged by route and platform, so a desktop rename made in Finder or Explorer counts here.',
  all: 'Every request, newest first.',
};
const isOrigin = (value: string | null): value is AdminActivityOrigin =>
  (adminActivityOrigins as readonly string[]).includes(value ?? '');

/** One account's API requests, a page at a time, split by who made them. */
function RequestLog({ id }: { id: string }) {
  const params = useSearchParams();
  const initialRange = params.get('range');
  const initialOrigin = params.get('origin');
  const [range, setRange] = useState<AdminActivityRange>(
    isRange(initialRange) ? initialRange : '24h',
  );
  const [origin, setOrigin] = useState<AdminActivityOrigin>(
    isOrigin(initialOrigin) ? initialOrigin : 'manual',
  );
  const [failed, setFailed] = useState(false);
  // The cursor of every page opened so far, so "Newer" can step back.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length;
  const restart = () => setCursors([undefined]);

  const detail = useQuery({ queryKey: ['user', id], queryFn: () => api.user(id) });
  const summary = useQuery({
    queryKey: ['user-activity', id, range],
    queryFn: () => api.activity(id, range),
    staleTime: 60_000,
    retry: false,
  });
  const log = useQuery({
    queryKey: ['request-log', id, range, origin, failed, cursors.at(-1)],
    queryFn: () => api.requestLog(id, { range, origin, failed, cursor: cursors.at(-1) }),
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const device = deviceLabel(detail.data?.devices ?? []);
  const counts = summary.data && {
    manual: summary.data.totals.manual,
    automated: summary.data.totals.automated,
    all: summary.data.totals.requests,
  };
  const email = detail.data?.account.email;

  return (
    <>
      <Link href={`/user?id=${encodeURIComponent(id)}`} className="admin-back">
        <ArrowLeft aria-hidden="true" />
        {email ?? 'Account'}
      </Link>
      <PageHeader
        title="Request log"
        description={`Every API request ${email ?? 'this account'} made, newest first. From the API request log, kept 30 days; accounts are named from 11 Oct 2026.`}
      />
      <Card
        action={
          <div className="admin-activity-controls">
            <RangeSelect
              value={range}
              onChange={(r) => {
                setRange(r);
                restart();
              }}
            />
            <label className="admin-checkbox">
              <Checkbox
                checked={failed}
                onChange={(e) => {
                  setFailed(e.target.checked);
                  restart();
                }}
              />
              Failed only
            </label>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Refresh"
              disabled={log.isFetching}
              onClick={() => {
                restart();
                void summary.refetch();
                void log.refetch();
              }}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
        }
      >
        <Tabs
          value={origin}
          onValueChange={(next) => {
            setOrigin(next);
            restart();
          }}
        >
          <TabList aria-label="Who made the requests">
            {adminActivityOrigins.map((o) => (
              <Tab key={o} value={o}>
                {originNames[o]}
                {counts && !failed && (
                  <span className="admin-muted">{counts[o].toLocaleString()}</span>
                )}
              </Tab>
            ))}
          </TabList>
          <TabPanel value={origin} className="admin-request-log">
            <p className="admin-muted">{originHints[origin]}</p>
            {log.error ? (
              <Alert tone="error">{log.error.message}</Alert>
            ) : !log.data ? (
              <Skeleton style={{ height: 240 }} />
            ) : log.data.requests.length ? (
              <DataTable label={`${originNames[origin]}, page ${page}`}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Request</th>
                    <th>Status</th>
                    <th>Device</th>
                    <th>Took</th>
                  </tr>
                </thead>
                <tbody aria-busy={log.isFetching}>
                  {log.data.requests.map((r) => (
                    <tr key={r.requestId || r.at}>
                      <td className="admin-nowrap" title={r.at}>
                        {date(r.at)}
                      </td>
                      <td className="admin-activity-route" title={`Request ID ${r.requestId}`}>
                        <Route method={r.method} route={r.route} />
                        {(r.code || (origin === 'all' && r.automated)) && (
                          <div className="admin-muted">
                            {[r.code, origin === 'all' && r.automated ? 'Automatic' : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                      </td>
                      <td>{device(r.deviceId, r.platform, r.appVersion)}</td>
                      <td className="admin-nowrap">{r.ms == null ? '—' : `${r.ms} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : (
              <p className="admin-empty">
                No {failed ? 'failed ' : ''}
                {origin === 'all' ? 'requests' : originNames[origin].toLowerCase()} in the{' '}
                {rangeNames[range].toLowerCase()}.
              </p>
            )}
            {log.data && (page > 1 || log.data.nextCursor) && (
              <div className="admin-pager">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 1 || log.isFetching}
                  onClick={() => setCursors((c) => c.slice(0, -1))}
                >
                  Newer
                </Button>
                <span className="admin-muted">
                  Page {page} · {ADMIN_REQUEST_PAGE} per page
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!log.data.nextCursor || log.isFetching}
                  onClick={() => setCursors((c) => [...c, log.data!.nextCursor!])}
                >
                  Older
                </Button>
              </div>
            )}
          </TabPanel>
        </Tabs>
      </Card>
    </>
  );
}

function RequestLogPage() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="admin-empty">No account selected.</p>;
  return <RequestLog key={id} id={id} />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <RequestLogPage />
      </Suspense>
    </Shell>
  );
}
