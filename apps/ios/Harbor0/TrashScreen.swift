import SwiftUI

@MainActor
final class TrashModel: ObservableObject {
    @Published private(set) var items: [DriveItem] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var cursor: String?
    @Published private(set) var loading = true
    @Published private(set) var failed: String?
    @Published var selected: Set<String> = []
    @Published var grid = false
    @Published var busy = false
    private var loadedKey = ""

    func load(_ workspace: Workspace, cursor next: String? = nil, keepPage: Bool = false) async {
        let query = workspace.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let page = keepPage ? cursor : next
        let key = query + "|" + (page ?? "")
        if key != loadedKey { loading = true; items = [] }
        do {
            var path = "/v1/search?trash=true"
            if !query.isEmpty { path += "&q=" + DriveModel.encode(query) }
            let result: DrivePage = try await workspace.api.request(HarborAPI.pagePath(path, cursor: page))
            try Task.checkCancellation()
            items = result.items
            nextCursor = result.nextCursor
            cursor = page
            failed = nil
            loadedKey = key
            selected = selected.filter { id in result.items.contains { $0.id == id } }
        } catch is CancellationError {
        } catch { failed = error.localizedDescription }
        loading = false
    }
    /// Removes items optimistically; any that fail come back with an error (use-optimistic-removal.ts).
    func remove(_ targets: [DriveItem], action: HarborAPI.TrashAction, workspace: Workspace) async {
        selected = []
        let ids = Set(targets.map(\.id))
        let previous = items
        items.removeAll { ids.contains($0.id) }
        var errors: [String] = []
        var failedIDs = Set<String>()
        for item in targets {
            do { try await workspace.api.changeTrash(item, action: action) }
            catch {
                failedIDs.insert(item.id)
                errors.append("Could not \(action == .restore ? "restore" : "delete") “\(item.name)”. \(error.localizedDescription)")
            }
        }
        if !errors.isEmpty {
            workspace.error = errors.joined(separator: " ")
            items = previous.filter { !ids.contains($0.id) || failedIDs.contains($0.id) }
        }
        workspace.changed()
        await workspace.refreshAccount()
        await load(workspace, keepPage: true)
    }
    func empty(_ workspace: Workspace) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await workspace.api.emptyTrash()
            cursor = nil
            await load(workspace)
            await workspace.refreshAccount()
            workspace.notify("Trash emptied.")
            return true
        } catch { workspace.fail(error); return false }
    }
}

enum TrashSheet: Identifiable {
    case menu(DriveItem), permanent([DriveItem]), empty
    var id: String {
        switch self {
        case .menu(let item): "menu-" + item.id
        case .permanent(let items): "delete-" + items.map(\.id).joined()
        case .empty: "empty"
        }
    }
}

/// Trash: restore or permanently delete, with search, selection and pagination.
struct TrashScreen: View {
    @ObservedObject var model: TrashModel
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.tokens) private var tokens
    @State private var sheet: TrashSheet?
    @State private var next: TrashSheet?
    private var query: String { workspace.query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var selection: [DriveItem] { model.items.filter { model.selected.contains($0.id) } }

    var body: some View {
        PageScroll(bottom: selection.isEmpty ? 32 : 104) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        PageTitle(text: "Trash")
                        if !query.isEmpty { Text("Items in Trash matching “\(query)”").font(TypeScale.sm).foregroundStyle(tokens.text2) }
                    }
                    Spacer(minLength: 8)
                    if !query.isEmpty { ClearSearchButton() }
                }
                if !selection.isEmpty {
                    HStack {
                        Text("\(selection.count) selected").font(TypeScale.baseMedium.weight(.semibold))
                        Spacer()
                        Button { model.selected = [] } label: { Icon(.x, size: 18) }.harborButton(.ghost, size: .icon).accessibilityLabel("Clear selection")
                    }.frame(minHeight: 40)
                } else {
                    HStack(spacing: 8) {
                        Badge(text: model.loading ? "Loading…" : model.failed != nil && model.items.isEmpty ? "Unavailable"
                              : "\(model.items.count) \(model.items.count == 1 ? "item" : "items")\(model.cursor != nil || model.nextCursor != nil ? " on this page" : "")")
                            .font(TypeScale.sm)
                        Spacer()
                        Button { sheet = .empty } label: { Icon(.trash, size: 16); Text("Empty Trash") }
                            .harborButton(.outline)
                            .disabled(model.busy || model.loading || model.failed != nil || (model.items.isEmpty && model.cursor == nil && model.nextCursor == nil && query.isEmpty))
                            .accessibilityIdentifier("emptyTrash")
                        ViewSwitch(grid: $model.grid)
                    }
                }
                if model.loading {
                    SkeletonRows()
                } else if model.failed != nil && model.items.isEmpty {
                    LoadErrorView(title: "We couldn’t load these files.") { Task { await model.load(workspace, keepPage: true) } }
                } else if model.items.isEmpty {
                    if !query.isEmpty {
                        EmptyStateView(icon: .search, title: "No matching files", description: "Try a different name or clear your search to see your files again.") {
                            Button("Clear search") { workspace.query = "" }.harborButton(.outline)
                        }
                    } else {
                        EmptyStateView(icon: .trash, title: "Trash is empty", description: "Files you move to trash will appear here. You can restore them or delete them permanently.") {
                            Button("Browse My Drive") { workspace.navigate(.drive) }.harborButton(.outline)
                        }
                    }
                } else if model.grid {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                        ForEach(model.items) { item in
                            FileGridCard(item: item, selected: model.selected.contains(item.id), selecting: !model.selected.isEmpty,
                                         toggle: { toggle(item) }, open: { open(item) }, actions: { sheet = .menu(item) })
                        }
                    }
                } else {
                    VStack(spacing: 0) {
                        HStack(spacing: 14) {
                            Button {
                                let all = Set(model.items.map(\.id))
                                model.selected = model.selected.isSuperset(of: all) ? [] : all
                            } label: {
                                CheckBox(checked: model.selected.isSuperset(of: Set(model.items.map(\.id))),
                                         mixed: !model.selected.isEmpty).frame(width: 32, height: 40).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityLabel("Select all files on this page")
                            Text("Name").font(TypeScale.smMedium).foregroundStyle(tokens.text2)
                            Spacer()
                        }.frame(height: 40)
                        Hairline()
                        ForEach(model.items) { item in
                            FileRowView(item: item, selected: model.selected.contains(item.id), selecting: !model.selected.isEmpty,
                                        trashIcon: true, toggle: { toggle(item) }, open: { open(item) }, actions: { sheet = .menu(item) })
                        }
                    }
                }
                if model.cursor != nil || model.nextCursor != nil {
                    HStack(spacing: 8) {
                        if model.cursor != nil {
                            Button("First page") { model.selected = []; Task { await model.load(workspace) } }.harborButton(.outline)
                        }
                        if let next = model.nextCursor {
                            Button("Next page") { model.selected = []; Task { await model.load(workspace, cursor: next) } }.harborButton(.outline)
                        }
                    }.frame(maxWidth: .infinity)
                }
            }
        }
        .refreshable { await model.load(workspace, keepPage: true) }
        .overlay(alignment: .bottom) {
            if !selection.isEmpty {
                HStack(spacing: 0) {
                    dock("Restore", .rotateCcw) { Task { await model.remove(selection, action: .restore, workspace: workspace) } }
                    dock("Delete permanently", .trash) { sheet = .permanent(selection) }
                }
                .padding(6)
                .background(tokens.background, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(tokens.line, lineWidth: 1))
                .shadow(color: tokens.shadow, radius: 16, y: 8)
                .padding(.horizontal, 10).padding(.bottom, 10)
            }
        }
        .task(id: query + "|\(workspace.revision)") {
            if !query.isEmpty { try? await Task.sleep(nanoseconds: 300_000_000); if Task.isCancelled { return } }
            await model.load(workspace)
        }
        .sheet(item: $sheet, onDismiss: { if let next { self.next = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { sheet = next } } }) { current in
            Group {
                switch current {
                case .menu(let item):
                    SheetMenu {
                        HStack(spacing: 12) {
                            FileTile(kind: item.kind, size: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name).font(TypeScale.name).lineLimit(1)
                                Text(Format.meta(item)).font(TypeScale.xs).foregroundStyle(tokens.text2)
                            }
                        }.padding(.horizontal, 12).padding(.bottom, 8)
                        MenuSeparator()
                        MenuRow(title: "Restore", icon: .rotateCcw) { sheet = nil; Task { await model.remove([item], action: .restore, workspace: workspace) } }
                        MenuRow(title: "Delete permanently", icon: .trash, tone: .danger) { next = .permanent([item]); sheet = nil }
                    }
                case .permanent(let items):
                    AsyncConfirm(title: items.count > 1 ? "Delete \(items.count) items permanently?" : "Delete \(items.first?.name ?? "this item") permanently?",
                                 description: "This removes the selected items and their version history, and cannot be undone. Content needed by your sent transfers remains stored and counted until those transfers are cancelled or expire.",
                                 confirm: "Delete permanently") {
                        Task { await model.remove(items, action: .permanent, workspace: workspace) }
                        return true
                    }
                case .empty:
                    AsyncConfirm(title: "Empty Trash?",
                                 description: "Permanently delete all items in Trash, including items on other pages and their version history? This cannot be undone. Content needed by sent transfers remains stored until those transfers end.",
                                 confirm: "Empty Trash") { await model.empty(workspace) }
                }
            }.environment(\.tokens, tokens)
        }
    }
    private func dock(_ label: String, _ icon: Lucide, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) { Icon(icon, size: 20); Text(label).font(TypeScale.tab).lineLimit(1) }
                .frame(maxWidth: .infinity).frame(height: 52).contentShape(Rectangle())
        }.buttonStyle(PressStyle()).foregroundStyle(tokens.text2).accessibilityIdentifier("dock-" + label)
    }
    private func toggle(_ item: DriveItem) {
        if model.selected.contains(item.id) { model.selected.remove(item.id) } else { model.selected.insert(item.id) }
    }
    private func open(_ item: DriveItem) {
        if !model.selected.isEmpty { toggle(item); return }
        sheet = .menu(item)
    }
}
