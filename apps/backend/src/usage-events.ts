import { createHash } from 'node:crypto';
import { usageAction, type UsageDetails } from '../../../packages/contracts/src/admin';

type Fields = Partial<UsageDetails>;
type Item = { type?: string; sizeBytes?: number; mimeType?: string | null; backupRootId?: string };
const record = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const count = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
/**
 * Which file a download fetched, as a short one-way hash of its ids, so repeats of the same file
 * can be told apart from different files without the log naming an item.
 */
const downloadKey = (i: Record<string, unknown>) => {
  const target = i.folderDownloadId
    ? `zip:${i.folderDownloadId}`
    : i.transferId
      ? `transfer:${i.transferId}:${i.entryId ?? ''}`
      : i.driveItemId
        ? `item:${i.driveItemId}:${i.versionId ?? ''}`
        : null;
  return target ? createHash('sha256').update(target).digest('hex').slice(0, 16) : undefined;
};

/**
 * The sizes and counts a successful usage request adds to its request line, so the console can
 * show what an account uploaded, downloaded and set up. Only numbers and kinds: never names,
 * paths or item ids (a download's fileKey is a one-way hash). Undefined when the request is not usage, or (for a sync folder list that
 * didn't change) nothing happened.
 */
export function usageDetails(
  method: string,
  route: string,
  input: unknown,
  result: unknown,
): Fields | undefined {
  const action = usageAction(method, route);
  if (!action) return undefined;
  const i = record(input);
  const r = record(result);
  const item = record(r.item) as Item;
  let fields: Fields;
  switch (action) {
    case 'UPLOADED':
      // A batch of small files: how many were saved and their total size.
      if (Array.isArray(r.results)) {
        const saved = r.results.map((result) => record(record(result).item) as Item);
        const items = saved.filter((entry) => entry.sizeBytes !== undefined);
        fields = {
          files: items.length,
          sizeBytes: items.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
          backup: route.startsWith('/v1/backups/'),
        };
        break;
      }
      fields = {
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType ?? undefined,
        backup: !!item.backupRootId,
      };
      break;
    case 'DOWNLOADED':
      fields = {
        sizeBytes: r.sizeBytes as number,
        fileKey: downloadKey(i),
        source: i.folderDownloadId
          ? 'ZIP'
          : i.transferId
            ? 'TRANSFER'
            : i.versionId
              ? 'VERSION'
              : 'FILE',
      };
      break;
    case 'FOLDER_ZIPPED':
      fields = { files: (r.totalFiles as number) || undefined };
      break;
    case 'TRASHED':
    case 'UNTRASHED':
      fields = {
        itemType: item.type,
        sizeBytes: item.type === 'FILE' ? item.sizeBytes : undefined,
      };
      break;
    case 'TRASH_EMPTIED':
      fields = { files: r.count as number };
      break;
    case 'TRANSFER_SENT':
      fields = { files: count(i.items) };
      break;
    case 'TRANSFER_SAVED':
      fields = { files: count(r.items) };
      break;
    case 'SHARED':
      fields = { permission: i.permission as string };
      break;
    case 'SYNC_FOLDERS_CHANGED': {
      const added = count(r.addedFolderIds) ?? 0;
      const removed = count(r.removedFolderIds) ?? 0;
      // The desktop apps send their whole list on every start; only changes are usage.
      if (!added && !removed) return undefined;
      fields = { added, removed };
      break;
    }
    case 'BACKUP_STARTED':
      fields = { trigger: i.trigger as string };
      break;
    case 'BACKUP_FINISHED': {
      const run = record(r.run);
      fields = {
        state: run.state as string,
        files: run.fileCount as number,
        sizeBytes: run.sizeBytes as number,
      };
      break;
    }
    default:
      fields = {};
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
  );
}
