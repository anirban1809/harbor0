'use client';
import {
  adminActivityRanges,
  type AdminActivityRange,
  type AdminUserDetail,
} from '../../../packages/contracts/src/admin';
import type { BadgeTone } from '../../web/components/ui/badge';
import { Select } from '../../web/components/ui/select';

export const rangeNames: Record<AdminActivityRange, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
export const isRange = (value: string | null): value is AdminActivityRange =>
  (adminActivityRanges as readonly string[]).includes(value ?? '');
/** What a usage action was, in words, e.g. UPLOADED → "Uploaded a file". */
export const actionNames: Record<string, string> = {
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
export const kindNames: Record<string, string> = {
  UPLOAD_FAILED: 'Upload failed',
  UPLOAD_PART_RETRY: 'Part retried',
};
export const stageNames: Record<string, string> = {
  hash: 'reading the file',
  create: 'starting the upload',
  parts: 'signing part URLs',
  storage: 'sending to storage',
  complete: 'finishing',
  other: 'other',
};
export const statusTone = (status: number): BadgeTone =>
  status >= 500 ? 'danger' : status === 401 ? 'neutral' : status >= 400 ? 'warning' : 'success';

/** A route that wraps only after its slashes, e.g. "/v1/uploads/" then ":id/complete". */
export function Route({ method, route }: { method: string; route: string }) {
  return (
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
}

/** Names a request's device from the account's devices, e.g. "Chrome on Windows · WEB". */
export function deviceLabel(devices: AdminUserDetail['devices']) {
  return (id: string | null, platform: string | null, version: string | null) => {
    const known = devices.find((d) => d.id === id);
    const app = [platform, version].filter(Boolean).join(' ');
    return known ? `${known.name}${app ? ` · ${app}` : ''}` : app || '—';
  };
}

export function RangeSelect({
  value,
  onChange,
}: {
  value: AdminActivityRange;
  onChange: (value: AdminActivityRange) => void;
}) {
  return (
    <Select
      aria-label="Range"
      value={value}
      onChange={(e) => onChange(e.target.value as AdminActivityRange)}
    >
      {adminActivityRanges.map((r) => (
        <option key={r} value={r}>
          {rangeNames[r]}
        </option>
      ))}
    </Select>
  );
}
