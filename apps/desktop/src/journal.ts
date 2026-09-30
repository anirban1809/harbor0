import { DatabaseSync } from 'node:sqlite';
export type Root = {
  id: string;
  localPath: string;
  remoteId: string | null;
  mode: 'sync' | 'backup';
  backupId?: string;
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
};
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
 `);
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
  ) {
    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE root_id=? AND relative_path=? AND kind=?')
      .get(rootId, relativePath, kind);
    if (existing) {
      // A fresh local change retries immediately instead of waiting out an earlier failure.
      this.db
        .prepare("UPDATE jobs SET payload=json_remove(payload, '$.retryAt') WHERE id=?")
        .run(existing.id as string);
      if (entry)
        this.db
          .prepare("UPDATE jobs SET payload=json_set(payload, '$.entry', json(?)) WHERE id=?")
          .run(JSON.stringify(entry), existing.id as string);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO jobs(id,root_id,relative_path,kind,created_at,payload) VALUES(?,?,?,?,?,?)',
      )
      .run(crypto.randomUUID(), rootId, relativePath, kind, Date.now(), JSON.stringify({ entry }));
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
  }
  close() {
    this.db.close();
  }
}
