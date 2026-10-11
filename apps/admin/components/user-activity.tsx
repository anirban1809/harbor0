'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  adminActivityRanges,
  type AdminActivityRange,
  type AdminUserDetail,
} from '../../../packages/contracts/src/admin';
import { Alert } from '../../web/components/ui/alert';
import { Badge, type BadgeTone } from '../../web/components/ui/badge';
import { Button } from '../../web/components/ui/button';
import { Card } from '../../web/components/ui/card';
import { Checkbox } from '../../web/components/ui/checkbox';
import { Select } from '../../web/components/ui/select';
import { DataTable } from '../../web/components/ui/table';
import { Skeleton } from '../../web/components/ui/skeleton';
import { api } from '../lib/api';
import { date, relative } from '../lib/format';
import { Stat } from './storage-totals';

const rangeNames: Record<AdminActivityRange, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
/** A route that wraps only after its slashes, e.g. "/v1/uploads/" then ":id/complete". */
const Route = ({ method, route }: { method: string; route: string }) => (
  <>
    {method}{' '}
    {route.split('/').map((part, i) => (
      <span key={i}>
        {i > 0 && '/'}
        {i > 0 && <wbr />}
        {part}
      </span>
    ))}
  </>
);
const tone = (status: number): BadgeTone =>
  status >= 500 ? 'danger' : status === 401 ? 'neutral' : status >= 400 ? 'warning' : 'success';

/**
 * The account's API requests from the request log: how many failed, which routes and errors,
 * and the latest requests with the device that made them.
 */
export function UserActivity({
  userId,
  devices,
}: {
  userId: string;
  devices: AdminUserDetail['devices'];
}) {
  const [range, setRange] = useState<AdminActivityRange>('24h');
  const [failed, setFailed] = useState(false);
  const activity = useQuery({
    queryKey: ['user-activity', userId, range, failed],
    queryFn: () => api.activity(userId, range, failed),
    staleTime: 60_000,
    retry: false,
  });
  const device = (id: string | null, platform: string | null, version: string | null) => {
    const known = devices.find((d) => d.id === id);
    const app = [platform, version].filter(Boolean).join(' ');
    return known ? `${known.name}${app ? ` · ${app}` : ''}` : app || '—';
  };
  const data = activity.data;
  return (
    <Card
      title="API activity"
      description="Requests this account's apps made, from the API request log (kept 30 days; accounts are named from 11 Oct 2026)."
      action={
        <div className="admin-activity-controls">
          <Select
            aria-label="Range"
            value={range}
            onChange={(e) => setRange(e.target.value as AdminActivityRange)}
          >
            {adminActivityRanges.map((r) => (
              <option key={r} value={r}>
                {rangeNames[r]}
              </option>
            ))}
          </Select>
          <label className="admin-checkbox">
            <Checkbox checked={failed} onChange={(e) => setFailed(e.target.checked)} />
            Failed only
          </label>
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
            <Stat label="Requests" value={data.totals.requests.toLocaleString()} />
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
          </div>

          {data.problems.length > 0 && (
            <DataTable label="Failures by route">
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
                  <tr key={`${p.method} ${p.route} ${p.status} ${p.code}`}>
                    <td className="admin-activity-route">
                      <Route method={p.method} route={p.route} />
                    </td>
                    <td>
                      <Badge tone={tone(p.status)}>{p.status}</Badge>
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

          {data.requests.length ? (
            <DataTable label={failed ? 'Latest failed requests' : 'Latest requests'}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Device</th>
                  <th>Took</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((r) => (
                  <tr key={r.requestId || r.at}>
                    <td className="admin-nowrap" title={r.at}>
                      {date(r.at)}
                    </td>
                    <td className="admin-activity-route" title={`Request ID ${r.requestId}`}>
                      <Route method={r.method} route={r.route} />
                      {r.code && <div className="admin-muted">{r.code}</div>}
                    </td>
                    <td>
                      <Badge tone={tone(r.status)}>{r.status}</Badge>
                    </td>
                    <td>{device(r.deviceId, r.platform, r.appVersion)}</td>
                    <td className="admin-nowrap">{r.ms == null ? '—' : `${r.ms} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <p className="admin-empty">
              {failed ? 'No failed requests' : 'No requests'} in the{' '}
              {rangeNames[range].toLowerCase()}.
            </p>
          )}
          {data.truncated && (
            <p className="admin-muted">
              Showing the latest {data.requests.length}. Narrow the range or show failed only to see
              older ones.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
