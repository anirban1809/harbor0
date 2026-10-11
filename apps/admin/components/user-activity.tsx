'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type {
  AdminActivityOrigin,
  AdminActivityRange,
  AdminUserDetail,
} from '../../../packages/contracts/src/admin';
import { Alert } from '../../web/components/ui/alert';
import { Badge } from '../../web/components/ui/badge';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { DataTable } from '../../web/components/ui/table';
import { Skeleton } from '../../web/components/ui/skeleton';
import { api } from '../lib/api';
import { bytes, date, relative } from '../lib/format';
import {
  deviceLabel,
  kindNames,
  RangeSelect,
  Route,
  stageNames,
  statusTone,
} from './activity-parts';
import { Stat } from './storage-totals';

/** Where the request log page opens for this account. */
export const requestLogHref = (
  userId: string,
  range: AdminActivityRange,
  origin: AdminActivityOrigin = 'manual',
) => `/user/requests?id=${encodeURIComponent(userId)}&range=${range}&origin=${origin}`;
/** Where the usage page opens for this account. */
export const usageHref = (userId: string, range: AdminActivityRange) =>
  `/user/usage?id=${encodeURIComponent(userId)}&range=${range}`;

/**
 * The account's activity from the request log: how many requests it made and by whom, which
 * failed, and the problems its apps reported. Each request is on the request log page.
 */
export function UserActivity({
  userId,
  devices,
}: {
  userId: string;
  devices: AdminUserDetail['devices'];
}) {
  const [range, setRange] = useState<AdminActivityRange>('24h');
  const activity = useQuery({
    queryKey: ['user-activity', userId, range],
    queryFn: () => api.activity(userId, range),
    staleTime: 60_000,
    retry: false,
  });
  const device = deviceLabel(devices);
  const data = activity.data;
  return (
    <Card
      title="API activity"
      description="Requests this account's apps made and problems they reported, from the API request log (kept 30 days; accounts are named from 11 Oct 2026)."
      action={
        <div className="admin-activity-controls">
          <RangeSelect value={range} onChange={setRange} />
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh"
            disabled={activity.isFetching}
            onClick={() => activity.refetch()}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      }
    >
      {activity.error ? (
        <Alert tone="error">{activity.error.message}</Alert>
      ) : !data ? (
        <Skeleton style={{ height: 120 }} />
      ) : (
        <div className="admin-activity">
          <div className="admin-stats">
            <Stat
              label="Manual actions"
              value={
                <Link href={requestLogHref(userId, range, 'manual')}>
                  {data.totals.manual.toLocaleString()}
                </Link>
              }
              hint="Requests a person made"
            />
            <Stat
              label="Automatic"
              value={
                <Link href={requestLogHref(userId, range, 'automated')}>
                  {data.totals.automated.toLocaleString()}
                </Link>
              }
              hint="Polling, sync and backups"
            />
            <Stat
              label="Server errors"
              value={data.totals.serverErrors.toLocaleString()}
              hint="5xx: our fault"
            />
            <Stat
              label="Other failures"
              value={(
                data.totals.failed -
                data.totals.serverErrors -
                data.totals.unauthorized
              ).toLocaleString()}
              hint="Refused (4xx), not 401"
            />
            <Stat
              label="Sign-in refused"
              value={data.totals.unauthorized.toLocaleString()}
              hint="401: mostly expired sessions"
            />
            <Stat
              label="Uploads failed"
              value={data.totals.appFailures.toLocaleString()}
              hint="Reported by the apps"
            />
            <Stat
              label="Storage retries"
              value={data.totals.appRetries.toLocaleString()}
              hint="Upload parts the apps retried"
            />
          </div>

          {data.appProblems.length > 0 && (
            <DataTable label="Problems the apps reported">
              <thead>
                <tr>
                  <th>App reported</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th>Count</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {data.appProblems.map((p) => (
                  <tr key={`${p.kind} ${p.stage} ${p.code} ${p.httpStatus}`}>
                    <td>
                      {kindNames[p.kind] ?? p.kind}
                      <div className="admin-muted">{stageNames[p.stage] ?? p.stage}</div>
                    </td>
                    <td>
                      {p.httpStatus == null ? (
                        '—'
                      ) : (
                        <Badge tone={p.httpStatus ? statusTone(p.httpStatus) : 'warning'}>
                          {p.httpStatus || 'No response'}
                        </Badge>
                      )}
                    </td>
                    <td className="admin-activity-route">{p.code ?? '—'}</td>
                    <td>{p.count.toLocaleString()}</td>
                    <td className="admin-nowrap" title={date(p.lastAt)}>
                      {relative(p.lastAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}

          {data.appEvents.length > 0 && (
            <DataTable label="Latest problems the apps reported">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Problem</th>
                  <th>Upload</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                {data.appEvents.map((e, i) => (
                  <tr key={`${e.at} ${i}`}>
                    <td className="admin-nowrap" title={e.at}>
                      {date(e.at)}
                    </td>
                    <td>
                      {kindNames[e.kind] ?? e.kind} · {stageNames[e.stage] ?? e.stage}
                      <div className="admin-muted">
                        {[
                          e.code,
                          e.httpStatus == null ? null : `HTTP ${e.httpStatus || 'none'}`,
                          e.online === false ? 'offline' : null,
                          e.message,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td className="admin-nowrap">
                      {e.sizeBytes == null ? '—' : bytes(e.sizeBytes)}
                      {e.partNumber != null && (
                        <div className="admin-muted">
                          Part {e.partNumber}
                          {e.attempt != null && `, try ${e.attempt + 1}`}
                        </div>
                      )}
                    </td>
                    <td>{device(e.deviceId, e.platform, e.appVersion)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}

          {data.problems.length > 0 && (
            <DataTable label="Failed requests by route">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th>Count</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {data.problems.map((p) => (
                  <tr key={`${p.method} ${p.route} ${p.status} ${p.code} ${p.automated}`}>
                    <td className="admin-activity-route">
                      <Route method={p.method} route={p.route} />
                      {p.automated && <div className="admin-muted">Automatic</div>}
                    </td>
                    <td>
                      <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                    </td>
                    <td className="admin-activity-route">{p.code ?? '—'}</td>
                    <td>{p.count.toLocaleString()}</td>
                    <td className="admin-nowrap" title={date(p.lastAt)}>
                      {relative(p.lastAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}

          <div className="admin-activity-links">
            <Link className="admin-activity-link" href={usageHref(userId, range)}>
              Open usage: uploads, downloads, sync and backups
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
            <Link className="admin-activity-link" href={requestLogHref(userId, range)}>
              Open the request log
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}
    </Card>
  );
}
