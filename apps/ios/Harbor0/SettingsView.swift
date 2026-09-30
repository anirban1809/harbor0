import SwiftUI

struct SettingsView: View {
    @ObservedObject var api: HarborAPI
    @EnvironmentObject var appearance: AppearanceStore
    @EnvironmentObject var transfers: TransferState
    @Environment(\.harborPalette) private var palette
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmSignOut = false
    @State private var signingOut = false
    @State private var signOutError: String?
    @State private var customMode = "light"

    var body: some View {
        List {
            if let account = appearance.account {
                Section("Account") {
                    HStack(spacing: 14) {
                        Image(systemName: "person.crop.circle.fill").font(.system(size: 34)).foregroundStyle(palette.accent)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(account.user.displayName).font(.headline)
                            Text(account.user.email).font(.subheadline).foregroundStyle(palette.cardInk.opacity(0.65))
                        }
                    }.padding(.vertical, 4)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Storage").font(.subheadline.weight(.medium))
                            Spacer()
                            Text("\(bytes(account.storage.usedBytes)) of \(bytes(account.storage.quotaBytes))")
                                .font(.caption).foregroundStyle(palette.cardInk.opacity(0.65))
                        }
                        ProgressView(value: min(1, Double(account.storage.usedBytes) / Double(max(1, account.storage.quotaBytes))))
                    }.padding(.vertical, 4)
                }.listRowBackground(palette.card)
            } else if appearance.loading { ProgressView("Loading settings…").listRowBackground(Color.clear) }
            if let error = appearance.error {
                LoadFailure(message: error) {
                    Task { if appearance.dirty { await appearance.save(api) } else { await appearance.load(api) } }
                }
            }
            Section {
                Picker("Appearance", selection: $appearance.appearance.preference) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }.pickerStyle(.segmented).accessibilityIdentifier("appearanceMode")
                    .padding(.vertical, 4)
            } header: { Text("Appearance") }
              footer: { Text("Use the same colors as harbor0 on the web and desktop.") }
              .listRowBackground(palette.card)
              .disabled(appearance.saving || appearance.account == nil)
            Section("Color scheme") {
                ForEach(ThemePreset.all) { preset in
                    Button {
                        appearance.appearance.preset = preset.id
                        appearance.appearance.palettes = .init()
                        appearance.savedMessage = nil
                    } label: {
                        HStack(spacing: 14) {
                            HStack(spacing: -6) {
                                ForEach(["background", "sidebar", "primary"], id: \.self) { key in
                                    Circle().fill(Color(hex: (colorScheme == .dark ? preset.dark : preset.light)[key]!))
                                        .frame(width: 23, height: 23)
                                        .overlay(Circle().stroke(palette.border, lineWidth: 1))
                                }
                            }.accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(preset.name).font(.body.weight(.medium))
                                Text(preset.detail).font(.caption).foregroundStyle(palette.cardInk.opacity(0.6))
                            }
                            Spacer()
                            if appearance.appearance.preset == preset.id {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(palette.accent)
                            }
                        }.padding(.vertical, 3).foregroundStyle(palette.cardInk).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("theme-" + preset.id)
                        .accessibilityAddTraits(appearance.appearance.preset == preset.id ? [.isSelected] : [])
                }
            }.listRowBackground(palette.card).disabled(appearance.saving || appearance.account == nil)
            Section {
                DisclosureGroup("Custom colors") {
                    Picker("Edit colors for", selection: $customMode) {
                        Text("Light").tag("light"); Text("Dark").tag("dark")
                    }.pickerStyle(.segmented)
                    ForEach(colorFields, id: \.key) { field in
                        ColorPicker(field.name, selection: colorBinding(field.key), supportsOpacity: false)
                    }
                    Button("Reset custom colors") {
                        if customMode == "dark" { appearance.appearance.palettes.dark = [:] }
                        else { appearance.appearance.palettes.light = [:] }
                    }
                }
            }.listRowBackground(palette.card).disabled(appearance.saving || appearance.account == nil)
            Section {
                Button {
                    Task { await appearance.save(api) }
                } label: {
                    HStack {
                        Spacer()
                        if appearance.saving { ProgressView().tint(palette.onAccent) }
                        Text(appearance.saving ? "Saving…" : "Save appearance").fontWeight(.semibold)
                        Spacer()
                    }.padding(.vertical, 6)
                }.buttonStyle(.borderedProminent).tint(palette.accent).foregroundStyle(palette.onAccent)
                    .disabled(!appearance.dirty || appearance.saving || appearance.account == nil)
                    .accessibilityIdentifier("saveAppearance")
                if appearance.dirty {
                    Text("Previewing changes. Save to use them on your other devices.").font(.caption).foregroundStyle(palette.cardInk.opacity(0.65))
                    Button("Discard changes") { appearance.appearance = appearance.saved; appearance.error = nil }
                        .font(.subheadline).disabled(appearance.saving)
                } else if let message = appearance.savedMessage {
                    Label(message, systemImage: "checkmark.circle").font(.caption).accessibilityIdentifier("appearanceSaved")
                }
            }.listRowBackground(palette.card)
            Section {
                if let signOutError { Text(signOutError).font(.subheadline).foregroundStyle(.red) }
                Button("Sign out", role: .destructive) { confirmSignOut = true }
                    .disabled(signingOut || transfers.busy || appearance.saving)
                    .accessibilityIdentifier("signOut")
            } footer: {
                Text("harbor0 for iPhone · Version 0.1\nSync and automatic backups run on your connected computers.")
            }.listRowBackground(palette.card)
        }
        .navigationTitle("Settings")
        .workspaceStyle()
        .task { await appearance.load(api); customMode = colorScheme == .dark ? "dark" : "light" }
        .refreshable { await appearance.load(api) }
        .confirmationDialog("Sign out of harbor0?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                signingOut = true
                Task {
                    defer { signingOut = false }
                    do { try await api.logout() }
                    catch { signOutError = error.localizedDescription }
                }
            }
        }
    }

    private let colorFields: [(key: String, name: String)] = [
        ("primary", "Accent"), ("background", "Background"), ("card", "Cards"),
        ("sidebar", "Navigation"), ("border", "Borders")
    ]
    private func colorBinding(_ key: String) -> Binding<Color> {
        Binding {
            let preset = ThemePreset.all.first { $0.id == appearance.appearance.preset } ?? ThemePreset.all[0]
            let values = customMode == "dark" ? appearance.appearance.palettes.dark : appearance.appearance.palettes.light
            let base = customMode == "dark" ? preset.dark : preset.light
            return Color(hex: values[key] ?? base[key]!)
        } set: { color in
            if customMode == "dark" { appearance.appearance.palettes.dark[key] = color.hex }
            else { appearance.appearance.palettes.light[key] = color.hex }
        }
    }
    private func bytes(_ value: Int64) -> String { ByteCountFormatter.string(fromByteCount: value, countStyle: .file) }
}
