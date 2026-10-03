import SwiftUI

/// The phone workspace frame (mobile.css): sticky top bar, page, floating trays, bottom tab bar.
struct Shell: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @EnvironmentObject private var appearance: AppearanceStore
    @Environment(\.tokens) private var tokens
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var drive = DriveModel()
    @StateObject private var trash = TrashModel()
    @StateObject private var backups = BackupsModel()

    var body: some View {
        page
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) { floating }
            .background(tokens.background.ignoresSafeArea())
            .safeAreaInset(edge: .top, spacing: 0) { TopBar() }
            .safeAreaInset(edge: .bottom, spacing: 0) { TabBar() }
            .environmentObject(workspace.catalog)
            .environmentObject(workspace.sync)
            .sheet(isPresented: $workspace.showMore) { MoreSheet().environment(\.tokens, tokens) }
            .sheet(isPresented: $workspace.showAccount) { AccountSheet().environment(\.tokens, tokens) }
            .sheet(isPresented: $workspace.showActivity, onDismiss: { workspace.markActivityRead() }) {
                ActivitySheet().environment(\.tokens, tokens)
            }
            .sheet(isPresented: Binding(get: { !transfers.shareURLs.isEmpty }, set: { if !$0 { transfers.finishSharing() } })) {
                ShareSheet(urls: transfers.shareURLs) { transfers.finishSharing() }
                    .presentationDetents([.medium, .large])
            }
            .onChange(of: workspace.section) { _, _ in drive.selected = []; trash.selected = [] }
            .task {
                transfers.notify = { [weak workspace] message in workspace?.notify(message) }
                async let theme: Void = workspace.refreshAccount()
                async let catalog: Void = workspace.catalog.load(workspace.api)
                _ = await (theme, catalog)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await workspace.refreshAccount() }; workspace.sync.foreground() }
                if phase == .background { workspace.sync.background() }
            }
    }

    @ViewBuilder private var page: some View {
        let searching = !workspace.query.trimmingCharacters(in: .whitespaces).isEmpty && ![.drive, .trash].contains(workspace.section)
        // Search results replace the current page until the search is cleared; the tab stays the same.
        // The page stays mounted underneath so clearing restores it as it was.
        ZStack {
            sectionPage
                .opacity(searching ? 0 : 1)
                .allowsHitTesting(!searching)
                .accessibilityHidden(searching)
            if searching {
                SearchResultsScreen { folder in
                    workspace.navigate(.drive)
                    drive.reveal(folder, workspace: workspace)
                }
            }
        }
    }
    @ViewBuilder private var sectionPage: some View {
        switch workspace.section {
        case .drive: DriveScreen(model: drive)
        case .shared: SharedScreen()
        case .backups: BackupsScreen(model: backups)
        case .sync: SyncScreen()
        case .trash: TrashScreen(model: trash)
        case .devices: DevicesScreen()
        case .storage: StorageScreen()
        case .settings: SettingsScreen()
        case .notifications: NotificationsScreen()
        }
    }

    /// Upload tray and toasts float above the tab bar (and above the FAB on My Drive).
    private var floating: some View {
        VStack(spacing: 10) {
            if let toast = workspace.toast {
                ToastView(text: toast).transition(.move(edge: .bottom).combined(with: .opacity))
                    .onTapGesture { workspace.toast = nil }
            }
            if !transfers.uploads.isEmpty { UploadTray().padding(.horizontal, 12) }
        }
        .padding(.bottom, 12 + (workspace.section == .drive && drive.canWriteHere(workspace) && drive.selected.isEmpty ? 72 : (drive.selected.isEmpty || workspace.section != .drive ? 0 : 76)))
        .animation(.easeOut(duration: 0.2), value: workspace.toast)
    }
}

/// Every page: 16pt gutters, page alerts, then content. Pages scroll under the translucent bars.
struct PageScroll<Content: View>: View {
    var bottom: CGFloat = 32
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                PageAlerts()
                content
            }
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, bottom)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

struct PageTitle: View {
    let text: String
    var body: some View {
        Text(text).font(TypeScale.title).tracking(-0.6).lineLimit(1)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("pageTitle")
    }
}

/// Offline, error and transfer status above every page (.page-alerts, zip status card).
struct PageAlerts: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.tokens) private var tokens
    var body: some View {
        if !workspace.online {
            AlertBanner(tone: .warning, text: "You’re offline. Changes will sync when your connection returns.")
        }
        if let error = workspace.error {
            AlertBanner(tone: .danger, text: error, dismiss: { workspace.error = nil }).accessibilityIdentifier("pageError")
        }
        if let error = transfers.error {
            AlertBanner(tone: .danger, text: error, dismiss: { transfers.error = nil })
        }
        if let zip = transfers.zip {
            StatusCard(title: (zip.phase == .downloading ? "Downloading " : "Preparing ") + zip.name + ".zip",
                       message: zip.message,
                       detail: "\(Format.count(zip.files, "file")) completed · \(UploadActivity.bytes(zip.bytes)) \(zip.phase == .downloading ? "downloaded" : "prepared")",
                       file: zip.currentFile, progress: zip.percent.map { Double($0) / 100 }) { transfers.cancelZip() }
        }
        if let label = transfers.downloadLabel {
            StatusCard(title: label, message: "Keep harbor0 open until the download finishes.", detail: nil, file: nil, progress: nil) {
                transfers.cancelDownload()
            }
        }
    }
}

struct StatusCard: View {
    let title: String
    let message: String
    let detail: String?
    let file: String?
    let progress: Double?
    let cancel: () -> Void
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Spinner(size: 18).foregroundStyle(tokens.primary)
                Text(title).font(TypeScale.smMedium.weight(.semibold)).lineLimit(1)
                Spacer()
                Button("Cancel", action: cancel).harborButton(.ghost, size: .sm).accessibilityIdentifier("cancelTransfer")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(message)
                if let detail { Text(detail) }
            }.font(TypeScale.xs).foregroundStyle(tokens.text2)
            if let file { Text(file).font(TypeScale.xs).foregroundStyle(tokens.text3).lineLimit(1).truncationMode(.middle) }
            ProgressBar(value: progress)
        }
        .padding(14)
        .modifier(CardChrome())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("statusCard")
    }
}

// MARK: - Top bar

struct TopBar: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    @FocusState private var searching: Bool
    var body: some View {
        HStack(spacing: 4) {
            Button { workspace.navigate(.drive) } label: { BrandMark(size: 26).frame(width: 34, height: 40) }
                .buttonStyle(.plain).accessibilityLabel("harbor0 home").padding(.trailing, 4)
            HStack(spacing: 8) {
                Icon(.search, size: 16).foregroundStyle(tokens.text3)
                TextField("", text: $workspace.query,
                          prompt: Text(workspace.section == .trash ? "Search Trash" : "Search your files").foregroundStyle(tokens.text3))
                    .font(Font.geist(16))
                    .focused($searching)
                    .submitLabel(.search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("search")
                if !workspace.query.isEmpty {
                    Button { workspace.query = "" } label: { Icon(.x, size: 14).foregroundStyle(tokens.text2) }
                        .buttonStyle(.plain).accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 40)
            .background(searching ? tokens.surface : tokens.fill2, in: Capsule())
            .overlay(Capsule().strokeBorder(searching ? tokens.primary : .clear, lineWidth: 1))
            Button { workspace.showActivity = true } label: {
                Icon(.bell, size: 18).frame(width: 40, height: 40)
                    .overlay(alignment: .topTrailing) {
                        if workspace.unread > 0 {
                            Circle().fill(tokens.primary).frame(width: 7, height: 7)
                                .overlay(Circle().stroke(tokens.background, lineWidth: 2))
                                .padding(.top, 9).padding(.trailing, 10)
                        }
                    }
            }
            .buttonStyle(.plain).foregroundStyle(tokens.text2)
            .accessibilityLabel("Activity notifications" + (workspace.unread > 0 ? ", \(workspace.unread) unread" : ""))
            .accessibilityIdentifier("activity")
            Button { workspace.showAccount = true } label: {
                Avatar(name: workspace.account?.user.displayName ?? "").frame(width: 40, height: 40)
            }
            .buttonStyle(.plain).accessibilityLabel("Account menu").accessibilityIdentifier("accountMenu")
        }
        .padding(.leading, 12).padding(.trailing, 8)
        .frame(height: 56)
        .background {
            Rectangle().fill(.ultraThinMaterial).overlay(tokens.bar).ignoresSafeArea(edges: .top)
        }
    }
}

struct Avatar: View {
    let name: String
    var size: CGFloat = 30
    @Environment(\.tokens) private var tokens
    var body: some View {
        Text(String((name.isEmpty ? "Your account" : name).prefix(1)).uppercased())
            .font(Font.geist(size <= 30 ? 12 : 16, 600))
            .foregroundStyle(tokens.accentText)
            .frame(width: size, height: size)
            .background(tokens.accentSoft, in: Circle())
    }
}

// MARK: - Tab bar

struct TabBar: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    private let tabs: [(Section, String, Lucide)] = [(.drive, "Drive", .hardDrive), (.shared, "Shared", .users),
                                                     (.backups, "Backups", .archive), (.trash, "Trash", .trash)]
    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs, id: \.0) { tab in
                item(tab.1, tab.2, active: workspace.section == tab.0) {
                    if workspace.section == tab.0 && tab.0 == .drive { workspace.query = "" }
                    workspace.navigate(tab.0)
                }
            }
            item("More", .menu, active: workspace.section.inMore || workspace.showMore) { workspace.showMore = true }
        }
        .frame(height: 60)
        .background {
            Rectangle().fill(.ultraThinMaterial)
                .overlay(tokens.palette.background.opacity(0.9).color)
                .overlay(alignment: .top) { Rectangle().fill(tokens.line).frame(height: 1) }
                .ignoresSafeArea(edges: .bottom)
        }
    }
    private func item(_ label: String, _ icon: Lucide, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Icon(icon, size: 20)
                    .padding(.vertical, 4).padding(.horizontal, 18)
                    .foregroundStyle(active ? tokens.accentText : tokens.text2)
                    .background(active ? tokens.accentSoft : .clear, in: Capsule())
                Text(label).font(TypeScale.tab).tracking(0.11).lineLimit(1)
                    .foregroundStyle(active ? tokens.text : tokens.text2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier("tab-" + label.lowercased())
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }
}

// MARK: - Sheets

/// The “More” sheet: Devices, Storage, Settings, theme and storage (mobile-nav.tsx).
struct MoreSheet: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        FittedSheet {
            SheetScaffold(title: "More", divider: true) {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(spacing: 0) {
                        link(.sync, .refreshCw, "Folders that sync to this iPhone")
                        link(.devices, .laptop, "Computers and phones signed in")
                        link(.storage, .cloud, "Usage and plan")
                        link(.settings, .settings, "Profile and appearance")
                    }
                    HStack {
                        Text("Theme").font(TypeScale.baseMedium)
                        Spacer()
                        ThemeToggle()
                    }.padding(.horizontal, 4)
                    StorageIndicator { workspace.navigate(.storage) }
                }
            }
        }
    }
    private func link(_ section: Section, _ icon: Lucide, _ hint: String) -> some View {
        Button { workspace.navigate(section) } label: {
            HStack(spacing: 14) {
                IconTile(icon: icon, size: 38, iconSize: 18, radius: 10, active: workspace.section == section)
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.rawValue).font(TypeScale.baseMedium.weight(.medium)).foregroundStyle(tokens.text)
                    Text(hint).font(TypeScale.sm).foregroundStyle(tokens.text2)
                }
                Spacer()
            }
            .padding(.horizontal, 4).padding(.vertical, 8).frame(minHeight: 60)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { Hairline() }
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("more-" + section.rawValue.lowercased())
    }
}

/// .drive-storage: usage card with a Manage storage link.
struct StorageIndicator: View {
    let manage: () -> Void
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Storage").font(TypeScale.smMedium)
                Spacer()
                Button("Manage storage", action: manage).harborButton(.link).font(TypeScale.sm)
            }
            if let storage = workspace.account?.storage {
                ProgressBar(value: Double(storage.usedBytes) / Double(max(1, storage.quotaBytes)))
                Text("\(Format.size(storage.usedBytes)) of \(Format.size(storage.quotaBytes))").font(TypeScale.sm).foregroundStyle(tokens.text2)
            } else {
                Button("Storage unavailable · Retry") { Task { await workspace.refreshAccount() } }.harborButton(.link).font(TypeScale.sm)
            }
        }
        .padding(14)
        .background(tokens.fill2, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct ThemeToggle: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var appearance: AppearanceStore
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        let dark = (appearance.appearance.colorScheme ?? colorScheme) == .dark
        Button { workspace.toggleTheme(current: colorScheme) } label: { Icon(dark ? .sun : .moon, size: 16) }
            .harborButton(.ghost, size: .icon)
            .accessibilityLabel(dark ? "Switch to light theme" : "Switch to dark theme")
            .accessibilityIdentifier("themeToggle")
    }
}

/// The account menu as a bottom sheet (drive-account.tsx AccountMenu).
struct AccountSheet: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    @State private var signingOut = false
    var body: some View {
        let user = workspace.account?.user
        SheetMenu {
            VStack(alignment: .leading, spacing: 2) {
                Text(user?.displayName.isEmpty == false ? user!.displayName : "Your account").font(Font.geist(16, 600)).foregroundStyle(tokens.text)
                if let username = user?.username { Text("@" + username) }
                if let email = user?.email { Text(email) }
                if let storage = workspace.account?.storage {
                    Text("\(Format.size(storage.usedBytes)) of \(Format.size(storage.quotaBytes)) used").padding(.top, 6)
                }
            }
            .font(TypeScale.sm).foregroundStyle(tokens.text2)
            .padding(.horizontal, 12).padding(.bottom, 10)
            .accessibilityElement(children: .combine)
            MenuSeparator()
            MenuRow(title: "Account settings", icon: .settings) { workspace.navigate(.settings) }
            MenuRow(title: "Devices", icon: .laptop) { workspace.navigate(.devices) }
            MenuRow(title: "Manage storage", icon: .cloud) { workspace.navigate(.storage) }
            MenuSeparator()
            HStack {
                Text("Theme").font(Font.geist(15))
                Spacer()
                ThemeToggle()
            }.padding(.leading, 12).padding(.trailing, 4).frame(minHeight: 48)
            MenuSeparator()
            MenuRow(title: signingOut ? "Signing out…" : "Sign out", icon: .logOut, disabled: signingOut, identifier: "signOut") {
                signingOut = true
                Task { await workspace.signOut(); signingOut = false }
            }
        }
    }
}

/// Activity: this session's file activity, with a link to all notifications.
struct ActivitySheet: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(spacing: 0) {
            SheetScaffold(title: "Activity", description: "File activity, invitations, and required actions.", divider: true) { EmptyView() }
            ScrollView {
                if workspace.activity.isEmpty {
                    EmptyStateView(icon: .bell, title: "No activity yet", description: "File activity and sync updates will appear here.", compact: true)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(workspace.activity) { entry in
                            HStack(alignment: .top, spacing: 10) {
                                Group {
                                    switch entry.status {
                                    case .error: Icon(.circleAlert, size: 17).foregroundStyle(tokens.dangerText)
                                    case .success: Icon(.circleCheck, size: 17).foregroundStyle(tokens.successText)
                                    case .progress: Spinner(size: 17).foregroundStyle(tokens.accentText)
                                    case .info: Icon(.clock3, size: 17).foregroundStyle(tokens.text2)
                                    }
                                }.padding(.top, 1)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.message).font(TypeScale.sm).fixedSize(horizontal: false, vertical: true)
                                    Text(Format.short(entry.time)).font(TypeScale.xs).foregroundStyle(tokens.text2)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 12)
                            .overlay(alignment: .bottom) { Hairline() }
                        }
                    }.padding(.horizontal, 20)
                }
            }
            Button("All notifications") { workspace.showActivity = false; workspace.navigate(.notifications) }
                .harborButton(.outline, size: .lg, block: true)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .overlay(alignment: .top) { Hairline() }
                .accessibilityIdentifier("allNotifications")
        }
        .cardSurface(paint: false)
        .modifier(TallSheet())
    }
}

/// Floating upload card (upload-tray.tsx): folders roll up, with pause, resume and cancel.
struct UploadTray: View {
    @EnvironmentObject private var transfers: TransferCenter
    @Environment(\.tokens) private var tokens
    var body: some View {
        let activity = transfers.activity
        let running = activity.filter { $0.phase != .done && $0.phase != .failed }.count
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(running > 0 ? "Uploading \(running) \(running == 1 ? "item" : "items")"
                     : activity.contains { $0.phase == .failed } ? "Some uploads failed" : "Uploads complete")
                    .font(TypeScale.smMedium.weight(.semibold))
                Spacer()
                Button { transfers.dismissFinished() } label: { Icon(.x, size: 14) }
                    .harborButton(.ghost, size: .iconSm).disabled(running == activity.count)
                    .accessibilityLabel("Dismiss finished uploads").accessibilityIdentifier("dismissUploads")
            }
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 6)
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(activity) { entry in row(entry) }
                }.padding(.horizontal, 14).padding(.bottom, 12)
            }
            .frame(maxHeight: min(CGFloat(activity.count) * 64 + 8, UIScreen.main.bounds.height * 0.3))
        }
        .modifier(CardChrome())
        .shadow(color: tokens.shadow, radius: 16, y: 8)
        .accessibilityIdentifier("uploadTray")
    }
    private func row(_ entry: UploadActivity) -> some View {
        let resumable = entry.phase == .paused || entry.phase == .failed
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Icon(entry.folder ? .folder : .file, size: 16).foregroundStyle(tokens.text2)
                Text(entry.name).font(TypeScale.smMedium).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                if entry.phase == .done {
                    Icon(.check, size: 16).foregroundStyle(tokens.successText).accessibilityLabel("Uploaded")
                } else if resumable {
                    Button { transfers.resume(entry.keys) } label: { Icon(.play, size: 14) }.harborButton(.ghost, size: .iconSm)
                        .accessibilityLabel((entry.phase == .failed ? "Retry " : "Resume ") + entry.name)
                } else {
                    Button { transfers.pause(entry.keys) } label: { Icon(.pause, size: 14) }.harborButton(.ghost, size: .iconSm)
                        .accessibilityLabel("Pause " + entry.name)
                }
                if entry.phase != .done {
                    Button { transfers.cancel(entry.keys) } label: { Icon(.x, size: 14) }.harborButton(.ghost, size: .iconSm)
                        .accessibilityLabel("Cancel " + entry.name)
                }
            }
            ProgressBar(value: Double(entry.loaded) / Double(max(1, entry.size)), height: 4)
            Text(entry.detail).font(TypeScale.xs).foregroundStyle(entry.phase == .failed ? tokens.dangerText : tokens.text2).lineLimit(2)
        }
    }
}
