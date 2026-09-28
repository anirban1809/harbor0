import path from 'node:path';
import { lstat, readdir, rm } from 'node:fs/promises';
import type { ApiClient } from '@harbor/api-client';
import type { BackupEntry, BackupRestore } from '../../../packages/contracts/src/backups';
import { Journal, type Root, type LocalJob } from './journal';
import { contained, safeParents } from './paths';
import { downloadFile } from './transfers';
export const BACKUP_QUIET_MS = 60 * 60 * 1000;
export function backupReady(mtimeMs: number, observedAt = 0, now = Date.now()) {
  return now - Math.max(mtimeMs, observedAt) >= BACKUP_QUIET_MS;
}
type PendingRun = { id: string; trigger: 'MANUAL' | 'AUTOMATIC'; jobs: string[]; error?: string };
export class FolderBackups {
  private nextRestoreCheck = new Map<string, number>();
  constructor(
    private api: ApiClient,
    private journal: Journal,
  ) {}
  private ignored(root: Root, relative: string) {
    return (
      relative.split('/').some((p) => p.startsWith('.harbor-') || p.endsWith('.harbor-part')) ||
      root.excluded.some((p) => relative === p || relative.startsWith(p + '/'))
    );
  }
  async request(root: Root) {
    if (root.paused) throw new Error('Resume this backup folder before backing up now.');
    if (this.journal.get(`backup-run:${root.id}`))
      throw new Error('A backup is already running for this folder.');
    // Persist intent before scanning; an interrupted scan is repeated by the next tick.
    this.journal.set(`backup-now:${root.id}`, true);
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
    await this.restores(root, url);
    const key = `backup-run:${root.id}`;
    let run = this.journal.get<PendingRun | null>(key);
    if (!run) {
      const manual = !!this.journal.get(`backup-now:${root.id}`);
      if (manual) await this.scan(root);
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
        if (manual || backupReady(info.mtimeMs, job.payload.observedAt ?? 0)) ready.push(job.id);
      }
      if (!ready.length && !manual) return;
      run = { id: crypto.randomUUID(), trigger: manual ? 'MANUAL' : 'AUTOMATIC', jobs: ready };
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
