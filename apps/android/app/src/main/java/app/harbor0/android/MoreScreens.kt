package app.harbor0.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

@Composable private fun Page(tag: String, title: String, refresh: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val body = @Composable {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag(tag).padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            PageTitle(title)
            content()
        }
    }
    if (refresh != null) Refreshable(false, refresh) { body() } else body()
}

@Composable fun DevicesScreen(model: WorkspaceModel) {
    val devices = model.devices
    Page("devices-page", "Devices", model::loadDevices) {
        Card {
            CardHeader("Connected devices", "Use harbor0 on all your devices. Remove access whenever you need to.")
            val list = devices.data
            when {
                list == null && devices.error == null -> SkeletonRows()
                devices.error != null && list.isNullOrEmpty() -> LoadError(compact = true) { model.loadDevices() }
                list.isNullOrEmpty() -> EmptyState(Lucide.Laptop, "No connected devices", "Sign in to harbor0 on your computers and phones to connect them. Your devices will appear here.", compact = true) {
                    HButton("Refresh devices", model::loadDevices, variant = Variant.Outline, small = true)
                }
                else -> list.forEachIndexed { index, device ->
                    if (index > 0) Divider()
                    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        IconBox(if (device.platform == "IOS" || device.platform == "ANDROID") Lucide.Smartphone else Lucide.Laptop, 32.dp)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(device.name, style = Type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${platformNames[device.platform] ?: device.platform} · ${if (device.revokedAt != null) "Access removed" else "Last active ${dateLabel(device.lastSeenAt ?: device.createdAt)}"}",
                                style = Type.sm, color = theme.text2)
                        }
                        if (device.revokedAt == null) HButton("Revoke", { model.revoke(device) }, variant = Variant.Outline, small = true)
                    }
                }
            }
        }
    }
}

@Composable fun StorageScreen(model: WorkspaceModel) {
    Page("storage-page", "Storage", model::refreshAccount) {
        val usage = model.storage
        Card {
            Row { Badge("Free plan", Tone.Accent) }
            if (usage == null) Text("Storage unavailable", Modifier.padding(top = 12.dp), style = Type.sm, color = theme.text2)
            else {
                Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(bytesLabel(usage.usedBytes), style = Type.body.copy(fontSize = 32.sp, lineHeight = 36.sp, fontWeight = FontWeight(650), letterSpacing = (-.03).em))
                    Text("of ${bytesLabel(usage.quotaBytes)} used", Modifier.padding(bottom = 4.dp), style = Type.body, color = theme.text2)
                }
                Progress((usage.usedBytes + usage.reservedBytes).toFloat() / maxOf(1, usage.quotaBytes), Modifier.padding(top = 16.dp), height = 8.dp)
                Row(Modifier.padding(top = 14.dp).fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${bytesLabel(usage.usedBytes)} stored", style = Type.sm.copy(fontSize = 14.sp), color = theme.text2)
                    Text("${bytesLabel(usage.reservedBytes)} uploading", style = Type.sm.copy(fontSize = 14.sp), color = theme.text2)
                    Text("${bytesLabel(usage.availableBytes)} available", style = Type.label.copy(fontSize = 14.sp))
                }
            }
            Text("Storage includes current files, version history, backups, trash, and content retained for sent transfers. Permanently deleting unused files frees up space.",
                Modifier.padding(top = 14.dp), style = Type.sm.copy(fontSize = 14.sp, lineHeight = 21.sp), color = theme.text2)
        }
        Card {
            CardHeader("Plan features", "Backup, sync, file sharing, and transfers are included in the free plan.")
            Alert("Additional storage purchases are not available yet.")
        }
    }
}

@Composable fun NotificationsScreen(model: WorkspaceModel) {
    val notices = model.notices
    Page("notifications-page", "Notifications", model::loadNotices) {
        Card(padding = 8.dp) {
            val list = notices.data
            when {
                list == null && notices.error == null -> SkeletonRows()
                notices.error != null && list.isNullOrEmpty() -> LoadError(compact = true) { model.loadNotices() }
                list.isNullOrEmpty() -> EmptyState(Lucide.Bell, "No notifications", "Updates about your files and transfers will appear here.", compact = true) {
                    HButton("Back to My Drive", { model.navigate(Section.Drive) }, variant = Variant.Outline, small = true)
                }
                else -> list.forEachIndexed { index, notice ->
                    if (index > 0) Divider(Modifier.padding(horizontal = 8.dp))
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Icon(Lucide.Bell, null, Modifier.size(20.dp), tint = theme.text2)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(notificationTitles[notice.type] ?: sentence(notice.type), style = Type.body)
                            Text(dateLabel(notice.createdAt), style = Type.sm, color = theme.text2)
                        }
                        HButton(if (notice.readAt != null) "Read" else "Mark read", { model.markRead(notice) }, variant = Variant.Ghost, small = true, enabled = notice.readAt == null && !model.busy)
                    }
                }
            }
        }
    }
}

@Composable fun SettingsScreen(model: WorkspaceModel) {
    Page("settings-page", "Settings") {
        AppearanceCard(model)
        AccountCard(model)
        Card {
            CardHeader("Delete account", "You’ll be signed out everywhere right away. Your files, backups and transfers are kept for 30 days and then permanently deleted.")
            Row { HButton("Delete account", { model.error = null; model.overlay = Overlay.DeleteAccount }, variant = Variant.Danger, icon = Lucide.Trash) }
        }
        Text("harbor0 for Android • ${BuildConfig.VERSION_NAME}\nUploads and downloads run while the app is open. Folder sync and backups run while harbor0 is open, and in the background about every 15 minutes when Android allows.", style = Type.xs, color = theme.text2)
    }
}

@Composable private fun AccountCard(model: WorkspaceModel) {
    val user = model.user ?: return
    Card {
        CardHeader("Your account", "Manage active sessions in Devices. Use “Forgot password” on the sign-in screen to reset your password.")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Email", Modifier.width(56.dp), style = Type.sm, color = theme.text2)
            Text(user.email, Modifier.weight(1f, fill = false), style = Type.sm.copy(fontSize = 14.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (user.emailVerified) Badge("Verified", Tone.Success)
        }
        var displayName by remember(user.displayName) { mutableStateOf(user.displayName) }
        var username by remember(user.username) { mutableStateOf(user.username) }
        val changed = displayName.trim() != user.displayName || username != user.username
        val validName = Regex("^[a-z0-9_.]{3,32}$").matches(username)
        Column(Modifier.padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Field("Display name") { HInput(displayName, { displayName = it.take(100) }, Modifier.testTag("display-name")) }
            Field("Username", hint = "3–32 lowercase letters, numbers, dots, or underscores. Usernames can be changed once every 30 days.") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("@", Modifier.padding(end = 6.dp), style = Type.body, color = theme.text2)
                    HInput(username, { username = it.lowercase().take(32) }, Modifier.testTag("username"), invalid = username.isNotEmpty() && !validName,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
                }
            }
            Row { HButton(if (model.busy && changed) "Saving…" else "Save profile", { model.saveProfile(displayName, username) }, enabled = changed && validName && displayName.isNotBlank() && !model.busy) }
            Divider()
            HButton("Manage devices", { model.navigate(Section.Devices) }, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.Settings)
            HButton("Sign out", model::logout, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.LogOut, enabled = !model.busy && model.transfer == null)
        }
    }
}

@Composable private fun AppearanceCard(model: WorkspaceModel) {
    val appearance = model.appearance
    val dark = theme.palette.dark
    val mode = if (dark) "dark" else "light"
    val palette = if (dark) appearance.palettes.dark else appearance.palettes.light
    var picking by remember { mutableStateOf<String?>(null) }
    Card {
        CardHeader("Appearance", "Theme settings apply across your devices.")
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Color mode", style = Type.h3)
            Segmented(listOf("light" to "Light", "dark" to "Dark", "system" to "System"), appearance.preference, { model.updateAppearance(appearance.copy(preference = it)) },
                icons = mapOf("light" to Lucide.Sun, "dark" to Lucide.Moon, "system" to Lucide.Monitor), hug = true)
        }
        Column(Modifier.padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Preset themes", style = Type.h3)
            Text("Each theme includes light and dark colors. Choosing a preset resets custom colors.", style = Type.sm.copy(fontSize = 14.sp, lineHeight = 20.sp), color = theme.text2)
            val customized = appearance.palettes.light.isNotEmpty() || appearance.palettes.dark.isNotEmpty()
            presets.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEach { preset ->
                        PresetCard(preset, dark, appearance.preset == preset.id, customized, Modifier.weight(1f)) {
                            model.updateAppearance(appearance.copy(preset = preset.id, palettes = Palettes()))
                        }
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
        Column(Modifier.padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Custom colors", style = Type.h3)
                Badge(if (dark) "Dark theme" else "Light theme")
            }
            Text("Choose a color or enter a hex code. Light and dark themes keep separate colors.", style = Type.sm.copy(fontSize = 14.sp, lineHeight = 20.sp), color = theme.text2)
            val colors = appearance.colors(dark)
            colorKeys.forEachIndexed { index, key ->
                Divider(Modifier.padding(top = 6.dp))
                ColorRow(colorLabels[index], colorHints[index], colors[index], key in palette, { picking = key }, { value -> model.updateAppearance(appearance.withColor(dark, key, value)) })
            }
        }
        Divider(Modifier.padding(vertical = 14.dp))
        Text(when (model.appearanceStatus) {
            "saving" -> "Saving to your account…"; "saved" -> "Saved to your account."
            "error" -> "Applied here. Couldn’t save to your account. Please retry."; else -> "Theme changes are saved to your account."
        }, style = Type.sm, color = theme.text2)
        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (model.appearanceStatus == "error") HButton("Retry", model::retryAppearance, variant = Variant.Outline, small = true)
            HButton("Reset $mode colors", { model.updateAppearance(appearance.copy(palettes = if (dark) appearance.palettes.copy(dark = emptyMap()) else appearance.palettes.copy(light = emptyMap()))) },
                variant = Variant.Outline, small = true, icon = Lucide.RotateCcw, enabled = palette.isNotEmpty())
        }
    }
    picking?.let { key -> ColorPicker(colorLabels[colorKeys.indexOf(key)], appearance.colors(dark)[colorKeys.indexOf(key)], { picking = null }) { value ->
        model.updateAppearance(appearance.withColor(dark, key, value)); picking = null
    } }
}
fun Appearance.withColor(dark: Boolean, key: String, value: String?): Appearance {
    val old = if (dark) palettes.dark else palettes.light
    val next = if (value == null) old - key else old + (key to value.lowercase())
    return copy(palettes = if (dark) palettes.copy(dark = next) else palettes.copy(light = next))
}
fun normalizeHex(value: String): String? {
    val hex = value.trim()
    if (Regex("^#[\\da-fA-F]{6}$").matches(hex)) return hex.lowercase()
    if (Regex("^#[\\da-fA-F]{3}$").matches(hex)) return "#" + hex.drop(1).map { "$it$it" }.joinToString("").lowercase()
    return null
}
fun hexOf(color: androidx.compose.ui.graphics.Color) = "#%02x%02x%02x".format((color.red * 255).toInt(), (color.green * 255).toInt(), (color.blue * 255).toInt())

@Composable private fun ColorRow(label: String, hint: String, color: androidx.compose.ui.graphics.Color, custom: Boolean, onPick: () -> Unit, onCommit: (String?) -> Unit) {
    var text by remember(color) { mutableStateOf(hexOf(color)) }
    var invalid by remember(color) { mutableStateOf(false) }
    Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column {
            Text(label, style = Type.label.copy(fontSize = 14.sp))
            Text(hint, style = Type.xs, color = theme.text2)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(44.dp).clip(RoundedCornerShape(Radius.md)).border(1.dp, theme.line, RoundedCornerShape(Radius.md)).clickable(role = Role.Button, onClick = onPick)
                .padding(4.dp).background(color, RoundedCornerShape(4.dp)))
            HInput(text, { value ->
                text = value.take(7); invalid = false
                if (Regex("^#[\\da-fA-F]{6}$").matches(value)) onCommit(value)
            }, Modifier.weight(1f), placeholder = "#RRGGBB", invalid = invalid, style = Type.mono.copy(fontSize = 15.sp),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false), keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = {
                    normalizeHex(text)?.let(onCommit) ?: run { invalid = true }
                }))
            HIconButton(Lucide.RotateCcw, "Reset ${label.lowercase()} color", { onCommit(null) }, enabled = custom)
        }
        if (invalid) Text("Use a hex color, like #2563eb or #fff.", style = Type.xs, color = theme.dangerText)
    }
}

private val swatches = listOf("#4353d9", "#2563eb", "#0e9384", "#187047", "#15803d", "#7c3aed", "#b94719", "#d33b3b", "#b45309", "#db2777",
    "#8793ff", "#60a5fa", "#3fd0c0", "#6cce98", "#b794f6", "#fbad77", "#f26d6d", "#e5a949",
    "#ffffff", "#fafafa", "#f4f5f7", "#eff6ff", "#f0f7f2", "#f7f3ff", "#fff7ed", "#e3e5ea",
    "#16181d", "#0d0e10", "#141518", "#1b1d21", "#2b2e34", "#0b1220")
@Composable private fun ColorPicker(label: String, current: androidx.compose.ui.graphics.Color, onDismiss: () -> Unit, onApply: (String) -> Unit) {
    var value by remember { mutableStateOf(hexOf(current)) }
    val parsed = normalizeHex(value)
    HDialog(label, onDismiss, "Choose a color or enter a hex code.", actions = {
        HButton("Apply color", { parsed?.let(onApply) }, Modifier.fillMaxWidth(), enabled = parsed != null)
        HButton("Cancel", onDismiss, Modifier.fillMaxWidth(), Variant.Outline)
    }) {
        swatches.chunked(6).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { hex ->
                    val selected = parsed == hex
                    Box(Modifier.weight(1f).aspectRatio(1f).clip(CircleShape).border(if (selected) 3.dp else 1.dp, if (selected) theme.primary else theme.line, CircleShape)
                        .padding(if (selected) 4.dp else 0.dp).clip(CircleShape).background(hexColor(hex)).selectable(selected, role = Role.RadioButton) { value = hex })
                }
                repeat(6 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(44.dp).border(1.dp, theme.line, RoundedCornerShape(Radius.md)).padding(4.dp).background(parsed?.let(::hexColor) ?: current, RoundedCornerShape(4.dp)))
            HInput(value, { value = it.trim().take(7) }, Modifier.weight(1f), placeholder = "#RRGGBB", invalid = parsed == null, style = Type.mono.copy(fontSize = 15.sp))
        }
        if (parsed == null) Text("Use a hex color, like #2563eb or #fff.", style = Type.xs, color = theme.dangerText)
    }
}

@Composable private fun PresetCard(preset: Preset, dark: Boolean, selected: Boolean, customized: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val t = theme
    val shape = RoundedCornerShape(Radius.lg)
    // Harbor shows its fixed swatches; other presets show their accent, page and card colors for the current mode.
    val colors = if (preset.id == "default") listOf("#4353d9", "#f4f5f7", "#ffffff") else (if (dark) preset.dark else preset.light).take(3)
    Column(modifier.clip(shape).border(if (selected) 2.dp else 1.dp, if (selected) t.primary else t.line, shape)
        .selectable(selected, role = Role.RadioButton, onClick = onClick).padding(10.dp).testTag("preset-${preset.name}")) {
        Row(Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(Radius.md)).border(1.dp, t.line, RoundedCornerShape(Radius.md))) {
            colors.forEach { Box(Modifier.weight(1f).fillMaxHeight().background(hexColor(it))) }
        }
        Text(preset.name, Modifier.padding(top = 10.dp), style = Type.h3)
        Text(preset.description, Modifier.padding(top = 2.dp), style = Type.sm.copy(fontSize = 14.sp), color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (selected) Text(if (customized) "Customized" else "Selected", Modifier.padding(top = 4.dp), style = Type.label.copy(fontSize = 14.sp), color = t.accentText)
    }
}
