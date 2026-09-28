import { Cloud, FolderSync, HardDrive, ShieldCheck, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from './ui/card';

type Metric = { label: string; value: string; detail: string; icon: LucideIcon };
function Overview({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="workspace-overview">
      {metrics.map(({ label, value, detail, icon: Icon }) => (
        <Card key={label} className="gap-0 py-0 shadow-xs">
          <CardContent className="p-5">
            <div className="metric-label">
              <span>{label}</span>
              <Icon size={17} aria-hidden="true" />
            </div>
            <div className="metric-value">{value}</div>
            <p className="metric-detail">{detail}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
export function StorageOverview({
  used,
  available,
  percent,
}: {
  used: string;
  available: string;
  percent: number;
}) {
  return (
    <Overview
      metrics={[
        {
          label: 'Storage used',
          value: used,
          detail: `${percent}% of your space`,
          icon: HardDrive,
        },
        {
          label: 'Available space',
          value: available,
          detail: 'Available for uploads',
          icon: Cloud,
        },
        {
          label: 'Your workspace',
          value: 'Private',
          detail: 'You choose who has access',
          icon: ShieldCheck,
        },
      ]}
    />
  );
}
export function SyncOverview({
  roots,
  queued,
  paused,
}: {
  roots: number;
  queued: number;
  paused: boolean;
}) {
  return (
    <Overview
      metrics={[
        {
          label: 'Connected folders',
          value: String(roots),
          detail: 'Backup and sync on this computer',
          icon: FolderSync,
        },
        {
          label: 'Pending changes',
          value: String(queued),
          detail: 'Waiting to sync with your drive',
          icon: Cloud,
        },
        {
          label: 'Sync status',
          value: paused ? 'Paused' : 'Enabled',
          detail: paused ? 'Resume to sync pending changes' : 'Folder sync is enabled',
          icon: ShieldCheck,
        },
      ]}
    />
  );
}
