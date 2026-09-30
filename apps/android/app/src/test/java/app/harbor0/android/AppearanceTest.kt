package app.harbor0.android

import org.junit.Assert.*
import org.junit.Test
import androidx.compose.ui.graphics.Color

class AppearanceTest {
    @Test fun allPresetsHaveLightAndDarkPalettes() {
        presets.forEach { preset ->
            listOf(false, true).forEach { dark -> assertEquals(5, Appearance(preset = preset.id).colors(dark).size) }
        }
    }
    @Test fun overridesApplyOnlyToChosenModeAndInvalidValuesFallBack() {
        val custom = Appearance(preset = "ocean", palettes = Palettes(dark = mapOf("sidebar" to "#123456", "primary" to "bad")))
        assertEquals(hexColor("#123456"), custom.colors(true)[3])
        assertEquals(hexColor("#60a5fa"), custom.colors(true)[0])
        assertEquals(hexColor("#dbeafe"), custom.colors(false)[3])
    }
    @Test fun contrastingInkRemainsReadable() {
        assertEquals(Color.Black, ink(Color.White)); assertEquals(Color.White, ink(Color.Black))
    }
}
