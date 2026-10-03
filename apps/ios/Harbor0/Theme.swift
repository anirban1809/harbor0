import SwiftUI
import UIKit
import CoreText

// Mirrors apps/web/app/styles/tokens.css: five customisable colors per mode, everything else
// derived per surface with the same color-mix(in oklab, …) ratios the web uses.

/// An sRGB color that can be mixed in Oklab, like CSS color-mix(in oklab, …).
struct RGB: Equatable {
    var r: Double, g: Double, b: Double, a: Double = 1

    init(r: Double, g: Double, b: Double, a: Double = 1) { self.r = r; self.g = g; self.b = b; self.a = a }
    init(hex: String) {
        let value = UInt64(hex.dropFirst(), radix: 16) ?? 0
        r = Double((value >> 16) & 255) / 255
        g = Double((value >> 8) & 255) / 255
        b = Double(value & 255) / 255
    }
    var color: Color { Color(.sRGB, red: r, green: g, blue: b, opacity: a) }
    var luminance: Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722
    }
    /// Black or white, whichever contrasts more (contrastingText in appearance-colors.ts).
    var prefersBlackInk: Bool { (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) }
    func opacity(_ value: Double) -> RGB { RGB(r: r, g: g, b: b, a: a * value) }

    private var oklab: (Double, Double, Double) {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let (lr, lg, lb) = (linear(r), linear(g), linear(b))
        let l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
        let m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
        let s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
    }
    private static func from(oklab: (Double, Double, Double)) -> RGB {
        let (L, A, B) = oklab
        let l = pow(L + 0.3963377774 * A + 0.2158037573 * B, 3)
        let m = pow(L - 0.1055613458 * A - 0.0638541728 * B, 3)
        let s = pow(L - 0.0894841775 * A - 1.2914855480 * B, 3)
        func gamma(_ c: Double) -> Double {
            let v = c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055
            return min(1, max(0, v))
        }
        return RGB(r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                   g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                   b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))
    }
    /// color-mix(in oklab, self share, other).
    func mix(_ share: Double, into other: RGB) -> RGB {
        let x = oklab, y = other.oklab
        return Self.from(oklab: (x.0 * share + y.0 * (1 - share), x.1 * share + y.1 * (1 - share), x.2 * share + y.2 * (1 - share)))
    }
}

/// The five base colors for the current mode plus the fixed status colors.
struct Palette: Equatable {
    let dark: Bool
    let primary: RGB, background: RGB, card: RGB, sidebar: RGB, border: RGB
    var destructive: RGB { RGB(hex: dark ? "#f26d6d" : "#d33b3b") }
    var onDestructive: RGB { RGB(hex: dark ? "#2a0a0a" : "#ffffff") }
    var success: RGB { RGB(hex: dark ? "#52c987" : "#15803d") }
    var warning: RGB { RGB(hex: dark ? "#e5a949" : "#b45309") }
    var kindImage: RGB { RGB(hex: dark ? "#3fd0c0" : "#0e9384") }
    var onPrimary: RGB { primary.prefersBlackInk ? RGB(hex: dark ? "#0e1024" : "#000000") : RGB(hex: "#ffffff") }
    var backdrop: Color { dark ? Color.black.opacity(0.55) : Color(.sRGB, red: 16 / 255, green: 18 / 255, blue: 24 / 255, opacity: 0.32) }
    func on(_ surface: RGB) -> ThemeTokens { ThemeTokens(palette: self, surface: surface) }
    static let fallback = Appearance().palette(for: .light).tokensPalette
}

/// Derived tokens for whichever surface an element paints (text-2, fill-1, accent-soft, …).
struct ThemeTokens {
    let palette: Palette
    let surfaceRGB: RGB
    let textRGB: RGB
    init(palette: Palette, surface: RGB) {
        self.palette = palette
        surfaceRGB = surface
        textRGB = surface.prefersBlackInk ? RGB(hex: "#16181d") : RGB(hex: "#eceef1")
    }
    private func mix(_ color: RGB, _ share: Double, into: RGB? = nil) -> Color { color.mix(share, into: into ?? surfaceRGB).color }
    var surface: Color { surfaceRGB.color }
    var text: Color { textRGB.color }
    var text2: Color { mix(textRGB, 0.66) }
    var text3: Color { mix(textRGB, 0.5) }
    var fill1: Color { mix(textRGB, 0.04) }
    var fill2: Color { mix(textRGB, 0.07) }
    var fill3: Color { mix(textRGB, 0.11) }
    var line: Color { palette.border.color }
    var strongLine: Color { mix(textRGB, 0.28) }
    var primary: Color { palette.primary.color }
    var onPrimary: Color { palette.onPrimary.color }
    var accentSoft: Color { mix(palette.primary, 0.12) }
    var accentSoftStrong: Color { mix(palette.primary, 0.2) }
    var accentText: Color { mix(palette.primary, 0.84, into: textRGB) }
    var accentBorder: Color { mix(palette.primary, 0.45) }
    var destructive: Color { palette.destructive.color }
    var onDestructive: Color { palette.onDestructive.color }
    var dangerSoft: Color { mix(palette.destructive, 0.11) }
    var dangerText: Color { mix(palette.destructive, 0.88, into: textRGB) }
    var successSoft: Color { mix(palette.success, 0.13) }
    var successText: Color { mix(palette.success, 0.88, into: textRGB) }
    var warning: Color { palette.warning.color }
    var warningSoft: Color { mix(palette.warning, 0.14) }
    var warningText: Color { mix(palette.warning, 0.88, into: textRGB) }
    var kindImage: Color { palette.kindImage.color }
    var background: Color { palette.background.color }
    var card: Color { palette.card.color }
    var sidebar: Color { palette.sidebar.color }
    /// A translucent bar background, like color-mix(in oklab, surface 88%, transparent).
    var bar: Color { surfaceRGB.opacity(0.88).color }
    var shadow: Color { palette.dark ? Color.black.opacity(0.5) : Color(.sRGB, red: 16 / 255, green: 18 / 255, blue: 24 / 255, opacity: 0.16) }
    /// ThemeTokens for a nested element painting another surface.
    func on(_ surface: RGB) -> ThemeTokens { ThemeTokens(palette: palette, surface: surface) }
    var onCard: ThemeTokens { on(palette.card) }
    var onBackground: ThemeTokens { on(palette.background) }
    var onSidebar: ThemeTokens { on(palette.sidebar) }
}

private struct TokensKey: EnvironmentKey { static let defaultValue = Palette.fallback.on(Palette.fallback.background) }
extension EnvironmentValues {
    var tokens: ThemeTokens { get { self[TokensKey.self] } set { self[TokensKey.self] = newValue } }
}

/// Names the background an area paints, so text, fills and tints inside are derived against it.
struct SurfaceModifier: ViewModifier {
    @Environment(\.tokens) private var tokens
    let pick: (Palette) -> RGB
    let paint: Bool
    func body(content: Content) -> some View {
        let next = tokens.on(pick(tokens.palette))
        content
            .environment(\.tokens, next)
            .foregroundStyle(next.text)
            .background(paint ? next.surface : Color.clear)
    }
}
extension View {
    func surface(_ pick: @escaping (Palette) -> RGB, paint: Bool = true) -> some View { modifier(SurfaceModifier(pick: pick, paint: paint)) }
    func cardSurface(paint: Bool = true) -> some View { surface({ $0.card }, paint: paint) }
    func backgroundSurface(paint: Bool = true) -> some View { surface({ $0.background }, paint: paint) }
}

// MARK: - Type

/// Geist, the web's typeface, from the bundled variable font; weights use its wght axis.
enum HarborFont {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: UIFont] = [:]
    private static let base: UIFont? = {
        guard let url = Bundle.main.url(forResource: "Geist", withExtension: "ttf"),
              let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
              let descriptor = descriptors.first else { return nil }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        return CTFontCreateWithFontDescriptor(descriptor, 14, nil) as UIFont
    }()
    static func ui(_ size: CGFloat, _ weight: CGFloat = 400, scaled: Bool = true) -> UIFont {
        // Respect Dynamic Type, within limits the phone layout can take.
        let scale = scaled ? min(1.35, max(0.85, UIFontMetrics.default.scaledValue(for: 100) / 100)) : 1
        let points = (size * scale).rounded(.toNearestOrEven)
        let key = "\(points)-\(weight)"
        lock.lock(); defer { lock.unlock() }
        if let cached = cache[key] { return cached }
        let font: UIFont
        if let base {
            let attribute = UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)
            let descriptor = base.fontDescriptor.addingAttributes([attribute: [0x7767_6874: weight]])
            font = UIFont(descriptor: descriptor, size: points)
        } else {
            let weights: [(CGFloat, UIFont.Weight)] = [(400, .regular), (500, .medium), (600, .semibold), (700, .bold)]
            font = .systemFont(ofSize: points, weight: weights.last { $0.0 <= weight }?.1 ?? .regular)
        }
        cache[key] = font
        return font
    }
}
extension Font {
    static func geist(_ size: CGFloat, _ weight: CGFloat = 400) -> Font { Font(HarborFont.ui(size, weight)) }
}
/// The web type scale (tokens.css --text-*), with phone sizes from mobile.css.
enum TypeScale {
    static let xs = Font.geist(12)
    static let xsMedium = Font.geist(12, 500)
    static let sm = Font.geist(13)
    static let smMedium = Font.geist(13, 500)
    static let base = Font.geist(14)
    static let baseMedium = Font.geist(14, 500)
    static let body = Font.geist(15)
    static let name = Font.geist(15, 500)
    static let lg = Font.geist(16, 600)
    static let title = Font.geist(24, 600)
    static let tab = Font.geist(11, 500)
}

// MARK: - Icons

/// Parses SVG path data (M L H V C S Q T A Z, absolute and relative) into a SwiftUI Path.
enum SVGPath {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [Lucide: Path] = [:]
    static func path(for icon: Lucide) -> Path {
        lock.lock(); defer { lock.unlock() }
        if let cached = cache[icon] { return cached }
        var result = Path()
        for data in icon.paths { result.addPath(parse(data)) }
        cache[icon] = result
        return result
    }

    static func parse(_ data: String) -> Path {
        var path = Path()
        let chars = Array(data.utf8)
        var index = 0
        var command: UInt8 = 0
        var current = CGPoint.zero, start = CGPoint.zero, lastControl: CGPoint?, lastQuad: CGPoint?
        func skip() { while index < chars.count, chars[index] == 32 || chars[index] == 44 || chars[index] == 10 || chars[index] == 9 { index += 1 } }
        func isNumberStart(_ c: UInt8) -> Bool { (c >= 48 && c <= 57) || c == 45 || c == 43 || c == 46 }
        func number() -> CGFloat {
            skip()
            let begin = index
            if index < chars.count, chars[index] == 45 || chars[index] == 43 { index += 1 }
            var dot = false, exp = false
            while index < chars.count {
                let c = chars[index]
                if c >= 48 && c <= 57 { index += 1 }
                else if c == 46 && !dot && !exp { dot = true; index += 1 }
                else if (c == 101 || c == 69) && !exp { exp = true; index += 1; if index < chars.count, chars[index] == 45 || chars[index] == 43 { index += 1 } }
                else { break }
            }
            return CGFloat(Double(String(decoding: chars[begin..<index], as: UTF8.self)) ?? 0)
        }
        func flag() -> Bool { skip(); let value = index < chars.count && chars[index] == 49; index += 1; return value }
        while true {
            skip()
            guard index < chars.count else { break }
            let c = chars[index]
            if !isNumberStart(c) { command = c; index += 1 }
            let relative = command >= 97
            let base = relative ? current : .zero
            switch command | 0x20 {
            case 109: // m
                let p = CGPoint(x: base.x + number(), y: base.y + number())
                path.move(to: p); current = p; start = p
                command = relative ? 108 : 76 // Implicit lineto after moveto.
                lastControl = nil; lastQuad = nil
            case 108: // l
                let p = CGPoint(x: base.x + number(), y: base.y + number())
                path.addLine(to: p); current = p; lastControl = nil; lastQuad = nil
            case 104: // h
                let x = number(); current.x = relative ? current.x + x : x
                path.addLine(to: current); lastControl = nil; lastQuad = nil
            case 118: // v
                let y = number(); current.y = relative ? current.y + y : y
                path.addLine(to: current); lastControl = nil; lastQuad = nil
            case 99: // c
                let c1 = CGPoint(x: base.x + number(), y: base.y + number())
                let c2 = CGPoint(x: base.x + number(), y: base.y + number())
                let p = CGPoint(x: base.x + number(), y: base.y + number())
                path.addCurve(to: p, control1: c1, control2: c2); current = p; lastControl = c2; lastQuad = nil
            case 115: // s
                let c1 = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = CGPoint(x: base.x + number(), y: base.y + number())
                let p = CGPoint(x: base.x + number(), y: base.y + number())
                path.addCurve(to: p, control1: c1, control2: c2); current = p; lastControl = c2; lastQuad = nil
            case 113: // q
                let q = CGPoint(x: base.x + number(), y: base.y + number())
                let p = CGPoint(x: base.x + number(), y: base.y + number())
                path.addQuadCurve(to: p, control: q); current = p; lastQuad = q; lastControl = nil
            case 116: // t
                let q = lastQuad.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let p = CGPoint(x: base.x + number(), y: base.y + number())
                path.addQuadCurve(to: p, control: q); current = p; lastQuad = q; lastControl = nil
            case 97: // a
                let rx = number(), ry = number(), rotation = number()
                let large = flag(), sweep = flag()
                let p = CGPoint(x: base.x + number(), y: base.y + number())
                arc(&path, from: current, to: p, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = p; lastControl = nil; lastQuad = nil
            case 122: // z
                path.closeSubpath(); current = start; lastControl = nil; lastQuad = nil
            default:
                index += 1
            }
        }
        return path
    }

    private static func arc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx: CGFloat, ry: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        if p0 == p1 { return }
        var rx = abs(rx), ry = abs(ry)
        if rx == 0 || ry == 0 { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180, cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy, y1 = -sinPhi * dx + cosPhi * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let coefficient = (large != sweep ? 1 : -1) * sqrt(max(0, numerator / denominator))
        let cxp = coefficient * rx * y1 / ry, cyp = coefficient * -ry * x1 / rx
        let cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2
        let cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat { atan2(ux * vy - uy * vx, ux * vx + uy * vy) }
        let theta = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
        var delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let t = 4 / 3 * tan(step / 4)
        func point(_ a: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cos(a) * cosPhi - ry * sin(a) * sinPhi, y: cy + rx * cos(a) * sinPhi + ry * sin(a) * cosPhi)
        }
        func derivative(_ a: CGFloat) -> CGPoint {
            CGPoint(x: -rx * sin(a) * cosPhi - ry * cos(a) * sinPhi, y: -rx * sin(a) * sinPhi + ry * cos(a) * cosPhi)
        }
        for i in 0..<segments {
            let a1 = theta + CGFloat(i) * step, a2 = a1 + step
            let s = point(a1), e = point(a2), d1 = derivative(a1), d2 = derivative(a2)
            path.addCurve(to: e, control1: CGPoint(x: s.x + t * d1.x, y: s.y + t * d1.y),
                          control2: CGPoint(x: e.x - t * d2.x, y: e.y - t * d2.y))
        }
    }
}

private struct LucideShape: Shape {
    let icon: Lucide
    func path(in rect: CGRect) -> Path {
        SVGPath.path(for: icon).applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / 24, y: rect.height / 24))
    }
}

/// A lucide icon at the web's sizes, stroked in the current foreground style.
struct Icon: View {
    let icon: Lucide
    var size: CGFloat = 16
    var weight: CGFloat = 2
    var filled = false
    init(_ icon: Lucide, size: CGFloat = 16, weight: CGFloat = 2, filled: Bool = false) {
        self.icon = icon; self.size = size; self.weight = weight; self.filled = filled
    }
    var body: some View {
        ZStack {
            if filled { LucideShape(icon: icon).fill() }
            LucideShape(icon: icon)
                .stroke(style: StrokeStyle(lineWidth: weight * size / 24, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
