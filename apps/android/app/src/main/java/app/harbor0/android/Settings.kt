package app.harbor0.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable fun Settings(model: WorkspaceModel, signOut: () -> Unit) {
    var editDark by rememberSaveable { mutableStateOf(false) }
    var customKey by remember { mutableStateOf<String?>(null) }
    val appearance = model.appearance
    val changed = appearance != model.savedAppearance
    Column(Modifier.widthIn(max = 840.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        model.listing.error?.let { Alert(it, tone = Tone.Danger, action = "Try again") { model.refresh() } }
        model.account?.let { account ->
            Card {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(account.user.displayName)
                    Column {
                        Text(account.user.displayName, style = Type.h3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(account.user.email, style = Type.sm, color = theme.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Divider(Modifier.padding(vertical = 14.dp))
                Row(Modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Storage", Modifier.weight(1f), style = Type.label)
                    Text("${bytesLabel(account.storage.usedBytes)} of ${bytesLabel(account.storage.quotaBytes)} used", style = Type.xs, color = theme.text2)
                }
                Progress(if (account.storage.quotaBytes > 0) account.storage.usedBytes.toFloat() / account.storage.quotaBytes else 0f)
                if (account.storage.reservedBytes > 0) Text("${bytesLabel(account.storage.reservedBytes)} reserved for uploads", Modifier.padding(top = 8.dp), style = Type.xs, color = theme.text2)
            }
        }
        Card {
            CardHeader("Appearance", "Preview changes here, then save them to your account.")
            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Mode", style = Type.label.copy(fontWeight = FontWeight(600)))
                    Segmented(listOf("system" to "System", "light" to "Light", "dark" to "Dark"), appearance.preference, { model.appearance = appearance.copy(preference = it) }, Modifier.fillMaxWidth())
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Theme", style = Type.label.copy(fontWeight = FontWeight(600)))
                    BoxWithConstraints {
                        val columns = (maxWidth / 132.dp).toInt().coerceIn(2, 5)
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            presets.chunked(columns).forEach { row ->
                                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                    row.forEach { preset -> PresetCard(preset, appearance.preset == preset.id, Modifier.weight(1f)) { model.appearance = appearance.copy(preset = preset.id) } }
                                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                    }
                }
                Column {
                    Text("Custom colors", style = Type.label.copy(fontWeight = FontWeight(600)))
                    Text("Override individual colors for one mode.", Modifier.padding(top = 2.dp, bottom = 10.dp), style = Type.xs, color = theme.text2)
                    Segmented(listOf("light" to "Light palette", "dark" to "Dark palette"), if (editDark) "dark" else "light", { editDark = it == "dark" }, Modifier.fillMaxWidth().padding(bottom = 10.dp))
                    val colors = appearance.colors(editDark)
                    val overrides = if (editDark) appearance.palettes.dark else appearance.palettes.light
                    colorKeys.forEachIndexed { index, key ->
                        Divider()
                        Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { customKey = key }.heightIn(min = 60.dp).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f).padding(end = 12.dp)) {
                                Text(colorLabels[index], style = Type.label)
                                Text(colorHints[index], style = Type.xs, color = theme.text2)
                            }
                            if (key in overrides) Badge("Custom", Tone.Accent)
                            Box(Modifier.padding(start = 8.dp).size(36.dp).border(1.dp, theme.line, RoundedCornerShape(Radius.md)).padding(4.dp).background(colors[index], RoundedCornerShape(4.dp)))
                            Icon(Lucide.Pencil, "Edit", Modifier.padding(start = 12.dp, end = 2.dp).size(16.dp), tint = theme.text3)
                        }
                    }
                    Divider()
                    HButton("Reset custom colors", { model.appearance = appearance.copy(palettes = Palettes()) }, Modifier.padding(top = 6.dp), Variant.Ghost, small = true,
                        icon = Lucide.RotateCcw, enabled = appearance.palettes != Palettes())
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Divider(Modifier.padding(bottom = 8.dp))
                    HButton("Save appearance", model::saveAppearance, Modifier.fillMaxWidth(), enabled = !model.busy && model.account != null && changed)
                    if (changed) HButton("Discard changes", { model.appearance = model.savedAppearance }, Modifier.fillMaxWidth(), Variant.Outline)
                }
            }
        }
        HButton("Sign out", signOut, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.LogOut, enabled = !model.busy && model.transfer == null)
        Text("harbor0 for Android • ${BuildConfig.VERSION_NAME}\nTransfers run while the app is open. Sync and backup automation run on your computers.", style = Type.xs, color = theme.text2)
    }
    customKey?.let { key ->
        val original = (if (editDark) appearance.palettes.dark else appearance.palettes.light)[key].orEmpty()
        var value by remember(key, editDark) { mutableStateOf(original) }
        val valid = value.isEmpty() || isHex(value)
        HDialog(colorLabels[colorKeys.indexOf(key)], { customKey = null }, "Enter a hex color for the ${if (editDark) "dark" else "light"} palette, or leave it blank to use the theme’s color.", actions = {
            HButton("Cancel", { customKey = null }, variant = Variant.Outline)
            HButton("Apply color", {
                val old = if (editDark) appearance.palettes.dark else appearance.palettes.light
                val next = if (value.isEmpty()) old - key else old + (key to value.lowercase())
                model.appearance = appearance.copy(palettes = if (editDark) appearance.palettes.copy(dark = next) else appearance.palettes.copy(light = next))
                customKey = null
            }, enabled = valid)
        }) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                val preview = if (value.isNotEmpty() && isHex(value)) hexColor(value) else appearance.copy(palettes = Palettes()).colors(editDark)[colorKeys.indexOf(key)]
                Box(Modifier.size(44.dp).border(1.dp, theme.line, RoundedCornerShape(Radius.md)).padding(4.dp).background(preview, RoundedCornerShape(4.dp)))
                HInput(value, { value = it.trim() }, Modifier.weight(1f), placeholder = "#RRGGBB", invalid = !valid, style = Type.mono.copy(fontSize = Type.body.fontSize))
            }
            if (!valid) Text("Use six hex digits, such as #4353d9.", style = Type.xs, color = theme.dangerText)
        }
    }
}

@Composable private fun PresetCard(preset: Preset, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val t = theme
    val shape = RoundedCornerShape(Radius.lg)
    Column(modifier.clip(shape).border(if (selected) 2.dp else 1.dp, if (selected) t.primary else t.line, shape)
        .selectable(selected, role = Role.RadioButton, onClick = onClick).padding(8.dp)) {
        // Navigation, page and accent of the light palette, as in the web theme picker.
        Row(Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(Radius.md)).border(1.dp, t.line, RoundedCornerShape(Radius.md))) {
            listOf(preset.light[3], preset.light[1], preset.light[0]).forEach { Box(Modifier.weight(1f).fillMaxHeight().background(hexColor(it))) }
        }
        Text(preset.name, Modifier.padding(top = 8.dp), style = Type.label.copy(fontWeight = FontWeight(550)))
        Text(if (selected) "Selected" else preset.description, style = Type.xs, color = if (selected) t.accentText else t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
