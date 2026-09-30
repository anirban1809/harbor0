import SwiftUI

struct SyncView: View {
    @ObservedObject var api: HarborAPI
    @EnvironmentObject var catalog: WorkspaceCatalog
    @Environment(\.harborPalette) private var palette
    var body: some View {
        List {
            NoticeRow(text: "Browse folders linked to your computers. Automatic sync runs on the desktop app.", symbol: "arrow.triangle.2.circlepath")
            if let error = catalog.syncError {
                LoadFailure(message: error) { Task { await catalog.loadSync(api) } }
            }
            if let error = catalog.statusError {
                LoadFailure(message: "Could not refresh sync status. " + error) { Task { await catalog.loadSync(api) } }
            }
            if catalog.loadingSync && !catalog.haveSync { ProgressView("Loading synced folders…").listRowBackground(Color.clear) }
            if catalog.haveSync && catalog.syncFolders.isEmpty && catalog.syncError == nil {
                ContentUnavailableView("No synced folders", systemImage: "arrow.triangle.2.circlepath", description: Text("Connect a folder in the harbor0 desktop app to find it here."))
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(catalog.syncFolders) { folder in
                    NavigationLink {
                        DriveView(api: api, folder: folder, readOnly: false, location: .sync)
                    } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            FileRow(item: folder, detail: "Synced folder")
                            if let status = catalog.statuses[folder.id] {
                                HStack {
                                    StatusBadge(text: status.label)
                                    Spacer()
                                    if status.requiredDevices > 0 {
                                        Text("\(status.confirmedDevices)/\(status.requiredDevices) devices").font(.caption).foregroundStyle(palette.cardInk.opacity(0.65))
                                    }
                                }.padding(.leading, 52)
                            }
                        }.padding(.vertical, 3)
                    }.accessibilityIdentifier("sync-" + folder.name)
                }
            }.listRowBackground(palette.card).listRowSeparatorTint(palette.border)
        }.navigationTitle("Sync").workspaceStyle()
            .task { await catalog.loadSync(api) }
            .refreshable { await catalog.loadSync(api) }
    }
}

struct BackupsView: View {
    @ObservedObject var api: HarborAPI
    @EnvironmentObject var catalog: WorkspaceCatalog
    @Environment(\.harborPalette) private var palette
    var body: some View {
        List {
            NoticeRow(text: "Browse saved files and backup history. Manage automatic backups on the source computer.", symbol: "clock.arrow.circlepath")
            if let error = catalog.backupError { LoadFailure(message: error) { Task { await catalog.loadBackups(api) } } }
            if catalog.loadingBackups && !catalog.haveBackups { ProgressView("Loading backups…").listRowBackground(Color.clear) }
            if catalog.haveBackups && catalog.backups.isEmpty && catalog.backupError == nil {
                ContentUnavailableView("No backups yet", systemImage: "clock.arrow.circlepath", description: Text("Add a backup folder in harbor0 on your computer. Its saved files will appear here."))
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(catalog.backups) { root in
                    NavigationLink {
                        DriveView(api: api, folder: root.folder, readOnly: true, location: .backup)
                            .toolbar {
                                ToolbarItem(placement: .topBarTrailing) {
                                    NavigationLink { BackupHistoryView(api: api, root: root) } label: { Image(systemName: "clock") }
                                        .accessibilityLabel("Backup history").accessibilityIdentifier("backupHistory")
                                }
                            }
                    } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            FileRow(item: root.folder, detail: root.deviceName ?? "Source computer")
                            StatusBadge(text: root.state.capitalized).padding(.leading, 52)
                        }.padding(.vertical, 3)
                    }.accessibilityIdentifier("backup-" + root.localPathDisplayName)
                }
            }.listRowBackground(palette.card).listRowSeparatorTint(palette.border)
        }.navigationTitle("Backups").workspaceStyle()
            .task { await catalog.loadBackups(api) }
            .refreshable { await catalog.loadBackups(api) }
    }
}

struct BackupHistoryView: View {
    @ObservedObject var api: HarborAPI
    let root: BackupRoot
    @Environment(\.harborPalette) private var palette
    @State private var runs: [BackupRun] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var error: String?
    var body: some View {
        List {
            NoticeRow(text: root.localPathDisplayName, symbol: "folder")
            if let error { LoadFailure(message: error) { Task { await load() } } }
            if loaded && runs.isEmpty && error == nil {
                ContentUnavailableView("No backup history", systemImage: "clock", description: Text("Completed and in-progress backups will appear here."))
                    .listRowBackground(Color.clear)
            }
            ForEach(runs) { run in
                VStack(alignment: .leading, spacing: 10) {
                    HStack { Text(run.trigger == "MANUAL" ? "Manual backup" : "Automatic backup").font(.headline); Spacer(); StatusBadge(text: run.state.capitalized) }
                    Text(dateLabel(run.startedAt)).font(.subheadline).foregroundStyle(palette.cardInk.opacity(0.65))
                    Text("\(run.fileCount) files · \(ByteCountFormatter.string(fromByteCount: run.sizeBytes, countStyle: .file))").font(.caption)
                    if let failure = run.error { Text(failure).font(.caption).foregroundStyle(.red) }
                }.padding(.vertical, 5).listRowBackground(palette.card)
            }
            if loading { ProgressView("Loading history…").listRowBackground(Color.clear) }
            if cursor != nil && !loading { Button("Load more history") { Task { await load(more: true) } }.listRowBackground(palette.card) }
        }.navigationTitle("Backup history").navigationBarTitleDisplayMode(.inline).workspaceStyle()
            .task { await load() }.refreshable { await load() }
    }
    private func load(more: Bool = false) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let page: BackupRunPage = try await api.request(HarborAPI.pagePath("/v1/backups/\(root.id)/runs", cursor: more ? cursor : nil))
            try Task.checkCancellation()
            runs = more ? runs + page.items.filter { incoming in !runs.contains { $0.id == incoming.id } } : page.items
            cursor = page.nextCursor; loaded = true
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}

func dateLabel(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    return date?.formatted(date: .abbreviated, time: .shortened) ?? value
}
