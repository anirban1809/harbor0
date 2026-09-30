package app.harbor0.android

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

// Mirrors apps/web/app/styles/tokens.css: five customisable colors per mode, everything else derived per surface.
val colorKeys = listOf("primary", "background", "card", "sidebar", "border")
val colorLabels = listOf("Accent", "Background", "Cards", "Navigation", "Borders")
val colorHints = listOf("Buttons, links, and focus rings", "Your main workspace", "File lists, panels, and popovers", "Bottom navigation and sign-in", "Dividers and input outlines")
data class Preset(val id: String, val name: String, val description: String, val light: List<String>, val dark: List<String>)
val presets = listOf(
    Preset("default", "Harbor", "Indigo on neutral", listOf("#4353d9", "#ffffff", "#ffffff", "#f4f5f7", "#e3e5ea"), listOf("#8793ff", "#141518", "#1b1d21", "#0d0e10", "#2b2e34")),
    Preset("ocean", "Ocean", "Blue tones", listOf("#2563eb", "#eff6ff", "#ffffff", "#dbeafe", "#bfdbfe"), listOf("#60a5fa", "#0b1220", "#111e33", "#0e192b", "#294362")),
    Preset("forest", "Forest", "Green tones", listOf("#187047", "#f0f7f2", "#ffffff", "#deeee2", "#bed8c6"), listOf("#6cce98", "#0c1712", "#14261d", "#102017", "#305340")),
    Preset("violet", "Violet", "Purple tones", listOf("#7c3aed", "#f7f3ff", "#ffffff", "#ede5fb", "#d8c9ed"), listOf("#b794f6", "#171122", "#241b34", "#1d162b", "#4a3766")),
    Preset("sunset", "Sunset", "Orange tones", listOf("#b94719", "#fff7ed", "#fffcf8", "#ffead5", "#edcdb2"), listOf("#fbad77", "#20140f", "#302018", "#281a13", "#60412f")),
)
fun isHex(value: String) = Regex("^#[a-fA-F0-9]{6}$").matches(value)
fun hexColor(value: String) = Color(0xff000000L or value.drop(1).toLong(16))
fun ink(color: Color): Color = if ((color.luminance() + .05f) / .05f >= 1.05f / (color.luminance() + .05f)) Color.Black else Color.White
fun Appearance.colors(dark: Boolean): List<Color> {
    val presetColors = presets.firstOrNull { it.id == preset } ?: presets.first()
    val base = if (dark) presetColors.dark else presetColors.light
    val overrides = if (dark) palettes.dark else palettes.light
    return colorKeys.mapIndexed { index, key -> hexColor(overrides[key]?.takeIf(::isHex) ?: base[index]) }
}

/** The base palette. `on` builds the derived tokens for whichever surface an element paints. */
data class Palette(val dark: Boolean, val primary: Color, val background: Color, val card: Color, val sidebar: Color, val border: Color) {
    val onPrimary = ink(primary)
    val destructive = if (dark) Color(0xfff26d6d) else Color(0xffd33b3b)
    val onDestructive = if (dark) Color(0xff2a0a0a) else Color.White
    val success = if (dark) Color(0xff52c987) else Color(0xff15803d)
    val warning = if (dark) Color(0xffe5a949) else Color(0xffb45309)
    val kindImage = if (dark) Color(0xff3fd0c0) else Color(0xff0e9384)
    val backdrop = if (dark) Color.Black.copy(alpha = .55f) else Color(0xff101218).copy(alpha = .32f)
    fun on(surface: Color) = SurfaceTokens(this, surface)
}
// Compose interpolates colors in Oklab, matching the web's color-mix(in oklab, …).
class SurfaceTokens(val palette: Palette, val surface: Color) {
    val text = if (ink(surface) == Color.Black) Color(0xff16181d) else Color(0xffeceef1)
    private fun mix(color: Color, share: Float, into: Color = surface) = lerp(into, color, share)
    val text2 = mix(text, .66f)
    val text3 = mix(text, .5f)
    val fill1 = mix(text, .04f)
    val fill2 = mix(text, .07f)
    val fill3 = mix(text, .11f)
    val line = palette.border
    val strongLine = mix(text, .22f)
    val primary get() = palette.primary
    val onPrimary get() = palette.onPrimary
    val accentSoft = mix(palette.primary, .12f)
    val accentText = mix(palette.primary, .84f, text)
    val dangerSoft = mix(palette.destructive, .11f)
    val dangerText = mix(palette.destructive, .88f, text)
    val successSoft = mix(palette.success, .13f)
    val successText = mix(palette.success, .88f, text)
    val warningSoft = mix(palette.warning, .14f)
    val warningText = mix(palette.warning, .88f, text)
}
private val defaultPalette = Appearance().colors(false).let { (accent, background, card, sidebar, border) -> Palette(false, accent, background, card, sidebar, border) }
val LocalTokens = staticCompositionLocalOf { defaultPalette.on(defaultPalette.background) }
val theme: SurfaceTokens @Composable @ReadOnlyComposable get() = LocalTokens.current

/** Names the background an area paints, so text, fills and tints inside it are derived against it. */
@Composable fun OnSurface(color: Color, modifier: Modifier = Modifier, paint: Boolean = true, content: @Composable () -> Unit) {
    val next = theme.palette.on(color)
    CompositionLocalProvider(LocalTokens provides next, LocalContentColor provides next.text) {
        Box(if (paint) modifier.background(color) else modifier) { content() }
    }
}

@OptIn(ExperimentalTextApi::class)
private fun variable(font: Int, weight: Int) = Font(font, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
val Geist = FontFamily(listOf(400, 500, 550, 600, 650).map { variable(R.font.geist, it) })
val GeistMono = FontFamily(listOf(400, 500).map { variable(R.font.geist_mono, it) })
object Type {
    private val base = TextStyle(fontFamily = Geist, fontWeight = FontWeight(400))
    val xs = base.copy(fontSize = 12.sp, lineHeight = 17.sp)
    val sm = base.copy(fontSize = 13.sp, lineHeight = 19.sp)
    val body = base.copy(fontSize = 15.sp, lineHeight = 21.sp)
    val label = sm.copy(fontWeight = FontWeight(500))
    val button = base.copy(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight(500))
    val name = body.copy(fontWeight = FontWeight(500))
    val h3 = body.copy(fontWeight = FontWeight(600))
    val h2 = base.copy(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight(600), letterSpacing = (-.01).em)
    val h1 = base.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight(600), letterSpacing = (-.015).em)
    val display = base.copy(fontSize = 26.sp, lineHeight = 30.sp, fontWeight = FontWeight(600), letterSpacing = (-.035).em)
    val mono = sm.copy(fontFamily = GeistMono)
}
object Radius { val sm = 6.dp; val md = 8.dp; val lg = 12.dp; val xl = 16.dp }

@Composable fun HarborTheme(appearance: Appearance, content: @Composable () -> Unit) {
    val dark = when (appearance.preference) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    val (accent, background, card, sidebar, border) = appearance.colors(dark)
    val palette = Palette(dark, accent, background, card, sidebar, border)
    val page = palette.on(background)
    val onCard = palette.on(card)
    // Material components that remain (menus, pull-to-refresh, ripples, text selection) follow the same theme.
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(primary = accent, onPrimary = palette.onPrimary,
        background = background, onBackground = page.text, surface = card, onSurface = onCard.text, surfaceVariant = onCard.fill2,
        onSurfaceVariant = onCard.text2, outline = border, outlineVariant = border, error = palette.destructive, onError = palette.onDestructive,
        surfaceContainer = card, surfaceContainerLow = card, surfaceContainerHigh = card, surfaceContainerHighest = onCard.fill2,
        secondaryContainer = onCard.accentSoft, onSecondaryContainer = onCard.accentText, scrim = palette.backdrop)
    val defaults = Typography()
    val typography = Typography(bodyLarge = Type.body, bodyMedium = Type.sm, bodySmall = Type.xs, labelLarge = Type.button, labelMedium = Type.label,
        labelSmall = Type.xs, titleLarge = Type.h1, titleMedium = Type.h2, titleSmall = Type.h3, headlineSmall = Type.display,
        headlineMedium = defaults.headlineMedium.copy(fontFamily = Geist), headlineLarge = defaults.headlineLarge.copy(fontFamily = Geist),
        displaySmall = defaults.displaySmall.copy(fontFamily = Geist), displayMedium = defaults.displayMedium.copy(fontFamily = Geist),
        displayLarge = defaults.displayLarge.copy(fontFamily = Geist))
    MaterialTheme(colorScheme = scheme, typography = typography) {
        CompositionLocalProvider(LocalTokens provides page, LocalContentColor provides page.text, LocalTextStyle provides Type.body, content = content)
    }
}
