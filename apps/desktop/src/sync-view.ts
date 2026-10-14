import path from 'node:path';
import type { Journal, LocalJob } from './journal';
import type { SyncRuntime } from './sync-state';
import { localSyncId, type SyncDriveItem } from './sync-drive';

/**
 * A local projection only: unfinished files are never published as cloud files. `view` is the
 * folder the window shows (a cloud folder ID or a local-sync ID; null for none): only its pending
 * items are listed, read without loading the whole queue. Without it, every folder's are.
 */
export function syncView(journal: Journal, state: SyncRuntime, view?: string | null) {
  const viewing = view !== undefined;
  const driveItems = new Map<string, SyncDriveItem>();
  const folderIds: Record<string, string> = {};
  for (const root of journal.roots().filter((root) => root.mode === 'sync' && root.remoteId)) {
    // Where the viewed folder is in this root: '' for its top, 'a/b/' for a subfolder.
    let prefix: string | undefined;
    if (viewing && view) {
      const local = localSyncId(root.id, '');
      const known = view.startsWith(local) ? undefined : journal.fileByItem(root.id, view);
      if (view === root.remoteId) prefix = '';
      else if (view.startsWith(local)) prefix = decodeURIComponent(view.slice(local.length)) + '/';
      else if (known?.type === 'FOLDER') prefix = known.relativePath + '/';
    }
    if (viewing && prefix === undefined) continue;
    const known = new Map(journal.folders(root.id).map((file) => [file.relativePath, file]));
    for (const file of known.values())
      if (file.type === 'FOLDER') folderIds[localSyncId(root.id, file.relativePath)] = file.itemId;
    const idFor = (relative: string): string =>
      relative === '.'
        ? root.remoteId!
        : (known.get(relative)?.itemId ?? localSyncId(root.id, relative));
    // Backup folders show no pending files, so their queue, often the largest, is never read.
    let queued: LocalJob[];
    if (prefix === undefined) queued = journal.jobs(root.id);
    else {
      const { direct, deeper } = journal.pendingChildren(root.id, prefix);
      // The file being uploaded marks the subfolder it is in as syncing.
      const active = state.active?.rootId === root.id ? state.active.relativePath : undefined;
      const current =
        active?.startsWith(prefix) && journal.pendingJob(root.id, active, 'upsert')?.id;
      queued = [...new Set([...direct, ...deeper, ...(current ? [current] : [])])]
        .map((id) => journal.job(id))
        .filter((job): job is LocalJob => !!job);
    }
    const rootJobs = queued.filter(
      (job) =>
        !root.excluded.some(
          (excluded) =>
            job.relativePath === excluded || job.relativePath.startsWith(excluded + '/'),
        ),
    );
    for (const job of rootJobs) {
      if (job.kind === 'delete') continue;
      const tracked = journal.file(root.id, job.relativePath);
      if (tracked) known.set(job.relativePath, tracked);
      const active =
        state.active?.rootId === root.id && state.active.relativePath === job.relativePath
          ? state.active
          : null;
      const detail = job.error
        ? `Retry pending: ${job.error}`
        : state.paused || root.paused
          ? 'Sync is paused'
          : !state.online
            ? 'Waiting for a connection'
            : state.storageFull &&
                !root.shareId &&
                (job.payload.entry?.sizeBytes ?? Infinity) > state.storageFull.availableBytes
              ? 'Waiting for storage: your cloud storage is full'
              : 'Waiting to upload';
      let relative = job.relativePath;
      while (relative !== '.') {
        const file = known.get(relative);
        const isJob = relative === job.relativePath;
        const id = idFor(relative);
        const existing = driveItems.get(id);
        const syncing = !!active;
        const entry = job.payload.entry;
        driveItems.set(id, {
          ...existing,
          id,
          localId: localSyncId(root.id, relative),
          parentId: idFor(path.posix.dirname(relative)),
          name: path.posix.basename(relative),
          type: isJob ? (entry?.type ?? file?.type ?? 'FILE') : 'FOLDER',
          sizeBytes: isJob
            ? (entry?.sizeBytes ?? active?.total ?? job.payload.upload?.size ?? 0)
            : 0,
          updatedAt: isJob ? entry?.updatedAt : undefined,
          localOnly: !file,
          syncStatus: syncing || existing?.syncStatus === 'Syncing' ? 'Syncing' : 'Pending',
          syncDetail: syncing
            ? active.direction === 'upload'
              ? 'Uploading'
              : 'Downloading'
            : existing?.syncStatus === 'Syncing'
              ? existing.syncDetail
              : detail,
          syncProgress:
            isJob && active && active.total > 0
              ? Math.min(100, Math.round((active.loaded / active.total) * 100))
              : undefined,
        });
        relative = path.posix.dirname(relative);
      }
    }
    // Subfolders harbor0 may not read: nothing in them syncs, whatever the cloud copy says.
    for (const folder of state.unreadable?.[root.id] ?? []) {
      const id = idFor(folder);
      driveItems.set(id, {
        id,
        localId: localSyncId(root.id, folder),
        parentId: idFor(path.posix.dirname(folder)),
        name: path.posix.basename(folder),
        type: 'FOLDER',
        sizeBytes: 0,
        localOnly: !known.has(folder),
        syncStatus: 'Not synced',
        syncDetail:
          'harbor0 does not have permission to read this folder. It syncs once its permissions are fixed.',
      });
    }
    // Downloads already exist in the cloud, but still need a visible local sync status.
    const active = state.active;
    if (active?.rootId === root.id && active.direction === 'download') {
      const tracked = journal.file(root.id, active.relativePath);
      if (tracked) known.set(active.relativePath, tracked);
      const id = idFor(active.relativePath);
      driveItems.set(id, {
        id,
        parentId: idFor(path.posix.dirname(active.relativePath)),
        name: path.posix.basename(active.relativePath),
        type: 'FILE',
        sizeBytes: active.total,
        localOnly: !known.has(active.relativePath),
        syncStatus: 'Syncing',
        syncDetail: 'Downloading',
        syncProgress:
          active.total > 0
            ? Math.min(100, Math.round((active.loaded / active.total) * 100))
            : undefined,
      });
    }
  }
  // A viewed folder's own items; the walk above also passes through the folders around them.
  const shown = viewing ? (view ? (folderIds[view] ?? view) : null) : undefined;
  return {
    ...state,
    // Enough to tell which folders are busy or failing; the full queue can be enormous.
    jobs: journal.jobSummary(),
    driveItems: [...driveItems.values()].filter(
      (item) => shown === undefined || item.parentId === shown,
    ),
    folderIds: viewing ? (view && folderIds[view] ? { [view]: folderIds[view] } : {}) : folderIds,
    changes: Object.fromEntries(journal.changeSummaries()),
    // Live, unlike the folder list the page loaded earlier.
    reconciling: journal
      .roots()
      .filter((root) => root.needsReconcile)
      .map((root) => root.id),
  };
}
