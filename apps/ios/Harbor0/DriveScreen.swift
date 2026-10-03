import SwiftUI
import UniformTypeIdentifiers

enum DriveSheet: Identifiable {
    case newMenu, sortMenu, selectionMenu, newFolder
    case itemMenu(DriveItem)
    case rename(DriveItem), share(DriveItem), details(DriveItem), versions(DriveItem), disconnect(DriveItem)
    case move([DriveItem]), send([DriveItem]), trash([DriveItem]), removeSync([DriveItem])
    case restoreLocal(DriveItem, FileVersion)
    var id: String {
        switch self {
        case .newMenu: "new"
        case .sortMenu: "sort"
        case .selectionMenu: "selection"
        case .newFolder: "folder"
        case .itemMenu(let item): "menu-" + item.id
        case .rename(let item): "rename-" + item.id
        case .share(let item): "share-" + item.id
        case .details(let item): "details-" + item.id
        case .versions(let item): "versions-" + item.id
        case .disconnect(let item): "disconnect-" + item.id
        case .move(let items): "move-" + items.map(\.id).joined()
        case .send(let items): "send-" + items.map(\.id).joined()
        case .trash(let items): "trash-" + items.map(\.id).joined()
        case .removeSync(let items): "sync-" + items.map(\.id).joined()
        case .restoreLocal(let item, let version): "restore-" + item.id + version.id
        }
    }
}

/// My Drive (drive-workspace.tsx at phone size). The root pins three places, Synced Folders, Backups and
/// Archives: devices, then each device's folders there (web components/device-folders.tsx).
struct DriveScreen: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @EnvironmentObject private var catalog: WorkspaceCatalog
    @EnvironmentObject private var sync: SyncCenter
    @ObservedObject var model: DriveModel
    @Environment(\.tokens) private var tokens
    @Environment(\.scenePhase) private var scenePhase
    @State private var syncSetup: SyncSetupRequest?
    @State private var sheet: DriveSheet?
    @State private var next: DriveSheet?
    @State private var importer: UTType?
    @State private var importing = false

    private var query: String { workspace.query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var files: [DriveItem] { model.entries(workspace: workspace) }
    private var selection: [DriveItem] { files.filter { model.selected.contains($0.id) } }
    private var canWrite: Bool { model.canWriteHere(workspace) }
    /// A place's device list (My Drive › Synced Folders, Backups or Archives).
    private var deviceList: Bool { model.inPlace && model.placeDevice == nil && query.isEmpty }
    private func devices(in place: DrivePlace) -> [PlaceDevice] { model.devices(in: place, workspace: workspace) }
    private var reloadKey: String { [model.parentID ?? "root", query, model.scope, model.location.rawValue, "\(transfers.revision)", "\(workspace.revision)"].joined(separator: "|") }

    var body: some View {
        PageScroll(bottom: 104) {
            VStack(alignment: .leading, spacing: 12) {
                PageTitle(text: query.isEmpty ? "My Drive" : "Search results")
                if model.inFolder || model.place != nil { breadcrumbs }
                if !query.isEmpty { searchScope }
                if let storage = workspace.account?.storage, storage.quotaBytes > 0,
                   Double(storage.usedBytes + storage.reservedBytes) / Double(storage.quotaBytes) >= 0.9 {
                    AlertBanner(tone: .warning, text: "\(Format.size(storage.usedBytes)) of \(Format.size(storage.quotaBytes)) used. You’re running low on storage.",
                                actionLabel: "Manage storage") { workspace.navigate(.storage) }
                }
                if let error = model.loadError, !files.isEmpty { AlertBanner(tone: .danger, text: error) }
                toolbar
                if deviceList && model.place == .synced { syncBanner }
                if model.location == .sync, catalog.syncError != nil {
                    AlertBanner(tone: .warning, text: "Sync folders could not be loaded.", actionLabel: "Retry") { Task { await model.load(workspace: workspace) } }
                }
                if catalog.statusError != nil, !files.isEmpty {
                    Text("Sync status is temporarily unavailable.").font(TypeScale.sm).foregroundStyle(tokens.text2)
                }
                content
            }
        }
        .refreshable { await model.load(workspace: workspace, silent: true) }
        .sheet(item: $syncSetup) { request in SyncSetupSheet(request: request).environment(\.tokens, tokens) }
        .overlay(alignment: .bottom) { floating }
        .task(id: reloadKey) {
            await model.load(workspace: workspace)
            // Keep changes from other devices current without a loading state (web polls every 15s).
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled, scenePhase == .active else { continue }
                await model.load(workspace: workspace, silent: true)
            }
        }
        .sheet(item: $sheet, onDismiss: presentNext) { sheet in
            sheetView(sheet).environment(\.tokens, tokens)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: importer == .folder ? [.folder] : [.item],
                      allowsMultipleSelection: importer != .folder) { result in
            switch result {
            case .success(let urls):
                if importer == .folder, let folder = urls.first { transfers.uploadFolder(folder, parentID: model.parentID) }
                else if !urls.isEmpty { transfers.upload(urls, parentID: model.parentID) }
            case .failure(let failure): workspace.fail(failure)
            }
        }
    }

    // MARK: Header pieces

    private var breadcrumbs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                crumb("My Drive", current: false) { model.go(to: nil) }
                if let place = model.place {
                    Icon(.chevronRight, size: 14).foregroundStyle(tokens.text3)
                    crumb(place.rawValue, current: deviceList) { model.open(place: place, workspace: workspace) }
                    if let device = model.placeDevice {
                        Icon(.chevronRight, size: 14).foregroundStyle(tokens.text3)
                        crumb(device.name, current: !model.inFolder) { model.go(to: -1) }
                    }
                }
                ForEach(Array(model.trail.enumerated()), id: \.element.id) { index, entry in
                    Icon(.chevronRight, size: 14).foregroundStyle(tokens.text3)
                    crumb(entry.name, current: index == model.trail.count - 1) { model.go(to: index) }
                }
                if model.trailError {
                    Button("Retry folder path") { model.go(to: model.trail.count - 1) }.harborButton(.link).font(TypeScale.sm)
                }
            }
        }
        .accessibilityIdentifier("breadcrumbs")
    }
    private func crumb(_ name: String, current: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(name).font(current ? TypeScale.smMedium : TypeScale.sm)
                .foregroundStyle(current ? tokens.text : tokens.text2)
                .padding(.horizontal, 6).padding(.vertical, 4)
        }.buttonStyle(.plain).accessibilityIdentifier("crumb-" + name)
    }
    private var searchScope: some View {
        HStack(spacing: 8) {
            Text("Results for “\(query)”").font(TypeScale.sm).foregroundStyle(tokens.text2).lineLimit(1)
            Spacer(minLength: 4)
            if model.inFolder {
                Menu {
                    Picker("Search scope", selection: $model.scope) {
                        Text("Search all files").tag("all")
                        Text("Search this folder").tag("folder")
                    }
                } label: { Chip(label: model.scope == "folder" ? "Search this folder" : "Search all files") }
            }
            Button { workspace.query = "" } label: { Icon(.x, size: 16) }.harborButton(.ghost, size: .icon)
                .accessibilityLabel("Clear search")
        }
    }
    @ViewBuilder private var toolbar: some View {
        if deviceList, let place = model.place {
            Text(model.placeLoaded(place, workspace: workspace) ? Format.count(devices(in: place).count, "device") : "Loading…")
                .font(TypeScale.base).foregroundStyle(tokens.text2).frame(minHeight: 40).accessibilityIdentifier("itemCount")
        } else if !selection.isEmpty {
            HStack {
                Text("\(selection.count) selected").font(TypeScale.baseMedium.weight(.semibold))
                Spacer()
                Button { model.selected = [] } label: { Icon(.x, size: 18) }
                    .harborButton(.ghost, size: .icon).accessibilityLabel("Clear selection").accessibilityIdentifier("clearSelection")
            }.frame(minHeight: 40)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(model.loading ? "Loading…" : "\(files.count)\(model.nextCursor != nil ? "+" : "") \(files.count == 1 ? "item" : "items")")
                        .font(TypeScale.base).foregroundStyle(tokens.text2).accessibilityIdentifier("itemCount")
                    // Inside a place: the current folder's total storage.
                    if model.showsUsage, model.inFolder, let id = model.parentID, let total = model.usage([id], workspace: workspace) {
                        Text("· " + total.label).font(TypeScale.base).foregroundStyle(tokens.text2).lineLimit(1)
                            .accessibilityIdentifier("folderUsage")
                    }
                    Spacer()
                    ViewSwitch(grid: $model.grid)
                }
                filterChips
            }
        }
    }
    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Menu {
                    Picker("Filter by type", selection: $model.filters.type) {
                        ForEach(DriveFilters.types, id: \.0) { Text($0.1).tag($0.0) }
                    }
                } label: { Chip(label: DriveFilters.types.first { $0.0 == model.filters.type }?.1 ?? "Type", active: model.filters.type != "all") }
                    .accessibilityIdentifier("filterType")
                Menu {
                    Picker("Filter by modified date", selection: $model.filters.modified) {
                        ForEach(DriveFilters.modifiedOptions, id: \.0) { Text($0.1).tag($0.0) }
                    }
                } label: { Chip(label: DriveFilters.modifiedOptions.first { $0.0 == model.filters.modified }?.1 ?? "Modified", active: model.filters.modified != "all") }
                    .accessibilityIdentifier("filterModified")
                Button { sheet = .sortMenu } label: {
                    Chip(label: "Sort: " + (DriveFilters.sorts.first { $0.0 == model.filters.sort }?.1 ?? ""))
                }.buttonStyle(.plain).accessibilityIdentifier("sort")
                if model.filters.active {
                    Button("Clear filters") { model.selected = []; model.filters.type = "all"; model.filters.modified = "all" }
                        .harborButton(.ghost, size: .sm)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 2)
        }
        .padding(.horizontal, -16)
        .onChange(of: model.filters) { _, _ in model.selected = [] }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if model.showsPlaces(workspace: workspace) && !model.loading {
            ForEach(DrivePlace.allCases) { place in
                PlaceRow(place: place, devices: devices(in: place).count,
                         size: model.usage(model.folderIDs(in: place, workspace: workspace), workspace: workspace)) {
                    model.open(place: place, workspace: workspace)
                }
            }
        }
        if deviceList, let place = model.place {
            placeDevices(place)
        } else if model.loading {
            SkeletonRows()
        } else if (model.loadError != nil || (model.location == .sync && catalog.syncError != nil)) && files.isEmpty {
            LoadErrorView(title: "We couldn’t load these files.") { Task { await model.load(workspace: workspace) } }
        } else if files.isEmpty {
            emptyState
        } else {
            if model.grid { grid } else { list }
            if model.grid {
                Button("Select all files") { model.selected = Set(files.map(\.id)) }.harborButton(.link).font(TypeScale.sm)
            }
        }
        if model.nextCursor != nil && !model.loading && !model.inPlace {
            Button(model.refreshing ? "Loading more files…" : model.loadError != nil ? "Retry loading more files" : "Load more files") {
                Task { await model.load(workspace: workspace, more: true) }
            }
            .harborButton(.outline).disabled(model.refreshing).frame(maxWidth: .infinity)
            .accessibilityIdentifier("loadMore")
        }
    }
    private var emptyState: some View {
        let filtered = !query.isEmpty || model.filters.active
        let title = filtered ? "No matching files"
            : !model.inFolder && model.place == .archives ? "No archived folders"
            : model.location == .backup && !model.inFolder ? "No backup folders"
            : model.location == .sync && !model.inFolder ? "No synced folders"
            : model.inFolder ? "This folder is empty" : "No files yet"
        let description = filtered ? "Try a different search or reset your filters."
            : model.location == .backup ? (model.inFolder ? "Files appear here after their first backup." : "This device’s \(model.place?.noun ?? "backup folder")s will appear here.")
            : model.location == .sync ? (model.inFolder ? "Files will appear here when this folder syncs." : "Folders this device keeps in sync will appear here.")
            : "Upload files or create a folder to get started."
        return EmptyStateView(icon: .folder, title: title, description: description) {
            if filtered {
                Button("Clear search and filters") { model.filters = DriveFilters(); workspace.query = "" }.harborButton(.outline)
            } else if canWrite {
                Button("Upload files") { pick(.item) }.harborButton(.primary).disabled(model.busy)
                Button("New folder") { sheet = .newFolder }.harborButton(.outline).disabled(model.busy)
            }
        }
    }
    /// A place's devices: computers and phones with folders there. Virtual entries: no selection or actions.
    @ViewBuilder private func placeDevices(_ place: DrivePlace) -> some View {
        let groups = devices(in: place)
        let error = model.placeError(place, workspace: workspace)
        if !model.placeLoaded(place, workspace: workspace) && error == nil {
            SkeletonRows()
        } else if groups.isEmpty && error != nil {
            LoadErrorView(title: "We couldn’t load these folders.") { Task { await model.load(workspace: workspace) } }
        } else if groups.isEmpty {
            switch place {
            case .synced:
                EmptyStateView(icon: .laptop, title: "No synced folders",
                               description: "Folders you sync on your computers and phones are kept in the cloud and appear here.") {
                    Button("Sync a folder to this iPhone") { workspace.navigate(.sync) }.harborButton(.outline)
                }
            case .backups:
                EmptyStateView(icon: .laptop, title: "No backup folders",
                               description: "Folders you back up from your computers and phones appear here.") {
                    Button("Back up a folder") { workspace.navigate(.backups) }.harborButton(.outline)
                }
            case .archives:
                EmptyStateView(icon: .archive, title: "No archived folders",
                               description: "Backup folders you archive stay in the cloud and appear here.")
            }
        } else {
            VStack(spacing: 0) {
                ForEach(groups) { group in
                    VirtualFolderRow(icon: group.icon, title: group.name,
                                     detail: ([group.platform, Format.count(group.folders.count, place.noun),
                                               model.usage(group.folders.map(\.id), workspace: workspace)?.label]).compactMap { $0 }.joined(separator: " · "),
                                     identifier: "placeDevice-" + group.name) {
                        model.open(place: place, device: Crumb(id: group.id, name: group.name), workspace: workspace)
                    }
                }
            }
        }
    }
    private var list: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Button {
                    let all = Set(files.map(\.id))
                    model.selected = model.selected.isSuperset(of: all) ? [] : all
                } label: {
                    CheckBox(checked: !files.isEmpty && model.selected.isSuperset(of: Set(files.map(\.id))),
                             mixed: !model.selected.isDisjoint(with: Set(files.map(\.id))))
                        .frame(width: 32, height: 40).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Select all files on this page").accessibilityIdentifier("selectAll")
                Text("Name").font(TypeScale.smMedium).foregroundStyle(tokens.text2)
                Spacer()
            }
            .frame(height: 40)
            Hairline()
            ForEach(files) { item in
                FileRowView(item: item, selected: model.selected.contains(item.id), selecting: !model.selected.isEmpty,
                            status: model.syncLabel(item, workspace: workspace),
                            detail: detail(item),
                            showsActions: !(model.location == .sync && !model.inFolder && !model.canModify(item, workspace: workspace)),
                            toggle: { toggle(item) }, open: { open(item) }, actions: { sheet = .itemMenu(item) })
            }
        }
    }
    private var grid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(files) { item in
                FileGridCard(item: item, selected: model.selected.contains(item.id), selecting: !model.selected.isEmpty,
                             status: model.syncLabel(item, workspace: workspace), detail: detail(item),
                             toggle: { toggle(item) }, open: { open(item) }, actions: { sheet = .itemMenu(item) })
            }
        }
    }
    private func detail(_ item: DriveItem) -> String? {
        // Folders inside a place show their storage where files show their size.
        if item.isFolder && model.showsUsage, let total = model.usage([item.id], workspace: workspace) {
            return total.short + " · " + Format.date(item.deletedAt ?? item.updatedAt)
        }
        switch model.cloudState(item, workspace: workspace) {
        case "RELEASED" where !item.isFolder: return "On your computer · Request a copy"
        case "REQUESTED" where !item.isFolder: return "Waiting for your computer"
        default: return nil
        }
    }

    // MARK: Floating FAB and selection dock

    @ViewBuilder private var floating: some View {
        if !selection.isEmpty {
            selectionDock.padding(.horizontal, 10).padding(.bottom, 10)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if canWrite && !model.busy {
            HStack {
                Spacer()
                Button { sheet = .newMenu } label: {
                    Icon(.plus, size: 24).foregroundStyle(tokens.onPrimary)
                        .frame(width: 56, height: 56)
                        .background(tokens.primary, in: RoundedRectangle(cornerRadius: 18))
                        .shadow(color: tokens.palette.primary.opacity(0.55).color, radius: 12, y: 8)
                        .shadow(color: Color.black.opacity(0.16), radius: 3, y: 2)
                }
                .buttonStyle(.plain).accessibilityLabel("New").accessibilityIdentifier("newMenu")
            }
            .padding(.trailing, 16).padding(.bottom, 16)
        }
    }
    private var selectionDock: some View {
        let all = selection
        let modifiable = all.allSatisfy { model.canModify($0, workspace: workspace) }
        let hasSync = all.contains { model.isSyncFolder($0, workspace: workspace) }
        let canTrash = all.allSatisfy { model.canTrash($0, workspace: workspace) }
        return HStack(spacing: 0) {
            dockButton("Download", .download) { download(all) }
            if modifiable {
                dockButton("Send", .send) { sheet = .send(all) }
                if !hasSync { dockButton("Move", .folderInput) { sheet = .move(all) } }
            }
            if canTrash { dockButton("Move to trash", .trash) { sheet = .trash(all) } }
            Button { sheet = .selectionMenu } label: {
                Icon(.ellipsis, size: 20).frame(width: 48, height: 52).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(tokens.text2).accessibilityLabel("More selection actions")
        }
        .disabled(model.busy)
        .padding(6)
        .background(tokens.background, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(tokens.line, lineWidth: 1))
        .shadow(color: tokens.shadow, radius: 16, y: 8)
        .accessibilityIdentifier("selectionDock")
    }
    private func dockButton(_ label: String, _ icon: Lucide, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Icon(icon, size: 20)
                Text(label).font(TypeScale.tab).lineLimit(1).truncationMode(.tail)
            }
            .frame(maxWidth: .infinity).frame(height: 52).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle()).foregroundStyle(tokens.text2)
        .accessibilityLabel(label).accessibilityIdentifier("dock-" + label)
    }

    /// This iPhone's sync status above the Sync folders, with a link to manage them.
    private var syncBanner: some View {
        let label = SyncLabels.global(sync.snapshot)
        let count = sync.syncFolders.count
        return Button { workspace.navigate(.sync) } label: {
            HStack(spacing: 12) {
                IconTile(icon: .smartphone, active: count > 0)
                VStack(alignment: .leading, spacing: 1) {
                    Text("This iPhone").font(TypeScale.smMedium.weight(.semibold)).foregroundStyle(tokens.text)
                    Text(count == 0 ? "Sync a folder to keep its files on this iPhone." : "\(Format.count(count, "folder")) sync here")
                        .font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1)
                }
                Spacer(minLength: 8)
                if count > 0 { Badge(text: label, tone: SyncLabels.tone(label), icon: SyncLabels.icon(label), spinning: SyncLabels.icon(label) == .loaderCircle) }
                Icon(.chevronRight, size: 16).foregroundStyle(tokens.text3)
            }
            .padding(.horizontal, 12).padding(.vertical, 10).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .modifier(CardChrome())
        .accessibilityIdentifier("syncBanner")
    }

    // MARK: Actions

    private func toggle(_ item: DriveItem) {
        if model.selected.contains(item.id) { model.selected.remove(item.id) } else { model.selected.insert(item.id) }
    }
    private func open(_ item: DriveItem) {
        if !model.selected.isEmpty { toggle(item); return }
        if item.isFolder { model.open(folder: item, workspace: workspace); return }
        if let state = model.cloudState(item, workspace: workspace), state != "AVAILABLE" {
            workspace.notify("This file is stored on your linked devices. Sync its folder to this iPhone, or request a copy, to open it here.", status: .info)
            return
        }
        transfers.open(item)
    }
    private func download(_ targets: [DriveItem]) {
        if targets.contains(where: { !$0.isFolder && (model.cloudState($0, workspace: workspace) ?? "AVAILABLE") != "AVAILABLE" }) {
            workspace.error = "This file is stored on linked devices. Open its local copy in the desktop app."
            return
        }
        let folders = targets.filter(\.isFolder), fileItems = targets.filter { !$0.isFolder }
        if !fileItems.isEmpty { transfers.save(fileItems) }
        if let folder = folders.first { transfers.downloadFolder(folder) }
    }
    private func pick(_ type: UTType) {
        importer = type
        importing = true
    }
    /// Shows another sheet once the current one has gone, or the file picker.
    private func then(_ action: DriveSheet?) {
        next = action
        sheet = nil
    }
    private func thenPick(_ type: UTType) {
        importer = type
        next = nil
        sheet = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { importing = true }
    }
    private func presentNext() {
        if let next { self.next = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { sheet = next } }
    }

    // MARK: Sheets

    @ViewBuilder private func sheetView(_ current: DriveSheet) -> some View {
        switch current {
        case .newMenu:
            SheetMenu {
                MenuRow(title: "Upload files", icon: .arrowUpFromLine) { thenPick(.item) }
                MenuRow(title: "Upload a folder", icon: .folderUp) { thenPick(.folder) }
                MenuSeparator()
                MenuRow(title: "New folder", icon: .folderPlus) { then(.newFolder) }
            }
        case .sortMenu:
            SheetMenu(title: "Sort") {
                ForEach(DriveFilters.sorts, id: \.0) { option in
                    MenuRow(title: option.1, checked: model.filters.sort == option.0) { model.filters.sort = option.0; sheet = nil }
                }
                MenuSeparator()
                MenuRow(title: "Folders first", checked: model.filters.foldersFirst) { model.filters.foldersFirst.toggle() }
                MenuRow(title: "Show system files", checked: model.filters.showSystem) { model.filters.showSystem.toggle() }
            }
        case .selectionMenu:
            let all = selection
            let modifiable = all.allSatisfy { model.canModify($0, workspace: workspace) }
            SheetMenu {
                if !all.contains(where: { model.isSyncFolder($0, workspace: workspace) }) {
                    MenuRow(title: "Toggle favorites", icon: .star, disabled: !modifiable) {
                        sheet = nil; Task { await model.favorite(all, workspace: workspace) }
                    }
                }
                if all.count == 1 {
                    MenuRow(title: "Rename", icon: .pencil, disabled: !modifiable) { then(.rename(all[0])) }
                    MenuRow(title: "View details", icon: .info) { then(.details(all[0])) }
                }
            }
        case .newFolder:
            NameSheet(title: "Create a folder", label: "Name", initial: "", confirm: "Create", selectBase: false) { name in
                await model.createFolder(name, workspace: workspace)
            }
        case .itemMenu(let item):
            itemMenu(item)
        case .rename(let item):
            NameSheet(title: "Rename \(item.name)", label: "Name", initial: item.name, confirm: "Save", selectBase: !item.isFolder) { name in
                await model.rename(item, to: name, workspace: workspace)
            }
        case .send(let items):
            RecipientSheet(title: "Send \(items.count == 1 ? items[0].name : "\(items.count) items")",
                           description: "Send a copy to a person. They must sign in to receive it.",
                           hint: "New recipients can verify their email and find the transfer after signup.", confirm: "Send", permission: false) { recipient, _ in
                await model.send(items, to: recipient, workspace: workspace)
            }
        case .share(let item):
            RecipientSheet(title: "Share \(item.name)", description: "Give a registered person access to the original files.",
                           hint: nil, confirm: "Share", permission: true) { recipient, permission in
                await model.share(item, to: recipient, permission: permission, workspace: workspace)
            }
        case .move(let items):
            MoveSheet(items: items) { destination in await model.move(items, to: destination, workspace: workspace) }
        case .trash(let items):
            AsyncConfirm(title: "Move \(items.count == 1 ? items[0].name : "\(items.count) items") to trash?",
                         description: "You can restore \(items.count == 1 ? "this item" : "these items") from Trash.",
                         confirm: "Move to trash", danger: true) { await model.trash(items, workspace: workspace) }
        case .removeSync(let items):
            AsyncConfirm(title: "Remove “\(items[0].name)” from sync?",
                         description: "Stop syncing on all linked devices and remove this folder from the app. Local folders and files will stay where they are. Offline devices will stop syncing when they reconnect.",
                         confirm: "Remove from sync", danger: false) { await model.removeSync(items, workspace: workspace) }
        case .disconnect(let item):
            AsyncConfirm(title: "Disconnect backup?",
                         description: "Stop backing up this folder. All archived files and versions will remain in Cloud and become editable. Local files stay where they are.",
                         confirm: "Disconnect backup", danger: false) { await model.disconnectBackup(item, workspace: workspace) }
        case .details(let item):
            DetailsSheet(item: item) { then(nil); DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { open(item) } }
        case .versions(let item):
            VersionsSheet(item: item, backup: !model.canModify(item, workspace: workspace) && model.itemLocation(item, workspace: workspace) == .backup,
                          restore: { version in await model.restoreVersion(item, version, workspace: workspace) },
                          restoreLocally: { version in then(.restoreLocal(item, version)) })
        case .restoreLocal(let item, let version):
            AsyncConfirm(title: "Restore this local file?",
                         description: "Replace the current local copy of \(item.name) with the version saved \(Format.full(version.createdAt)). The archive will stay unchanged. The source computer must be online with backups running.",
                         confirm: "Restore locally", danger: false) { await model.restoreLocally(item, version, workspace: workspace) }
        }
    }

    @ViewBuilder private func itemMenu(_ item: DriveItem) -> some View {
        let modify = model.canModify(item, workspace: workspace)
        let syncFolder = model.isSyncFolder(item, workspace: workspace)
        let state = model.cloudState(item, workspace: workspace) ?? "AVAILABLE"
        let backupRoot = catalog.backups.contains { $0.remoteRootDriveItemId == item.id }
        SheetMenu {
            HStack(spacing: 12) {
                FileTile(kind: item.kind, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).font(TypeScale.name).lineLimit(1)
                    Text(Format.meta(item)).font(TypeScale.xs).foregroundStyle(tokens.text2)
                }
            }.padding(.horizontal, 12).padding(.bottom, 8)
            MenuSeparator()
            MenuRow(title: "Open") { then(nil); DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { open(item) } }
            MenuSeparator()
            if !item.isFolder && state == "RELEASED" {
                MenuRow(title: "Request a copy", disabled: model.busy) { sheet = nil; Task { await model.requestCopy(item, workspace: workspace) } }
            } else if !item.isFolder && state == "REQUESTED" {
                MenuRow(title: "Waiting for your computer", disabled: true) {}
            } else {
                MenuRow(title: item.isFolder ? "Download as ZIP" : "Download", disabled: model.busy || transfers.zip != nil) {
                    sheet = nil; download([item])
                }
            }
            if modify {
                MenuRow(title: "Send") { then(.send([item])) }
                MenuRow(title: "Share") { then(.share(item)) }
                MenuSeparator()
                MenuRow(title: "Rename") { then(.rename(item)) }
                if !syncFolder {
                    MenuRow(title: "Move") { then(.move([item])) }
                    MenuRow(title: item.favorite == true ? "Remove favorite" : "Add to favorites") {
                        sheet = nil; Task { await model.favorite([item], workspace: workspace) }
                    }
                }
            }
            MenuSeparator()
            MenuRow(title: "View details") { then(.details(item)) }
            if !item.isFolder { MenuRow(title: "Version history") { then(.versions(item)) } }
            if backupRoot || (modify && syncFolder) || model.canTrash(item, workspace: workspace) { MenuSeparator() }
            if backupRoot { MenuRow(title: "Disconnect backup") { then(.disconnect(item)) } }
            if syncFolder {
                if sync.folder(remoteId: item.id) != nil {
                    MenuRow(title: "Sync settings on this iPhone", icon: .smartphone) { sheet = nil; workspace.navigate(.sync) }
                } else {
                    MenuRow(title: "Sync to this iPhone", icon: .smartphone, disabled: !sync.ready) {
                        sheet = nil
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                            syncSetup = SyncSetupRequest(cloud: .existing(id: item.id, path: "My Drive / \(item.name)"), name: item.name)
                        }
                    }
                }
            }
            if modify && syncFolder { MenuRow(title: "Remove from sync", tone: .danger) { then(.removeSync([item])) } }
            if model.canTrash(item, workspace: workspace) { MenuRow(title: "Move to trash", tone: .danger) { then(.trash([item])) } }
        }
    }
}

// MARK: - Rows

/// A pinned My Drive place (Synced Folders, Backups, Archives). Not a drive item: no selection, rename, move or sharing.
struct PlaceRow: View {
    let place: DrivePlace
    let devices: Int
    /// Total storage of the place's folders; nil while it loads.
    var size: UsageTotal? = nil
    let open: () -> Void
    var body: some View {
        VirtualFolderRow(icon: place == .synced ? .refreshCw : place == .backups ? .hardDrive : .archive, title: place.rawValue,
                         detail: place.summary(devices: devices) + (size.map { " · " + $0.label } ?? ""),
                         identifier: "place-" + place.rawValue, action: open)
    }
}

/// A row for a virtual folder (a place or one of its devices): tile, name over detail, chevron.
struct VirtualFolderRow: View {
    let icon: Lucide
    let title: String
    let detail: String
    let identifier: String
    let action: () -> Void
    @Environment(\.tokens) private var tokens
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Icon(icon, size: 20).foregroundStyle(tokens.primary)
                    .frame(width: 40, height: 40)
                    .background(tokens.primary.opacity(0.13), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(TypeScale.name).foregroundStyle(tokens.text).lineLimit(1).truncationMode(.middle)
                    Text(detail).font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1)
                }
                Spacer(minLength: 0)
                Icon(.chevronRight, size: 16).foregroundStyle(tokens.text3)
            }
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .overlay(alignment: .bottom) { Hairline() }
        .accessibilityIdentifier(identifier)
    }
}

/// A 64pt phone file row: checkbox, kind tile, name over size · date, favorite, sync status, ⋯.
struct FileRowView: View {
    let item: DriveItem
    var selected = false
    var selecting = false
    var status: (String, Tone)? = nil
    var detail: String? = nil
    var showsActions = true
    var trashIcon = false
    var showsCheckbox = true
    var toggle: () -> Void = {}
    let open: () -> Void
    var actions: (() -> Void)? = nil
    @Environment(\.tokens) private var tokens
    var body: some View {
        HStack(spacing: 10) {
            if showsCheckbox {
                Button(action: toggle) { CheckBox(checked: selected).frame(width: 32, height: 64).contentShape(Rectangle()) }
                    .buttonStyle(.plain).accessibilityLabel("Select \(item.name)")
                    .accessibilityIdentifier("select-" + item.name)
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
            HStack(spacing: 12) {
                FileTile(kind: item.kind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).font(TypeScale.name).lineLimit(1).truncationMode(.middle)
                    Text(detail ?? Format.meta(item)).font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 64)
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .onLongPressGesture(minimumDuration: 0.4) {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                toggle()
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier((item.isFolder ? "folder-" : "file-") + item.name)
            .accessibilityAction(named: selected ? "Deselect" : "Select", toggle)
            if item.favorite == true {
                Icon(.star, size: 16, filled: true).foregroundStyle(tokens.warning).accessibilityLabel("Favorite")
            }
            if trashIcon { Icon(.trash, size: 16).foregroundStyle(tokens.text2).padding(.horizontal, 4) }
            if let status { Badge(text: status.0, tone: status.1) }
            if showsActions, let actions {
                Button(action: actions) { Icon(.ellipsis, size: 18).frame(width: 40, height: 40).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(tokens.text2)
                    .accessibilityLabel("Actions for \(item.name)").accessibilityIdentifier("actions-" + item.name)
            }
        }
        .padding(.trailing, 4)
        .background(selected ? tokens.accentSoft : .clear)
        .overlay(alignment: .bottom) { Hairline() }
    }
}

struct FileGridCard: View {
    let item: DriveItem
    var selected = false
    var selecting = false
    var status: (String, Tone)? = nil
    var detail: String? = nil
    var trashIcon = false
    var toggle: () -> Void = {}
    let open: () -> Void
    var actions: (() -> Void)? = nil
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button(action: toggle) { CheckBox(checked: selected).frame(width: 32, height: 32, alignment: .leading).contentShape(Rectangle()) }
                    .buttonStyle(.plain).accessibilityLabel("Select \(item.name)")
                Spacer()
                if item.favorite == true { Icon(.star, size: 14, filled: true).foregroundStyle(tokens.warning) }
                if let actions {
                    Button(action: actions) { Icon(.ellipsis, size: 18).frame(width: 32, height: 32).contentShape(Rectangle()) }
                        .buttonStyle(.plain).foregroundStyle(tokens.text2).accessibilityLabel("Actions for \(item.name)")
                        .accessibilityIdentifier("actions-" + item.name)
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                FileTile(kind: item.kind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).font(TypeScale.baseMedium).lineLimit(1).truncationMode(.middle)
                    Text(detail ?? Format.meta(item)).font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1)
                }
                if let status { Badge(text: status.0, tone: status.1) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .onLongPressGesture(minimumDuration: 0.4) { toggle() }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier((item.isFolder ? "folder-" : "file-") + item.name)
        }
        .padding(12)
        .background(selected ? tokens.accentSoft : tokens.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? tokens.accentBorder : tokens.line, lineWidth: 1))
    }
}
