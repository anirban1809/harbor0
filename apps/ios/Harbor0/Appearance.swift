import SwiftUI
import Combine

struct Appearance: Codable, Equatable {
    var preference = "system"
    var preset = "default"
    var palettes = Overrides()
    struct Overrides: Codable, Equatable {
        var light: [String: String] = [:]
        var dark: [String: String] = [:]
    }
    var colorScheme: ColorScheme? { preference == "system" ? nil : (preference == "dark" ? .dark : .light) }
    func palette(for system: ColorScheme) -> HarborPalette {
        let dark = (colorScheme ?? system) == .dark
        let base = ThemePreset.all.first { $0.id == preset } ?? ThemePreset.all[0]
        var values = dark ? base.dark : base.light
        for (key, value) in (dark ? palettes.dark : palettes.light) where HarborPalette.isHex(value) { values[key] = value }
        return HarborPalette(values: values, dark: dark)
    }
}

struct ThemePreset: Identifiable {
    let id: String
    let name: String
    let detail: String
    let light: [String: String]
    let dark: [String: String]
    /// The three colors shown on the preset card (appearance-presets.ts swatches).
    let swatches: [String]
    private static func colors(_ primary: String, _ background: String, _ card: String, _ sidebar: String, _ border: String) -> [String: String] {
        ["primary": primary, "background": background, "card": card, "sidebar": sidebar, "border": border]
    }
    // Same named presets and hex colors as the web/desktop tokens.css and appearance-presets.ts.
    static let all: [ThemePreset] = [
        .init(id: "default", name: "Harbor", detail: "Indigo on neutral",
              light: colors("#4353d9", "#ffffff", "#ffffff", "#f4f5f7", "#e3e5ea"),
              dark: colors("#8793ff", "#141518", "#1b1d21", "#0d0e10", "#2b2e34"),
              swatches: ["#4353d9", "#f4f5f7", "#ffffff"]),
        .init(id: "ocean", name: "Ocean", detail: "Blue tones",
              light: colors("#2563eb", "#eff6ff", "#ffffff", "#dbeafe", "#bfdbfe"),
              dark: colors("#60a5fa", "#0b1220", "#111e33", "#0e192b", "#294362"),
              swatches: ["#eff6ff", "#dbeafe", "#2563eb"]),
        .init(id: "forest", name: "Forest", detail: "Green tones",
              light: colors("#187047", "#f0f7f2", "#ffffff", "#deeee2", "#bed8c6"),
              dark: colors("#6cce98", "#0c1712", "#14261d", "#102017", "#305340"),
              swatches: ["#f0f7f2", "#deeee2", "#187047"]),
        .init(id: "violet", name: "Violet", detail: "Purple tones",
              light: colors("#7c3aed", "#f7f3ff", "#ffffff", "#ede5fb", "#d8c9ed"),
              dark: colors("#b794f6", "#171122", "#241b34", "#1d162b", "#4a3766"),
              swatches: ["#f7f3ff", "#ede5fb", "#7c3aed"]),
        .init(id: "sunset", name: "Sunset", detail: "Orange tones",
              light: colors("#b94719", "#fff7ed", "#fffcf8", "#ffead5", "#edcdb2"),
              dark: colors("#fbad77", "#20140f", "#302018", "#281a13", "#60412f"),
              swatches: ["#fff7ed", "#ffead5", "#b94719"])
    ]
    /// Swatches as the web shows them: Harbor's fixed trio, other presets' first three colors for the mode.
    func cardSwatches(dark: Bool) -> [String] {
        if id == "default" { return swatches }
        let values = dark ? self.dark : light
        return ["primary", "background", "card"].compactMap { values[$0] }
    }
}

/// The resolved five colors for one mode, including any valid custom overrides.
struct HarborPalette {
    let values: [String: String]
    var dark = false
    func color(_ key: String) -> Color { Color(hex: values[key] ?? "#4353d9") }
    var tokensPalette: Palette {
        func rgb(_ key: String) -> RGB { RGB(hex: values[key] ?? "#4353d9") }
        return Palette(dark: dark, primary: rgb("primary"), background: rgb("background"), card: rgb("card"),
                       sidebar: rgb("sidebar"), border: rgb("border"))
    }
    static func isHex(_ value: String) -> Bool { value.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil }
    static func useBlackInk(_ hex: String) -> Bool { RGB(hex: hex).prefersBlackInk }
    /// Accepts #rgb or #rrggbb, like normalizeHex in appearance-colors.ts.
    static func normalize(_ value: String) -> String? {
        let hex = value.trimmingCharacters(in: .whitespaces).lowercased()
        if isHex(hex) { return hex }
        if hex.range(of: "^#[a-f0-9]{3}$", options: .regularExpression) != nil {
            return "#" + hex.dropFirst().map { "\($0)\($0)" }.joined()
        }
        return nil
    }
}

extension Color {
    init(hex: String) {
        let value = UInt64(hex.dropFirst(), radix: 16) ?? 0
        self.init(.sRGB, red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, opacity: 1)
    }
    var hex: String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let clamp = { (v: CGFloat) in Int((min(1, max(0, v)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", clamp(red), clamp(green), clamp(blue))
    }
}

/// The account's appearance and profile. Edits apply at once and save to the account,
/// the same preference used by web and desktop.
@MainActor
final class AppearanceStore: ObservableObject {
    @Published var appearance = Appearance()
    @Published private(set) var account: Account?
    @Published private(set) var saved = Appearance()
    @Published private(set) var loading = false
    @Published private(set) var saving = false
    @Published var error: String?
    @Published var savedMessage: String?
    private var generation = UUID()
    private var autosave: Task<Void, Never>?
    var dirty: Bool { appearance != saved }

    func load(_ api: HarborAPI) async {
        guard !loading, !saving else { return }
        let stamp = generation
        loading = true
        defer { if generation == stamp { loading = false } }
        do {
            let response: Account = try await api.request("/v1/users/me")
            guard generation == stamp else { return }
            if !dirty { appearance = response.user.appearance ?? Appearance(); saved = appearance }
            account = response
            error = nil
        } catch is CancellationError { }
        catch { if generation == stamp { self.error = error.localizedDescription } }
    }
    func save(_ api: HarborAPI) async {
        guard !saving, account != nil else { return }
        // A refresh already in flight must not overwrite the newly saved draft.
        generation = UUID()
        loading = false
        let stamp = generation
        saving = true
        error = nil
        savedMessage = nil
        defer { if generation == stamp { saving = false } }
        do {
            let snapshot = appearance
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
            let _: ProfileResponse = try await api.request("/v1/users/me", method: "PATCH", body: ["operationId": UUID().uuidString, "appearance": encoded])
            guard generation == stamp else { return }
            saved = snapshot
            savedMessage = "Saved to your account."
            // Edits made while saving are saved next.
            if dirty { scheduleSave(api) }
        } catch { if generation == stamp { self.error = error.localizedDescription } }
    }
    /// Applies a change now and saves it shortly after, coalescing quick edits.
    func change(_ api: HarborAPI, _ edit: (inout Appearance) -> Void) {
        edit(&appearance)
        savedMessage = nil
        scheduleSave(api)
    }
    private func scheduleSave(_ api: HarborAPI) {
        autosave?.cancel()
        autosave = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self else { return }
            if self.saving { return }
            await self.save(api)
        }
    }
    func setAccount(_ account: Account) { self.account = account }
    func reset() {
        generation = UUID()
        autosave?.cancel()
        appearance = Appearance(); saved = Appearance(); account = nil
        loading = false; saving = false; error = nil; savedMessage = nil
    }
}
