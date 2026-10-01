import path from 'node:path';
import os from 'node:os';
import { FolderBackups, backupReady } from './backups';
import { SyncReceipts } from './sync-receipts';
import { mkdir, lstat, rename, rm, access, readdir } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import {
  stickyIssue,
  syncIssueCode,
  type SyncRuntime,
  type SyncIssue,
  type SyncActivityItem,
} from './sync-state';
import chokidar, { type FSWatcher } from 'chokidar';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { Journal, type Root, type LocalJob } from './journal';
import {
  contained,
  internalPath,
  metadataSegment,
  recoveredName,
  safeParents,
  safeSegment,
  conflictName,
} from './paths';
import { uploadFile, downloadFile, hashFile, type UploadState } from './transfers';
// Failed files and folders retry with growing delays (4s up to 5 minutes).
const retryDelay = (attempts: number) => Math.min(300_000, 2000 * 2 ** Math.min(attempts, 10));
// Remote checks start every 2s and back off to 30s while nothing changes;
// local edits, remote changes and wake() return to the fast rate.
export const REMOTE_POLL_MIN = 2000;
export const REMOTE_POLL_MAX = 30_000;
// With live updates connected, polling is only a safety net for missed messages.
export const REMOTE_POLL_LIVE = 5 * 60_000;
export class SyncEngine {
  private receipts: SyncReceipts;
  private backups: FolderBackups;
  private watchers = new Map<string, FSWatcher>();
  private timer?: ReturnType<typeof setInterval>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private queueEmitTimer?: ReturnType<typeof setTimeout>;
  private pendingWake = false;
  private lastProgressEmit = 0;
  private running = false;
  private stopped = false;
  private work?: Promise<void>;
  private mutation = Promise.resolve();
  private currentRootId = '';
  private publishedFolders = '';
  private publishingFolders = false;
  private publishWork?: Promise<void>;
  private publishRetryAt = 0;
  private publishedAt = 0;
  private removedRemoteIds = new Set<string>();
  private confirmationWork?: Promise<void>;
  private confirmationController = new AbortController();
  private nextConfirmationAt = 0;
  private rootRetry = new Map<string, { attempts: number; at: number }>();
  private waiting = new Map<string, { rootId: string; relativePath: string }>();
  private remoteDelay = REMOTE_POLL_MIN;
  private maxDelay = REMOTE_POLL_MAX;
  private nextRemoteAt = 0;
  private checkpointed?: number;
  private hurried = false;
  state: SyncRuntime = {
    running: false,
    paused: false,
    online: true,
    message: 'Ready',
    queued: 0,
    lastSync: null,
    active: null,
    issues: [],
    recent: [],
  };
  constructor(
    private api: ApiClient,
    private journal: Journal,
    private deviceId: string,
    private changed: (state: unknown) => void,
  ) {
    this.receipts = new SyncReceipts(api, journal);
    this.backups = new FolderBackups(api, journal);
    this.state.lastSync = journal.get<string>('lastSync') ?? null;
    // An ended session returns the app to sign-in by itself; never restore that as a sync problem.
    this.state.issues = (journal.get<SyncIssue[]>('syncIssues') ?? []).filter(
      (issue) => issue.code !== 'AUTH_INVALID',
    );
    this.state.recent = journal.get<SyncActivityItem[]>('syncRecent') ?? [];
  }
  async start() {
    this.stopped = false;
    this.confirmationController = new AbortController();
    this.nextConfirmationAt = 0;
    this.remoteDelay = REMOTE_POLL_MIN;
    this.nextRemoteAt = 0;
    for (let root of this.journal.roots()) {
      if (root.mode === 'sync' && !root.remoteId) {
        root = { ...root, paused: true };
        this.journal.root(root);
        this.state.issues = this.state.issues.filter(
          (issue) => issue.rootId !== root.id || stickyIssue(issue),
        );
        this.state.issues.push({
          id: `${root.id}:mapping`,
          rootId: root.id,
          code: 'MAPPING_REQUIRED',
          message: 'Choose a cloud folder for this local folder before syncing resumes.',
          at: new Date().toISOString(),
        });
        this.persistIssues();
      }
      if (root.mode === 'sync') this.journal.root({ ...root, needsReconcile: true });
      // An archived folder has no local copy to watch until it is restored.
      if (root.archive === 'archived' || root.archive === 'restoring') continue;
      if (await this.checkRoot(root)) await this.watch(root);
    }
    this.timer = setInterval(() => void this.run(), REMOTE_POLL_MIN);
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    this.confirmationController.abort();
    await this.confirmationWork;
    this.pendingWake = false;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (this.queueEmitTimer) clearTimeout(this.queueEmitTimer);
    this.queueEmitTimer = undefined;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
    await this.work;
    await this.publishWork;
  }
  private ignored(root: Root, relative: string) {
    return (
      internalPath(relative) ||
      root.excluded.some((p) => relative === p || relative.startsWith(p + '/'))
    );
  }
  async watch(root: Root) {
    const watcher = chokidar.watch(root.localPath, {
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
      ignored: (p) =>
        this.ignored(root, path.relative(root.localPath, p).split(path.sep).join('/')),
    });
    const queue =
      (kind: 'upsert' | 'delete', changed = false) =>
      (full: string, info?: Stats) => {
        const relative = path.relative(root.localPath, full).split(path.sep).join('/');
        const current = this.journal.roots().find((entry) => entry.id === root.id);
        if (current && relative && !this.ignored(current, relative)) {
          this.journal.enqueue(
            root.id,
            relative,
            kind,
            info
              ? {
                  type: info.isDirectory() ? 'FOLDER' : 'FILE',
                  sizeBytes: info.size,
                  updatedAt: info.mtime.toISOString(),
                }
              : undefined,
          );
          if (current.mode === 'backup' && changed) {
            const job = this.journal
              .jobs()
              .find((j) => j.rootId === root.id && j.relativePath === relative && j.kind === kind);
            if (job) {
              job.payload.observedAt = Date.now();
              this.journal.saveJob(job);
            }
          }
          // Batch large directory scans while still showing new files promptly,
          // including when paused (when no sync tick will run).
          if (!this.queueEmitTimer)
            this.queueEmitTimer = setTimeout(() => {
              this.queueEmitTimer = undefined;
              this.emit();
            }, 50);
          this.hurry();
          this.scheduleTick();
        }
      };
    watcher
      .on('add', queue('upsert'))
      .on('change', queue('upsert', true))
      .on('addDir', queue('upsert'))
      .on('unlink', queue('delete'))
      .on('unlinkDir', queue('delete'))
      .on('error', (error) => this.issue(root.id, error));
    this.watchers.set(root.id, watcher);
  }
  // The next tick checks the server instead of waiting out the idle backoff.
  private hurry() {
    this.hurried = true;
    this.remoteDelay = REMOTE_POLL_MIN;
    this.nextRemoteAt = 0;
    this.receipts.nudge();
  }
  /** Live updates push changes, so idle checks can wait longer while connected. */
  setLive(connected: boolean) {
    this.maxDelay = connected ? REMOTE_POLL_LIVE : REMOTE_POLL_MAX;
    if (!connected) {
      this.remoteDelay = Math.min(this.remoteDelay, REMOTE_POLL_MAX);
      this.nextRemoteAt = Math.min(this.nextRemoteAt, Date.now() + REMOTE_POLL_MAX);
    }
  }
  /** Check the server now, e.g. when the window gains focus or the computer wakes. */
  wake() {
    this.hurry();
    this.scheduleTick();
  }
  private scheduleTick() {
    if (this.stopped || this.state.paused) return;
    if (this.running) {
      this.pendingWake = true;
      return;
    }
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.run();
    }, 150);
  }
  pause(paused: boolean) {
    this.state.paused = paused;
    this.journal.set('paused', paused);
    if (!paused) {
      for (const root of this.journal.roots())
        if (root.mode === 'sync') this.journal.root({ ...root, needsReconcile: true });
      // Resuming is also the user's way to retry failed work now.
      this.rootRetry.clear();
      this.hurry();
      for (const job of this.journal.jobs())
        if (job.payload.retryAt) {
          delete job.payload.retryAt;
          this.journal.saveJob(job);
        }
    }
    this.emit();
  }
  private emit(progressOnly = false) {
    const now = Date.now();
    if (progressOnly && now - this.lastProgressEmit < 100) return;
    this.lastProgressEmit = now;
    this.state.queued = this.journal.jobCount();
    this.state.waiting = [...this.waiting.values()];
    this.changed({ ...this.state });
  }
  validateRoot(root: Root) {
    if (root.mode === 'sync' && !root.remoteId)
      throw new Error('Choose a cloud folder before syncing.');
    for (const other of this.journal.roots().filter((other) => other.id !== root.id)) {
      const rel = path.relative(other.localPath, root.localPath);
      const reverse = path.relative(root.localPath, other.localPath);
      if (
        !rel ||
        (!rel.startsWith('..') && !path.isAbsolute(rel)) ||
        (!reverse.startsWith('..') && !path.isAbsolute(reverse))
      )
        throw new Error('Sync and backup folders must not overlap.');
      if (root.mode === 'sync' && other.mode === 'sync' && root.remoteId === other.remoteId)
        throw new Error('This cloud folder is already synchronized on this computer.');
    }
  }
  private changeConfiguration(change: () => void) {
    const task = this.mutation.then(async () => {
      // Finish the current transfer before detaching its mapping; no files are deleted.
      await this.stop();
      await this.work;
      try {
        change();
      } finally {
        await this.start();
      }
    });
    this.mutation = task.catch(() => {});
    return task;
  }
  async disconnectBackup(id: string) {
    const root = this.journal.roots().find((r) => r.id === id && r.mode === 'backup');
    if (!root) throw new Error('Backup folder was not found on this computer.');
    const roots = (await this.api.request('/v1/backups')).items;
    const backup = roots.find(
      (entry: { remoteRootDriveItemId: string }) => entry.remoteRootDriveItemId === root.remoteId,
    );
    if (!backup) throw new Error('Backup connection was not found.');
    await this.api.request(`/v1/backups/${backup.id}`, { method: 'DELETE' });
    await this.removeRoot(root.id);
  }
  /** Archive: one last full backup, then the local copy is removed and only the cloud copy stays. */
  async archiveBackup(id: string, archived: boolean) {
    const root = this.journal.roots().find((r) => r.id === id && r.mode === 'backup');
    if (!root) throw new Error('Backup folder was not found on this computer.');
    if (this.state.paused || root.paused)
      throw new Error(`Resume backups before ${archived ? 'archiving' : 'restoring'} this folder.`);
    if (archived) {
      if (root.archive) throw new Error('This folder is already archived.');
      this.journal.root({ ...root, archive: 'pending', archiveError: undefined });
      this.journal.set(`backup-now:${root.id}`, true);
    } else {
      if (root.archive !== 'archived') throw new Error('This folder is not archived.');
      this.validateRoot(root);
      this.journal.root({ ...root, archive: 'restoring' });
    }
    this.emit();
    this.wake();
    return { queued: true };
  }
  async backupNow(id: string) {
    const root = this.journal.roots().find((r) => r.id === id && r.mode === 'backup');
    if (!root) throw new Error('Backup folder was not found on this computer.');
    if (this.state.paused) throw new Error('Resume backups before backing up now.');
    if (root.archive) throw new Error('Restore this archived folder before backing up.');
    await this.backups.request(root);
    this.wake();
    return { queued: true };
  }
  async addRoot(root: Root) {
    this.validateRoot(root);
    await this.changeConfiguration(() => {
      this.validateRoot(root);
      this.journal.root({ ...root, needsReconcile: root.mode === 'sync' });
    });
  }
  async updateRoot(root: Root) {
    this.validateRoot(root);
    await this.changeConfiguration(() => {
      this.validateRoot(root);
      const previous = this.journal.roots().find((item) => item.id === root.id);
      if (!previous) throw new Error('Folder was not found.');
      if (previous.localPath !== root.localPath || previous.remoteId !== root.remoteId)
        this.journal.resetRootFiles(root.id);
      this.journal.root({ ...root, needsReconcile: root.mode === 'sync' });
      this.rootRetry.delete(root.id);
      this.state.issues = this.state.issues.filter(
        (issue) => issue.rootId !== root.id || stickyIssue(issue),
      );
      this.persistIssues();
    });
  }
  async removeSyncedFolder(folderId: string) {
    await this.api.request(`/v1/sync/folders/${folderId}`, { method: 'DELETE' });
    await this.changeConfiguration(() => {
      for (const root of this.journal.roots()) {
        if (root.mode !== 'sync') continue;
        if (root.remoteId === folderId) this.journal.removeRoot(root.id);
        else this.excludeRemovedFolder(root, folderId);
      }
      this.state.issues = this.state.issues.filter((issue) =>
        this.journal.roots().some((r) => r.id === issue.rootId),
      );
      this.persistIssues();
    });
  }
  private excludeRemovedFolder(root: Root, folderId: string) {
    const known = this.journal.fileByItem(root.id, folderId);
    if (!known || known.type !== 'FOLDER') return;
    this.journal.root({ ...root, excluded: [...new Set([...root.excluded, known.relativePath])] });
    for (const job of this.journal.jobs())
      if (
        job.rootId === root.id &&
        (job.relativePath === known.relativePath ||
          job.relativePath.startsWith(known.relativePath + '/'))
      )
        this.journal.finish(job.id);
    for (const file of this.journal.files(root.id))
      if (
        file.relativePath === known.relativePath ||
        file.relativePath.startsWith(known.relativePath + '/')
      )
        this.journal.deleteFile(root.id, file.relativePath);
  }
  private async detachRoot(root: Root) {
    await this.watchers.get(root.id)?.close();
    this.watchers.delete(root.id);
    this.journal.removeRoot(root.id);
    this.forgetWaiting(root.id);
    this.state.issues = this.state.issues.filter((issue) => issue.rootId !== root.id);
    this.persistIssues();
    this.emit();
  }
  async removeRoot(id: string) {
    await this.changeConfiguration(() => {
      this.journal.removeRoot(id);
      this.state.issues = this.state.issues.filter((issue) => issue.rootId !== id);
      this.persistIssues();
    });
  }
  dismissConflict(id: string) {
    this.state.issues = this.state.issues.filter((issue) => issue.id !== id || !stickyIssue(issue));
    this.persistIssues();
    this.emit();
  }
  private persistIssues() {
    this.journal.set('syncIssues', this.state.issues);
  }
  private forgetWaiting(rootId: string) {
    for (const [id, item] of this.waiting) if (item.rootId === rootId) this.waiting.delete(id);
  }
  // Errors that are not about one file or folder: stop the pass and retry everything later.
  private interrupts(error: unknown) {
    if (error instanceof ApiError)
      return (
        error.status >= 500 ||
        error.status === 429 ||
        ['AUTH_INVALID', 'DEVICE_REVOKED', 'SYNC_REMOVED', 'SYNC_CURSOR_EXPIRED'].includes(
          error.code,
        )
      );
    return (
      error instanceof TypeError ||
      ['AbortError', 'TimeoutError'].includes((error as Error | undefined)?.name ?? '')
    );
  }
  private rootFailed(root: Root, error: unknown) {
    const attempts = (this.rootRetry.get(root.id)?.attempts ?? 0) + 1;
    this.rootRetry.set(root.id, { attempts, at: Date.now() + retryDelay(attempts) });
    // A full reconcile repairs whatever this pass could not apply.
    const current = this.journal.roots().find((item) => item.id === root.id);
    if (current && !current.needsReconcile) this.journal.root({ ...current, needsReconcile: true });
    this.issue(root.id, error);
  }
  private issue(rootId: string, error: unknown, relativePath?: string, jobId?: string) {
    const root = this.journal.roots().find((item) => item.id === rootId);
    const failedPath = (error as NodeJS.ErrnoException)?.path;
    // Filesystem errors below the folder itself concern one item, not the folder's own access.
    const inside =
      root && typeof failedPath === 'string' ? path.relative(root.localPath, failedPath) : '';
    const nested = !!inside && !inside.startsWith('..') && !path.isAbsolute(inside);
    const item = !!jobId || nested;
    const code = syncIssueCode(error, item);
    this.state.issues = this.state.issues.filter(
      (issue) =>
        issue.rootId !== rootId ||
        stickyIssue(issue) ||
        (jobId ? issue.jobId !== jobId : !!issue.jobId),
    );
    this.state.issues.push({
      id: jobId ? `job:${jobId}` : `${rootId}:${code}`,
      rootId,
      code,
      relativePath: relativePath ?? (nested ? inside.split(path.sep).join('/') : undefined),
      message: (error as Error).message,
      at: new Date().toISOString(),
      ...(jobId ? { jobId } : {}),
      ...(item ? { scope: 'item' as const } : {}),
    });
    this.persistIssues();
    this.emit();
  }
  private deviceName() {
    return this.journal.get<string>('deviceName') || os.hostname();
  }
  private recovered(root: Root, relativePath: string, recoveredPath: string) {
    this.state.issues.push({
      id: crypto.randomUUID(),
      rootId: root.id,
      code: 'FOLDER_RECOVERED',
      relativePath,
      conflictPath: recoveredPath,
      message:
        'This folder was removed from sync elsewhere. The copy on this computer was kept under a new name and no longer syncs.',
      at: new Date().toISOString(),
    });
    this.persistIssues();
    this.emit();
  }
  private conflict(root: Root, relativePath: string, conflictPath: string) {
    this.state.issues.push({
      id: crypto.randomUUID(),
      rootId: root.id,
      code: 'CONFLICT',
      relativePath,
      conflictPath,
      message:
        'This file changed in more than one place. Your local version has been preserved separately.',
      at: new Date().toISOString(),
    });
    this.persistIssues();
    this.emit();
  }
  private activity(
    root: Root,
    relativePath: string,
    direction: 'upload' | 'download',
    item?: DriveItem,
  ) {
    const at = new Date().toISOString();
    this.state.recent = [
      { id: crypto.randomUUID(), rootId: root.id, direction, relativePath, at, item },
      ...this.state.recent,
    ].slice(0, 30);
    this.journal.set('syncRecent', this.state.recent);
    const current = this.journal.roots().find((item) => item.id === root.id);
    if (current) this.journal.root({ ...current, lastSyncedAt: at });
    // Upload jobs remain active until their queue entry has been removed.
    if (direction === 'download') {
      this.state.active = null;
      this.emit();
    }
  }
  private async checkRoot(root: Root) {
    try {
      const info = await lstat(root.localPath);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Object.assign(new Error('The local folder is unavailable.'), { code: 'ENOTDIR' });
      await access(root.localPath, constants.R_OK | constants.W_OK);
      return true;
    } catch (error) {
      if (root.mode === 'sync') this.journal.root({ ...root, needsReconcile: true });
      this.issue(root.id, error);
      return false;
    }
  }
  async reconcile(root: Root) {
    if (root.mode === 'backup' || root.paused || this.state.paused || this.stopped) return;
    const seen = new Set<string>();
    this.forgetWaiting(root.id);
    const walk = async (parent: string | null) => {
      let cursor: string | undefined;
      do {
        const page = await this.api.list(parent, cursor);
        for (const item of page.items) {
          if (this.stopped || this.state.paused) return;
          seen.add(item.id);
          const relative = await this.relative(root, item);
          if (relative === null || this.ignored(root, relative)) continue;
          const known = this.journal.fileByItem(root.id, item.id);
          const pending = this.journal
            .jobs()
            .some((job) => job.rootId === root.id && job.relativePath === relative);
          // A shared-folder scan can be triggered by an unrelated sibling edit.
          // Do not overwrite this device's queued edits/deletes when this item is unchanged.
          if (!(
            pending &&
            known?.revision === item.revision &&
            known.relativePath === relative &&
            item.cloudState !== 'REQUESTED'
          ))
            await this.remoteItem(root, item);
          if (item.type === 'FOLDER') await walk(item.id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    };
    const rootItem = (await this.api.request(`/v1/drive/items/${root.remoteId}`)).item;
    if (rootItem) this.receipts.queue(root, '.', rootItem, null);
    await walk(root.remoteId);
    // Paused or unavailable folders can miss feed events while other folders advance
    // the device cursor. Check tracked items absent from the current subtree.
    for (const known of this.journal.files(root.id)) {
      if (this.stopped || this.state.paused) return;
      if (seen.has(known.itemId) || this.ignored(root, known.relativePath)) continue;
      try {
        const { item } = await this.api.request(`/v1/drive/items/${known.itemId}`);
        await this.remoteItem(root, item);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'SYNC_REMOVED') continue;
        if (
          !(error instanceof ApiError) ||
          !['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND', ...(root.shareId ? ['FORBIDDEN'] : [])].includes(
            error.code,
          )
        )
          throw error;
        if (root.shareId) await this.api.request(`/v1/sync/shares/${root.shareId}/status`);
        await this.remoteItem(root, {
          id: known.itemId,
          revision: known.revision + 1,
          deletedAt: new Date().toISOString(),
        } as DriveItem);
      }
    }
  }
  private async publishSyncFolders() {
    const folderIds = this.journal
      .roots()
      .filter((root) => root.mode === 'sync' && root.remoteId)
      .map((root) => root.remoteId!)
      .sort();
    const signature = JSON.stringify(folderIds);
    if (
      this.publishingFolders ||
      (signature === this.publishedFolders && Date.now() - this.publishedAt < 60000) ||
      Date.now() < this.publishRetryAt
    )
      return;
    this.publishingFolders = true;
    try {
      const response = await this.api.request('/v1/sync/folders', {
        method: 'PUT',
        body: { folderIds },
        signal: AbortSignal.timeout(8000),
      });
      for (const id of response.removedFolderIds ?? []) this.removedRemoteIds.add(id);
      this.publishedFolders = signature;
      this.publishedAt = Date.now();
      this.publishRetryAt = 0;
    } catch {
      // Retry while offline without interrupting file transfers or local configuration changes.
      this.publishRetryAt = Date.now() + 15000;
    } finally {
      this.publishingFolders = false;
    }
  }
  private confirmStatus() {
    if (
      this.stopped ||
      this.state.paused ||
      this.confirmationWork ||
      Date.now() < this.nextConfirmationAt
    )
      return;
    const signal = this.confirmationController.signal;
    this.confirmationWork = (async () => {
      try {
        await this.receipts.flush(signal);
        if (!signal.aborted) await this.receipts.audit(signal);
        if (!signal.aborted) await this.receipts.flush(signal);
      } catch {
        // Keep the durable outbox and retry independently of file transfer work.
      } finally {
        this.confirmationWork = undefined;
        this.nextConfirmationAt = Date.now() + 5000;
        if (!signal.aborted) {
          this.state.confirmationPendingRoots = this.receipts.pendingRoots();
          if (!this.state.active && !this.journal.jobCount() && !this.state.issues.length) {
            if (this.state.confirmationPendingRoots.length)
              this.state.message = 'Files transferred; waiting for backend confirmation';
            else if (this.state.message === 'Files transferred; waiting for backend confirmation')
              this.state.message = 'Everything is up to date';
          }
          this.emit();
        }
      }
    })();
  }
  /** Run a full sync pass now, including the server check. */
  async tick() {
    this.hurry();
    return this.run();
  }
  private async run() {
    if (!this.stopped && !this.publishingFolders) this.publishWork = this.publishSyncFolders();
    this.confirmStatus();
    if (this.running || this.stopped || (this.state.paused && !this.removedRemoteIds.size)) return;
    this.work = this.runTick();
    return this.work;
  }
  private async runTick() {
    this.running = true;
    this.state.running = true;
    // Local work runs every tick; server checks only when due.
    const remote = Date.now() >= this.nextRemoteAt;
    let active = false;
    this.hurried = false;
    try {
      for (const root of this.journal.roots())
        if (root.mode === 'sync' && root.remoteId && this.removedRemoteIds.has(root.remoteId))
          await this.detachRoot(root);
      this.removedRemoteIds.clear();
      const available = new Set<string>();
      for (let root of this.journal.roots()) {
        if (this.stopped || this.state.paused) return;
        if (root.shareId && remote) {
          try {
            const status = await this.api.request(`/v1/sync/shares/${root.shareId}/status`);
            if (root.sharedSequence !== status.sequence) {
              root = { ...root, needsReconcile: true, sharedSequence: status.sequence };
              this.journal.root(root);
            }
          } catch (error) {
            if (
              error instanceof ApiError &&
              [
                'SYNC_ACCESS_REMOVED',
                'FORBIDDEN',
                'SYNC_REMOVED',
                'ITEM_NOT_FOUND',
                'PARENT_NOT_FOUND',
              ].includes(error.code)
            ) {
              await this.detachRoot(root);
              continue;
            }
            throw error;
          }
        }
        if (root.archive === 'archived') continue;
        if (root.archive === 'restoring' && !root.paused)
          await mkdir(root.localPath, { recursive: true });
        if (root.paused || !(await this.checkRoot(root))) continue;
        if (
          root.mode === 'sync' &&
          this.state.issues.some(
            (issue) => issue.rootId === root.id && issue.code === 'FOLDER_MISSING' && !issue.scope,
          )
        ) {
          // A disappearing volume can generate unlink events for every child.
          // Rebuild the mapping on recovery instead of replaying those deletions.
          this.journal.resetRootFiles(root.id);
        }
        if (!this.watchers.has(root.id)) await this.watch(root);
        available.add(root.id);
        this.currentRootId = root.id;
        // Keep a problem visible while its file or folder is still waiting to retry.
        const retrying = (this.rootRetry.get(root.id)?.at ?? 0) > Date.now();
        const queued = new Set(this.journal.jobs().map((job) => job.id));
        this.state.issues = this.state.issues.filter(
          (issue) =>
            issue.rootId !== root.id ||
            stickyIssue(issue) ||
            (issue.jobId ? queued.has(issue.jobId) : retrying),
        );
        if (root.needsReconcile && root.mode === 'sync' && !retrying) {
          try {
            await this.reconcile(root);
          } catch (error) {
            if (this.interrupts(error)) throw error;
            // One blocked folder must not stop the others or this folder's own uploads.
            this.rootFailed(root, error);
            continue;
          }
          if (this.stopped || this.state.paused) return;
          active = true;
          this.rootRetry.delete(root.id);
          const current = this.journal.roots().find((item) => item.id === root.id);
          if (current) this.journal.root({ ...current, needsReconcile: false });
        }
      }
      for (const root of this.journal
        .roots()
        // Backup runs wait for the server check; an archive in progress keeps the fast rate.
        .filter(
          (r) => r.mode === 'backup' && !r.paused && available.has(r.id) && (remote || r.archive),
        )) {
        if (this.stopped || this.state.paused) return;
        if (root.archive) active = true;
        this.currentRootId = root.id;
        const stopped = () => this.stopped || this.state.paused;
        try {
          if (root.archive === 'restoring') {
            this.state.message = 'Restoring archived folder';
            await this.backups.unarchive(root, stopped);
            continue;
          }
          if (root.archive !== 'removing')
            await this.backups.process(root, (r, job) => this.localJob(r, job), stopped);
          const current = this.journal.roots().find((r) => r.id === root.id);
          if (current?.archive && !stopped())
            await this.backups.archive(
              current,
              async () => {
                await this.watchers.get(root.id)?.close();
                this.watchers.delete(root.id);
              },
              stopped,
            );
        } catch (error) {
          if (error instanceof ApiError && error.code === 'BACKUP_DISCONNECTED')
            await this.detachRoot(root);
          else throw error;
        }
      }
      const full = new Set<string>();
      for (const job of this.journal.jobs()) {
        if (this.stopped || this.state.paused) return;
        const root = this.journal.roots().find((r) => r.id === job.rootId);
        if (
          !root ||
          root.mode === 'backup' ||
          !available.has(root.id) ||
          root.paused ||
          this.ignored(root, job.relativePath) ||
          (job.payload.retryAt ?? 0) > Date.now() ||
          (job.kind === 'upsert' && full.has(root.id))
        )
          continue;
        active = true;
        this.currentRootId = root.id;
        try {
          await this.localJob(root, job);
          this.journal.finish(job.id);
          if (this.state.issues.some((issue) => issue.jobId === job.id)) {
            this.state.issues = this.state.issues.filter((issue) => issue.jobId !== job.id);
            this.persistIssues();
          }
          this.state.active = null;
          this.emit();
        } catch (e) {
          job.attempts++;
          job.error = (e as Error).message;
          if (this.interrupts(e)) {
            this.journal.saveJob(job);
            throw e;
          }
          // One failing file waits for its own retry; the rest of the queue keeps moving.
          job.payload.retryAt = Date.now() + retryDelay(job.attempts);
          this.journal.saveJob(job);
          // Every further upload would fail the same way until storage is freed.
          if (e instanceof ApiError && e.code === 'STORAGE_QUOTA_EXCEEDED') full.add(root.id);
          this.issue(root.id, e, job.relativePath, job.id);
          this.state.active = null;
        }
      }
      if (this.stopped || this.state.paused || !remote) return;
      this.currentRootId = '';
      let cursor = this.journal.get<number>('cursor') ?? 0;
      let more = true;
      while (more && !this.stopped) {
        const page = await this.api.changes(cursor);
        if (page.changes.length) active = true;
        for (const change of page.changes) {
          if (change.type === 'BACKUP_DISCONNECTED')
            for (const root of this.journal
              .roots()
              .filter((r) => r.mode === 'backup' && r.remoteId === change.entityId))
              await this.detachRoot(root);
          if (change.type === 'SYNC_FOLDER_REMOVED')
            for (const root of this.journal.roots().filter((r) => r.mode === 'sync')) {
              if (root.remoteId === change.entityId) await this.detachRoot(root);
              else this.excludeRemovedFolder(root, change.entityId);
            }
          // Folders waiting to retry are repaired by their next reconcile instead.
          const targets = () =>
            this.journal
              .roots()
              .filter(
                (r) =>
                  r.mode === 'sync' &&
                  !r.shareId &&
                  !r.paused &&
                  available.has(r.id) &&
                  !this.rootRetry.has(r.id),
              );
          const apply = async (root: Root, work: () => Promise<void>) => {
            this.currentRootId = root.id;
            try {
              await work();
            } catch (error) {
              if (this.interrupts(error)) throw error;
              this.rootFailed(root, error);
            }
          };
          if (change.type === 'TRANSFER_SAVED')
            for (const root of targets()) await apply(root, () => this.reconcile(root));
          const item = change.item;
          if (item)
            for (const root of targets()) await apply(root, () => this.remoteItem(root, item));
        }
        cursor = page.nextCursor;
        this.journal.set('cursor', cursor);
        more = page.hasMore;
      }
      if (this.stopped || this.state.paused) return;
      this.currentRootId = '';
      this.state.issues = this.state.issues.filter(
        (issue) => issue.rootId !== '' || stickyIssue(issue),
      );
      this.persistIssues();
      // Each checkpoint is a database write; only send one when the cursor moved.
      if (cursor !== this.checkpointed) {
        await this.api.request('/v1/sync/checkpoints', {
          method: 'POST',
          body: { deviceId: this.deviceId, cursor },
        });
        this.checkpointed = cursor;
      }
      this.state.online = true;
      this.state.lastSync = new Date().toISOString();
      this.journal.set('lastSync', this.state.lastSync);
      this.state.confirmationPendingRoots = this.receipts.pendingRoots();
      this.state.message = this.state.confirmationPendingRoots.length
        ? 'Files transferred; waiting for backend confirmation'
        : 'Everything is up to date';
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SYNC_REMOVED') {
        const root = this.journal.roots().find((r) => r.id === this.currentRootId);
        if (root) {
          try {
            await this.api.request(`/v1/drive/items/${root.remoteId}`);
          } catch (rootError) {
            if (rootError instanceof ApiError && rootError.code === 'SYNC_REMOVED')
              await this.detachRoot(root);
          }
          const folderId = (e.details as { folderId?: string } | undefined)?.folderId;
          if (folderId && this.journal.roots().some((r) => r.id === root.id))
            this.excludeRemovedFolder(root, folderId);
        }
        return;
      }
      if (e instanceof ApiError && e.code === 'SYNC_CURSOR_EXPIRED') {
        for (const root of this.journal.roots())
          if (root.mode === 'sync') this.journal.root({ ...root, needsReconcile: true });
        this.journal.set('cursor', 0);
      }
      this.state.online = !(e instanceof TypeError);
      this.state.message = (e as Error).message;
      // An ended session returns the app to sign-in by itself; there is nothing to fix here.
      const sessionEnded =
        e instanceof ApiError &&
        (e.status === 401 || ['AUTH_INVALID', 'DEVICE_REVOKED'].includes(e.code));
      if (
        !(e instanceof TypeError) &&
        !sessionEnded &&
        !(e instanceof ApiError && e.code === 'SYNC_CURSOR_EXPIRED') &&
        !this.state.issues.some(
          (issue) => issue.rootId === this.currentRootId && !stickyIssue(issue),
        )
      )
        this.issue(this.currentRootId, e);
      if (e instanceof ApiError && ['DEVICE_REVOKED', 'AUTH_INVALID'].includes(e.code))
        this.state.paused = true;
    } finally {
      // Activity keeps checks every 2s; each quiet or failed check doubles the wait.
      if (active) {
        this.remoteDelay = REMOTE_POLL_MIN;
        this.nextRemoteAt = remote ? Date.now() + REMOTE_POLL_MIN : 0;
        this.receipts.nudge();
      } else if (remote) {
        this.remoteDelay = Math.min(this.maxDelay, this.remoteDelay * 2);
        this.nextRemoteAt = Date.now() + this.remoteDelay;
      }
      // A wake() during this tick still gets its immediate check.
      if (this.hurried) this.hurry();
      this.confirmStatus();
      this.running = false;
      if (this.pendingWake) {
        this.pendingWake = false;
        this.scheduleTick();
      }
      this.state.running = false;
      this.state.active = null;
      this.emit();
    }
  }
  private async child(parentId: string | null, name: string) {
    let cursor: string | undefined;
    do {
      const page = await this.api.list(parentId, cursor);
      const item = page.items.find((i) => i.normalizedName === name.normalize('NFC').toLowerCase());
      if (item) return item;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return undefined;
  }
  private async ensureFolder(
    name: string,
    parentId: string | null,
    operationId: string = crypto.randomUUID(),
    backup?: { rootId: string; runId: string },
  ) {
    try {
      return backup
        ? (
            await this.api.request(`/v1/backups/${backup.rootId}/runs/${backup.runId}/folders`, {
              method: 'POST',
              body: { name, parentId, operationId },
            })
          ).item
        : (await this.api.createFolder(name, parentId, operationId)).item;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NAME_CONFLICT') {
        const existing = await this.child(parentId, name);
        if (existing?.type === 'FOLDER') return existing;
      }
      throw e;
    }
  }
  private async remoteParent(
    root: Root,
    relative: string,
    backup?: { rootId: string; runId: string },
  ): Promise<string | null> {
    const dirname = path.posix.dirname(relative);
    if (dirname === '.') return root.remoteId;
    const cached = this.journal.file(root.id, dirname);
    if (cached) return cached.itemId;
    const parentId = await this.remoteParent(root, dirname, backup);
    const item = await this.ensureFolder(path.posix.basename(dirname), parentId, undefined, backup);
    this.journal.putFile({
      rootId: root.id,
      relativePath: dirname,
      itemId: item.id,
      revision: item.revision,
      hash: null,
      type: 'FOLDER',
    });
    return item.id;
  }
  private async localJob(root: Root, job: LocalJob) {
    const absolute = contained(root.localPath, job.relativePath);
    let known = this.journal.file(root.id, job.relativePath);
    if (job.kind === 'delete') {
      try {
        await lstat(absolute);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (root.mode === 'backup') return;
      if (known) {
        try {
          await this.api.request(`/v1/drive/items/${known.itemId}`, {
            method: 'DELETE',
            body: { operationId: job.id, baseRevision: known.revision },
          });
        } catch (e) {
          if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
            const current = await this.api.request(`/v1/drive/items/${known.itemId}`);
            await this.remoteItem(root, current.item);
            return;
          }
          if (!(e instanceof ApiError && ['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND'].includes(e.code)))
            throw e;
        }
        this.journal.deleteFile(root.id, job.relativePath);
      }
      return;
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return;
    this.state.active = {
      rootId: root.id,
      direction: 'upload',
      relativePath: job.relativePath,
      loaded: 0,
      total: info.isFile() ? info.size : 0,
    };
    this.emit();
    const backup =
      root.mode === 'backup'
        ? { rootId: root.backupId!, runId: job.payload.backupRunId as string }
        : undefined;
    const parentId = await this.remoteParent(root, job.relativePath, backup);
    if (info.isDirectory()) {
      if (!known) {
        const item = await this.ensureFolder(path.basename(absolute), parentId, job.id, backup);
        this.journal.putFile({
          rootId: root.id,
          relativePath: job.relativePath,
          itemId: item.id,
          revision: item.revision,
          hash: null,
          type: 'FOLDER',
        });
        this.receipts.queue(root, job.relativePath, item, null);
        this.activity(root, job.relativePath, 'upload', item);
      }
      return;
    }
    if (root.mode === 'backup') {
      await safeParents(root.localPath, job.relativePath, false);
      const remote = known
        ? ((await this.api.request(`/v1/drive/items/${known.itemId}`)).item as DriveItem)
        : await this.child(parentId, path.basename(absolute));
      if (remote?.type === 'FILE') {
        if (remote.name.normalize('NFC') !== path.basename(absolute).normalize('NFC'))
          throw new Error(
            'Another archived file has the same name with different capitalization. Rename the local file to back up both.',
          );
        let savedHash = known?.revision === remote.revision ? known.hash : null;
        if (!savedHash) {
          const { items } = await this.api.request(`/v1/drive/items/${remote.id}/versions`);
          savedHash =
            items.find(
              (version: { id: string; contentHash: string }) =>
                version.id === remote.currentVersionId,
            )?.contentHash ?? null;
        }
        known = {
          rootId: root.id,
          relativePath: job.relativePath,
          itemId: remote.id,
          revision: remote.revision,
          hash: savedHash,
          type: 'FILE',
        };
        this.journal.putFile(known);
      }
    }
    const hash = await hashFile(absolute);
    if (job.payload.relayVersion && known) {
      if (known.hash !== hash) {
        // An edit arriving while a relay request is queued is still a normal local edit.
        delete job.payload.relayVersion;
        job.payload.upload = { operationId: crypto.randomUUID() };
        this.journal.saveJob(job);
      } else {
        const current = (await this.api.request(`/v1/drive/items/${known.itemId}`))
          .item as DriveItem;
        if (
          current.cloudState !== 'REQUESTED' ||
          current.currentVersionId !== job.payload.relayVersion
        )
          return;
      }
    } else if (known?.hash === hash) return;
    const state = (job.payload.upload ??= { operationId: job.id }) as UploadState;
    // Reuse this checksum only when the file remained stable during hashing.
    // uploadFile checks these attributes again before using it.
    const hashedInfo = await lstat(absolute);
    if (!state.uploadId && info.size === hashedInfo.size && info.mtimeMs === hashedInfo.mtimeMs) {
      state.hash = hash;
      state.size = info.size;
      state.mtime = info.mtimeMs;
    }
    const verifyBackupQuiet = async () => {
      if (root.mode !== 'backup' || job.payload.backupManual) return;
      const current = await lstat(absolute);
      const queued = this.journal.jobs().find((entry) => entry.id === job.id);
      if (!backupReady(current.mtimeMs, queued?.payload.observedAt ?? job.payload.observedAt ?? 0))
        throw new Error('This file changed recently. Automatic backup will wait one hour.');
    };
    await verifyBackupQuiet();
    let item: DriveItem;
    this.state.active = {
      rootId: root.id,
      direction: 'upload',
      relativePath: job.relativePath,
      loaded: 0,
      total: info.size,
    };
    this.emit();
    try {
      item = await uploadFile(
        this.api,
        absolute,
        path.basename(absolute),
        parentId,
        state,
        () => this.journal.saveJob(job),
        known ? { itemId: known.itemId, revision: known.revision } : undefined,
        (n, total) => {
          this.state.active = {
            rootId: root.id,
            direction: 'upload',
            relativePath: job.relativePath,
            loaded: n,
            total,
          };
          this.state.message = `Uploading ${Math.round((n / Math.max(1, total)) * 100)}%`;
          this.emit(n < total);
        },
        verifyBackupQuiet,
        backup,
      );
    } catch (e) {
      if (root.mode === 'backup') throw e;
      if (e instanceof ApiError && ['REVISION_CONFLICT', 'NAME_CONFLICT'].includes(e.code)) {
        if (state.uploadId)
          await this.api.request(`/v1/uploads/${state.uploadId}`, { method: 'DELETE' });
        if (job.payload.relayVersion) return;
        const conflict = path.posix.join(
          path.posix.dirname(job.relativePath),
          conflictName(path.basename(absolute), this.deviceName(), job.id),
        );
        await rename(absolute, contained(root.localPath, conflict));
        this.conflict(root, job.relativePath, conflict);
        this.journal.enqueue(root.id, conflict, 'upsert');
        const remote = known
          ? (await this.api.request(`/v1/drive/items/${known.itemId}`)).item
          : await this.child(parentId, path.basename(absolute));
        if (remote) await this.remoteItem(root, remote);
        return;
      }
      throw e;
    }
    if (root.mode === 'backup') {
      job.payload.backupEntry = {
        relativePath: job.relativePath,
        itemId: item.id,
        versionId: item.currentVersionId,
        sizeBytes: item.sizeBytes,
        modifiedAt: new Date(state.mtime!).toISOString(),
        savedAt: new Date().toISOString(),
      };
      this.journal.saveJob(job);
    }
    this.journal.putFile({
      rootId: root.id,
      relativePath: job.relativePath,
      itemId: item.id,
      revision: item.revision,
      hash: state.hash!,
      type: 'FILE',
    });
    this.receipts.queue(root, job.relativePath, item, state.hash!);
    this.activity(root, job.relativePath, 'upload', item);
  }
  private async relative(root: Root, item: DriveItem): Promise<string | null> {
    const segments = [safeSegment(item.name, item.id)];
    let parentId = item.parentId;
    let depth = 0;
    while (parentId !== root.remoteId) {
      if (!parentId || depth++ > 32) return null;
      const response = await this.api.request(`/v1/drive/items/${parentId}`);
      segments.unshift(safeSegment(response.item.name, response.item.id));
      parentId = response.item.parentId;
    }
    return segments.join('/');
  }
  private async preserve(root: Root, relative: string, knownHash: string | null) {
    const full = contained(root.localPath, relative);
    try {
      const info = await lstat(full);
      if (info.isFile() && (await hashFile(full)) !== knownHash) {
        const conflict = path.posix.join(
          path.posix.dirname(relative),
          conflictName(path.basename(full), this.deviceName(), crypto.randomUUID()),
        );
        await rename(full, contained(root.localPath, conflict));
        this.conflict(root, relative, conflict);
        this.journal.enqueue(root.id, conflict, 'upsert');
        return true;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return false;
  }
  async remoteItem(root: Root, eventItem: DriveItem) {
    if (this.stopped || this.state.paused || root.paused || root.mode !== 'sync') return;
    if (root.remoteId === eventItem.id) {
      if (!eventItem.deletedAt) this.receipts.queue(root, '.', eventItem, null);
      return;
    }
    const known = this.journal.fileByItem(root.id, eventItem.id);
    if (known && this.ignored(root, known.relativePath)) return;
    if (eventItem.deletedAt && known && known.revision >= eventItem.revision) return;
    if (eventItem.deletedAt) {
      this.waiting.delete(eventItem.id);
      if (!known) return;
      const full = contained(root.localPath, known.relativePath);
      if (known.type === 'FILE') {
        await this.preserve(root, known.relativePath, known.hash);
        await rm(full, { force: true });
      } else {
        // Preserve the entire local directory on remote deletion. It may contain unsynced work.
        // The copy stays visible beside its old location and is excluded from further syncing.
        try {
          if ((await readdir(full)).every(metadataSegment)) await rm(full, { recursive: true });
          else {
            const kept = path.posix.join(
              path.posix.dirname(known.relativePath),
              recoveredName(path.basename(full), new Date()),
            );
            await rename(full, contained(root.localPath, kept));
            this.recovered(root, known.relativePath, kept);
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        for (const child of this.journal
          .files(root.id)
          .filter((f) => f.relativePath.startsWith(known.relativePath + '/')))
          this.journal.deleteFile(root.id, child.relativePath);
      }
      this.journal.deleteFile(root.id, known.relativePath);
      return;
    }
    // Resolve the latest metadata when processing historical feed entries.
    let item: DriveItem;
    try {
      item = (await this.api.request(`/v1/drive/items/${eventItem.id}`)).item;
    } catch (e) {
      if (e instanceof ApiError && ['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND'].includes(e.code)) return;
      throw e;
    }
    const relative = await this.relative(root, item);
    if (relative === null || this.ignored(root, relative)) return;
    const destination = await safeParents(root.localPath, relative);
    if (known && known.relativePath !== relative) {
      const previous = contained(root.localPath, known.relativePath);
      try {
        await lstat(destination);
        throw new Error('A local item blocks a remote move. Move it aside to continue safely.');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      try {
        await rename(previous, destination);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      this.journal.deleteFile(root.id, known.relativePath);
      if (known.type === 'FOLDER')
        for (const child of this.journal
          .files(root.id)
          .filter((f) => f.relativePath.startsWith(known.relativePath + '/'))) {
          this.journal.deleteFile(root.id, child.relativePath);
          this.journal.putFile({
            ...child,
            relativePath: relative + child.relativePath.slice(known.relativePath.length),
          });
        }
    }
    if (item.type === 'FOLDER') {
      await mkdir(destination, { recursive: true });
      this.journal.putFile({
        rootId: root.id,
        relativePath: relative,
        itemId: item.id,
        revision: item.revision,
        hash: null,
        type: 'FOLDER',
      });
      this.receipts.queue(root, relative, item, null);
      return;
    }
    const versions = await this.api.request(`/v1/drive/items/${item.id}/versions`);
    const hash = versions.items.find((v: any) => v.id === item.currentVersionId)?.contentHash;
    if (!hash) throw new Error('File version is unavailable.');
    try {
      if ((await hashFile(destination)) === hash) {
        this.journal.putFile({
          rootId: root.id,
          relativePath: relative,
          itemId: item.id,
          revision: item.revision,
          hash,
          type: 'FILE',
        });
        this.receipts.queue(root, relative, item, hash);
        this.waiting.delete(item.id);
        if (item.cloudState === 'REQUESTED') {
          this.journal.enqueue(root.id, relative, 'upsert');
          const relay = this.journal
            .jobs()
            .find(
              (j) => j.rootId === root.id && j.relativePath === relative && j.kind === 'upsert',
            )!;
          if (relay.payload.relayVersion !== item.currentVersionId) {
            relay.payload.relayVersion = item.currentVersionId;
            relay.payload.upload = { operationId: crypto.randomUUID() };
          }
          this.journal.saveJob(relay);
          this.scheduleTick();
        }
        return;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (item.cloudState === 'RELEASED' || item.cloudState === 'REQUESTED') {
      await this.api.request(`/v1/sync/items/${item.id}/request-content`, { method: 'POST' });
      this.state.message = 'Waiting for a linked device to provide this file';
      this.waiting.set(item.id, { rootId: root.id, relativePath: relative });
      this.emit();
      return;
    }
    this.state.active = {
      rootId: root.id,
      direction: 'download',
      relativePath: relative,
      loaded: 0,
      total: item.sizeBytes,
    };
    this.emit();
    await downloadFile(
      this.api,
      { driveItemId: item.id, versionId: item.currentVersionId! },
      destination,
      (loaded, total) => {
        this.state.active = {
          rootId: root.id,
          direction: 'download',
          relativePath: relative,
          loaded,
          total,
        };
        this.emit(loaded < total);
      },
      async () => {
        await this.preserve(root, relative, known?.hash ?? null);
      },
    );
    this.journal.putFile({
      rootId: root.id,
      relativePath: relative,
      itemId: item.id,
      revision: item.revision,
      hash,
      type: 'FILE',
    });
    this.receipts.queue(root, relative, item, hash);
    this.waiting.delete(item.id);
    this.activity(root, relative, 'download', item);
  }
}
