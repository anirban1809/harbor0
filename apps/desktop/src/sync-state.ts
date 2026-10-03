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
  at: string;
};
// Kept until the user dismisses them; a later successful sync does not clear these.
export const stickyIssue = (issue: SyncIssue) =>
  issue.code === 'CONFLICT' || issue.code === 'FOLDER_RECOVERED';
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
  if (state.active?.rootId === root.id || jobs.some((job) => job.rootId === root.id))
    return 'Syncing';
  if (state.waiting?.some((item) => item.rootId === root.id)) return WAITING;
  return root.needsReconcile || state.confirmationPendingRoots?.includes(root.id)
    ? 'Syncing'
    : 'Up to date';
}
export function globalSyncState(roots: SyncFolder[], state: SyncRuntime, jobs: SyncJob[]) {
  const ids = new Set(roots.map((root) => root.id));
  if (
    state.issues?.some(
      (issue) => (ids.has(issue.rootId) || !issue.rootId) && issue.code !== 'FOLDER_RECOVERED',
    )
  )
    return 'Action required';
  if (state.paused) return 'Paused';
  if (!state.online) return 'Offline';
  if (jobs.some((job) => ids.has(job.rootId) && job.error)) return 'Action required';
  if (
    (state.active && ids.has(state.active.rootId)) ||
    state.confirmationPendingRoots?.some((id) => ids.has(id)) ||
    roots.some(
      (root) => !root.paused && (root.needsReconcile || jobs.some((job) => job.rootId === root.id)),
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
  if (code === 'STORAGE_QUOTA_EXCEEDED') return code;
  if (code === 'AUTH_INVALID' || code === 'DEVICE_REVOKED') return 'AUTH_INVALID';
  return 'SYNC_ERROR';
}
