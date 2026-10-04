import Foundation

/// Folder backups from this phone (apps/desktop/src/backups.ts): runs, the one-hour quiet rule,
/// Back up now, archive and restore, and restores requested from other devices.
final class FolderBackups: @unchecked Sendable {
    static let quietMs: Double = 60 * 60 * 1000
    static func ready(mtime: Double, observedAt: Double = 0, now: Double = SyncClock.now) -> Bool {
        now - max(mtime, observedAt) >= quietMs
    }
    private struct PendingRun: Codable { var id: String; var trigger: String; var jobs: [String]; var error: String? }
    private struct RunResponse: Decodable { let run: BackupRun }
    private struct Connection: Decodable { let root: BackupRoot }
    private static let archiveAttempts = 3

    private let api: HarborAPI
    private let journal: SyncJournal
    private weak var engine: SyncEngine?
    private var nextRestoreCheck: [String: Double] = [:]

    init(api: HarborAPI, journal: SyncJournal, engine: SyncEngine) {
        self.api = api
        self.journal = journal
        self.engine = engine
    }

    // A request the server will keep refusing; retrying every pass would stall all other folders.
    private static func refused(_ error: Error) -> String? {
        guard let api = error as? APIError, api.status >= 400, api.status < 500, ![401, 429].contains(api.status),
              !["BACKUP_DISCONNECTED", "AUTH_INVALID", "DEVICE_REVOKED"].contains(api.code ?? "") else { return nil }
        return api.status == 404 ? "This harbor0 server does not support archiving yet." : api.message
    }
    private static func transient(_ error: Error) -> Bool {
        error.isNetwork || (error as? APIError).map { $0.status >= 500 || $0.status == 429 } ?? false || error is CancellationError
    }
    private func ignored(_ root: SyncRoot, _ relative: String) -> Bool {
        SyncPaths.internalPath(relative) || root.excluded.contains { relative == $0 || relative.hasPrefix($0 + "/") }
    }

    func request(_ root: SyncRoot) throws {
        if root.paused { throw APIError(status: 0, message: "Resume this backup folder before backing up now.") }
        if journal.get("backup-run:\(root.id)", as: PendingRun.self) != nil { throw APIError(status: 0, message: "A backup is already running for this folder.") }
        // Persist intent before scanning; an interrupted scan is repeated by the next pass.
        journal.set("backup-now:\(root.id)", true)
    }

    private func scan(_ root: SyncRoot, _ base: URL, _ relative: String = "") throws {
        let directory = try SyncPaths.contained(base, relative)
        guard let info = try LocalInfo.of(directory), info.kind == .folder else { throw SyncFolderMissing() }
        for name in try LocalFS.children(directory) {
            let path = relative.isEmpty ? name : relative + "/" + name
            if ignored(root, path) { continue }
            let kind = try LocalInfo.of(try SyncPaths.contained(base, path))?.kind
            if kind == .folder { try scan(root, base, path) } else if kind == .file { journal.enqueue(root.id, path, .upsert) }
        }
    }

    func process(_ root: SyncRoot, base: URL, stopped: () async -> Bool) async throws {
        var root = root
        if root.backupId == nil {
            let catalog: BackupCatalog = try await api.request("/v1/backups")
            guard let match = catalog.items.first(where: { $0.remoteRootDriveItemId == root.remoteId }) else {
                throw APIError(status: 0, message: "Backup folder registration was not found. Add this folder again.")
            }
            root.backupId = match.id
            journal.save(root)
        }
        let url = "/v1/backups/\(root.backupId!)"
        let connection: Connection = try await api.request(url)
        if connection.root.state == "REMOVED" { throw APIError(status: 409, message: "Backup folder disconnected.", code: "BACKUP_DISCONNECTED") }
        try await restores(root, base: base, url: url)
        let key = "backup-run:\(root.id)"
        var run = journal.get(key, as: PendingRun.self)
        if run == nil {
            let manual = journal.get("backup-now:\(root.id)", as: Bool.self) ?? false
            if manual { try scan(root, base) }
            var ready: [String] = []
            for job in journal.jobs(root: root.id) {
                if ignored(root, job.relativePath) { journal.finish(job.id); continue }
                if !manual && SyncClock.now < (job.payload.retryAfter ?? 0) { continue }
                let filename = try SyncPaths.contained(base, job.relativePath)
                let info: LocalInfo?
                do {
                    try LocalFS.safeParents(base, job.relativePath, create: false)
                    info = try LocalInfo.of(filename)
                } catch where LocalFS.missing(error) { info = nil }
                guard let info, info.kind == .file else { journal.finish(job.id); continue }
                if job.kind == .delete {
                    journal.finish(job.id)
                    journal.enqueue(root.id, job.relativePath, .upsert)
                    continue
                }
                if !manual && !Self.ready(mtime: info.mtime, observedAt: job.payload.observedAt ?? 0) { continue }
                // Rescans and touched-but-identical files queue entries too; they are already saved.
                if job.payload.upload?.uploadId == nil, job.payload.backupEntry == nil,
                   let known = journal.file(root.id, job.relativePath), known.type == "FILE", let hash = known.hash,
                   try SyncTransfers.hash(filename) == hash {
                    journal.finish(job.id)
                    continue
                }
                ready.append(job.id)
            }
            // Nothing changed: no backup is recorded, and a Back up now request is settled.
            if ready.isEmpty {
                if manual { journal.set("backup-now:\(root.id)", false) }
                try await upToDate(root, url)
                return
            }
            run = PendingRun(id: UUID().uuidString.lowercased(), trigger: manual ? "MANUAL" : "AUTOMATIC", jobs: ready)
            journal.set(key, run)
            journal.set("backup-now:\(root.id)", false)
        }
        guard var run else { return }
        let _: RunResponse = try await api.request("\(url)/runs", method: "POST", body: ["id": run.id, "trigger": run.trigger])
        for id in run.jobs {
            if await stopped() { return }
            if var job = journal.job(id) {
                let filename = try SyncPaths.contained(base, job.relativePath)
                var before: LocalInfo?
                do {
                    try LocalFS.safeParents(base, job.relativePath, create: false)
                    before = try LocalInfo.of(filename)
                } catch where LocalFS.missing(error) {}
                if job.payload.backupEntry != nil
                    || (before?.kind == .file && (run.trigger == "MANUAL" || Self.ready(mtime: before!.mtime, observedAt: job.payload.observedAt ?? 0))) {
                    do {
                        if job.payload.backupEntry == nil {
                            job.payload.backupManual = run.trigger == "MANUAL"
                            job.payload.backupRunId = run.id
                            journal.save(job)
                            try await engine?.localJob(root, job)
                            job = journal.job(id) ?? job
                        }
                        var entry = job.payload.backupEntry
                        if entry == nil {
                            guard let known = journal.file(root.id, job.relativePath) else { throw APIError(status: 0, message: "File changed before it could be backed up.") }
                            let response: ItemResponse = try await api.request("/v1/drive/items/\(known.itemId)")
                            entry = BackupEntryInput(relativePath: job.relativePath, itemId: response.item.id, versionId: response.item.currentVersionId ?? "",
                                                     sizeBytes: response.item.sizeBytes, modifiedAt: SyncClock.iso(Date(timeIntervalSince1970: before!.mtime / 1000)),
                                                     savedAt: SyncClock.iso())
                            job.payload.backupEntry = entry
                            journal.save(job)
                        }
                        let body: [String: Any] = ["relativePath": entry!.relativePath, "itemId": entry!.itemId, "versionId": entry!.versionId,
                                                   "sizeBytes": entry!.sizeBytes, "modifiedAt": entry!.modifiedAt, "savedAt": entry!.savedAt]
                        let _: EmptyResponse = try await api.request("\(url)/runs/\(run.id)/files", method: "POST", body: body)
                        journal.finish(job.id)
                        // Changes observed during a transfer must survive completion of its old queue entry.
                        if let after = try? LocalInfo.of(filename), after.kind == .file,
                           before == nil || after.mtime != before!.mtime || after.size != before!.size {
                            journal.enqueue(root.id, job.relativePath, .upsert)
                            if var next = journal.job(root.id, job.relativePath, .upsert) { next.payload.observedAt = SyncClock.now; journal.save(next) }
                        }
                    } catch {
                        // Retain upload state and the run for network retries, including acknowledgement loss.
                        if Self.transient(error) || error.apiCode == "BACKUP_DISCONNECTED" { throw error }
                        job = journal.job(id) ?? job
                        if let uploadId = job.payload.upload?.uploadId {
                            let _: EmptyResponse? = try? await api.request("/v1/uploads/\(uploadId)", method: "DELETE")
                            job.payload.upload = UploadState(operationId: UUID().uuidString.lowercased())
                        }
                        job.attempts += 1
                        job.payload.retryAfter = SyncClock.now + 60_000
                        job.error = error.localizedDescription
                        journal.save(job)
                        run.error = String("\(job.relativePath): \(job.error ?? "")".prefix(2000))
                    }
                }
            }
            run.jobs.removeAll { $0 == id }
            journal.set(key, run)
        }
        let _: RunResponse = try await api.request("\(url)/runs/\(run.id)/complete", method: "POST", body: run.error.map { ["error": $0] } ?? [:])
        journal.set(key, Optional<PendingRun>.none)
        await engine?.emit()
    }

    /// Files whose current content is exactly what the cloud copy holds; everything else is left alone.
    private func saved(_ root: SyncRoot, _ base: URL, _ relative: String = "") throws -> (saved: [(String, LocalInfo)], changed: [String]) {
        var saved: [(String, LocalInfo)] = []
        var changed: [String] = []
        for name in try LocalFS.children(try SyncPaths.contained(base, relative)) {
            let path = relative.isEmpty ? name : relative + "/" + name
            if ignored(root, path) { continue }
            let url = try SyncPaths.contained(base, path)
            guard let info = try LocalInfo.of(url) else { continue }
            if info.kind == .folder {
                let nested = try self.saved(root, base, path)
                saved += nested.saved
                changed += nested.changed
            } else if info.kind == .file {
                if let known = journal.file(root.id, path), known.type == "FILE", let hash = known.hash, try SyncTransfers.hash(url) == hash {
                    saved.append((path, info))
                } else { changed.append(path) }
            }
        }
        return (saved, changed)
    }
    private func prune(_ root: SyncRoot, _ base: URL, _ relative: String = "") throws {
        let directory = try SyncPaths.contained(base, relative)
        for name in try LocalFS.children(directory) {
            let path = relative.isEmpty ? name : relative + "/" + name
            if try LocalInfo.of(try SyncPaths.contained(base, path))?.kind == .folder, !ignored(root, path) { try prune(root, base, path) }
        }
        let rest = try LocalFS.children(directory)
        // File-manager bookkeeping alone must not keep an emptied folder around.
        guard rest.allSatisfy({ SyncPaths.metadataSegment($0) }) else { return }
        if relative.isEmpty {
            for name in rest { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
        } else {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    /// Finish a requested archive once a full backup has saved everything: stop the backup, then
    /// remove only local files verified against their saved version.
    func archive(_ root: SyncRoot, base: URL, stopped: () async -> Bool) async throws {
        var root = root
        guard let backupId = root.backupId else { return }
        let attemptsKey = "backup-archive:\(root.id)"
        // Nothing local has been removed yet, so a failed archive simply keeps backing up.
        func cancel(_ reason: String) {
            root.archive = nil
            root.archiveError = reason
            journal.save(root)
            journal.set(attemptsKey, 0)
        }
        if root.archive == .pending {
            if journal.get("backup-run:\(root.id)", as: PendingRun.self) != nil || journal.get("backup-now:\(root.id)", as: Bool.self) == true { return }
            let jobs = journal.jobs(root: root.id)
            if let failed = jobs.first(where: { $0.error != nil }) { return cancel("\(failed.relativePath) could not be backed up: \(failed.error!)") }
            let changed = jobs.isEmpty ? try saved(root, base).changed : ["."]
            if await stopped() { return }
            if !changed.isEmpty {
                let attempts = (journal.get(attemptsKey, as: Int.self) ?? 0) + 1
                if attempts >= Self.archiveAttempts { return cancel("Its files keep changing. Try again when nothing is editing them.") }
                // Edits made during the final backup need one more pass before anything is removed.
                journal.set(attemptsKey, attempts)
                for name in changed where name != "." { journal.enqueue(root.id, name, .upsert) }
                journal.set("backup-now:\(root.id)", true)
                return
            }
            do {
                let _: EmptyResponse = try await api.request("/v1/backups/\(backupId)/archive", method: "POST")
            } catch {
                guard let reason = Self.refused(error) else { throw error }
                return cancel(reason)
            }
            root.archive = .removing
            journal.save(root)
        }
        if let exists = try LocalInfo.of(base), exists.kind == .folder {
            for (path, info) in try saved(root, base).saved {
                let url = try SyncPaths.contained(base, path)
                if let current = try LocalInfo.of(url), current.kind == .file, current.size == info.size, current.mtime == info.mtime {
                    try FileManager.default.removeItem(at: url)
                }
            }
            try prune(root, base)
        }
        journal.resetRootFiles(root.id)
        journal.set(attemptsKey, 0)
        root.archive = .archived
        journal.save(root)
    }

    /// Bring an archived folder back: resume the backup and download the latest saved files.
    func unarchive(_ root: SyncRoot, base: URL, stopped: () async -> Bool) async throws {
        var root = root
        do {
            let _: EmptyResponse = try await api.request("/v1/backups/\(root.backupId ?? "")/unarchive", method: "POST")
        } catch {
            guard let reason = Self.refused(error) else { throw error }
            root.archive = .archived
            root.archiveError = reason
            journal.save(root)
            return
        }
        func walk(_ parentId: String, _ relative: String) async throws -> Bool {
            var cursor: String?
            repeat {
                let page = try await api.list(parentID: parentId, cursor: cursor)
                for item in page.items {
                    if await stopped() { return false }
                    let name = try SyncPaths.safeSegment(item.name, id: item.id)
                    let path = relative.isEmpty ? name : relative + "/" + name
                    if ignored(root, path) { continue }
                    let destination = try LocalFS.safeParents(base, path)
                    if item.isFolder {
                        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                        if try await !walk(item.id, path) { return false }
                    } else if try LocalInfo.of(destination) == nil {
                        // Anything already in the folder is newer local work; the next backup saves it.
                        try await SyncTransfers.download(api: api, ["driveItemId": item.id], to: destination)
                    }
                }
                cursor = page.nextCursor
            } while cursor != nil
            return true
        }
        if let remoteId = root.remoteId, try await walk(remoteId, "") {
            root.archive = nil
            root.archiveError = nil
            journal.save(root)
        }
    }

    /// Nothing new records no run, so harbor0 is told the folder is still backed up; otherwise an
    /// untouched folder would get a stale-backup reminder. Waiting changes don't count.
    private func upToDate(_ root: SyncRoot, _ url: String) async throws {
        if !journal.jobs(root: root.id).isEmpty { return }
        let key = "backup-checked:\(root.id)"
        let now = Date().timeIntervalSince1970
        if now - (journal.get(key, as: Double.self) ?? 0) < 12 * 3600 { return }
        let _: EmptyResponse = try await api.request("\(url)/checked", method: "POST")
        journal.set(key, now)
    }
    private func restores(_ root: SyncRoot, base: URL, url: String) async throws {
        if SyncClock.now < (nextRestoreCheck[root.id] ?? 0) { return }
        nextRestoreCheck[root.id] = SyncClock.now + 10_000
        // Pending entries are removed on acknowledgement; always read from the beginning.
        let page: Page<BackupRestore> = try await api.request("\(url)/pending-restores")
        for request in page.items {
            guard let itemId = request.itemId, let versionId = request.versionId else { continue }
            let relativePath = journal.file(root.id, item: itemId)?.relativePath ?? request.relativePath
            let receiptKey = "backup-restore:\(request.id)"
            var receipt = journal.get(receiptKey, as: [String: String].self)
            if receipt == nil {
                do {
                    let destination = try LocalFS.safeParents(base, relativePath)
                    if relativePath.isEmpty || destination.standardizedFileURL == base.standardizedFileURL {
                        throw APIError(status: 0, message: "Invalid restore destination.")
                    }
                    let before = try LocalInfo.of(destination)
                    try await SyncTransfers.download(api: api, ["driveItemId": itemId, "versionId": versionId], to: destination) { [api] in
                        let connection: Connection = try await api.request(url)
                        if connection.root.state == "REMOVED" { throw APIError(status: 409, message: "Backup folder disconnected.", code: "BACKUP_DISCONNECTED") }
                        try LocalFS.safeParents(base, relativePath)
                        let current = try LocalInfo.of(destination)
                        if (before == nil) != (current == nil) || (before != nil && current != nil && before != current) {
                            throw APIError(status: 0, message: "The local file changed during restore. Retry after editing is finished.")
                        }
                    }
                    // Record completion before acknowledging so an offline retry cannot overwrite newer edits.
                    receipt = [:]
                } catch {
                    if Self.transient(error) { throw error }
                    receipt = ["error": String(error.localizedDescription.prefix(2000))]
                }
                journal.set(receiptKey, receipt)
            }
            let _: EmptyResponse = try await api.request("\(url)/restores/\(request.id)/complete", method: "POST", body: receipt ?? [:])
        }
    }
}
