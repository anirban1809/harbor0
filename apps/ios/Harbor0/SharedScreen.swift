import SwiftUI

enum SharedTab: String, CaseIterable { case received = "Received", sent = "Sent" }

private struct Confirmation: Identifiable {
    let id = UUID()
    let title: String
    let description: String
    let label: String
    let done: String
    let run: () async throws -> Void
}

/// Shared: transfers received and sent, each as a card, then shared access (app-shell.tsx, transfer-table.tsx).
struct SharedScreen: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.tokens) private var tokens
    @State private var tab: SharedTab = .received
    @State private var items: [Transfer] = []
    @State private var cursor: String?
    @State private var nextCursor: String?
    @State private var loading = true
    @State private var failed = false
    @State private var shares: [ShareGrant] = []
    @State private var sharesLoading = true
    @State private var sharesFailed = false
    @State private var busy = false
    @State private var confirmation: Confirmation?

    var body: some View {
        PageScroll {
            VStack(alignment: .leading, spacing: 16) {
                PageTitle(text: "Shared")
                Segmented(options: SharedTab.allCases.map { SegmentOption(value: $0, label: $0.rawValue) },
                          selection: Binding(get: { tab }, set: { tab = $0; cursor = nil }), identifier: "shared-tab")
                    .padding(.bottom, 2)
                transfersList
                if cursor != nil || nextCursor != nil {
                    HStack(spacing: 8) {
                        if cursor != nil { Button("First page") { cursor = nil }.harborButton(.outline) }
                        if let nextCursor { Button("Next page") { cursor = nextCursor }.harborButton(.outline) }
                    }.frame(maxWidth: .infinity)
                }
                if sharesLoading || sharesFailed || !shares.isEmpty { sharedAccess }
            }
        }
        .refreshable { await load(silent: true) }
        .task(id: "\(tab.rawValue)|\(cursor ?? "")|\(workspace.revision)") {
            await load()
            // Polling is the fallback for pushed updates (15 seconds on web).
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { break }
                await load(silent: true)
            }
        }
        .sheet(item: $confirmation) { confirm in
            ConfirmFlow(confirm: confirm, busy: $busy) { await load(silent: true) }.environment(\.tokens, tokens)
        }
    }

    @ViewBuilder private var transfersList: some View {
        if loading {
            SkeletonRows(count: 3)
        } else if failed && items.isEmpty {
            LoadErrorView { Task { await load() } }
        } else if items.isEmpty {
            EmptyStateView(icon: tab == .received ? .inbox : .send, title: tab == .received ? "No received files" : "No sent files",
                           description: tab == .received
                           ? "People can send files directly to @\(workspace.account?.user.username ?? "you")."
                           : "Choose a file in My Drive and select Send from its menu to share it directly with someone.") {
                Button("Browse My Drive") { workspace.navigate(.drive) }.harborButton(.outline)
            }
        } else {
            VStack(spacing: 10) {
                ForEach(items) { transfer in
                    TransferCard(transfer: transfer, received: tab == .received, busy: busy) { action in act(transfer, action) }
                }
            }
        }
    }

    private var sharedAccess: some View {
        Card(title: "Shared access") {
            if sharesLoading {
                SkeletonRows(count: 2, tile: 32)
            } else if sharesFailed && shares.isEmpty {
                LoadErrorView(compact: true) { Task { await loadShares() } }
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(shares.enumerated()), id: \.element.id) { index, share in
                        HStack(spacing: 12) {
                            FileTile(kind: share.item.kind, size: 32)
                            Button { open(share.item) } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(share.item.name).font(TypeScale.baseMedium).lineLimit(1)
                                    Text("\(share.permission == "EDITOR" ? "Can edit" : "Can view") · \(share.ownerUserId == workspace.account?.user.id ? "Shared by you" : "Shared with you")")
                                        .font(TypeScale.xs).foregroundStyle(tokens.text2)
                                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            if share.ownerUserId == workspace.account?.user.id {
                                Button("Remove access") {
                                    confirmation = Confirmation(title: "Remove access to \(share.item.name)?",
                                                                description: "The person you shared this with will no longer be able to open it.",
                                                                label: "Remove access", done: "Access removed.") {
                                        let _: EmptyResponse = try await workspace.api.request("/v1/shares/\(share.id)", method: "DELETE",
                                                                                                body: ["operationId": UUID().uuidString])
                                    }
                                }.harborButton(.outline, size: .sm)
                            }
                        }
                        .padding(.vertical, 12)
                        .overlay(alignment: .bottom) { if index < shares.count - 1 { Hairline() } }
                    }
                }
            }
        }
    }

    private func open(_ item: DriveItem) {
        if item.isFolder {
            workspace.navigate(.drive)
        } else { transfers.open(item) }
    }

    private func load(silent: Bool = false) async {
        async let list: Void = loadTransfers(silent: silent)
        async let grants: Void = loadShares(silent: silent)
        _ = await (list, grants)
    }
    private func loadTransfers(silent: Bool = false) async {
        if !silent { loading = true; items = [] }
        do {
            let page: Page<Transfer> = try await workspace.api.request(HarborAPI.pagePath("/v1/transfers/\(tab.rawValue.lowercased())", cursor: cursor))
            items = page.items
            nextCursor = page.nextCursor
            failed = false
        } catch is CancellationError {
        } catch {
            failed = true
            if (error as? URLError)?.code != .cancelled { workspace.fail(error) }
        }
        loading = false
    }
    private func loadShares(silent: Bool = false) async {
        if !silent { sharesLoading = true }
        do {
            let page: Page<ShareGrant> = try await workspace.api.request("/v1/shares/\(tab.rawValue.lowercased())")
            shares = page.items.filter { $0.revokedAt == nil }
            sharesFailed = false
        } catch is CancellationError {
        } catch { sharesFailed = true }
        sharesLoading = false
    }

    private func act(_ transfer: Transfer, _ action: String) {
        if action == "decline" || action == "cancel" {
            // Declining or cancelling cannot be undone, so ask first.
            confirmation = Confirmation(
                title: action == "decline" ? "Decline this transfer?" : "Cancel this transfer?",
                description: action == "decline" ? "You won’t be able to download these files unless they are sent again."
                    : "The recipient will no longer be able to accept or download these files.",
                label: action == "decline" ? "Decline transfer" : "Cancel transfer",
                done: action == "decline" ? "Transfer declined." : "Transfer cancelled.") {
                    let _: EmptyResponse = try await workspace.api.request("/v1/transfers/\(transfer.id)/\(action)", method: "POST",
                                                                            body: ["operationId": UUID().uuidString])
                }
            return
        }
        busy = true
        Task {
            defer { busy = false }
            do {
                var body: [String: Any] = ["operationId": UUID().uuidString]
                if action == "save" { body["targetParentId"] = NSNull() }
                let _: EmptyResponse = try await workspace.api.request("/v1/transfers/\(transfer.id)/\(action)", method: "POST", body: body)
                await load(silent: true)
                workspace.changed()
                workspace.notify(action == "save" ? "Saving to My Drive. Large folders finish in the background."
                                 : "Transfer accepted. You can now download or save the files.")
            } catch { workspace.fail(error) }
        }
    }
}

private struct ConfirmFlow: View {
    let confirm: Confirmation
    @Binding var busy: Bool
    let reload: () async -> Void
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    var body: some View {
        ConfirmSheet(title: confirm.title, description: confirm.description, confirm: confirm.label, cancel: "Go back", busy: busy, error: error) {
            busy = true
            error = nil
            Task {
                do {
                    try await confirm.run()
                    busy = false
                    dismiss()
                    workspace.notify(confirm.done)
                    await reload()
                    workspace.changed()
                } catch { busy = false; self.error = error.localizedDescription }
            }
        }
    }
}

/// One transfer as a card: status, files, From/To · Size · Sent · Expires, and actions.
struct TransferCard: View {
    let transfer: Transfer
    let received: Bool
    let busy: Bool
    let act: (String) -> Void
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.tokens) private var tokens
    @State private var extra: [ManifestEntry] = []
    @State private var cursor: String?
    @State private var loadingMore = false
    @State private var moreError: String?
    @State private var started = false

    private var entries: [ManifestEntry] { (transfer.items ?? []) + extra }
    private var status: String {
        if transfer.preparationState == "BUILDING" { return "Preparing files" }
        if transfer.preparationState == "FAILED" { return "Preparation failed" }
        if transfer.saveState == "SAVING" { return "Saving…" }
        if transfer.savedAt != nil { return "Saved to My Drive" }
        switch transfer.state {
        case "PENDING_RECIPIENT_SIGNUP": return "Waiting for sign-up"
        case "PENDING": return received ? "Waiting for you" : "Waiting for recipient"
        case "ACCEPTED": return "Accepted"
        case "DECLINED": return "Declined"
        case "CANCELLED": return "Cancelled"
        case "EXPIRED": return "Expired"
        default: return transfer.state
        }
    }
    private var tone: Tone {
        transfer.preparationState == "FAILED" ? .danger : transfer.state == "ACCEPTED" ? .success : transfer.state.hasPrefix("PENDING") ? .accent : .neutral
    }

    var body: some View {
        let person = received ? transfer.sender : transfer.recipient
        VStack(alignment: .leading, spacing: 12) {
            Badge(text: status, tone: tone)
            if let failure = transfer.failure { AlertBanner(tone: .danger, text: failure) }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(entries) { entry in
                    HStack(spacing: 10) {
                        FileTile(kind: entry.kind)
                        Text(entry.displayName).font(Font.geist(15, 500)).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                        if received && transfer.state == "ACCEPTED" && transfer.ready && !entry.isFolder {
                            Button { transfers.saveEntry(transferID: transfer.id, entry: entry) } label: { Icon(.arrowDownToLine, size: 16) }
                                .harborButton(.ghost, size: .iconSm).disabled(busy)
                                .accessibilityLabel("Download \(entry.displayName)")
                        }
                    }
                }
                if entries.isEmpty {
                    ForEach(Array((transfer.displayNames?.isEmpty == false ? transfer.displayNames! : ["Files being prepared"]).enumerated()), id: \.offset) { _, name in
                        HStack(spacing: 10) { FileTile(kind: .plain); Text(name).font(Font.geist(15, 500)).lineLimit(1) }
                    }
                }
                if cursor != nil {
                    Button(loadingMore ? "Loading…" : "Show more files") { Task { await more() } }
                        .harborButton(.ghost, size: .sm).disabled(loadingMore || busy)
                }
                if let moreError { AlertBanner(tone: .danger, text: moreError) }
            }
            Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    field(received ? "From" : "To") {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(person?.displayName ?? transfer.recipientEmail ?? "Unknown recipient").font(TypeScale.base).foregroundStyle(tokens.text)
                            Text(person.map { "@" + $0.username } ?? "Account invitation").font(TypeScale.sm).foregroundStyle(tokens.text2)
                        }
                    }
                    field("Size") { Text(Format.size(transfer.totalSizeBytes)).font(TypeScale.base).foregroundStyle(tokens.text2) }
                }
                GridRow {
                    field("Sent") { Text(Format.date(transfer.createdAt)).font(TypeScale.base).foregroundStyle(tokens.text2) }
                    field("Expires") { Text(transfer.expiresAt.map { Format.date($0) } ?? "No expiry").font(TypeScale.base).foregroundStyle(tokens.text2) }
                }
            }
            actions
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(CardChrome())
        .onAppear { if !started { started = true; cursor = transfer.nextEntryCursor } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transfer-" + transfer.id)
    }
    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(Font.geist(11, 500)).foregroundStyle(tokens.text3)
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private var actions: some View {
        if received && transfer.state == "PENDING" && transfer.ready {
            HStack(spacing: 8) {
                Button("Accept") { act("accept") }.harborButton(.primary, size: .lg, block: true).disabled(busy).accessibilityIdentifier("accept")
                Button("Decline") { act("decline") }.harborButton(.outline, size: .lg, block: true).disabled(busy).accessibilityIdentifier("decline")
            }
        } else if received && transfer.state == "ACCEPTED" && transfer.ready {
            Button(transfer.savedAt != nil ? "Saved" : transfer.saveState == "SAVING" ? "Saving…" : "Save to My Drive") { act("save") }
                .harborButton(.outline, size: .lg, block: true)
                .disabled(busy || transfer.savedAt != nil || transfer.saveState == "SAVING")
                .accessibilityIdentifier("saveTransfer")
        } else if !received && transfer.preparationState != "BUILDING" && ["PENDING", "PENDING_RECIPIENT_SIGNUP"].contains(transfer.state) {
            Button("Cancel transfer") { act("cancel") }.harborButton(.outline, size: .lg, block: true).disabled(busy)
        }
    }
    private func more() async {
        guard let current = cursor else { return }
        loadingMore = true
        moreError = nil
        do {
            let page: Page<ManifestEntry> = try await workspace.api.request(HarborAPI.pagePath("/v1/transfers/\(transfer.id)/items", cursor: current))
            extra += page.items
            cursor = page.nextCursor
        } catch { moreError = error.localizedDescription }
        loadingMore = false
    }
}
