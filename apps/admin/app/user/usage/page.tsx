'use client';
import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import {
  ADMIN_REQUEST_PAGE,
  USAGE_GROUP_ACTIONS,
  usageGroups,
  type AdminActivityRange,
  type AdminUsage,
  type AdminUsageEvent,
  type UsageGroup,
} from '../../../../../packages/contracts/src/admin';
import { Alert } from '../../../../web/components/ui/alert';
import { Badge } from '../../../../web/components/ui/badge';
import { Button } from '../../../../web/components/ui/button';
import { Card } from '../../../../web/components/ui/card';
import { DataTable } from '../../../../web/components/ui/table';
import { Skeleton } from '../../../../web/components/ui/skeleton';
import { Segmented } from '../../../../web/components/ui/segmented';
import { Tab, TabList, TabPanel, Tabs } from '../../../../web/components/ui/tabs';
import { deviceLabel, isRange, RangeSelect, rangeNames } from '../../../components/activity-parts';
import { PageHeader, Shell } from '../../../components/shell';
import { Stat } from '../../../components/storage-totals';
import { api } from '../../../lib/api';
import { bytes, date } from '../../../lib/format';

const actionNames: Record<string, string> = {
  UPLOADED: 'Uploaded a file',
  DOWNLOADED: 'Downloaded',
  FOLDER_ZIPPED: 'Downloaded a folder as ZIP',
  FOLDER_CREATED: 'Created a folder',
  RENAMED: 'Renamed',
  MOVED: 'Moved',
  TRASHED: 'Moved to trash',
  UNTRASHED: 'Restored from trash',
  DELETED: 'Deleted forever',
  TRASH_EMPTIED: 'Emptied the trash',
  VERSION_RESTORED: 'Restored an older version',
  TRANSFER_SENT: 'Sent files',
  TRANSFER_SAVED: 'Saved received files',
  SHARED: 'Shared an item',
  SYNC_SHARED: 'Invited someone to sync a folder',
  SYNC_FOLDERS_CHANGED: 'Changed sync folders',
  SYNC_FOLDER_REMOVED: 'Stopped syncing a folder everywhere',
  BACKUP_ADDED: 'Added a backup folder',
  BACKUP_STARTED: 'Backup started',
  BACKUP_FINISHED: 'Backup finished',
  BACKUP_DISCONNECTED: 'Disconnected a backup',
  BACKUP_ARCHIVED: 'Archived a backup',
  BACKUP_RESUMED: 'Resumed a backup',
  BACKUP_RESTORED: 'Restored from a backup',
};
const groupNames: Record<UsageGroup, string> = {
  all: 'Everything',
  transfers: 'Uploads and downloads',
  files: 'File changes',
  sync: 'Sync and backups',
  sharing: 'Sharing',
};
const sourceNames: Record<string, string> = {
  FILE: 'file',
  VERSION: 'older version',
  TRANSFER: 'from a transfer',
  ZIP: 'folder ZIP',
};
/** A size, or a dash when only counts were logged (before 11 Oct 2026). */
const size = (t: { count: number; bytes: number }) => (t.bytes || !t.count ? bytes(t.bytes) : '—');
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** An event's details in a line, e.g. "video/mp4 · into a backup" or "2 added, 1 removed". */
function details(e: AdminUsageEvent) {
  const d = e.details;
  return [
    d.mimeType,
    d.itemType === 'FOLDER' ? 'folder' : d.itemType === 'FILE' ? 'file' : null,
    d.backup ? 'into a backup' : null,
    d.source && e.action === 'DOWNLOADED' ? (sourceNames[d.source] ?? d.source) : null,
    d.added || d.removed ? `${d.added ?? 0} added, ${d.removed ?? 0} removed` : null,
    d.trigger === 'MANUAL' ? 'started by hand' : d.trigger === 'AUTOMATIC' ? 'scheduled' : null,
    d.state && d.state !== 'COMPLETED' ? d.state.toLowerCase() : null,
    d.files != null ? plural(d.files, 'file') : null,
    d.permission ? d.permission.toLowerCase() : null,
    e.automated ? 'by the app' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

type Totals = Record<string, { count: number; bytes: number }>;
const sum = (totals: Totals, actions: readonly string[]) =>
  actions.reduce(
    (acc, a) => ({
      count: acc.count + (totals[a]?.count ?? 0),
      bytes: acc.bytes + (totals[a]?.bytes ?? 0),
    }),
    { count: 0, bytes: 0 },
  );

const HOUR = 3_600_000;
/** Local-time buckets for the chart: hours for a day or less, days beyond. */
function buckets(usage: AdminUsage, range: AdminActivityRange, now: number) {
  const hourly = range === '1h' || range === '24h';
  const start = new Date(range === '1h' ? now - HOUR : Date.parse(usage.since));
  if (hourly) start.setMinutes(0, 0, 0);
  else start.setHours(0, 0, 0, 0);
  const list: { at: Date; up: number; down: number; ups: number; downs: number }[] = [];
  for (let t = new Date(start); t.getTime() <= now;) {
    list.push({ at: new Date(t), up: 0, down: 0, ups: 0, downs: 0 });
    if (hourly) t.setHours(t.getHours() + 1);
    else t.setDate(t.getDate() + 1);
  }
  for (const h of usage.hours) {
    if (h.action !== 'UPLOADED' && h.action !== 'DOWNLOADED') continue;
    const t = Date.parse(h.at);
    let i = list.length - 1;
    while (i > 0 && list[i]!.at.getTime() > t) i--;
    const b = list[i]!;
    if (h.action === 'UPLOADED') {
      b.up += h.bytes;
      b.ups += h.count;
    } else {
      b.down += h.bytes;
      b.downs += h.count;
    }
  }
  return { list, hourly };
}

/** Uploaded and downloaded bytes (or files) per hour or day, side by side. */
function TransferChart({ usage, range }: { usage: AdminUsage; range: AdminActivityRange }) {
  const [now] = useState(() => Date.now());
  const { list, hourly } = useMemo(() => buckets(usage, range, now), [usage, range, now]);
  const [hover, setHover] = useState<number | null>(null);
  // Lines before sizes were logged only count, so a range without sizes opens on counts.
  const [measure, setMeasure] = useState<'bytes' | 'count'>(() =>
    list.some((b) => b.up || b.down) ? 'bytes' : 'count',
  );
  const up = (b: (typeof list)[number]) => (measure === 'bytes' ? b.up : b.ups);
  const down = (b: (typeof list)[number]) => (measure === 'bytes' ? b.down : b.downs);
  const max = Math.max(1, ...list.flatMap((b) => [up(b), down(b)]));
  const peak = measure === 'bytes' ? bytes(max === 1 ? 0 : max) : `${max.toLocaleString()} files`;
  const label = (at: Date) =>
    hourly
      ? at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const shown = hover == null ? null : list[hover];
  const every = Math.ceil(list.length / 8);
  return (
    <div className="admin-usage-chart">
      <div className="admin-usage-legend">
        <span>
          <i data-series="up" /> Uploaded
        </span>
        <span>
          <i data-series="down" /> Downloaded
        </span>
        <span className="admin-muted admin-usage-readout">
          {shown
            ? `${label(shown.at)}: uploaded ${plural(shown.ups, 'file')}${shown.up ? ` (${bytes(shown.up)})` : ''}, downloaded ${plural(shown.downs, 'time')}${shown.down ? ` (${bytes(shown.down)})` : ''}`
            : `Peak ${peak} ${hourly ? 'an hour' : 'a day'}. Hover a bar for details.`}
        </span>
        <Segmented
          label="Measure"
          value={measure}
          onValueChange={setMeasure}
          options={[
            { value: 'bytes', label: 'Size' },
            { value: 'count', label: 'Files' },
          ]}
        />
      </div>
      <div className="admin-usage-plot" onMouseLeave={() => setHover(null)}>
        {list.map((b, i) => (
          <div
            key={b.at.toISOString()}
            className="admin-usage-slot"
            data-active={hover === i || undefined}
            onMouseEnter={() => setHover(i)}
            aria-label={`${label(b.at)}: uploaded ${bytes(b.up)}, downloaded ${bytes(b.down)}`}
          >
            <div className="admin-usage-bars">
              <span data-series="up" style={{ height: `${(up(b) / max) * 100}%` }} />
              <span data-series="down" style={{ height: `${(down(b) / max) * 100}%` }} />
            </div>
            <span className="admin-usage-tick">{i % every === 0 ? label(b.at) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** How many things the account did by weekday and hour of day, in this browser's time. */
function ActiveHours({ usage }: { usage: AdminUsage }) {
  const grid = useMemo(() => {
    const cells = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const h of usage.hours) {
      const at = new Date(h.at);
      cells[(at.getDay() + 6) % 7]![at.getHours()]! += h.count;
    }
    return cells;
  }, [usage]);
  const max = Math.max(1, ...grid.flat());
  return (
    <div className="admin-usage-heat" role="table" aria-label="Activity by weekday and hour">
      <span />
      {Array.from({ length: 24 }, (_, h) => (
        <span key={h} className="admin-usage-tick">
          {h % 3 === 0 ? h : ''}
        </span>
      ))}
      {grid.map((row, d) => (
        <div key={d} role="row" className="admin-usage-heat-row">
          <span className="admin-usage-tick">{weekdays[d]}</span>
          {row.map((n, h) => (
            <span
              key={h}
              role="cell"
              className="admin-usage-cell"
              title={`${weekdays[d]} ${h}:00–${h + 1}:00: ${plural(n, 'action')}`}
              style={{ opacity: n ? 0.15 + 0.85 * (n / max) : undefined }}
              data-empty={!n || undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Usage({ id }: { id: string }) {
  const params = useSearchParams();
  const initialRange = params.get('range');
  const [range, setRange] = useState<AdminActivityRange>(
    isRange(initialRange) ? initialRange : '7d',
  );
  const [group, setGroup] = useState<UsageGroup>('all');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length;
  const restart = () => setCursors([undefined]);

  const detail = useQuery({ queryKey: ['user', id], queryFn: () => api.user(id) });
  const usage = useQuery({
    queryKey: ['user-usage', id, range],
    queryFn: () => api.usage(id, range),
    staleTime: 60_000,
    retry: false,
  });
  const log = useQuery({
    queryKey: ['usage-log', id, range, group, cursors.at(-1)],
    queryFn: () => api.usageEvents(id, { range, group, cursor: cursors.at(-1) }),
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const device = deviceLabel(detail.data?.devices ?? []);
  const email = detail.data?.account.email;
  const data = usage.data;
  const totals: Totals = Object.fromEntries((data?.totals ?? []).map((t) => [t.action, t]));
  const uploaded = sum(totals, ['UPLOADED']);
  const downloaded = sum(totals, ['DOWNLOADED', 'FOLDER_ZIPPED']);
  const backedUp = sum(totals, ['BACKUP_FINISHED']);

  return (
    <>
      <Link href={`/user?id=${encodeURIComponent(id)}`} className="admin-back">
        <ArrowLeft aria-hidden="true" />
        {email ?? 'Account'}
      </Link>
      <PageHeader
        title="Usage"
        description={`What ${email ?? 'this account'} uploaded, downloaded and set up, from the API request log (kept 30 days). Sizes are logged from 11 Oct 2026; file names never are.`}
        action={
          <div className="admin-activity-controls">
            <RangeSelect
              value={range}
              onChange={(r) => {
                setRange(r);
                restart();
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label="Refresh"
              disabled={usage.isFetching || log.isFetching}
              onClick={() => {
                restart();
                void usage.refetch();
                void log.refetch();
              }}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
        }
      />
      {usage.error ? (
        <Alert tone="error">{usage.error.message}</Alert>
      ) : !data ? (
        <Skeleton style={{ height: 320 }} />
      ) : (
        <>
          <Card title={rangeNames[range]}>
            <div className="admin-stats admin-usage-stats">
              <Stat label="Uploaded" value={size(uploaded)} hint={plural(uploaded.count, 'file')} />
              <Stat
                label="Downloaded"
                value={size(downloaded)}
                hint={plural(downloaded.count, 'download')}
              />
              <Stat
                label="Backups"
                value={plural(sum(totals, ['BACKUP_STARTED']).count, 'run')}
                hint={`${bytes(backedUp.bytes)} in ${plural(backedUp.count, 'finished run')}`}
              />
              <Stat
                label="Sync and backup setup"
                value={sum(totals, [
                  'SYNC_FOLDERS_CHANGED',
                  'SYNC_FOLDER_REMOVED',
                  'BACKUP_ADDED',
                  'BACKUP_DISCONNECTED',
                  'BACKUP_ARCHIVED',
                  'BACKUP_RESUMED',
                ]).count.toLocaleString()}
                hint="Folders added or removed"
              />
              <Stat
                label="File changes"
                value={sum(totals, USAGE_GROUP_ACTIONS.files).count.toLocaleString()}
                hint="New folders, renames, moves, deletes"
              />
              <Stat
                label="Sharing"
                value={sum(totals, USAGE_GROUP_ACTIONS.sharing).count.toLocaleString()}
                hint="Transfers and shares"
              />
            </div>
            <TransferChart usage={data} range={range} />
          </Card>

          <div className="admin-usage-pair">
            <Card
              title="When they're active"
              description="Everything above by weekday and hour, in your time zone."
            >
              <ActiveHours usage={data} />
            </Card>
            <Card title="Backups set up" description="Every backup folder, from the database.">
              {data.backups.length ? (
                <DataTable label="Backups set up">
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Set up</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.backups.map((b) => (
                      <tr key={b.id}>
                        <td>{b.deviceName ?? '—'}</td>
                        <td className="admin-nowrap">{date(b.createdAt)}</td>
                        <td>
                          <Badge tone={b.state === 'ACTIVE' ? 'success' : 'neutral'}>
                            {b.state.toLowerCase()}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              ) : (
                <p className="admin-empty">No backups set up.</p>
              )}
            </Card>
          </div>

          {data.devices.length > 0 && (
            <Card title="By device">
              <DataTable label="Usage by device">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Uploaded</th>
                    <th>Downloaded</th>
                    <th>Other actions</th>
                    <th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {data.devices.map((d) => (
                    <tr key={`${d.deviceId} ${d.platform}`}>
                      <td>{device(d.deviceId, d.platform, null)}</td>
                      <td>
                        {size(d.uploads)}
                        <div className="admin-muted">{plural(d.uploads.count, 'file')}</div>
                      </td>
                      <td>
                        {size(d.downloads)}
                        <div className="admin-muted">{plural(d.downloads.count, 'download')}</div>
                      </td>
                      <td>{d.other.toLocaleString()}</td>
                      <td className="admin-nowrap">{date(d.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </Card>
          )}
        </>
      )}

      <Card title="Timeline">
        <Tabs
          value={group}
          onValueChange={(next) => {
            setGroup(next);
            restart();
          }}
        >
          <TabList aria-label="What to list">
            {usageGroups.map((g) => (
              <Tab key={g} value={g}>
                {groupNames[g]}
                {data && (
                  <span className="admin-muted">
                    {(g === 'all'
                      ? data.totals.reduce((n, t) => n + t.count, 0)
                      : sum(totals, USAGE_GROUP_ACTIONS[g]).count
                    ).toLocaleString()}
                  </span>
                )}
              </Tab>
            ))}
          </TabList>
          <TabPanel value={group} className="admin-request-log">
            {log.error ? (
              <Alert tone="error">{log.error.message}</Alert>
            ) : !log.data ? (
              <Skeleton style={{ height: 240 }} />
            ) : log.data.events.length ? (
              <DataTable label={`${groupNames[group]}, page ${page}`}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>What</th>
                    <th>Size</th>
                    <th>Device</th>
                  </tr>
                </thead>
                <tbody aria-busy={log.isFetching}>
                  {log.data.events.map((e) => (
                    <tr key={e.requestId || e.at}>
                      <td className="admin-nowrap" title={e.at}>
                        {date(e.at)}
                      </td>
                      <td>
                        {actionNames[e.action] ?? e.action}
                        {details(e) && <div className="admin-muted">{details(e)}</div>}
                      </td>
                      <td className="admin-nowrap">{bytes(e.details.sizeBytes)}</td>
                      <td>{device(e.deviceId, e.platform, e.appVersion)}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : (
              <p className="admin-empty">
                Nothing in {groupNames[group].toLowerCase()} in the{' '}
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

function UsagePage() {
  const id = useSearchParams().get('id');
  if (!id) return <p className="admin-empty">No account selected.</p>;
  return <Usage key={id} id={id} />;
}

export default function Page() {
  return (
    <Shell>
      <Suspense>
        <UsagePage />
      </Suspense>
    </Shell>
  );
}
