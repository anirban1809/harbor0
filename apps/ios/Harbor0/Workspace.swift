import SwiftUI
import Combine
import Network

/// The phone workspace's pages (web WorkspaceSection).
enum Section: String, CaseIterable, Identifiable {
    case drive = "My Drive", shared = "Shared", backups = "Backups", trash = "Trash"
    case sync = "Sync", devices = "Devices", storage = "Storage", settings = "Settings", notifications = "Notifications"
    var id: String { rawValue }
    /// Pages reached from the More sheet keep the More tab active.
    var inMore: Bool { ![.drive, .shared, .backups, .trash].contains(self) }
}

struct ActivityEntry: Identifiable, Equatable {
    enum Status: String { case info, progress, success, error }
    let id: String
    var message: String
    var status: Status
    var time: Date
    var read: Bool
}

/// Session-wide state: navigation, search, account, feedback and connectivity.
@MainActor
final class Workspace: ObservableObject {
    @Published var section: Section = .drive
    @Published var query = ""
    @Published var toast: String?
    @Published var error: String?
    @Published private(set) var online = true
    @Published private(set) var activity: [ActivityEntry] = []
    @Published var showMore = false
    @Published var showAccount = false
    @Published var showActivity = false
    /// Bumped after changes that other pages should reload for.
    @Published var revision = 0
    let api: HarborAPI
    let appearance: AppearanceStore
    let catalog = WorkspaceCatalog()
    let sync: SyncCenter
    private var toastTask: Task<Void, Never>?
    private let monitor = NWPathMonitor()

    init(api: HarborAPI, appearance: AppearanceStore, sync: SyncCenter) {
        self.api = api
        self.appearance = appearance
        self.sync = sync
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in self?.online = path.status == .satisfied }
        }
        monitor.start(queue: DispatchQueue(label: "app.harbor0.network"))
    }
    deinit { monitor.cancel() }

    var account: Account? { appearance.account }
    var unread: Int { activity.filter { !$0.read }.count }

    func navigate(_ next: Section) {
        query = ""
        error = nil
        showMore = false
        showAccount = false
        section = next
    }
    /// A short confirmation toast (4.5 seconds), also kept in the activity feed.
    func notify(_ message: String, status: ActivityEntry.Status = .success, id: String? = nil, toast showToast: Bool = true) {
        publish(id: id ?? UUID().uuidString, message: message, status: status)
        guard showToast else { return }
        toast = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_500_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }
    func publish(id: String, message: String, status: ActivityEntry.Status, time: Date = Date()) {
        if let existing = activity.first(where: { $0.id == id }), existing.message == message, existing.status == status { return }
        activity.removeAll { $0.id == id }
        activity.insert(ActivityEntry(id: id, message: message, status: status, time: time, read: showActivity), at: 0)
        activity.sort { $0.time > $1.time }
        if activity.count > 100 { activity.removeLast(activity.count - 100) }
    }
    func markActivityRead() {
        guard activity.contains(where: { !$0.read }) else { return }
        activity = activity.map { var entry = $0; entry.read = true; return entry }
    }
    func fail(_ error: Error) {
        if error is CancellationError { return }
        if let url = error as? URLError, url.code == .cancelled { return }
        self.error = error.localizedDescription
    }
    func refreshAccount() async {
        await appearance.load(api)
        startSync()
    }
    /// Starts this phone's sync engine once the account is known.
    func startSync(force: Bool = false) {
        guard let id = account?.user.id, force || !sync.ready else { return }
        Task { await sync.connect(userId: id) }
    }
    func changed() { revision += 1 }

    /// The theme toggle (sun/moon): switches between light and dark and saves to the account.
    func toggleTheme(current: ColorScheme) {
        let dark = (appearance.appearance.colorScheme ?? current) == .dark
        appearance.change(api) { $0.preference = dark ? "light" : "dark" }
    }
    func signOut() async {
        // Finish the current transfer; queued changes stay in this account's journal for next time.
        await sync.disconnect()
        do {
            try await api.logout()
            await FilesLocation.disable()
        } catch { fail(error); startSync(force: true) }
    }
    func reset() {
        toastTask?.cancel()
        section = .drive; query = ""; toast = nil; error = nil; activity = []
        showMore = false; showAccount = false; showActivity = false
    }
}

/// Synced folders, backup roots, devices and sync status, shared by My Drive and Backups.
@MainActor
final class WorkspaceCatalog: ObservableObject {
    @Published private(set) var syncFolders: [DriveItem] = []
    @Published private(set) var backups: [BackupRoot] = []
    @Published private(set) var allBackups: [BackupRoot] = []
    /// Signed-in devices, for grouping synced folders by device in My Drive › Synced Folders.
    @Published private(set) var devices: [Device] = []
    @Published private(set) var haveDevices = false
    /// Folder usage by item id (`/v1/drive/usage`), for the places in My Drive.
    @Published private(set) var usage: [String: FolderUsage] = [:]
    private var usageFetchedAt: [String: Date] = [:]
    @Published private(set) var statuses: [String: SyncStatus] = [:]
    @Published private(set) var syncError: String?
    @Published private(set) var backupError: String?
    @Published private(set) var statusError: String?
    @Published private(set) var loadingSync = false
    @Published private(set) var loadingBackups = false
    @Published private(set) var haveSync = false
    @Published private(set) var haveBackups = false
    @Published var revision = 0
    var ready: Bool { haveSync && haveBackups }
    var syncIDs: Set<String> { Set(syncFolders.map(\.id)) }
    var backupFolderIDs: [String: String] { Dictionary(backups.map { ($0.remoteRootDriveItemId, $0.id) }, uniquingKeysWith: { a, _ in a }) }
    var specialIDs: Set<String> { Set(syncFolders.map(\.id) + backups.map(\.remoteRootDriveItemId)) }

    func load(_ api: HarborAPI) async {
        async let sync: Void = loadSync(api)
        async let backup: Void = loadBackups(api)
        async let devices: Void = loadDevices(api)
        _ = await (sync, backup, devices)
    }
    /// Usage for folders, 50 ids per request. The server caches ~60s, so ids fetched in the last 30s are skipped.
    func loadUsage(_ api: HarborAPI, ids: [String]) async {
        let now = Date()
        var wanted: [String] = []
        for id in ids where !wanted.contains(id) && now.timeIntervalSince(usageFetchedAt[id] ?? .distantPast) > 30 { wanted.append(id) }
        guard !wanted.isEmpty else { return }
        for id in wanted { usageFetchedAt[id] = now }
        for start in stride(from: 0, to: wanted.count, by: 50) {
            let chunk = Array(wanted[start..<min(start + 50, wanted.count)])
            do {
                let page: Page<FolderUsage> = try await api.request("/v1/drive/usage?ids=" + chunk.joined(separator: ","))
                var next = usage
                for item in page.items { next[item.itemId] = item }
                usage = next
            } catch {
                // Retry these on the next load.
                for id in chunk { usageFetchedAt[id] = nil }
            }
        }
    }
    /// Best effort: without the device list, synced folders are grouped by the device names they carry.
    func loadDevices(_ api: HarborAPI) async {
        do {
            let page: Page<Device> = try await api.request("/v1/devices")
            try Task.checkCancellation()
            devices = page.items
            haveDevices = true
        } catch {}
    }
    func loadSync(_ api: HarborAPI) async {
        guard !loadingSync else { return }
        loadingSync = true
        defer { loadingSync = false }
        do {
            var all: [DriveItem] = []
            var cursor: String?
            var seen = Set<String>()
            repeat {
                let page: DrivePage = try await api.request(HarborAPI.pagePath("/v1/sync/folders", cursor: cursor))
                all += page.items
                cursor = page.nextCursor
                if let cursor, !seen.insert(cursor).inserted { break }
            } while cursor != nil
            try Task.checkCancellation()
            syncFolders = all
            haveSync = true
            syncError = nil
        } catch is CancellationError { }
        catch { syncError = error.localizedDescription }
    }
    func loadBackups(_ api: HarborAPI) async {
        guard !loadingBackups else { return }
        loadingBackups = true
        defer { loadingBackups = false }
        do {
            let result: BackupCatalog = try await api.request("/v1/backups")
            try Task.checkCancellation()
            allBackups = result.items
            backups = result.items.filter { $0.state != "REMOVED" }
            haveBackups = true
            backupError = nil
        } catch is CancellationError { }
        catch { backupError = error.localizedDescription }
    }
    /// Sync status for any visible items, 50 at a time (web refreshStatus).
    func loadStatuses(_ api: HarborAPI, ids: [String]) async {
        guard !ids.isEmpty else { return }
        do {
            var all: [String: SyncStatus] = [:]
            for start in stride(from: 0, to: ids.count, by: 50) {
                let chunk = ids[start..<min(start + 50, ids.count)].joined(separator: ",")
                let status: SyncStatusPage = try await api.request("/v1/sync/status?ids=\(chunk)")
                for item in status.items { all[item.itemId] = item }
            }
            statuses.merge(all) { _, new in new }
            statusError = nil
        } catch is CancellationError { }
        catch { statusError = error.localizedDescription }
    }
}
