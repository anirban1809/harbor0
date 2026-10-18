import { storageUsage } from '@harbor/contracts';
import {
  ADMIN_BACKUP_RUNS,
  type AdminBackupRun,
  type AdminBackups,
} from '../../../../packages/contracts/src/admin';
import type { ActivityState } from '../../../../packages/contracts/src/activity';
import type { BackupRoot, BackupRun } from '../../../../packages/contracts/src/backups';
import { backupPartition } from '../backups';
import { userPK, type Account } from '../domain';
import type { Repository } from '../repository';

/** Runs read per folder at most; a folder with more lists its newest among these. */
const RUNS_READ = 2000;

const STORAGE_SHORT =
  /^[\d,.]+ files? (?:was|were) not backed up: there is not enough cloud storage \([^)]*\)\./;
const UNREADABLE = /^harbor0 does not have permission to read (?:this folder|these folders): /;

/**
 * A run's error as the device wrote it, without the person's file and folder names. Devices
 * write up to three parts: files left for want of storage, then either one file's failure
 * (`<path>: <message>`) or the folders it may not read (named). Anything else that still looks
 * like a path is blanked too.
 */
export function redactBackupError(error: string | undefined) {
  if (!error) return null;
  let rest = error.trim();
  const parts: string[] = [];
  const storage = STORAGE_SHORT.exec(rest);
  if (storage) {
    parts.push(storage[0]);
    rest = rest.slice(storage[0].length).trim();
  }
  if (UNREADABLE.test(rest)) parts.push('harbor0 does not have permission to read some folders.');
  else if (rest) {
    // `<path>: <message>`, as every device version writes a file's failure.
    const split = rest.indexOf(': ');
    parts.push(split > 0 ? `A file failed: ${rest.slice(split + 2)}` : rest);
  }
  return parts.join(' ').replace(/[^\s:]*[\\/][^\s:]*/g, '…');
}

const adminRun = (run: BackupRun): AdminBackupRun => ({
  id: run.id,
  trigger: run.trigger,
  state: run.state,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  fileCount: run.fileCount,
  sizeBytes: run.sizeBytes,
  plannedFileCount: run.plannedFileCount ?? null,
  plannedSizeBytes: run.plannedSizeBytes ?? null,
  lastSavedAt: run.lastSavedAt ?? null,
  error: redactBackupError(run.error),
});

/** Every backup folder of the account with its newest runs, for the console's backups page. */
export async function backupRuns(repo: Repository, userId: string): Promise<AdminBackups> {
  const [roots, states] = await Promise.all([
    list<BackupRoot>(repo, userPK(userId), 'BACKUP#'),
    list<ActivityState>(repo, userPK(userId), 'ACTIVITY#'),
  ]);
  const account = (await repo.get({ pk: userPK(userId), sk: 'PROFILE' }))?.data as
    Account | undefined;
  const storage = account
    ? storageUsage(account)
    : { quotaBytes: 0, usedBytes: 0, availableBytes: 0 };
  const backups = await Promise.all(
    roots.map(async (root) => {
      const runs = (
        await list<BackupRun>(repo, backupPartition(userId, root.id), 'RUN#', RUNS_READ)
      ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return {
        id: root.id,
        folderName: root.localPathDisplayName,
        deviceName: root.deviceName ?? null,
        state: root.state,
        createdAt: root.createdAt,
        updatedAt: root.updatedAt,
        runs: runs.slice(0, ADMIN_BACKUP_RUNS).map(adminRun),
        runCount: runs.length,
        ...reported(root, states),
      };
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    storage: {
      quotaBytes: storage.quotaBytes,
      usedBytes: storage.usedBytes,
      availableBytes: storage.availableBytes,
    },
    backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

/** What the backup's computer last reported about the folder and about its engine. */
export function reported(root: BackupRoot, states: ActivityState[]) {
  const status = states.find((s) => s.scope === 'BACKUP' && s.folderId === root.id) ?? null;
  const device = (s: ActivityState) =>
    status
      ? s.deviceKey === status.deviceKey
      : s.deviceId === root.deviceId ||
        (!!root.devicePublicId && s.deviceKey === `installation:${root.devicePublicId}`);
  const engine = states.find((s) => s.scope === 'ENGINE' && device(s)) ?? null;
  return { status, engine };
}

export async function list<T>(repo: Repository, pk: string, prefix: string, max = Infinity) {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.query(pk, prefix, 100, cursor);
    out.push(...page.rows.map((row) => row.data as T));
    cursor = page.cursor ?? undefined;
  } while (cursor && out.length < max);
  return out;
}
