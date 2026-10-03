import SwiftUI

// The component kit, mirroring apps/web/app/styles/components.css at phone sizes (mobile.css).

// MARK: - Buttons

enum ButtonVariant { case primary, outline, ghost, danger, link }
enum ButtonSize { case sm, md, lg, icon, iconSm }

struct HarborButtonStyle: ButtonStyle {
    var variant: ButtonVariant = .primary
    var size: ButtonSize = .md
    var block = false
    @Environment(\.tokens) private var tokens
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        let height: CGFloat = switch size { case .sm, .iconSm: 32; case .md, .icon: 40; case .lg: 44 }
        let font: Font = switch size { case .sm, .iconSm: TypeScale.xsMedium; case .lg: TypeScale.baseMedium; default: TypeScale.smMedium }
        Group {
            if variant == .link {
                configuration.label.lineLimit(1).foregroundStyle(tokens.accentText).opacity(pressed ? 0.6 : 1)
            } else {
                HStack(spacing: 6) { configuration.label.font(font).lineLimit(1) }
                    .padding(.horizontal, size == .icon || size == .iconSm ? 0 : (size == .sm ? 10 : (size == .lg ? 16 : 12)))
                    .frame(width: size == .icon ? 40 : (size == .iconSm ? 32 : nil), height: height)
                    .frame(maxWidth: block ? .infinity : nil)
                    .foregroundStyle(foreground)
                    .background(background(pressed), in: RoundedRectangle(cornerRadius: 8))
                    .overlay {
                        if variant == .outline { RoundedRectangle(cornerRadius: 8).strokeBorder(tokens.line, lineWidth: 1) }
                    }
                    .contentShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .opacity(enabled ? 1 : 0.5)
    }
    private var foreground: Color {
        switch variant {
        case .primary: tokens.onPrimary
        case .danger: tokens.onDestructive
        case .ghost: tokens.text2
        default: tokens.text
        }
    }
    private func background(_ pressed: Bool) -> Color {
        switch variant {
        case .primary: pressed ? tokens.palette.primary.mix(0.88, into: tokens.textRGB).color : tokens.primary
        case .danger: pressed ? tokens.palette.destructive.mix(0.88, into: tokens.textRGB).color : tokens.destructive
        case .outline: pressed ? tokens.fill1 : tokens.surface
        case .ghost: pressed ? tokens.fill2 : .clear
        case .link: .clear
        }
    }
}
extension View {
    func harborButton(_ variant: ButtonVariant = .primary, size: ButtonSize = .md, block: Bool = false) -> some View {
        buttonStyle(HarborButtonStyle(variant: variant, size: size, block: block))
    }
}

/// A plain press style that dims slightly, for rows and tiles.
struct PressStyle: ButtonStyle {
    @Environment(\.tokens) private var tokens
    var highlight = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed && highlight ? tokens.fill1 : .clear)
            .contentShape(Rectangle())
    }
}

// MARK: - Surfaces

/// .card: 1pt border, 12pt radius, 16pt padding on phones.
struct Card<Content: View>: View {
    var title: String? = nil
    var description: String? = nil
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if title != nil || description != nil {
                VStack(alignment: .leading, spacing: 2) {
                    if let title { Text(title).font(TypeScale.lg).tracking(-0.16) }
                    if let description { CardDescription(text: description) }
                }.padding(.bottom, 16)
            }
            content
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(CardChrome())
    }
}
private struct CardDescription: View {
    let text: String
    @Environment(\.tokens) private var tokens
    var body: some View { Text(text).font(TypeScale.sm).foregroundStyle(tokens.text2).lineSpacing(3).fixedSize(horizontal: false, vertical: true) }
}
struct CardChrome: ViewModifier {
    var radius: CGFloat = 12
    @Environment(\.tokens) private var tokens
    func body(content: Content) -> some View {
        content
            .cardSurface(paint: false)
            .background(tokens.card, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(tokens.line, lineWidth: 1))
    }
}

// MARK: - Badges, tiles, progress

enum Tone { case neutral, accent, success, warning, danger }

struct Badge: View {
    let text: String
    var tone: Tone = .neutral
    var icon: Lucide? = nil
    var spinning = false
    @Environment(\.tokens) private var tokens
    var body: some View {
        HStack(spacing: 4) {
            if let icon {
                Icon(icon, size: 12).rotationEffect(.degrees(spinning ? 360 : 0))
                    .animation(spinning ? .linear(duration: 1).repeatForever(autoreverses: false) : nil, value: spinning)
            }
            Text(text).font(TypeScale.xsMedium).lineLimit(1)
        }
        .padding(.horizontal, 8).frame(height: 22)
        .foregroundStyle(foreground).background(background, in: Capsule())
        .fixedSize()
    }
    private var foreground: Color {
        switch tone { case .neutral: tokens.text2; case .accent: tokens.accentText; case .success: tokens.successText; case .warning: tokens.warningText; case .danger: tokens.dangerText }
    }
    private var background: Color {
        switch tone { case .neutral: tokens.fill2; case .accent: tokens.accentSoft; case .success: tokens.successSoft; case .warning: tokens.warningSoft; case .danger: tokens.dangerSoft }
    }
}

/// .icon-tile: a rounded square with a muted icon.
struct IconTile: View {
    let icon: Lucide
    var size: CGFloat = 32
    var iconSize: CGFloat = 16
    var radius: CGFloat = 8
    var active = false
    @Environment(\.tokens) private var tokens
    var body: some View {
        Icon(icon, size: iconSize)
            .frame(width: size, height: size)
            .foregroundStyle(active ? tokens.accentText : tokens.text2)
            .background(active ? tokens.accentSoft : tokens.fill2, in: RoundedRectangle(cornerRadius: radius))
    }
}

enum FileKind { case folder, image, document, plain }
extension DriveItem {
    var kind: FileKind {
        if isFolder { return .folder }
        if mimeType?.hasPrefix("image/") == true { return .image }
        if mimeType?.contains("pdf") == true || mimeType?.hasPrefix("text/") == true { return .document }
        return .plain
    }
}
extension ManifestEntry {
    var kind: FileKind {
        if isFolder { return .folder }
        if mimeType?.hasPrefix("image/") == true { return .image }
        if mimeType?.contains("pdf") == true || mimeType?.hasPrefix("text/") == true { return .document }
        return .plain
    }
}

/// .file-entry-icon at phone size: 40pt, kind-tinted (folder = accent, image = teal).
struct FileTile: View {
    let kind: FileKind
    var size: CGFloat = 40
    @Environment(\.tokens) private var tokens
    var body: some View {
        let tint: Color = switch kind { case .folder: tokens.primary; case .image: tokens.kindImage; default: tokens.text2 }
        let icon: Lucide = switch kind { case .folder: .folder; case .image: .fileImage; case .document: .fileText; case .plain: .file }
        Icon(icon, size: size / 2)
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: size / 4))
    }
}

struct ProgressBar: View {
    var value: Double? // nil = indeterminate
    var height: CGFloat = 6
    @Environment(\.tokens) private var tokens
    @State private var phase = false
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(tokens.fill3)
                if let value {
                    Capsule().fill(tokens.primary).frame(width: max(value > 0 ? height : 0, geometry.size.width * min(1, max(0, value))))
                } else {
                    Capsule().fill(tokens.primary).frame(width: geometry.size.width * 0.35)
                        .offset(x: phase ? geometry.size.width : -geometry.size.width * 0.35)
                        .onAppear { withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: false)) { phase = true } }
                }
            }.clipShape(Capsule())
        }.frame(height: height)
    }
}

/// .checkbox: 18pt rounded square, accent fill when checked or mixed.
struct CheckBox: View {
    var checked: Bool
    var mixed = false
    @Environment(\.tokens) private var tokens
    var body: some View {
        let on = checked || mixed
        RoundedRectangle(cornerRadius: 5)
            .fill(on ? tokens.primary : tokens.surface)
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(on ? tokens.primary : tokens.strongLine, lineWidth: 1.5))
            .overlay {
                if mixed && !checked { Icon(.minus, size: 12, weight: 3).foregroundStyle(tokens.onPrimary) }
                else if checked { Icon(.check, size: 12, weight: 3).foregroundStyle(tokens.onPrimary) }
            }
            .frame(width: 18, height: 18)
    }
}

struct Spinner: View {
    var size: CGFloat = 16
    @State private var spinning = false
    var body: some View {
        Icon(.loaderCircle, size: size)
            .rotationEffect(.degrees(spinning ? 360 : 0))
            .onAppear { withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { spinning = true } }
    }
}

// MARK: - Segmented controls

struct SegmentOption<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    var icon: Lucide? = nil
    var iconOnly = false
    var id: Value { value }
}

/// .tabs-list / .segmented: a fill-2 track with a raised surface segment for the selection.
struct Segmented<Value: Hashable>: View {
    let options: [SegmentOption<Value>]
    @Binding var selection: Value
    var fill = false
    var height: CGFloat = 34
    var identifier: String? = nil
    @Environment(\.tokens) private var tokens
    @Namespace private var namespace
    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.value == selection
                Button {
                    withAnimation(.easeOut(duration: 0.14)) { selection = option.value }
                } label: {
                    HStack(spacing: 6) {
                        if let icon = option.icon { Icon(icon, size: 16) }
                        if !option.iconOnly { Text(option.label).font(TypeScale.smMedium).lineLimit(1) }
                    }
                    .padding(.horizontal, option.iconOnly ? 0 : 12)
                    .frame(width: option.iconOnly ? 36 : nil, height: height - 6)
                    .frame(maxWidth: fill ? .infinity : nil)
                    .foregroundStyle(selected ? tokens.text : tokens.text2)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 7).fill(tokens.surface)
                                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(tokens.textRGB.opacity(0.08).color, lineWidth: 1))
                                .shadow(color: Color.black.opacity(0.08), radius: 1, y: 1)
                                .matchedGeometryEffect(id: "segment", in: namespace)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.label)
                .accessibilityIdentifier((identifier.map { $0 + "-" } ?? "segment-") + option.label.lowercased())
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
        .padding(3)
        .background(tokens.fill2, in: RoundedRectangle(cornerRadius: 10))
    }
}

/// List/grid switch (.view-switch).
struct ViewSwitch: View {
    @Binding var grid: Bool
    var body: some View {
        Segmented(options: [SegmentOption(value: false, label: "List view", icon: .list, iconOnly: true),
                            SegmentOption(value: true, label: "Grid view", icon: .layoutGrid, iconOnly: true)],
                  selection: $grid, height: 40, identifier: "view")
    }
}

/// A pill chip used for filters (.drive-filters select / button at phone size).
struct Chip: View {
    let label: String
    var active = false
    var chevron = true
    @Environment(\.tokens) private var tokens
    var body: some View {
        HStack(spacing: 6) {
            Text(label).font(TypeScale.sm).lineLimit(1)
            if chevron { Icon(.chevronDown, size: 14).foregroundStyle(active ? tokens.accentText : tokens.text3) }
        }
        .padding(.leading, 14).padding(.trailing, chevron ? 10 : 14)
        .frame(height: 34)
        .foregroundStyle(active ? tokens.accentText : tokens.text)
        .background(active ? tokens.accentSoft : tokens.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(active ? tokens.accentBorder : tokens.line, lineWidth: 1))
        .contentShape(Capsule())
    }
}

// MARK: - Inputs

struct FieldLabel: View {
    let text: String
    var body: some View { Text(text).font(TypeScale.smMedium) }
}

/// .field: label, control, hint.
struct Field<Content: View, Accessory: View>: View {
    let label: String
    var hint: String? = nil
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) { FieldLabel(text: label); Spacer(); accessory }
            content
            if let hint { Text(hint).font(TypeScale.xs).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true) }
        }
    }
}
extension Field where Accessory == EmptyView {
    init(label: String, hint: String? = nil, @ViewBuilder content: () -> Content) {
        self.label = label; self.hint = hint; self.accessory = EmptyView(); self.content = content()
    }
}

/// .input: 40pt (44 large), 8pt radius, line border, focus ring in the accent color.
struct InputChrome: ViewModifier {
    var focused: Bool
    var invalid = false
    var large = false
    var prefix: String? = nil
    var icon: Lucide? = nil
    @Environment(\.tokens) private var tokens
    func body(content: Content) -> some View {
        HStack(spacing: 6) {
            if let icon { Icon(icon, size: 16).foregroundStyle(tokens.text3) }
            if let prefix { Text(prefix).font(Font.geist(16)).foregroundStyle(tokens.text3) }
            content.font(Font.geist(16)).foregroundStyle(tokens.text).tint(tokens.primary)
        }
        .padding(.horizontal, large ? 12 : 10)
        .frame(height: large ? 44 : 40)
        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(invalid ? tokens.destructive : (focused ? tokens.primary : tokens.line), lineWidth: 1))
        .background(RoundedRectangle(cornerRadius: 8).stroke(focused ? (invalid ? tokens.destructive : tokens.primary).opacity(0.2) : .clear, lineWidth: 6))
    }
}

struct TextInput: View {
    var placeholder = ""
    @Binding var text: String
    var prefix: String? = nil
    var icon: Lucide? = nil
    var large = false
    var invalid = false
    var keyboard: UIKeyboardType = .default
    var content: UITextContentType? = nil
    var autocapitalize = false
    var identifier: String? = nil
    var submit: (() -> Void)? = nil
    @FocusState private var focused: Bool
    @Environment(\.tokens) private var tokens
    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(tokens.text3))
            .keyboardType(keyboard)
            .textContentType(content)
            .textInputAutocapitalization(autocapitalize ? .sentences : .never)
            .autocorrectionDisabled(!autocapitalize)
            .focused($focused)
            .onSubmit { submit?() }
            .accessibilityIdentifier(identifier ?? placeholder)
            .modifier(InputChrome(focused: focused, invalid: invalid, large: large, prefix: prefix, icon: icon))
    }
}

/// PasswordInput: a secure field with a show/hide toggle.
struct PasswordInput: View {
    @Binding var text: String
    var newPassword = false
    var identifier = "password"
    var submit: (() -> Void)? = nil
    @State private var shown = false
    @FocusState private var focused: Bool
    @Environment(\.tokens) private var tokens
    var body: some View {
        HStack(spacing: 0) {
            Group {
                if shown { TextField("", text: $text).textInputAutocapitalization(.never).autocorrectionDisabled() }
                else { SecureField("", text: $text) }
            }
            .textContentType(newPassword ? .newPassword : .password)
            .focused($focused)
            .onSubmit { submit?() }
            .accessibilityIdentifier(identifier)
            .accessibilityLabel("Password")
            Button { shown.toggle() } label: {
                Icon(shown ? .eyeOff : .eye, size: 16).foregroundStyle(tokens.text3).frame(width: 32, height: 32)
            }.buttonStyle(.plain).accessibilityLabel(shown ? "Hide password" : "Show password")
                .padding(.trailing, -8)
        }
        .modifier(InputChrome(focused: focused, large: true))
    }
}

// MARK: - Feedback

/// .alert with tones and an optional link action and dismiss button.
struct AlertBanner: View {
    var tone: Tone = .neutral
    let text: String
    var actionLabel: String? = nil
    var dismiss: (() -> Void)? = nil
    var action: (() -> Void)? = nil
    @Environment(\.tokens) private var tokens
    init(tone: Tone = .neutral, text: String, dismiss: (() -> Void)? = nil) {
        self.tone = tone; self.text = text; self.dismiss = dismiss
    }
    init(tone: Tone = .neutral, text: String, actionLabel: String?, action: (() -> Void)? = nil) {
        self.tone = tone; self.text = text; self.actionLabel = actionLabel; self.action = action
    }
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Icon(icon, size: 16).padding(.top, 2).foregroundStyle(tone == .neutral || tone == .success ? iconColor : foreground)
            VStack(alignment: .leading, spacing: 4) {
                Text(text).font(TypeScale.sm).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let actionLabel, let action {
                    Button(actionLabel, action: action).font(TypeScale.smMedium).underline()
                        .buttonStyle(.plain).foregroundStyle(foreground)
                }
            }
            if let dismiss {
                Button(action: dismiss) { Icon(.x, size: 16).frame(width: 28, height: 28) }
                    .buttonStyle(.plain).accessibilityLabel("Dismiss").padding(.vertical, -6).padding(.trailing, -6)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .foregroundStyle(foreground)
        .background(background, in: RoundedRectangle(cornerRadius: 8))
    }
    private var icon: Lucide {
        switch tone { case .danger: .circleAlert; case .warning: .triangleAlert; case .success: .circleCheck; default: .info }
    }
    private var iconColor: Color { tone == .success ? tokens.successText : tokens.text2 }
    private var foreground: Color {
        switch tone { case .danger: tokens.dangerText; case .warning: tokens.warningText; default: tokens.text }
    }
    private var background: Color {
        switch tone { case .danger: tokens.dangerSoft; case .warning: tokens.warningSoft; default: tokens.fill1 }
    }
}

/// .empty-state: an icon tile, title, description and optional actions.
struct EmptyStateView<Actions: View>: View {
    let icon: Lucide
    let title: String
    let description: String
    var compact = false
    @ViewBuilder var actions: Actions
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(spacing: 16) {
            Icon(icon, size: 20, weight: 1.75)
                .foregroundStyle(tokens.text2)
                .frame(width: 44, height: 44)
                .background(tokens.fill2, in: RoundedRectangle(cornerRadius: 12))
            VStack(spacing: 4) {
                Text(title).font(TypeScale.baseMedium).foregroundStyle(tokens.text)
                Text(description).font(TypeScale.sm).foregroundStyle(tokens.text2).lineSpacing(3)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: 380)
            HStack(spacing: 8) { actions }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, compact ? 16 : 24).padding(.vertical, compact ? 32 : 56)
    }
}
extension EmptyStateView where Actions == EmptyView {
    init(icon: Lucide, title: String, description: String, compact: Bool = false) {
        self.icon = icon; self.title = title; self.description = description; self.compact = compact; self.actions = EmptyView()
    }
}

struct LoadErrorView: View {
    var title = "This view couldn’t be loaded."
    var compact = false
    let retry: () -> Void
    var body: some View {
        EmptyStateView(icon: .wifiOff, title: title, description: "Your data hasn’t changed. Check your connection and try again.", compact: compact) {
            Button(action: retry) { Icon(.refreshCw, size: 16); Text("Try again") }.harborButton(.outline)
        }
    }
}

/// Pulsing skeleton rows (ContentSkeleton / FileCollectionSkeleton).
struct SkeletonRows: View {
    var count = 6
    var tile: CGFloat = 40
    @Environment(\.tokens) private var tokens
    @State private var pulse = false
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: tile / 4).frame(width: tile, height: tile)
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 6).frame(width: [180, 140, 210][index % 3], height: 12)
                        RoundedRectangle(cornerRadius: 6).frame(width: 110, height: 10)
                    }
                    Spacer()
                }
                .foregroundStyle(tokens.fill2)
                .frame(height: 64)
                .overlay(alignment: .bottom) { Rectangle().fill(tokens.line).frame(height: 1) }
            }
        }
        .opacity(pulse ? 0.55 : 1)
        .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true } }
        .accessibilityLabel("Loading")
    }
}

// MARK: - Sheets

/// A web-style bottom sheet: 20pt top radius, grab handle, title, close X and description.
struct SheetScaffold<Content: View>: View {
    var title: String? = nil
    var description: String? = nil
    var showsClose = true
    var divider = false
    var scrolls = false
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule().fill(tokens.fill3).frame(width: 36, height: 4)
                .frame(maxWidth: .infinity).padding(.top, 8)
            if title != nil || showsClose {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let title {
                            Text(title).font(Font.geist(16, 600)).tracking(-0.16)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                        }
                        if let description {
                            Text(description).font(TypeScale.sm).foregroundStyle(tokens.text2).lineSpacing(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    if showsClose {
                        Button { dismiss() } label: { Icon(.x, size: 18).frame(width: 36, height: 36) }
                            .buttonStyle(.plain).foregroundStyle(tokens.text2)
                            .accessibilityLabel("Close").accessibilityIdentifier("closeSheet")
                            .padding(.top, -6).padding(.trailing, -8)
                    }
                }
                .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, divider ? 14 : 4)
                if divider { Rectangle().fill(tokens.line).frame(height: 1) }
            }
            if scrolls {
                ScrollView { content.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 20) }
            } else {
                content.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 20)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(paint: false)
    }
}

private struct SheetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Presents content as a bottom sheet that sizes itself to its content, like the web's phone sheets.
struct FittedSheet<Content: View>: View {
    @ViewBuilder var content: Content
    @State private var height: CGFloat = 320
    @Environment(\.tokens) private var tokens
    var body: some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { Color.clear.preference(key: SheetHeightKey.self, value: $0.size.height) })
            .onPreferenceChange(SheetHeightKey.self) { value in if value > 0 { height = value } }
            .frame(maxHeight: .infinity, alignment: .top)
            .presentationDetents([.height(height)])
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(20)
            .presentationBackground(tokens.card)
    }
}

/// A sheet with medium/large detents for long content (pickers, history, previews).
struct TallSheet: ViewModifier {
    @Environment(\.tokens) private var tokens
    var large = false
    func body(content: Content) -> some View {
        content
            .presentationDetents(large ? [.large] : [.medium, .large])
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(20)
            .presentationBackground(tokens.card)
    }
}

/// .dialog-actions on phones: full-width buttons, primary on the bottom.
struct SheetActions<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { VStack(spacing: 8) { content }.padding(.top, 4) }
}

/// A row in a bottom-sheet menu (.menu-item at phone size: 44pt, 18pt icons).
struct MenuRow: View {
    let title: String
    var icon: Lucide? = nil
    var tone: Tone = .neutral
    var disabled = false
    var checked: Bool? = nil
    var identifier: String? = nil
    let action: () -> Void
    @Environment(\.tokens) private var tokens
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let icon { Icon(icon, size: 18).foregroundStyle(tone == .danger ? tokens.dangerText : tokens.text2) }
                Text(title).font(Font.geist(15)).foregroundStyle(tone == .danger ? tokens.dangerText : tokens.text)
                Spacer(minLength: 8)
                if let checked, checked { Icon(.check, size: 16).foregroundStyle(tokens.accentText) }
            }
            .padding(.horizontal, 12).frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(MenuPressStyle(danger: tone == .danger))
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityIdentifier(identifier ?? "menu-" + title)
        .accessibilityAddTraits(checked == true ? [.isSelected] : [])
    }
}
private struct MenuPressStyle: ButtonStyle {
    var danger: Bool
    @Environment(\.tokens) private var tokens
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? (danger ? tokens.dangerSoft : tokens.fill2) : .clear, in: RoundedRectangle(cornerRadius: 8))
    }
}
struct MenuSeparator: View {
    @Environment(\.tokens) private var tokens
    var body: some View { Rectangle().fill(tokens.line).frame(height: 1).padding(.vertical, 4).padding(.horizontal, -8) }
}
/// Bottom-sheet menu body: optional header and rows.
struct SheetMenu<Content: View>: View {
    var title: String? = nil
    @ViewBuilder var content: Content
    var body: some View {
        FittedSheet {
            SheetScaffold(title: title, showsClose: title != nil) {
                VStack(alignment: .leading, spacing: 0) { content }.padding(.horizontal, -8)
            }
        }
    }
}

/// A confirmation sheet: title, description, error, and stacked Cancel / confirm buttons.
struct ConfirmSheet: View {
    let title: String
    var description: String? = nil
    var note: String? = nil
    let confirm: String
    var cancel = "Cancel"
    var danger = true
    var busy = false
    var error: String? = nil
    let action: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.tokens) private var tokens
    var body: some View {
        FittedSheet {
            SheetScaffold(title: title, description: description) {
                VStack(alignment: .leading, spacing: 16) {
                    if let note { Text(note).font(TypeScale.sm).foregroundStyle(tokens.text2).fixedSize(horizontal: false, vertical: true) }
                    if let error { AlertBanner(tone: .danger, text: error) }
                    SheetActions {
                        Button(busy ? "Working…" : confirm, action: action).harborButton(danger ? .danger : .primary, size: .lg, block: true)
                            .disabled(busy).accessibilityIdentifier("confirm-" + confirm)
                        Button(cancel) { dismiss() }.harborButton(.outline, size: .lg, block: true).disabled(busy)
                    }
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }
}

/// The toast: inverted colors, check icon, floating above the tab bar.
struct ToastView: View {
    let text: String
    @Environment(\.tokens) private var tokens
    var body: some View {
        HStack(spacing: 8) {
            Icon(.check, size: 16)
            Text(text).font(TypeScale.sm).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .foregroundStyle(tokens.surface)
        .background(tokens.text, in: RoundedRectangle(cornerRadius: 10))
        .shadow(color: tokens.shadow, radius: 16, y: 8)
        .accessibilityIdentifier("toast")
    }
}

/// Section label inside pages and cards.
struct SectionTitle: View {
    let text: String
    var body: some View { Text(text).font(TypeScale.smMedium.weight(.semibold)).accessibilityAddTraits(.isHeader) }
}

/// A horizontal hairline using the line token.
struct Hairline: View {
    @Environment(\.tokens) private var tokens
    var body: some View { Rectangle().fill(tokens.line).frame(height: 1) }
}

/// .details: label on the left, value on the right.
struct DetailsList: View {
    let rows: [(String, String)]
    @Environment(\.tokens) private var tokens
    var body: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 20, verticalSpacing: 10) {
            ForEach(rows.indices, id: \.self) { index in
                GridRow {
                    Text(rows[index].0).foregroundStyle(tokens.text2).frame(minWidth: 88, alignment: .leading)
                    Text(rows[index].1).foregroundStyle(tokens.text).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.font(TypeScale.sm)
    }
}

/// The brand mark (assets/branding/logo.svg): an open ring with a center dot.
struct BrandMark: View {
    var size: CGFloat = 26
    @Environment(\.tokens) private var tokens
    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0, to: 72.25 / (2 * .pi * 15))
                .stroke(style: StrokeStyle(lineWidth: size * 7 / 48, lineCap: .round))
                .rotationEffect(.degrees(-10))
                .frame(width: size * 30 / 48, height: size * 30 / 48)
            Circle().frame(width: size * 10 / 48, height: size * 10 / 48)
        }
        .frame(width: size, height: size)
        .foregroundStyle(tokens.primary)
        .accessibilityHidden(true)
    }
}
