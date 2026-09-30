package app.harbor0.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable fun Settings(model: WorkspaceModel, signOut: () -> Unit) {
    var editDark by rememberSaveable { mutableStateOf(false) }
    var customKey by remember { mutableStateOf<String?>(null) }
    val appearance = model.appearance
    Column(Modifier.widthIn(max = 840.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        model.listing.error?.let { Banner(it, "Try again") { model.refresh() } }
        model.account?.let { account ->
            SettingsGroup("Account") {
                Text(account.user.displayName, style = MaterialTheme.typography.titleMedium)
                Text(account.user.email, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                Text("${bytesLabel(account.storage.usedBytes)} of ${bytesLabel(account.storage.quotaBytes)} used", style = MaterialTheme.typography.bodySmall)
                LinearProgressIndicator(progress = { if (account.storage.quotaBytes > 0) (account.storage.usedBytes.toFloat() / account.storage.quotaBytes).coerceIn(0f, 1f) else 0f }, modifier = Modifier.fillMaxWidth())
                if (account.storage.reservedBytes > 0) Text("${bytesLabel(account.storage.reservedBytes)} reserved for uploads", style = MaterialTheme.typography.bodySmall)
            }
        }
        SettingsGroup("Appearance") {
            Text("Preview changes here, then save them to your account.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("system" to "System", "light" to "Light", "dark" to "Dark").forEach { (value, label) ->
                    FilterChip(selected = appearance.preference == value, onClick = { model.appearance = appearance.copy(preference = value) }, label = { Text(label) })
                }
            }
            presets.forEach { preset ->
                Row(Modifier.fillMaxWidth().selectablePreset(appearance.preset == preset.id) {
                    model.appearance = appearance.copy(preset = preset.id)
                }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = appearance.preset == preset.id, onClick = null)
                    Text(preset.name, Modifier.weight(1f).padding(start = 8.dp))
                    preset.light.take(4).forEach { color -> Box(Modifier.padding(3.dp).size(20.dp).background(hexColor(color), CircleShape).border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)) }
                }
            }
            Button(onClick = model::saveAppearance, enabled = !model.busy && model.account != null && appearance != model.savedAppearance, modifier = Modifier.fillMaxWidth()) { Text("Save appearance") }
            if (appearance != model.savedAppearance) TextButton(onClick = { model.appearance = model.savedAppearance }) { Text("Discard changes") }
        }
        SettingsGroup("Custom colors") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(!editDark, { editDark = false }, label = { Text("Light palette") })
                FilterChip(editDark, { editDark = true }, label = { Text("Dark palette") })
            }
            val colors = appearance.colors(editDark)
            colorKeys.forEachIndexed { index, key ->
                Row(Modifier.fillMaxWidth().clickable { customKey = key }.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(24.dp).background(colors[index], CircleShape).border(1.dp, MaterialTheme.colorScheme.outline, CircleShape))
                    Text(colorLabels[index], Modifier.padding(start = 12.dp).weight(1f))
                    Text("Edit", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                }
            }
            TextButton(onClick = { model.appearance = appearance.copy(palettes = Palettes()) }) { Text("Reset custom colors") }
        }
        OutlinedButton(onClick = signOut, enabled = !model.busy && model.transfer == null, modifier = Modifier.fillMaxWidth()) { Text("Sign out") }
        Text("harbor0 for Android • 0.1.0\nTransfers run while the app is open. Sync and backup automation run on your computers.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onBackground.copy(alpha = .65f))
    }
    customKey?.let { key ->
        val original = (if (editDark) appearance.palettes.dark else appearance.palettes.light)[key].orEmpty()
        var value by remember(key, editDark) { mutableStateOf(original) }
        AlertDialog(onDismissRequest = { customKey = null }, title = { Text(colorLabels[colorKeys.indexOf(key)]) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Enter a hex color, or leave blank to use the preset.")
                OutlinedTextField(value, { value = it.trim() }, label = { Text("#RRGGBB") }, singleLine = true, isError = value.isNotEmpty() && !isHex(value))
            }
        }, confirmButton = { TextButton(enabled = value.isEmpty() || isHex(value), onClick = {
            val old = if (editDark) appearance.palettes.dark else appearance.palettes.light
            val next = if (value.isEmpty()) old - key else old + (key to value)
            model.appearance = appearance.copy(palettes = if (editDark) appearance.palettes.copy(dark = next) else appearance.palettes.copy(light = next))
            customKey = null
        }) { Text("Apply color") } }, dismissButton = { TextButton(onClick = { customKey = null }) { Text("Cancel") } })
    }
}
private fun Modifier.selectablePreset(selected: Boolean, onClick: () -> Unit): Modifier = this.then(
    Modifier.selectable(selected = selected, role = androidx.compose.ui.semantics.Role.RadioButton, onClick = onClick)
)
@Composable private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}
