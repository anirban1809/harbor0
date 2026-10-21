import { GAVE_UP_ATTEMPTS } from './retry-policy';
import { DatabaseSync } from 'node:sqlite';
import type { Volume } from './volumes';
export type Root = {
  id: string;
  localPath: string;
  remoteId: string | null;
  mode: 'sync' | 'backup';
  backupId?: string;
  // Backup folders only: set while the local copy is being removed, is gone, or is coming back.
  archive?: 'pending' | 'removing' | 'archived' | 'restoring';
  archiveError?: string;
  paused: boolean;
  excluded: string[];
  cloudPath?: string;
  needsReconcile?: boolean;
  shareId?: string;
  sharedBy?: string;
  // The owner's display name when the folder was joined, for notices once access ends.
  sharedByName?: string;
  sharedSequence?: number;
  lastSyncedAt?: string;
  // Backup folders only: why the last run skipped files or failed; cleared by a clean run.
  lastBackupError?: string;
  // Backup folders only: the files waiting to be saved need more cloud storage than is free.
  // Files that fit still back up; set when a run starts or an upload is refused for storage.
  backupStorage?: { requiredBytes: number; availableBytes: number; files: number };
  // The removable or secondary drive the folder is on, recorded when it is first seen there.
  volume?: Volume;
  // On a network share, which is checked with time limits; kept while the share is away.
  network?: boolean;
};
export type LocalFile = {
  rootId: string;
  relativePath: string;
  itemId: string;
  revision: number;
  hash: string | null;
  type: 'FILE' | 'FOLDER';
  // The local file's size and modification time when it last matched the cloud copy, so a
  // scan can tell an untouched file from an edit without reading it.
  sizeBytes?: number;
  mtimeMs?: number;
};
/** One detected local change. It stays pending until the job carrying it has finished. */
export type ChangeRecord = {
  id: string;
  rootId: string;
  relativePath: string;
  kind: 'upsert' | 'delete';
  source: string;
  detectedAt: number;
  syncedAt: number | null;
};
export type ChangeSummary = {
  pending: number;
  lastDetectedAt: number | null;
  lastSyncedAt: number | null;
};
// Finished changes are kept this long for diagnostics, then pruned.
const CHANGE_HISTORY_MS = 7 * 24 * 3600_000;
export type LocalJob = {
  id: string;
  rootId: string;
  relativePath: string;
  kind: 'upsert' | 'delete';
  payload: Record<string, any>;
  attempts: number;
  error: string | null;
};
type JobRow = {
  id: string;
  root_id: string;
  relative_path: string;
  kind: 'upsert' | 'delete';
  payload: string;
  attempts: number;
  error: string | null;
};
const jobFromRow = (r: JobRow): LocalJob => ({
  id: r.id,
  rootId: r.root_id,
  relativePath: r.relative_path,
  kind: r.kind,
  payload: JSON.parse(r.payload),
  attempts: r.attempts,
  error: r.error,
});
// Pending items one folder lists; a folder with more shows the first of them.
const PENDING_CHILDREN = 5000;
// Failed jobs sent to the window; past this many it only needs to know there are failures.
const JOB_SUMMARY_FAILURES = 500;
export class Journal {
  db: DatabaseSync;
  private transactionDepth = 0;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO schema_version VALUES(1);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS files(root_id TEXT NOT NULL,relative_path TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(root_id,relative_path));
 CREATE INDEX IF NOT EXISTS files_item ON files(root_id,json_extract(data, '$.itemId'));
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,relative_path TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL DEFAULT '{}',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,root_id TEXT NOT NULL,relative_path TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,detected_at INTEGER NOT NULL,synced_at INTEGER);
 CREATE INDEX IF NOT EXISTS changes_pending ON changes(root_id,synced_at);
 CREATE INDEX IF NOT EXISTS changes_job ON changes(job_id);
 CREATE INDEX IF NOT EXISTS jobs_path ON jobs(root_id,relative_path,kind);
 CREATE INDEX IF NOT EXISTS jobs_kind ON jobs(root_id,kind);
 CREATE INDEX IF NOT EXISTS jobs_failed ON jobs(created_at,id) WHERE error IS NOT NULL;
 CREATE INDEX IF NOT EXISTS changes_detected ON changes(root_id,detected_at);
 CREATE INDEX IF NOT EXISTS files_type ON files(root_id,json_extract(data, '$.type'));
 `);
    this.db.prepare('DELETE FROM changes WHERE synced_at < ?').run(Date.now() - CHANGE_HISTORY_MS);
    // Changes whose job is gone (an older version, a crash between statements) cannot finish.
    this.db
      .prepare(
        'UPDATE changes SET synced_at=? WHERE synced_at IS NULL AND job_id NOT IN (SELECT id FROM jobs)',
      )
      .run(Date.now());
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  devicePublicId(): string {
    let id = this.get<string>('publicId');
    if (!id) {
      id = crypto.randomUUID();
      this.set('publicId', id);
    }
    return id;
  }
  roots(): Root[] {
    return (this.db.prepare('SELECT data FROM roots').all() as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }
  root(root: Root) {
    this.db
      .prepare(
        'INSERT INTO roots(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(root.id, JSON.stringify(root));
  }
  removeRoot(id: string) {
    // This removes only local bookkeeping. Neither copy of the files is deleted.
    this.db.exec('BEGIN');
    try {
      this.abandonJobs(id);
      this.db.prepare('DELETE FROM jobs WHERE root_id=?').run(id);
      this.db.prepare('DELETE FROM changes WHERE root_id=?').run(id);
      this.db.prepare('DELETE FROM files WHERE root_id=?').run(id);
      this.db.prepare('DELETE FROM roots WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  resetRootFiles(id: string) {
    this.abandonJobs(id);
    this.db.prepare('DELETE FROM jobs WHERE root_id=?').run(id);
    this.db.prepare('DELETE FROM changes WHERE root_id=?').run(id);
    this.db.prepare('DELETE FROM files WHERE root_id=?').run(id);
  }
  file(rootId: string, relativePath: string): LocalFile | undefined {
    const row = this.db
      .prepare('SELECT data FROM files WHERE root_id=? AND relative_path=?')
      .get(rootId, relativePath) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  fileByItem(rootId: string, itemId: string): LocalFile | undefined {
    const row = this.db
      .prepare("SELECT data FROM files WHERE root_id=? AND json_extract(data, '$.itemId')=?")
      .get(rootId, itemId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  /** Work waiting, leaving out files harbor0 stopped retrying (see retry-policy). */
  jobCount(): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM jobs WHERE attempts < ?')
        .get(GAVE_UP_ATTEMPTS) as { count: number }
    ).count;
  }
  /**
   * Queued uploads seen from one folder (`prefix` is '' or ends in '/'): the jobs directly in it,
   * and one job from each subfolder holding more. A folder shows its pending children this way
   * without reading a queue that can hold hundreds of thousands of files.
   */
  pendingChildren(rootId: string, prefix: string): { direct: string[]; deeper: string[] } {
    const length = [...prefix].length;
    const under = `SELECT id, relative_path, instr(substr(relative_path, ? + 1), '/') AS slash
      FROM jobs WHERE root_id = ? AND kind = 'upsert' AND substr(relative_path, 1, ?) = ?`;
    const args = [length, rootId, length, prefix];
    const direct = this.db
      .prepare(`SELECT id FROM (${under}) WHERE slash = 0 LIMIT ?`)
      .all(...args, PENDING_CHILDREN) as { id: string }[];
    const deeper = this.db
      .prepare(
        `SELECT MIN(id) AS id FROM (${under}) WHERE slash > 0
         GROUP BY substr(relative_path, 1, ? + slash - 1) LIMIT ?`,
      )
      .all(...args, length, PENDING_CHILDREN) as { id: string }[];
    return { direct: direct.map((row) => row.id), deeper: deeper.map((row) => row.id) };
  }
  /** Paths with a job queued in one folder, without reading the jobs themselves. */
  pendingPaths(rootId: string): Set<string> {
    const rows = this.db.prepare('SELECT relative_path FROM jobs WHERE root_id=?').all(rootId) as {
      relative_path: string;
    }[];
    return new Set(rows.map((row) => row.relative_path));
  }
  pendingCount(rootId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM jobs WHERE root_id=? AND attempts < ?')
        .get(rootId, GAVE_UP_ATTEMPTS) as {
        count: number;
      }
    ).count;
  }
  jobCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        'SELECT root_id AS rootId, COUNT(*) AS count FROM jobs WHERE attempts < ? GROUP BY root_id',
      )
      .all(GAVE_UP_ATTEMPTS) as { rootId: string; count: number }[];
    return new Map(rows.map((row) => [row.rootId, row.count]));
  }
  files(rootId: string): LocalFile[] {
    return (
      this.db.prepare('SELECT data FROM files WHERE root_id=?').all(rootId) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  /** The synced items directly inside `folder`, a relative path ('' for the top of the root). */
  children(rootId: string, folder: string): LocalFile[] {
    const prefix = folder ? folder + '/' : '';
    return (
      this.db
        .prepare(
          "SELECT data FROM files WHERE root_id=? AND substr(relative_path, 1, ?) = ? AND instr(substr(relative_path, ?), '/') = 0",
        )
        .all(rootId, [...prefix].length, prefix, [...prefix].length + 1) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  folders(rootId: string): LocalFile[] {
    return (
      this.db
        .prepare("SELECT data FROM files WHERE root_id=? AND json_extract(data, '$.type')='FOLDER'")
        .all(rootId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  fileCounts(rootId: string): { fileCount: number; folderCount: number } {
    // Counted from the files_type index, so no row's JSON is read.
    const count = (type: string) =>
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM files WHERE root_id = ? AND json_extract(data, '$.type') = ?",
          )
          .get(rootId, type) as { count: number }
      ).count;
    return { fileCount: count('FILE'), folderCount: count('FOLDER') };
  }
  putFile(file: LocalFile) {
    this.db
      .prepare(
        'INSERT INTO files(root_id,relative_path,data) VALUES(?,?,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET data=excluded.data',
      )
      .run(file.rootId, file.relativePath, JSON.stringify(file));
  }
  deleteFile(rootId: string, relativePath: string) {
    this.db
      .prepare('DELETE FROM files WHERE root_id=? AND relative_path=?')
      .run(rootId, relativePath);
  }
  enqueue(
    rootId: string,
    relativePath: string,
    kind: 'upsert' | 'delete',
    entry?: { type: 'FILE' | 'FOLDER'; sizeBytes: number; updatedAt: string },
    source = 'local',
  ): string {
    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE root_id=? AND relative_path=? AND kind=?')
      .get(rootId, relativePath, kind);
    const jobId = (existing?.id as string | undefined) ?? crypto.randomUUID();
    // Repeated events for a change that is still waiting are the same change.
    const open = this.db
      .prepare('SELECT 1 FROM changes WHERE job_id=? AND synced_at IS NULL')
      .get(jobId);
    if (!open)
      this.db
        .prepare(
          'INSERT INTO changes(id,job_id,root_id,relative_path,kind,source,detected_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(crypto.randomUUID(), jobId, rootId, relativePath, kind, source, Date.now());
    if (existing) {
      // A fresh local change retries immediately instead of waiting out an earlier failure.
      this.db
        .prepare("UPDATE jobs SET payload=json_remove(payload, '$.retryAt') WHERE id=?")
        .run(existing.id as string);
      if (entry)
        this.db
          .prepare("UPDATE jobs SET payload=json_set(payload, '$.entry', json(?)) WHERE id=?")
          .run(JSON.stringify(entry), existing.id as string);
      return jobId;
    }
    this.db
      .prepare(
        'INSERT INTO jobs(id,root_id,relative_path,kind,created_at,payload) VALUES(?,?,?,?,?,?)',
      )
      .run(jobId, rootId, relativePath, kind, Date.now(), JSON.stringify({ entry }));
    return jobId;
  }
  /** Every queued job, or one folder's. Reads and parses them all, so not once per file. */
  jobs(rootId?: string): LocalJob[] {
    const rows = (
      rootId === undefined
        ? this.db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all()
        : this.db.prepare('SELECT * FROM jobs WHERE root_id=? ORDER BY created_at,id').all(rootId)
    ) as JobRow[];
    return rows.map(jobFromRow);
  }
  /** One folder's queued uploads or deletions. */
  jobsOfKind(rootId: string, kind: 'upsert' | 'delete'): LocalJob[] {
    return (
      this.db
        .prepare('SELECT * FROM jobs WHERE root_id=? AND kind=? ORDER BY created_at,id')
        .all(rootId, kind) as JobRow[]
    ).map(jobFromRow);
  }
  /**
   * The queued jobs of some folders a page at a time, in queue order, starting after `after` and
   * leaving out jobs queued after `before`. Reading a large queue whole costs hundreds of
   * megabytes; a page costs little, and later pages see changes made meanwhile.
   */
  jobsPage(
    rootIds: string[],
    after: { createdAt: number; id: string } | null,
    before: number,
    limit: number,
  ): { jobs: LocalJob[]; last: { createdAt: number; id: string } | null } {
    if (!rootIds.length) return { jobs: [], last: null };
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE root_id IN (${rootIds.map(() => '?').join(',')})
           AND created_at <= ? AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at,id LIMIT ?`,
      )
      .all(
        ...rootIds,
        before,
        after?.createdAt ?? -1,
        after?.createdAt ?? -1,
        after?.id ?? '',
        limit,
      ) as (JobRow & { created_at: number })[];
    const end = rows.at(-1);
    return {
      jobs: rows.map(jobFromRow),
      last: end ? { createdAt: end.created_at, id: end.id } : null,
    };
  }
  job(id: string): LocalJob | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    return row && jobFromRow(row);
  }
  /** The queued job for one path, if there is one. */
  pendingJob(
    rootId: string,
    relativePath: string,
    kind: 'upsert' | 'delete',
  ): LocalJob | undefined {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE root_id=? AND relative_path=? AND kind=?')
      .get(rootId, relativePath, kind) as JobRow | undefined;
    return row && jobFromRow(row);
  }
  /**
   * What the window shows of the queue: one job per folder with work waiting, so it can tell the
   * folder is busy, plus the failed ones. A folder can queue over a hundred thousand files, far
   * too many to send on every progress update.
   */
  jobSummary(): Omit<LocalJob, 'payload'>[] {
    const columns = 'id, root_id, relative_path, kind, attempts, error';
    const first = this.db.prepare(`SELECT ${columns} FROM jobs WHERE root_id=? LIMIT 1`);
    const rows = [
      // Read from the jobs_failed index.
      ...(this.db
        .prepare(
          `SELECT ${columns} FROM jobs WHERE error IS NOT NULL ORDER BY created_at,id LIMIT ?`,
        )
        .all(JOB_SUMMARY_FAILURES) as JobRow[]),
      ...(this.db.prepare('SELECT id FROM roots').all() as { id: string }[])
        .map(({ id }) => first.get(id) as JobRow | undefined)
        .filter((row): row is JobRow => !!row),
    ];
    const seen = new Set<string>();
    return rows
      .filter((r) => !seen.has(r.id) && !!seen.add(r.id))
      .map((r) => ({
        id: r.id,
        rootId: r.root_id,
        relativePath: r.relative_path,
        kind: r.kind,
        attempts: r.attempts,
        error: r.error,
      }));
  }
  /** Runs synchronous writes as one commit, which is far faster than one commit each. */
  transaction<T>(work: () => T): T {
    if (this.transactionDepth) return work();
    this.db.exec('BEGIN');
    this.transactionDepth++;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  saveJob(job: LocalJob) {
    this.db
      .prepare('UPDATE jobs SET payload=?,attempts=?,error=? WHERE id=?')
      .run(JSON.stringify(job.payload), job.attempts, job.error, job.id);
  }
  /**
   * Uploads that will never complete because their file was deleted, replaced or is no longer
   * synced. The server holds their size as reserved storage until each is cancelled.
   */
  abandonedUploads(): string[] {
    return this.get<string[]>('abandonedUploads') ?? [];
  }
  abandonUpload(uploadId: string | undefined) {
    if (uploadId)
      this.set('abandonedUploads', [...new Set([...this.abandonedUploads(), uploadId])]);
  }
  uploadReleased(uploadId: string) {
    this.set(
      'abandonedUploads',
      this.abandonedUploads().filter((id) => id !== uploadId),
    );
  }
  private abandonJobs(rootId: string) {
    const rows = this.db
      .prepare(
        "SELECT json_extract(payload, '$.upload.uploadId') AS uploadId FROM jobs WHERE root_id=? AND json_extract(payload, '$.upload.uploadId') IS NOT NULL",
      )
      .all(rootId) as { uploadId: string }[];
    for (const row of rows) this.abandonUpload(row.uploadId);
  }
  /** Ends a job that did not complete, releasing any upload it had started. */
  drop(id: string) {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id) as
      { payload: string } | undefined;
    if (row) this.abandonUpload(JSON.parse(row.payload).upload?.uploadId);
    this.finish(id);
  }
  finish(id: string) {
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    this.db
      .prepare('UPDATE changes SET synced_at=? WHERE job_id=? AND synced_at IS NULL')
      .run(Date.now(), id);
  }
  changeSummaries(): Map<string, ChangeSummary> {
    // Folder by folder, each answered from an index: totalling the whole ledger on every status
    // update cost tens of milliseconds once a folder queued a few hundred thousand files.
    const summaries = new Map<string, ChangeSummary>();
    const value = (sql: string, rootId: string) =>
      (this.db.prepare(sql).get(rootId) as { value: number | null }).value;
    for (const { id } of this.db.prepare('SELECT id FROM roots').all() as { id: string }[]) {
      const lastDetectedAt = value(
        'SELECT MAX(detected_at) AS value FROM changes WHERE root_id=?',
        id,
      );
      if (lastDetectedAt === null) continue;
      summaries.set(id, {
        pending:
          value(
            'SELECT COUNT(*) AS value FROM changes WHERE root_id=? AND synced_at IS NULL',
            id,
          ) ?? 0,
        lastDetectedAt,
        lastSyncedAt: value('SELECT MAX(synced_at) AS value FROM changes WHERE root_id=?', id),
      });
    }
    return summaries;
  }
  changes(rootId: string, limit = 100): ChangeRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, root_id AS rootId, relative_path AS relativePath, kind, source,
                  detected_at AS detectedAt, synced_at AS syncedAt
           FROM changes WHERE root_id=? ORDER BY detected_at DESC LIMIT ?`,
        )
        .all(rootId, limit) as ChangeRecord[]
    ).map((row) => ({ ...row }));
  }
  close() {
    this.db.close();
  }
}
