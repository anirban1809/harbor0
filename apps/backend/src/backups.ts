import type { Device, FileVersion } from '@harbor/contracts';
import type {
  BackupRoot,
  BackupRun,
  BackupEntry,
  BackupRestore,
} from '../../../packages/contracts/src/backups';
import { BACKUP_STALE_MS, StorageService, userPK, watchedBackup, type Job } from './domain';
import { Transaction, transact } from './repository';
import { assert } from './errors';
const partition = (userId: string, rootId: string) => `${userPK(userId)}#BACKUP#${rootId}`;
// When the folder's last backup run finished, kept for its stale-backup reminder.
type LastRun = { completedAt: string };
// A device saying nothing changed re-arms the reminder at most this often.
const CHECKED_MS = 12 * 3600_000;
export class Backups {
  constructor(private service: StorageService) {}
  async root(tx: Transaction, userId: string, rootId: string, deviceId?: string) {
    const root = await tx.get<BackupRoot>(userPK(userId), `BACKUP#${rootId}`);
    assert(root, 'ITEM_NOT_FOUND', 'Backup folder was not found.', 404);
    if (deviceId !== undefined) {
      const device = await this.service.checkDevice(userId, deviceId);
      const owner =
        root.devicePublicId ??
        (await tx.get<Device>(userPK(userId), `DEVICE#${root.deviceId}`))?.devicePublicId;
      assert(
        root.deviceId === deviceId || (device.devicePublicId && device.devicePublicId === owner),
        'FORBIDDEN',
        'Use the computer that owns this backup folder.',
        403,
      );
    }
    return root;
  }
  async connected(tx: Transaction, userId: string, rootId: string, deviceId?: string) {
    const root = await this.root(tx, userId, rootId, deviceId);
    assert(
      root.state !== 'REMOVED',
      'BACKUP_DISCONNECTED',
      'This folder is no longer connected for backup.',
      409,
    );
    return root;
  }
  async get(userId: string, rootId: string) {
    return { root: await this.root(new Transaction(this.service.repo), userId, rootId) };
  }
  async disconnect(userId: string, rootId: string) {
    return transact(this.service.repo, async (tx) => {
      const root = await this.root(tx, userId, rootId);
      if (root.state !== 'REMOVED') {
        root.state = 'REMOVED';
        root.updatedAt = new Date().toISOString();
        await tx.put(userPK(userId), `BACKUP#${root.id}`, root);
        await this.service.record(tx, userId, 'BACKUP_DISCONNECTED', root.remoteRootDriveItemId);
      }
      return { root };
    });
  }
  /** Archived folders keep their read-only cloud copy; the source computer removes its local files. */
  async archive(userId: string, rootId: string, deviceId: string, archived: boolean) {
    return transact(this.service.repo, async (tx) => {
      const root = await this.connected(tx, userId, rootId, deviceId);
      if ((root.state === 'ARCHIVED') !== archived) {
        root.state = archived ? 'ARCHIVED' : 'ACTIVE';
        root.updatedAt = new Date().toISOString();
        await tx.put(userPK(userId), `BACKUP#${root.id}`, root);
        if (!archived) await this.rearm(tx, userId, rootId);
      }
      return { root };
    });
  }
  private active(root: BackupRoot) {
    assert(
      root.state !== 'ARCHIVED',
      'BACKUP_ARCHIVED',
      'This backup folder is archived. Restore the folder to its computer first.',
      409,
    );
  }
  /** Remove a stopped backup and its run/restore history. Its cloud folder is untouched. */
  async forget(userId: string, rootId: string) {
    const repo = this.service.repo;
    const root = await new Transaction(repo).get<BackupRoot>(userPK(userId), `BACKUP#${rootId}`);
    if (!root) return { removed: true };
    assert(
      root.state === 'REMOVED',
      'VALIDATION_ERROR',
      'Stop backing up this folder before removing it.',
      409,
    );
    const pk = partition(userId, rootId);
    for (const prefix of ['ENTRY#', 'RUN#', 'RESTORE#', 'PENDING#', 'LAST_RUN']) {
      for (;;) {
        const page = await repo.query(pk, prefix, 25);
        if (!page.rows.length) break;
        await transact(repo, async (tx) => {
          for (const row of page.rows) await tx.delete(pk, row.sk);
        });
      }
    }
    await transact(repo, (tx) => tx.delete(userPK(userId), `BACKUP#${rootId}`));
    return { removed: true };
  }
  async page(userId: string, rootId: string, prefix: string, cursor?: string) {
    const root = await this.root(new Transaction(this.service.repo), userId, rootId);
    if (prefix === 'PENDING#' && root.state === 'REMOVED') return { items: [], nextCursor: null };
    const page = await this.service.repo.query(partition(userId, rootId), prefix, 100, cursor);
    return { items: page.rows.map((row) => row.data), nextCursor: page.cursor };
  }
  async start(
    userId: string,
    rootId: string,
    deviceId: string,
    input: { id: string; trigger: BackupRun['trigger'] },
  ) {
    return transact(this.service.repo, async (tx) => {
      const root = await this.connected(tx, userId, rootId, deviceId);
      const pk = partition(userId, rootId);
      const existing = await tx.get<BackupRun>(pk, `RUN#${input.id}`);
      if (existing) return { run: existing };
      this.active(root);
      const run: BackupRun = {
        ...input,
        rootId,
        deviceId,
        state: 'RUNNING',
        startedAt: new Date().toISOString(),
        completedAt: null,
        fileCount: 0,
        sizeBytes: 0,
      };
      await tx.put(pk, `RUN#${run.id}`, run);
      return { run };
    });
  }
  async version(
    tx: Transaction,
    userId: string,
    root: BackupRoot,
    itemId: string,
    versionId: string,
  ) {
    let item = await this.service.owned(tx, userId, itemId);
    assert(item.type === 'FILE', 'VALIDATION_ERROR', 'Choose a file version.');
    const segments = [item.name];
    const seen = new Set<string>();
    while (item.parentId !== root.remoteRootDriveItemId) {
      assert(
        item.parentId && !seen.has(item.parentId),
        'FORBIDDEN',
        'File is outside this backup folder.',
        403,
      );
      seen.add(item.parentId);
      item = await this.service.owned(tx, userId, item.parentId);
      segments.unshift(item.name);
    }
    const version = await tx.get<FileVersion>(userPK(userId), `VERSION#${itemId}#${versionId}`);
    assert(version, 'ITEM_NOT_FOUND', 'File version was not found.', 404);
    return { version, relativePath: segments.join('/') };
  }
  async entry(userId: string, rootId: string, deviceId: string, runId: string, input: BackupEntry) {
    return transact(this.service.repo, async (tx) => {
      const root = await this.connected(tx, userId, rootId, deviceId);
      const pk = partition(userId, rootId);
      const run = await tx.get<BackupRun>(pk, `RUN#${runId}`);
      assert(run, 'ITEM_NOT_FOUND', 'Backup run was not found.', 404);
      const key = `ENTRY#${runId}#${input.itemId}#${input.versionId}`;
      if (await tx.get(pk, key)) return { saved: true };
      assert(run.state === 'RUNNING', 'VALIDATION_ERROR', 'Backup is already complete.');
      const { version, relativePath } = await this.version(
        tx,
        userId,
        root,
        input.itemId,
        input.versionId,
      );
      assert(
        input.relativePath.normalize('NFC') === relativePath.normalize('NFC'),
        'VALIDATION_ERROR',
        'Backup file path does not match.',
      );
      await tx.put(pk, key, { ...input, sizeBytes: version.sizeBytes });
      await tx.put(pk, `RUN#${runId}`, {
        ...run,
        fileCount: run.fileCount + 1,
        sizeBytes: run.sizeBytes + version.sizeBytes,
      });
      return { saved: true };
    });
  }
  async finish(userId: string, rootId: string, deviceId: string, runId: string, error?: string) {
    return transact(this.service.repo, async (tx) => {
      await this.connected(tx, userId, rootId, deviceId);
      const pk = partition(userId, rootId);
      const run = await tx.get<BackupRun>(pk, `RUN#${runId}`);
      assert(run, 'ITEM_NOT_FOUND', 'Backup run was not found.', 404);
      if (run.state === 'RUNNING') {
        run.state = error ? (run.fileCount ? 'PARTIAL' : 'FAILED') : 'COMPLETED';
        run.completedAt = new Date().toISOString();
        if (error) run.error = error;
        await tx.put(pk, `RUN#${runId}`, run);
        if (run.state !== 'FAILED') {
          await tx.put(pk, 'LAST_RUN', { completedAt: run.completedAt } satisfies LastRun);
          await this.service.scheduleBackupCheck(tx, userId, rootId, run.completedAt);
        }
      }
      return { run };
    });
  }
  /**
   * The source device found nothing new to back up, so the folder is still protected: pushes
   * its stale-backup reminder out without recording an empty run.
   */
  async checked(userId: string, rootId: string, deviceId: string) {
    return transact(this.service.repo, async (tx) => {
      const root = await this.connected(tx, userId, rootId, deviceId);
      if (!watchedBackup(root)) return { checked: false };
      const check = await tx.get<Job>('JOB', `backup-check-${rootId}`);
      if (check && Date.parse(check.dueAt) > Date.now() + BACKUP_STALE_MS - CHECKED_MS)
        return { checked: true };
      await this.rearm(tx, userId, rootId);
      return { checked: true };
    });
  }
  private async rearm(tx: Transaction, userId: string, rootId: string) {
    const last = await tx.get<LastRun>(partition(userId, rootId), 'LAST_RUN');
    await this.service.scheduleBackupCheck(tx, userId, rootId, last?.completedAt ?? null);
  }
  /**
   * Gives folders backed up before stale-backup reminders existed their first check, due a week
   * after their last finished run (or now, when that is already past). Returns how many it armed.
   */
  async backfillChecks(userId: string, apply: boolean) {
    const repo = this.service.repo;
    const roots = await new Transaction(repo).list<BackupRoot>(userPK(userId), 'BACKUP#');
    let armed = 0;
    for (const root of roots.filter(watchedBackup)) {
      if (await repo.get({ pk: 'JOB', sk: `backup-check-${root.id}` })) continue;
      let last: string | null = null;
      let cursor: string | undefined;
      do {
        const page = await repo.query(partition(userId, root.id), 'RUN#', 100, cursor);
        for (const row of page.rows) {
          const run = row.data as BackupRun;
          if (run.state !== 'FAILED' && run.completedAt && (!last || run.completedAt > last))
            last = run.completedAt;
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
      armed++;
      if (!apply) continue;
      const due = Math.max(Date.now(), Date.parse(last ?? root.createdAt) + BACKUP_STALE_MS);
      await transact(repo, async (tx) => {
        if (last) await tx.put(partition(userId, root.id), 'LAST_RUN', { completedAt: last });
        await this.service.scheduleBackupCheck(
          tx,
          userId,
          root.id,
          last,
          new Date(due).toISOString(),
        );
      });
    }
    return armed;
  }
  async restore(
    userId: string,
    rootId: string,
    input: { id: string; itemId: string; versionId: string },
  ) {
    return transact(this.service.repo, async (tx) => {
      const root = await this.connected(tx, userId, rootId);
      const pk = partition(userId, rootId);
      const existing = await tx.get<BackupRestore>(pk, `RESTORE#${input.id}`);
      if (existing) {
        assert(
          existing.itemId === input.itemId && existing.versionId === input.versionId,
          'IDEMPOTENCY_KEY_REUSED',
          'Restore request has different content.',
          409,
        );
        return { restore: existing };
      }
      this.active(root);
      const { relativePath } = await this.version(tx, userId, root, input.itemId, input.versionId);
      const restore: BackupRestore = {
        ...input,
        rootId,
        relativePath,
        state: 'PENDING',
        requestedAt: new Date().toISOString(),
        completedAt: null,
      };
      await tx.put(pk, `RESTORE#${input.id}`, restore);
      await tx.put(pk, `PENDING#${input.id}`, restore);
      return { restore };
    });
  }
  async restored(userId: string, rootId: string, deviceId: string, id: string, error?: string) {
    return transact(this.service.repo, async (tx) => {
      await this.connected(tx, userId, rootId, deviceId);
      const pk = partition(userId, rootId);
      const restore = await tx.get<BackupRestore>(pk, `RESTORE#${id}`);
      assert(restore, 'ITEM_NOT_FOUND', 'Restore request was not found.', 404);
      if (restore.state === 'PENDING') {
        await tx.put(pk, `RESTORE#${id}`, {
          ...restore,
          state: error ? 'FAILED' : 'COMPLETED',
          completedAt: new Date().toISOString(),
          ...(error ? { error } : {}),
        });
        await tx.delete(pk, `PENDING#${id}`);
      }
      return { saved: true };
    });
  }
}
