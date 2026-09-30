import SwiftUI

struct TrashView: View {
    @ObservedObject var api: HarborAPI
    @EnvironmentObject var catalog: WorkspaceCatalog
    @Environment(\.harborPalette) private var palette
    @State private var items: [DriveItem] = []
    @State private var cursor: String?
    @State private var loaded = false
    @State private var loading = false
    @State private var busy = false
    @State private var error: String?
    @State private var pending: DriveItem?
    @State private var confirmDelete = false
    @State private var confirmEmpty = false
    var body: some View {
        List {
            NoticeRow(text: "Restore files to your drive or delete them permanently.", symbol: "trash")
            if let error { LoadFailure(message: error) { Task { await load() } } }
            if loaded && items.isEmpty && error == nil {
                ContentUnavailableView("Trash is empty", systemImage: "trash", description: Text("Files you remove from your drive will appear here."))
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 10) {
                        FileRow(item: item, detail: item.deletedAt.map { "Deleted " + dateLabel($0) }, showsDownload: false)
                        HStack {
                            Button("Restore", systemImage: "arrow.uturn.backward") { Task { await mutate(item, action: .restore) } }
                                .accessibilityIdentifier("restore-" + item.id)
                            Spacer()
                            Button("Delete", systemImage: "trash", role: .destructive) { pending = item; confirmDelete = true }
                                .accessibilityIdentifier("delete-" + item.id)
                        }.font(.subheadline).buttonStyle(.borderless).disabled(busy).padding(.leading, 52)
                    }.padding(.vertical, 4)
                }
            }.listRowBackground(palette.card).listRowSeparatorTint(palette.border)
            if loading { ProgressView("Loading trash…").listRowBackground(Color.clear) }
            if cursor != nil && !loading { Button("Load more files") { Task { await load(more: true) } }.disabled(busy).listRowBackground(palette.card) }
        }.navigationTitle("Trash").workspaceStyle()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Empty trash", role: .destructive) { confirmEmpty = true }
                        .disabled(busy || loading || items.isEmpty).accessibilityIdentifier("emptyTrash")
                }
            }
            .task { await load() }.refreshable { await load() }
            .confirmationDialog("Delete this item permanently?", isPresented: $confirmDelete, titleVisibility: .visible, presenting: pending) { item in
                Button("Delete permanently", role: .destructive) { Task { await mutate(item, action: .permanent) } }
            } message: { item in Text("\(item.name) will be permanently deleted. This cannot be undone.") }
            .confirmationDialog("Empty trash?", isPresented: $confirmEmpty, titleVisibility: .visible) {
                Button("Empty trash", role: .destructive) {
                    busy = true
                    Task {
                        defer { busy = false }
                        do { try await api.emptyTrash(); await load() }
                        catch { self.error = error.localizedDescription }
                    }
                }
            } message: { Text("All items in your trash will be permanently deleted. This cannot be undone.") }
    }
    private func load(more: Bool = false) async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let page = try await api.trashPage(cursor: more ? cursor : nil)
            try Task.checkCancellation()
            items = more ? items + page.items.filter { incoming in !items.contains { $0.id == incoming.id } } : page.items
            cursor = page.nextCursor; loaded = true
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    private func mutate(_ item: DriveItem, action: HarborAPI.TrashAction) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { try await api.changeTrash(item, action: action); catalog.revision += 1; await load() }
        catch { self.error = error.localizedDescription }
    }
}
