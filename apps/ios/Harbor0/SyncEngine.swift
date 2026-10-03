import Foundation

// MARK: - State shared with the UI (apps/desktop/src/sync-state.ts)

struct SyncIssue: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var rootId: String
    var code: String
    var message: String
    var relativePath: String? = nil
    var conflictPath: String? = nil
    // Set when the problem belongs to one queued file rather than the whole folder.
    var jobId: String? = nil
    var scope: String? = nil
    var at: String
    /// Kept until the user dismisses them; a later successful sync does not clear these.
    var sticky: Bool { code == "CONFLICT" || code == "FOLDER_RECOVERED" }
}

struct SyncProgress: Equatable, Sendable {
    enum Direction: String, Codable, Sendable { case upload, download }
    var rootId: String
    var direction: Direction
    var relativePath: String
    var loaded: Int64
    var total: Int64
}

struct SyncActivity: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var rootId: String
    var direction: SyncProgress.Direction
    var relativePath: String
    var at: String
}

struct SyncWaiting: Equatable, Sendable { var rootId: String; var relativePath: String }

struct SyncRuntime: Equatable, Sendable {
    var running = false
    var paused = false
    var online = true
    var message = "Ready"
    var queued = 0
    var lastSync: String?
    var active: SyncProgress?
    var issues: [SyncIssue] = []
    var recent: [SyncActivity] = []
    var waiting: [SyncWaiting] = []
    var confirmationPendingRoots: [String] = []
}

struct SyncJobSummary: Equatable, Sendable, Identifiable {
    let id: String
    let rootId: String
    let relativePath: String
    let kind: String
    let error: String?
    let attempts: Int
}

/// Everything the Sync and Backups screens show about this phone, published after every change.
struct SyncSnapshot: Equatable, Sendable {
    struct Folder: Equatable, Sendable, Identifiable {
        var root: SyncRoot
        var files: Int
        var folders: Int
        var url: URL?
        var id: String { root.id }
    }
    var state = SyncRuntime()
    var folders: [Folder] = []
    var jobs: [SyncJobSummary] = []
}

struct SyncFoldersResult: Decodable { var ok: Bool? = nil; var removedFolderIds: [String]? = nil }
struct SyncShareStatus: Decodable {
    struct Share: Decodable { let id: String; let ownerUserId: String; var driveItemId: String? = nil }
    let share: Share
    let item: DriveItem
    let sequence: Int
}

enum SyncClock {
    static var now: Double { Date().timeIntervalSince1970 * 1000 }
    static func iso(_ date: Date = Date()) -> String {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.string(from: date)
    }
}

// Failed files and folders retry with growing delays (4s up to 5 minutes).
private func retryDelay(_ attempts: Int) -> Double { min(300_000, 2000 * pow(2, Double(min(attempts, 10)))) }

/// Issue codes for the UI (sync-state.ts syncIssueCode).
func syncIssueCode(_ error: Error, item: Bool = false) -> String {
    if error is SyncFolderMissing { return item ? "SYNC_ERROR" : "FOLDER_MISSING" }
    if LocalFS.missing(error) { return item ? "SYNC_ERROR" : "FOLDER_MISSING" }
    if LocalFS.denied(error) { return "PERMISSION_DENIED" }
    if LocalFS.full(error) { return "DISK_FULL" }
    if let api = error as? APIError {
        if api.code == "STORAGE_QUOTA_EXCEEDED" { return "STORAGE_QUOTA_EXCEEDED" }
        if api.code == "AUTH_INVALID" || api.code == "DEVICE_REVOKED" { return "AUTH_INVALID" }
    }
    return "SYNC_ERROR"
}

extension Error {
    var apiCode: String? { (self as? APIError)?.code }
    var isNetwork: Bool { self is URLError }
}

/// The phone's sync and backup engine: a port of apps/desktop/src/sync.ts.
/// The desktop watches folders; a phone app cannot, so each pass scans its folders and
/// compares them with what the previous scan saw.
actor SyncEngine {
    // Remote checks start every 2s and back off to 30s while nothing changes.
    static let remotePollMin: Double = 2000
    static let remotePollMax: Double = 30_000
    static let scanInterval: Double = 5000

    let api: HarborAPI
    let journal: SyncJournal
    let deviceId: String
    private let changed: @Sendable (SyncSnapshot) -> Void
    private var receipts: SyncReceipts!
    private var backups: FolderBackups!
    private(set) var state = SyncRuntime()
    private var running = false
    private var stopped = true
    private var work: Task<Void, Never>?
    private var loop: Task<Void, Never>?
    private var pendingWake = false
    private var lastProgressEmit: Double = 0
    private var currentRootId = ""
    private var publishedFolders = ""
    private var publishingFolders = false
    private var publishRetryAt: Double = 0
    private var publishedAt: Double = 0
    private var removedRemoteIds = Set<String>()
    private var confirmation: Task<Void, Never>?
    private var nextConfirmationAt: Double = 0
    private var rootRetry: [String: (attempts: Int, at: Double)] = [:]
    private var waiting: [String: SyncWaiting] = [:]
    private var remoteDelay = remotePollMin
    private var nextRemoteAt: Double = 0
    private var checkpointed: Int?
    private var hurried = false
    private var scannedAt: [String: Double] = [:]
    private var accessed: [String: URL] = [:]
    private var available: [String: URL] = [:]
    private var mutation: Task<Void, Error>?
    private var started = false

    init(api: HarborAPI, journal: SyncJournal, deviceId: String, changed: @escaping @Sendable (SyncSnapshot) -> Void) {
        self.api = api
        self.journal = journal
        self.deviceId = deviceId
        self.changed = changed
        state.lastSync = journal.get("lastSync", as: String.self)
        // An ended session returns the app to sign-in by itself; never restore that as a sync problem.
        state.issues = (journal.get("syncIssues", as: [SyncIssue].self) ?? []).filter { $0.code != "AUTH_INVALID" }
        state.recent = journal.get("syncRecent", as: [SyncActivity].self) ?? []
        state.paused = journal.get("paused", as: Bool.self) ?? false
    }

    private func setUp() {
        if receipts == nil { receipts = SyncReceipts(api: api, journal: journal, engine: self) }
        if backups == nil { backups = FolderBackups(api: api, journal: journal, engine: self) }
    }

    // MARK: Lifecycle

    /// Starts the engine. `foreground` keeps a 2-second loop going until `stop()`.
    func start(foreground: Bool = true) {
        setUp()
        guard stopped else { if foreground { startLoop() }; return }
        stopped = false
        nextConfirmationAt = 0
        remoteDelay = Self.remotePollMin
        nextRemoteAt = 0
        for var root in journal.roots() {
            if root.mode == .sync, root.remoteId == nil {
                root.paused = true
                journal.save(root)
                state.issues.removeAll { $0.rootId == root.id && !$0.sticky }
                state.issues.append(SyncIssue(id: "\(root.id):mapping", rootId: root.id, code: "MAPPING_REQUIRED",
                                              message: "Choose a cloud folder for this local folder before syncing resumes.", at: SyncClock.iso()))
                persistIssues()
            }
            // The first start after launch repairs anything missed while the app was not running;
            // resuming from the background relies on the change feed.
            if root.mode == .sync && !started { root.needsReconcile = true; journal.save(root) }
        }
        started = true
        if foreground { startLoop() }
        emit()
    }

    private func startLoop() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.run()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// Stops the 2-second loop; a running pass finishes its current step first.
    func stop() async {
        stopped = true
        loop?.cancel()
        loop = nil
        confirmation?.cancel()
        await confirmation?.value
        await work?.value
        for url in accessed.values { url.stopAccessingSecurityScopedResource() }
        accessed = [:]
    }

    /// Background work: run passes until nothing is left to do or `deadline` passes.
    func drain(until deadline: Date) async {
        start(foreground: false)
        defer { if loop == nil { stopped = true } }
        var quiet = 0
        while Date() < deadline, quiet < 2, !state.paused {
            hurry()
            await run()
            await confirmation?.value
            let busy = journal.jobCount() > 0 || state.active != nil || !receipts.pendingRoots().isEmpty
                || journal.roots().contains { $0.needsReconcile == true && !$0.paused }
            quiet = busy ? 0 : quiet + 1
            if busy { try? await Task.sleep(nanoseconds: 1_000_000_000) }
        }
    }

    /// The next pass checks the server instead of waiting out the idle backoff.
    func hurry() {
        hurried = true
        remoteDelay = Self.remotePollMin
        nextRemoteAt = 0
        scannedAt = [:]
        receipts?.nudge()
    }
    /// Check the server and folders now, e.g. when the app returns to the foreground.
    func wake() {
        hurry()
        scheduleTick()
    }
    private func scheduleTick() {
        if stopped || state.paused { return }
        if running { pendingWake = true; return }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            await self?.run()
        }
    }

    func pause(_ paused: Bool) {
        state.paused = paused
        journal.set("paused", paused)
        if !paused {
            for var root in journal.roots() where root.mode == .sync { root.needsReconcile = true; journal.save(root) }
            // Resuming is also the user's way to retry failed work now.
            rootRetry = [:]
            hurry()
            for var job in journal.jobs() where job.payload.retryAt != nil {
                job.payload.retryAt = nil
                journal.save(job)
            }
            scheduleTick()
        }
        emit()
    }

    // MARK: Snapshot

    func snapshot() -> SyncSnapshot {
        state.queued = journal.jobCount()
        state.waiting = Array(waiting.values)
        return SyncSnapshot(state: state,
                            folders: journal.roots().map { root in
                                let counts = journal.counts(root.id)
                                return .init(root: root, files: counts.files, folders: counts.folders, url: try? location(root))
                            },
                            jobs: journal.jobs().map { SyncJobSummary(id: $0.id, rootId: $0.rootId, relativePath: $0.relativePath, kind: $0.kind.rawValue, error: $0.error, attempts: $0.attempts) })
    }
    func emit(progressOnly: Bool = false) {
        let now = SyncClock.now
        if progressOnly && now - lastProgressEmit < 150 { return }
        lastProgressEmit = now
        changed(snapshot())
    }

    // MARK: Folder locations

    static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    /// The local folder of a root, keeping access to folders chosen in Files while the engine runs.
    func location(_ root: SyncRoot) throws -> URL {
        if let documents = root.place.documents { return try SyncPaths.contained(Self.documents, documents) }
        if let url = accessed[root.id] { return url }
        guard let bookmark = root.place.bookmark else { throw SyncFolderMissing() }
        var stale = false
        let url: URL
        do { url = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) }
        catch { throw SyncFolderMissing() }
        guard url.startAccessingSecurityScopedResource() else { throw SyncFolderMissing() }
        accessed[root.id] = url
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil), var current = journal.root(root.id) {
            current.place.bookmark = fresh
            journal.save(current)
        }
        return url
    }
    private func release(_ rootId: String) {
        accessed.removeValue(forKey: rootId)?.stopAccessingSecurityScopedResource()
        available.removeValue(forKey: rootId)
        scannedAt.removeValue(forKey: rootId)
    }

    private func ignored(_ root: SyncRoot, _ relative: String) -> Bool {
        SyncPaths.internalPath(relative) || root.excluded.contains { relative == $0 || relative.hasPrefix($0 + "/") }
    }

    // MARK: Configuration

    func validate(_ root: SyncRoot, url: URL) throws {
        if root.mode == .sync && root.remoteId == nil { throw APIError(status: 0, message: "Choose a cloud folder before syncing.") }
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        for other in journal.roots() where other.id != root.id {
            guard let otherURL = try? location(other) else { continue }
            let otherPath = otherURL.standardizedFileURL.resolvingSymlinksInPath().path
            if path == otherPath || path.hasPrefix(otherPath + "/") || otherPath.hasPrefix(path + "/") {
                throw APIError(status: 0, message: "Sync and backup folders must not overlap.")
            }
            if root.mode == .sync, other.mode == .sync, root.remoteId == other.remoteId {
                throw APIError(status: 0, message: "This cloud folder is already synchronized on this iPhone.")
            }
        }
    }

    /// Finish the current transfer before changing folders; no files are deleted.
    private func reconfigure(_ change: @escaping () async throws -> Void) async throws {
        let previous = mutation
        let task = Task {
            _ = await previous?.result
            let foreground = loop != nil
            await stop()
            defer { start(foreground: foreground); wake() }
            try await change()
        }
        mutation = task
        try await task.value
    }

    func addRoot(_ root: SyncRoot) async throws {
        try validate(root, url: try location(root))
        try await reconfigure {
            var root = root
            root.needsReconcile = root.mode == .sync
            self.journal.save(root)
        }
    }
    func updateRoot(_ root: SyncRoot) async throws {
        try validate(root, url: try location(root))
        try await reconfigure {
            guard let previous = self.journal.root(root.id) else { throw APIError(status: 0, message: "Folder was not found.") }
            if previous.place != root.place || previous.remoteId != root.remoteId {
                self.journal.resetRootFiles(root.id)
                self.release(root.id)
            }
            var next = root
            next.needsReconcile = root.mode == .sync
            self.journal.save(next)
            self.rootRetry[root.id] = nil
            self.state.issues.removeAll { $0.rootId == root.id && !$0.sticky }
            self.persistIssues()
        }
    }
    func removeRoot(_ id: String) async throws {
        try await reconfigure {
            self.release(id)
            self.journal.removeRoot(id)
            self.state.issues.removeAll { $0.rootId == id }
            self.persistIssues()
            self.publishedFolders = ""
        }
    }
    func removeSyncedFolder(_ folderId: String) async throws {
        let _: EmptyResponse = try await api.request("/v1/sync/folders/\(folderId)", method: "DELETE")
        try await reconfigure {
            for root in self.journal.roots() where root.mode == .sync {
                if root.remoteId == folderId { self.release(root.id); self.journal.removeRoot(root.id) }
                else { self.excludeRemovedFolder(root, folderId) }
            }
            let ids = Set(self.journal.roots().map(\.id))
            self.state.issues.removeAll { !ids.contains($0.rootId) }
            self.persistIssues()
            self.publishedFolders = ""
        }
    }
    func disconnectBackup(_ id: String) async throws {
        guard let root = journal.root(id), root.mode == .backup else { throw APIError(status: 0, message: "Backup folder was not found on this iPhone.") }
        if let backupId = try await backupID(root) {
            let _: EmptyResponse = try await api.request("/v1/backups/\(backupId)", method: "DELETE")
        }
        try await removeRoot(id)
    }
    private func backupID(_ root: SyncRoot) async throws -> String? {
        if let id = root.backupId { return id }
        let catalog: BackupCatalog = try await api.request("/v1/backups")
        return catalog.items.first { $0.remoteRootDriveItemId == root.remoteId }?.id
    }
    /// Archive: one last full backup, then the local copy is removed and only the cloud copy stays.
    func archiveBackup(_ id: String, archived: Bool) throws {
        guard var root = journal.root(id), root.mode == .backup else { throw APIError(status: 0, message: "Backup folder was not found on this iPhone.") }
        if state.paused || root.paused { throw APIError(status: 0, message: "Resume backups before \(archived ? "archiving" : "restoring") this folder.") }
        if archived {
            if root.archive != nil { throw APIError(status: 0, message: "This folder is already archived.") }
            root.archive = .pending
            root.archiveError = nil
            journal.save(root)
            journal.set("backup-now:\(root.id)", true)
        } else {
            if root.archive != .archived { throw APIError(status: 0, message: "This folder is not archived.") }
            root.archive = .restoring
            journal.save(root)
        }
        emit()
        wake()
    }
    func backupNow(_ id: String) throws {
        guard let root = journal.root(id), root.mode == .backup else { throw APIError(status: 0, message: "Backup folder was not found on this iPhone.") }
        if state.paused { throw APIError(status: 0, message: "Resume backups before backing up now.") }
        if root.archive != nil { throw APIError(status: 0, message: "Restore this archived folder before backing up.") }
        try backups.request(root)
        emit()
        wake()
    }
    func dismissIssue(_ id: String) {
        state.issues.removeAll { $0.id == id && $0.sticky }
        persistIssues()
        emit()
    }
    /// Retry one failed file now.
    func retry(job id: String) {
        guard var job = journal.job(id) else { return }
        job.payload.retryAt = nil
        job.payload.retryAfter = nil
        journal.save(job)
        wake()
    }

    private func excludeRemovedFolder(_ root: SyncRoot, _ folderId: String) {
        guard let known = journal.file(root.id, item: folderId), known.type == "FOLDER" else { return }
        var next = root
        next.excluded = Array(Set(root.excluded + [known.relativePath])).sorted()
        journal.save(next)
        for job in journal.jobs(root: root.id) where job.relativePath == known.relativePath || job.relativePath.hasPrefix(known.relativePath + "/") {
            journal.finish(job.id)
        }
        for file in journal.files(root.id) where file.relativePath == known.relativePath || file.relativePath.hasPrefix(known.relativePath + "/") {
            journal.deleteFile(root.id, file.relativePath)
        }
    }
    func detach(_ root: SyncRoot) {
        release(root.id)
        journal.removeRoot(root.id)
        waiting = waiting.filter { $0.value.rootId != root.id }
        state.issues.removeAll { $0.rootId == root.id }
        persistIssues()
        emit()
    }

    // MARK: Issues and activity

    private func persistIssues() { journal.set("syncIssues", state.issues) }

    // Errors that are not about one file or folder: stop the pass and retry everything later.
    private func interrupts(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let api = error as? APIError {
            return api.status >= 500 || api.status == 429 || api.status == 401
                || ["AUTH_INVALID", "DEVICE_REVOKED", "SYNC_REMOVED", "SYNC_CURSOR_EXPIRED"].contains(api.code ?? "")
        }
        return error.isNetwork
    }
    private func rootFailed(_ root: SyncRoot, _ error: Error) {
        let attempts = (rootRetry[root.id]?.attempts ?? 0) + 1
        rootRetry[root.id] = (attempts, SyncClock.now + retryDelay(attempts))
        // A full reconcile repairs whatever this pass could not apply.
        if var current = journal.root(root.id), current.needsReconcile != true { current.needsReconcile = true; journal.save(current) }
        issue(root.id, error)
    }
    func issue(_ rootId: String, _ error: Error, relativePath: String? = nil, jobId: String? = nil) {
        // Filesystem errors below the folder itself concern one item, not the folder's own access.
        var nested: String?
        if let root = journal.root(rootId), let base = available[root.id] ?? (try? location(root)) {
            let info = (error as NSError).userInfo
            let failed = (info[NSFilePathErrorKey] as? String) ?? (info[NSURLErrorKey] as? URL)?.path
            if let failed, failed.hasPrefix(base.path + "/") { nested = String(failed.dropFirst(base.path.count + 1)) }
        }
        let item = jobId != nil || nested != nil
        let code = syncIssueCode(error, item: item)
        state.issues.removeAll { issue in
            !(issue.rootId != rootId || issue.sticky || (jobId != nil ? issue.jobId != jobId : issue.jobId != nil))
        }
        state.issues.append(SyncIssue(id: jobId.map { "job:\($0)" } ?? "\(rootId):\(code)", rootId: rootId, code: code,
                                      message: error.localizedDescription, relativePath: relativePath ?? nested,
                                      jobId: jobId, scope: item ? "item" : nil, at: SyncClock.iso()))
        persistIssues()
        emit()
    }
    private func deviceName() async -> String {
        journal.get("deviceName", as: String.self) ?? "iPhone"
    }
    private func recovered(_ root: SyncRoot, _ relativePath: String, _ kept: String) {
        state.issues.append(SyncIssue(id: UUID().uuidString, rootId: root.id, code: "FOLDER_RECOVERED",
                                      message: "This folder was removed from sync elsewhere. The copy on this iPhone was kept under a new name and no longer syncs.",
                                      relativePath: relativePath, conflictPath: kept, at: SyncClock.iso()))
        persistIssues()
        emit()
    }
    private func conflict(_ root: SyncRoot, _ relativePath: String, _ conflictPath: String) {
        state.issues.append(SyncIssue(id: UUID().uuidString, rootId: root.id, code: "CONFLICT",
                                      message: "This file changed in more than one place. Your local version has been preserved separately.",
                                      relativePath: relativePath, conflictPath: conflictPath, at: SyncClock.iso()))
        persistIssues()
        emit()
    }
    private func activity(_ root: SyncRoot, _ relativePath: String, _ direction: SyncProgress.Direction) {
        let at = SyncClock.iso()
        state.recent = Array(([SyncActivity(id: UUID().uuidString, rootId: root.id, direction: direction, relativePath: relativePath, at: at)] + state.recent).prefix(30))
        journal.set("syncRecent", state.recent)
        if var current = journal.root(root.id) { current.lastSyncedAt = at; journal.save(current) }
        if direction == .download { state.active = nil; emit() }
    }
    func setActive(_ progress: SyncProgress?, message: String? = nil) {
        state.active = progress
        if let message { state.message = message }
        emit(progressOnly: progress.map { $0.loaded < $0.total } ?? false)
    }

    /// The root folder must be a real, writable directory.
    private func check(_ root: SyncRoot) -> URL? {
        do {
            let url = try location(root)
            guard let info = try LocalInfo.of(url), info.kind == .folder else { throw SyncFolderMissing() }
            guard FileManager.default.isWritableFile(atPath: url.path) else {
                throw CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: url.path])
            }
            return url
        } catch {
            if root.mode == .sync, var current = journal.root(root.id) { current.needsReconcile = true; journal.save(current) }
            issue(root.id, error)
            return nil
        }
    }

    // MARK: Local scan (the phone's file watcher)

    /// Compares the folder with the previous scan and queues what changed. Returns whether anything did.
    private func scan(_ root: SyncRoot, _ base: URL) throws -> Bool {
        let previous = journal.seen(root.id)
        var current: [String: LocalSeen] = [:]
        // iCloud Drive can replace a downloaded file with a hidden “.name.icloud” placeholder.
        // The file still exists; it must not be treated as deleted.
        var evicted = Set<String>()
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey]
        func walk(_ directory: URL, _ relative: String) throws {
            let entries: [URL]
            do { entries = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys, options: []) }
            catch where !relative.isEmpty && LocalFS.missing(error) { return }
            for entry in entries {
                let name = entry.lastPathComponent
                if name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > 8 {
                    let original = String(name.dropFirst().dropLast(7))
                    evicted.insert(relative.isEmpty ? original : relative + "/" + original)
                    continue
                }
                let path = relative.isEmpty ? name : relative + "/" + name
                if ignored(root, path) { continue }
                guard let values = try? entry.resourceValues(forKeys: Set(keys)), values.isSymbolicLink != true else { continue }
                if values.isDirectory == true {
                    current[path] = LocalSeen(folder: true, size: 0, mtime: 0)
                    try walk(entry, path)
                } else if values.isRegularFile == true {
                    current[path] = LocalSeen(folder: false, size: Int64(values.fileSize ?? 0),
                                              mtime: (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)
                }
            }
        }
        try walk(base, "")
        var added: [String: LocalSeen] = [:]
        var removed: [String] = []
        for (path, entry) in current where previous[path] != entry {
            let before = previous[path]
            journal.enqueue(root.id, path, .upsert)
            if root.mode == .backup, before != nil, !entry.folder, var job = journal.job(root.id, path, .upsert) {
                job.payload.observedAt = SyncClock.now
                journal.save(job)
            }
            added[path] = entry
        }
        for path in previous.keys where current[path] == nil && !evicted.contains(path) {
            journal.enqueue(root.id, path, .delete)
            removed.append(path)
        }
        if !added.isEmpty || !removed.isEmpty { journal.replaceSeen(root.id, added: added, removed: removed) }
        scannedAt[root.id] = SyncClock.now
        return !added.isEmpty || !removed.isEmpty
    }
    private func note(_ root: SyncRoot, _ relative: String) {
        guard let base = available[root.id] ?? (try? location(root)), let url = try? SyncPaths.contained(base, relative) else { return }
        journal.noteSeen(root.id, relative, try? LocalInfo.of(url))
    }

    // MARK: Server state

    private func item(_ id: String) async throws -> DriveItem {
        let response: ItemResponse = try await api.request("/v1/drive/items/\(id)")
        return response.item
    }
    private func list(_ parent: String?, cursor: String?) async throws -> DrivePage {
        try await api.list(parentID: parent, cursor: cursor)
    }

    func reconcile(_ root: SyncRoot, _ base: URL) async throws {
        if root.mode == .backup || root.paused || state.paused || stopped { return }
        var seen = Set<String>()
        waiting = waiting.filter { $0.value.rootId != root.id }
        func walk(_ parent: String, _ prefix: String) async throws {
            var cursor: String?
            repeat {
                let page = try await list(parent, cursor: cursor)
                for item in page.items {
                    if stopped || state.paused { return }
                    seen.insert(item.id)
                    guard let segment = try? SyncPaths.safeSegment(item.name, id: item.id) else { continue }
                    let relative = prefix.isEmpty ? segment : prefix + "/" + segment
                    if ignored(root, relative) { continue }
                    let known = journal.file(root.id, item: item.id)
                    let pending = journal.hasJob(root.id, relative)
                    // Do not overwrite this device's queued edits/deletes when this item is unchanged.
                    if !(pending && known?.revision == item.revision && known?.relativePath == relative && item.cloudState != "REQUESTED") {
                        try await remoteItem(root, item, fresh: true, relative: relative)
                    }
                    if item.isFolder { try await walk(item.id, relative) }
                }
                cursor = page.nextCursor
            } while cursor != nil
        }
        guard let remoteId = root.remoteId else { return }
        let rootItem = try await item(remoteId)
        receipts.queue(root, ".", rootItem, hash: nil)
        try await walk(remoteId, "")
        // Paused or unavailable folders can miss feed events while other folders advance
        // the device cursor. Check tracked items absent from the current subtree.
        for known in journal.files(root.id) {
            if stopped || state.paused { return }
            if seen.contains(known.itemId) || ignored(root, known.relativePath) { continue }
            do {
                try await remoteItem(root, try await item(known.itemId))
            } catch let error as APIError where error.code == "SYNC_REMOVED" {
                continue
            } catch let error as APIError where ["ITEM_NOT_FOUND", "PARENT_NOT_FOUND"].contains(error.code ?? "") || (root.shareId != nil && error.code == "FORBIDDEN") {
                if let share = root.shareId { let _: SyncShareStatus = try await api.request("/v1/sync/shares/\(share)/status") }
                var gone = DriveItem(id: known.itemId, parentId: nil, type: known.type, name: "", mimeType: nil, sizeBytes: 0,
                                     updatedAt: SyncClock.iso(), backupRootId: nil, cloudState: nil)
                gone.revision = known.revision + 1
                gone.deletedAt = SyncClock.iso()
                try await remoteItem(root, gone)
            }
        }
    }

    private func publishSyncFolders() async {
        let folderIds = journal.roots().filter { $0.mode == .sync }.compactMap(\.remoteId).sorted()
        let signature = folderIds.joined(separator: ",")
        if publishingFolders || (signature == publishedFolders && SyncClock.now - publishedAt < 60_000) || SyncClock.now < publishRetryAt { return }
        publishingFolders = true
        defer { publishingFolders = false }
        do {
            let response: SyncFoldersResult = try await api.request("/v1/sync/folders", method: "PUT", body: ["folderIds": folderIds])
            for id in response.removedFolderIds ?? [] { removedRemoteIds.insert(id) }
            publishedFolders = signature
            publishedAt = SyncClock.now
            publishRetryAt = 0
        } catch {
            // Retry while offline without interrupting file transfers or local configuration changes.
            publishRetryAt = SyncClock.now + 15_000
        }
    }

    private func confirmStatus() {
        if stopped || state.paused || confirmation != nil || SyncClock.now < nextConfirmationAt { return }
        confirmation = Task { [weak self] in
            guard let self else { return }
            await self.receipts.flush()
            if !Task.isCancelled { await self.receipts.audit() }
            if !Task.isCancelled { await self.receipts.flush() }
            await self.confirmed(cancelled: Task.isCancelled)
        }
    }
    private func confirmed(cancelled: Bool) {
        confirmation = nil
        nextConfirmationAt = SyncClock.now + 5000
        guard !cancelled else { return }
        state.confirmationPendingRoots = receipts.pendingRoots()
        if state.active == nil && journal.jobCount() == 0 && state.issues.isEmpty {
            if !state.confirmationPendingRoots.isEmpty { state.message = "Files transferred; waiting for confirmation" }
            else if state.message == "Files transferred; waiting for confirmation" { state.message = "Everything is up to date" }
        }
        emit()
    }

    // MARK: Pass

    /// Run a pass now, including the server check.
    func tick() async {
        hurry()
        await run()
    }
    func run() async {
        if !stopped && !publishingFolders { await publishSyncFolders() }
        confirmStatus()
        if running || stopped || (state.paused && removedRemoteIds.isEmpty) { return }
        running = true
        let task = Task { await self.runTick() }
        work = task
        await task.value
    }

    private func runTick() async {
        state.running = true
        // Local work runs every pass; server checks only when due.
        let remote = SyncClock.now >= nextRemoteAt
        var active = false
        hurried = false
        defer {
            // Activity keeps checks every 2s; each quiet or failed check doubles the wait.
            if active {
                remoteDelay = Self.remotePollMin
                nextRemoteAt = remote ? SyncClock.now + Self.remotePollMin : 0
                receipts.nudge()
            } else if remote {
                remoteDelay = min(Self.remotePollMax, remoteDelay * 2)
                nextRemoteAt = SyncClock.now + remoteDelay
            }
            if hurried { hurry() }
            confirmStatus()
            running = false
            if pendingWake { pendingWake = false; scheduleTick() }
            state.running = false
            state.active = nil
            emit()
        }
        do {
            for root in journal.roots() where root.mode == .sync && root.remoteId.map(removedRemoteIds.contains) == true { detach(root) }
            removedRemoteIds = []
            available = [:]
            // Shared folders check their revisions in parallel instead of one round trip each.
            var shared: [String: Task<SyncShareStatus, Error>] = [:]
            if remote {
                for root in journal.roots() {
                    guard let share = root.shareId else { continue }
                    shared[root.id] = Task { [api] in try await api.request("/v1/sync/shares/\(share)/status") }
                }
            }
            for var root in journal.roots() {
                if stopped || state.paused { return }
                if root.shareId != nil, let request = shared[root.id] {
                    do {
                        let status = try await request.value
                        if root.sharedSequence != status.sequence {
                            root.needsReconcile = true
                            root.sharedSequence = status.sequence
                            journal.save(root)
                        }
                    } catch let error as APIError where ["SYNC_ACCESS_REMOVED", "FORBIDDEN", "SYNC_REMOVED", "ITEM_NOT_FOUND", "PARENT_NOT_FOUND"].contains(error.code ?? "") {
                        detach(root)
                        continue
                    }
                }
                if root.archive == .archived { continue }
                if root.archive == .restoring, !root.paused, let url = try? location(root) {
                    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                }
                if root.paused { continue }
                guard let base = check(root) else { continue }
                if root.mode == .sync, state.issues.contains(where: { $0.rootId == root.id && $0.code == "FOLDER_MISSING" && $0.scope == nil }) {
                    // A disappearing folder looks like every child was deleted.
                    // Rebuild the mapping on recovery instead of replaying those deletions.
                    journal.resetRootFiles(root.id)
                }
                available[root.id] = base
                currentRootId = root.id
                if SyncClock.now - (scannedAt[root.id] ?? 0) >= Self.scanInterval, root.archive == nil || root.archive == .pending {
                    do {
                        if try scan(root, base) { active = true; nextRemoteAt = min(nextRemoteAt, SyncClock.now) }
                    } catch {
                        issue(root.id, error)
                        continue
                    }
                }
                // Keep a problem visible while its file or folder is still waiting to retry.
                let retrying = (rootRetry[root.id]?.at ?? 0) > SyncClock.now
                let queued = Set(journal.jobs(root: root.id).map(\.id))
                state.issues.removeAll { issue in
                    !(issue.rootId != root.id || issue.sticky || (issue.jobId.map(queued.contains) ?? retrying))
                }
                if root.needsReconcile == true, root.mode == .sync, !retrying {
                    do { try await reconcile(root, base) }
                    catch {
                        if interrupts(error) { throw error }
                        // One blocked folder must not stop the others or this folder's own uploads.
                        rootFailed(root, error)
                        continue
                    }
                    if stopped || state.paused { return }
                    active = true
                    rootRetry[root.id] = nil
                    if var current = journal.root(root.id) { current.needsReconcile = false; journal.save(current) }
                }
            }
            for root in journal.roots() where root.mode == .backup && !root.paused && available[root.id] != nil && (remote || root.archive != nil) {
                if stopped || state.paused { return }
                if root.archive != nil { active = true }
                currentRootId = root.id
                let isStopped: @Sendable () async -> Bool = { [weak self] in await self?.halted() ?? true }
                do {
                    if root.archive == .restoring {
                        state.message = "Restoring archived folder"
                        try await backups.unarchive(root, base: available[root.id]!, stopped: isStopped)
                        continue
                    }
                    if root.archive != .removing {
                        // A backup run resumes from the journal, so it pauses between files when a
                        // local edit arrives instead of holding up sync for the whole run.
                        var yielded = false
                        try await backups.process(root, base: available[root.id]!, stopped: { [weak self] in
                            guard let self else { return true }
                            if await self.halted() { return true }
                            if await self.hurried { yielded = true; return true }
                            return false
                        })
                        if yielded { continue }
                    }
                    if let current = journal.root(root.id), current.archive != nil, !halted() {
                        try await backups.archive(current, base: available[root.id]!, stopped: isStopped)
                        if journal.root(root.id)?.archive == .archived { release(root.id) }
                    }
                } catch let error as APIError where error.code == "BACKUP_DISCONNECTED" {
                    detach(root)
                }
            }
            var full = Set<String>()
            for var job in journal.jobs() {
                if stopped || state.paused { return }
                guard let root = journal.root(job.rootId), root.mode == .sync, available[root.id] != nil, !root.paused,
                      !ignored(root, job.relativePath), (job.payload.retryAt ?? 0) <= SyncClock.now,
                      !(job.kind == .upsert && full.contains(root.id)) else {
                    if let root = journal.root(job.rootId), root.mode == .sync, ignored(root, job.relativePath) { journal.finish(job.id) }
                    continue
                }
                active = true
                currentRootId = root.id
                do {
                    try await localJob(root, job)
                    journal.finish(job.id)
                    if state.issues.contains(where: { $0.jobId == job.id }) {
                        state.issues.removeAll { $0.jobId == job.id }
                        persistIssues()
                    }
                    state.active = nil
                    emit()
                } catch {
                    job = journal.job(job.id) ?? job
                    job.attempts += 1
                    job.error = error.localizedDescription
                    if interrupts(error) { journal.save(job); throw error }
                    // One failing file waits for its own retry; the rest of the queue keeps moving.
                    job.payload.retryAt = SyncClock.now + retryDelay(job.attempts)
                    journal.save(job)
                    // Every further upload would fail the same way until storage is freed.
                    if error.apiCode == "STORAGE_QUOTA_EXCEEDED" { full.insert(root.id) }
                    issue(root.id, error, relativePath: job.relativePath, jobId: job.id)
                    state.active = nil
                }
            }
            if stopped || state.paused || !remote { return }
            currentRootId = ""
            var cursor = journal.get("cursor", as: Int.self) ?? 0
            var more = true
            while more && !stopped {
                let page: SyncChangesPage = try await api.request("/v1/sync/changes?cursor=\(cursor)&limit=100")
                if !page.changes.isEmpty { active = true }
                for change in page.changes {
                    if change.type == "BACKUP_DISCONNECTED" {
                        for root in journal.roots() where root.mode == .backup && root.remoteId == change.entityId { detach(root) }
                    }
                    if change.type == "SYNC_FOLDER_REMOVED" {
                        for root in journal.roots() where root.mode == .sync {
                            if root.remoteId == change.entityId { detach(root) } else { excludeRemovedFolder(root, change.entityId) }
                        }
                    }
                    // Folders waiting to retry are repaired by their next reconcile instead.
                    let targets = journal.roots().filter { $0.mode == .sync && $0.shareId == nil && !$0.paused && available[$0.id] != nil && rootRetry[$0.id] == nil }
                    for root in targets {
                        currentRootId = root.id
                        do {
                            if change.type == "TRANSFER_SAVED" { try await reconcile(root, available[root.id]!) }
                            if let item = change.item { try await remoteItem(root, item) }
                        } catch {
                            if interrupts(error) { throw error }
                            rootFailed(root, error)
                        }
                    }
                }
                cursor = page.nextCursor
                journal.set("cursor", cursor)
                more = page.hasMore
            }
            if stopped || state.paused { return }
            currentRootId = ""
            state.issues.removeAll { $0.rootId == "" && !$0.sticky }
            persistIssues()
            // Each checkpoint is a database write; only send one when the cursor moved.
            if cursor != checkpointed {
                let _: EmptyResponse = try await api.request("/v1/sync/checkpoints", method: "POST", body: ["deviceId": deviceId, "cursor": cursor])
                checkpointed = cursor
            }
            state.online = true
            state.lastSync = SyncClock.iso()
            journal.set("lastSync", state.lastSync)
            state.confirmationPendingRoots = receipts.pendingRoots()
            state.message = state.confirmationPendingRoots.isEmpty ? "Everything is up to date" : "Files transferred; waiting for confirmation"
        } catch {
            await failed(error)
        }
    }

    private func failed(_ error: Error) async {
        if let api = error as? APIError, api.code == "SYNC_REMOVED" {
            if let root = journal.root(currentRootId), let remoteId = root.remoteId {
                do { _ = try await item(remoteId) }
                catch let rootError as APIError where rootError.code == "SYNC_REMOVED" { detach(root) }
                catch {}
                if let folderId = api.folderID, let current = journal.root(root.id) { excludeRemovedFolder(current, folderId) }
            }
            return
        }
        if error.apiCode == "SYNC_CURSOR_EXPIRED" {
            for var root in journal.roots() where root.mode == .sync { root.needsReconcile = true; journal.save(root) }
            journal.set("cursor", 0)
        }
        if error is CancellationError { return }
        state.online = !error.isNetwork
        state.message = error.localizedDescription
        // An ended session returns the app to sign-in by itself; there is nothing to fix here.
        let sessionEnded = (error as? APIError).map { $0.status == 401 || ["AUTH_INVALID", "DEVICE_REVOKED"].contains($0.code ?? "") } ?? false
        if !error.isNetwork, !sessionEnded, error.apiCode != "SYNC_CURSOR_EXPIRED",
           !state.issues.contains(where: { $0.rootId == currentRootId && !$0.sticky }) {
            issue(currentRootId, error)
        }
        if ["DEVICE_REVOKED", "AUTH_INVALID"].contains(error.apiCode ?? "") { state.paused = true }
    }

    func halted() -> Bool { stopped || state.paused }

    // MARK: Remote folders

    private func child(_ parentId: String?, _ name: String) async throws -> DriveItem? {
        var cursor: String?
        let wanted = SyncPaths.normalized(name)
        repeat {
            let page = try await list(parentId, cursor: cursor)
            if let item = page.items.first(where: { SyncPaths.normalized($0.name) == wanted }) { return item }
            cursor = page.nextCursor
        } while cursor != nil
        return nil
    }
    func ensureFolder(_ name: String, parentId: String?, operationId: String = UUID().uuidString.lowercased(),
                      backup: (rootId: String, runId: String)? = nil) async throws -> DriveItem {
        do {
            let body: [String: Any] = ["name": name, "parentId": parentId as Any? ?? NSNull(), "operationId": operationId]
            let response: ItemResponse = try await api.request(backup.map { "/v1/backups/\($0.rootId)/runs/\($0.runId)/folders" } ?? "/v1/drive/folders",
                                                               method: "POST", body: body)
            return response.item
        } catch let error as APIError where error.code == "NAME_CONFLICT" {
            if let existing = try await child(parentId, name), existing.isFolder { return existing }
            throw error
        }
    }
    private func remoteParent(_ root: SyncRoot, _ relative: String, backup: (rootId: String, runId: String)?) async throws -> String? {
        let directory = SyncPaths.dirname(relative)
        if directory == "." { return root.remoteId }
        if let cached = journal.file(root.id, directory) { return cached.itemId }
        let parentId = try await remoteParent(root, directory, backup: backup)
        let item = try await ensureFolder(SyncPaths.basename(directory), parentId: parentId, backup: backup)
        journal.put(LocalFile(rootId: root.id, relativePath: directory, itemId: item.id, revision: item.revision ?? 1, hash: nil, type: "FOLDER"))
        return item.id
    }

    // MARK: Local changes

    func localJob(_ root: SyncRoot, _ job: LocalJob) async throws {
        guard let base = available[root.id] ?? (try? location(root)) else { throw SyncFolderMissing() }
        var job = job
        let absolute = try SyncPaths.contained(base, job.relativePath)
        var known = journal.file(root.id, job.relativePath)
        if job.kind == .delete {
            if try LocalInfo.of(absolute) != nil { return }
            if root.mode == .backup { return }
            if let known {
                do {
                    let _: EmptyResponse = try await api.request("/v1/drive/items/\(known.itemId)", method: "DELETE",
                                                                  body: ["operationId": job.id, "baseRevision": known.revision])
                } catch let error as APIError where error.code == "REVISION_CONFLICT" {
                    try await remoteItem(root, try await self.item(known.itemId))
                    return
                } catch let error as APIError where ["ITEM_NOT_FOUND", "PARENT_NOT_FOUND"].contains(error.code ?? "") {}
                journal.deleteFile(root.id, job.relativePath)
            }
            return
        }
        guard let info = try LocalInfo.of(absolute), info.kind == .file || info.kind == .folder else { return }
        setActive(SyncProgress(rootId: root.id, direction: .upload, relativePath: job.relativePath, loaded: 0, total: info.kind == .file ? info.size : 0))
        let backup: (rootId: String, runId: String)? = root.mode == .backup ? (root.backupId ?? "", job.payload.backupRunId ?? "") : nil
        let parentId = try await remoteParent(root, job.relativePath, backup: backup)
        let name = absolute.lastPathComponent
        if info.kind == .folder {
            if known == nil {
                let item = try await ensureFolder(name, parentId: parentId, operationId: job.id.lowercased(), backup: backup)
                journal.put(LocalFile(rootId: root.id, relativePath: job.relativePath, itemId: item.id, revision: item.revision ?? 1, hash: nil, type: "FOLDER"))
                receipts.queue(root, job.relativePath, item, hash: nil)
                activity(root, job.relativePath, .upload)
            }
            return
        }
        if root.mode == .backup {
            try LocalFS.safeParents(base, job.relativePath, create: false)
            let remote: DriveItem? = if let known { try await self.item(known.itemId) } else { try await child(parentId, name) }
            if let remote, !remote.isFolder {
                if remote.name.precomposedStringWithCanonicalMapping != name.precomposedStringWithCanonicalMapping {
                    throw APIError(status: 0, message: "Another backed-up file has the same name with different capitalization. Rename the local file to back up both.")
                }
                var savedHash = known?.revision == remote.revision ? known?.hash : nil
                if savedHash == nil {
                    let versions: Page<FileVersion> = try await api.request("/v1/drive/items/\(remote.id)/versions")
                    savedHash = versions.items.first { $0.id == remote.currentVersionId }?.contentHash
                }
                known = LocalFile(rootId: root.id, relativePath: job.relativePath, itemId: remote.id, revision: remote.revision ?? 1, hash: savedHash, type: "FILE")
                journal.put(known!)
            }
        }
        let hash = try SyncTransfers.hash(absolute)
        if let relay = job.payload.relayVersion, let known {
            if known.hash != hash {
                // An edit arriving while a relay request is queued is still a normal local edit.
                job.payload.relayVersion = nil
                job.payload.upload = UploadState(operationId: UUID().uuidString.lowercased())
                journal.save(job)
            } else {
                let current = try await item(known.itemId)
                if current.cloudState != "REQUESTED" || current.currentVersionId != relay { return }
            }
        } else if known?.hash == hash {
            note(root, job.relativePath)
            return
        }
        var upload = job.payload.upload ?? UploadState(operationId: job.id.lowercased())
        // Reuse this checksum only when the file remained stable during hashing.
        if upload.uploadId == nil, let hashed = try LocalInfo.of(absolute), hashed.size == info.size, hashed.mtime == info.mtime {
            upload.hash = hash
            upload.size = info.size
            upload.mtime = info.mtime
        }
        let quiet: () async throws -> Void = { [journal] in
            guard root.mode == .backup, job.payload.backupManual != true else { return }
            let current = try LocalInfo.of(absolute)
            let observed = journal.job(job.id)?.payload.observedAt ?? job.payload.observedAt ?? 0
            if !FolderBackups.ready(mtime: current?.mtime ?? 0, observedAt: observed) {
                throw APIError(status: 0, message: "This file changed recently. Automatic backup will wait one hour.")
            }
        }
        try await quiet()
        setActive(SyncProgress(rootId: root.id, direction: .upload, relativePath: job.relativePath, loaded: 0, total: info.size))
        let item: DriveItem
        do {
            let persistJob = job
            item = try await SyncTransfers.upload(
                api: api, file: absolute, name: name, parentId: parentId, state: &upload,
                persist: { [journal] state in
                    var saved = journal.job(persistJob.id) ?? persistJob
                    saved.payload.upload = state
                    saved.payload.relayVersion = persistJob.payload.relayVersion
                    journal.save(saved)
                },
                existing: known.map { ($0.itemId, $0.revision) }, backup: backup,
                progress: { [weak self] loaded, total in
                    Task { await self?.setActive(SyncProgress(rootId: root.id, direction: .upload, relativePath: job.relativePath, loaded: loaded, total: total),
                                                 message: "Uploading \(Int(Double(loaded) / Double(max(1, total)) * 100))%") }
                },
                beforeComplete: quiet)
        } catch let error as APIError where root.mode == .sync && ["REVISION_CONFLICT", "NAME_CONFLICT"].contains(error.code ?? "") {
            if let uploadId = upload.uploadId { let _: EmptyResponse? = try? await api.request("/v1/uploads/\(uploadId)", method: "DELETE") }
            if job.payload.relayVersion != nil { return }
            let conflict = SyncPaths.join(SyncPaths.dirname(job.relativePath), SyncPaths.conflictName(name, device: await deviceName(), operationID: job.id))
            try FileManager.default.moveItem(at: absolute, to: try SyncPaths.contained(base, conflict))
            note(root, job.relativePath)
            self.conflict(root, job.relativePath, conflict)
            journal.enqueue(root.id, conflict, .upsert)
            let remote: DriveItem? = if let known { try await self.item(known.itemId) } else { try await child(parentId, name) }
            if let remote { try await remoteItem(root, remote) }
            return
        }
        if root.mode == .backup {
            var saved = journal.job(job.id) ?? job
            saved.payload.upload = upload
            saved.payload.backupEntry = BackupEntryInput(relativePath: job.relativePath, itemId: item.id, versionId: item.currentVersionId ?? "",
                                                         sizeBytes: item.sizeBytes, modifiedAt: SyncClock.iso(Date(timeIntervalSince1970: (upload.mtime ?? info.mtime) / 1000)),
                                                         savedAt: SyncClock.iso())
            journal.save(saved)
        }
        journal.put(LocalFile(rootId: root.id, relativePath: job.relativePath, itemId: item.id, revision: item.revision ?? 1, hash: upload.hash, type: "FILE"))
        receipts.queue(root, job.relativePath, item, hash: upload.hash)
        activity(root, job.relativePath, .upload)
    }

    // MARK: Remote changes

    private func remotePath(_ root: SyncRoot, _ item: DriveItem) async throws -> String? {
        var segments = [try SyncPaths.safeSegment(item.name, id: item.id)]
        var parentId = item.parentId
        var depth = 0
        while parentId != root.remoteId {
            guard let current = parentId, depth < 32 else { return nil }
            depth += 1
            let parent = try await self.item(current)
            segments.insert(try SyncPaths.safeSegment(parent.name, id: parent.id), at: 0)
            parentId = parent.parentId
        }
        return segments.joined(separator: "/")
    }

    /// Keeps a divergent local file under a conflict name before it would be replaced.
    private func preserve(_ root: SyncRoot, _ base: URL, _ relative: String, knownHash: String?) async throws -> Bool {
        let full = try SyncPaths.contained(base, relative)
        guard let info = try LocalInfo.of(full), info.kind == .file, try SyncTransfers.hash(full) != knownHash else { return false }
        let conflict = SyncPaths.join(SyncPaths.dirname(relative), SyncPaths.conflictName(full.lastPathComponent, device: await deviceName(), operationID: UUID().uuidString.lowercased()))
        try FileManager.default.moveItem(at: full, to: try SyncPaths.contained(base, conflict))
        self.conflict(root, relative, conflict)
        journal.enqueue(root.id, conflict, .upsert)
        return true
    }

    func remoteItem(_ root: SyncRoot, _ eventItem: DriveItem, fresh: Bool = false, relative hint: String? = nil) async throws {
        if stopped || state.paused || root.paused || root.mode != .sync { return }
        guard let base = available[root.id] ?? (try? location(root)) else { return }
        if root.remoteId == eventItem.id {
            if eventItem.deletedAt == nil { receipts.queue(root, ".", eventItem, hash: nil) }
            return
        }
        let known = journal.file(root.id, item: eventItem.id)
        if let known, ignored(root, known.relativePath) { return }
        if eventItem.deletedAt != nil, let known, known.revision >= (eventItem.revision ?? 0) { return }
        if eventItem.deletedAt != nil {
            waiting[eventItem.id] = nil
            guard let known else { return }
            let full = try SyncPaths.contained(base, known.relativePath)
            if known.type == "FILE" {
                _ = try await preserve(root, base, known.relativePath, knownHash: known.hash)
                try? FileManager.default.removeItem(at: full)
            } else {
                // Preserve the entire local directory on remote deletion. It may contain unsynced work.
                // The copy stays visible beside its old location and is excluded from further syncing.
                do {
                    if try LocalFS.children(full).allSatisfy(SyncPaths.metadataSegment) {
                        try FileManager.default.removeItem(at: full)
                    } else {
                        let kept = SyncPaths.join(SyncPaths.dirname(known.relativePath), SyncPaths.recoveredName(full.lastPathComponent, at: Date()))
                        try FileManager.default.moveItem(at: full, to: try SyncPaths.contained(base, kept))
                        recovered(root, known.relativePath, kept)
                    }
                } catch where LocalFS.missing(error) {}
                for child in journal.files(root.id) where child.relativePath.hasPrefix(known.relativePath + "/") {
                    journal.deleteFile(root.id, child.relativePath)
                }
            }
            journal.deleteFile(root.id, known.relativePath)
            note(root, known.relativePath)
            return
        }
        // Resolve the latest metadata when processing historical feed entries.
        let item: DriveItem
        if fresh { item = eventItem } else {
            do { item = try await self.item(eventItem.id) }
            catch let error as APIError where ["ITEM_NOT_FOUND", "PARENT_NOT_FOUND"].contains(error.code ?? "") { return }
        }
        let resolved: String?
        if let hint { resolved = hint } else { resolved = try await remotePath(root, item) }
        guard let relative = resolved, !ignored(root, relative) else { return }
        let destination = try LocalFS.safeParents(base, relative)
        if let known, known.relativePath != relative {
            let previous = try SyncPaths.contained(base, known.relativePath)
            if try LocalInfo.of(destination) != nil {
                throw APIError(status: 0, message: "A local item blocks a remote move. Move it aside to continue safely.")
            }
            do { try FileManager.default.moveItem(at: previous, to: destination) } catch where LocalFS.missing(error) {}
            journal.deleteFile(root.id, known.relativePath)
            note(root, known.relativePath)
            if known.type == "FOLDER" {
                for child in journal.files(root.id) where child.relativePath.hasPrefix(known.relativePath + "/") {
                    journal.deleteFile(root.id, child.relativePath)
                    var moved = child
                    moved.relativePath = relative + child.relativePath.dropFirst(known.relativePath.count)
                    journal.put(moved)
                }
            }
            scannedAt[root.id] = 0
        }
        if item.isFolder {
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            journal.put(LocalFile(rootId: root.id, relativePath: relative, itemId: item.id, revision: item.revision ?? 1, hash: nil, type: "FOLDER"))
            note(root, relative)
            receipts.queue(root, relative, item, hash: nil)
            return
        }
        // A new file skips the version lookup: the download is verified against its own hash.
        var localHash: String?
        if let info = try LocalInfo.of(destination), info.kind == .file { localHash = try SyncTransfers.hash(destination) }
        if let localHash {
            let versions: Page<FileVersion> = try await api.request("/v1/drive/items/\(item.id)/versions")
            guard let hash = versions.items.first(where: { $0.id == item.currentVersionId })?.contentHash else {
                throw APIError(status: 0, message: "File version is unavailable.")
            }
            if localHash == hash {
                journal.put(LocalFile(rootId: root.id, relativePath: relative, itemId: item.id, revision: item.revision ?? 1, hash: hash, type: "FILE"))
                note(root, relative)
                receipts.queue(root, relative, item, hash: hash)
                waiting[item.id] = nil
                if item.cloudState == "REQUESTED" {
                    journal.enqueue(root.id, relative, .upsert)
                    if var relay = journal.job(root.id, relative, .upsert), relay.payload.relayVersion != item.currentVersionId {
                        relay.payload.relayVersion = item.currentVersionId
                        relay.payload.upload = UploadState(operationId: UUID().uuidString.lowercased())
                        journal.save(relay)
                    }
                    scheduleTick()
                }
                return
            }
        }
        if item.cloudState == "RELEASED" || item.cloudState == "REQUESTED" {
            let _: ItemResponse = try await api.request("/v1/sync/items/\(item.id)/request-content", method: "POST")
            state.message = "Waiting for a linked device to provide this file"
            waiting[item.id] = SyncWaiting(rootId: root.id, relativePath: relative)
            emit()
            return
        }
        setActive(SyncProgress(rootId: root.id, direction: .download, relativePath: relative, loaded: 0, total: item.sizeBytes))
        var body = ["driveItemId": item.id]
        if let version = item.currentVersionId { body["versionId"] = version }
        let hash = try await SyncTransfers.download(api: api, body, to: destination) { [weak self] in
            _ = try await self?.preserve(root, base, relative, knownHash: known?.hash)
        }
        journal.put(LocalFile(rootId: root.id, relativePath: relative, itemId: item.id, revision: item.revision ?? 1, hash: hash, type: "FILE"))
        note(root, relative)
        receipts.queue(root, relative, item, hash: hash)
        waiting[item.id] = nil
        activity(root, relative, .download)
    }
}
