import SwiftUI
import Combine

enum DriveLocation: String, CaseIterable, Identifiable { case cloud = "Cloud", backup = "Backup", sync = "Sync"; var id: String { rawValue } }
struct Crumb: Identifiable, Hashable { let id: String; let name: String }
/// My Drive's permanent places: virtual folders pinned at the Cloud root. Each lists devices, then the
/// folders that device keeps there (web components/device-folders.tsx). None is a drive item.
enum DrivePlace: String, CaseIterable, Identifiable {
    case synced = "Synced Folders", backups = "Backups", archives = "Archives"
    var id: String { rawValue }
    var location: DriveLocation { self == .synced ? .sync : .backup }
    /// "synced folder", "backup folder" or "archived folder", for counts.
    var noun: String { switch self { case .synced: "synced folder"; case .backups: "backup folder"; case .archives: "archived folder" } }
    func summary(devices count: Int) -> String {
        switch self {
        case .synced: count == 0 ? "Folders synced on your devices" : "Synced on \(Format.count(count, "device"))"
        case .backups: count == 0 ? "Folders backed up from your devices" : "Backed up from \(Format.count(count, "device"))"
        case .archives: count == 0 ? "Archived backup folders" : "Archived from \(Format.count(count, "device"))"
        }
    }
    /// Backup root states shown in this place; REMOVED roots are ordinary cloud folders.
    var backupStates: Set<String> { self == .archives ? ["ARCHIVED"] : self == .backups ? ["ACTIVE", "PAUSED", "ERROR"] : [] }
}
/// Storage used by a set of folders: the sum over unique folder ids. Incomplete if any count stopped early.
struct UsageTotal: Equatable {
    var bytes: Int64 = 0
    var files = 0
    var complete = true

    /// nil until every folder's usage has loaded; rows render first and sizes fill in.
    static func sum<S: Sequence>(_ ids: S, usage: [String: FolderUsage]) -> UsageTotal? where S.Element == String {
        var total = UsageTotal()
        for id in Set(ids) {
            guard let entry = usage[id] else { return nil }
            total.bytes += entry.bytes
            total.files += entry.files
            total.complete = total.complete && entry.complete
        }
        return total
    }
    /// "4.2 GB", or "At least 4.2 GB" when the count is partial.
    var label: String { complete ? Format.size(bytes) : "At least \(Format.size(bytes))" }
    /// "4.2 GB", or "4.2 GB+" where space is tight.
    var short: String { Format.size(bytes) + (complete ? "" : "+") }
}
/// A device inside a place and its folders there. Devices that are gone appear as name-only pseudo-devices.
struct PlaceDevice: Identifiable {
    let id: String
    let name: String
    var platform: String? = nil
    var icon: Lucide = .laptop
    let folders: [DriveItem]
}

/// Type, modified and sort filters (apps/web/lib/drive-view.ts).
struct DriveFilters: Equatable {
    var type = "all"
    var modified = "all"
    var sort = "modified-desc"
    var foldersFirst = true
    var showSystem = false
    var active: Bool { type != "all" || modified != "all" }

    static let types: [(String, String)] = [("all", "Type: All items"), ("folders", "Type: Folders"), ("files", "Type: Files"),
                                            ("image", "Type: Images"), ("video", "Type: Videos"), ("audio", "Type: Audio")]
    static let modifiedOptions: [(String, String)] = [("all", "Modified: Any time"), ("1", "Modified: Last 24 hours"),
                                                      ("7", "Modified: Last 7 days"), ("30", "Modified: Last 30 days")]
    static let sorts: [(String, String)] = [("modified-desc", "Modified, newest first"), ("modified-asc", "Modified, oldest first"),
                                            ("name-asc", "Name, A–Z"), ("name-desc", "Name, Z–A"),
                                            ("size-desc", "Size, largest first"), ("size-asc", "Size, smallest first"),
                                            ("created-desc", "Created, newest first"), ("created-asc", "Created, oldest first")]
    static func isSystem(_ name: String) -> Bool { [".ds_store", "thumbs.db", "desktop.ini"].contains(name.lowercased()) }

    func apply(_ items: [DriveItem], now: Date = Date()) -> [DriveItem] {
        let days = Double(modified) ?? 0
        let result = items.filter { item in
            (showSystem || !Self.isSystem(item.name)) &&
            (type == "all" || (type == "folders" ? item.isFolder : type == "files" ? !item.isFolder : item.mimeType?.hasPrefix(type + "/") == true)) &&
            (modified == "all" || (Format.parse(item.updatedAt).map { $0.timeIntervalSince1970 >= now.timeIntervalSince1970 - days * 86400 } ?? false))
        }
        let parts = sort.split(separator: "-")
        let field = parts.first.map(String.init) ?? "modified", descending = parts.last == "desc"
        return result.sorted { a, b in
            if foldersFirst && a.isFolder != b.isFolder { return a.isFolder }
            let order: ComparisonResult
            switch field {
            case "name": order = a.name.localizedStandardCompare(b.name)
            case "size": order = a.sizeBytes == b.sizeBytes ? .orderedSame : (a.sizeBytes < b.sizeBytes ? .orderedAscending : .orderedDescending)
            default:
                let x = Format.parse(field == "created" ? a.createdAt : a.updatedAt)?.timeIntervalSince1970 ?? 0
                let y = Format.parse(field == "created" ? b.createdAt : b.updatedAt)?.timeIntervalSince1970 ?? 0
                order = x == y ? .orderedSame : (x < y ? .orderedAscending : .orderedDescending)
            }
            if order == .orderedSame { return a.name.localizedStandardCompare(b.name) == .orderedAscending }
            return descending ? order == .orderedDescending : order == .orderedAscending
        }
    }
}

/// My Drive's state: location tab, folder trail, listing, filters and selection (drive-workspace.tsx).
@MainActor
final class DriveModel: ObservableObject {
    @Published var location: DriveLocation = .cloud
    @Published private(set) var trail: [Crumb] = []
    @Published private(set) var items: [DriveItem] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var loading = true
    @Published private(set) var refreshing = false
    @Published private(set) var loadError: String?
    @Published private(set) var trailError = false
    @Published var filters = DriveFilters()
    @Published var grid = UserDefaults.standard.string(forKey: "harbor-drive-view") == "grid" {
        didSet { UserDefaults.standard.set(grid ? "grid" : "list", forKey: "harbor-drive-view") }
    }
    @Published var selected: Set<String> = []
    @Published var scope = "all"
    @Published private(set) var searchLocations: [String: DriveLocation] = [:]
    @Published var busy = false
    /// The place being browsed (nil: plain Cloud), and the device opened inside it (nil: its device list).
    @Published private(set) var place: DrivePlace?
    @Published private(set) var placeDevice: Crumb?
    private var pages = 1
    private var loadedKey = ""
    private var ancestry: [String: DriveItem] = [:]
    private var generation = UUID()

    var parentID: String? { trail.last?.id }
    var inFolder: Bool { !trail.isEmpty }
    /// A place's own pages: its device list, or one device's folders.
    var inPlace: Bool { place != nil && trail.isEmpty }
    /// The Cloud root, where the places are pinned first.
    func showsPlaces(workspace: Workspace) -> Bool {
        location == .cloud && !inFolder && workspace.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !filters.active
    }

    func reset() {
        generation = UUID()
        location = .cloud; trail = []; items = []; nextCursor = nil
        loading = true; loadError = nil; filters = DriveFilters(); selected = []; scope = "all"
        searchLocations = [:]; pages = 1; loadedKey = ""; ancestry = [:]; place = nil; placeDevice = nil
    }

    // MARK: Navigation

    func changeTab(_ tab: DriveLocation, workspace: Workspace) {
        location = tab
        trail = []
        place = nil
        placeDevice = nil
        selected = []
        filters = DriveFilters()
        workspace.query = ""
    }
    /// Opens a place's device list (device nil) or one device's folders inside it.
    func open(place: DrivePlace, device: Crumb? = nil, workspace: Workspace) {
        changeTab(place.location, workspace: workspace)
        self.place = place
        placeDevice = device
    }
    /// The place a folder reached by search or link belongs to.
    private func place(of item: DriveItem, in tab: DriveLocation, workspace: Workspace) -> DrivePlace? {
        switch tab {
        case .cloud: return nil
        case .sync: return .synced
        case .backup:
            let rootID = item.backupRootId ?? workspace.catalog.backupFolderIDs[item.id]
            return workspace.catalog.backups.first { $0.id == rootID }?.state == "ARCHIVED" ? .archives : .backups
        }
    }
    func open(folder: DriveItem, workspace: Workspace) {
        selected = []
        filters = DriveFilters()
        if !workspace.query.isEmpty {
            // A search result: resolve its path and location like a deep link.
            workspace.query = ""
            let tab = searchLocations[folder.id] ?? (folder.backupRootId != nil ? .backup : .cloud)
            location = tab
            place = place(of: folder, in: tab, workspace: workspace)
            placeDevice = nil
            trail = [Crumb(id: folder.id, name: folder.name)]
            Task { await resolveTrail(folder, workspace: workspace) }
        } else {
            if trail.isEmpty && place == nil {
                if folder.backupRootId != nil || workspace.catalog.backupFolderIDs[folder.id] != nil { location = .backup }
                else if workspace.catalog.syncIDs.contains(folder.id) { location = .sync }
                place = place(of: folder, in: location, workspace: workspace)
            }
            trail.append(Crumb(id: folder.id, name: folder.name))
        }
    }
    /// Opens a folder found by search elsewhere, resolving its location tab and path.
    func reveal(_ folder: DriveItem, workspace: Workspace) {
        selected = []
        filters = DriveFilters()
        location = folder.backupRootId != nil ? .backup : .cloud
        place = place(of: folder, in: location, workspace: workspace)
        placeDevice = nil
        trail = [Crumb(id: folder.id, name: folder.name)]
        Task {
            if let tab = try? await classify(folder, workspace: workspace), trail.last?.id == folder.id {
                location = tab
                place = place(of: folder, in: tab, workspace: workspace)
            }
            await resolveTrail(folder, workspace: workspace)
        }
    }
    func go(to index: Int?) {
        selected = []
        filters = DriveFilters()
        if let index { trail = Array(trail.prefix(index + 1)) } else { trail = []; location = .cloud; place = nil; placeDevice = nil }
    }
    private func resolveTrail(_ folder: DriveItem, workspace: Workspace) async {
        var names: [Crumb] = [Crumb(id: folder.id, name: folder.name)]
        var parent = folder.parentId
        var seen = Set<String>()
        do {
            while let id = parent, seen.insert(id).inserted, seen.count < 33 {
                let item = try await lookup(id, workspace: workspace)
                names.insert(Crumb(id: item.id, name: item.name), at: 0)
                parent = item.parentId
            }
            if trail.last?.id == folder.id { trail = names; trailError = false }
        } catch { trailError = true }
    }
    private func lookup(_ id: String, workspace: Workspace) async throws -> DriveItem {
        if let cached = ancestry[id] { return cached }
        let response: ItemResponse = try await workspace.api.request("/v1/drive/items/\(id)")
        ancestry[id] = response.item
        return response.item
    }
    /// Which location tab an item belongs to, from its ancestry (drive-locations.ts).
    private func classify(_ item: DriveItem, workspace: Workspace) async throws -> DriveLocation {
        let backups = workspace.catalog.backupFolderIDs, sync = workspace.catalog.syncIDs
        var current = item
        var isSync = false
        var seen = Set<String>()
        while true {
            if current.backupRootId != nil || backups[current.id] != nil { return .backup }
            if sync.contains(current.id) { isSync = true }
            guard let parent = current.parentId else { return isSync ? .sync : .cloud }
            guard seen.insert(parent).inserted, seen.count < 33 else { throw APIError(status: 0, message: "Could not identify this folder location.") }
            current = try await lookup(parent, workspace: workspace)
        }
    }

    // MARK: Loading

    func load(workspace: Workspace, more: Bool = false, silent: Bool = false) async {
        let query = workspace.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = [parentID ?? "root", query, scope, location.rawValue].joined(separator: "|")
        if more { pages += 1 } else if key != loadedKey { pages = 1 }
        let fresh = key != loadedKey
        if fresh && !silent { loading = true; loadError = nil; items = []; nextCursor = nil }
        refreshing = true
        let stamp = UUID()
        generation = stamp
        defer { if generation == stamp { refreshing = false; loading = false } }
        let api = workspace.api
        let path = !query.isEmpty && !(scope == "folder" && parentID != nil)
            ? "/v1/search?q=" + Self.encode(query)
            : "/v1/drive/folders/\(parentID ?? "root")/children"
        do {
            async let catalog: Void = workspace.catalog.load(api)
            var result: [DriveItem] = []
            var cursor: String?
            var seen = Set<String>()
            for _ in 0..<pages {
                let page: DrivePage = try await api.request(HarborAPI.pagePath(path, cursor: cursor))
                result += page.items
                cursor = page.nextCursor
                guard let next = cursor else { break }
                guard seen.insert(next).inserted else { throw APIError(status: 0, message: "Could not load the remaining files. Please retry.") }
            }
            await catalog
            guard generation == stamp else { return }
            var unique: [String: DriveItem] = [:]
            var order: [String] = []
            for item in result where unique[item.id] == nil { unique[item.id] = item; order.append(item.id) }
            let listing = order.compactMap { unique[$0] }
            if workspace.catalog.backupError != nil && workspace.catalog.haveBackups == false {
                throw APIError(status: 0, message: workspace.catalog.backupError!)
            }
            if !query.isEmpty && !(scope == "folder" && parentID != nil) {
                var locations: [String: DriveLocation] = [:]
                for item in listing { locations[item.id] = (try? await classify(item, workspace: workspace)) ?? .cloud }
                searchLocations = locations
            }
            guard generation == stamp else { return }
            items = listing
            nextCursor = cursor
            loadedKey = key
            loadError = nil
            let visible = Set(entries(workspace: workspace).map(\.id))
            selected = selected.filter { visible.contains($0) }
            refreshUsage(workspace: workspace)
            await workspace.catalog.loadStatuses(api, ids: Array(visible.union(workspace.catalog.syncIDs)).sorted())
        } catch is CancellationError {
        } catch {
            guard generation == stamp else { return }
            if (error as? URLError)?.code == .cancelled { return }
            if (error as? APIError)?.code == "SYNC_REMOVED" { trail = []; return }
            loadError = error.localizedDescription
        }
    }

    // MARK: Derived listing

    func itemLocation(_ item: DriveItem, workspace: Workspace) -> DriveLocation {
        if item.backupRootId != nil || workspace.catalog.backupFolderIDs[item.id] != nil { return .backup }
        if !workspace.query.isEmpty && !(scope == "folder" && inFolder) { return searchLocations[item.id] ?? .cloud }
        if inFolder { return location }
        return workspace.catalog.syncIDs.contains(item.id) ? .sync : .cloud
    }
    /// The visible files: this location's items, filtered and sorted.
    func entries(workspace: Workspace) -> [DriveItem] {
        let query = workspace.query.trimmingCharacters(in: .whitespacesAndNewlines)
        var merged = items
        if !inFolder && query.isEmpty {
            let known = Set(merged.map(\.id))
            merged += workspace.catalog.syncFolders.filter { !known.contains($0.id) }
        }
        if inPlace && query.isEmpty {
            // A place lists devices; a device lists its folders in that place.
            guard let place, let device = placeDevice else { return [] }
            return filters.apply(devices(in: place, workspace: workspace).first { $0.id == device.id }?.folders ?? [])
        }
        if !query.isEmpty && scope == "folder" && inFolder {
            merged = merged.filter { $0.name.localizedCaseInsensitiveContains(query) }
        }
        return filters.apply(merged.filter { itemLocation($0, workspace: workspace) == location })
    }

    // MARK: Places

    /// The folder ids a place holds (synced folders, or backup roots in the place's states).
    func folderIDs(in place: DrivePlace, workspace: Workspace) -> [String] {
        place == .synced ? workspace.catalog.syncFolders.map(\.id)
            : workspace.catalog.backups.filter { place.backupStates.contains($0.state) }.map(\.remoteRootDriveItemId)
    }
    func usage<S: Sequence>(_ ids: S, workspace: Workspace) -> UsageTotal? where S.Element == String {
        UsageTotal.sum(ids, usage: workspace.catalog.usage)
    }
    /// Usage is shown at the root's places and anywhere inside a place.
    var showsUsage: Bool { place != nil }
    /// Fetches usage for what is on screen without holding up the listing.
    private func refreshUsage(workspace: Workspace) {
        let root = showsPlaces(workspace: workspace)
        guard root || place != nil else { return }
        var ids = DrivePlace.allCases.flatMap { folderIDs(in: $0, workspace: workspace) }
        if inFolder, let parentID {
            ids.append(parentID)
            ids += entries(workspace: workspace).filter(\.isFolder).map(\.id)
        }
        let api = workspace.api, catalog = workspace.catalog
        Task { await catalog.loadUsage(api, ids: ids) }
    }

    /// Whether a place's folders have loaded, and why they could not.
    func placeLoaded(_ place: DrivePlace, workspace: Workspace) -> Bool {
        place == .synced ? workspace.catalog.haveSync : workspace.catalog.haveBackups
    }
    func placeError(_ place: DrivePlace, workspace: Workspace) -> String? {
        place == .synced ? workspace.catalog.syncError : workspace.catalog.backupError
    }
    /// Computers and phones (never web browsers or revoked devices) with at least one folder in a place,
    /// in device-list order; folders no listed device owns are grouped under pseudo-devices (web lib/devices.ts).
    func devices(in place: DrivePlace, workspace: Workspace) -> [PlaceDevice] {
        let catalog = workspace.catalog
        let listed = catalog.haveDevices ? catalog.devices.filter { $0.platform != "WEB" && $0.status != "REVOKED" && $0.revokedAt == nil } : nil
        var groups: [PlaceDevice] = []
        var folders: [String: [DriveItem]] = [:]
        var pseudo: [(id: String, name: String)] = []
        func add(_ id: String, _ folder: DriveItem) {
            if folders[id]?.contains(where: { $0.id == folder.id }) == true { return }
            folders[id, default: []].append(folder)
        }
        func addPseudo(_ name: String, _ folder: DriveItem) {
            let id = "name:" + name
            if !pseudo.contains(where: { $0.id == id }) { pseudo.append((id, name)) }
            add(id, folder)
        }
        if place == .synced {
            // A sync folder belongs to every device in its syncDevices list.
            for folder in catalog.syncFolders {
                let refs = (folder.syncDevices ?? []).filter { ref in listed?.contains { $0.id == ref.id } ?? true }
                if refs.isEmpty { addPseudo("Other", folder) }
                for ref in refs {
                    if listed == nil && !pseudo.contains(where: { $0.id == ref.id }) { pseudo.append((ref.id, ref.name)) }
                    add(ref.id, folder)
                }
            }
        } else {
            // A backup root belongs to the device that created it: key fingerprint first, then session id or name.
            for root in catalog.backups where place.backupStates.contains(root.state) {
                let owner = (listed ?? []).first { device in
                    if let mine = root.devicePublicId, let theirs = device.devicePublicId { return mine == theirs }
                    return root.deviceId == device.id || (root.deviceName != nil && root.deviceName == device.name)
                }
                if let owner { add(owner.id, root.folder) } else { addPseudo(root.deviceName ?? "Other device", root.folder) }
            }
        }
        for device in listed ?? [] {
            guard let items = folders[device.id], !items.isEmpty else { continue }
            groups.append(PlaceDevice(id: device.id, name: device.name, platform: device.platformName,
                                      icon: device.isPhone ? .smartphone : .laptop, folders: items))
        }
        for entry in pseudo {
            guard let items = folders[entry.id], !items.isEmpty else { continue }
            groups.append(PlaceDevice(id: entry.id, name: entry.name, icon: entry.id == "name:Other" ? .folder : .laptop, folders: items))
        }
        return groups
    }

    // MARK: Rules (canModify / canTrash / canWriteHere)

    func catalogError(_ workspace: Workspace) -> Bool { workspace.catalog.backupError != nil && !workspace.catalog.haveBackups }
    func canModify(_ item: DriveItem, workspace: Workspace) -> Bool {
        item.backupRootId == nil && !catalogError(workspace) && itemLocation(item, workspace: workspace) != .backup
    }
    func isSyncFolder(_ item: DriveItem, workspace: Workspace) -> Bool { item.isFolder && workspace.catalog.syncIDs.contains(item.id) }
    func canTrash(_ item: DriveItem, workspace: Workspace) -> Bool {
        canModify(item, workspace: workspace) && (!item.isFolder || (!workspace.catalog.syncIDs.contains(item.id) && workspace.catalog.syncError == nil))
    }
    func canWriteHere(_ workspace: Workspace) -> Bool {
        !loading && loadError == nil && !catalogError(workspace) && location != .backup && (location == .cloud || inFolder)
    }
    func cloudState(_ item: DriveItem, workspace: Workspace) -> String? {
        workspace.catalog.statuses[item.id]?.cloudState ?? item.cloudState
    }
    func syncLabel(_ item: DriveItem, workspace: Workspace) -> (String, Tone)? {
        guard let status = workspace.catalog.statuses[item.id] else { return nil }
        switch status.state {
        case "SYNCED": return ("Synced", .success)
        case "SYNCING": return ("Syncing", .accent)
        case "PENDING": return ("Pending", .neutral)
        default: return ("Status unavailable", .neutral)
        }
    }

    // MARK: Actions

    private func run(_ workspace: Workspace, reload: Bool = true, _ action: () async throws -> String?) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            let message = try await action()
            if reload { await load(workspace: workspace, silent: true); workspace.changed(); await workspace.refreshAccount() }
            if let message { workspace.notify(message, status: .info) }
            return true
        } catch {
            workspace.fail(error)
            if reload { await load(workspace: workspace, silent: true) }
            return false
        }
    }
    static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }
    static func revision(_ item: DriveItem) throws -> Int {
        guard let revision = item.revision, revision > 0 else { throw APIError(status: 0, message: "Refresh this list before changing the file.") }
        return revision
    }
    private static func names(_ items: [DriveItem]) -> String { items.count == 1 ? "“\(items[0].name)”" : "\(items.count) items" }
    static func recipient(_ value: String) -> [String: String] {
        let text = value.trimmingCharacters(in: .whitespaces)
        return ["type": text.contains("@") && !text.hasPrefix("@") ? "EMAIL" : "USERNAME",
                "value": text.hasPrefix("@") ? String(text.dropFirst()) : text]
    }

    func createFolder(_ name: String, workspace: Workspace) async -> Bool {
        filters = DriveFilters()
        if !workspace.query.isEmpty { workspace.query = "" }
        return await run(workspace) {
            let item = try await workspace.api.createFolder(name: name, parentID: parentID)
            selected = [item.id]
            return "Folder created."
        }
    }
    func rename(_ item: DriveItem, to name: String, workspace: Workspace) async -> Bool {
        await run(workspace) {
            let _: ItemResponse = try await workspace.api.request("/v1/drive/items/\(item.id)", method: "PATCH",
                body: ["operationId": UUID().uuidString, "baseRevision": try Self.revision(item), "name": name])
            selected = []
            return nil
        }
    }
    func move(_ targets: [DriveItem], to destination: Crumb?, workspace: Workspace) async -> Bool {
        await run(workspace) {
            for item in targets {
                let _: ItemResponse = try await workspace.api.request("/v1/drive/items/\(item.id)/move", method: "POST",
                    body: ["operationId": UUID().uuidString, "baseRevision": try Self.revision(item), "parentId": destination?.id as Any? ?? NSNull()])
            }
            selected = []
            return "Moved \(Self.names(targets)) to \(destination?.name ?? "My Drive")."
        }
    }
    func trash(_ targets: [DriveItem], workspace: Workspace) async -> Bool {
        await run(workspace) {
            for item in targets { try await workspace.api.changeTrash(item, action: .trash) }
            selected = []
            return "Moved \(Self.names(targets)) to trash."
        }
    }
    func favorite(_ targets: [DriveItem], workspace: Workspace) async {
        _ = await run(workspace) {
            for item in targets {
                let _: EmptyResponse = try await workspace.api.request("/v1/drive/items/\(item.id)/favorite", method: item.favorite == true ? "DELETE" : "PUT",
                    body: ["operationId": UUID().uuidString, "baseRevision": try Self.revision(item)])
            }
            return nil
        }
    }
    func send(_ targets: [DriveItem], to recipient: String, workspace: Workspace) async -> Bool {
        await run(workspace) {
            let _: EmptyResponse = try await workspace.api.request("/v1/transfers", method: "POST", body: [
                "operationId": UUID().uuidString, "recipient": Self.recipient(recipient),
                "items": targets.map { ["driveItemId": $0.id] }])
            selected = []
            return "Sent \(Self.names(targets)). Track it in Shared → Sent."
        }
    }
    func share(_ item: DriveItem, to recipient: String, permission: String, workspace: Workspace) async -> Bool {
        await run(workspace, reload: false) {
            let _: EmptyResponse = try await workspace.api.request("/v1/shares", method: "POST", body: [
                "operationId": UUID().uuidString, "recipient": Self.recipient(recipient), "driveItemId": item.id, "permission": permission])
            return "Access shared."
        }
    }
    func removeSync(_ targets: [DriveItem], workspace: Workspace) async -> Bool {
        await run(workspace) {
            for item in targets { let _: EmptyResponse = try await workspace.api.request("/v1/sync/folders/\(item.id)", method: "DELETE") }
            selected = []
            items.removeAll { item in targets.contains { $0.id == item.id } }
            await workspace.catalog.loadSync(workspace.api)
            return "Folder removed from sync. Local files are preserved on every device."
        }
    }
    func disconnectBackup(_ item: DriveItem, workspace: Workspace) async -> Bool {
        let rootID = item.backupRootId ?? workspace.catalog.backupFolderIDs[item.id]
        let done = await run(workspace) {
            guard let rootID else { throw APIError(status: 0, message: "This backup is no longer connected.") }
            let _: EmptyResponse = try await workspace.api.request("/v1/backups/\(rootID)", method: "DELETE")
            await workspace.catalog.loadBackups(workspace.api)
            return "Backup disconnected. Its folder and versions are now in Cloud."
        }
        if done { changeTab(.cloud, workspace: workspace); await load(workspace: workspace) }
        return done
    }
    func requestCopy(_ item: DriveItem, workspace: Workspace) async {
        _ = await run(workspace) {
            let _: EmptyResponse = try await workspace.api.request("/v1/sync/items/\(item.id)/request-content", method: "POST")
            return "Requested a copy of “\(item.name)”. It will be available when a linked device is online."
        }
    }
    func restoreVersion(_ item: DriveItem, _ version: FileVersion, workspace: Workspace) async -> Bool {
        await run(workspace) {
            let _: EmptyResponse = try await workspace.api.request("/v1/drive/items/\(item.id)/versions/\(version.id)/restore", method: "POST",
                body: ["operationId": UUID().uuidString, "baseRevision": try Self.revision(item)])
            return "Restored version \(version.versionNumber) of \(item.name)."
        }
    }
    func restoreLocally(_ item: DriveItem, _ version: FileVersion, workspace: Workspace) async -> Bool {
        let rootID = item.backupRootId ?? trail.first.flatMap { workspace.catalog.backupFolderIDs[$0.id] }
        return await run(workspace, reload: false) {
            guard let rootID else { throw APIError(status: 0, message: "This backup is no longer connected.") }
            let _: EmptyResponse = try await workspace.api.request("/v1/backups/\(rootID)/restores", method: "POST",
                body: ["id": UUID().uuidString, "itemId": item.id, "versionId": version.id])
            return "Local restore requested. Track progress in Backups → History."
        }
    }
}
