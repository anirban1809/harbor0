import path from 'node:path';
import { lstat, mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { ApiClient, ApiError } from '@harbor/api-client';
import type { BackupEntry, BackupRestore } from '../../../packages/contracts/src/backups';
import { Journal, type Root, type LocalJob } from './journal';
import type { DriveItem } from '@harbor/contracts';
import { contained, internalPath, metadataSegment, safeParents, safeSegment } from './paths';
import { downloadFile, hashFile } from './transfers';
export const BACKUP_QUIET_MS = 60 * 60 * 1000;
export function backupReady(mtimeMs: number, observedAt = 0, now = Date.now()) {
  return now - Math.max(mtimeMs, observedAt) >= BACKUP_QUIET_MS;
}
type PendingRun = {
  id: string;
  trigger: 'MANUAL' | 'AUTOMATIC';
  jobs: string[];
  // Files in the run when it started; `jobs` shrinks as each one is saved.
  total?: number;
  error?: string;
};
const ARCHIVE_ATTEMPTS = 3;
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
export class FolderBackups {
  private nextRestoreCheck = new Map<string, number>();
  constructor(
    private api: ApiClient,
    private journal: Journal,
  ) {}
  /** Files saved and files in the backup run under way, if one is. */
  run(rootId: string) {
    const run = this.journal.get<PendingRun | null>(`backup-run:${rootId}`);
    if (!run) return null;
    const total = Math.max(run.total ?? 0, run.jobs.length);
    return { done: total - run.jobs.length, total };
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
  private async scan(root: Root, relative = '') {
    const directory = contained(root.localPath, relative);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('Backup folder is unavailable.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (this.ignored(root, name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.scan(root, name);
      else if (entry.isFile()) this.journal.enqueue(root.id, name, 'upsert');
    }
  }
  /**
   * Settle this folder's queue: drop entries with nothing to save (missing, excluded, or content
   * identical to the last saved version) and return the jobs due for a backup now.
   */
  private async changed(root: Root, manual: boolean) {
    const ready: string[] = [];
    for (const job of this.journal.jobs().filter((j) => j.rootId === root.id)) {
      if (this.ignored(root, job.relativePath)) {
        this.journal.finish(job.id);
        continue;
      }
      if (!manual && Date.now() < (job.payload.retryAfter ?? 0)) continue;
      const filename = contained(root.localPath, job.relativePath);
      let info;
      try {
        await safeParents(root.localPath, job.relativePath, false);
        info = await lstat(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.journal.finish(job.id);
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        this.journal.finish(job.id);
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
      ready.push(job.id);
    }
    return ready;
  }
  /**
   * Nothing new records no run, so harbor0 is told the folder is still backed up; otherwise an
   * untouched folder would get a stale-backup reminder. Waiting changes don't count.
   */
  private async upToDate(root: Root, url: string) {
    if (this.journal.jobs().some((j) => j.rootId === root.id)) return;
    const key = `backup-checked:${root.id}`;
    if (Date.now() - (this.journal.get<number>(key) ?? 0) < CHECKED_MS) return;
    await this.api.request(`${url}/checked`, { method: 'POST' });
    this.journal.set(key, Date.now());
  }
  async process(
    root: Root,
    perform: (root: Root, job: LocalJob) => Promise<void>,
    stopped: () => boolean,
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
    let run = this.journal.get<PendingRun | null>(key);
    if (!run) {
      const manual = !!this.journal.get(`backup-now:${root.id}`);
      const ready = await this.changed(root, manual);
      if (!ready.length) {
        if (manual) this.journal.set(`backup-now:${root.id}`, false);
        await this.upToDate(root, url);
        return;
      }
      run = {
        id: crypto.randomUUID(),
        trigger: manual ? 'MANUAL' : 'AUTOMATIC',
        jobs: ready,
        total: ready.length,
      };
      this.journal.set(key, run);
      this.journal.set(`backup-now:${root.id}`, false);
    }
    await this.api.request(`${url}/runs`, {
      method: 'POST',
      body: { id: run.id, trigger: run.trigger },
    });
    for (const id of [...run.jobs]) {
      if (stopped()) return;
      const job = this.journal.jobs().find((j) => j.id === id);
      if (job) {
        let before;
        try {
          await safeParents(root.localPath, job.relativePath, false);
          before = await lstat(contained(root.localPath, job.relativePath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (
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
              const next = this.journal
                .jobs()
                .find(
                  (j) =>
                    j.rootId === root.id &&
                    j.relativePath === job.relativePath &&
                    j.kind === 'upsert',
                );
              if (next) {
                next.payload.observedAt = Date.now();
                this.journal.saveJob(next);
              }
            }
          } catch (error) {
            // Retain upload state and the run for network retries, including acknowledgement loss.
            if (error instanceof TypeError || (error as { status?: number }).status! >= 500)
              throw error;
            if (error instanceof ApiError && error.code === 'BACKUP_DISCONNECTED') throw error;
            if (job.payload.upload?.uploadId) {
              await this.api.request(`/v1/uploads/${job.payload.upload.uploadId}`, {
                method: 'DELETE',
              });
              job.payload.upload = { operationId: crypto.randomUUID() };
            }
            job.attempts++;
            job.payload.retryAfter = Date.now() + 60000;
            job.error = (error as Error).message;
            this.journal.saveJob(job);
            run.error = `${job.relativePath}: ${job.error}`.slice(0, 2000);
          }
        }
      }
      run.jobs = run.jobs.filter((jobId) => jobId !== id);
      this.journal.set(key, run);
    }
    await this.api.request(`${url}/runs/${run.id}/complete`, {
      method: 'POST',
      body: run.error ? { error: run.error } : {},
    });
    this.journal.set(key, null);
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
      const jobs = this.journal.jobs().filter((job) => job.rootId === root.id);
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
