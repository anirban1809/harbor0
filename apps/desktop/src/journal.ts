import { DatabaseSync } from 'node:sqlite';
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
  sharedSequence?: number;
  lastSyncedAt?: string;
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
export class Journal {
  db: DatabaseSync;
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
  jobCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count;
  }
  jobCounts(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT root_id AS rootId, COUNT(*) AS count FROM jobs GROUP BY root_id')
      .all() as { rootId: string; count: number }[];
    return new Map(rows.map((row) => [row.rootId, row.count]));
  }
  files(rootId: string): LocalFile[] {
    return (
      this.db.prepare('SELECT data FROM files WHERE root_id=?').all(rootId) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  folders(rootId: string): LocalFile[] {
    return (
      this.db
        .prepare("SELECT data FROM files WHERE root_id=? AND json_extract(data, '$.type')='FOLDER'")
        .all(rootId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  fileCounts(rootId: string): { fileCount: number; folderCount: number } {
    return this.db
      .prepare(
        `
      SELECT COALESCE(SUM(json_extract(data, '$.type') = 'FILE'), 0) AS fileCount,
             COALESCE(SUM(json_extract(data, '$.type') = 'FOLDER'), 0) AS folderCount
      FROM files WHERE root_id = ?
    `,
      )
      .get(rootId) as { fileCount: number; folderCount: number };
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
  jobs(): LocalJob[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all() as any[]).map(
      (r) => ({
        id: r.id,
        rootId: r.root_id,
        relativePath: r.relative_path,
        kind: r.kind,
        payload: JSON.parse(r.payload),
        attempts: r.attempts,
        error: r.error,
      }),
    );
  }
  saveJob(job: LocalJob) {
    this.db
      .prepare('UPDATE jobs SET payload=?,attempts=?,error=? WHERE id=?')
      .run(JSON.stringify(job.payload), job.attempts, job.error, job.id);
  }
  finish(id: string) {
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
    this.db
      .prepare('UPDATE changes SET synced_at=? WHERE job_id=? AND synced_at IS NULL')
      .run(Date.now(), id);
  }
  changeSummaries(): Map<string, ChangeSummary> {
    const rows = this.db
      .prepare(
        `SELECT root_id AS rootId, SUM(synced_at IS NULL) AS pending,
                MAX(detected_at) AS lastDetectedAt, MAX(synced_at) AS lastSyncedAt
         FROM changes GROUP BY root_id`,
      )
      .all() as (ChangeSummary & { rootId: string })[];
    return new Map(
      rows.map(({ rootId, ...summary }) => [rootId, { ...summary, pending: summary.pending ?? 0 }]),
    );
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
