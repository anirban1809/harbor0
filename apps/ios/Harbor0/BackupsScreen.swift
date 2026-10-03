import SwiftUI

private enum BackupTone { case ok, busy, paused, error, stopped, archived }

/// Backups (backups-page.tsx): folders backed up from computers, their files, versions and history.
@MainActor
final class BackupsModel: ObservableObject {
    @Published private(set) var roots: [BackupRoot] = []
    @Published private(set) var loaded = false
    @Published var rootID: String?
    @Published var tab = "Files"
    @Published var trail: [Crumb] = []
    @Published private(set) var items: [DriveItem] = []
    @Published private(set) var loadedFolder: String?
    @Published private(set) var runs: [BackupRun] = []
    @Published private(set) var restores: [BackupRestore] = []
    @Published private(set) var historyFor: String?
    @Published var expandedRun: String?
    @Published private(set) var entries: [String: [BackupEntry]] = [:]
    @Published var error: String?
    @Published var busy = false
    @Published var filter = ""

    var root: BackupRoot? { roots.first { $0.id == rootID } }
    var folderID: String? { trail.last?.id ?? root?.remoteRootDriveItemId }

    private static func all<T: Decodable>(_ api: HarborAPI, _ path: String) async throws -> [T] {
        var result: [T] = []
        var cursor: String?
        var seen = Set<String>()
        repeat {
            let page: Page<T> = try await api.request(HarborAPI.pagePath(path, cursor: cursor))
            result += page.items
            cursor = page.nextCursor
            if let cursor, !seen.insert(cursor).inserted { break }
        } while cursor != nil
        return result
    }
    func loadRoots(_ api: HarborAPI) async {
        do {
            let result: BackupCatalog = try await api.request("/v1/backups")
            // Active folders first; stopped backups stay listed so their history remains reachable.
            roots = result.items.sorted {
                ($0.state == "REMOVED" ? 1 : 0, $0.localPathDisplayName.lowercased()) < ($1.state == "REMOVED" ? 1 : 0, $1.localPathDisplayName.lowercased())
            }
            if let rootID, !roots.contains(where: { $0.id == rootID }) { self.rootID = nil }
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
        loaded = true
    }
    func loadFolder(_ api: HarborAPI) async {
        guard root != nil, let folderID else { return }
        do {
            let files: [DriveItem] = try await Self.all(api, "/v1/drive/folders/\(folderID)/children")
            guard folderID == self.folderID else { return }
            items = files.sorted { $0.isFolder != $1.isFolder ? $0.isFolder : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            loadedFolder = folderID
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }
    func loadHistory(_ api: HarborAPI) async {
        guard let id = root?.id else { return }
        do {
            async let history: [BackupRun] = Self.all(api, "/v1/backups/\(id)/runs")
            async let recovery: [BackupRestore] = Self.all(api, "/v1/backups/\(id)/restores")
            let (h, r) = try await (history, recovery)
            guard id == root?.id else { return }
            runs = h.sorted { $0.startedAt > $1.startedAt }
            restores = r.sorted { $0.requestedAt > $1.requestedAt }
            historyFor = id
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }
    func loadEntries(_ api: HarborAPI, run: String) async {
        guard let id = root?.id else { return }
        do { entries[run] = try await Self.all(api, "/v1/backups/\(id)/runs/\(run)/files") }
        catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }
    func select(_ id: String?) {
        rootID = id; trail = []; expandedRun = nil; error = nil; items = []; loadedFolder = nil
        runs = []; restores = []; historyFor = nil; tab = "Files"
    }
}

struct BackupsScreen: View {
    @ObservedObject var model: BackupsModel
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @EnvironmentObject private var sync: SyncCenter
    @Environment(\.tokens) private var tokens
    @State private var selectedFile: DriveItem?
    @State private var confirm: BackupConfirm?
    @State private var choosing = false
    @State private var adding = false

    var body: some View {
        PageScroll {
            VStack(alignment: .leading, spacing: 16) {
                PageTitle(text: "Backups")
                if model.root == nil {
                    Text("harbor0 keeps earlier versions of every file in these folders. A new version is saved about an hour after you stop editing a file, so you can always go back.")
                        .font(TypeScale.sm).foregroundStyle(tokens.text2).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                    if !model.roots.isEmpty {
                        Button { choosing = true } label: { Icon(.plus, size: 14); Text(adding ? "Adding…" : "Back up a folder") }
                            .harborButton(.primary, size: .sm).disabled(adding || !sync.ready).accessibilityIdentifier("addBackup")
                    }
                } else {
                    Button { model.select(nil) } label: { Icon(.arrowLeft, size: 14); Text("All backup folders") }
                        .harborButton(.ghost, size: .sm).padding(.leading, -10).accessibilityIdentifier("allBackupFolders")
                }
                if let error = model.error {
                    AlertBanner(tone: .danger, text: error, actionLabel: "Try again") {
                        model.error = nil
                        Task { await refresh() }
                    }
                }
                if model.roots.isEmpty {
                    if !model.loaded {
                        Text("Loading backup folders…").font(TypeScale.sm).foregroundStyle(tokens.text2).padding(.vertical, 24)
                    } else {
                        EmptyStateView(icon: .archive, title: "Back up a folder",
                                       description: "Choose a folder on this iPhone or in iCloud Drive. Its files are saved to harbor0, with earlier versions kept. You can also add folders from the harbor0 desktop app.") {
                            Button { choosing = true } label: { Icon(.plus, size: 14); Text(adding ? "Adding…" : "Back up a folder") }
                                .harborButton(.outline).disabled(adding || !sync.ready).accessibilityIdentifier("addBackup")
                        }
                    }
                } else if let root = model.root {
                    detail(root)
                } else {
                    folderList
                }
            }
        }
        .refreshable { await refresh() }
        .task(id: "\(model.rootID ?? "")|\(model.folderID ?? "")|\(workspace.revision)") {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { break }
                await refresh()
            }
        }
        .sheet(item: $selectedFile) { file in
            BackupFileSheet(file: file, model: model, location: location, device: device(model.root), deviceName: deviceName,
                            canRestore: !removed && !archived) { version in
                selectedFile = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                    confirm = .restore(itemID: file.id, versionID: version.id, name: file.name, createdAt: version.createdAt)
                }
            }.environment(\.tokens, tokens)
        }
        .sheet(item: $confirm) { current in confirmSheet(current).environment(\.tokens, tokens) }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.folder]) { result in
            switch result {
            case .success(let url): add(url)
            case .failure(let error): workspace.fail(error)
            }
        }
    }

    private func add(_ url: URL) {
        adding = true
        Task {
            _ = await act("Backing up \(url.lastPathComponent). The first backup runs once files have been unchanged for an hour.") {
                try await sync.addBackup(url)
            }
            adding = false
        }
    }
    /// This backup's folder when it is backed up from this iPhone.
    private func local(_ root: BackupRoot?) -> SyncSnapshot.Folder? { root.flatMap { sync.backupFolder($0) } }

    private func refresh() async {
        await model.loadRoots(workspace.api)
        if model.root != nil {
            async let folder: Void = model.loadFolder(workspace.api)
            async let history: Void = model.loadHistory(workspace.api)
            _ = await (folder, history)
            if let run = model.expandedRun { await model.loadEntries(workspace.api, run: run) }
        }
    }

    // MARK: List

    private var folderList: some View {
        let needle = model.roots.count >= 7 ? model.filter.trimmingCharacters(in: .whitespaces).lowercased() : ""
        let shown = needle.isEmpty ? model.roots : model.roots.filter { "\($0.localPathDisplayName) \(device($0))".lowercased().contains(needle) }
        return VStack(alignment: .leading, spacing: 12) {
            if model.roots.count >= 7 {
                TextInput(placeholder: "Filter \(model.roots.count) folders", text: $model.filter, icon: .search, identifier: "filterBackups")
            }
            VStack(spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, root in
                    let (tone, text) = rootTone(root)
                    Button { model.select(root.id) } label: {
                        HStack(spacing: 12) {
                            Icon(.folder, size: 16).foregroundStyle(tokens.text2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(root.localPathDisplayName).font(TypeScale.baseMedium.weight(.semibold)).lineLimit(1)
                                Text(device(root)).font(TypeScale.sm).foregroundStyle(tokens.text2).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            statusBadge(tone, text)
                            Icon(.chevronRight, size: 16).foregroundStyle(tokens.text2)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .overlay(alignment: .top) { if index > 0 { Hairline() } }
                    .accessibilityIdentifier("backup-" + root.localPathDisplayName)
                }
                if shown.isEmpty { Text("No folders match.").font(TypeScale.sm).foregroundStyle(tokens.text2).padding(16) }
            }
            .modifier(CardChrome())
        }
    }

    // MARK: Detail

    private var removed: Bool { model.root?.state == "REMOVED" }
    private var archived: Bool { model.root?.state == "ARCHIVED" }
    private var deviceName: String { local(model.root) != nil ? "this iPhone" : model.root?.deviceName ?? "the source computer" }
    private func device(_ root: BackupRoot?) -> String { local(root) != nil ? "This iPhone" : root?.deviceName ?? "Another computer" }
    private var location: String { ([model.root?.localPathDisplayName].compactMap { $0 } + model.trail.map(\.name)).joined(separator: " / ") }

    private var status: (BackupTone, String, String) {
        guard let root = model.root else { return (.ok, "", "") }
        let runs = model.historyFor == root.id ? model.runs : []
        let latest = runs.first
        let lastGood = runs.first { $0.state == "COMPLETED" || $0.state == "PARTIAL" }
        if removed { return (.stopped, "Stopped", "No new versions are saved. The backed-up files are now regular files in My Drive → Cloud.") }
        if archived { return (.archived, "Archived", "Backups are stopped and the folder was removed from \(deviceName). Its files and versions are kept here.") }
        if let folder = local(root) {
            if folder.root.archive == .pending || folder.root.archive == .removing { return (.busy, "Archiving", "Saving everything one last time, then removing the files from this iPhone.") }
            if folder.root.archive == .restoring { return (.busy, "Restoring", "Downloading the saved files back to this iPhone.") }
            if folder.root.paused || sync.snapshot.state.paused { return (.paused, "Paused", "No new versions are saved until you resume. Saved versions are still here.") }
            if sync.snapshot.state.active?.rootId == folder.id { return (.busy, "Backing up", "Saving \(SyncPaths.basename(sync.snapshot.state.active!.relativePath))…") }
        }
        if root.state == "PAUSED" { return (.paused, "Paused", "No new versions are saved until you resume. Saved versions are still here.") }
        if latest?.state == "RUNNING" { return (.busy, "Backing up", "Saving \(Format.count(latest!.fileCount, "file")) so far…") }
        if root.state == "ERROR" || latest?.state == "FAILED" {
            return (.error, "Needs attention", latest?.error.map { "The last backup didn’t finish: \($0)" } ?? "The last backup didn’t finish. It will try again automatically.")
        }
        if let lastGood {
            return (latest?.state == "PARTIAL" ? .error : .ok, latest?.state == "PARTIAL" ? "Some files skipped" : "Backed up",
                    "Last backed up \(Format.ago(lastGood.completedAt ?? lastGood.startedAt)).")
        }
        return (.ok, "Waiting", model.historyFor != root.id ? "Checking backup status…" : "The first backup runs once files have been unchanged for an hour.")
    }
    private func rootTone(_ root: BackupRoot) -> (BackupTone, String) {
        switch root.state {
        case "REMOVED": (.stopped, "Stopped")
        case "ARCHIVED": (.archived, "Archived")
        case "PAUSED": (.paused, "Paused")
        case "ERROR": (.error, "Needs attention")
        default: (.ok, "On")
        }
    }
    private func statusBadge(_ tone: BackupTone, _ text: String) -> some View {
        let icon: Lucide = switch tone { case .ok: .circleCheck; case .busy: .loaderCircle; case .paused: .pause; case .error: .circleAlert; case .archived: .archive; case .stopped: .x }
        let badgeTone: Tone = switch tone { case .ok: .success; case .busy: .accent; case .error: .danger; default: .neutral }
        return Badge(text: text, tone: badgeTone, icon: icon, spinning: tone == .busy)
    }

    private func detail(_ root: BackupRoot) -> some View {
        let (tone, label, detail) = status
        let pending = (model.historyFor == root.id ? model.restores : []).filter { $0.state == "PENDING" }.count
        return VStack(alignment: .leading, spacing: 16) {
            Card {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .top, spacing: 12) {
                        IconTile(icon: .folder)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(root.localPathDisplayName).font(TypeScale.lg).lineLimit(2)
                                statusBadge(tone, label)
                            }
                            Text("\(device(root)) · \(detail)").font(TypeScale.sm).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if removed {
                        Button { confirm = .remove } label: { Icon(.trash, size: 14); Text("Remove from Backups") }
                            .harborButton(.outline, size: .sm).disabled(model.busy)
                    } else if let folder = local(root) {
                        localControls(folder)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(archived ? "To restore this folder, open harbor0 on \(deviceName)."
                                 : "To back up now, pause or archive, open harbor0 on \(deviceName).")
                                .font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                            Button("Stop backing up") { confirm = .stop }.harborButton(.ghost, size: .sm).padding(.leading, -10)
                                .disabled(model.busy).accessibilityIdentifier("stopBackup")
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                Segmented(options: [SegmentOption(value: "Files", label: "Files & versions"), SegmentOption(value: "History", label: "History")],
                          selection: $model.tab, identifier: "backup-tab")
                if pending > 0 { Badge(text: "\(pending) waiting", tone: .accent) }
            }
            if model.tab == "Files" { files(root) } else { history }
        }
    }

    /// Controls for a folder backed up from this iPhone (the desktop app's backup actions).
    private func localControls(_ folder: SyncSnapshot.Folder) -> some View {
        let root = folder.root
        let archiving = root.archive == .pending || root.archive == .removing || root.archive == .restoring
        return VStack(alignment: .leading, spacing: 10) {
            if let error = root.archiveError { AlertBanner(tone: .danger, text: error) }
            if let issue = sync.snapshot.state.issues.first(where: { $0.rootId == root.id }) { AlertBanner(tone: .danger, text: issue.message) }
            if root.place.documents != nil {
                Text(SyncFiles.place(root)).font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1).truncationMode(.middle)
            }
            HStack(spacing: 6) {
                if root.archive == .archived {
                    Button { localAction("Restoring \(root.name) to this iPhone.") { try await sync.archive(folder, false) } } label: {
                        Icon(.archiveRestore, size: 14); Text("Restore folder")
                    }.harborButton(.primary, size: .sm).disabled(model.busy).accessibilityIdentifier("unarchiveBackup")
                } else {
                    Button { localAction("Backing up \(root.name) now.") { try await sync.backupNow(folder) } } label: {
                        Icon(.cloudUpload, size: 14); Text("Back up now")
                    }.harborButton(.primary, size: .sm).disabled(model.busy || archiving || root.paused).accessibilityIdentifier("backupNow")
                    Button { localAction(root.paused ? "Resumed backing up \(root.name)." : "Paused backing up \(root.name).") { try await sync.setPaused(folder, !root.paused) } } label: {
                        Icon(root.paused ? .play : .pause, size: 14); Text(root.paused ? "Resume" : "Pause")
                    }.harborButton(.outline, size: .sm).disabled(model.busy || archiving)
                    Button { SyncFiles.open(folder.url) } label: { Icon(.folder, size: 14) }
                        .harborButton(.ghost, size: .iconSm).accessibilityLabel("Show in Files")
                }
            }
            HStack(spacing: 0) {
                if root.archive == nil {
                    Button("Archive") { confirm = .archive }.harborButton(.ghost, size: .sm).padding(.leading, -10).disabled(model.busy || root.paused)
                }
                Button("Stop backing up") { confirm = .stop }.harborButton(.ghost, size: .sm).padding(.leading, root.archive == nil ? 0 : -10)
                    .disabled(model.busy || archiving).accessibilityIdentifier("stopBackup")
            }
        }
    }
    private func localAction(_ done: String, _ work: @escaping () async throws -> Void) {
        Task { _ = await act(done, work) }
    }

    @ViewBuilder private func files(_ root: BackupRoot) -> some View {
        if !model.trail.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    Button(root.localPathDisplayName) { model.trail = [] }.buttonStyle(.plain).font(TypeScale.sm).foregroundStyle(tokens.text2).padding(4)
                    ForEach(Array(model.trail.enumerated()), id: \.element.id) { index, folder in
                        Icon(.chevronRight, size: 14).foregroundStyle(tokens.text3)
                        Button(folder.name) { model.trail = Array(model.trail.prefix(index + 1)) }.buttonStyle(.plain)
                            .font(index == model.trail.count - 1 ? TypeScale.smMedium : TypeScale.sm)
                            .foregroundStyle(index == model.trail.count - 1 ? tokens.text : tokens.text2).padding(4)
                    }
                }
            }
        }
        if model.loadedFolder != model.folderID {
            SkeletonRows(count: 4)
        } else if model.items.isEmpty {
            Text(model.trail.isEmpty ? "Nothing backed up yet. Files appear here after their first backup." : "This folder has no backed-up files.")
                .font(TypeScale.sm).foregroundStyle(tokens.text2).padding(.vertical, 24)
        } else {
            VStack(spacing: 0) {
                Hairline()
                ForEach(model.items) { item in
                    FileRowView(item: item, showsCheckbox: false, open: {
                        if item.isFolder { model.trail.append(Crumb(id: item.id, name: item.name)) } else { selectedFile = item }
                    })
                }
            }
        }
    }

    @ViewBuilder private var history: some View {
        let restores = model.historyFor == model.rootID ? model.restores : []
        let runs = model.historyFor == model.rootID ? model.runs : []
        if !restores.isEmpty {
            SectionTitle(text: "Restores")
            VStack(spacing: 0) {
                ForEach(restores) { restore in
                    HStack(alignment: .top, spacing: 12) {
                        Icon(.rotateCcw, size: 18).foregroundStyle(tokens.text2).padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(restore.relativePath).font(TypeScale.baseMedium).fixedSize(horizontal: false, vertical: true)
                            Text("Requested \(Format.full(restore.requestedAt))" + (restore.completedAt.map { " · Finished \(Format.full($0))" } ?? ""))
                                .font(TypeScale.xs).foregroundStyle(tokens.text2)
                            if restore.state == "PENDING" {
                                Text("Will be restored the next time \(deviceName) is online.").font(TypeScale.xs).foregroundStyle(tokens.text2)
                            }
                            if let error = restore.error { Text(error).font(TypeScale.xs).foregroundStyle(tokens.dangerText) }
                        }
                        Spacer(minLength: 4)
                        statusBadge(restore.state == "PENDING" ? .busy : restore.state == "FAILED" ? .error : .ok,
                                    ["PENDING": "Waiting", "COMPLETED": "Restored", "FAILED": "Failed"][restore.state] ?? restore.state)
                    }
                    .padding(.vertical, 12)
                    .overlay(alignment: .bottom) { Hairline() }
                }
            }
        }
        SectionTitle(text: "Backups")
        if runs.isEmpty {
            Text(model.historyFor != model.rootID ? "Loading history…" : "No backups have run yet.").font(TypeScale.sm).foregroundStyle(tokens.text2)
        }
        VStack(spacing: 0) {
            ForEach(runs) { run in
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        model.expandedRun = model.expandedRun == run.id ? nil : run.id
                        if model.expandedRun == run.id { Task { await model.loadEntries(workspace.api, run: run.id) } }
                    } label: {
                        HStack(spacing: 12) {
                            Icon(.archive, size: 18).foregroundStyle(tokens.text2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Format.full(run.startedAt)).font(TypeScale.baseMedium)
                                Text("\(run.trigger == "MANUAL" ? "Backed up manually" : "Automatic backup") · \(Format.count(run.fileCount, "file")) saved · \(Format.size(run.sizeBytes))")
                                    .font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 4)
                            statusBadge(run.state == "RUNNING" ? .busy : run.state == "COMPLETED" ? .ok : .error,
                                        ["RUNNING": "In progress", "COMPLETED": "Done", "PARTIAL": "Some files skipped", "FAILED": "Failed"][run.state] ?? run.state)
                            Icon(.chevronRight, size: 16).foregroundStyle(tokens.text3)
                                .rotationEffect(.degrees(model.expandedRun == run.id ? 90 : 0))
                        }
                        .padding(.vertical, 12).padding(.horizontal, 4).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityIdentifier("run-" + run.id)
                    if model.expandedRun == run.id { runFiles(run) }
                }
                .overlay(alignment: .bottom) { Hairline() }
            }
        }
    }

    @ViewBuilder private func runFiles(_ run: BackupRun) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error = run.error { AlertBanner(tone: .danger, text: error).padding(.bottom, 8) }
            if let entries = model.entries[run.id] {
                if entries.isEmpty { Text("No files were saved in this backup.").font(TypeScale.sm).foregroundStyle(tokens.text2) }
                ForEach(entries) { entry in
                    let name = entry.relativePath.split(separator: "/").last.map(String.init) ?? entry.relativePath
                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.relativePath).font(TypeScale.baseMedium).fixedSize(horizontal: false, vertical: true)
                            Text("\(Format.size(entry.sizeBytes)) · Edited \(Format.full(entry.modifiedAt))").font(TypeScale.xs).foregroundStyle(tokens.text2)
                        }
                        versionActions(itemID: entry.itemId, versionID: entry.versionId, name: name, createdAt: entry.savedAt)
                    }
                    .padding(.vertical, 10)
                }
            } else {
                Text("Loading files…").font(TypeScale.sm).foregroundStyle(tokens.text2)
            }
        }
        .padding(.leading, 34).padding(.bottom, 12)
    }

    private func versionActions(itemID: String, versionID: String, name: String, createdAt: String) -> some View {
        HStack(spacing: 6) {
            if !removed && !archived {
                Button { confirm = .restore(itemID: itemID, versionID: versionID, name: name, createdAt: createdAt) } label: {
                    Icon(.rotateCcw, size: 14); Text("Restore")
                }.harborButton(.outline, size: .sm).disabled(model.busy)
            }
            Button {
                let item = DriveItem(id: itemID, parentId: nil, type: "FILE", name: name, mimeType: nil, sizeBytes: 0, updatedAt: createdAt, backupRootId: model.rootID, cloudState: nil)
                transfers.save([item], versionID: versionID)
            } label: { Icon(.download, size: 14); Text("Download") }
                .harborButton(.ghost, size: .sm).disabled(model.busy)
                .accessibilityLabel("Download this version of \(name)")
        }
    }

    // MARK: Confirmations

    @ViewBuilder private func confirmSheet(_ current: BackupConfirm) -> some View {
        let name = model.root?.localPathDisplayName ?? "this folder"
        switch current {
        case .stop:
            AsyncConfirm(title: "Stop backing up \(name)?",
                         description: "No new versions will be saved. Everything already backed up moves to My Drive → Cloud as regular files. Nothing on \(local(model.root) != nil ? "this iPhone" : "your computer") is deleted.",
                         confirm: "Stop backing up", cancel: "Keep backing up") {
                await act("Stopped backing up \(name). Its files are in My Drive → Cloud.") {
                    if let folder = local(model.root) { try await sync.disconnectBackup(folder) }
                    else { let _: EmptyResponse = try await workspace.api.request("/v1/backups/\(model.rootID ?? "")", method: "DELETE") }
                }
            }
        case .archive:
            AsyncConfirm(title: "Archive \(name)?",
                         description: "harbor0 backs up everything one last time, then removes the files from this iPhone. They stay in Backups with all their versions, and you can restore the folder later.",
                         note: "Files that change or can’t be backed up are kept on this iPhone.",
                         confirm: "Archive", danger: false) {
                await act("Archiving \(name). Files are removed from this iPhone after a final backup.") {
                    guard let folder = local(model.root) else { return }
                    try await sync.archive(folder, true)
                }
            }
        case .remove:
            AsyncConfirm(title: "Remove \(name) from Backups?",
                         description: "This removes the folder and its backup history from this list. Its files stay in My Drive → Cloud, and nothing on your computer is deleted.",
                         confirm: "Remove") {
                await act("Removed \(name) from Backups.") {
                    let _: EmptyResponse = try await workspace.api.request("/v1/backups/\(model.rootID ?? "")/forget", method: "POST")
                    model.select(nil)
                }
            }
        case .restore(let itemID, let versionID, let file, let createdAt):
            AsyncConfirm(title: "Restore \(file)?",
                         description: "The copy of \(file) on \(deviceName) will be replaced with the version from \(Format.full(createdAt)).",
                         note: "If \(deviceName) is offline, the restore happens the next time it’s online. To keep both, download this version instead.",
                         confirm: "Restore", danger: false) {
                await act("Restoring \(file). Follow its progress in History.") {
                    let _: EmptyResponse = try await workspace.api.request("/v1/backups/\(model.rootID ?? "")/restores", method: "POST",
                                                                            body: ["id": UUID().uuidString, "itemId": itemID, "versionId": versionID])
                }
            }
        }
    }
    private func act(_ done: String, _ action: () async throws -> Void) async -> Bool {
        model.busy = true
        defer { model.busy = false }
        do {
            try await action()
            workspace.notify(done)
            await refresh()
            await workspace.catalog.loadBackups(workspace.api)
            workspace.changed()
            return true
        } catch { workspace.fail(error); return false }
    }
}

private enum BackupConfirm: Identifiable {
    case stop, remove, archive
    case restore(itemID: String, versionID: String, name: String, createdAt: String)
    var id: String {
        switch self {
        case .stop: "stop"
        case .remove: "remove"
        case .archive: "archive"
        case .restore(let item, let version, _, _): item + version
        }
    }
}

/// A backed-up file: details and saved versions with Restore / Download.
private struct BackupFileSheet: View {
    let file: DriveItem
    @ObservedObject var model: BackupsModel
    let location: String
    let device: String
    let deviceName: String
    let canRestore: Bool
    let restore: (FileVersion) -> Void
    @State private var versions: [FileVersion]?
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(spacing: 0) {
            SheetScaffold(title: file.name, description: "File details and saved versions.", divider: true) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DetailsList(rows: [("Type", Format.kind(file)), ("Size", Format.size(file.sizeBytes)),
                                       ("Modified", Format.full(file.updatedAt)), ("Location", location), ("Backed up from", device)])
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle(text: "Saved versions")
                        Text((versions.map { "\(Format.count($0.count, "saved version")), newest first. " } ?? "")
                             + (canRestore ? "Restore puts a version back on \(deviceName). " : "") + "Download saves a separate copy.")
                            .font(TypeScale.sm).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                    }
                    if let versions {
                        if versions.isEmpty { Text("No saved versions.").font(TypeScale.sm).foregroundStyle(tokens.text2) }
                        ForEach(Array(versions.enumerated()), id: \.element.id) { index, version in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(Format.full(version.createdAt)).font(TypeScale.baseMedium)
                                    Spacer()
                                    if index == 0 { Badge(text: "Latest") }
                                }
                                Text("Version \(version.versionNumber) · \(Format.size(version.sizeBytes))").font(TypeScale.xs).foregroundStyle(tokens.text2)
                                HStack(spacing: 6) {
                                    if canRestore {
                                        Button { restore(version) } label: { Icon(.rotateCcw, size: 14); Text("Restore") }.harborButton(.outline, size: .sm)
                                    }
                                    Button { dismiss(); transfers.save([file], versionID: version.id) } label: { Icon(.download, size: 14); Text("Download") }
                                        .harborButton(.ghost, size: .sm)
                                }.padding(.top, 4)
                            }
                            .padding(.vertical, 8)
                            .overlay(alignment: .bottom) { if index < versions.count - 1 { Hairline() } }
                        }
                    } else {
                        Text("Loading versions…").font(TypeScale.sm).foregroundStyle(tokens.text2)
                    }
                }.padding(20)
            }
        }
        .cardSurface(paint: false)
        .modifier(TallSheet())
        .task {
            do {
                let page: Page<FileVersion> = try await workspace.api.request("/v1/drive/items/\(file.id)/versions")
                versions = page.items
            } catch { versions = []; workspace.fail(error) }
        }
    }
}
