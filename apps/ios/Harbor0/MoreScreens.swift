import SwiftUI

private let notificationTitles = ["TRANSFER_RECEIVED": "Someone sent you files", "TRANSFER_ACCEPTED": "Your transfer was accepted",
                                  "TRANSFER_DECLINED": "Your transfer was declined", "TRANSFER_CANCELLED": "A transfer was cancelled",
                                  "TRANSFER_EXPIRED": "A transfer expired", "SHARE_RECEIVED": "Someone shared an item with you"]

// MARK: - Devices

struct DevicesScreen: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    @State private var devices: [Device]?
    @State private var failed = false
    @State private var revoking: Device?

    var body: some View {
        PageScroll {
            VStack(alignment: .leading, spacing: 16) {
                PageTitle(text: "Devices")
                Card(title: "Connected devices", description: "Use harbor0 on all your devices. Remove access whenever you need to.") {
                    if devices == nil && !failed {
                        SkeletonRows(count: 3, tile: 32)
                    } else if failed && (devices ?? []).isEmpty {
                        LoadErrorView(compact: true) { Task { await load() } }
                    } else if let devices, devices.isEmpty {
                        EmptyStateView(icon: .laptop, title: "No connected devices",
                                       description: "Sign in to the harbor0 desktop app to connect a computer. Your devices will appear here.", compact: true) {
                            Button("Refresh devices") { Task { await load() } }.harborButton(.outline)
                        }
                    } else if let devices {
                        VStack(spacing: 0) {
                            ForEach(Array(devices.enumerated()), id: \.element.id) { index, device in
                                HStack(spacing: 12) {
                                    IconTile(icon: ["IOS", "ANDROID"].contains(device.platform) ? .smartphone : .laptop)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(device.name).font(TypeScale.baseMedium)
                                        Text("\(device.platformName) · \(device.revokedAt != nil ? "Access removed" : "Last active \(Format.date(device.lastSeenAt ?? device.createdAt))")")
                                            .font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true)
                                    }
                                    Spacer(minLength: 8)
                                    if device.revokedAt == nil {
                                        Button("Revoke") { revoking = device }.harborButton(.outline, size: .sm)
                                            .accessibilityIdentifier("revoke-" + device.name)
                                    }
                                }
                                .padding(.vertical, 12)
                                .overlay(alignment: .bottom) { if index < devices.count - 1 { Hairline() } }
                            }
                        }
                    }
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $revoking) { device in
            AsyncConfirm(title: "Revoke access for \(device.name)?",
                         description: "This device will be signed out and will stop syncing. If it is the browser you are using now, you will need to sign in again.",
                         confirm: "Revoke access", cancel: "Go back") {
                do {
                    let _: EmptyResponse = try await workspace.api.request("/v1/devices/\(device.id)", method: "DELETE")
                    workspace.notify("Device access removed.")
                    await load()
                    return true
                } catch { workspace.fail(error); return false }
            }.environment(\.tokens, tokens)
        }
    }
    private func load() async {
        do {
            let page: Page<Device> = try await workspace.api.request("/v1/devices")
            devices = page.items
            failed = false
        } catch is CancellationError {
        } catch { failed = true }
    }
}

// MARK: - Storage

struct StorageScreen: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    var body: some View {
        PageScroll {
            VStack(alignment: .leading, spacing: 16) {
                PageTitle(text: "Storage")
                if let usage = workspace.account?.storage {
                    Card {
                        VStack(alignment: .leading, spacing: 14) {
                            Badge(text: "Free plan", tone: .accent)
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(UploadActivity.bytes(usage.usedBytes)).font(Font.geist(28, 600)).tracking(-0.84).monospacedDigit()
                                Text("of \(UploadActivity.bytes(usage.quotaBytes)) used").font(TypeScale.base).foregroundStyle(tokens.text2)
                            }
                            ProgressBar(value: Double(usage.usedBytes + usage.reservedBytes) / Double(max(1, usage.quotaBytes)), height: 8)
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 20) { breakdown(usage) }
                                VStack(alignment: .leading, spacing: 6) { breakdown(usage) }
                            }
                            .font(TypeScale.sm).foregroundStyle(tokens.text2).monospacedDigit()
                            Text("Storage includes current files, version history, backups, trash, and content retained for sent transfers. Permanently deleting unused files frees up space.")
                                .font(TypeScale.sm).foregroundStyle(tokens.text2).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    LoadErrorView { Task { await workspace.refreshAccount() } }
                }
                Card(title: "Plan features", description: "Backup, sync, file sharing, and transfers are included in the free plan.") {
                    AlertBanner(text: "Additional storage purchases are not available yet.")
                }
            }
        }
        .refreshable { await workspace.refreshAccount() }
        .task { await workspace.refreshAccount() }
    }
    @ViewBuilder private func breakdown(_ usage: Account.Storage) -> some View {
        Text("\(UploadActivity.bytes(usage.usedBytes)) stored")
        Text("\(UploadActivity.bytes(usage.reservedBytes)) uploading")
        Spacer(minLength: 0)
        Text("\(UploadActivity.bytes(usage.available)) available").font(TypeScale.smMedium).foregroundStyle(tokens.text)
    }
}

// MARK: - Notifications

struct NotificationsScreen: View {
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.tokens) private var tokens
    @State private var items: [HarborNotification]?
    @State private var failed = false
    @State private var busy = false
    var body: some View {
        PageScroll {
            VStack(alignment: .leading, spacing: 16) {
                PageTitle(text: "Notifications")
                Card(padding: 16) {
                    if items == nil && !failed {
                        SkeletonRows(count: 3, tile: 32)
                    } else if failed && (items ?? []).isEmpty {
                        LoadErrorView(compact: true) { Task { await load() } }
                    } else if let items, items.isEmpty {
                        EmptyStateView(icon: .bell, title: "No notifications", description: "Updates about your files and transfers will appear here.", compact: true) {
                            Button("Back to My Drive") { workspace.navigate(.drive) }.harborButton(.outline)
                        }
                    } else if let items {
                        VStack(spacing: 0) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                HStack(spacing: 12) {
                                    Icon(.bell, size: 18).foregroundStyle(tokens.text2).padding(.horizontal, 8)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(notificationTitles[item.type] ?? sentence(item.type)).font(TypeScale.baseMedium)
                                        Text(Format.date(item.createdAt)).font(TypeScale.sm).foregroundStyle(tokens.text2)
                                    }
                                    Spacer(minLength: 8)
                                    Button(item.readAt != nil ? "Read" : "Mark read") { Task { await markRead(item) } }
                                        .harborButton(.ghost, size: .sm).disabled(item.readAt != nil || busy)
                                }
                                .padding(.vertical, 12)
                                .overlay(alignment: .bottom) { if index < items.count - 1 { Hairline() } }
                            }
                        }
                    }
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }
    private func sentence(_ value: String) -> String {
        let text = value.replacingOccurrences(of: "_", with: " ").lowercased()
        return text.prefix(1).uppercased() + text.dropFirst()
    }
    private func load() async {
        do {
            let page: Page<HarborNotification> = try await workspace.api.request("/v1/notifications")
            items = page.items
            failed = false
        } catch is CancellationError {
        } catch { failed = true }
    }
    private func markRead(_ item: HarborNotification) async {
        busy = true
        defer { busy = false }
        do {
            let _: EmptyResponse = try await workspace.api.request("/v1/notifications/\(item.id)/read", method: "POST")
            await load()
        } catch { workspace.fail(error) }
    }
}

// MARK: - Settings

struct SettingsScreen: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var appearance: AppearanceStore
    @Environment(\.tokens) private var tokens
    @State private var deleting = false
    @State private var signingOut = false
    var body: some View {
        PageScroll {
            VStack(alignment: .leading, spacing: 16) {
                PageTitle(text: "Settings")
                AppearanceCard()
                if let user = workspace.account?.user {
                    Card(title: "Your account", description: "Manage active sessions in Devices. Use “Forgot password” on the sign-in screen to reset your password.") {
                        VStack(alignment: .leading, spacing: 0) {
                            Grid(alignment: .leading, horizontalSpacing: 20) {
                                GridRow {
                                    Text("Email").foregroundStyle(tokens.text2)
                                    HStack(spacing: 8) {
                                        Text(user.email).lineLimit(1).truncationMode(.middle)
                                        if user.emailVerified != false { Badge(text: "Verified", tone: .success) }
                                    }
                                }
                            }.font(TypeScale.sm)
                            ProfileForm(user: user).id((user.displayName) + (user.username ?? ""))
                                .padding(.vertical, 20)
                                .overlay(alignment: .top) { Hairline() }
                                .overlay(alignment: .bottom) { Hairline() }
                                .padding(.top, 20)
                            Button { workspace.navigate(.devices) } label: { Icon(.settings, size: 16); Text("Manage devices") }
                                .harborButton(.outline).padding(.top, 16)
                        }
                    }
                    Card(title: "Delete account", description: "You’ll be signed out everywhere right away. Your files, backups and transfers are kept for 30 days and then permanently deleted.") {
                        Button { deleting = true } label: { Icon(.trash, size: 16); Text("Delete account") }
                            .harborButton(.danger).accessibilityIdentifier("deleteAccount")
                    }
                    Card(title: "Sign out", description: "harbor0 for iPhone · Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") — Sync and backups run on this iPhone while harbor0 is open, and catch up in the background when iOS allows.") {
                        Button { signingOut = true; Task { await workspace.signOut(); signingOut = false } } label: {
                            Icon(.logOut, size: 16); Text(signingOut ? "Signing out…" : "Sign out")
                        }
                        .harborButton(.outline).disabled(signingOut).accessibilityIdentifier("settingsSignOut")
                    }
                } else if appearance.loading {
                    SkeletonRows(count: 3)
                }
            }
        }
        .refreshable { await workspace.refreshAccount() }
        .sheet(isPresented: $deleting) {
            if let email = workspace.account?.user.email { DeleteAccountSheet(email: email).environment(\.tokens, tokens) }
        }
    }
}

private struct ProfileForm: View {
    let user: Account.User
    @EnvironmentObject private var workspace: Workspace
    @State private var displayName = ""
    @State private var username = ""
    @State private var saving = false
    private var changed: Bool { displayName.trimmingCharacters(in: .whitespaces) != user.displayName || username != (user.username ?? "") }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Field(label: "Display name") { TextInput(placeholder: "Your name", text: $displayName, content: .name, autocapitalize: true, identifier: "displayName") }
            Field(label: "Username", hint: "3–32 lowercase letters, numbers, dots, or underscores. Usernames can be changed once every 30 days.") {
                TextInput(placeholder: "username", text: Binding(get: { username }, set: { username = $0.lowercased() }), prefix: "@",
                          content: .username, identifier: "username")
            }
            Button(saving ? "Saving…" : "Save profile") { save() }.harborButton(.primary)
                .disabled(!changed || saving || displayName.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("saveProfile")
        }
        .onAppear { displayName = user.displayName; username = user.username ?? "" }
    }
    private func save() {
        guard username.isEmpty || username.range(of: "^[a-z0-9_.]{3,32}$", options: .regularExpression) != nil else {
            workspace.error = "Use 3–32 lowercase letters, numbers, dots, or underscores."
            return
        }
        saving = true
        // Only changed fields are sent, so an unchanged username never counts as a rename.
        var body: [String: Any] = ["operationId": UUID().uuidString]
        let name = displayName.trimmingCharacters(in: .whitespaces)
        if name != user.displayName { body["displayName"] = name }
        if username != (user.username ?? "") { body["username"] = username }
        Task {
            defer { saving = false }
            do {
                let _: UserResponse = try await workspace.api.request("/v1/users/me", method: "PATCH", body: body)
                await workspace.refreshAccount()
                workspace.notify("Profile updated.")
            } catch { workspace.fail(error) }
        }
    }
}

private struct DeleteAccountSheet: View {
    let email: String
    @EnvironmentObject private var workspace: Workspace
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?
    private var matches: Bool { typed.trimmingCharacters(in: .whitespaces).lowercased() == email.lowercased() }
    var body: some View {
        FittedSheet {
            SheetScaffold(title: "Delete your account?", description: "This can’t be undone. You’ll be signed out on every device, and your data will be permanently deleted after 30 days.") {
                VStack(alignment: .leading, spacing: 16) {
                    if let error { AlertBanner(tone: .danger, text: error) }
                    Field(label: "Type \(email) to confirm") {
                        TextInput(placeholder: "", text: $typed, keyboard: .emailAddress, content: .emailAddress, identifier: "confirmEmail")
                    }
                    SheetActions {
                        Button(busy ? "Deleting…" : "Delete account") { delete() }.harborButton(.danger, size: .lg, block: true)
                            .disabled(!matches || busy).accessibilityIdentifier("confirmDeleteAccount")
                        Button("Go back") { dismiss() }.harborButton(.outline, size: .lg, block: true).disabled(busy)
                    }
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }
    private func delete() {
        guard matches, !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                let _: EmptyResponse = try await workspace.api.request("/v1/users/me/delete", method: "POST",
                    body: ["operationId": UUID().uuidString, "email": typed.trimmingCharacters(in: .whitespaces)])
                dismiss()
                try? workspace.api.forgetLocalSession()
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

/// Settings → Appearance (appearance-settings.tsx): color mode, preset themes and custom colors, saved to the account.
private struct AppearanceCard: View {
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var appearance: AppearanceStore
    @Environment(\.tokens) private var tokens
    @Environment(\.colorScheme) private var colorScheme
    private var mode: String { (appearance.appearance.colorScheme ?? colorScheme) == .dark ? "dark" : "light" }
    private let fields: [(String, String, String)] = [
        ("primary", "Accent", "Buttons, links, and focus rings"), ("background", "Background", "Your main workspace"),
        ("card", "Cards", "File lists, panels, and popovers"), ("sidebar", "Navigation", "Navigation and account area"),
        ("border", "Borders", "Dividers and input outlines")]
    var body: some View {
        let ready = appearance.account != nil
        Card(title: "Appearance", description: "Theme settings apply across your devices.") {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle(text: "Color mode")
                    Segmented(options: [SegmentOption(value: "light", label: "Light", icon: .sun), SegmentOption(value: "dark", label: "Dark", icon: .moon),
                                        SegmentOption(value: "system", label: "System", icon: .monitor)],
                              selection: Binding(get: { appearance.appearance.preference },
                                                 set: { value in appearance.change(workspace.api) { $0.preference = value } }),
                              height: 40, identifier: "mode")
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle(text: "Preset themes")
                    Text("Each theme includes light and dark colors. Choosing a preset resets custom colors.")
                        .font(TypeScale.sm).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true).padding(.bottom, 4)
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                        ForEach(ThemePreset.all) { preset in presetCard(preset) }
                    }
                }
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        SectionTitle(text: "Custom colors")
                        Badge(text: mode == "light" ? "Light theme" : "Dark theme")
                    }.padding(.bottom, 4)
                    Text("Choose a color or enter a hex code. Light and dark themes keep separate colors.")
                        .font(TypeScale.sm).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true).padding(.bottom, 12)
                    ForEach(fields, id: \.0) { field in ColorRow(key: field.0, label: field.1, detail: field.2, mode: mode) }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Hairline()
                    Text(status).font(TypeScale.sm).foregroundStyle(tokens.text2).accessibilityIdentifier("appearanceSaved")
                    HStack(spacing: 8) {
                        if appearance.error != nil {
                            Button("Retry") { Task { if appearance.dirty { await appearance.save(workspace.api) } else { await appearance.load(workspace.api) } } }
                                .harborButton(.outline)
                        }
                        Button { appearance.change(workspace.api) { if mode == "dark" { $0.palettes.dark = [:] } else { $0.palettes.light = [:] } } } label: {
                            Icon(.rotateCcw, size: 16); Text("Reset \(mode) colors")
                        }
                        .harborButton(.outline)
                        .disabled(!ready || (mode == "dark" ? appearance.appearance.palettes.dark : appearance.appearance.palettes.light).isEmpty)
                    }
                }
            }
            .disabled(!ready)
        }
    }
    private var status: String {
        if appearance.loading && appearance.account == nil { return "Loading your account theme…" }
        if appearance.saving { return "Saving to your account…" }
        if appearance.error != nil { return appearance.account != nil ? "Applied here. Couldn’t save to your account. Please retry." : "Couldn’t load your account theme. Please retry." }
        if appearance.savedMessage != nil || !appearance.dirty { return "Saved to your account." }
        return "Saving to your account…"
    }
    private func presetCard(_ preset: ThemePreset) -> some View {
        let selected = appearance.appearance.preset == preset.id
        let customized = !appearance.appearance.palettes.light.isEmpty || !appearance.appearance.palettes.dark.isEmpty
        return Button {
            appearance.change(workspace.api) { $0.preset = preset.id; $0.palettes = .init() }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 0) {
                    ForEach(preset.cardSwatches(dark: mode == "dark"), id: \.self) { Rectangle().fill(Color(hex: $0)) }
                }
                .frame(height: 40)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tokens.line, lineWidth: 1))
                .padding(.bottom, 8)
                Text(preset.name).font(TypeScale.smMedium.weight(.semibold)).foregroundStyle(tokens.text)
                Text(preset.detail).font(TypeScale.xs).foregroundStyle(tokens.text2)
                if selected {
                    Text(customized ? "Customized" : "Selected").font(TypeScale.xsMedium).foregroundStyle(tokens.accentText)
                } else { Text(" ").font(TypeScale.xsMedium) }
            }
            .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? tokens.primary : tokens.line, lineWidth: selected ? 2 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("theme-" + preset.id)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// One custom color: label, picker, hex input and reset.
private struct ColorRow: View {
    let key: String
    let label: String
    let detail: String
    let mode: String
    @EnvironmentObject private var workspace: Workspace
    @EnvironmentObject private var appearance: AppearanceStore
    @Environment(\.tokens) private var tokens
    @State private var text = ""
    @State private var invalid = false
    private var custom: String? { (mode == "dark" ? appearance.appearance.palettes.dark : appearance.appearance.palettes.light)[key] }
    private var effective: String {
        let preset = ThemePreset.all.first { $0.id == appearance.appearance.preset } ?? ThemePreset.all[0]
        return custom ?? (mode == "dark" ? preset.dark : preset.light)[key] ?? "#000000"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(TypeScale.smMedium)
                Text(detail).font(TypeScale.xs).foregroundStyle(tokens.text2)
            }
            HStack(spacing: 6) {
                ColorPicker(label, selection: Binding(get: { Color(hex: effective) }, set: { commit($0.hex) }), supportsOpacity: false)
                    .labelsHidden()
                    .frame(width: 40, height: 40)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tokens.line, lineWidth: 1).allowsHitTesting(false))
                TextInput(placeholder: "#000000", text: $text, invalid: invalid, identifier: "hex-" + key) { commit(text) }
                    .frame(width: 120)
                    .onChange(of: text) { _, value in
                        invalid = false
                        if value.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil, value.lowercased() != effective { commit(value) }
                    }
                Button { set(nil) } label: { Icon(.rotateCcw, size: 16) }.harborButton(.ghost, size: .icon).disabled(custom == nil)
                    .accessibilityLabel("Reset \(label.lowercased()) color")
                Spacer(minLength: 0)
            }
            if invalid { Text("Use a hex color, like #2563eb or #fff.").font(TypeScale.xs).foregroundStyle(tokens.dangerText) }
        }
        .padding(.vertical, 12)
        .overlay(alignment: .top) { Hairline() }
        .onAppear { text = effective }
        .onChange(of: effective) { _, value in if text.lowercased() != value { text = value } }
    }
    private func commit(_ value: String) {
        guard let color = HarborPalette.normalize(value) else { invalid = true; return }
        invalid = false
        text = color
        if color != effective { set(color) }
    }
    private func set(_ color: String?) {
        appearance.change(workspace.api) { value in
            if mode == "dark" { value.palettes.dark[key] = color } else { value.palettes.light[key] = color }
        }
    }
}
