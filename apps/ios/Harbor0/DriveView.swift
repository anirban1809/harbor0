import SwiftUI
import QuickLook
import Combine

@MainActor
final class TransferState: ObservableObject {
    @Published var label: String?
    @Published var progress: Double?
    @Published var error: String?
    @Published var previewURL: URL?
    @Published var showingPreview = false
    @Published var revision = 0
    private var task: Task<Void, Never>?
    private let files: FileTransfers
    private var generation = UUID()
    var busy: Bool { label != nil }

    init(api: HarborAPI) { files = FileTransfers(api: api) }

    func upload(_ url: URL, parentID: String?) {
        run { [files] update in try await files.upload(url, parentID: parentID, progress: update); return nil }
    }
    func download(_ item: DriveItem) {
        run { [files] update in try await files.download(item, progress: update) }
    }
    private func run(_ work: @escaping (@escaping @MainActor @Sendable (String, Double?) -> Void) async throws -> URL?) {
        guard !busy else { return }
        label = "Preparing…"
        progress = nil
        error = nil
        let stamp = generation
        task = Task {
            defer { if generation == stamp { label = nil; progress = nil; task = nil } }
            do {
                let url = try await work { [weak self] label, progress in
                    guard let self, self.generation == stamp else { return }
                    self.label = label
                    self.progress = progress
                }
                guard generation == stamp, !Task.isCancelled else {
                    if let url { FileTransfers.removePreview(url) }
                    return
                }
                previewURL = url
                showingPreview = url != nil
                revision += 1
            } catch {
                guard generation == stamp, !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
    }
    func cancel() { task?.cancel() }
    func dismissPreview() {
        if let previewURL { FileTransfers.removePreview(previewURL) }
        previewURL = nil
    }
    func reset() {
        generation = UUID()
        task?.cancel()
        task = nil
        label = nil
        error = nil
        showingPreview = false
        dismissPreview()
    }
}

enum DriveLocation { case cloud, sync, backup }

struct DriveView: View {
    @ObservedObject var api: HarborAPI
    @EnvironmentObject var transfers: TransferState
    @EnvironmentObject var catalog: WorkspaceCatalog
    @Environment(\.harborPalette) private var palette
    let folder: DriveItem?
    let readOnly: Bool
    var location: DriveLocation = .cloud
    @State private var items: [DriveItem] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var error: String?
    @State private var importing = false
    @State private var creatingFolder = false
    @State private var folderName = ""
    @State private var creating = false
    @State private var pendingTrash: DriveItem?
    @State private var confirmTrash = false
    private var ready: Bool { location != .cloud || catalog.ready }
    private var visibleItems: [DriveItem] {
        location == .cloud ? items.filter { !catalog.specialIDs.contains($0.id) && $0.backupRootId == nil } : items
    }

    var body: some View {
        List {
            if readOnly { NoticeRow(text: "Backup files are read only. Download a file to save a copy.", symbol: "lock") }
            else if folder == nil { NoticeRow(text: "Your files in the cloud", symbol: "cloud") }
            if let error { LoadFailure(message: error) { Task { await load() } } }
            if location == .cloud, let message = catalog.syncError ?? catalog.backupError {
                LoadFailure(message: "Could not refresh your drive locations. " + message) { Task { await catalog.load(api) } }
            }
            if ready && loaded && visibleItems.isEmpty && cursor == nil && error == nil {
                ContentUnavailableView {
                    Label("No files yet", systemImage: "folder")
                } description: {
                    Text(readOnly ? "Files backed up from your computer will appear here." : "Upload a file to keep it within reach.")
                } actions: {
                    if !readOnly { Button("Upload a file") { importing = true }.buttonStyle(.bordered).disabled(transfers.busy) }
                }.listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if ready {
                Section {
                    ForEach(visibleItems) { item in
                        Group {
                            if item.isFolder {
                                NavigationLink(value: item) { FileRow(item: item) }
                                    .accessibilityIdentifier("folder-" + item.name)
                            } else {
                                Button {
                                    if item.cloudState == "RELEASED" { Task { await requestCopy(item) } }
                                    else { transfers.download(item) }
                                } label: {
                                    FileRow(item: item, detail: item.cloudState == "RELEASED" ? "On your computer · Request a copy" : item.cloudState == "REQUESTED" ? "Waiting for your computer" : nil)
                                }.buttonStyle(.plain).disabled(transfers.busy || item.cloudState == "REQUESTED")
                                    .accessibilityIdentifier("file-" + item.name)
                            }
                        }
                        .contextMenu {
                            if !readOnly && location == .cloud {
                                Button("Move to trash", systemImage: "trash", role: .destructive) { pendingTrash = item; confirmTrash = true }
                                    .disabled(transfers.busy || creating)
                            }
                        }
                    }
                }.listRowBackground(palette.card).listRowSeparatorTint(palette.border)
            }
            if loading || (!ready && catalog.syncError == nil && catalog.backupError == nil) {
                HStack { Spacer(); ProgressView("Loading files…"); Spacer() }.listRowBackground(Color.clear)
            }
            if cursor != nil && !loading {
                Button("Load more files") { Task { await load(more: true) } }
                    .frame(maxWidth: .infinity).accessibilityIdentifier("loadMore").listRowBackground(palette.card)
            }
        }
        .listStyle(.insetGrouped).workspaceStyle()
        .navigationTitle(folder?.name ?? "My Drive")
        .navigationDestination(for: DriveItem.self) { item in
            DriveView(api: api, folder: item, readOnly: readOnly || item.backupRootId != nil, location: location)
        }
        .toolbar {
            if !readOnly {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Upload a file", systemImage: "arrow.up.doc") { importing = true }
                        Button("New folder", systemImage: "folder.badge.plus") { folderName = ""; creatingFolder = true }
                    } label: { Image(systemName: "plus") }
                        .disabled(transfers.busy || creating || !ready).accessibilityLabel("Add files").accessibilityIdentifier("addFiles")
                }
            }
        }
        .refreshable { await catalog.load(api); await load() }
        .task(id: transfers.revision + catalog.revision) { await load() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url): transfers.upload(url, parentID: folder?.id)
            case .failure(let failure): error = failure.localizedDescription
            }
        }
        .alert("New folder", isPresented: $creatingFolder) {
            TextField("Folder name", text: $folderName)
            Button("Cancel", role: .cancel) {}
            Button("Create") { Task { await createFolder() } }
                .disabled(folderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("Move to trash?", isPresented: $confirmTrash, titleVisibility: .visible, presenting: pendingTrash) { item in
            Button("Move to trash", role: .destructive) {
                Task {
                    do { try await api.changeTrash(item, action: .trash); await load() }
                    catch { self.error = error.localizedDescription }
                }
            }
        } message: { item in Text("You can restore \(item.name) from Trash.") }
    }

    private func load(more: Bool = false) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let page = try await api.list(parentID: folder?.id, cursor: more ? cursor : nil)
            try Task.checkCancellation()
            if more {
                let existing = Set(items.map(\.id))
                items += page.items.filter { !existing.contains($0.id) }
            } else { items = page.items }
            cursor = page.nextCursor; loaded = true
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func createFolder() async {
        creating = true
        defer { creating = false }
        do {
            try await api.createFolder(name: folderName.trimmingCharacters(in: .whitespacesAndNewlines), parentID: folder?.id)
            await load()
        } catch { self.error = error.localizedDescription }
    }
    private func requestCopy(_ item: DriveItem) async {
        do {
            let _: ItemResponse = try await api.request("/v1/sync/items/\(item.id)/request-content", method: "POST")
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

struct FileRow: View {
    let item: DriveItem
    var detail: String? = nil
    var showsDownload = true
    @Environment(\.harborPalette) private var palette
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.symbol).font(.system(size: 20, weight: .regular))
                .foregroundStyle(palette.accent).frame(width: 40, height: 40)
                .background(palette.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(.body).foregroundStyle(palette.cardInk).lineLimit(2)
                Text(detail ?? (item.isFolder ? "Folder" : item.sizeLabel))
                    .font(.caption).foregroundStyle(palette.cardInk.opacity(0.65))
            }
            Spacer(minLength: 0)
            if !item.isFolder && showsDownload { Image(systemName: "arrow.down.circle").foregroundStyle(palette.cardInk.opacity(0.5)).accessibilityHidden(true) }
        }.padding(.vertical, 3).contentShape(Rectangle())
            .accessibilityElement(children: .combine)
    }
}
