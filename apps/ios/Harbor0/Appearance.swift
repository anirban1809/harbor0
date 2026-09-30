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
        return HarborPalette(values: values)
    }
}

struct ThemePreset: Identifiable {
    let id: String
    let name: String
    let detail: String
    let light: [String: String]
    let dark: [String: String]
    private static func colors(_ primary: String, _ background: String, _ card: String, _ sidebar: String, _ border: String) -> [String: String] {
        ["primary": primary, "background": background, "card": card, "sidebar": sidebar, "border": border]
    }
    // Same named presets and hex colors as the web/desktop appearance-presets.ts.
    static let all: [ThemePreset] = [
        .init(id: "default", name: "Harbor", detail: "Neutral grays",
              light: colors("#171717", "#fafafa", "#ffffff", "#f5f5f5", "#e5e5e5"),
              dark: colors("#fafafa", "#171717", "#202020", "#1c1c1c", "#363636")),
        .init(id: "ocean", name: "Ocean", detail: "Blue tones",
              light: colors("#2563eb", "#eff6ff", "#ffffff", "#dbeafe", "#bfdbfe"),
              dark: colors("#60a5fa", "#0b1220", "#111e33", "#0e192b", "#294362")),
        .init(id: "forest", name: "Forest", detail: "Green tones",
              light: colors("#187047", "#f0f7f2", "#ffffff", "#deeee2", "#bed8c6"),
              dark: colors("#6cce98", "#0c1712", "#14261d", "#102017", "#305340")),
        .init(id: "violet", name: "Violet", detail: "Purple tones",
              light: colors("#7c3aed", "#f7f3ff", "#ffffff", "#ede5fb", "#d8c9ed"),
              dark: colors("#b794f6", "#171122", "#241b34", "#1d162b", "#4a3766")),
        .init(id: "sunset", name: "Sunset", detail: "Orange tones",
              light: colors("#b94719", "#fff7ed", "#fffcf8", "#ffead5", "#edcdb2"),
              dark: colors("#fbad77", "#20140f", "#302018", "#281a13", "#60412f"))
    ]
}

struct HarborPalette {
    let values: [String: String]
    var accent: Color { color("primary") }
    var background: Color { color("background") }
    var card: Color { color("card") }
    var sidebar: Color { color("sidebar") }
    var border: Color { color("border") }
    var ink: Color { Self.contrast(values["background"]!) }
    var cardInk: Color { Self.contrast(values["card"]!) }
    var sidebarInk: Color { Self.contrast(values["sidebar"]!) }
    var onAccent: Color { Self.contrast(values["primary"]!) }
    func color(_ key: String) -> Color { Color(hex: values[key] ?? "#171717") }
    static func isHex(_ value: String) -> Bool { value.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil }
    static func useBlackInk(_ hex: String) -> Bool {
        let rgb = UInt64(hex.dropFirst(), radix: 16) ?? 0
        let parts = [16, 8, 0].map { shift -> Double in
            let value = Double((rgb >> shift) & 255) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        let luminance = parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722
        return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    }
    static func contrast(_ hex: String) -> Color { useBlackInk(hex) ? .black : .white }
}

extension Color {
    init(hex: String) {
        let value = UInt64(hex.dropFirst(), radix: 16) ?? 0
        self.init(.sRGB, red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255, opacity: 1)
    }
    var hex: String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return String(format: "#%02x%02x%02x", Int(red * 255), Int(green * 255), Int(blue * 255))
    }
}

private struct PaletteKey: EnvironmentKey { static let defaultValue = HarborPalette(values: ThemePreset.all[0].light) }
extension EnvironmentValues {
    var harborPalette: HarborPalette { get { self[PaletteKey.self] } set { self[PaletteKey.self] = newValue } }
}

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
            savedMessage = "Appearance saved to your account."
        } catch { if generation == stamp { self.error = error.localizedDescription } }
    }
    func reset() {
        generation = UUID()
        appearance = Appearance(); saved = Appearance(); account = nil
        loading = false; saving = false; error = nil; savedMessage = nil
    }
}

struct WorkspaceStyle: ViewModifier {
    @Environment(\.harborPalette) private var palette
    func body(content: Content) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(palette.background)
            .foregroundStyle(palette.cardInk)
            .toolbarBackground(palette.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(HarborPalette.useBlackInk(palette.values["background"]!) ? .light : .dark, for: .navigationBar)
    }
}
extension View {
    func workspaceStyle() -> some View { modifier(WorkspaceStyle()) }
}
