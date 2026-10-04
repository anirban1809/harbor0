import type { Root } from './journal';
export type SyncIssueCode =
  | 'MAPPING_REQUIRED'
  | 'FOLDER_MISSING'
  | 'PERMISSION_DENIED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'DISK_FULL'
  | 'AUTH_INVALID'
  | 'CONFLICT'
  | 'FOLDER_RECOVERED'
  | 'SYNC_DETACHED'
  | 'SYNC_ERROR';
export type SyncIssue = {
  id: string;
  rootId: string;
  code: SyncIssueCode;
  message: string;
  relativePath?: string;
  conflictPath?: string;
  // Set when the problem belongs to one queued file rather than the whole folder.
  jobId?: string;
  scope?: 'item';
  // A refused upload: its size and the free space, or that the shared folder's owner is full.
  storage?: { requiredBytes?: number; availableBytes?: number; owner?: boolean };
  at: string;
};
// Kept until the user dismisses them; a later successful sync does not clear these.
export const stickyIssue = (issue: SyncIssue) =>
  issue.code === 'CONFLICT' || issue.code === 'FOLDER_RECOVERED' || issue.code === 'SYNC_DETACHED';
// Notices of something that already happened; nothing is waiting on the user.
const notice = (issue: SyncIssue) =>
  issue.code === 'FOLDER_RECOVERED' || issue.code === 'SYNC_DETACHED';
export type SyncProgress = {
  rootId: string;
  direction: 'upload' | 'download';
  relativePath: string;
  loaded: number;
  total: number;
};
export type SyncActivityItem = {
  id: string;
  rootId: string;
  direction: 'upload' | 'download';
  relativePath: string;
  at: string;
  item?: import('@harbor/contracts').DriveItem;
};
export type SyncRuntime = {
  confirmationPendingRoots?: string[];
  // Files whose only copy is on another linked device that has not provided it yet.
  waiting?: { rootId: string; relativePath: string }[];
  running: boolean;
  paused: boolean;
  online: boolean;
  message: string;
  queued: number;
  lastSync: string | null;
  active: SyncProgress | null;
  // Percent complete of the sync or backup under way, by root id; absent when idle.
  progress?: Record<string, number>;
  issues: SyncIssue[];
  recent: SyncActivityItem[];
  // The local change ledger by root id: a folder is up to date only when nothing is pending.
  changes?: Record<string, import('./journal').ChangeSummary>;
  // Folders whose contents are still being compared with the cloud.
  reconciling?: string[];
};
export type SyncFolder = Root & {
  localPathDisplayName: string;
  localPathDisplay?: string;
  diskSizeBytes?: number | null;
  fileCount: number;
  folderCount: number;
};
export type SyncJob = {
  id: string;
  rootId: string;
  relativePath: string;
  kind: string;
  error: string | null;
  attempts: number;
};
export const WAITING = 'Waiting for another device';
// The live status knows when a check ends; the folder list is only as fresh as its last load.
const reconciling = (root: SyncFolder, state: SyncRuntime) =>
  state.reconciling ? state.reconciling.includes(root.id) : !!root.needsReconcile;
export function folderState(root: SyncFolder, state: SyncRuntime, jobs: SyncJob[]) {
  const issues =
    state.issues?.filter(
      (issue) => issue.rootId === root.id && issue.code !== 'FOLDER_RECOVERED',
    ) ?? [];
  if (issues.some((issue) => issue.code === 'FOLDER_MISSING')) return 'Folder unavailable';
  if (issues.some((issue) => issue.code === 'CONFLICT')) return 'Conflict';
  if (issues.length) return 'Action required';
  if (state.paused || root.paused) return 'Paused';
  if (!state.online) return 'Offline';
  if (jobs.some((job) => job.rootId === root.id && job.error)) return 'Action required';
  if (
    state.active?.rootId === root.id ||
    jobs.some((job) => job.rootId === root.id) ||
    (state.changes?.[root.id]?.pending ?? 0) > 0
  )
    return 'Syncing';
  if (state.waiting?.some((item) => item.rootId === root.id)) return WAITING;
  return reconciling(root, state) || state.confirmationPendingRoots?.includes(root.id)
    ? 'Syncing'
    : 'Up to date';
}
export function globalSyncState(roots: SyncFolder[], state: SyncRuntime, jobs: SyncJob[]) {
  const ids = new Set(roots.map((root) => root.id));
  if (state.issues?.some((issue) => (ids.has(issue.rootId) || !issue.rootId) && !notice(issue)))
    return 'Action required';
  if (state.paused) return 'Paused';
  if (!state.online) return 'Offline';
  if (jobs.some((job) => ids.has(job.rootId) && job.error)) return 'Action required';
  if (
    (state.active && ids.has(state.active.rootId)) ||
    state.confirmationPendingRoots?.some((id) => ids.has(id)) ||
    [...ids].some((id) => (state.changes?.[id]?.pending ?? 0) > 0) ||
    roots.some(
      (root) =>
        !root.paused && (reconciling(root, state) || jobs.some((job) => job.rootId === root.id)),
    )
  )
    return 'Syncing';
  return state.waiting?.some((item) => ids.has(item.rootId)) ? WAITING : 'Up to date';
}
// Requirements are derived from current engine state, so resolved problems disappear immediately.
export function syncRequirements(roots: SyncFolder[], state: SyncRuntime, jobs: SyncJob[]) {
  const ids = new Set(roots.filter((root) => root.mode === 'sync').map((root) => root.id));
  const issues = (state.issues ?? []).filter((issue) => ids.has(issue.rootId) || !issue.rootId);
  for (const job of jobs.filter(
    (job) =>
      ids.has(job.rootId) &&
      state.online !== false &&
      job.error &&
      !issues.some((issue) => issue.rootId === job.rootId && !stickyIssue(issue)),
  )) {
    issues.push({
      id: job.id,
      rootId: job.rootId,
      relativePath: job.relativePath,
      code: 'SYNC_ERROR',
      message: job.error!,
      at: '',
    });
  }
  return issues;
}
export function syncIssueCode(error: unknown, item = false): SyncIssueCode {
  const code = (error as { code?: string })?.code;
  // A single missing file is not a missing sync folder.
  if (code === 'ENOENT' || code === 'ENOTDIR') return item ? 'SYNC_ERROR' : 'FOLDER_MISSING';
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'ENOSPC') return 'DISK_FULL';
  if (code === 'STORAGE_QUOTA_EXCEEDED' || code === 'OWNER_STORAGE_FULL')
    return 'STORAGE_QUOTA_EXCEEDED';
  if (code === 'AUTH_INVALID' || code === 'DEVICE_REVOKED') return 'AUTH_INVALID';
  return 'SYNC_ERROR';
}
/** What a refused upload needed; a shared folder's owner's free space is not theirs to see. */
export function storageNeed(error: unknown, shared: boolean): SyncIssue['storage'] {
  if (shared || (error as { code?: string })?.code === 'OWNER_STORAGE_FULL') return { owner: true };
  const details = (error as { details?: Record<string, unknown> })?.details ?? {};
  const bytes = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    requiredBytes: bytes(details.requiredBytes),
    availableBytes: bytes(details.availableBytes),
  };
}
