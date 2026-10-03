import Foundation
import SQLite3

/// Where a sync or backup folder lives on this phone: inside the app's Documents folder
/// (visible in the Files app under On My iPhone › harbor0), or a folder chosen in Files.
struct LocalPlace: Codable, Hashable, Sendable {
    var documents: String? = nil
    var bookmark: Data? = nil
}

struct SyncRoot: Codable, Identifiable, Equatable, Sendable {
    enum Mode: String, Codable, Sendable { case sync, backup }
    enum Archive: String, Codable, Sendable { case pending, removing, archived, restoring }
    var id: String
    var place: LocalPlace
    /// The local folder's name, for display.
    var name: String
    var remoteId: String?
    var mode: Mode
    var backupId: String? = nil
    // Backup folders only: set while the local copy is being removed, is gone, or is coming back.
    var archive: Archive? = nil
    var archiveError: String? = nil
    var paused = false
    var excluded: [String] = []
    var cloudPath: String? = nil
    var needsReconcile: Bool? = nil
    var shareId: String? = nil
    var sharedBy: String? = nil
    var sharedSequence: Int? = nil
    var lastSyncedAt: String? = nil
}

struct LocalFile: Codable, Equatable, Sendable {
    var rootId: String
    var relativePath: String
    var itemId: String
    var revision: Int
    var hash: String?
    var type: String
}

struct UploadState: Codable, Equatable, Sendable {
    var operationId: String
    var uploadId: String? = nil
    var partSize: Int64? = nil
    var hash: String? = nil
    var size: Int64? = nil
    var mtime: Double? = nil
    var parts: [CompletedPart]? = nil
}
extension CompletedPart: Equatable, @unchecked Sendable {
    static func == (a: CompletedPart, b: CompletedPart) -> Bool { a.partNumber == b.partNumber && a.etag == b.etag }
}

struct BackupEntryInput: Codable, Equatable, Sendable {
    var relativePath: String
    var itemId: String
    var versionId: String
    var sizeBytes: Int64
    var modifiedAt: String
    var savedAt: String
}

struct JobPayload: Codable, Equatable, Sendable {
    var retryAt: Double? = nil
    var retryAfter: Double? = nil
    var observedAt: Double? = nil
    var upload: UploadState? = nil
    var relayVersion: String? = nil
    var backupRunId: String? = nil
    var backupManual: Bool? = nil
    var backupEntry: BackupEntryInput? = nil
}

struct LocalJob: Equatable, Sendable {
    enum Kind: String, Sendable { case upsert, delete }
    let id: String
    let rootId: String
    let relativePath: String
    let kind: Kind
    var payload: JobPayload
    var attempts: Int
    var error: String?
}

/// What the last local scan saw, so the next scan can tell what changed (the phone's file watcher).
struct LocalSeen: Equatable, Sendable {
    let folder: Bool
    let size: Int64
    let mtime: Double
}

/// The per-account sync journal (apps/desktop/src/journal.ts), stored in SQLite.
final class SyncJournal: @unchecked Sendable {
    private var db: OpaquePointer?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let lock = NSRecursiveLock()

    init(url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw APIError(status: 0, message: "The sync database could not be opened.")
        }
        try exec("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files(root_id TEXT NOT NULL, relative_path TEXT NOT NULL, item_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(root_id, relative_path));
        CREATE INDEX IF NOT EXISTS files_item ON files(root_id, item_id);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, root_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_path ON jobs(root_id, relative_path, kind);
        CREATE TABLE IF NOT EXISTS seen(root_id TEXT NOT NULL, relative_path TEXT NOT NULL, folder INTEGER NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, PRIMARY KEY(root_id, relative_path));
        """)
        var excluded = URLResourceValues()
        excluded.isExcludedFromBackup = true
        var location = url
        try? location.setResourceValues(excluded)
    }
    deinit { sqlite3_close_v2(db) }

    // MARK: SQLite plumbing

    private enum Value { case text(String), int(Int64), real(Double), null }
    private func exec(_ sql: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
    }
    private func failure() -> APIError {
        APIError(status: 0, message: "Sync database error: " + String(cString: sqlite3_errmsg(db)))
    }
    @discardableResult
    private func run(_ sql: String, _ values: [Value] = [], row: ((OpaquePointer) -> Void)? = nil) -> Bool {
        lock.lock(); defer { lock.unlock() }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in values.enumerated() {
            let position = Int32(index + 1)
            switch value {
            case .text(let text): sqlite3_bind_text(statement, position, text, -1, transient)
            case .int(let int): sqlite3_bind_int64(statement, position, int)
            case .real(let real): sqlite3_bind_double(statement, position, real)
            case .null: sqlite3_bind_null(statement, position)
            }
        }
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_ROW { row?(statement!) } else { return step == SQLITE_DONE }
        }
    }
    private static func text(_ statement: OpaquePointer, _ column: Int32) -> String? {
        guard let pointer = sqlite3_column_text(statement, column) else { return nil }
        return String(cString: pointer)
    }
    private func json<T: Encodable>(_ value: T) -> String {
        (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    }
    private func decode<T: Decodable>(_ type: T.Type, _ text: String?) -> T? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return try? decoder.decode(T.self, from: data)
    }
    func transaction(_ work: () throws -> Void) rethrows {
        lock.lock(); defer { lock.unlock() }
        sqlite3_exec(db, "BEGIN", nil, nil, nil)
        do { try work(); sqlite3_exec(db, "COMMIT", nil, nil, nil) }
        catch { sqlite3_exec(db, "ROLLBACK", nil, nil, nil); throw error }
    }

    // MARK: Settings

    func get<T: Decodable>(_ key: String, as type: T.Type = T.self) -> T? {
        var result: T?
        run("SELECT value FROM settings WHERE key=?", [.text(key)]) { result = self.decode(T.self, Self.text($0, 0)) }
        return result
    }
    func set<T: Encodable>(_ key: String, _ value: T?) {
        guard let value else { run("DELETE FROM settings WHERE key=?", [.text(key)]); return }
        run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [.text(key), .text(json(value))])
    }

    // MARK: Roots

    func roots() -> [SyncRoot] {
        var result: [SyncRoot] = []
        run("SELECT data FROM roots ORDER BY rowid") { if let root = self.decode(SyncRoot.self, Self.text($0, 0)) { result.append(root) } }
        return result
    }
    func root(_ id: String) -> SyncRoot? { roots().first { $0.id == id } }
    func save(_ root: SyncRoot) {
        run("INSERT INTO roots(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [.text(root.id), .text(json(root))])
    }
    /// Removes only local bookkeeping. Neither copy of the files is deleted.
    func removeRoot(_ id: String) {
        transaction {
            run("DELETE FROM jobs WHERE root_id=?", [.text(id)])
            run("DELETE FROM files WHERE root_id=?", [.text(id)])
            run("DELETE FROM seen WHERE root_id=?", [.text(id)])
            run("DELETE FROM roots WHERE id=?", [.text(id)])
        }
    }
    func resetRootFiles(_ id: String) {
        run("DELETE FROM jobs WHERE root_id=?", [.text(id)])
        run("DELETE FROM files WHERE root_id=?", [.text(id)])
        run("DELETE FROM seen WHERE root_id=?", [.text(id)])
    }

    // MARK: Files

    private func files(_ sql: String, _ values: [Value]) -> [LocalFile] {
        var result: [LocalFile] = []
        run(sql, values) { if let file = self.decode(LocalFile.self, Self.text($0, 0)) { result.append(file) } }
        return result
    }
    func file(_ rootId: String, _ relativePath: String) -> LocalFile? {
        files("SELECT data FROM files WHERE root_id=? AND relative_path=?", [.text(rootId), .text(relativePath)]).first
    }
    func file(_ rootId: String, item itemId: String) -> LocalFile? {
        files("SELECT data FROM files WHERE root_id=? AND item_id=?", [.text(rootId), .text(itemId)]).first
    }
    func files(_ rootId: String) -> [LocalFile] {
        files("SELECT data FROM files WHERE root_id=?", [.text(rootId)])
    }
    func counts(_ rootId: String) -> (files: Int, folders: Int) {
        var result = (0, 0)
        run("SELECT SUM(json_extract(data,'$.type')='FILE'), SUM(json_extract(data,'$.type')='FOLDER') FROM files WHERE root_id=?", [.text(rootId)]) {
            result = (Int(sqlite3_column_int64($0, 0)), Int(sqlite3_column_int64($0, 1)))
        }
        return result
    }
    func put(_ file: LocalFile) {
        run("INSERT INTO files(root_id,relative_path,item_id,data) VALUES(?,?,?,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET item_id=excluded.item_id, data=excluded.data",
            [.text(file.rootId), .text(file.relativePath), .text(file.itemId), .text(json(file))])
    }
    func deleteFile(_ rootId: String, _ relativePath: String) {
        run("DELETE FROM files WHERE root_id=? AND relative_path=?", [.text(rootId), .text(relativePath)])
    }

    // MARK: Jobs

    func enqueue(_ rootId: String, _ relativePath: String, _ kind: LocalJob.Kind) {
        var existing: LocalJob?
        jobsMatching("WHERE root_id=? AND relative_path=? AND kind=?", [.text(rootId), .text(relativePath), .text(kind.rawValue)]) { existing = $0 }
        if var job = existing {
            // A fresh local change retries immediately instead of waiting out an earlier failure.
            if job.payload.retryAt != nil { job.payload.retryAt = nil; save(job) }
            return
        }
        run("INSERT INTO jobs(id,root_id,relative_path,kind,created_at,payload) VALUES(?,?,?,?,?,?)",
            [.text(UUID().uuidString.lowercased()), .text(rootId), .text(relativePath), .text(kind.rawValue),
             .real(Date().timeIntervalSince1970 * 1000), .text("{}")])
    }
    private func jobsMatching(_ clause: String, _ values: [Value], each: (LocalJob) -> Void) {
        var rows: [LocalJob] = []
        run("SELECT id,root_id,relative_path,kind,payload,attempts,error FROM jobs \(clause) ORDER BY created_at,id", values) { row in
            rows.append(LocalJob(id: Self.text(row, 0) ?? "", rootId: Self.text(row, 1) ?? "", relativePath: Self.text(row, 2) ?? "",
                                 kind: LocalJob.Kind(rawValue: Self.text(row, 3) ?? "") ?? .upsert,
                                 payload: self.decode(JobPayload.self, Self.text(row, 4)) ?? JobPayload(),
                                 attempts: Int(sqlite3_column_int64(row, 5)), error: Self.text(row, 6)))
        }
        rows.forEach(each)
    }
    func jobs() -> [LocalJob] {
        var result: [LocalJob] = []
        jobsMatching("", []) { result.append($0) }
        return result
    }
    func jobs(root rootId: String) -> [LocalJob] {
        var result: [LocalJob] = []
        jobsMatching("WHERE root_id=?", [.text(rootId)]) { result.append($0) }
        return result
    }
    func job(_ id: String) -> LocalJob? {
        var result: LocalJob?
        jobsMatching("WHERE id=?", [.text(id)]) { result = $0 }
        return result
    }
    func job(_ rootId: String, _ relativePath: String, _ kind: LocalJob.Kind) -> LocalJob? {
        var result: LocalJob?
        jobsMatching("WHERE root_id=? AND relative_path=? AND kind=?", [.text(rootId), .text(relativePath), .text(kind.rawValue)]) { result = $0 }
        return result
    }
    func hasJob(_ rootId: String, _ relativePath: String) -> Bool {
        var found = false
        run("SELECT 1 FROM jobs WHERE root_id=? AND relative_path=? LIMIT 1", [.text(rootId), .text(relativePath)]) { _ in found = true }
        return found
    }
    func jobCount() -> Int {
        var count = 0
        run("SELECT COUNT(*) FROM jobs") { count = Int(sqlite3_column_int64($0, 0)) }
        return count
    }
    func save(_ job: LocalJob) {
        run("UPDATE jobs SET payload=?, attempts=?, error=? WHERE id=?",
            [.text(json(job.payload)), .int(Int64(job.attempts)), job.error.map { .text($0) } ?? .null, .text(job.id)])
    }
    func finish(_ id: String) { run("DELETE FROM jobs WHERE id=?", [.text(id)]) }

    // MARK: Local scan snapshot

    func seen(_ rootId: String) -> [String: LocalSeen] {
        var result: [String: LocalSeen] = [:]
        run("SELECT relative_path, folder, size, mtime FROM seen WHERE root_id=?", [.text(rootId)]) { row in
            result[Self.text(row, 0) ?? ""] = LocalSeen(folder: sqlite3_column_int64(row, 1) != 0, size: sqlite3_column_int64(row, 2), mtime: sqlite3_column_double(row, 3))
        }
        return result
    }
    func replaceSeen(_ rootId: String, added: [String: LocalSeen], removed: [String]) {
        transaction {
            for path in removed { run("DELETE FROM seen WHERE root_id=? AND relative_path=?", [.text(rootId), .text(path)]) }
            for (path, entry) in added {
                run("INSERT INTO seen(root_id,relative_path,folder,size,mtime) VALUES(?,?,?,?,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET folder=excluded.folder,size=excluded.size,mtime=excluded.mtime",
                    [.text(rootId), .text(path), .int(entry.folder ? 1 : 0), .int(entry.size), .real(entry.mtime)])
            }
        }
    }
    /// Records a change the engine made itself, so the next scan does not report it back.
    func noteSeen(_ rootId: String, _ relativePath: String, _ info: LocalInfo?) {
        if let info, info.kind == .file || info.kind == .folder {
            replaceSeen(rootId, added: [relativePath: LocalSeen(folder: info.kind == .folder, size: info.kind == .folder ? 0 : info.size, mtime: info.kind == .folder ? 0 : info.mtime)], removed: [])
        } else {
            run("DELETE FROM seen WHERE root_id=? AND (relative_path=? OR relative_path LIKE ? ESCAPE '\\')",
                [.text(rootId), .text(relativePath), .text(Self.likePrefix(relativePath))])
        }
    }
    private static func likePrefix(_ path: String) -> String {
        path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_") + "/%"
    }
}
