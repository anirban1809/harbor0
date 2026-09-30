import SwiftUI
import Combine

enum WorkspaceTab: String, CaseIterable, Identifiable {
    case drive = "Drive", sync = "Sync", backups = "Backups", trash = "Trash", settings = "Settings"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .drive: return "externaldrive"
        case .sync: return "arrow.triangle.2.circlepath"
        case .backups: return "clock.arrow.circlepath"
        case .trash: return "trash"
        case .settings: return "gearshape"
        }
    }
}

@MainActor
final class WorkspaceCatalog: ObservableObject {
    @Published private(set) var syncFolders: [DriveItem] = []
    @Published private(set) var backups: [BackupRoot] = []
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
    var specialIDs: Set<String> { Set(syncFolders.map(\.id) + backups.map(\.remoteRootDriveItemId)) }

    func load(_ api: HarborAPI) async {
        async let sync: Void = loadSync(api)
        async let backup: Void = loadBackups(api)
        _ = await (sync, backup)
    }
    func loadSync(_ api: HarborAPI) async {
        guard !loadingSync else { return }
        loadingSync = true
        defer { loadingSync = false }
        do {
            let result: FolderCatalog = try await api.request("/v1/sync/folders")
            try Task.checkCancellation()
            syncFolders = result.items
            haveSync = true
            syncError = nil
            var all: [String: SyncStatus] = [:]
            do {
                for start in stride(from: 0, to: result.items.count, by: 50) {
                    let ids = result.items[start..<min(start + 50, result.items.count)].map(\.id).joined(separator: ",")
                    let status: SyncStatusPage = try await api.request("/v1/sync/status?ids=\(ids)&recursive=true")
                    for item in status.items { all[item.itemId] = item }
                }
                statuses = all
                statusError = nil
            } catch { statusError = error.localizedDescription; statuses = [:] }
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
            backups = result.items.filter { $0.state != "REMOVED" }
            haveBackups = true
            backupError = nil
        } catch is CancellationError { }
        catch { backupError = error.localizedDescription }
    }
}

struct WorkspaceView: View {
    @ObservedObject var api: HarborAPI
    @EnvironmentObject var appearance: AppearanceStore
    @EnvironmentObject var transfers: TransferState
    @Environment(\.harborPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var catalog = WorkspaceCatalog()
    @State private var selected: WorkspaceTab = .drive
    @State private var drivePath = NavigationPath()
    @State private var syncPath = NavigationPath()
    @State private var backupPath = NavigationPath()

    var body: some View {
        TabView(selection: $selected) {
            NavigationStack(path: $drivePath) { DriveView(api: api, folder: nil, readOnly: false) }.tag(WorkspaceTab.drive)
            NavigationStack(path: $syncPath) { SyncView(api: api) }.tag(WorkspaceTab.sync)
            NavigationStack(path: $backupPath) { BackupsView(api: api) }.tag(WorkspaceTab.backups)
            NavigationStack { TrashView(api: api) }.tag(WorkspaceTab.trash)
            NavigationStack { SettingsView(api: api) }.tag(WorkspaceTab.settings)
        }
        .toolbar(.hidden, for: .tabBar)
        .environmentObject(catalog)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let label = transfers.label {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(label).font(.subheadline).lineLimit(2)
                            Spacer()
                            Button("Cancel") { transfers.cancel() }
                        }
                        if let progress = transfers.progress { ProgressView(value: progress) }
                        else { ProgressView() }
                        Text("Keep harbor0 open until the transfer finishes.").font(.caption).foregroundStyle(palette.cardInk.opacity(0.65))
                    }.padding().foregroundStyle(palette.cardInk).background(palette.card)
                }
                Rectangle().fill(palette.border).frame(height: 1)
                HStack(spacing: 0) {
                    ForEach(WorkspaceTab.allCases) { tab in
                        Button {
                            selected = tab
                        } label: {
                            VStack(spacing: 5) {
                                Image(systemName: tab.symbol).font(.system(size: 20, weight: selected == tab ? .semibold : .regular))
                                    .accessibilityHidden(true)
                                Text(tab.rawValue).font(.caption2.weight(selected == tab ? .semibold : .medium))
                                    .lineLimit(1).minimumScaleFactor(0.8)
                            }
                            .frame(maxWidth: .infinity, minHeight: 54)
                            .foregroundStyle(selected == tab ? palette.accent : palette.sidebarInk.opacity(0.65))
                            .background(selected == tab ? palette.accent.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .accessibilityIdentifier("tab-" + tab.rawValue.lowercased())
                            .accessibilityLabel(tab.rawValue)
                            .accessibilityAddTraits(selected == tab ? [.isSelected] : [])
                    }
                }.padding(.horizontal, 10).padding(.vertical, 8)
                    .background(palette.sidebar.ignoresSafeArea(edges: .bottom))
            }
        }
        .task {
            async let theme: Void = appearance.load(api)
            async let data: Void = catalog.load(api)
            _ = await (theme, data)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await appearance.load(api); await catalog.load(api) } }
        }
    }
}

struct NoticeRow: View {
    let text: String
    var symbol = "info.circle"
    @Environment(\.harborPalette) private var palette
    var body: some View {
        Label(text, systemImage: symbol).font(.subheadline).foregroundStyle(palette.ink.opacity(0.7))
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}

struct LoadFailure: View {
    let message: String
    let retry: () -> Void
    @Environment(\.harborPalette) private var palette
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: "exclamationmark.circle").font(.subheadline)
            Button("Try again", action: retry).font(.subheadline.weight(.semibold))
        }.padding(.vertical, 4).listRowBackground(palette.card)
    }
}

struct StatusBadge: View {
    let text: String
    @Environment(\.harborPalette) private var palette
    var body: some View {
        Text(text).font(.caption.weight(.medium)).foregroundStyle(palette.cardInk)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(palette.cardInk.opacity(0.07), in: Capsule())
    }
}
