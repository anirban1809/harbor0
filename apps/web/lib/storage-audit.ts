import type { ApiClient } from '@harbor/api-client';
import type { StorageAuditRow, StorageUsage } from '@harbor/contracts';

const locations: Record<StorageAuditRow['location'], string> = {
  MY_DRIVE: 'My Drive',
  BACKUP: 'Backups',
  SYNC: 'Synced folders',
  TRASH: 'Trash',
  DELETING: 'Being deleted',
};
const states: Record<StorageAuditRow['state'], string> = {
  CURRENT: 'Current version',
  PREVIOUS_VERSION: 'Previous version',
  RETAINED_FOR_TRANSFER: 'Kept for a sent transfer',
  ON_DEVICES_ONLY: 'On devices only (not counted)',
};

function size(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  const unit = Math.min(4, Math.floor(Math.log10(bytes) / 3));
  return `${(bytes / 1000 ** unit).toFixed(2)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
function cell(value: string | number | null) {
  if (value === null) return '';
  let text = String(value);
  // Keep spreadsheet apps from evaluating file names as formulas.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const line = (values: (string | number | null)[]) => values.map(cell).join(',');

export function storageAuditCsv(rows: StorageAuditRow[], storage: StorageUsage, at = new Date()) {
  const counted = rows.reduce((n, r) => n + r.countedBytes, 0);
  const byLocation = new Map<string, number>();
  for (const r of rows)
    byLocation.set(r.location, (byLocation.get(r.location) ?? 0) + r.countedBytes);
  const previous = rows
    .filter((r) => r.state === 'PREVIOUS_VERSION')
    .reduce((n, r) => n + r.countedBytes, 0);
  const summary: [string, number][] = [
    ...(Object.keys(locations) as StorageAuditRow['location'][])
      .filter((key) => byLocation.has(key))
      .map((key): [string, number] => [locations[key], byLocation.get(key)!]),
    ['  of which previous versions', previous],
    ['Total of files listed below', counted],
    ['Storage used (account total)', storage.usedBytes],
    ['Unaccounted difference', storage.usedBytes - counted],
    ['Uploads in progress (reserved)', storage.reservedBytes],
    ['Available', storage.availableBytes],
    ['Quota', storage.quotaBytes],
  ];
  const out = [
    line(['harbor0 storage audit', at.toISOString()]),
    line(['Summary', 'Bytes', 'Size']),
    ...summary.map(([label, bytes]) => line([label, bytes, size(Math.abs(bytes))])),
    '',
    line([
      'Path',
      'Location',
      'Location detail',
      'Version state',
      'Version',
      'Size (bytes)',
      'Counted (bytes)',
      'Size',
      'Uploaded at',
      'Uploaded from',
      'SHA-256',
      'File ID',
      'Version ID',
    ]),
    ...[...rows]
      .sort((a, b) => b.countedBytes - a.countedBytes || a.path.localeCompare(b.path))
      .map((r) =>
        line([
          r.path,
          locations[r.location],
          r.locationDetail,
          states[r.state],
          r.versionNumber,
          r.sizeBytes,
          r.countedBytes,
          size(r.sizeBytes),
          r.uploadedAt,
          r.uploadedFrom,
          r.contentHash,
          r.itemId,
          r.versionId,
        ]),
      ),
  ];
  return out.join('\r\n') + '\r\n';
}

/** Reads every audit page and saves the CSV. Returns the number of file versions listed. */
export async function downloadStorageAudit(api: ApiClient, signal?: AbortSignal) {
  const rows: StorageAuditRow[] = [];
  let cursor: string | undefined;
  let storage: StorageUsage;
  do {
    const page = await api.storageAuditPage(cursor, signal);
    rows.push(...page.rows);
    storage = page.storage;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const at = new Date();
  // BOM so Excel reads non-ASCII file names as UTF-8.
  const blob = new Blob(['﻿', storageAuditCsv(rows, storage, at)], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `harbor0-storage-audit-${at.toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return rows.length;
}
