import Foundation
import Combine
import UIKit
import BackgroundTasks
import CryptoKit

/// Where a new sync folder should live on this phone.
enum LocalChoice: Equatable {
    /// A new folder inside harbor0's own folder in the Files app (On My iPhone › harbor0).
    case app
    /// A folder chosen in the Files app; access is kept with a security-scoped bookmark.
    case picked(URL)
}

/// The cloud side of a new sync folder.
enum CloudChoice: Equatable {
    case existing(id: String, path: String)
    case new(name: String, parentId: String?, parentPath: String)
    case share(id: String)
}

struct SyncInvitation: Decodable, Identifiable, Equatable {
    struct Account: Decodable, Equatable { let id: String; let username: String; let displayName: String }
    let id: String
    let driveItemId: String
    let ownerUserId: String
    let recipientUserId: String
    var syncState: String? = nil
    var revokedAt: String? = nil
    let createdAt: String
    let name: String
    let direction: String
    let owner: Account
    let recipient: Account
}

/// Runs this phone's sync and backup engine for the signed-in account and publishes its state.
/// The engine runs while the app is open, finishes in-flight work when the app moves to the
/// background, and catches up in background tasks that iOS schedules.
@MainActor
final class SyncCenter: ObservableObject {
    static let refreshTask = "app.harbor0.sync.refresh"
    static let processingTask = "app.harbor0.sync.processing"

    @Published private(set) var snapshot = SyncSnapshot()
    @Published private(set) var deviceId: String?
    @Published private(set) var startError: String?
    @Published private(set) var invitations: [SyncInvitation] = []
    @Published private(set) var invitationError: String?
    private(set) var engine: SyncEngine?
    private var userId: String?
    private var starting: Task<Void, Never>?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    let api: HarborAPI

    private lazy var push = FilesPush(api: api)

    init(api: HarborAPI) { self.api = api }

    var ready: Bool { engine != nil }
    var folders: [SyncSnapshot.Folder] { snapshot.folders }
    var syncFolders: [SyncSnapshot.Folder] { snapshot.folders.filter { $0.root.mode == .sync } }
    var backupFolders: [SyncSnapshot.Folder] { snapshot.folders.filter { $0.root.mode == .backup } }
    func folder(remoteId: String?) -> SyncSnapshot.Folder? {
        guard let remoteId else { return nil }
        return snapshot.folders.first { $0.root.remoteId == remoteId }
    }
    func backupFolder(_ backup: BackupRoot) -> SyncSnapshot.Folder? {
        snapshot.folders.first { $0.root.mode == .backup && ($0.root.backupId == backup.id || $0.root.remoteId == backup.remoteRootDriveItemId) }
    }

    // MARK: Account

    /// Opens the account's journal and starts the engine once this device is registered.
    func connect(userId: String) async {
        if self.userId == userId, engine != nil { return }
        if let starting { return await starting.value }
        let task = Task { await self.open(userId: userId) }
        starting = task
        await task.value
        starting = nil
    }
    private func open(userId: String) async {
        await disconnect()
        do {
            let key = SHA256.hash(data: Data(api.baseURL.absoluteString.utf8)).prefix(6).map { String(format: "%02x", $0) }.joined()
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            let journal = try SyncJournal(url: support.appendingPathComponent("harbor0/sync/\(key)-\(userId).sqlite"))
            let device: (id: String, name: String)
            do { device = try await api.registerSyncDevice() }
            catch where error.isNetwork {
                // Offline: keep working from the last registration; the server is checked when online.
                guard let id = journal.get("deviceId", as: String.self) else { throw error }
                device = (id, journal.get("deviceName", as: String.self) ?? api.deviceName)
            }
            journal.set("deviceName", device.name)
            if journal.get("deviceId", as: String.self) != device.id {
                // A new session starts its change feed again; reconciling repairs anything missed.
                journal.set("deviceId", device.id)
                journal.set("cursor", 0)
            }
            let engine = SyncEngine(api: api, journal: journal, deviceId: device.id) { [weak self] snapshot in
                Task { @MainActor in self?.snapshot = snapshot }
            }
            self.engine = engine
            self.userId = userId
            deviceId = device.id
            startError = nil
            let foreground = UIApplication.shared.applicationState != .background
            await engine.start(foreground: foreground)
            snapshot = await engine.snapshot()
            if foreground { await engine.wake() }
            await loadInvitations()
            schedule()
            await FilesLocation.enable(apiURL: api.baseURL, userId: userId)
            push.start(domain: userId)
        } catch {
            if error is CancellationError { return }
            startError = error.localizedDescription
        }
    }
    func disconnect() async {
        guard let engine else { return }
        self.engine = nil
        userId = nil
        deviceId = nil
        await engine.stop()
        push.stop()
        snapshot = SyncSnapshot()
        invitations = []
    }

    // MARK: App lifecycle

    func foreground() {
        endBackgroundTask()
        FilesLocation.refresh()
        guard let engine else { return }
        Task { await engine.start(foreground: true); await engine.wake() }
    }
    /// Gives in-flight work up to the time iOS allows, then schedules background catch-up.
    func background() {
        schedule()
        guard let engine, backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "harbor0 sync") { [weak self] in
            Task { @MainActor in
                if UIApplication.shared.applicationState == .background { await self?.engine?.stop() }
                self?.endBackgroundTask()
            }
        }
        Task {
            await engine.stop()
            let remaining = min(UIApplication.shared.backgroundTimeRemaining, 25)
            await engine.drain(until: Date().addingTimeInterval(max(0, remaining - 3)))
            // The app may have returned to the foreground meanwhile; keep its loop running then.
            if UIApplication.shared.applicationState == .background { await engine.stop() }
            endBackgroundTask()
        }
    }
    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    static func register(center: @escaping @MainActor () -> SyncCenter?) {
        for identifier in [refreshTask, processingTask] {
            BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
                Task { @MainActor in
                    guard let center = center() else { task.setTaskCompleted(success: false); return }
                    await center.runBackgroundTask(task)
                }
            }
        }
    }
    private func runBackgroundTask(_ task: BGTask) async {
        schedule()
        let work = Task { @MainActor in
            if !api.signedIn { await api.restore() }
            guard api.signedIn else { return false }
            if engine == nil {
                let me: Account? = try? await api.request("/v1/users/me")
                guard let id = me?.user.id else { return false }
                await connect(userId: id)
            }
            guard let engine else { return false }
            let budget: TimeInterval = task is BGProcessingTask ? 600 : 25
            await engine.drain(until: Date().addingTimeInterval(budget))
            if UIApplication.shared.applicationState == .background { await engine.stop() }
            return true
        }
        task.expirationHandler = { work.cancel() }
        let success = await work.value
        task.setTaskCompleted(success: success)
    }
    /// Asks iOS for background time to catch up: a short refresh and a longer pass on Wi-Fi or power.
    func schedule() {
        guard !snapshot.folders.isEmpty else { return }
        let refresh = BGAppRefreshTaskRequest(identifier: Self.refreshTask)
        refresh.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(refresh)
        let processing = BGProcessingTaskRequest(identifier: Self.processingTask)
        processing.requiresNetworkConnectivity = true
        processing.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
        try? BGTaskScheduler.shared.submit(processing)
    }

    // MARK: Actions

    private func require() throws -> SyncEngine {
        guard let engine else { throw APIError(status: 0, message: startError ?? "Sync is starting. Try again in a moment.") }
        return engine
    }
    func refresh() async {
        guard let engine else { return }
        await engine.tick()
        snapshot = await engine.snapshot()
    }
    func pauseAll(_ paused: Bool) async { await engine?.pause(paused) }

    private static func uniqueAppFolder(_ name: String) throws -> String {
        let documents = SyncEngine.documents
        let base = (try? SyncPaths.safeSegment(name, id: UUID().uuidString)) ?? "Synced folder"
        for number in 1... {
            let candidate = number == 1 ? base : "\(base) \(number)"
            let url = documents.appendingPathComponent(candidate)
            if !FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                return candidate
            }
            if number > 200 { break }
        }
        throw APIError(status: 0, message: "Could not create a folder for this sync on your iPhone.")
    }
    private static func bookmark(_ url: URL) throws -> (LocalPlace, String) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let info = try LocalInfo.of(url), info.kind == .folder else {
            throw APIError(status: 0, message: "Choose a real folder, not a shortcut.")
        }
        guard FileManager.default.isWritableFile(atPath: url.path) else {
            throw APIError(status: 0, message: "harbor0 can’t write to this folder. Choose a folder on your iPhone or in iCloud Drive.")
        }
        let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        // The name the Files app shows, e.g. “harbor0” for this app's own folder.
        let name = (try? url.resourceValues(forKeys: [.localizedNameKey]).localizedName) ?? url.lastPathComponent
        return (LocalPlace(bookmark: data), name)
    }
    private func place(_ choice: LocalChoice, name: String) throws -> (LocalPlace, String) {
        switch choice {
        case .app:
            let folder = try Self.uniqueAppFolder(name)
            return (LocalPlace(documents: folder), folder)
        case .picked(let url):
            return try Self.bookmark(url)
        }
    }

    /// Starts syncing a cloud folder with a folder on this phone (desktop addSyncRoot).
    func addSync(cloud: CloudChoice, local: LocalChoice) async throws {
        let engine = try require()
        var remoteId: String?
        var cloudPath: String
        var shareId: String?
        var sharedBy: String?
        var name: String
        switch cloud {
        case .existing(let id, let path):
            remoteId = id; cloudPath = path; name = path.components(separatedBy: " / ").last ?? "Synced folder"
        case .share(let id):
            let status: SyncShareStatus = try await api.request("/v1/sync/shares/\(id)/status")
            remoteId = status.item.id; cloudPath = "Shared with me / \(status.item.name)"; name = status.item.name
            shareId = status.share.id; sharedBy = status.share.ownerUserId
        case .new(let folderName, _, let parentPath):
            name = folderName; cloudPath = parentPath
        }
        if let remoteId, snapshot.folders.contains(where: { $0.root.mode == .sync && $0.root.remoteId == remoteId }) {
            throw APIError(status: 0, message: "This cloud folder already syncs to this iPhone.")
        }
        if case .picked(let url) = local {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            try await engine.validate(SyncRoot(id: "", place: LocalPlace(), name: "", remoteId: remoteId ?? "new", mode: .sync), url: url)
        }
        let (place, localName) = try place(local, name: name)
        do {
            if case .new(let folderName, let parentId, let parentPath) = cloud {
                // Create the cloud folder; synced files are kept there and every device downloads changes from it.
                let operation = UUID().uuidString.lowercased()
                var created: DriveItem?
                for number in 1...50 where created == nil {
                    do {
                        created = try await api.createFolder(name: number == 1 ? folderName : "\(folderName.prefix(190)) \(number)", parentID: parentId)
                        _ = operation
                    } catch let error as APIError where error.code == "NAME_CONFLICT" && number < 50 { continue }
                }
                guard let created else { throw APIError(status: 0, message: "Could not create the cloud folder.") }
                remoteId = created.id
                cloudPath = parentPath + " / " + created.name
            }
            let root = SyncRoot(id: UUID().uuidString.lowercased(), place: place, name: localName, remoteId: remoteId, mode: .sync,
                                cloudPath: cloudPath, shareId: shareId, sharedBy: sharedBy)
            try await engine.addRoot(root)
        } catch {
            if case .app = local, let folder = place.documents {
                // Remove the empty folder made for this attempt.
                let url = SyncEngine.documents.appendingPathComponent(folder)
                if (try? LocalFS.children(url).isEmpty) == true { try? FileManager.default.removeItem(at: url) }
            }
            throw error
        }
        snapshot = await engine.snapshot()
    }

    /// Starts backing up a folder chosen in the Files app (desktop chooseRoot backup).
    func addBackup(_ url: URL) async throws {
        let engine = try require()
        guard let deviceId else { throw APIError(status: 0, message: "Sync is starting. Try again in a moment.") }
        let (place, name) = try Self.bookmark(url)
        let probe = SyncRoot(id: UUID().uuidString.lowercased(), place: place, name: name, remoteId: nil, mode: .backup)
        // Check overlap before anything is created on the server.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        try await engine.validate(probe, url: url)
        struct Created: Decodable { let root: BackupRoot }
        let created: Created = try await api.request("/v1/backups", method: "POST", body: [
            "operationId": UUID().uuidString.lowercased(), "deviceId": deviceId, "name": String(name.prefix(255)),
        ])
        var root = probe
        root.remoteId = created.root.remoteRootDriveItemId
        root.backupId = created.root.id
        root.cloudPath = "Backups / \(name)"
        do { try await engine.addRoot(root) }
        catch {
            // The overlap check runs before the folder starts backing up; don't leave an empty backup behind.
            let _: EmptyResponse? = try? await api.request("/v1/backups/\(created.root.id)", method: "DELETE")
            let _: EmptyResponse? = try? await api.request("/v1/backups/\(created.root.id)/forget", method: "POST")
            throw error
        }
        snapshot = await engine.snapshot()
    }

    func setPaused(_ folder: SyncSnapshot.Folder, _ paused: Bool) async throws {
        var root = folder.root
        root.paused = paused
        try await require().updateRoot(root)
    }
    func setExcluded(_ folder: SyncSnapshot.Folder, _ excluded: [String]) async throws {
        var root = folder.root
        root.excluded = excluded.sorted()
        try await require().updateRoot(root)
    }
    func changeLocal(_ folder: SyncSnapshot.Folder, to url: URL) async throws {
        var root = folder.root
        let (place, name) = try Self.bookmark(url)
        root.place = place
        root.name = name
        root.paused = false
        try await require().updateRoot(root)
    }
    /// Stops syncing on this phone only; other devices keep syncing and local files stay.
    func stopHere(_ folder: SyncSnapshot.Folder) async throws {
        try await require().removeRoot(folder.root.id)
    }
    /// Removes the folder from sync on every linked device (desktop removeSyncFolder).
    func removeEverywhere(folderId: String) async throws {
        try await require().removeSyncedFolder(folderId)
    }
    func backupNow(_ folder: SyncSnapshot.Folder) async throws { try await require().backupNow(folder.root.id) }
    func archive(_ folder: SyncSnapshot.Folder, _ archived: Bool) async throws { try await require().archiveBackup(folder.root.id, archived: archived) }
    func disconnectBackup(_ folder: SyncSnapshot.Folder) async throws { try await require().disconnectBackup(folder.root.id) }
    func dismiss(_ issue: SyncIssue) async { await engine?.dismissIssue(issue.id) }
    func retry(jobId: String) async { await engine?.retry(job: jobId) }
    func wake() { Task { await engine?.wake() } }

    // MARK: Shared sync invitations

    func loadInvitations() async {
        do {
            let page: Page<SyncInvitation> = try await api.request("/v1/sync/shares")
            invitations = page.items
            invitationError = nil
        } catch is CancellationError {
        } catch { invitationError = error.localizedDescription }
    }
    func invite(_ folder: SyncSnapshot.Folder, recipient raw: String) async throws {
        guard let remoteId = folder.root.remoteId else { return }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "^@", with: "", options: .regularExpression)
        let _: EmptyResponse = try await api.request("/v1/sync/shares", method: "POST", body: [
            "operationId": UUID().uuidString.lowercased(), "driveItemId": remoteId,
            "recipient": ["type": value.contains("@") ? "EMAIL" : "USERNAME", "value": value],
        ])
        await loadInvitations()
    }
    func revoke(_ invitation: SyncInvitation) async throws {
        let _: EmptyResponse = try await api.request("/v1/shares/\(invitation.id)", method: "DELETE", body: ["operationId": UUID().uuidString.lowercased()])
        await loadInvitations()
    }
    func respond(_ invitation: SyncInvitation, accept: Bool) async throws {
        let _: EmptyResponse = try await api.request("/v1/sync/shares/\(invitation.id)/respond", method: "POST", body: ["action": accept ? "ACCEPTED" : "DECLINED"])
        await loadInvitations()
    }
}

// MARK: - Labels (sync-state.ts folderState / globalSyncState)

enum SyncLabels {
    static let waiting = "Waiting for another device"

    static func folder(_ folder: SyncSnapshot.Folder, _ snapshot: SyncSnapshot) -> String {
        let state = snapshot.state
        let root = folder.root
        let issues = state.issues.filter { $0.rootId == root.id && $0.code != "FOLDER_RECOVERED" }
        if issues.contains(where: { $0.code == "FOLDER_MISSING" }) { return "Folder unavailable" }
        if issues.contains(where: { $0.code == "CONFLICT" }) { return "Conflict" }
        if !issues.isEmpty { return "Action required" }
        if state.paused || root.paused { return "Paused" }
        if !state.online { return "Offline" }
        if snapshot.jobs.contains(where: { $0.rootId == root.id && $0.error != nil }) { return "Action required" }
        if root.mode == .backup {
            if let archive = root.archive {
                switch archive {
                case .pending, .removing: return "Archiving"
                case .archived: return "Archived"
                case .restoring: return "Restoring"
                }
            }
            if state.active?.rootId == root.id { return "Backing up" }
            return snapshot.jobs.contains { $0.rootId == root.id } ? "Waiting" : "Backed up"
        }
        if state.active?.rootId == root.id || snapshot.jobs.contains(where: { $0.rootId == root.id }) { return "Syncing" }
        if state.waiting.contains(where: { $0.rootId == root.id }) { return waiting }
        return root.needsReconcile == true || state.confirmationPendingRoots.contains(root.id) ? "Syncing" : "Up to date"
    }

    static func global(_ snapshot: SyncSnapshot) -> String {
        let state = snapshot.state
        let roots = snapshot.folders.map(\.root)
        let ids = Set(roots.map(\.id))
        if roots.isEmpty { return state.paused ? "Paused" : "Not syncing" }
        if state.issues.contains(where: { (ids.contains($0.rootId) || $0.rootId.isEmpty) && $0.code != "FOLDER_RECOVERED" }) { return "Action required" }
        if state.paused { return "Paused" }
        if !state.online { return "Offline" }
        if snapshot.jobs.contains(where: { ids.contains($0.rootId) && $0.error != nil }) { return "Action required" }
        if state.active.map({ ids.contains($0.rootId) }) == true || state.confirmationPendingRoots.contains(where: ids.contains)
            || roots.contains(where: { root in !root.paused && root.mode == .sync && (root.needsReconcile == true || snapshot.jobs.contains { $0.rootId == root.id }) }) {
            return "Syncing"
        }
        return state.waiting.contains(where: { ids.contains($0.rootId) }) ? waiting : "Up to date"
    }

    static func tone(_ label: String) -> Tone {
        switch label {
        case "Up to date", "Backed up": .success
        case "Syncing", "Backing up", "Archiving", "Restoring": .accent
        case "Action required", "Conflict", "Folder unavailable": .danger
        case "Offline", waiting: .warning
        default: .neutral
        }
    }
    static func icon(_ label: String) -> Lucide {
        switch label {
        case "Up to date", "Backed up": .circleCheck
        case "Syncing", "Backing up", "Archiving", "Restoring": .loaderCircle
        case "Action required", "Conflict", "Folder unavailable": .circleAlert
        case "Offline": .wifiOff
        case "Paused": .pause
        case "Archived": .archive
        default: .clock3
        }
    }
}
