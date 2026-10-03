import SwiftUI
import UIKit

/// A text field that selects a file's name without its extension when focused, like the web's rename.
struct SelectingTextField: UIViewRepresentable {
    @Binding var text: String
    var selectBase: Bool
    var identifier: String
    var submit: () -> Void
    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.font = HarborFont.ui(16)
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.returnKeyType = .done
        field.clearButtonMode = .whileEditing
        field.accessibilityIdentifier = identifier
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { field.becomeFirstResponder() }
        return field
    }
    func updateUIView(_ field: UITextField, context: Context) {
        if field.text != text { field.text = text }
        context.coordinator.parent = self
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: SelectingTextField
        private var selected = false
        init(_ parent: SelectingTextField) { self.parent = parent }
        @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }
        func textFieldDidBeginEditing(_ field: UITextField) {
            guard !selected else { return }
            selected = true
            DispatchQueue.main.async {
                let value = field.text ?? ""
                let dot = self.parent.selectBase ? (value.range(of: ".", options: .backwards).map { value.distance(from: value.startIndex, to: $0.lowerBound) } ?? -1) : -1
                let end = dot > 0 ? dot : value.count
                if let start = field.position(from: field.beginningOfDocument, offset: 0),
                   let stop = field.position(from: field.beginningOfDocument, offset: end) {
                    field.selectedTextRange = field.textRange(from: start, to: stop)
                }
            }
        }
        func textFieldShouldReturn(_ field: UITextField) -> Bool { parent.submit(); return true }
    }
}

/// Wraps a sheet's async submit: busy state and an inline error, closing on success.
@MainActor
private func submitting(_ workspace: Workspace, busy: Binding<Bool>, error: Binding<String?>, dismiss: DismissAction,
                        _ action: @escaping () async -> Bool) {
    guard !busy.wrappedValue else { return }
    busy.wrappedValue = true
    error.wrappedValue = nil
    Task {
        let done = await action()
        busy.wrappedValue = false
        if done { dismiss() } else if let message = workspace.error { error.wrappedValue = message; workspace.error = nil }
    }
}

struct NameSheet: View {
    let title: String
    let label: String
    let initial: String
    let confirm: String
    let selectBase: Bool
    let action: (String) async -> Bool
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && name.count <= 240 }
    var body: some View {
        FittedSheet {
            SheetScaffold(title: title) {
                VStack(alignment: .leading, spacing: 16) {
                    Field(label: label) {
                        SelectingTextField(text: $name, selectBase: selectBase, identifier: "nameField") { save() }
                            .frame(height: 22)
                            .modifier(InputChrome(focused: true))
                    }
                    if let error { AlertBanner(tone: .danger, text: error) }
                    SheetActions {
                        Button(busy ? "Working…" : confirm) { save() }.harborButton(.primary, size: .lg, block: true)
                            .disabled(!valid || busy).accessibilityIdentifier("confirm-" + confirm)
                        Button("Cancel") { dismiss() }.harborButton(.outline, size: .lg, block: true).disabled(busy)
                    }
                }
            }
        }
        .onAppear { name = initial }
    }
    private func save() {
        guard valid else { return }
        let value = name.trimmingCharacters(in: .whitespaces)
        submitting(workspace, busy: $busy, error: $error, dismiss: dismiss) { await action(value) }
    }
}

struct RecipientSheet: View {
    let title: String
    let description: String
    let hint: String?
    let confirm: String
    let permission: Bool
    let action: (String, String) async -> Bool
    @State private var recipient = ""
    @State private var access = "VIEWER"
    @State private var busy = false
    @State private var error: String?
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        FittedSheet {
            SheetScaffold(title: title, description: description) {
                VStack(alignment: .leading, spacing: 16) {
                    Field(label: "To", hint: hint) {
                        TextInput(placeholder: "@username or email", text: $recipient, keyboard: .emailAddress, content: .emailAddress,
                                  identifier: "recipient") { save() }
                    }
                    if permission {
                        Field(label: "Permission") {
                            Segmented(options: [SegmentOption(value: "VIEWER", label: "Can view"), SegmentOption(value: "EDITOR", label: "Can edit")],
                                      selection: $access, fill: true, height: 40, identifier: "permission")
                        }
                    }
                    if let error { AlertBanner(tone: .danger, text: error) }
                    SheetActions {
                        Button(busy ? "Working…" : confirm) { save() }.harborButton(.primary, size: .lg, block: true)
                            .disabled(recipient.trimmingCharacters(in: .whitespaces).count < 3 || busy)
                            .accessibilityIdentifier("confirm-" + confirm)
                        Button("Cancel") { dismiss() }.harborButton(.outline, size: .lg, block: true).disabled(busy)
                    }
                }
            }
        }
    }
    private func save() {
        guard recipient.trimmingCharacters(in: .whitespaces).count >= 3 else { return }
        let value = recipient, permission = access
        submitting(workspace, busy: $busy, error: $error, dismiss: dismiss) { await action(value, permission) }
    }
}

/// A confirmation that runs an async action and stays open with the error if it fails.
struct AsyncConfirm: View {
    let title: String
    var description: String? = nil
    var note: String? = nil
    let confirm: String
    var cancel = "Cancel"
    var danger = true
    let action: () async -> Bool
    @State private var busy = false
    @State private var error: String?
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ConfirmSheet(title: title, description: description, note: note, confirm: confirm, cancel: cancel, danger: danger, busy: busy, error: error) {
            submitting(workspace, busy: $busy, error: $error, dismiss: dismiss, action)
        }
    }
}

/// The move destination picker: breadcrumbs, subfolders and "Move here".
struct MoveSheet: View {
    let items: [DriveItem]
    let action: (Crumb?) async -> Bool
    @State private var trail: [Crumb] = []
    @State private var folders: [DriveItem] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var busy = false
    @State private var error: String?
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(spacing: 0) {
            SheetScaffold(title: "Move \(items.count == 1 ? items[0].name : "\(items.count) items")", divider: true) {
                VStack(alignment: .leading, spacing: 8) {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 2) {
                            crumb("My Drive", current: trail.isEmpty) { trail = [] }
                            ForEach(Array(trail.enumerated()), id: \.element.id) { index, entry in
                                Icon(.chevronRight, size: 13).foregroundStyle(tokens.text3)
                                crumb(entry.name, current: index == trail.count - 1) { trail = Array(trail.prefix(index + 1)) }
                            }
                        }
                    }
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if loading { Text("Loading folders…").font(TypeScale.sm).foregroundStyle(tokens.text2).padding(.vertical, 12) }
                    else if let loadError { AlertBanner(tone: .danger, text: loadError) }
                    else if folders.isEmpty { Text("No subfolders").font(TypeScale.sm).foregroundStyle(tokens.text2).padding(.vertical, 12) }
                    else {
                        ForEach(folders) { folder in
                            Button { trail.append(Crumb(id: folder.id, name: folder.name)) } label: {
                                HStack(spacing: 10) {
                                    Icon(.folder, size: 16).foregroundStyle(tokens.primary)
                                    Text(folder.name).font(TypeScale.base).lineLimit(1)
                                    Spacer()
                                    Icon(.chevronRight, size: 14).foregroundStyle(tokens.text3)
                                }
                                .padding(.horizontal, 8).frame(height: 48).contentShape(Rectangle())
                            }
                            .buttonStyle(PressStyle()).accessibilityIdentifier("destination-" + folder.name)
                            Hairline()
                        }
                    }
                }.padding(.horizontal, 20).padding(.vertical, 8)
            }
            VStack(spacing: 8) {
                if let error { AlertBanner(tone: .danger, text: error) }
                Button(busy ? "Working…" : "Move here") {
                    let destination = trail.last
                    submitting(workspace, busy: $busy, error: $error, dismiss: dismiss) { await action(destination) }
                }.harborButton(.primary, size: .lg, block: true).disabled(busy || loading || loadError != nil)
                    .accessibilityIdentifier("confirm-Move here")
                Button("Cancel") { dismiss() }.harborButton(.outline, size: .lg, block: true).disabled(busy)
            }
            .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 12)
            .overlay(alignment: .top) { Hairline() }
        }
        .cardSurface(paint: false)
        .modifier(TallSheet())
        .task(id: trail.last?.id ?? "root") { await load() }
    }
    private func crumb(_ name: String, current: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(name).font(current ? TypeScale.smMedium : TypeScale.sm).foregroundStyle(current ? tokens.text : tokens.text2)
                .padding(.horizontal, 6).padding(.vertical, 4)
        }.buttonStyle(.plain)
    }
    private func load() async {
        loading = true
        loadError = nil
        do {
            var all: [DriveItem] = []
            var cursor: String?
            repeat {
                let page = try await workspace.api.list(parentID: trail.last?.id, cursor: cursor)
                all += page.items
                cursor = page.nextCursor
            } while cursor != nil
            let moving = Set(items.map(\.id))
            folders = all.filter { $0.isFolder && $0.backupRootId == nil && !moving.contains($0.id) }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        } catch is CancellationError {
        } catch { loadError = error.localizedDescription }
        loading = false
    }
}

struct DetailsSheet: View {
    let item: DriveItem
    let open: () -> Void
    @State private var location = "Loading…"
    @State private var sharing = "Loading…"
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    var body: some View {
        FittedSheet {
            SheetScaffold(title: "File details", description: "Information about this item.") {
                VStack(alignment: .leading, spacing: 16) {
                    Text(item.name).font(TypeScale.lg).fixedSize(horizontal: false, vertical: true)
                    DetailsList(rows: [
                        ("Type", Format.kind(item)),
                        ("Size", item.isFolder ? "—" : Format.size(item.sizeBytes)),
                        ("Location", location),
                        ("Created", Format.full(item.createdAt)),
                        ("Modified", Format.full(item.updatedAt)),
                        ("Owner", item.ownerUserId == nil || item.ownerUserId == workspace.account?.user.id ? "You" : "Shared with you"),
                        ("Sharing", sharing),
                    ])
                    Button("Open", action: open).harborButton(.outline, size: .lg, block: true)
                }
            }
        }
        .task { await load() }
    }
    private func load() async {
        async let path: Void = loadPath()
        async let shares: Void = loadSharing()
        _ = await (path, shares)
    }
    private func loadPath() async {
        var names: [String] = []
        var visited = Set<String>()
        var id = item.parentId
        do {
            while let current = id, visited.insert(current).inserted {
                let response: ItemResponse = try await workspace.api.request("/v1/drive/items/\(current)")
                names.insert(response.item.name, at: 0)
                id = response.item.parentId
            }
            location = (["My Drive"] + names).joined(separator: " / ")
        } catch { location = "Location unavailable" }
    }
    private func loadSharing() async {
        do {
            var shares: [ShareGrant] = []
            var cursor: String?
            repeat {
                let page: Page<ShareGrant> = try await workspace.api.request(HarborAPI.pagePath("/v1/shares/sent", cursor: cursor))
                shares += page.items
                cursor = page.nextCursor
            } while cursor != nil
            sharing = shares.contains { $0.driveItemId == item.id && $0.revokedAt == nil } ? "Shared access" : "No direct shares"
        } catch { sharing = "Sharing status unavailable" }
    }
}

struct VersionsSheet: View {
    let item: DriveItem
    let backup: Bool
    let restore: (FileVersion) async -> Bool
    let restoreLocally: (FileVersion) -> Void
    @State private var versions: [FileVersion]?
    @State private var loadError: String?
    @State private var busy = false
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(spacing: 0) {
            SheetScaffold(title: "Version history", description: item.name, divider: true) { EmptyView() }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let loadError { AlertBanner(tone: .danger, text: loadError) }
                    else if let versions {
                        if versions.isEmpty {
                            EmptyStateView(icon: .clock, title: "No versions to show", description: "Saved versions will appear here when available.", compact: true)
                        }
                        ForEach(versions) { version in row(version) }
                    } else {
                        Text("Loading versions…").font(TypeScale.sm).foregroundStyle(tokens.text2).padding(.vertical, 12)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 8)
            }
        }
        .cardSurface(paint: false)
        .modifier(TallSheet())
        .task { await load() }
    }
    private func row(_ version: FileVersion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Version \(version.versionNumber)").font(TypeScale.baseMedium)
                Text("\(Format.full(version.createdAt)) · \(Format.size(version.sizeBytes))\(version.cloudState == "RELEASED" ? " · Cloud copy removed" : "")")
                    .font(TypeScale.xs).foregroundStyle(tokens.text2)
            }
            HStack(spacing: 6) {
                Button("Download") { dismiss(); transfers.save([item], versionID: version.id) }
                    .harborButton(.outline, size: .sm).disabled(busy || version.cloudState == "RELEASED")
                if backup {
                    Button("Restore locally") { restoreLocally(version) }.harborButton(.ghost, size: .sm).disabled(busy)
                } else if version.id != item.currentVersionId {
                    Button("Restore") {
                        busy = true
                        Task { if await restore(version) { dismiss() }; busy = false }
                    }.harborButton(.ghost, size: .sm).disabled(busy || version.cloudState == "RELEASED")
                }
            }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Hairline() }
    }
    private func load() async {
        do {
            let page: Page<FileVersion> = try await workspace.api.request("/v1/drive/items/\(item.id)/versions")
            versions = page.items
        } catch { loadError = error.localizedDescription }
    }
}
