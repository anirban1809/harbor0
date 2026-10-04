import path from 'node:path';
import type { Journal } from './journal';
import type { SyncRuntime } from './sync-state';
import { localSyncId, type SyncDriveItem } from './sync-drive';

// A local projection only: unfinished files are never published as cloud files.
export function syncView(journal: Journal, state: SyncRuntime) {
  const jobs = journal.jobs();
  const driveItems = new Map<string, SyncDriveItem>();
  const folderIds: Record<string, string> = {};
  for (const root of journal.roots().filter((root) => root.mode === 'sync' && root.remoteId)) {
    const known = new Map(journal.folders(root.id).map((file) => [file.relativePath, file]));
    for (const file of known.values())
      if (file.type === 'FOLDER') folderIds[localSyncId(root.id, file.relativePath)] = file.itemId;
    const idFor = (relative: string): string =>
      relative === '.'
        ? root.remoteId!
        : (known.get(relative)?.itemId ?? localSyncId(root.id, relative));
    const rootJobs = jobs.filter(
      (job) =>
        job.rootId === root.id &&
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
  return {
    ...state,
    jobs: jobs.map(({ id, rootId, relativePath, kind, error, attempts }) => ({
      id,
      rootId,
      relativePath,
      kind,
      error,
      attempts,
    })),
    driveItems: [...driveItems.values()],
    folderIds,
    changes: Object.fromEntries(journal.changeSummaries()),
  };
}
