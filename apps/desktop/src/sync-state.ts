import type { Root } from './journal';
export type SyncIssueCode =
  | 'MAPPING_REQUIRED'
  | 'FOLDER_MISSING'
  | 'PERMISSION_DENIED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'DISK_FULL'
  | 'AUTH_INVALID'
  | 'CONFLICT'
  | 'SYNC_ERROR';
export type SyncIssue = {
  id: string;
  rootId: string;
  code: SyncIssueCode;
  message: string;
  relativePath?: string;
  conflictPath?: string;
  at: string;
};
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
  running: boolean;
  paused: boolean;
  online: boolean;
  message: string;
  queued: number;
  lastSync: string | null;
  active: SyncProgress | null;
  issues: SyncIssue[];
  recent: SyncActivityItem[];
};
export type SyncFolder = Root & {
  localPathDisplayName: string;
  localPathDisplay?: string;
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
export function folderState(root: SyncFolder, state: SyncRuntime, jobs: SyncJob[]) {
  const issues = state.issues?.filter((issue) => issue.rootId === root.id) ?? [];
  if (issues.some((issue) => issue.code === 'FOLDER_MISSING')) return 'Folder unavailable';
  if (issues.some((issue) => issue.code === 'CONFLICT')) return 'Conflict';
  if (issues.length) return 'Action required';
  if (state.paused || root.paused) return 'Paused';
  if (!state.online) return 'Offline';
  if (jobs.some((job) => job.rootId === root.id && job.error)) return 'Action required';
  if (state.active?.rootId === root.id || jobs.some((job) => job.rootId === root.id))
    return 'Syncing';
  return root.needsReconcile || state.confirmationPendingRoots?.includes(root.id)
    ? 'Syncing'
    : 'Up to date';
}
export function globalSyncState(roots: SyncFolder[], state: SyncRuntime, jobs: SyncJob[]) {
  const ids = new Set(roots.map((root) => root.id));
  if (state.issues?.some((issue) => ids.has(issue.rootId) || !issue.rootId))
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
  return 'Up to date';
}
export function syncIssueCode(error: unknown): SyncIssueCode {
  const code = (error as { code?: string })?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'FOLDER_MISSING';
  if (code === 'EACCES' || code === 'EPERM') return 'PERMISSION_DENIED';
  if (code === 'ENOSPC') return 'DISK_FULL';
  if (code === 'STORAGE_QUOTA_EXCEEDED') return code;
  if (code === 'AUTH_INVALID' || code === 'DEVICE_REVOKED') return 'AUTH_INVALID';
  return 'SYNC_ERROR';
}
