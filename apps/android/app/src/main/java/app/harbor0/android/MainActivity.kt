package app.harbor0.android

import android.content.ClipData
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import java.io.File

class MainActivity: ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val model: WorkspaceModel = viewModel()
            HarborTheme(model.appearance) {
                // The workspace puts the page under the status bar and the navigation color under the system bar; sign-in is the reverse.
                val palette = LocalTokens.current.palette
                val workspace = model.signedIn || model.restoring
                val lightTop = ink(if (workspace) palette.background else palette.sidebar) == Color.Black
                val lightBottom = ink(if (model.signedIn && !model.restoring) palette.sidebar else palette.background) == Color.Black
                SideEffect { WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = lightTop; isAppearanceLightNavigationBars = lightBottom } }
                HarborApp(model)
            }
        }
    }
}
fun tabIcon(tab: Tab): ImageVector = when (tab) {
    Tab.Drive -> Lucide.HardDrive
    Tab.Sync -> Lucide.RefreshCw
    Tab.Backups -> Lucide.Archive
    Tab.Trash -> Lucide.Trash
    Tab.Settings -> Lucide.Settings
}

@Composable fun HarborApp(model: WorkspaceModel) {
    val context = LocalContext.current
    val palette = theme.palette
    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(model::upload) }
    var fileToSave by remember { mutableStateOf<File?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri != null) fileToSave?.let { model.saveDownload(uri, it) }; fileToSave = null
    }
    var newFolder by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<Pair<String, DriveItem?>?>(null) }
    LaunchedEffect(model.signedIn) { if (!model.signedIn) { newFolder = false; confirm = null } }
    LaunchedEffect(model.message) { if (model.message != null) { delay(5000); model.message = null } }
    BackHandler(model.signedIn && (model.path.isNotEmpty() || model.history)) { model.back() }
    when {
        model.restoring -> Sheet(palette.background, Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically)) {
                Icon(painterResource(R.drawable.ic_harbor), null, Modifier.size(40.dp), tint = theme.primary)
                Progress(null, Modifier.width(120.dp), height = 4.dp)
                Text("Opening harbor0…", style = Type.sm, color = theme.text2)
            }
        }
        !model.signedIn -> SignIn(model)
        // The navigation color is the canvas; the working area sits on it as one sheet, as in the web and desktop shell.
        else -> Sheet(palette.sidebar, Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal))) {
                Sheet(palette.background, Modifier.weight(1f).fillMaxWidth(), RoundedCornerShape(bottomStart = Radius.xl, bottomEnd = Radius.xl), border = true) {
                    Box(Modifier.fillMaxSize()) {
                        Column(Modifier.fillMaxSize().statusBarsPadding()) {
                            TopBar(model, onUpload = { upload.launch(arrayOf("*/*")) }, onNewFolder = { newFolder = true }, onEmptyTrash = { confirm = "empty" to null })
                            if (model.busy) Progress(null, height = 2.dp) else Divider()
                            model.error?.let { Alert(it, Modifier.padding(start = 16.dp, top = 12.dp, end = 16.dp), Tone.Danger, "Dismiss") { model.error = null } }
                            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                                if (model.tab == Tab.Settings) Settings(model) { confirm = "logout" to null }
                                else {
                                    val refresh = rememberPullToRefreshState()
                                    PullToRefreshBox(isRefreshing = model.listing.loading && model.listing.loaded, onRefresh = { model.refresh() }, state = refresh,
                                        modifier = Modifier.widthIn(max = 840.dp).fillMaxSize(),
                                        indicator = { PullToRefreshDefaults.Indicator(refresh, model.listing.loading && model.listing.loaded, Modifier.align(Alignment.TopCenter), containerColor = palette.card, color = palette.primary) }) {
                                        FileListing(model, onUpload = { upload.launch(arrayOf("*/*")) }, onNewFolder = { newFolder = true }) { action, item -> confirm = action to item }
                                    }
                                }
                            }
                            model.transfer?.let { TransferCard(it, model::cancelTransfer) }
                        }
                        model.message?.let { Toast(it, Modifier.align(Alignment.BottomCenter)) }
                    }
                }
                BottomNav(model)
            }
        }
    }
    if (newFolder) {
        var name by rememberSaveable { mutableStateOf("") }
        val valid = runCatching { safeName(name.trim()) }.isSuccess
        val focus = remember { FocusRequester() }
        fun create() { if (valid) { newFolder = false; model.createFolder(name) } }
        LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
        HDialog("New folder", { newFolder = false }, "Create a folder in ${model.title}.", actions = {
            HButton("Cancel", { newFolder = false }, variant = Variant.Outline)
            HButton("Create folder", ::create, enabled = valid)
        }) {
            Field("Folder name") {
                HInput(name, { name = it }, Modifier.focusRequester(focus).testTag("folder-name"),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { create() }))
            }
        }
    }
    confirm?.let { (action, item) ->
        val title = when (action) { "empty" -> "Empty trash?"; "permanent" -> "Delete permanently?"; "logout" -> "Sign out?"; else -> "Move to trash?" }
        val detail = when (action) {
            "empty" -> "All items in your trash will be permanently deleted. This cannot be undone."
            "permanent" -> "${item?.name} will be permanently deleted. This cannot be undone."
            "logout" -> "Your session on this device will be revoked."
            else -> "${item?.name} will move to Trash, where you can restore it."
        }
        HDialog(title, { confirm = null }, detail, actions = {
            HButton("Cancel", { confirm = null }, variant = Variant.Outline)
            HButton(when (action) { "empty" -> "Empty trash"; "permanent" -> "Delete permanently"; "logout" -> "Sign out"; else -> "Move to trash" }, {
                confirm = null
                when (action) { "empty" -> model.emptyTrash(); "logout" -> model.logout(); else -> item?.let { model.mutate(it, action) } }
            }, variant = if (action == "logout") Variant.Primary else Variant.Danger)
        })
    }
    model.preview?.let { preview ->
        fun launchFile(share: Boolean) {
            try {
                val uri = FileProvider.getUriForFile(context, context.packageName + ".files", preview.file)
                val intent = if (share) Intent(Intent.ACTION_SEND).setType(preview.mime).putExtra(Intent.EXTRA_STREAM, uri)
                    else Intent(Intent.ACTION_VIEW).setDataAndType(uri, preview.mime)
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                intent.clipData = ClipData.newRawUri(preview.file.name, uri)
                context.startActivity(Intent.createChooser(intent, if (share) "Share file" else "Open file"))
            } catch (_: android.content.ActivityNotFoundException) { model.error = "No app can open this file. Use Save to keep a copy." }
        }
        HDialog(preview.file.name, { model.preview = null }, "Open it in another app or save a copy on your device.",
            actions = { HButton("Done", { model.preview = null }) }) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Badge("Download verified", Tone.Success)
                Text(bytesLabel(preview.file.length()), style = Type.xs, color = theme.text2)
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HButton("Open file", { launchFile(false) }, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.ExternalLink)
                HButton("Share file", { launchFile(true) }, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.Share2)
                HButton("Save to device", { fileToSave = preview.file; save.launch(preview.file.name) }, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.Download)
            }
        }
    }
}

@Composable private fun TopBar(model: WorkspaceModel, onUpload: () -> Unit, onNewFolder: () -> Unit, onEmptyTrash: () -> Unit) {
    val nested = model.path.isNotEmpty() || model.history
    var addMenu by remember { mutableStateOf(false) }
    LaunchedEffect(model.signedIn, model.tab) { addMenu = false }
    Row(Modifier.fillMaxWidth().height(56.dp).padding(start = if (nested) 4.dp else 16.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (nested) HIconButton(Lucide.ArrowLeft, "Back", model::back)
        Text(model.title, Modifier.weight(1f).padding(end = 8.dp).semantics { heading() }, style = Type.h1, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (model.currentBackup != null && !model.history) HIconButton(Lucide.RotateCcwClock, "Backup history", model::showHistory)
        if (model.tab == Tab.Trash) HButton("Empty trash", onEmptyTrash, variant = Variant.Outline, small = true, enabled = model.listing.items.isNotEmpty() && !model.busy)
        HIconButton(Lucide.RefreshCw, "Refresh", { model.refresh() }, enabled = !model.listing.loading)
        if (model.canWrite) Box {
            HIconButton(Lucide.Plus, "Add files or folder", { addMenu = true }, primary = true, enabled = !model.busy && model.transfer == null)
            HMenu(addMenu, { addMenu = false }) {
                HMenuItem("Upload file", Lucide.ArrowUpFromLine, { addMenu = false; onUpload() })
                HMenuItem("New folder", Lucide.FolderPlus, { addMenu = false; onNewFolder() })
            }
        }
    }
}

@Composable private fun BottomNav(model: WorkspaceModel) {
    val t = theme
    val active = t.palette.on(t.palette.background)
    val shape = RoundedCornerShape(Radius.md)
    Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp, vertical = 6.dp).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Tab.entries.forEach { tab ->
            val selected = model.tab == tab
            Column(Modifier.weight(1f).testTag("tab-${tab.name}").heightIn(min = 52.dp)
                .then(if (selected) Modifier.shadow(1.dp, shape).background(active.surface, shape).border(1.dp, active.text.copy(alpha = .08f), shape) else Modifier)
                .clip(shape).selectable(selected, role = Role.Tab) { model.select(tab) }.padding(vertical = 7.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically)) {
                Icon(tabIcon(tab), null, Modifier.size(20.dp), tint = if (selected) active.accentText else t.text2)
                Text(tab.label, style = Type.xs.copy(fontSize = 11.sp, fontWeight = FontWeight(500)), color = if (selected) active.text else t.text2, maxLines = 1)
            }
        }
    }
}

@Composable private fun TransferCard(state: TransferProgress, cancel: () -> Unit) {
    val shape = RoundedCornerShape(Radius.lg)
    Sheet(theme.palette.card, Modifier.padding(12.dp).fillMaxWidth().shadow(10.dp, shape), shape, border = true) {
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

@Composable fun SignIn(model: WorkspaceModel) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val context = LocalContext.current
    val ready = !model.busy && email.isNotBlank() && password.isNotEmpty()
    Sheet(theme.palette.sidebar, Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Top)).imePadding(),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().padding(start = 20.dp, top = 24.dp, end = 20.dp, bottom = 22.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(R.drawable.ic_harbor), null, Modifier.size(24.dp), tint = theme.primary)
                    Text("harbor0", style = Type.h2.copy(fontWeight = FontWeight(650), letterSpacing = (-.02).em))
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Your files, within reach.", style = Type.display, modifier = Modifier.semantics { heading() })
                    Text("Store, sync, and share files. 100 GB free.", style = Type.body, color = theme.text2)
                }
            }
            Sheet(theme.palette.background, Modifier.weight(1f).fillMaxWidth(), RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl), border = true) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                    Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 20.dp, vertical = 28.dp)) {
                        Text("Sign in", style = Type.display.copy(fontSize = 24.sp, letterSpacing = (-.025).em), modifier = Modifier.semantics { heading() })
                        Text("Enter your email and password.", Modifier.padding(top = 6.dp), style = Type.sm, color = theme.text2)
                        model.error?.let { Alert(it, Modifier.padding(top = 16.dp), Tone.Danger) }
                        Column(Modifier.padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            Field("Email") {
                                HInput(email, { email = it }, Modifier.testTag("email"), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next))
                            }
                            Field("Password") {
                                HInput(password, { password = it }, Modifier.testTag("password"), visualTransformation = PasswordVisualTransformation(),
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                                    keyboardActions = KeyboardActions(onDone = { if (ready) model.login(email, password) }))
                            }
                            HButton(if (model.busy) "Signing in…" else "Sign in", { model.login(email, password) }, Modifier.fillMaxWidth().testTag("sign-in"), enabled = ready)
                        }
                        Column(Modifier.padding(top = 12.dp)) {
                            HButton("Create an account", { context.startActivity(Intent(Intent.ACTION_VIEW, UriForSignup)) }, variant = Variant.Link)
                            if (model.api.canRestore) {
                                HButton("Retry saved sign-in", model::restore, variant = Variant.Link, enabled = !model.busy)
                                HButton("Remove saved sign-in from this device", model::forget, variant = Variant.Link, enabled = !model.busy)
                            }
                        }
                        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Lucide.ShieldCheck, null, Modifier.size(14.dp), tint = theme.text2)
                            Text("Files are private unless you share them.", style = Type.xs, color = theme.text2)
                        }
                    }
                }
            }
        }
    }
}
private val UriForSignup = android.net.Uri.parse("https://d1bpha1d51nhxy.cloudfront.net/signup")

private fun stateLabel(state: String) = state.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }
private fun stateTone(state: String) = when (state) {
    "ACTIVE", "SYNCED", "SUCCEEDED", "COMPLETED" -> Tone.Success
    "RUNNING", "SYNCING" -> Tone.Accent
    "PAUSED", "PENDING" -> Tone.Warning
    "FAILED", "ERROR" -> Tone.Danger
    else -> Tone.Neutral
}

@Composable private fun Breadcrumbs(model: WorkspaceModel) {
    val root = if (model.tab == Tab.Drive) "My Drive" else model.tab.label
    Row(Modifier.horizontalScroll(rememberScrollState(), reverseScrolling = true).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        (listOf(root) + model.path.map { it.name }).forEachIndexed { depth, name ->
            val current = depth == model.path.size
            if (depth > 0) Icon(Lucide.ChevronRight, null, Modifier.size(14.dp), tint = theme.text3)
            Text(name, Modifier.clip(RoundedCornerShape(Radius.sm)).clickable(enabled = !current, role = Role.Button) { model.openPath(depth) }.padding(horizontal = 6.dp, vertical = 8.dp),
                style = if (current) Type.label else Type.sm, color = if (current) theme.text else theme.text2, maxLines = 1)
        }
    }
}

@Composable fun FileListing(model: WorkspaceModel, onUpload: () -> Unit, onNewFolder: () -> Unit, confirm: (String, DriveItem) -> Unit) {
    val list = model.listing
    val t = theme
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
        item {
            if (model.path.isNotEmpty() && !model.history) Breadcrumbs(model)
            else Text(when {
                model.history -> model.currentBackup?.localPathDisplayName.orEmpty()
                model.tab == Tab.Backups -> "Browse saved files. Automatic backups are managed on the source computer."
                model.tab == Tab.Sync -> "Folders linked to your computers. Automatic sync runs on the desktop app."
                model.tab == Tab.Trash -> "Restore files or delete them permanently."
                else -> "Cloud files"
            }, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = Type.sm, color = t.text2)
        }
        val empty = list.items.isEmpty() && list.runs.isEmpty()
        list.error?.let { error ->
            item {
                if (empty) EmptyState(Lucide.WifiOff, "Couldn’t load this page", error) { HButton("Try again", { model.refresh() }, variant = Variant.Outline, small = true, icon = Lucide.RefreshCw) }
                else Alert(error, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), Tone.Danger, "Try again") { model.refresh() }
            }
        }
        if (list.loading && !list.loaded) items(6) {
            Row(Modifier.fillMaxWidth().height(60.dp).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Skeleton(Modifier.size(36.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { Skeleton(Modifier.size(width = (120 + it % 3 * 40).dp, height = 12.dp)); Skeleton(Modifier.size(72.dp, 10.dp)) }
            }
        }
        if (list.loaded && empty) item {
            EmptyState(if (model.history) Lucide.RotateCcwClock else if (model.tab == Tab.Drive || model.path.isNotEmpty()) Lucide.Folder else tabIcon(model.tab),
                when { model.history -> "No backup history"; model.tab == Tab.Trash -> "Trash is empty"; else -> "No files here yet" },
                when { model.canWrite -> "Upload a file or create a folder to get started."; model.tab == Tab.Trash -> "Removed files will appear here."; else -> "Add a folder in harbor0 on your computer." }) {
                if (model.canWrite) {
                    HButton("Upload a file", onUpload, small = true, icon = Lucide.ArrowUpFromLine, enabled = !model.busy && model.transfer == null)
                    HButton("Add a folder", onNewFolder, variant = Variant.Outline, small = true, icon = Lucide.FolderPlus, enabled = !model.busy)
                }
            }
        }
        items(list.items, key = { it.id }) { item ->
            val sync = model.statuses[item.id]
            val backup = model.backups.firstOrNull { it.remoteRootDriveItemId == item.id }
            val (badge, detail) = when {
                model.tab == Tab.Trash -> null to "Deleted ${dateLabel(item.deletedAt.orEmpty())}"
                backup != null -> (stateLabel(backup.state) to stateTone(backup.state)) to (backup.deviceName ?: "Source computer")
                sync != null -> (sync.label to stateTone(sync.state)) to "${sync.confirmedDevices}/${sync.requiredDevices} devices"
                item.cloudState == "RELEASED" -> ("On your computer" to Tone.Neutral) to "Tap to request a copy"
                item.cloudState == "REQUESTED" -> ("Waiting for your computer" to Tone.Warning) to ""
                item.isFolder -> null to "Folder"
                else -> null to listOf(bytesLabel(item.sizeBytes), dateLabel(item.updatedAt)).filter { it.isNotEmpty() }.joinToString(" • ")
            }
            val mime = item.mimeType.orEmpty()
            val (icon, tint) = when {
                item.isFolder -> Lucide.Folder to t.primary
                mime.startsWith("image/") -> Lucide.FileImage to t.palette.kindImage
                mime.startsWith("text/") || mime == "application/pdf" -> Lucide.FileText to t.text2
                else -> Lucide.File to t.text2
            }
            Column(Modifier.animateItem()) {
                Row(Modifier.fillMaxWidth().then(if (model.tab != Tab.Trash) Modifier.clickable(enabled = model.transfer == null && item.cloudState != "REQUESTED") {
                    if (item.isFolder) model.enter(item) else model.openFile(item)
                } else Modifier).heightIn(min = 60.dp).padding(start = 16.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconTile(icon, tint)
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = Type.name)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            badge?.let { (label, tone) -> Badge(label, tone) }
                            if (detail.isNotEmpty()) Text(detail, style = Type.xs, color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (model.tab != Tab.Trash) {
                        val actions = !model.readOnly && item.backupRootId == null
                        if (item.isFolder) Icon(Lucide.ChevronRight, null, Modifier.padding(end = if (actions) 0.dp else 10.dp).size(16.dp), tint = t.text3)
                        if (actions) {
                            var menu by remember { mutableStateOf(false) }
                            Box {
                                HIconButton(Lucide.EllipsisVertical, "Actions for ${item.name}", { menu = true }, enabled = !model.busy)
                                HMenu(menu, { menu = false }) { HMenuItem("Move to trash", Lucide.Trash, { menu = false; confirm("trash", item) }, danger = true) }
                            }
                        }
                    }
                }
                if (model.tab == Tab.Trash) Row(Modifier.padding(start = 64.dp, end = 16.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HButton("Restore", { model.mutate(item, "restore") }, variant = Variant.Outline, small = true, icon = Lucide.RotateCcw, enabled = !model.busy)
                    HButton("Delete", { confirm("permanent", item) }, variant = Variant.DangerGhost, small = true, enabled = !model.busy)
                }
                Divider(Modifier.padding(horizontal = 16.dp))
            }
        }
        items(list.runs, key = { it.id }) { run ->
            Card(Modifier.padding(horizontal = 16.dp, vertical = 5.dp), padding = 14.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (run.trigger == "MANUAL") "Manual backup" else "Automatic backup", Modifier.weight(1f), style = Type.name)
                    Badge(stateLabel(run.state), stateTone(run.state))
                }
                Text(dateLabel(run.startedAt, time = true), Modifier.padding(top = 4.dp), style = Type.xs, color = theme.text2)
                Text("${run.fileCount} files • ${bytesLabel(run.sizeBytes)}", style = Type.xs, color = theme.text2)
                run.error?.let { Text(it, Modifier.padding(top = 6.dp), style = Type.sm, color = theme.dangerText) }
            }
        }
        if (list.loaded && !empty) item {
            val count = list.items.size + list.runs.size
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("$count ${if (list.runs.isNotEmpty()) "run" else "item"}${if (count == 1) "" else "s"}${if (list.cursor != null) " shown" else ""}", Modifier.weight(1f), style = Type.xs, color = t.text2)
                if (list.cursor != null) HButton("Load more", { model.refresh(more = true) }, variant = Variant.Outline, small = true, enabled = !list.loading)
            }
        }
    }
}
