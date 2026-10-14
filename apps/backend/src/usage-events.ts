import { usageAction, type UsageDetails } from '../../../packages/contracts/src/admin';

type Fields = Partial<UsageDetails>;
type Item = { type?: string; sizeBytes?: number; mimeType?: string | null; backupRootId?: string };
const record = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const count = (value: unknown) => (Array.isArray(value) ? value.length : undefined);

/**
 * The sizes and counts a successful usage request adds to its request line, so the console can
 * show what an account uploaded, downloaded and set up. Only numbers and kinds: never names,
 * paths or item ids. Undefined when the request is not usage, or (for a sync folder list that
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
      // A backup's batch of small files: how many were saved and their total size.
      if (Array.isArray(r.results)) {
        const saved = r.results.map((result) => record(record(result).item) as Item);
        const items = saved.filter((entry) => entry.sizeBytes !== undefined);
        fields = {
          files: items.length,
          sizeBytes: items.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
          backup: true,
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
