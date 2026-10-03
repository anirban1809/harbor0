package app.harbor0.android

import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

enum class TabItem(val label: String, val icon: ImageVector, val section: Section?) {
    Drive("Drive", Lucide.HardDrive, Section.Drive), Shared("Shared", Lucide.Users, Section.Shared),
    Backups("Backups", Lucide.Archive, Section.Backups), Trash("Trash", Lucide.Trash, Section.Trash), More("More", Lucide.Menu, null)
}

/** The phone frame: top bar, the current page, floating cards and the tab bar. */
@Composable fun Shell(model: WorkspaceModel) {
    val palette = theme.palette
    // Searching waits for typing to pause, as the web search box does.
    LaunchedEffect(model.query) {
        delay(300)
        when (model.section) {
            Section.Drive -> if (model.query.trim() != model.drive.loadedQuery) model.drive.refresh()
            Section.Trash -> if (model.query.trim() != model.trash.loadedQuery) model.trash.refresh(null)
            else -> if (model.query.trim() != (model.search.loadedQuery ?: "")) model.search.refresh(null)
        }
    }
    Sheet(palette.background, Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))) {
            TopBar(model)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                Column(Modifier.fillMaxSize().imePadding()) {
                    if (!model.online) Alert("You’re offline. Changes will sync when your connection returns.", Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp), Tone.Warning)
                    if (model.overlay == null) model.error?.let { Alert(it, Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp), Tone.Danger, "Dismiss") { model.error = null } }
                    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                        Box(Modifier.widthIn(max = 840.dp).fillMaxSize()) {
                            val searching = model.query.isNotBlank() && model.section != Section.Drive && model.section != Section.Trash
                            if (searching) SearchScreen(model) else when (model.section) {
                                Section.Drive -> DriveScreen(model)
                                Section.Shared -> SharedScreen(model)
                                Section.Backups -> BackupsScreen(model)
                                Section.Trash -> TrashScreen(model)
                                Section.Sync -> SyncScreen(model)
                                Section.Devices -> DevicesScreen(model)
                                Section.Storage -> StorageScreen(model)
                                Section.Settings -> SettingsScreen(model)
                                Section.Notifications -> NotificationsScreen(model)
                            }
                        }
                    }
                }
                Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth(), horizontalAlignment = Alignment.End) {
                    model.toast?.let { Toast(it, Modifier.align(Alignment.CenterHorizontally)) }
                    model.zip?.let { ZipCard(it, model::cancelZip) }
                    model.transfer?.let { TransferCard(it, model::cancelTransfer) }
                    if (model.uploads.entries.isNotEmpty()) UploadTray(model.uploads)
                    if (model.section == Section.Drive) DriveFloating(model)
                }
            }
            TabBar(model)
        }
    }
    Overlays(model)
}

@Composable private fun TopBar(model: WorkspaceModel) {
    val t = theme
    val focus = LocalFocusManager.current
    var account by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(start = 12.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.padding(end = 4.dp).clip(RoundedCornerShape(Radius.md)).clickable(role = Role.Button) { model.navigate(Section.Drive) }
            .semantics { contentDescription = "harbor0 home" }.padding(2.dp)) { BrandMark(26.dp) }
        val interaction = remember { MutableInteractionSource() }
        BasicTextField(model.query, { text ->
            model.query = text; model.drive.selected = emptySet(); model.trash.selected = emptySet()
        }, Modifier.weight(1f).testTag("search"), singleLine = true, textStyle = Type.body.copy(fontSize = 16.sp, color = t.text), cursorBrush = SolidColor(t.primary),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }), interactionSource = interaction) { inner ->
            Row(Modifier.height(40.dp).background(t.fill2, CircleShape).padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Lucide.Search, null, Modifier.size(18.dp), tint = t.text2)
                Box(Modifier.weight(1f).padding(start = 8.dp)) {
                    if (model.query.isEmpty()) Text(if (model.section == Section.Trash) "Search Trash" else "Search your files", style = Type.body.copy(fontSize = 16.sp), color = t.text2, maxLines = 1)
                    inner()
                }
                if (model.query.isNotEmpty()) Box(Modifier.size(32.dp).clip(CircleShape).clickable(role = Role.Button) { model.clearSearch(); focus.clearFocus() }
                    .semantics { contentDescription = "Clear search" }, contentAlignment = Alignment.Center) { Icon(Lucide.X, null, Modifier.size(16.dp), tint = t.text2) }
            }
        }
        Box(Modifier.size(40.dp).clip(CircleShape).clickable(role = Role.Button) { model.overlay = Overlay.Activity }
            .semantics { contentDescription = "Activity notifications" + if (model.unread > 0) ", ${model.unread} unread" else "" }, contentAlignment = Alignment.Center) {
            Icon(Lucide.Bell, null, Modifier.size(20.dp), tint = t.text2)
            if (model.unread > 0) Box(Modifier.align(Alignment.TopEnd).padding(top = 9.dp, end = 9.dp).size(8.dp).background(t.palette.destructive, CircleShape).border(1.5.dp, t.surface, CircleShape))
        }
        Box {
            val name = model.user?.displayName?.ifBlank { null } ?: "Your account"
            Box(Modifier.size(40.dp).clip(CircleShape).clickable(role = Role.Button) { account = true }.semantics { contentDescription = "Account menu" }.testTag("account"),
                contentAlignment = Alignment.Center) {
                Box(Modifier.size(32.dp).background(t.accentSoft, CircleShape), contentAlignment = Alignment.Center) {
                    Text(name.take(1).uppercase(), style = Type.label.copy(fontSize = 14.sp, fontWeight = FontWeight(600)), color = t.accentText)
                }
            }
            HMenu(account, { account = false }, Modifier.widthIn(min = 280.dp)) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(name, style = Type.h3)
                    model.user?.username?.takeIf { it.isNotEmpty() }?.let { Text("@$it", style = Type.sm, color = theme.text2) }
                    model.user?.email?.let { Text(it, style = Type.sm, color = theme.text2) }
                    model.storage?.let { Text("${bytesLabel(it.usedBytes)} of ${bytesLabel(it.quotaBytes)} used", Modifier.padding(top = 6.dp), style = Type.xs, color = theme.text2) }
                }
                HMenuSeparator()
                HMenuItem("Account settings", onClick = { account = false; model.navigate(Section.Settings) })
                HMenuItem("Devices", onClick = { account = false; model.navigate(Section.Devices) })
                HMenuItem("Manage storage", onClick = { account = false; model.navigate(Section.Storage) })
                HMenuSeparator()
                HMenuItem("Sign out", onClick = { account = false; model.logout() })
            }
        }
    }
}

@Composable private fun TabBar(model: WorkspaceModel) {
    val t = theme
    Column(Modifier.fillMaxWidth().background(t.surface)) {
        Divider()
        Row(Modifier.fillMaxWidth().navigationBarsPadding().height(60.dp).selectableGroup()) {
            TabItem.entries.forEach { tab ->
                val active = if (tab.section == null) model.section.inMore || model.overlay == Overlay.More else model.section == tab.section && model.overlay != Overlay.More
                Column(Modifier.weight(1f).fillMaxHeight().testTag("tab-${tab.name}").selectable(active, role = Role.Tab) {
                    if (tab.section == null) model.overlay = Overlay.More else model.navigate(tab.section)
                }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically)) {
                    Box(Modifier.clip(CircleShape).background(if (active) t.accentSoft else t.surface).padding(horizontal = 18.dp, vertical = 4.dp)) {
                        Icon(tab.icon, null, Modifier.size(20.dp), tint = if (active) t.accentText else t.text2)
                    }
                    Text(tab.label, style = Type.xs.copy(fontSize = 11.sp, fontWeight = FontWeight(500), letterSpacing = .1.sp), color = if (active) t.text else t.text2, maxLines = 1)
                }
            }
        }
    }
}

@Composable fun FloatingCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(Radius.lg)
    Sheet(theme.palette.card, modifier.padding(horizontal = 12.dp, vertical = 6.dp).fillMaxWidth().shadow(12.dp, shape), shape, border = true) {
        Column(Modifier.fillMaxWidth(), content = content)
    }
}
@Composable private fun TransferCard(state: TransferProgress, cancel: () -> Unit) {
    FloatingCard {
        Column(Modifier.padding(start = 14.dp, end = 6.dp, bottom = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(state.label, Modifier.weight(1f), style = Type.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                HButton("Cancel", cancel, variant = Variant.Ghost, small = true)
            }
            Progress(state.fraction, Modifier.padding(end = 8.dp))
            Text("Keep harbor0 open until the transfer finishes.", Modifier.padding(top = 8.dp), style = Type.xs, color = theme.text2)
        }
    }
}
@Composable private fun ZipCard(progress: ZipProgress, cancel: () -> Unit) {
    val percent = progress.fraction?.takeIf { progress.phase in listOf("building", "downloading") }?.let { (it * 100).toInt().coerceIn(0, 100) }
    val message = when (progress.phase) {
        "queued" -> "Starting ZIP preparation…"
        "listing" -> "Finding files and folders…"
        "building" -> if (percent == null) "Preparing your ZIP…" else "Preparing ZIP · $percent%"
        "downloading" -> if (percent == null) "Connecting to storage…" else "Downloading ZIP · $percent%"
        else -> "Finishing your ZIP…"
    }
    FloatingCard {
        Column(Modifier.padding(start = 14.dp, end = 6.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Lucide.LoaderCircle, null, Modifier.size(18.dp), tint = theme.accentText)
                Text("${if (progress.phase == "downloading") "Downloading" else "Preparing"} ${progress.name}.zip", Modifier.weight(1f), style = Type.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                HButton("Cancel", cancel, variant = Variant.Ghost, small = true)
            }
            Text(message, style = Type.xs, color = theme.text2)
            Text("${plural(progress.files, "file")} completed · ${bytesLabel(progress.bytes)} ${if (progress.phase == "downloading") "downloaded" else "prepared"}", style = Type.xs, color = theme.text2)
            progress.currentFile?.let { Text(it, style = Type.xs, color = theme.text3, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            Progress(percent?.let { it / 100f }, Modifier.padding(top = 4.dp, end = 8.dp))
        }
    }
}
@Composable private fun UploadTray(queue: UploadQueue) {
    val activity = summarizeUploads(queue.entries)
    val running = activity.count { it.phase != UploadPhase.Done && it.phase != UploadPhase.Failed }
    FloatingCard(Modifier.testTag("upload-tray")) {
        Row(Modifier.padding(start = 14.dp, end = 4.dp, top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(when { running > 0 -> "Uploading $running ${if (running == 1) "item" else "items"}"; activity.any { it.phase == UploadPhase.Failed } -> "Some uploads failed"; else -> "Uploads complete" },
                Modifier.weight(1f), style = Type.label.copy(fontSize = 14.sp))
            HIconButton(Lucide.X, "Dismiss finished uploads", queue::dismiss, enabled = running < activity.size)
        }
        Column(Modifier.heightIn(max = 220.dp).verticalScroll(rememberScrollState()).padding(start = 14.dp, end = 4.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            activity.forEach { a ->
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(if (a.folder) Lucide.Folder else Lucide.File, null, Modifier.size(16.dp), tint = theme.text2)
                        Text(a.name, Modifier.weight(1f), style = Type.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        when (a.phase) {
                            UploadPhase.Done -> Icon(Lucide.Check, "Uploaded", Modifier.padding(horizontal = 10.dp).size(16.dp), tint = theme.successText)
                            UploadPhase.Paused, UploadPhase.Failed -> HIconButton(Lucide.Play, "${if (a.phase == UploadPhase.Failed) "Retry" else "Resume"} ${a.name}", { queue.resume(a.keys) })
                            else -> HIconButton(Lucide.Pause, "Pause ${a.name}", { queue.pause(a.keys) })
                        }
                        if (a.phase != UploadPhase.Done) HIconButton(Lucide.X, "Cancel ${a.name}", { queue.cancel(a.keys) })
                    }
                    Progress(if (a.phase == UploadPhase.Hashing && a.loaded == 0L) null else a.loaded.toFloat() / maxOf(1, a.size), Modifier.padding(end = 10.dp), height = 4.dp)
                    Text(uploadDetail(a), Modifier.padding(top = 4.dp), style = Type.xs, color = if (a.phase == UploadPhase.Failed) theme.dangerText else theme.text2, maxLines = 2)
                }
            }
        }
    }
}
