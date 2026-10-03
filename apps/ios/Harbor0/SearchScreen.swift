import SwiftUI

private enum SearchSheet: Identifiable {
    case menu(DriveItem), rename(DriveItem), move(DriveItem), send([DriveItem]), trash(DriveItem)
    case details(DriveItem), versions(DriveItem)
    var id: String {
        switch self {
        case .menu(let item): "menu-" + item.id
        case .rename(let item): "rename-" + item.id
        case .move(let item): "move-" + item.id
        case .send(let items): "send-" + items.map(\.id).joined()
        case .trash(let item): "trash-" + item.id
        case .details(let item): "details-" + item.id
        case .versions(let item): "versions-" + item.id
        }
    }
}

/// Search started from a page other than My Drive or Trash: the page's content is replaced in place
/// by file results until the search is cleared (app-shell.tsx `searching` / generic file section).
struct SearchResultsScreen: View {
    let openFolder: (DriveItem) -> Void
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.tokens) private var tokens
    @State private var items: [DriveItem] = []
    @State private var cursor: String?
    @State private var nextCursor: String?
    @State private var loading = true
    @State private var failed = false
    @State private var selected: Set<String> = []
    @State private var grid = false
    @State private var sheet: SearchSheet?
    @State private var next: SearchSheet?
    private var query: String { workspace.query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        PageScroll {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        PageTitle(text: "Search results")
                        Text("Files matching “\(query)”").font(TypeScale.sm).foregroundStyle(tokens.text2).lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    ClearSearchButton()
                }
                HStack {
                    Badge(text: loading ? "Loading…" : failed && items.isEmpty ? "Unavailable"
                          : "\(items.count) \(items.count == 1 ? "item" : "items")\(cursor != nil || nextCursor != nil ? " on this page" : "")")
                    Spacer()
                    ViewSwitch(grid: $grid)
                }
                if !selected.isEmpty {
                    HStack(spacing: 8) {
                        Text("\(selected.count) selected").font(TypeScale.smMedium)
                        Spacer()
                        Button { sheet = .send(items.filter { selected.contains($0.id) }) } label: { Icon(.send, size: 14); Text("Send") }
                            .harborButton(.primary, size: .sm).accessibilityIdentifier("searchSend")
                        Button("Clear") { selected = [] }.harborButton(.ghost, size: .sm)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(tokens.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                }
                content
                if cursor != nil || nextCursor != nil {
                    HStack(spacing: 8) {
                        if cursor != nil { Button("First page") { selected = []; cursor = nil }.harborButton(.outline) }
                        if let nextCursor { Button("Next page") { selected = []; cursor = nextCursor }.harborButton(.outline) }
                    }.frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityIdentifier("searchResults")
        .refreshable { await load() }
        .task(id: query + "|" + (cursor ?? "") + "|\(workspace.revision)") {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            await load()
        }
        .onChange(of: query) { _, _ in cursor = nil; selected = [] }
        .sheet(item: $sheet, onDismiss: { if let next { self.next = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { sheet = next } } }) { current in
            sheetView(current).environment(\.tokens, tokens)
        }
    }

    @ViewBuilder private var content: some View {
        if loading && items.isEmpty {
            SkeletonRows()
        } else if failed && items.isEmpty {
            LoadErrorView(title: "We couldn’t load these files.") { Task { await load() } }
        } else if items.isEmpty {
            EmptyStateView(icon: .search, title: "No matching files", description: "Try a different name or clear your search to see your files again.") {
                Button("Clear search") { workspace.query = "" }.harborButton(.outline)
            }
        } else if grid {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(items) { item in
                    FileGridCard(item: item, selected: selected.contains(item.id), selecting: !selected.isEmpty,
                                 toggle: { toggle(item) }, open: { open(item) }, actions: { sheet = .menu(item) })
                }
            }
        } else {
            VStack(spacing: 0) {
                Hairline()
                ForEach(items) { item in
                    FileRowView(item: item, selected: selected.contains(item.id), selecting: !selected.isEmpty,
                                toggle: { toggle(item) }, open: { open(item) }, actions: { sheet = .menu(item) })
                }
            }
        }
    }

    private func toggle(_ item: DriveItem) {
        if selected.contains(item.id) { selected.remove(item.id) } else { selected.insert(item.id) }
    }
    private func open(_ item: DriveItem) {
        if !selected.isEmpty { toggle(item); return }
        if item.isFolder { openFolder(item) } else { transfers.open(item) }
    }
    private func load() async {
        guard !query.isEmpty else { return }
        loading = true
        do {
            let page: DrivePage = try await workspace.api.request(HarborAPI.pagePath("/v1/search?q=" + DriveModel.encode(query), cursor: cursor))
            try Task.checkCancellation()
            items = page.items
            nextCursor = page.nextCursor
            failed = false
            selected = selected.filter { id in page.items.contains { $0.id == id } }
        } catch is CancellationError {
            return
        } catch { failed = true; workspace.fail(error) }
        loading = false
    }
    /// Runs a change, refreshes and shows the web's toast.
    private func act(_ message: String, _ action: () async throws -> Void) async -> Bool {
        do {
            try await action()
            selected = []
            workspace.changed()
            await workspace.refreshAccount()
            if !message.isEmpty { workspace.notify(message) }
            return true
        } catch { workspace.fail(error); return false }
    }
    private func then(_ sheet: SearchSheet) { next = sheet; self.sheet = nil }

    @ViewBuilder private func sheetView(_ current: SearchSheet) -> some View {
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
                if !item.isFolder {
                    MenuRow(title: "Preview") { sheet = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { transfers.open(item) } }
                }
                MenuRow(title: item.isFolder ? "Download as ZIP" : "Download", disabled: transfers.zip != nil) {
                    sheet = nil
                    if item.isFolder { transfers.downloadFolder(item) } else { transfers.save([item]) }
                }
                MenuRow(title: "Send to someone") { then(.send([item])) }
                MenuSeparator()
                MenuRow(title: "File details") { then(.details(item)) }
                MenuRow(title: "Rename") { then(.rename(item)) }
                MenuRow(title: "Move") { then(.move(item)) }
                MenuRow(title: item.favorite == true ? "Remove favorite" : "Add to favorites") {
                    sheet = nil
                    Task {
                        _ = await act("") {
                            let _: EmptyResponse = try await workspace.api.request("/v1/drive/items/\(item.id)/favorite", method: item.favorite == true ? "DELETE" : "PUT",
                                body: ["operationId": UUID().uuidString, "baseRevision": try DriveModel.revision(item)])
                        }
                    }
                }
                if !item.isFolder { MenuRow(title: "Version history") { then(.versions(item)) } }
                MenuSeparator()
                MenuRow(title: "Move to trash", tone: .danger) { then(.trash(item)) }
            }
        case .rename(let item):
            NameSheet(title: "Rename \(item.name)", label: "Name", initial: item.name, confirm: "Save", selectBase: !item.isFolder) { name in
                await act("Renamed.") {
                    let _: ItemResponse = try await workspace.api.request("/v1/drive/items/\(item.id)", method: "PATCH",
                        body: ["operationId": UUID().uuidString, "baseRevision": try DriveModel.revision(item), "name": name])
                }
            }
        case .move(let item):
            MoveSheet(items: [item]) { destination in
                await act("Moved.") {
                    let _: ItemResponse = try await workspace.api.request("/v1/drive/items/\(item.id)/move", method: "POST",
                        body: ["operationId": UUID().uuidString, "baseRevision": try DriveModel.revision(item), "parentId": destination?.id as Any? ?? NSNull()])
                }
            }
        case .send(let targets):
            RecipientSheet(title: "Send \(targets.count == 1 ? targets[0].name : "selected files")",
                           description: "Send a copy to a person. They must sign in to receive it.",
                           hint: "New recipients can verify their email and find the transfer after signup.", confirm: "Send files", permission: false) { recipient, _ in
                await act("Sent. Your recipient will see it after signing in.") {
                    let _: EmptyResponse = try await workspace.api.request("/v1/transfers", method: "POST", body: [
                        "operationId": UUID().uuidString, "recipient": DriveModel.recipient(recipient), "items": targets.map { ["driveItemId": $0.id] }])
                }
            }
        case .trash(let item):
            AsyncConfirm(title: "Move \(item.name) to trash?", description: "You can restore this item from Trash.", confirm: "Move to trash") {
                await act("Moved to trash.") { try await workspace.api.changeTrash(item, action: .trash) }
            }
        case .details(let item):
            DetailsSheet(item: item) { sheet = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { open(item) } }
        case .versions(let item):
            VersionsSheet(item: item, backup: false, restore: { version in
                await act("Restored version \(version.versionNumber).") {
                    let _: EmptyResponse = try await workspace.api.request("/v1/drive/items/\(item.id)/versions/\(version.id)/restore", method: "POST",
                        body: ["operationId": UUID().uuidString, "baseRevision": try DriveModel.revision(item)])
                }
            }, restoreLocally: { _ in })
        }
    }
}

/// The web's "Clear search" outline button with an X.
struct ClearSearchButton: View {
    @EnvironmentObject private var workspace: Workspace
    var body: some View {
        Button { workspace.query = "" } label: { Icon(.x, size: 16); Text("Clear search") }
            .harborButton(.outline).accessibilityIdentifier("clearSearch")
    }
}
