package app.harbor0.android

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance

val colorKeys = listOf("primary", "background", "card", "sidebar", "border")
val colorLabels = listOf("Accent", "Background", "Cards", "Navigation", "Borders")
data class Preset(val id: String, val name: String, val light: List<String>, val dark: List<String>)
val presets = listOf(
    Preset("default", "Harbor", listOf("#171717", "#fafafa", "#ffffff", "#f5f5f5", "#e5e5e5"), listOf("#fafafa", "#171717", "#202020", "#1c1c1c", "#363636")),
    Preset("ocean", "Ocean", listOf("#2563eb", "#eff6ff", "#ffffff", "#dbeafe", "#bfdbfe"), listOf("#60a5fa", "#0b1220", "#111e33", "#0e192b", "#294362")),
    Preset("forest", "Forest", listOf("#187047", "#f0f7f2", "#ffffff", "#deeee2", "#bed8c6"), listOf("#6cce98", "#0c1712", "#14261d", "#102017", "#305340")),
    Preset("violet", "Violet", listOf("#7c3aed", "#f7f3ff", "#ffffff", "#ede5fb", "#d8c9ed"), listOf("#b794f6", "#171122", "#241b34", "#1d162b", "#4a3766")),
    Preset("sunset", "Sunset", listOf("#b94719", "#fff7ed", "#fffcf8", "#ffead5", "#edcdb2"), listOf("#fbad77", "#20140f", "#302018", "#281a13", "#60412f")),
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
val LocalNavigationColor = staticCompositionLocalOf { Color(0xfff5f5f5) }
@Composable fun HarborTheme(appearance: Appearance, content: @Composable () -> Unit) {
    val dark = when (appearance.preference) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    val (accent, background, card, navigation, border) = appearance.colors(dark)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(primary = accent, onPrimary = ink(accent), background = background,
        onBackground = ink(background), surface = card, onSurface = ink(card), surfaceVariant = card,
        onSurfaceVariant = ink(card).copy(alpha = .7f), outline = border, outlineVariant = border,
        secondaryContainer = accent.copy(alpha = .13f), onSecondaryContainer = ink(navigation),
        surfaceContainer = card, surfaceContainerLow = card, surfaceContainerHigh = card)
    CompositionLocalProvider(LocalNavigationColor provides navigation) { MaterialTheme(colorScheme = scheme, content = content) }
}
