import path from 'node:path';
import os from 'node:os';
import { FolderBackups, backupReady } from './backups';
import { SyncReceipts } from './sync-receipts';
import { mkdir, lstat, rename, rm, access, readdir } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import {
  stickyIssue,
  storageNeed,
  syncIssueCode,
  type SyncRuntime,
  type SyncIssue,
  type SyncActivityItem,
} from './sync-state';
import { watchTree, type TreeWatcher } from './local-watcher';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { DriveItem } from '@harbor/contracts';
import { Journal, type Root, type LocalJob, type LocalFile } from './journal';
import {
  contained,
  internalPath,
  metadataSegment,
  recoveredName,
  safeParents,
  safeSegment,
  legacySafeSegment,
  conflictName,
} from './paths';
import { uploadFile, downloadFile, hashFile, cancelUpload, type UploadState } from './transfers';
// Watchers can miss events (sleep, a full event buffer, edits while the app was closed),
// so every folder is also compared against the journal on this schedule.
export const LOCAL_SCAN_INTERVAL = 5 * 60_000;
// A pass waiting this long on one server request is aborted and started again.
export const STALL_TIMEOUT = 3 * 60_000;
// Failed files and folders retry with growing delays (4s up to 5 minutes).
const retryDelay = (attempts: number) => Math.min(300_000, 2000 * 2 ** Math.min(attempts, 10));
// Remote checks start every 2s and back off to 30s while nothing changes;
// local edits, remote changes and wake() return to the fast rate.
export const REMOTE_POLL_MIN = 2000;
export const REMOTE_POLL_MAX = 30_000;
// With live updates connected, polling is only a safety net for missed messages.
export const REMOTE_POLL_LIVE = 5 * 60_000;
async function localStat(file: string) {
  try {
    const info = await lstat(file);
    return { sizeBytes: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return {};
  }
}
export class SyncEngine {
  private receipts: SyncReceipts;
  private backups: FolderBackups;
  private watchers = new Map<string, TreeWatcher>();
  private scannedAt = new Map<string, number>();
  private api: ApiClient;
  private tickController = new AbortController();
  // Start times of the server requests still waiting for an answer.
  private inflight = new Set<{ at: number }>();
  private watchdog?: ReturnType<typeof setInterval>;
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
  // While the server is unreachable or failing, passes wait out a growing delay instead of
  // starting every 2s; wake() and tick() try again at once.
  private outages = 0;
  private outageUntil = 0;
  // Files finished per sync folder since it was last idle; the base for its percent complete.
  private syncDone = new Map<string, number>();
  // Folders this computer is removing itself; nothing to tell the user when they go.
  private leaving = new Set<string>();
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
    api: ApiClient,
    private journal: Journal,
    private deviceId: string,
    private changed: (state: unknown) => void,
    // A desktop notification for something the user did not do on this computer.
    private notify: (title: string, body: string) => void = () => {},
  ) {
    // Every request of a pass shares its signal, so the watchdog can end a pass that hangs.
    this.api = new ApiClient(async (endpoint, init = {}) => {
      const request = { at: Date.now() };
      this.inflight.add(request);
      try {
        return await api.request(endpoint, {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, this.tickController.signal])
            : this.tickController.signal,
        });
      } finally {
        this.inflight.delete(request);
      }
    });
    this.receipts = new SyncReceipts(api, journal);
    this.backups = new FolderBackups(this.api, journal);
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
    this.watchdog = setInterval(() => this.checkStalled(), 15_000);
    void this.tick();
  }
  /** A pass stuck on the server for STALL_TIMEOUT is aborted; the next one starts fresh. */
  private checkStalled() {
    const oldest = Math.min(...[...this.inflight].map((request) => request.at));
    if (!this.running || Date.now() - oldest < STALL_TIMEOUT) return;
    this.inflight.clear();
    this.tickController.abort(
      Object.assign(new Error('Sync stopped responding and was restarted.'), {
        name: 'TimeoutError',
      }),
    );
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
    if (this.watchdog) clearInterval(this.watchdog);
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
    this.scannedAt.clear();
    await this.work;
    await this.publishWork;
  }
  private ignored(root: Root, relative: string) {
    return (
      internalPath(relative) ||
      root.excluded.some((p) => relative === p || relative.startsWith(p + '/'))
    );
  }
  private relativeTo(root: Root, full: string) {
    return path.relative(root.localPath, full).split(path.sep).join('/');
  }
  async watch(root: Root) {
    const watcher = watchTree(root.localPath, (full) =>
      this.ignored(root, this.relativeTo(root, full)),
    );
    const queue =
      (kind: 'upsert' | 'delete', changed = false) =>
      (full: string, info?: Stats) => {
        if (this.observe(root.id, this.relativeTo(root, full), kind, info, 'watch', changed))
          this.changesFound();
      };
    watcher
      .on('add', queue('upsert'))
      .on('addDir', queue('upsert'))
      .on('change', queue('upsert', true))
      .on('unlink', queue('delete'))
      .on('error', (error) => {
        this.issue(root.id, error);
        // The next pass watches again and rescans whatever was missed meanwhile.
        void watcher.close();
        if (this.watchers.get(root.id) === watcher) {
          this.watchers.delete(root.id);
          this.scannedAt.delete(root.id);
        }
        this.scheduleTick();
      });
    this.watchers.set(root.id, watcher);
  }
  private changesFound() {
    // Batch large scans while still showing new files promptly, including when paused.
    if (!this.queueEmitTimer)
      this.queueEmitTimer = setTimeout(() => {
        this.queueEmitTimer = undefined;
        this.emit();
      }, 50);
    this.hurry();
    this.scheduleTick();
  }
  /**
   * Record one local change in the journal unless the journal already matches the disk.
   * Returns whether anything was queued.
   */
  private observe(
    rootId: string,
    relative: string,
    kind: 'upsert' | 'delete',
    info: Stats | undefined,
    source: string,
    changed = false,
  ) {
    const root = this.journal.roots().find((entry) => entry.id === rootId);
    if (!root || !relative || relative.startsWith('..') || this.ignored(root, relative))
      return false;
    const known = this.journal.file(root.id, relative);
    const pending = this.journal
      .jobs()
      .some((job) => job.rootId === root.id && job.relativePath === relative && job.kind === kind);
    if (kind === 'upsert' && info && !pending && known) {
      if (info.isDirectory() && known.type === 'FOLDER') return false;
      if (
        info.isFile() &&
        known.type === 'FILE' &&
        known.sizeBytes === info.size &&
        known.mtimeMs === info.mtimeMs
      )
        return false;
    }
    if (kind === 'delete') {
      // Backups keep what was saved; nothing to do for a file the cloud never had.
      if (root.mode === 'backup' || (!known && !pending)) return false;
      if (known?.type === 'FOLDER')
        for (const child of this.journal.files(root.id))
          if (child.relativePath.startsWith(relative + '/'))
            this.journal.enqueue(root.id, child.relativePath, 'delete', undefined, source);
    }
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
      source,
    );
    if (root.mode === 'backup' && changed) {
      const job = this.journal
        .jobs()
        .find((j) => j.rootId === root.id && j.relativePath === relative && j.kind === kind);
      if (job) {
        job.payload.observedAt = Date.now();
        this.journal.saveJob(job);
      }
    }
    return true;
  }
  /** Compare the whole folder with the journal: catches anything the watcher missed. */
  private async scanLocal(root: Root) {
    const seen = new Set<string>();
    let found = false;
    const walk = async (relative: string) => {
      let entries;
      try {
        entries = await readdir(relative ? contained(root.localPath, relative) : root.localPath, {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (this.stopped || this.state.paused) return;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (this.ignored(root, name) || entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        let info: Stats;
        try {
          info = await lstat(contained(root.localPath, name));
        } catch {
          continue;
        }
        seen.add(name);
        if (this.observe(root.id, name, 'upsert', info, 'scan')) found = true;
        if (entry.isDirectory()) await walk(name);
      }
    };
    await walk('');
    if (this.stopped || this.state.paused) return;
    // The folder itself was checked this pass, so a missing entry was really removed.
    for (const file of this.journal.files(root.id))
      if (
        !seen.has(file.relativePath) &&
        this.observe(root.id, file.relativePath, 'delete', undefined, 'scan')
      )
        found = true;
    this.scannedAt.set(root.id, Date.now());
    if (found) this.emit();
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
    this.outageUntil = 0;
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
      this.scannedAt.clear();
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
    this.state.progress = this.progress();
    this.changed({ ...this.state });
  }
  /**
   * Sync: files finished since the folder was last idle against those still queued, plus a
   * download in flight. Backup: files saved in the current run against the run's size. The file
   * being transferred counts by its bytes. Stays below 100 until the work is done.
   */
  private progress() {
    const progress: Record<string, number> = {};
    const queued = this.journal.jobCounts();
    const active = this.state.active;
    for (const root of this.journal.roots()) {
      const fraction =
        active?.rootId === root.id && active.total > 0
          ? Math.min(1, active.loaded / active.total)
          : 0;
      let done: number;
      let total: number;
      if (root.mode === 'backup') {
        const run = this.backups.run(root.id);
        if (!run?.total) continue;
        ({ done, total } = run);
      } else {
        const download = active?.rootId === root.id && active.direction === 'download' ? 1 : 0;
        const remaining = (queued.get(root.id) ?? 0) + download;
        if (!remaining) continue;
        done = this.syncDone.get(root.id) ?? 0;
        total = done + remaining;
      }
      progress[root.id] = Math.min(99, Math.floor(((done + fraction) / total) * 100));
    }
    return progress;
  }
  private finished(rootId: string) {
    this.syncDone.set(rootId, (this.syncDone.get(rootId) ?? 0) + 1);
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
      // End the current pass now rather than waiting minutes for it: an unfinished transfer
      // resumes from the journal after the restart, and no files are deleted.
      this.tickController.abort(
        Object.assign(new Error('Sync restarted to apply new settings.'), { name: 'AbortError' }),
      );
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
    this.leaving.add(root.id);
    try {
      await this.api.request(`/v1/backups/${backup.id}`, { method: 'DELETE' });
      await this.removeRoot(root.id);
    } finally {
      this.leaving.delete(root.id);
    }
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
    const changes = await this.backups.request(root);
    if (changes) {
      // Saying "Backing up" and failing a moment later helps no one: check there is room first.
      // Offline, the run simply waits for the connection as before.
      const available = (await this.api.me().catch(() => null))?.storage.availableBytes;
      let smallest = Infinity;
      for (const job of available === undefined ? [] : this.journal.jobs())
        if (job.rootId === root.id && job.kind === 'upsert') {
          const info = await lstat(contained(root.localPath, job.relativePath)).catch(() => null);
          if (info?.isFile()) smallest = Math.min(smallest, info.size);
        }
      if (smallest !== Infinity && smallest > available!) {
        this.journal.set(`backup-now:${root.id}`, false);
        throw new Error(
          `There is not enough cloud storage to back up ${changes === 1 ? 'the changed file' : 'any of the changed files'}. They back up automatically once space is freed.`,
        );
      }
      this.wake();
    }
    return { queued: changes > 0, changes };
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
    const own = this.journal.roots().filter((root) => root.remoteId === folderId);
    for (const root of own) this.leaving.add(root.id);
    try {
      await this.api.request(`/v1/sync/folders/${folderId}`, { method: 'DELETE' });
      await this.changeConfiguration(() => {
        for (const root of this.journal.roots()) {
          if (root.mode !== 'sync') continue;
          if (root.remoteId === folderId) this.journal.removeRoot(root.id);
          else this.excludeRemovedFolder(root, folderId);
        }
        this.state.issues = this.state.issues.filter(
          (issue) => !issue.rootId || this.journal.roots().some((r) => r.id === issue.rootId),
        );
        this.persistIssues();
      });
    } finally {
      for (const root of own) this.leaving.delete(root.id);
    }
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
        this.journal.drop(job.id);
    for (const file of this.journal.files(root.id))
      if (
        file.relativePath === known.relativePath ||
        file.relativePath.startsWith(known.relativePath + '/')
      )
        this.journal.deleteFile(root.id, file.relativePath);
  }
  private async detachRoot(root: Root, reason: 'revoked' | 'deleted' | 'removed' | 'backup') {
    await this.watchers.get(root.id)?.close();
    this.watchers.delete(root.id);
    this.journal.removeRoot(root.id);
    this.forgetWaiting(root.id);
    this.state.issues = this.state.issues.filter((issue) => issue.rootId !== root.id);
    if (!this.leaving.has(root.id)) {
      // The folder leaves the list, so say why in a notice that stays until dismissed.
      const name = path.basename(root.localPath);
      const owner = root.sharedByName ?? 'The owner';
      const what = {
        revoked: `${owner} stopped sharing “${name}” with you.`,
        deleted: root.shareId
          ? `${owner} moved “${name}” to the trash or deleted it, so it stopped syncing. If it is restored, accept the invitation again to resume.`
          : `“${name}” was moved to the trash or deleted in the cloud, so it stopped syncing.`,
        removed: root.shareId
          ? `“${name}” stopped syncing: it was removed from sync on another device.`
          : `“${name}” was removed from sync on another device.`,
        backup: `Backups of “${name}” were turned off on another device.`,
      }[reason];
      const message = `${what} Your local files are still in ${root.localPath}.`;
      this.state.issues.push({
        id: `detached:${root.id}`,
        rootId: '',
        code: 'SYNC_DETACHED',
        relativePath: name,
        conflictPath: root.localPath,
        message,
        at: new Date().toISOString(),
      });
      this.notify(root.mode === 'backup' ? 'Backup stopped' : 'Folder stopped syncing', message);
    }
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
      ...(code === 'STORAGE_QUOTA_EXCEEDED'
        ? { storage: storageNeed(error, !!root?.shareId) }
        : {}),
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
      this.finished(root.id);
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
    // The listing gives each item's path directly, so nothing is looked up item by item.
    const walk = async (parent: string | null, parentPath: string) => {
      let cursor: string | undefined;
      do {
        const page = await this.api.list(parent, cursor);
        const pendingPaths = new Set(
          this.journal
            .jobs()
            .filter((job) => job.rootId === root.id)
            .map((job) => job.relativePath),
        );
        for (const item of page.items) {
          if (this.stopped || this.state.paused) return;
          seen.add(item.id);
          const segment = this.localName(root, item, parentPath);
          const relative = parentPath ? `${parentPath}/${segment}` : segment;
          if (this.ignored(root, relative)) continue;
          const known = this.journal.fileByItem(root.id, item.id);
          const unchanged =
            known?.revision === item.revision &&
            known.relativePath === relative &&
            item.cloudState !== 'REQUESTED';
          // A shared-folder scan can be triggered by an unrelated sibling edit.
          // Do not overwrite this device's queued edits/deletes when this item is unchanged.
          // An item that matches the journal and the disk needs no work at all.
          if (!(unchanged && (pendingPaths.has(relative) || (await this.matchesDisk(root, known)))))
            await this.remoteItem(root, item, relative);
          if (item.type === 'FOLDER') await walk(item.id, relative);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    };
    const rootItem = (await this.api.request(`/v1/drive/items/${root.remoteId}`)).item;
    if (rootItem) this.receipts.queue(root, '.', rootItem, null);
    await walk(root.remoteId, '');
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
    this.outageUntil = 0;
    this.hurry();
    return this.run();
  }
  private async run() {
    if (!this.stopped && !this.publishingFolders) this.publishWork = this.publishSyncFolders();
    this.confirmStatus();
    if (this.running || this.stopped || (this.state.paused && !this.removedRemoteIds.size)) return;
    if (Date.now() < this.outageUntil) return;
    this.work = this.runTick();
    return this.work;
  }
  private async runTick() {
    this.tickController = new AbortController();
    this.running = true;
    this.state.running = true;
    // Local work runs every tick; server checks only when due.
    const remote = Date.now() >= this.nextRemoteAt;
    let active = false;
    this.hurried = false;
    try {
      for (const root of this.journal.roots())
        if (root.mode === 'sync' && root.remoteId && this.removedRemoteIds.has(root.remoteId))
          await this.detachRoot(root, 'removed');
      this.removedRemoteIds.clear();
      const available = new Set<string>();
      // Shared folders check their revisions in parallel instead of one round trip each.
      const shareStatus = (root: Root) =>
        this.api.request(`/v1/sync/shares/${root.shareId}/status`);
      const sharedStatuses = new Map(
        (remote ? this.journal.roots() : [])
          .filter((root) => root.shareId)
          .map((root) => {
            const request = shareStatus(root);
            request.catch(() => {}); // Handled in the loop below; this tick may stop early.
            return [root.id, request] as const;
          }),
      );
      for (let root of this.journal.roots()) {
        if (this.stopped || this.state.paused) return;
        if (root.shareId && remote) {
          try {
            const status = await (sharedStatuses.get(root.id) ?? shareStatus(root));
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
              await this.detachRoot(
                root,
                ['SYNC_ACCESS_REMOVED', 'FORBIDDEN'].includes(error.code) ? 'revoked' : 'deleted',
              );
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
        // A folder being removed or restored has no settled local copy to compare.
        if (
          (!root.archive || root.archive === 'pending') &&
          Date.now() - (this.scannedAt.get(root.id) ?? 0) >= LOCAL_SCAN_INTERVAL
        )
          await this.scanLocal(root);
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
          if (root.archive !== 'removing') {
            // A backup run resumes from the journal, so it pauses between files when a
            // local edit or live update arrives instead of holding up sync for the whole run.
            let yielded = false;
            await this.backups.process(
              root,
              (r, job) => this.localJob(r, job),
              () => stopped() || (yielded = this.hurried),
            );
            if (yielded) continue;
          }
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
            await this.detachRoot(root, 'backup');
          else throw error;
        }
      }
      await this.releaseUploads();
      // Free cloud storage by folder, once an upload was refused for lack of it this pass.
      const full = new Map<string, number>();
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
          (job.kind === 'upsert' &&
            job.payload.entry?.type !== 'FOLDER' &&
            (job.payload.entry?.sizeBytes ?? Infinity) > (full.get(root.id) ?? Infinity))
        )
          continue;
        active = true;
        this.currentRootId = root.id;
        try {
          await this.localJob(root, job);
          this.journal.finish(job.id);
          this.finished(root.id);
          if (this.state.issues.some((issue) => issue.jobId === job.id)) {
            this.state.issues = this.state.issues.filter((issue) => issue.jobId !== job.id);
            this.persistIssues();
          }
          this.state.active = null;
          this.emit();
        } catch (e) {
          // An ended pass is not this file's failure; it simply runs again next pass.
          if (this.tickController.signal.aborted) throw e;
          job.attempts++;
          job.error = (e as Error).message;
          if (this.interrupts(e)) {
            this.journal.saveJob(job);
            throw e;
          }
          // One failing file waits for its own retry; the rest of the queue keeps moving.
          job.payload.retryAt = Date.now() + retryDelay(job.attempts);
          this.journal.saveJob(job);
          // Every further upload that does not fit would fail the same way until storage is freed.
          if (e instanceof ApiError && syncIssueCode(e) === 'STORAGE_QUOTA_EXCEEDED')
            full.set(root.id, storageNeed(e, !!root.shareId)?.availableBytes ?? 0);
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
          // Emptied trash, a permanent delete, a cancelled upload or a new quota can free storage.
          if (['PROFILE_UPDATED', 'FILE_DELETED', 'UPLOAD_ABORTED'].includes(change.type))
            this.storageFreed();
          if (change.type === 'BACKUP_DISCONNECTED')
            for (const root of this.journal
              .roots()
              .filter((r) => r.mode === 'backup' && r.remoteId === change.entityId))
              await this.detachRoot(root, 'backup');
          if (change.type === 'SYNC_FOLDER_REMOVED')
            for (const root of this.journal.roots().filter((r) => r.mode === 'sync')) {
              if (root.remoteId === change.entityId) await this.detachRoot(root, 'removed');
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
      this.outages = 0;
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
              await this.detachRoot(root, 'removed');
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
      // Not reaching the server, or the server failing, is an outage for the whole pass.
      const unavailable = e instanceof TypeError || (e instanceof ApiError && e.status >= 500);
      if (unavailable || (e instanceof ApiError && e.status === 429))
        this.outageUntil = Date.now() + Math.min(60_000, retryDelay(++this.outages));
      this.state.online = !unavailable;
      this.state.message = unavailable
        ? 'harbor0 is unavailable right now. Sync resumes automatically.'
        : (e as Error).message;
      // A pass ended by the watchdog simply starts again; there is nothing to fix.
      const restarted = this.tickController.signal.aborted;
      // An ended session returns the app to sign-in by itself; there is nothing to fix here.
      const sessionEnded =
        e instanceof ApiError &&
        (e.status === 401 || ['AUTH_INVALID', 'DEVICE_REVOKED'].includes(e.code));
      if (
        !unavailable &&
        !restarted &&
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
      // A folder with nothing left starts its next batch from 0%.
      const queued = this.journal.jobCounts();
      for (const id of this.syncDone.keys()) if (!queued.get(id)) this.syncDone.delete(id);
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
  /** Uploads refused for lack of storage try again now instead of waiting out their delay. */
  storageFreed() {
    const refused = new Set(
      this.state.issues
        .filter((issue) => issue.code === 'STORAGE_QUOTA_EXCEEDED' && issue.jobId)
        .map((issue) => issue.jobId),
    );
    for (const job of this.journal.jobs())
      if (refused.has(job.id) && job.payload.retryAt) {
        delete job.payload.retryAt;
        this.journal.saveJob(job);
      }
  }
  /** The job's partial upload will never complete: free the storage it reserved. */
  private abandonUpload(job: LocalJob) {
    if (!job.payload.upload) return;
    this.journal.abandonUpload(job.payload.upload.uploadId);
    job.payload.upload = { operationId: crypto.randomUUID() };
    this.journal.saveJob(job);
  }
  private async releaseUploads() {
    for (const uploadId of this.journal.abandonedUploads()) {
      try {
        await cancelUpload(this.api, uploadId);
      } catch {
        return; // Kept for the next pass; the server is unavailable right now.
      }
      this.journal.uploadReleased(uploadId);
    }
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
      if (known?.type === 'FILE' && (await this.renamedTo(root, known))) return;
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
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.abandonUpload(job);
      throw e;
    }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      return this.abandonUpload(job);
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
    if (root.mode === 'sync' && !known && (await this.renamedFrom(root, job.relativePath)))
      return this.abandonUpload(job);
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
        this.journal.abandonUpload(job.payload.upload?.uploadId);
        job.payload.upload = { operationId: crypto.randomUUID() };
        this.journal.saveJob(job);
      } else {
        const current = (await this.api.request(`/v1/drive/items/${known.itemId}`))
          .item as DriveItem;
        if (
          current.cloudState !== 'REQUESTED' ||
          current.currentVersionId !== job.payload.relayVersion
        )
          return this.abandonUpload(job);
      }
    } else if (known?.hash === hash) {
      // Touched but identical: remember its size and time so scans skip it from now on.
      this.journal.putFile({ ...known, sizeBytes: info.size, mtimeMs: info.mtimeMs });
      return this.abandonUpload(job);
    }
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
        this.journal.abandonUpload(state.uploadId);
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
      sizeBytes: state.size,
      mtimeMs: state.mtime,
    });
    this.receipts.queue(root, job.relativePath, item, state.hash!);
    this.activity(root, job.relativePath, 'upload', item);
  }
  private async relative(root: Root, item: DriveItem): Promise<string | null> {
    const chain = [item];
    let parentId = item.parentId;
    let depth = 0;
    while (parentId !== root.remoteId) {
      if (!parentId || depth++ > 32) return null;
      const response = await this.api.request(`/v1/drive/items/${parentId}`);
      chain.unshift(response.item);
      parentId = response.item.parentId;
    }
    let relative = '';
    for (const entry of chain) {
      const segment = this.localName(root, entry, relative);
      relative = relative ? `${relative}/${segment}` : segment;
    }
    return relative;
  }
  /** An item already synced under the name earlier versions gave it keeps that local name. */
  private localName(root: Root, item: DriveItem, parentPath: string) {
    const segment = safeSegment(item.name, item.id);
    const legacy = legacySafeSegment(item.name, item.id);
    if (legacy === segment) return segment;
    const known = this.journal.fileByItem(root.id, item.id);
    return known?.relativePath === (parentPath ? `${parentPath}/${legacy}` : legacy)
      ? legacy
      : segment;
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
  /**
   * A local rename or move arrives as a deletion plus a new file, in either order. When both are
   * queued and the new file holds the deleted one's content, the cloud item is moved instead:
   * nothing is uploaded again, and the cloud copy never leaves, even when storage is full.
   */
  private async renamedTo(root: Root, known: LocalFile) {
    for (const other of this.journal.jobs())
      if (
        other.rootId === root.id &&
        other.kind === 'upsert' &&
        !this.journal.file(root.id, other.relativePath) &&
        (await this.sameContent(root, other.relativePath, known)) &&
        (await this.moveRemote(root, known, other.relativePath))
      ) {
        this.journal.drop(other.id);
        return true;
      }
    return false;
  }
  private async renamedFrom(root: Root, relative: string) {
    for (const other of this.journal.jobs()) {
      if (other.rootId !== root.id || other.kind !== 'delete') continue;
      const known = this.journal.file(root.id, other.relativePath);
      if (known?.type !== 'FILE' || (await this.exists(root, other.relativePath))) continue;
      if (
        (await this.sameContent(root, relative, known)) &&
        (await this.moveRemote(root, known, relative))
      ) {
        this.journal.finish(other.id);
        return true;
      }
    }
    return false;
  }
  private async exists(root: Root, relative: string) {
    try {
      await lstat(contained(root.localPath, relative));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return false;
    }
  }
  /** Only files of the recorded size are hashed; an unreadable one is simply not a match. */
  private async sameContent(root: Root, relative: string, known: LocalFile) {
    if (!known.hash || known.sizeBytes === undefined) return false;
    const full = contained(root.localPath, relative);
    try {
      const info = await lstat(full);
      if (!info.isFile() || info.size !== known.sizeBytes) return false;
      return (await hashFile(full)) === known.hash;
    } catch {
      return false;
    }
  }
  /** Moves and renames `known`'s cloud item to `relative`; false when the cloud refuses. */
  private async moveRemote(root: Root, known: LocalFile, relative: string) {
    const info = await lstat(contained(root.localPath, relative));
    const oldDir = path.posix.dirname(known.relativePath);
    const oldParent = oldDir === '.' ? root.remoteId : this.journal.file(root.id, oldDir)?.itemId;
    const name = path.posix.basename(relative);
    let item: DriveItem | undefined;
    let revision = known.revision;
    try {
      const parentId = await this.remoteParent(root, relative);
      if (parentId !== oldParent) {
        item = (
          await this.api.request(`/v1/drive/items/${known.itemId}/move`, {
            method: 'POST',
            body: { operationId: crypto.randomUUID(), baseRevision: revision, parentId },
          })
        ).item;
        revision = item!.revision;
      }
      if (name !== path.posix.basename(known.relativePath))
        item = (
          await this.api.request(`/v1/drive/items/${known.itemId}`, {
            method: 'PATCH',
            body: { operationId: crypto.randomUUID(), baseRevision: revision, name },
          })
        ).item;
    } catch (e) {
      // Changed elsewhere, or the destination is taken: sync the two changes separately.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) return false;
      throw e;
    }
    if (!item) return false;
    this.journal.deleteFile(root.id, known.relativePath);
    this.journal.putFile({
      ...known,
      relativePath: relative,
      revision: item.revision,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
    });
    this.receipts.queue(root, relative, item, known.hash);
    this.activity(root, relative, 'upload', item);
    return true;
  }
  /**
   * Deletes what under a remotely deleted folder is exactly as last synced: unchanged files, then
   * folders left holding only file-manager metadata. Edited or unknown files stay.
   */
  private async removeSynced(root: Root, folder: string) {
    const pending = new Set(
      this.journal
        .jobs()
        .filter((job) => job.rootId === root.id && job.kind === 'upsert')
        .map((job) => job.relativePath),
    );
    const entries = this.journal
      .files(root.id)
      .filter((f) => f.relativePath.startsWith(folder + '/') && !pending.has(f.relativePath))
      .sort((a, b) => b.relativePath.length - a.relativePath.length);
    for (const entry of entries) {
      const full = contained(root.localPath, entry.relativePath);
      try {
        if (entry.type === 'FILE') {
          if (
            (await this.matchesDisk(root, entry)) ||
            ((await lstat(full)).isFile() && (await hashFile(full)) === entry.hash)
          )
            await rm(full, { force: true });
        } else if ((await readdir(full)).every(metadataSegment))
          await rm(full, { recursive: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
  /** The journal's copy is still the one on disk: same size and time, or a folder present. */
  private async matchesDisk(root: Root, known: LocalFile) {
    try {
      const info = await lstat(contained(root.localPath, known.relativePath));
      return known.type === 'FOLDER'
        ? info.isDirectory()
        : info.isFile() && info.size === known.sizeBytes && info.mtimeMs === known.mtimeMs;
    } catch {
      return false;
    }
  }
  /** `listedPath`: the item came from a fresh listing at this path, so it need not be fetched. */
  /** Removes a synced item's local copy, keeping local edits the cloud has not seen. */
  private async removeLocal(root: Root, known: LocalFile) {
    const full = contained(root.localPath, known.relativePath);
    if (known.type === 'FILE') {
      await this.preserve(root, known.relativePath, known.hash);
      await rm(full, { force: true });
    } else {
      // Files the cloud already has go with the folder; anything else (unsynced work) is kept
      // in a copy beside the old location, which is excluded from further syncing.
      try {
        await this.removeSynced(root, known.relativePath);
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
  }
  async remoteItem(root: Root, eventItem: DriveItem, listedPath?: string) {
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
      if (known) await this.removeLocal(root, known);
      return;
    }
    // Resolve the latest metadata when processing historical feed entries.
    let item: DriveItem = eventItem;
    if (listedPath === undefined)
      try {
        item = (await this.api.request(`/v1/drive/items/${eventItem.id}`)).item;
      } catch (e) {
        if (e instanceof ApiError && ['ITEM_NOT_FOUND', 'PARENT_NOT_FOUND'].includes(e.code))
          return;
        throw e;
      }
    const relative = listedPath ?? (await this.relative(root, item));
    if (relative === null) {
      // Moved out of this sync folder: its local copy goes, as if the item had been deleted.
      this.waiting.delete(item.id);
      if (known) await this.removeLocal(root, known);
      return;
    }
    if (this.ignored(root, relative)) return;
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
    // A new file skips the version lookup: the download is verified against its own hash.
    let localHash: string | null = null;
    try {
      localHash = await hashFile(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (localHash) {
      const versions = await this.api.request(`/v1/drive/items/${item.id}/versions`);
      const hash = versions.items.find((v: any) => v.id === item.currentVersionId)?.contentHash;
      if (!hash) throw new Error('File version is unavailable.');
      if (localHash === hash) {
        this.journal.putFile({
          rootId: root.id,
          relativePath: relative,
          itemId: item.id,
          revision: item.revision,
          hash,
          type: 'FILE',
          ...(await localStat(destination)),
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
            this.journal.abandonUpload(relay.payload.upload?.uploadId);
            relay.payload.upload = { operationId: crypto.randomUUID() };
          }
          this.journal.saveJob(relay);
          this.scheduleTick();
        }
        return;
      }
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
    const hash = await downloadFile(
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
      ...(await localStat(destination)),
    });
    this.receipts.queue(root, relative, item, hash);
    this.waiting.delete(item.id);
    this.activity(root, relative, 'download', item);
  }
}
