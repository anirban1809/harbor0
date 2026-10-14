import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readdir, rm, rmdir } from 'node:fs/promises';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { BackupEntry, BackupRestore } from '../../../packages/contracts/src/backups';
import { Journal, type Root, type LocalJob } from './journal';
import { isEncryptedName, type DriveItem } from '@harbor/contracts';
import {
  contained,
  internalPath,
  metadataSegment,
  safeParents,
  safeSegment,
  verifyParents,
} from './paths';
import { cancelUpload, downloadFile, hashFile, uploadFile, type UploadState } from './transfers';
import { fileSize } from '../../web/lib/file-metadata';
export const BACKUP_QUIET_MS = 60 * 60 * 1000;
export function backupReady(mtimeMs: number, observedAt = 0, now = Date.now()) {
  return now - Math.max(mtimeMs, observedAt) >= BACKUP_QUIET_MS;
}
type PendingRun = {
  id: string;
  trigger: 'MANUAL' | 'AUTOMATIC';
  // Runs from older versions kept their job IDs here, removing each as it was saved.
  jobs?: string[];
  // Files in the run when it started. Their job IDs are stored once, under `backup-run-jobs:`,
  // and `next` is how many of them have been handled: rewriting a list of a hundred thousand
  // IDs after every file would cost more than the backup.
  total?: number;
  next?: number;
  error?: string;
  // Cloud storage still free for this run, once it is known to be short; files bigger than this
  // are left queued without being tried. Unset while everything fits.
  room?: number;
  // Files left for a later run because they did not fit.
  tooBig?: number;
};
// Waiting files checked between progress reports while a run is got ready.
const CHECK_REPORT = 500;
// Unreadable subfolders named in a run's error; the rest are counted.
const UNREADABLE_NAMED = 5;
const ARCHIVE_ATTEMPTS = 3;
// Files looked up at once while scanning, which matters most on high-latency shares.
const SCAN_BATCH = 16;
// Telling harbor0 a folder with nothing new is still backed up happens at most this often.
const CHECKED_MS = 12 * 3600_000;
// A request the server will keep refusing; retrying every pass would stall all other folders.
function refused(error: unknown) {
  if (
    !(error instanceof ApiError) ||
    error.status < 400 ||
    error.status >= 500 ||
    [401, 429].includes(error.status) ||
    ['BACKUP_DISCONNECTED', 'AUTH_INVALID', 'DEVICE_REVOKED'].includes(error.code)
  )
    return null;
  return error.status === 404
    ? 'This harbor0 server does not support archiving yet. Update the server and try again.'
    : error.message;
}
/**
 * End-to-end encryption turned on or off: what this computer's backups should be stored as, and
 * the server's own view of them (`raw`), whose names stay as stored.
 */
export type BackupConversion = { form: () => 'encrypted' | 'plain' | null; raw: ApiClient };
export class FolderBackups {
  private nextRestoreCheck = new Map<string, number>();
  private runJobs = new Map<string, { id: string; jobs: string[] }>();
  conversion?: BackupConversion;
  constructor(
    private api: ApiClient,
    private journal: Journal,
    // Time-limits looks at a folder on a network share; see SyncEngine.onShare.
    private onShare: <T>(root: Root, work: () => Promise<T>) => Promise<T> = (_root, work) =>
      work(),
    // Subfolders the last scan of a folder could not read; see SyncEngine.scanLocal.
    private unreadable: (rootId: string) => string[] = () => [],
  ) {}
  /** Files saved and files in the backup run under way, if one is. */
  run(rootId: string) {
    const run = this.journal.get<PendingRun | null>(`backup-run:${rootId}`);
    if (!run) return null;
    if (run.jobs) {
      const total = Math.max(run.total ?? 0, run.jobs.length);
      return { done: total - run.jobs.length, total };
    }
    return { done: Math.min(run.next ?? 0, run.total ?? 0), total: run.total ?? 0 };
  }
  /** Why some of the folder could not be backed up: subfolders harbor0 may not read. */
  private skipped(root: Root) {
    const folders = this.unreadable(root.id);
    if (!folders.length) return undefined;
    const named = folders.slice(0, UNREADABLE_NAMED).join(', ');
    const more = folders.length - UNREADABLE_NAMED;
    return `harbor0 does not have permission to read ${folders.length === 1 ? 'this folder' : 'these folders'}: ${named}${more > 0 ? ` and ${more} more` : ''}.`;
  }
  private ignored(root: Root, relative: string) {
    return (
      internalPath(relative) ||
      root.excluded.some((p) => relative === p || relative.startsWith(p + '/'))
    );
  }
  /**
   * Back up now: rescan the folder and save every changed file without waiting out the quiet
   * hour. Returns how many files will be saved; with none, no backup is recorded.
   */
  async request(root: Root) {
    if (root.paused) throw new Error('Resume this backup folder before backing up now.');
    if (this.journal.get(`backup-run:${root.id}`))
      throw new Error('A backup is already running for this folder.');
    await this.scan(root);
    const changed = (await this.changed(root, true)).length;
    if (changed) this.journal.set(`backup-now:${root.id}`, true);
    return changed;
  }
  /**
   * Queue every file that may have changed. A file with the size and modified time it had when
   * it was saved is skipped without being read, which on a network share saves reading it all.
   */
  private async scan(root: Root, relative = '') {
    const directory = contained(root.localPath, relative);
    const info = await this.onShare(root, () => lstat(directory));
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Backup folder is unavailable.');
    let entries;
    try {
      entries = await this.onShare(root, () => readdir(directory, { withFileTypes: true }));
    } catch (error) {
      // A subfolder harbor0 may not read is skipped; the rest of the folder still backs up.
      const code = (error as NodeJS.ErrnoException).code;
      if (relative && (code === 'EACCES' || code === 'EPERM')) return;
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (this.ignored(root, name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.scan(root, name);
      else if (entry.isFile()) files.push(name);
    }
    for (let start = 0; start < files.length; start += SCAN_BATCH) {
      const batch = files.slice(start, start + SCAN_BATCH);
      const infos = await Promise.all(
        batch.map((name) =>
          this.onShare(root, () => lstat(contained(root.localPath, name))).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'SHARE_UNAVAILABLE') throw error;
              return null;
            },
          ),
        ),
      );
      this.journal.transaction(() => {
        for (const [index, name] of batch.entries()) {
          const file = infos[index];
          const known = this.journal.file(root.id, name);
          if (
            file &&
            known?.type === 'FILE' &&
            known.sizeBytes === file.size &&
            known.mtimeMs === file.mtimeMs
          )
            continue;
          this.journal.enqueue(root.id, name, 'upsert');
        }
      });
    }
  }
  /**
   * Settle this folder's queue: drop entries with nothing to save (missing, excluded, or content
   * identical to the last saved version) and return the jobs due for a backup now.
   */
  private async changed(
    root: Root,
    manual: boolean,
    onCheck?: (checked: number, total: number) => void,
  ) {
    const ready: { id: string; size: number }[] = [];
    const checked = new Set<string>();
    const jobs = this.journal.jobs(root.id);
    let done = 0;
    for (const job of jobs) {
      if (++done % CHECK_REPORT === 0) onCheck?.(done, jobs.length);
      if (this.ignored(root, job.relativePath)) {
        this.journal.drop(job.id);
        continue;
      }
      if (!manual && Date.now() < (job.payload.retryAfter ?? 0)) continue;
      const filename = contained(root.localPath, job.relativePath);
      let info;
      try {
        await verifyParents(root.localPath, job.relativePath, checked);
        info = await lstat(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.journal.drop(job.id);
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        this.journal.drop(job.id);
        continue;
      }
      if (job.kind === 'delete') {
        this.journal.finish(job.id);
        this.journal.enqueue(root.id, job.relativePath, 'upsert');
        continue;
      }
      if (!manual && !backupReady(info.mtimeMs, job.payload.observedAt ?? 0)) continue;
      // Startup rescans and touched-but-identical files queue entries too; they are already saved.
      const known = this.journal.file(root.id, job.relativePath);
      if (
        known?.type === 'FILE' &&
        known.hash &&
        !job.payload.upload?.uploadId &&
        !job.payload.backupEntry &&
        (await hashFile(filename)) === known.hash
      ) {
        this.journal.putFile({ ...known, sizeBytes: info.size, mtimeMs: info.mtimeMs });
        this.journal.finish(job.id);
        continue;
      }
      ready.push({ id: job.id, size: info.size });
    }
    return ready;
  }
  /** Record whether the files waiting need more cloud storage than is free. */
  private storageShort(root: Root, short: Root['backupStorage']) {
    const current = this.journal.roots().find((r) => r.id === root.id);
    if (current && JSON.stringify(current.backupStorage) !== JSON.stringify(short))
      this.journal.root({ ...current, backupStorage: short });
  }
  /**
   * Nothing new records no run, so harbor0 is told the folder is still backed up; otherwise an
   * untouched folder would get a stale-backup reminder. Waiting changes don't count.
   */
  private async upToDate(root: Root, url: string) {
    if (this.journal.pendingCount(root.id)) return;
    const key = `backup-checked:${root.id}`;
    if (Date.now() - (this.journal.get<number>(key) ?? 0) < CHECKED_MS) return;
    await this.api.request(`${url}/checked`, { method: 'POST' });
    this.journal.set(key, Date.now());
  }
  async process(
    root: Root,
    perform: (root: Root, job: LocalJob) => Promise<void>,
    stopped: () => boolean,
    // While a run is got ready: how many of the waiting files have been checked.
    onCheck?: (checked: number, total: number) => void,
  ) {
    if (!root.backupId) {
      const { items } = await this.api.request('/v1/backups');
      const match = items.find(
        (item: { remoteRootDriveItemId: string }) => item.remoteRootDriveItemId === root.remoteId,
      );
      if (!match)
        throw new Error('Backup folder registration was not found. Add this folder again.');
      root = { ...root, backupId: match.id };
      this.journal.root(root);
    }
    const url = `/v1/backups/${root.backupId}`;
    const { root: connection } = await this.api.request(url);
    if (connection.state === 'REMOVED')
      throw new ApiError('BACKUP_DISCONNECTED', 'Backup folder disconnected.', 409);
    await this.restores(root, url);
    const key = `backup-run:${root.id}`;
    const jobsKey = `backup-run-jobs:${root.id}`;
    if (!this.journal.get(key)) await this.convert(root, url, stopped);
    let run = this.journal.get<PendingRun | null>(key);
    if (run?.jobs) {
      const { jobs: legacy, ...rest } = run;
      this.journal.set(jobsKey, legacy);
      run = { ...rest, total: legacy.length, next: 0 };
      this.journal.set(key, run);
    }
    if (!run) {
      const manual = !!this.journal.get(`backup-now:${root.id}`);
      const ready = await this.changed(root, manual, onCheck);
      if (!ready.length) {
        if (manual) this.journal.set(`backup-now:${root.id}`, false);
        this.storageShort(root, undefined);
        // Nothing left that failed (deleted, or saved meanwhile): the folder is backed up, apart
        // from any subfolders it may not read.
        const current = this.journal.roots().find((r) => r.id === root.id);
        const skipped = this.skipped(root);
        if (
          current &&
          current.lastBackupError !== skipped &&
          (skipped || !this.journal.pendingCount(root.id))
        )
          this.journal.root({ ...current, lastBackupError: skipped });
        await this.upToDate(root, url);
        return;
      }
      // Compare what is waiting with the free cloud storage before uploading any of it. Offline,
      // or against an older server, the run goes ahead and uploads are refused one by one.
      const required = ready.reduce((sum, file) => sum + file.size, 0);
      const available = (await this.api.me().catch(() => null))?.storage?.availableBytes;
      const short = available !== undefined && required > available;
      this.storageShort(
        root,
        short
          ? {
              requiredBytes: required,
              availableBytes: available,
              files: ready.filter((file) => file.size > available).length,
            }
          : undefined,
      );
      if (short && !ready.some((file) => file.size <= available)) {
        // Nothing fits: no run to record. The files wait until space is freed.
        if (manual) this.journal.set(`backup-now:${root.id}`, false);
        return;
      }
      run = {
        id: crypto.randomUUID(),
        trigger: manual ? 'MANUAL' : 'AUTOMATIC',
        total: ready.length,
        next: 0,
        ...(short ? { room: available } : {}),
      };
      this.journal.transaction(() => {
        this.journal.set(
          jobsKey,
          ready.map((file) => file.id),
        );
        this.journal.set(key, run);
        this.journal.set(`backup-now:${root.id}`, false);
      });
      // A large run takes hours; say now, not at the end, which subfolders it will leave out.
      const skipped = this.skipped(root);
      const current = this.journal.roots().find((r) => r.id === root.id);
      if (skipped && current && !current.lastBackupError)
        this.journal.root({ ...current, lastBackupError: skipped });
    }
    // A run's list is read once; with a hundred thousand files it is megabytes of JSON.
    let cached = this.runJobs.get(root.id);
    if (cached?.id !== run.id) {
      cached = { id: run.id, jobs: this.journal.get<string[]>(jobsKey) ?? [] };
      this.runJobs.set(root.id, cached);
    }
    const runJobs = cached.jobs;
    await this.api.request(`${url}/runs`, {
      method: 'POST',
      body: { id: run.id, trigger: run.trigger },
    });
    for (let index = run.next ?? 0; index < runJobs.length; index++) {
      const id = runJobs[index];
      if (stopped()) return;
      const job = this.journal.job(id);
      if (job) {
        let before;
        try {
          await safeParents(root.localPath, job.relativePath, false);
          before = await lstat(contained(root.localPath, job.relativePath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // Too big for the storage left: it waits for a later run instead of being refused.
        const tooBig =
          !job.payload.backupEntry && !!before && run.room !== undefined && before.size > run.room;
        if (tooBig) run.tooBig = (run.tooBig ?? 0) + 1;
        else if (
          job.payload.backupEntry ||
          (before?.isFile() &&
            (run.trigger === 'MANUAL' || backupReady(before.mtimeMs, job.payload.observedAt ?? 0)))
        ) {
          try {
            if (!job.payload.backupEntry) {
              job.payload.backupManual = run.trigger === 'MANUAL';
              job.payload.backupRunId = run.id;
              await perform(root, job);
            }
            let entry = job.payload.backupEntry as BackupEntry | undefined;
            if (!entry) {
              const known = this.journal.file(root.id, job.relativePath);
              if (!known) throw new Error('File changed before it could be backed up.');
              const { item } = await this.api.request(`/v1/drive/items/${known.itemId}`);
              entry = {
                relativePath: job.relativePath,
                itemId: item.id,
                versionId: item.currentVersionId,
                sizeBytes: item.sizeBytes,
                modifiedAt: before!.mtime.toISOString(),
                savedAt: new Date().toISOString(),
              };
              job.payload.backupEntry = entry;
              this.journal.saveJob(job);
            }
            await this.api.request(`${url}/runs/${run.id}/files`, { method: 'POST', body: entry });
            this.journal.finish(job.id);
            if (run.room !== undefined) run.room = Math.max(0, run.room - entry.sizeBytes);
            // Changes observed during a transfer must survive completion of its old queue entry.
            const after = await lstat(contained(root.localPath, job.relativePath)).catch(
              () => null,
            );
            if (
              after &&
              (!before ||
                after.mtimeMs !== before.mtimeMs ||
                after.size !== before.size ||
                after.mtime.toISOString() !== entry.modifiedAt)
            ) {
              this.journal.enqueue(root.id, job.relativePath, 'upsert');
              const next = this.journal.pendingJob(root.id, job.relativePath, 'upsert');
              if (next) {
                next.payload.observedAt = Date.now();
                this.journal.saveJob(next);
              }
            }
          } catch (error) {
            // Retain upload state and the run for network retries, including acknowledgement loss.
            // Timed-out requests (including the stall watchdog's abort) may have been applied.
            if (
              error instanceof TypeError ||
              (error as Error).name === 'TimeoutError' ||
              (error as { status?: number }).status! >= 500
            )
              throw error;
            if (error instanceof ApiError && error.code === 'BACKUP_DISCONNECTED') throw error;
            // Too many requests: the pass pauses and this file is tried again, not failed.
            if (error instanceof ApiError && error.status === 429) throw error;
            if (job.payload.upload?.uploadId)
              await cancelUpload(this.api, job.payload.upload.uploadId);
            // The retry belongs to a new run, a different request to the server, so it needs a new
            // operation ID even when no upload was recorded: one may have been made unseen.
            if (job.payload.upload) job.payload.upload = { operationId: crypto.randomUUID() };
            job.attempts++;
            // A path harbor0 never accepts waits a day; retrying each minute cannot help.
            job.payload.retryAfter =
              Date.now() +
              (error instanceof ApiError && error.code === 'PATH_TOO_DEEP' ? 24 * 3600_000 : 60000);
            job.error = (error as Error).message;
            this.journal.saveJob(job);
            if (error instanceof ApiError && error.code === 'STORAGE_QUOTA_EXCEEDED') {
              // From here on only files that fit in what is left are tried.
              const details = (error.details ?? {}) as { availableBytes?: number };
              run.room = details.availableBytes ?? 0;
              run.tooBig = (run.tooBig ?? 0) + 1;
              const current = this.journal.roots().find((r) => r.id === root.id);
              this.storageShort(root, {
                requiredBytes: Math.max(
                  current?.backupStorage?.requiredBytes ?? 0,
                  before?.size ?? 0,
                ),
                availableBytes: run.room,
                files: Math.max(current?.backupStorage?.files ?? 0, run.tooBig),
              });
            } else run.error = `${job.relativePath}: ${job.error}`.slice(0, 2000);
          }
        }
      }
      run.next = index + 1;
      this.journal.set(key, run);
    }
    const error = run.error ?? this.skipped(root);
    const storage = run.tooBig
      ? `${run.tooBig.toLocaleString('en-US')} ${run.tooBig === 1 ? 'file was' : 'files were'} not backed up: there is not enough cloud storage (${fileSize(run.room ?? 0)} free).`
      : undefined;
    const reported = [storage, error].filter(Boolean).join(' ');
    await this.api.request(`${url}/runs/${run.id}/complete`, {
      method: 'POST',
      body: reported ? { error: reported.slice(0, 2000) } : {},
    });
    this.journal.transaction(() => {
      this.journal.set(key, null);
      this.journal.set(jobsKey, null);
    });
    const current = this.journal.roots().find((r) => r.id === root.id);
    if (current && current.lastBackupError !== error)
      this.journal.root({ ...current, lastBackupError: error });
  }
  /**
   * Brings a folder's backup in line with the account's encryption. Only this computer may change
   * its backups, so as encryption is turned on it re-encrypts what was saved before, and as it is
   * turned off it decrypts what was saved since: each file's current version is downloaded,
   * uploaded again the other way and its old versions deleted, then names switch form. Earlier
   * versions go, as when the web app converts the rest of the drive. Runs once per change, inside
   * a backup run of its own.
   */
  private async convert(root: Root, url: string, stopped: () => boolean) {
    const want = this.conversion?.form();
    const doneKey = `backup-converted:${root.id}`;
    if (!want || !root.remoteId || this.journal.get(doneKey) === want) return;
    const raw = this.conversion!.raw;
    const encrypting = want === 'encrypted';
    const items: DriveItem[] = [];
    const folders = [root.remoteId];
    while (folders.length) {
      const folder = folders.pop()!;
      let cursor: string | undefined;
      do {
        const page = await raw.list(folder, cursor);
        for (const item of page.items) {
          items.push(item);
          if (item.type === 'FOLDER') folders.push(item.id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    const content = items.filter((i) => i.type === 'FILE');
    const names = items.filter((i) => isEncryptedName(i.name) !== encrypting);
    if (!content.length && !names.length) return this.journal.set(doneKey, want);
    const runId = crypto.randomUUID();
    await this.api.request(`${url}/runs`, {
      method: 'POST',
      body: { id: runId, trigger: 'MANUAL' },
    });
    const backup = { rootId: root.backupId!, runId };
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'harbor0-convert-'));
    let failed = 0;
    /** Keeps the journal's record of a saved file current, so it isn't saved again. */
    const saved = (item: DriveItem) => {
      const known = this.journal.fileByItem(root.id, item.id);
      if (known) this.journal.putFile({ ...known, revision: item.revision });
    };
    try {
      for (const item of content) {
        if (stopped()) return;
        try {
          let current = item;
          if (!!item.encrypted !== encrypting) {
            const copy = path.join(scratch, item.id);
            await downloadFile(this.api, { driveItemId: item.id }, copy);
            const state: UploadState = { operationId: crypto.randomUUID() };
            current = await uploadFile(
              this.api,
              copy,
              'file',
              item.parentId,
              state,
              () => {},
              { itemId: item.id, revision: item.revision },
              undefined,
              undefined,
              backup,
            );
            await rm(copy, { force: true });
            saved(current);
          }
          // Versions stored the other way, including ones an interrupted pass left behind.
          await this.api.request(
            `/v1/e2ee/items/${item.id}/${encrypting ? 'purge-plaintext' : 'purge-encrypted'}`,
            { method: 'POST' },
          );
          const named = names.find((n) => n.id === item.id);
          if (named) named.revision = current.revision;
        } catch {
          failed++;
        }
      }
      for (const item of names) {
        if (stopped()) return;
        try {
          // The decrypted name, read through the app's own client; a plain one goes up as is
          // and is encrypted on the way.
          const name = encrypting
            ? item.name
            : (await this.api.request(`/v1/drive/items/${item.id}`)).item.name;
          const { item: renamed } = await this.api.request(
            `${url}/runs/${runId}/items/${item.id}/name`,
            {
              method: 'POST',
              body: { operationId: crypto.randomUUID(), baseRevision: item.revision, name },
            },
          );
          saved(renamed);
        } catch {
          failed++;
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await this.api
        .request(`${url}/runs/${runId}/complete`, {
          method: 'POST',
          body: failed ? { error: `${failed} files couldn’t be converted. Retrying.` } : {},
        })
        .catch(() => {});
    }
    if (!failed) this.journal.set(doneKey, want);
  }
  /** Files whose current content is exactly what the cloud copy holds; everything else is left alone. */
  private async saved(root: Root, relative = '') {
    const saved: { relativePath: string; size: number; mtimeMs: number }[] = [];
    const changed: string[] = [];
    for (const entry of await readdir(contained(root.localPath, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (this.ignored(root, name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const nested = await this.saved(root, name);
        saved.push(...nested.saved);
        changed.push(...nested.changed);
      } else if (entry.isFile()) {
        const filename = contained(root.localPath, name);
        const info = await lstat(filename);
        const known = this.journal.file(root.id, name);
        if (known?.type === 'FILE' && known.hash && (await hashFile(filename)) === known.hash)
          saved.push({ relativePath: name, size: info.size, mtimeMs: info.mtimeMs });
        else changed.push(name);
      }
    }
    return { saved, changed };
  }
  private async prune(root: Root, relative = '') {
    const directory = contained(root.localPath, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink() && !this.ignored(root, name))
        await this.prune(root, name);
    }
    const rest = await readdir(directory, { withFileTypes: true });
    // File-manager bookkeeping alone must not keep an emptied folder around.
    if (!rest.every((entry) => entry.isFile() && metadataSegment(entry.name))) return;
    for (const entry of rest) await rm(path.join(directory, entry.name), { force: true });
    await rmdir(directory).catch(() => {});
  }
  /**
   * Finish a requested archive once a full backup has saved everything: stop the backup, then
   * remove only local files verified against their saved version.
   */
  async archive(root: Root, detach: () => Promise<void>, stopped: () => boolean) {
    const url = `/v1/backups/${root.backupId}`;
    const attemptsKey = `backup-archive:${root.id}`;
    // Nothing local has been removed yet, so a failed archive simply keeps backing up.
    const cancel = (reason: string) => {
      this.journal.root({ ...root, archive: undefined, archiveError: reason });
      this.journal.set(attemptsKey, 0);
    };
    if (root.archive === 'pending') {
      if (this.journal.get(`backup-run:${root.id}`) || this.journal.get(`backup-now:${root.id}`))
        return;
      const jobs = this.journal.jobs(root.id);
      const failed = jobs.find((job) => job.error);
      if (failed) return cancel(`${failed.relativePath} could not be backed up: ${failed.error}`);
      const { changed } = jobs.length ? { changed: ['.'] } : await this.saved(root);
      if (stopped()) return;
      if (changed.length) {
        const attempts = (this.journal.get<number>(attemptsKey) ?? 0) + 1;
        if (attempts >= ARCHIVE_ATTEMPTS)
          return cancel('Its files keep changing. Try again when nothing is editing them.');
        // Edits made during the final backup need one more pass before anything is removed.
        this.journal.set(attemptsKey, attempts);
        for (const name of changed) if (name !== '.') this.journal.enqueue(root.id, name, 'upsert');
        this.journal.set(`backup-now:${root.id}`, true);
        return;
      }
      try {
        await this.api.request(`${url}/archive`, { method: 'POST' });
      } catch (error) {
        const reason = refused(error);
        if (!reason) throw error;
        return cancel(reason);
      }
      root = { ...root, archive: 'removing' };
      this.journal.root(root);
    }
    await detach();
    const exists = await lstat(root.localPath).catch(() => null);
    if (exists?.isDirectory() && !exists.isSymbolicLink()) {
      for (const file of (await this.saved(root)).saved) {
        const filename = contained(root.localPath, file.relativePath);
        const info = await lstat(filename);
        if (info.isFile() && info.size === file.size && info.mtimeMs === file.mtimeMs)
          await rm(filename);
      }
      await this.prune(root);
    }
    this.journal.resetRootFiles(root.id);
    this.journal.set(attemptsKey, 0);
    this.journal.root({ ...root, archive: 'archived' });
  }
  /** Bring an archived folder back: resume the backup and download the latest saved files. */
  async unarchive(root: Root, stopped: () => boolean) {
    try {
      await this.api.request(`/v1/backups/${root.backupId}/unarchive`, { method: 'POST' });
    } catch (error) {
      const reason = refused(error);
      if (!reason) throw error;
      this.journal.root({ ...root, archive: 'archived', archiveError: reason });
      return;
    }
    const walk = async (parentId: string, relative: string): Promise<boolean> => {
      let cursor: string | undefined;
      do {
        const page = await this.api.list(parentId, cursor);
        for (const item of page.items as DriveItem[]) {
          if (stopped()) return false;
          const name = safeSegment(item.name, item.id);
          const relativePath = relative ? `${relative}/${name}` : name;
          if (this.ignored(root, relativePath)) continue;
          const destination = await safeParents(root.localPath, relativePath);
          if (item.type === 'FOLDER') {
            await mkdir(destination, { recursive: true });
            if (!(await walk(item.id, relativePath))) return false;
          } else if (!(await lstat(destination).catch(() => null)))
            // Anything already in the folder is newer local work; the next backup saves it.
            await downloadFile(this.api, { driveItemId: item.id }, destination);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return true;
    };
    if (await walk(root.remoteId!, ''))
      this.journal.root({ ...root, archive: undefined, archiveError: undefined });
  }
  private async restores(root: Root, url: string) {
    if (Date.now() < (this.nextRestoreCheck.get(root.id) ?? 0)) return;
    this.nextRestoreCheck.set(root.id, Date.now() + 10000);
    // Pending entries are removed on acknowledgement; always read from the beginning.
    const { items } = await this.api.request(`${url}/pending-restores`);
    for (const request of items as BackupRestore[]) {
      const relativePath =
        this.journal.fileByItem(root.id, request.itemId)?.relativePath ?? request.relativePath;
      const receiptKey = `backup-restore:${request.id}`;
      let receipt = this.journal.get<{ error?: string }>(receiptKey);
      if (!receipt) {
        try {
          const destination = await safeParents(root.localPath, relativePath);
          if (!relativePath || destination === path.resolve(root.localPath))
            throw new Error('Invalid restore destination.');
          const before = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
          });
          // A part file from a different selected version must not be resumed.
          await rm(destination + '.harbor-part', { force: true });
          await downloadFile(
            this.api,
            { driveItemId: request.itemId, versionId: request.versionId },
            destination,
            undefined,
            async () => {
              const { root: connection } = await this.api.request(url);
              if (connection.state === 'REMOVED')
                throw new ApiError('BACKUP_DISCONNECTED', 'Backup folder disconnected.', 409);
              await safeParents(root.localPath, relativePath);
              const current = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
                return null;
              });
              if (
                !!before !== !!current ||
                (before &&
                  current &&
                  (before.mtimeMs !== current.mtimeMs ||
                    before.size !== current.size ||
                    before.ino !== current.ino))
              )
                throw new Error(
                  'The local file changed during restore. Retry after editing is finished.',
                );
            },
          );
          // Record completion before acknowledging so an offline retry cannot overwrite newer edits.
          receipt = {};
        } catch (error) {
          if (error instanceof TypeError || (error as { status?: number }).status! >= 500)
            throw error;
          receipt = { error: (error as Error).message.slice(0, 2000) };
        }
        this.journal.set(receiptKey, receipt);
      }
      await this.api.request(`${url}/restores/${request.id}/complete`, {
        method: 'POST',
        body: receipt,
      });
    }
  }
}
