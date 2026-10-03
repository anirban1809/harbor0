import SwiftUI
import UniformTypeIdentifiers

extension Workspace {
    /// Runs a sheet action: a toast on success, the error in the sheet on failure.
    func attempt(_ done: String? = nil, _ work: () async throws -> Void) async -> Bool {
        do {
            try await work()
            if let done { notify(done) }
            return true
        } catch { fail(error); return false }
    }
}

enum SyncFiles {
    /// Opens a folder on this phone in the Files app.
    static func open(_ url: URL?) {
        guard let url, let path = url.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let target = URL(string: "shareddocuments://" + path) else { return }
        UIApplication.shared.open(target)
    }
    static func place(_ root: SyncRoot) -> String {
        root.place.documents != nil ? "On My iPhone › harbor0 › \(root.name)" : root.name
    }
}

/// Sync (desktop sync-page.tsx): folders kept on this iPhone, their status, problems and invitations.
struct SyncScreen: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var sync: SyncCenter
    @EnvironmentObject private var catalog: WorkspaceCatalog
    @Environment(\.tokens) private var tokens
    @State private var setup: SyncSetupRequest?
    @State private var selected: SyncSnapshot.Folder?
    @State private var preview: URL?
    @State private var confirm: SyncConfirm?

    var body: some View {
        let snapshot = sync.snapshot
        let label = SyncLabels.global(snapshot)
        PageScroll {
            VStack(alignment: .leading, spacing: 16) {
                PageTitle(text: "Sync")
                Text("Synced folders are kept in the cloud, and this iPhone and your other devices download changes from there. Files appear in the Files app, and changes you make there sync automatically.")
                    .font(TypeScale.sm).foregroundStyle(tokens.text2).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                if let error = sync.startError {
                    AlertBanner(tone: .danger, text: "Sync couldn’t start: \(error)", actionLabel: "Try again") { workspace.startSync(force: true) }
                }
                statusCard(snapshot, label)
                issues(snapshot)
                invitations
                folders(snapshot)
                if !snapshot.state.waiting.isEmpty {
                    SectionTitle(text: "Waiting for another device")
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(snapshot.state.waiting, id: \.relativePath) { item in
                            Text(item.relativePath).font(TypeScale.sm).foregroundStyle(tokens.text2).lineLimit(1).truncationMode(.middle)
                        }
                        Text("These older files are still on another linked device. They download when it comes online.")
                            .font(TypeScale.xs).foregroundStyle(tokens.text3).fixedSize(horizontal: false, vertical: true)
                    }
                }
                recent(snapshot)
            }
        }
        .refreshable {
            async let engine: Void = sync.refresh()
            async let invitations: Void = sync.loadInvitations()
            async let folders: Void = catalog.loadSync(workspace.api)
            _ = await (engine, invitations, folders)
        }
        .task {
            while !Task.isCancelled {
                async let invitations: Void = sync.loadInvitations()
                async let folders: Void = catalog.loadSync(workspace.api)
                _ = await (invitations, folders)
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
        .sheet(item: $setup) { request in SyncSetupSheet(request: request).environment(\.tokens, tokens) }
        .sheet(item: $selected) { folder in
            SyncFolderSheet(folderID: folder.id) { next in
                selected = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                    if case .change(let id) = next { setup = .init(changeLocal: id) } else { confirm = next }
                }
            }.environment(\.tokens, tokens)
        }
        .sheet(item: $confirm) { current in confirmSheet(current).environment(\.tokens, tokens) }
        .sheet(item: Binding(get: { preview.map(PreviewURL.init) }, set: { if $0 == nil { preview = nil } })) { item in
            FilePreview(url: item.url) { preview = nil }.ignoresSafeArea()
        }
    }

    private func statusCard(_ snapshot: SyncSnapshot, _ label: String) -> some View {
        let state = snapshot.state
        return Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    IconTile(icon: .smartphone, size: 40, iconSize: 18, radius: 10, active: true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("This iPhone").font(TypeScale.baseMedium.weight(.semibold))
                        Text(detail(snapshot)).font(TypeScale.sm).foregroundStyle(tokens.text2).lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    Badge(text: label, tone: SyncLabels.tone(label), icon: SyncLabels.icon(label), spinning: SyncLabels.icon(label) == .loaderCircle)
                        .accessibilityIdentifier("syncStatus")
                }
                if let active = state.active {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(active.direction == .upload ? "Uploading" : "Downloading") \(SyncPaths.basename(active.relativePath))")
                            .font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1).truncationMode(.middle)
                        ProgressBar(value: active.total > 0 ? Double(active.loaded) / Double(active.total) : nil, height: 4)
                    }
                }
                HStack(spacing: 8) {
                    Button { setup = .init() } label: { Icon(.plus, size: 14); Text("Sync a folder") }
                        .harborButton(.primary, size: .sm).disabled(!sync.ready).accessibilityIdentifier("addSyncFolder")
                    if !snapshot.folders.isEmpty {
                        Button { Task { await sync.pauseAll(!state.paused) } } label: {
                            Icon(state.paused ? .play : .pause, size: 14); Text(state.paused ? "Resume" : "Pause")
                        }.harborButton(.outline, size: .sm).accessibilityIdentifier("pauseSync")
                        Button { Task { await sync.refresh() } } label: { Icon(.refreshCw, size: 14) }
                            .harborButton(.ghost, size: .iconSm).accessibilityLabel("Check for changes now")
                    }
                }
            }
        }
    }
    private func detail(_ snapshot: SyncSnapshot) -> String {
        let state = snapshot.state
        if !sync.ready { return sync.startError == nil ? "Starting…" : "Not running" }
        if snapshot.folders.isEmpty { return "No folders sync to this iPhone yet." }
        if state.paused { return "Paused. Nothing uploads or downloads until you resume." }
        if !state.online { return "Offline. Changes sync when your connection returns." }
        if state.queued > 0 { return "\(Format.count(state.queued, "change")) waiting to sync" }
        if let last = state.lastSync { return "Checked \(Format.ago(last))" }
        return state.message
    }

    @ViewBuilder private func issues(_ snapshot: SyncSnapshot) -> some View {
        let ids = Set(snapshot.folders.map(\.id))
        let issues = snapshot.state.issues.filter { ids.contains($0.rootId) || $0.rootId.isEmpty }
        let failed = snapshot.jobs.filter { job in job.error != nil && !issues.contains { $0.jobId == job.id } && snapshot.folders.contains { $0.id == job.rootId && $0.root.mode == .sync } }
        if !issues.isEmpty || !failed.isEmpty {
            SectionTitle(text: "Needs attention")
            VStack(spacing: 8) {
                ForEach(issues) { issue in issueRow(issue, snapshot) }
                ForEach(failed) { job in
                    issueCard(title: SyncPaths.basename(job.relativePath), message: job.error ?? "", folder: folderName(job.rootId, snapshot)) {
                        Button("Retry now") { Task { await sync.retry(jobId: job.id) } }.harborButton(.outline, size: .sm)
                    }
                }
            }
        }
    }
    private func issueRow(_ issue: SyncIssue, _ snapshot: SyncSnapshot) -> some View {
        let folder = snapshot.folders.first { $0.id == issue.rootId }
        let title: String = switch issue.code {
        case "CONFLICT": "Kept both versions of \(SyncPaths.basename(issue.relativePath ?? "a file"))"
        case "FOLDER_RECOVERED": "Kept a copy of \(SyncPaths.basename(issue.relativePath ?? "a folder"))"
        case "FOLDER_MISSING": "\(folder?.root.name ?? "A folder") is unavailable"
        case "PERMISSION_DENIED": "harbor0 can’t access \(folder?.root.name ?? "a folder")"
        case "STORAGE_QUOTA_EXCEEDED": "Your storage is full"
        case "DISK_FULL": "This iPhone is out of space"
        case "MAPPING_REQUIRED": "Choose a cloud folder"
        default: issue.relativePath.map(SyncPaths.basename) ?? "Sync problem"
        }
        return issueCard(title: title, message: issue.message, folder: folder?.root.name) {
            if let path = issue.conflictPath, let base = folder?.url, let url = try? SyncPaths.contained(base, path) {
                if issue.code == "CONFLICT" {
                    Button("Open your copy") { preview = url }.harborButton(.outline, size: .sm)
                } else {
                    Button("Show in Files") { SyncFiles.open(url.deletingLastPathComponent()) }.harborButton(.outline, size: .sm)
                }
            }
            if issue.sticky {
                Button("Dismiss") { Task { await sync.dismiss(issue) } }.harborButton(.ghost, size: .sm)
            } else if let job = issue.jobId {
                Button("Retry now") { Task { await sync.retry(jobId: job) } }.harborButton(.outline, size: .sm)
            } else if issue.code == "FOLDER_MISSING" || issue.code == "PERMISSION_DENIED", let folder, folder.root.place.bookmark != nil, folder.root.mode == .sync {
                Button("Choose folder again") { setup = .init(changeLocal: folder.id) }.harborButton(.outline, size: .sm)
            } else if issue.code == "STORAGE_QUOTA_EXCEEDED" {
                Button("Manage storage") { workspace.navigate(.storage) }.harborButton(.outline, size: .sm)
            }
        }
    }
    private func issueCard<Actions: View>(title: String, message: String, folder: String?, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Icon(.circleAlert, size: 16).foregroundStyle(tokens.dangerText).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(TypeScale.smMedium.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    Text(message).font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                    if let folder { Text(folder).font(TypeScale.xs).foregroundStyle(tokens.text3) }
                }
            }
            HStack(spacing: 6) { actions() }.padding(.leading, 26)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .modifier(CardChrome())
    }
    private func folderName(_ id: String, _ snapshot: SyncSnapshot) -> String? { snapshot.folders.first { $0.id == id }?.root.name }

    @ViewBuilder private var invitations: some View {
        let received = sync.invitations.filter { $0.direction == "RECEIVED" && $0.revokedAt == nil && ($0.syncState ?? "PENDING") == "PENDING" }
        let accepted = sync.invitations.filter { invite in
            invite.direction == "RECEIVED" && invite.revokedAt == nil && invite.syncState == "ACCEPTED"
                && !sync.snapshot.folders.contains { $0.root.shareId == invite.id }
        }
        if !received.isEmpty || !accepted.isEmpty {
            SectionTitle(text: "Invitations")
            VStack(spacing: 8) {
                ForEach(received + accepted) { invite in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 12) {
                            IconTile(icon: .users)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(invite.name).font(TypeScale.baseMedium.weight(.semibold)).lineLimit(1)
                                Text("From \(invite.owner.displayName) · @\(invite.owner.username)").font(TypeScale.xs).foregroundStyle(tokens.text2)
                            }
                        }
                        Text("Everyone in this folder can add, edit, rename and delete files. Accept to choose where it syncs on this iPhone.")
                            .font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 6) {
                            Button(invite.syncState == "ACCEPTED" ? "Sync to this iPhone" : "Accept") { setup = .init(invitation: invite) }
                                .harborButton(.primary, size: .sm).accessibilityIdentifier("acceptInvite-" + invite.name)
                            if invite.syncState != "ACCEPTED" {
                                Button("Decline") { confirm = .decline(invite) }.harborButton(.ghost, size: .sm)
                            }
                        }
                    }
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading).modifier(CardChrome())
                }
            }
        }
    }

    @ViewBuilder private func folders(_ snapshot: SyncSnapshot) -> some View {
        let folders = snapshot.folders.filter { $0.root.mode == .sync }
        let local = Set(folders.compactMap(\.root.remoteId))
        let elsewhere = catalog.syncFolders.filter { !local.contains($0.id) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        // With nothing on this iPhone yet, the folders from other devices are the likely next step.
        if folders.isEmpty { otherDevices(elsewhere) }
        SectionTitle(text: "On this iPhone")
        if folders.isEmpty {
            if elsewhere.isEmpty {
                EmptyStateView(icon: .refreshCw, title: "No folders sync here yet",
                               description: "Choose a folder on this iPhone, a folder from My Drive, or one that already syncs with your computer. It stays the same everywhere it syncs.",
                               compact: true) {
                    Button { setup = .init() } label: { Icon(.plus, size: 14); Text("Sync a folder") }
                        .harborButton(.outline).disabled(!sync.ready)
                }
                .modifier(CardChrome())
            } else {
                Text("No folders sync to this iPhone yet. Choose one above, or use Sync a folder for any other folder.")
                    .font(TypeScale.sm).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(folders.enumerated()), id: \.element.id) { index, folder in
                    let label = SyncLabels.folder(folder, snapshot)
                    Button { selected = folder } label: {
                        HStack(spacing: 12) {
                            IconTile(icon: .folder, size: 40, iconSize: 18, radius: 10)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(folder.root.name).font(TypeScale.baseMedium.weight(.semibold)).lineLimit(1)
                                Text(rowDetail(folder)).font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            Badge(text: label, tone: SyncLabels.tone(label), icon: SyncLabels.icon(label), spinning: SyncLabels.icon(label) == .loaderCircle)
                            Icon(.chevronRight, size: 16).foregroundStyle(tokens.text3)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .overlay(alignment: .top) { if index > 0 { Hairline() } }
                    .accessibilityIdentifier("syncFolder-" + folder.root.name)
                }
            }
            .modifier(CardChrome())
        }
        if !folders.isEmpty { otherDevices(elsewhere) }
    }

    /// Folders that sync on the account's other devices but not on this iPhone, each one tap from syncing here.
    @ViewBuilder private func otherDevices(_ elsewhere: [DriveItem]) -> some View {
        if !elsewhere.isEmpty || catalog.syncError != nil || (!catalog.haveSync && catalog.loadingSync) {
            VStack(alignment: .leading, spacing: 4) {
                SectionTitle(text: "On your other devices")
                Text("These folders sync on your computers or other phones. Sync one to keep its files on this iPhone too.")
                    .font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
            }
            if let error = catalog.syncError, elsewhere.isEmpty {
                AlertBanner(tone: .warning, text: "Folders on your other devices couldn’t be loaded. \(error)", actionLabel: "Try again") {
                    Task { await catalog.loadSync(workspace.api) }
                }
            } else if elsewhere.isEmpty {
                SkeletonRows(count: 2, tile: 32)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(elsewhere.enumerated()), id: \.element.id) { index, item in
                        let start = { setup = .init(cloud: .existing(id: item.id, path: "My Drive / \(item.name)"), name: item.name) }
                        Button(action: start) {
                            HStack(spacing: 12) {
                                IconTile(icon: .folder, size: 40, iconSize: 18, radius: 10)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.name).font(TypeScale.baseMedium.weight(.semibold)).foregroundStyle(tokens.text).lineLimit(1)
                                    Text(devices(item)).font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1)
                                }
                                Spacer(minLength: 8)
                                Text("Sync to iPhone").font(TypeScale.smMedium).foregroundStyle(tokens.accentText)
                                    .padding(.horizontal, 10).frame(height: 30)
                                    .background(tokens.accentSoft, in: Capsule())
                            }
                            .padding(.horizontal, 14).padding(.vertical, 12).contentShape(Rectangle())
                        }
                        .buttonStyle(PressStyle())
                        .disabled(!sync.ready)
                        .overlay(alignment: .top) { if index > 0 { Hairline() } }
                        .accessibilityLabel("\(item.name), \(devices(item)). Sync to this iPhone")
                        .accessibilityIdentifier("syncHere-" + item.name)
                    }
                }
                .modifier(CardChrome())
            }
        }
    }
    private func devices(_ item: DriveItem) -> String {
        let names = (item.syncDevices ?? []).filter { $0.id != sync.deviceId }.map(\.name)
        let unique = names.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        switch unique.count {
        case 0: return "Synced folder"
        case 1, 2: return "On " + unique.joined(separator: " and ")
        default: return "On \(unique[0]), \(unique[1]) and \(unique.count - 2) more"
        }
    }
    private func rowDetail(_ folder: SyncSnapshot.Folder) -> String {
        var parts = [Format.count(folder.files, "file")]
        if let shared = folder.root.shareId, !shared.isEmpty { parts.append("Shared with you") }
        if let last = folder.root.lastSyncedAt { parts.append("Synced \(Format.ago(last))") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private func recent(_ snapshot: SyncSnapshot) -> some View {
        let ids = Set(snapshot.folders.filter { $0.root.mode == .sync }.map(\.id))
        let recent = snapshot.state.recent.filter { ids.contains($0.rootId) }.prefix(12)
        if !recent.isEmpty {
            SectionTitle(text: "Recent activity")
            VStack(spacing: 0) {
                ForEach(Array(recent)) { entry in
                    HStack(spacing: 10) {
                        Icon(entry.direction == .upload ? .arrowUpFromLine : .arrowDownToLine, size: 15).foregroundStyle(tokens.text2)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(SyncPaths.basename(entry.relativePath)).font(TypeScale.sm).lineLimit(1).truncationMode(.middle)
                            Text("\(entry.direction == .upload ? "Uploaded" : "Downloaded") \(Format.ago(entry.at)) · \(folderName(entry.rootId, snapshot) ?? "")")
                                .font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) { Hairline() }
                }
            }
        }
    }

    @ViewBuilder private func confirmSheet(_ current: SyncConfirm) -> some View {
        switch current {
        case .stop(let folder):
            AsyncConfirm(title: "Stop syncing \(folder.root.name) on this iPhone?",
                         description: "Its files stay in the Files app but no longer sync. Your other devices and My Drive keep syncing.",
                         confirm: "Stop syncing", danger: false) {
                await workspace.attempt("\(folder.root.name) no longer syncs to this iPhone.") { try await sync.stopHere(folder) }
            }
        case .removeEverywhere(let folder):
            AsyncConfirm(title: "Remove “\(folder.root.name)” from sync?",
                         description: "Stop syncing on all linked devices and remove this folder from the app. Local folders and files will stay where they are. Offline devices will stop syncing when they reconnect.",
                         confirm: "Remove from sync") {
                await workspace.attempt("Removed \(folder.root.name) from sync.") {
                    try await sync.removeEverywhere(folderId: folder.root.remoteId ?? "")
                    await catalog.loadSync(workspace.api)
                }
            }
        case .decline(let invite):
            AsyncConfirm(title: "Decline “\(invite.name)”?", description: "\(invite.owner.displayName) can invite you again later.", confirm: "Decline") {
                await workspace.attempt("Declined \(invite.name).") { try await sync.respond(invite, accept: false) }
            }
        case .change:
            EmptyView()
        }
    }
}

private struct PreviewURL: Identifiable { let url: URL; var id: String { url.path } }

enum SyncConfirm: Identifiable {
    case stop(SyncSnapshot.Folder), removeEverywhere(SyncSnapshot.Folder), decline(SyncInvitation), change(String)
    var id: String {
        switch self {
        case .stop(let folder): "stop-" + folder.id
        case .removeEverywhere(let folder): "remove-" + folder.id
        case .decline(let invite): "decline-" + invite.id
        case .change(let id): "change-" + id
        }
    }
}

// MARK: - Folder settings

/// One sync folder on this iPhone: open, pause, exclusions, sharing, change or stop.
struct SyncFolderSheet: View {
    let folderID: String
    let then: (SyncConfirm) -> Void
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var sync: SyncCenter
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    @State private var page: Page = .menu
    @State private var recipient = ""
    @State private var busy = false
    @State private var error: String?
    @State private var newExclusion = ""
    private enum Page { case menu, exclusions, sharing }

    var body: some View {
        if let folder = sync.snapshot.folders.first(where: { $0.id == folderID }) {
            switch page {
            case .menu: menu(folder)
            case .exclusions: exclusions(folder)
            case .sharing: sharing(folder)
            }
        } else {
            FittedSheet { SheetScaffold(title: "Folder removed") { Text("This folder no longer syncs to this iPhone.").font(TypeScale.sm) } }
        }
    }

    private func menu(_ folder: SyncSnapshot.Folder) -> some View {
        let root = folder.root
        let label = SyncLabels.folder(folder, sync.snapshot)
        return SheetMenu(title: root.name) {
            VStack(alignment: .leading, spacing: 6) {
                Badge(text: label, tone: SyncLabels.tone(label), icon: SyncLabels.icon(label))
                DetailsList(rows: [("On this iPhone", SyncFiles.place(root)), ("In harbor0", root.cloudPath ?? "My Drive"),
                                   ("Contents", "\(Format.count(folder.files, "file")), \(Format.count(folder.folders, "folder"))"),
                                   ("Last synced", root.lastSyncedAt.map(Format.full) ?? "Not yet")])
            }.padding(.horizontal, 12).padding(.bottom, 10)
            MenuSeparator()
            MenuRow(title: "Show in Files", icon: .folder) { SyncFiles.open(folder.url) }
            MenuRow(title: root.paused ? "Resume syncing" : "Pause syncing", icon: root.paused ? .play : .pause) {
                Task { if await workspace.attempt(root.paused ? "Syncing \(root.name) again." : "Paused \(root.name).", { try await sync.setPaused(folder, !root.paused) }) { dismiss() } }
            }
            MenuRow(title: "Excluded folders" + (root.excluded.isEmpty ? "" : " (\(root.excluded.count))"), icon: .eyeOff) { page = .exclusions }
            if root.shareId == nil { MenuRow(title: "Share with others", icon: .users) { page = .sharing } }
            if root.place.bookmark != nil { MenuRow(title: "Choose a different folder", icon: .folderInput) { then(.change(root.id)) } }
            MenuSeparator()
            MenuRow(title: "Stop syncing on this iPhone", icon: .x) { then(.stop(folder)) }
            if root.shareId == nil { MenuRow(title: "Remove from sync everywhere", tone: .danger) { then(.removeEverywhere(folder)) } }
        }
    }

    private func exclusions(_ folder: SyncSnapshot.Folder) -> some View {
        let root = folder.root
        let base = folder.url
        let names = base.flatMap { try? LocalFS.children($0) } ?? []
        let subfolders = names.filter { name in
            guard let base, !SyncPaths.internalPath(name), !root.excluded.contains(name) else { return false }
            return (try? LocalInfo.of(base.appendingPathComponent(name)))??.kind == .folder
        }.sorted()
        return FittedSheet {
            SheetScaffold(title: "Excluded folders", description: "Excluded folders stay where they are but don’t sync to or from this iPhone.") {
                VStack(alignment: .leading, spacing: 12) {
                    if root.excluded.isEmpty { Text("Nothing is excluded.").font(TypeScale.sm).foregroundStyle(tokens.text2) }
                    ForEach(root.excluded, id: \.self) { path in
                        HStack {
                            Icon(.eyeOff, size: 15).foregroundStyle(tokens.text2)
                            Text(path).font(TypeScale.sm).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Button("Include") { save(folder, root.excluded.filter { $0 != path }) }.harborButton(.ghost, size: .sm).disabled(busy)
                        }
                    }
                    if !subfolders.isEmpty {
                        Menu {
                            ForEach(subfolders, id: \.self) { name in Button(name) { save(folder, root.excluded + [name]) } }
                        } label: { HStack { Icon(.plus, size: 14); Text("Exclude a folder") } }
                            .harborButton(.outline, size: .sm).disabled(busy)
                    }
                    if let error { AlertBanner(tone: .danger, text: error) }
                    Button("Done") { page = .menu }.harborButton(.outline, size: .lg, block: true)
                }
            }
        }
    }
    private func save(_ folder: SyncSnapshot.Folder, _ excluded: [String]) {
        busy = true
        error = nil
        Task {
            if !(await workspace.attempt { try await sync.setExcluded(folder, excluded) }) { error = workspace.error; workspace.error = nil }
            busy = false
        }
    }

    private func sharing(_ folder: SyncSnapshot.Folder) -> some View {
        let members = sync.invitations.filter { $0.direction == "SENT" && $0.driveItemId == folder.root.remoteId && $0.revokedAt == nil }
        return FittedSheet {
            SheetScaffold(title: "Share “\(folder.root.name)”", description: "Everyone you invite can add, edit, rename and delete files. Changes sync across linked devices. Only you can manage access.") {
                VStack(alignment: .leading, spacing: 14) {
                    Field(label: "Email or username", hint: "Shared folders are kept in the cloud and use your storage.") {
                        TextInput(placeholder: "name@example.com or username", text: $recipient, keyboard: .emailAddress, content: .emailAddress, identifier: "syncRecipient")
                    }
                    Button(busy ? "Please wait…" : "Send invitation") {
                        busy = true; error = nil
                        Task {
                            if await workspace.attempt("Invitation sent. Sync starts after they accept.", { try await sync.invite(folder, recipient: recipient) }) { recipient = "" }
                            else { error = workspace.error; workspace.error = nil }
                            busy = false
                        }
                    }.harborButton(.primary, size: .lg, block: true).disabled(busy || recipient.trimmingCharacters(in: .whitespaces).count < 3)
                    if let error { AlertBanner(tone: .danger, text: error) }
                    if !members.isEmpty {
                        SectionTitle(text: "People with access")
                        ForEach(members) { member in
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(member.recipient.displayName).font(TypeScale.sm)
                                    Text("@\(member.recipient.username) · \(member.syncState == "ACCEPTED" ? "Syncing" : member.syncState == "DECLINED" ? "Declined" : "Invited")")
                                        .font(TypeScale.xs).foregroundStyle(tokens.text2)
                                }
                                Spacer()
                                Button("Remove") {
                                    busy = true
                                    Task {
                                        _ = await workspace.attempt("Access removed. Their local files are kept.") { try await sync.revoke(member) }
                                        busy = false
                                    }
                                }.harborButton(.ghost, size: .sm).disabled(busy)
                            }
                        }
                    }
                    Button("Done") { page = .menu }.harborButton(.outline, size: .lg, block: true)
                }
            }
        }
    }
}

// MARK: - Setup

struct SyncSetupRequest: Identifiable {
    var id = UUID()
    var cloud: CloudChoice? = nil
    var name: String? = nil
    var invitation: SyncInvitation? = nil
    var changeLocal: String? = nil
}

/// Sync a folder to this iPhone: choose the cloud folder, then where it lives on the phone.
struct SyncSetupSheet: View {
    let request: SyncSetupRequest
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var sync: SyncCenter
    @EnvironmentObject private var catalog: WorkspaceCatalog
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    @State private var cloud: CloudChoice?
    @State private var cloudName = ""
    @State private var trail: [Crumb] = []
    @State private var folders: [DriveItem] = []
    @State private var loading = false
    @State private var newName = ""
    @State private var creating = false
    @State private var local = "app"
    @State private var picked: URL?
    @State private var choosing = false
    /// The Files picker was opened from “Start from a folder on this iPhone”.
    @State private var startingLocal = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            SheetScaffold(title: title, description: description, divider: true) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if request.changeLocal == nil && request.invitation == nil {
                        if let cloud { chosen(cloud) } else {
                            if request.cloud == nil && picked == nil { startLocal }
                            browser
                        }
                    }
                    if cloud != nil || request.changeLocal != nil || request.invitation != nil { location }
                    if let error { AlertBanner(tone: .danger, text: error) }
                }.padding(20)
            }
            VStack(spacing: 8) {
                Button(busy ? "Working…" : confirmTitle) { submit() }
                    .harborButton(.primary, size: .lg, block: true).disabled(!ready || busy)
                    .accessibilityIdentifier("startSync")
                Button("Cancel") { dismiss() }.harborButton(.outline, size: .lg, block: true).disabled(busy)
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .overlay(alignment: .top) { Hairline() }
        }
        .cardSurface(paint: false)
        .modifier(TallSheet(large: true))
        .interactiveDismissDisabled(busy)
        .onAppear {
            cloud = request.cloud
            cloudName = request.name ?? ""
            if request.changeLocal != nil { local = "picked" }
        }
        .task(id: trail.last?.id ?? "root") { if cloud == nil && request.changeLocal == nil { await load() } }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.folder]) { result in
            switch result {
            case .success(let url):
                picked = url
                local = "picked"
                if startingLocal && cloud == nil {
                    // Like the desktop app: a matching folder is created in My Drive, which can be changed.
                    let name = (try? url.resourceValues(forKeys: [.localizedNameKey]).localizedName) ?? url.lastPathComponent
                    pick(.new(name: String(name.prefix(200)), parentId: nil, parentPath: "My Drive"), name)
                }
            case .failure(let failure): error = failure.localizedDescription
            }
            startingLocal = false
        }
    }

    private var title: String {
        if request.changeLocal != nil { return "Choose a different folder" }
        if let invite = request.invitation { return "Sync “\(invite.name)”" }
        return "Sync a folder to this iPhone"
    }
    private var description: String {
        if request.changeLocal != nil { return "Files already in the new folder are kept and compared with the cloud. Nothing is deleted." }
        if let invite = request.invitation { return "Shared by \(invite.owner.displayName). Choose where its files go on this iPhone." }
        return "Keep a folder the same on this iPhone, in My Drive and on your other devices."
    }
    private var confirmTitle: String {
        if request.changeLocal != nil { return "Use this folder" }
        if request.invitation?.syncState == "PENDING" || (request.invitation != nil && request.invitation?.syncState == nil) { return "Accept and sync" }
        return "Start syncing"
    }
    private var ready: Bool {
        if request.changeLocal != nil { return picked != nil }
        if request.invitation == nil && cloud == nil { return false }
        return local == "app" || picked != nil
    }

    /// Start from a folder that is already on this iPhone (desktop “Add folder”).
    private var startLocal: some View {
        VStack(alignment: .leading, spacing: 8) {
            FieldLabel(text: "Start from a folder on this iPhone")
            Button { startingLocal = true; choosing = true } label: {
                HStack(alignment: .top, spacing: 12) {
                    Icon(.smartphone, size: 18).foregroundStyle(tokens.accentText).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Choose a folder in Files…").font(TypeScale.baseMedium).foregroundStyle(tokens.text)
                        Text("Its files upload to a new folder in My Drive with the same name. You can pick a different cloud folder next.")
                            .font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Icon(.chevronRight, size: 14).foregroundStyle(tokens.text3).padding(.top, 3)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(PressStyle()).modifier(CardChrome())
            .accessibilityIdentifier("syncFromLocal")
            Text("Or sync a cloud folder to this iPhone").font(TypeScale.xs).foregroundStyle(tokens.text2).padding(.top, 8)
        }
    }

    private func chosen(_ cloud: CloudChoice) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            FieldLabel(text: "Cloud folder")
            HStack(spacing: 12) {
                IconTile(icon: .cloud)
                VStack(alignment: .leading, spacing: 1) {
                    Text(cloudName).font(TypeScale.baseMedium.weight(.semibold)).lineLimit(1)
                    Text(path(cloud)).font(TypeScale.xs).foregroundStyle(tokens.text2).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                if request.cloud == nil { Button("Change") { self.cloud = nil }.harborButton(.ghost, size: .sm).accessibilityIdentifier("changeCloudFolder") }
            }
            .padding(12).modifier(CardChrome())
        }
    }
    private func path(_ cloud: CloudChoice) -> String {
        switch cloud {
        case .existing(_, let path): path
        case .new(let name, _, let parent): "\(parent) / \(name) (new)"
        case .share: "Shared with you"
        }
    }

    private var browser: some View {
        VStack(alignment: .leading, spacing: 10) {
            FieldLabel(text: "Choose a cloud folder")
            let local = Set(sync.snapshot.folders.compactMap(\.root.remoteId))
            let synced = catalog.syncFolders.filter { !local.contains($0.id) }
            if trail.isEmpty && !synced.isEmpty {
                Text("Already syncing on your other devices").font(TypeScale.xs).foregroundStyle(tokens.text2)
                VStack(spacing: 0) {
                    ForEach(synced) { item in
                        folderRow(item, icon: .refreshCw) { pick(.existing(id: item.id, path: "My Drive / \(item.name)"), item.name) }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).modifier(CardChrome())
                Text("Or choose any folder in My Drive").font(TypeScale.xs).foregroundStyle(tokens.text2).padding(.top, 4)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    crumb("My Drive", current: trail.isEmpty) { trail = [] }
                    ForEach(Array(trail.enumerated()), id: \.element.id) { index, entry in
                        Icon(.chevronRight, size: 13).foregroundStyle(tokens.text3)
                        crumb(entry.name, current: index == trail.count - 1) { trail = Array(trail.prefix(index + 1)) }
                    }
                }
            }
            VStack(spacing: 0) {
                if loading { Text("Loading folders…").font(TypeScale.sm).foregroundStyle(tokens.text2).padding(12) }
                else if folders.isEmpty { Text("No subfolders").font(TypeScale.sm).foregroundStyle(tokens.text2).padding(12) }
                ForEach(folders) { item in
                    folderRow(item, icon: .folder) { trail.append(Crumb(id: item.id, name: item.name)) }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).modifier(CardChrome())
            HStack(spacing: 8) {
                if let current = trail.last {
                    Button("Sync “\(current.name)”") {
                        pick(.existing(id: current.id, path: (["My Drive"] + trail.map(\.name)).joined(separator: " / ")), current.name)
                    }.harborButton(.outline, size: .sm).accessibilityIdentifier("chooseCloudFolder")
                }
                Button { creating.toggle() } label: { Icon(.folderPlus, size: 14); Text("New folder") }.harborButton(.ghost, size: .sm)
            }
            if creating {
                HStack(spacing: 8) {
                    TextInput(placeholder: "Folder name", text: $newName, autocapitalize: true, identifier: "newSyncFolder")
                    Button("Use") {
                        let name = newName.trimmingCharacters(in: .whitespaces)
                        pick(.new(name: name, parentId: trail.last?.id, parentPath: (["My Drive"] + trail.map(\.name)).joined(separator: " / ")), name)
                    }.harborButton(.primary, size: .sm).disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
    private func folderRow(_ item: DriveItem, icon: Lucide, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Icon(icon, size: 16).foregroundStyle(tokens.primary)
                Text(item.name).font(TypeScale.base).lineLimit(1)
                Spacer()
                Icon(.chevronRight, size: 14).foregroundStyle(tokens.text3)
            }.padding(.horizontal, 12).frame(height: 46).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .overlay(alignment: .bottom) { Hairline() }
        .accessibilityIdentifier("cloudFolder-" + item.name)
    }
    private func crumb(_ name: String, current: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(name).font(current ? TypeScale.smMedium : TypeScale.sm).foregroundStyle(current ? tokens.text : tokens.text2)
                .padding(.horizontal, 6).padding(.vertical, 4)
        }.buttonStyle(.plain)
    }
    private func pick(_ choice: CloudChoice, _ name: String) {
        cloud = choice
        cloudName = name
        creating = false
    }
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            var all: [DriveItem] = []
            var cursor: String?
            repeat {
                let page = try await workspace.api.list(parentID: trail.last?.id, cursor: cursor)
                all += page.items
                cursor = page.nextCursor
            } while cursor != nil
            let here = Set(sync.snapshot.folders.compactMap(\.root.remoteId))
            folders = all.filter { $0.isFolder && $0.backupRootId == nil && !catalog.backupFolderIDs.keys.contains($0.id) && !here.contains($0.id) }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }

    private var location: some View {
        VStack(alignment: .leading, spacing: 10) {
            FieldLabel(text: "On this iPhone")
            if request.changeLocal == nil {
                option("app", "In harbor0’s folder", "On My iPhone › harbor0 in the Files app. Recommended.", icon: .smartphone)
            }
            option("picked", picked.map { "“\($0.lastPathComponent)”" } ?? "Choose a folder…",
                   picked == nil ? "Any folder in the Files app, such as On My iPhone or iCloud Drive." : "Files already there are kept and compared with the cloud.",
                   icon: .folderInput) { choosing = true }
            Text("Every file in this folder is downloaded and kept on this iPhone. Large folders use a lot of space.")
                .font(TypeScale.xs).foregroundStyle(tokens.text3).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func option(_ value: String, _ title: String, _ detail: String, icon: Lucide, action: (() -> Void)? = nil) -> some View {
        let on = local == value
        return Button {
            if let action { action() } else { local = value }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Icon(icon, size: 18).foregroundStyle(on ? tokens.accentText : tokens.text2).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(TypeScale.baseMedium).foregroundStyle(tokens.text)
                    Text(detail).font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if on { Icon(.check, size: 16).foregroundStyle(tokens.accentText) }
            }
            .padding(12)
            .background(on ? tokens.accentSoft.opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(on ? tokens.primary : tokens.line, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("syncLocation-" + value)
    }

    private func submit() {
        busy = true
        error = nil
        let choice: LocalChoice = local == "picked" && picked != nil ? .picked(picked!) : .app
        Task {
            let done = await workspace.attempt(nil) {
                if let id = request.changeLocal {
                    guard let folder = sync.snapshot.folders.first(where: { $0.id == id }), let picked else { return }
                    try await sync.changeLocal(folder, to: picked)
                    workspace.notify("\(folder.root.name) now syncs with “\(picked.lastPathComponent)”.")
                } else if let invite = request.invitation {
                    if invite.syncState != "ACCEPTED" { try await sync.respond(invite, accept: true) }
                    try await sync.addSync(cloud: .share(id: invite.id), local: choice)
                    workspace.notify("“\(invite.name)” is syncing to this iPhone.")
                } else if let cloud {
                    try await sync.addSync(cloud: cloud, local: choice)
                    workspace.notify("“\(cloudName)” is syncing to this iPhone.")
                }
            }
            busy = false
            if done {
                await catalog.loadSync(workspace.api)
                dismiss()
            } else { error = workspace.error; workspace.error = nil }
        }
    }
}
