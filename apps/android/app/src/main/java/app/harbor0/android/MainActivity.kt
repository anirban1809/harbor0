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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import java.io.File

class MainActivity: ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val model: WorkspaceModel = viewModel()
            HarborTheme(model.appearance) {
                val light = ink(MaterialTheme.colorScheme.background) == androidx.compose.ui.graphics.Color.Black
                SideEffect { WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light } }
                HarborApp(model)
            }
        }
    }
}
fun tabIcon(tab: Tab): ImageVector = when (tab) {
    Tab.Drive -> Icons.Outlined.Storage
    Tab.Sync -> Icons.Outlined.Sync
    Tab.Backups -> Icons.Outlined.History
    Tab.Trash -> Icons.Outlined.DeleteOutline
    Tab.Settings -> Icons.Outlined.Settings
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun HarborApp(model: WorkspaceModel) {
    val context = LocalContext.current
    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(model::upload) }
    var fileToSave by remember { mutableStateOf<File?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri != null) fileToSave?.let { model.saveDownload(uri, it) }; fileToSave = null
    }
    var newFolder by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<Pair<String, DriveItem?>?>(null) }
    var addMenu by remember { mutableStateOf(false) }
    LaunchedEffect(model.signedIn) { if (!model.signedIn) { newFolder = false; confirm = null; addMenu = false } }
    BackHandler(model.signedIn && (model.path.isNotEmpty() || model.history)) { model.back() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when {
            model.restoring -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) { CircularProgressIndicator(); Text("Opening harbor0…") }
            }
            !model.signedIn -> SignIn(model)
            else -> Scaffold(containerColor = MaterialTheme.colorScheme.background,
                topBar = {
                    TopAppBar(title = { Text(model.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold) },
                        navigationIcon = { if (model.path.isNotEmpty() || model.history) IconButton(onClick = model::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                        actions = {
                            if (model.currentBackup != null && !model.history) IconButton(onClick = model::showHistory) { Icon(Icons.Outlined.History, "Backup history") }
                            IconButton(onClick = { model.refresh() }, enabled = !model.listing.loading) { Icon(Icons.Outlined.Refresh, "Refresh") }
                            if (model.canWrite) Box {
                                IconButton(onClick = { addMenu = true }, enabled = !model.busy && model.transfer == null) { Icon(Icons.Outlined.Add, "Add files or folder") }
                                DropdownMenu(addMenu, { addMenu = false }) {
                                    DropdownMenuItem(text = { Text("Upload file") }, onClick = { addMenu = false; upload.launch(arrayOf("*/*")) })
                                    DropdownMenuItem(text = { Text("New folder") }, onClick = { addMenu = false; newFolder = true })
                                }
                            }
                            if (model.tab == Tab.Trash) IconButton(onClick = { confirm = "empty" to null }, enabled = model.listing.items.isNotEmpty() && !model.busy) { Icon(Icons.Outlined.DeleteSweep, "Empty trash") }
                        })
                },
                bottomBar = {
                    Column {
                        model.transfer?.let { state ->
                            Surface(tonalElevation = 2.dp) {
                                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(state.label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        TextButton(onClick = model::cancelTransfer) { Text("Cancel") }
                                    }
                                    if (state.fraction == null) LinearProgressIndicator(Modifier.fillMaxWidth()) else LinearProgressIndicator(progress = { state.fraction }, modifier = Modifier.fillMaxWidth())
                                    Text("Keep harbor0 open until the transfer finishes.", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(vertical = 6.dp))
                                }
                            }
                        }
                        NavigationBar(containerColor = LocalNavigationColor.current) {
                            Tab.entries.forEach { tab -> NavigationBarItem(selected = model.tab == tab, onClick = { model.select(tab) },
                                icon = { Icon(tabIcon(tab), null) }, label = { Text(tab.label, maxLines = 1, fontSize = 11.sp) },
                                modifier = Modifier.testTag("tab-${tab.name}"),
                                colors = NavigationBarItemDefaults.colors(unselectedIconColor = ink(LocalNavigationColor.current), unselectedTextColor = ink(LocalNavigationColor.current))) }
                        }
                    }
                }) { padding ->
                Column(Modifier.padding(padding).fillMaxSize()) {
                    if (model.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                    model.error?.let { Banner(it, "Dismiss") { model.error = null } }
                    model.message?.let { Banner(it, "Dismiss") { model.message = null } }
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                        if (model.tab == Tab.Settings) Settings(model) { confirm = "logout" to null }
                        else PullToRefreshBox(isRefreshing = model.listing.loading, onRefresh = { model.refresh() }, modifier = Modifier.widthIn(max = 840.dp).fillMaxSize()) {
                            FileListing(model) { action, item -> confirm = action to item }
                        }
                    }
                }
            }
        }
    }
    if (newFolder) {
        var name by rememberSaveable { mutableStateOf("") }
        AlertDialog(onDismissRequest = { newFolder = false }, title = { Text("New folder") },
            text = { OutlinedTextField(name, { name = it }, label = { Text("Folder name") }, singleLine = true, modifier = Modifier.testTag("folder-name")) },
            confirmButton = { TextButton(onClick = { newFolder = false; model.createFolder(name) }, enabled = runCatching { safeName(name.trim()) }.isSuccess) { Text("Create folder") } },
            dismissButton = { TextButton(onClick = { newFolder = false }) { Text("Cancel") } })
    }
    confirm?.let { (action, item) ->
        val title = when (action) { "empty" -> "Empty trash?"; "permanent" -> "Delete permanently?"; "logout" -> "Sign out?"; else -> "Move to trash?" }
        val detail = when (action) {
            "empty" -> "All items in your trash will be permanently deleted. This cannot be undone."
            "permanent" -> "${item?.name} will be permanently deleted. This cannot be undone."
            "logout" -> "Your session on this device will be revoked."
            else -> "${item?.name} will move to Trash, where you can restore it."
        }
        AlertDialog(onDismissRequest = { confirm = null }, title = { Text(title) }, text = { Text(detail) },
            confirmButton = { TextButton(onClick = {
                confirm = null
                when (action) { "empty" -> model.emptyTrash(); "logout" -> model.logout(); else -> item?.let { model.mutate(it, action) } }
            }) { Text(when (action) { "empty" -> "Empty trash"; "permanent" -> "Delete permanently"; "logout" -> "Sign out"; else -> "Move to trash" }) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } })
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
        AlertDialog(onDismissRequest = { model.preview = null }, title = { Text(preview.file.name) },
            text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Outlined.TaskAlt, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp))
                Text("Download verified. Open it in another app or save a copy on your device.")
                OutlinedButton(onClick = { launchFile(false) }, modifier = Modifier.fillMaxWidth()) { Text("Open file") }
                OutlinedButton(onClick = { launchFile(true) }, modifier = Modifier.fillMaxWidth()) { Text("Share file") }
                OutlinedButton(onClick = { fileToSave = preview.file; save.launch(preview.file.name) }, modifier = Modifier.fillMaxWidth()) { Text("Save to device") }
            } }, confirmButton = { TextButton(onClick = { model.preview = null }) { Text("Done") } })
    }
}

@Composable fun Banner(text: String, action: String, onClick: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, Modifier.weight(1f).padding(vertical = 10.dp), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = onClick) { Text(action) }
        }
    }
}
@Composable fun SignIn(model: WorkspaceModel) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val context = LocalContext.current
    Box(Modifier.fillMaxSize().safeDrawingPadding().imePadding(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Spacer(Modifier.height(36.dp))
            Icon(painterResource(R.drawable.ic_harbor), null, Modifier.size(56.dp))
            Text("harbor0", fontSize = 40.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1.5).sp)
            Text("Your files, within reach.", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onBackground.copy(alpha = .65f))
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth().testTag("email"))
            OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth().testTag("password"))
            model.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            Button(onClick = { model.login(email, password) }, enabled = !model.busy && email.isNotBlank() && password.isNotEmpty(),
                shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("sign-in")) { Text(if (model.busy) "Signing in…" else "Sign in") }
            if (model.api.canRestore) {
                TextButton(onClick = model::restore, enabled = !model.busy) { Text("Retry saved sign-in") }
                TextButton(onClick = model::forget, enabled = !model.busy) { Text("Remove saved sign-in from this device") }
            }
            TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, UriForSignup)) }, modifier = Modifier.fillMaxWidth()) { Text("Create an account on harbor0") }
        }
    }
}
private val UriForSignup = android.net.Uri.parse("https://d1bpha1d51nhxy.cloudfront.net/signup")

@Composable fun FileListing(model: WorkspaceModel, confirm: (String, DriveItem) -> Unit) {
    val list = model.listing
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        item {
            val notice = when {
                model.history -> model.currentBackup?.localPathDisplayName.orEmpty()
                model.readOnly -> "Browse saved files. Automatic backups are managed on the source computer."
                model.tab == Tab.Sync -> "Folders linked to your computers. Automatic sync runs on the desktop app."
                model.tab == Tab.Trash -> "Restore files or delete them permanently."
                else -> if (model.folder == null) "Cloud files" else model.path.joinToString(" / ") { it.name }
            }
            Text(notice, color = MaterialTheme.colorScheme.onBackground.copy(alpha = .65f), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 20.dp))
        }
        list.error?.let { item { Banner(it, "Try again") { model.refresh() } } }
        if (list.loaded && list.items.isEmpty() && list.runs.isEmpty()) item {
            Column(Modifier.fillMaxWidth().padding(vertical = 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(tabIcon(model.tab), null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onBackground.copy(alpha = .5f))
                Text(when { model.history -> "No backup history"; model.tab == Tab.Trash -> "Trash is empty"; else -> "No files here yet" }, style = MaterialTheme.typography.titleMedium)
                Text(when { model.canWrite -> "Use + to upload a file or create a folder."; model.tab == Tab.Trash -> "Removed files will appear here."; else -> "Add a folder in harbor0 on your computer." }, style = MaterialTheme.typography.bodySmall)
            }
        }
        items(list.items, key = { it.id }) { item ->
            val sync = model.statuses[item.id]
            val backup = model.backups.firstOrNull { it.remoteRootDriveItemId == item.id }
            val detail = when {
                model.tab == Tab.Trash -> "Deleted ${item.deletedAt?.take(10).orEmpty()}"
                backup != null -> "${backup.deviceName ?: "Source computer"} • ${backup.state.lowercase().replaceFirstChar { it.uppercase() }}"
                sync != null -> "${sync.label} • ${sync.confirmedDevices}/${sync.requiredDevices} devices"
                item.cloudState == "RELEASED" -> "On your computer • Request a copy"
                item.cloudState == "REQUESTED" -> "Waiting for your computer"
                item.isFolder -> "Folder"
                else -> bytesLabel(item.sizeBytes)
            }
            Surface(shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surface) {
                Column {
                    Row(Modifier.fillMaxWidth().then(if (model.tab != Tab.Trash) Modifier.clickable(enabled = model.transfer == null && item.cloudState != "REQUESTED") {
                        if (item.isFolder) model.enter(item) else model.openFile(item)
                    } else Modifier).padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (item.isFolder) Icons.Outlined.Folder else Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.primary)
                        Column(Modifier.weight(1f).padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (model.tab != Tab.Trash) {
                            if (item.isFolder) Icon(Icons.Outlined.ChevronRight, null, Modifier.padding(end = 12.dp))
                            if (!model.readOnly && item.backupRootId == null) {
                                var menu by remember { mutableStateOf(false) }
                                Box {
                                    IconButton(onClick = { menu = true }, enabled = !model.busy) { Icon(Icons.Outlined.MoreVert, "Actions for ${item.name}") }
                                    DropdownMenu(menu, { menu = false }) { DropdownMenuItem(text = { Text("Move to trash") }, onClick = { menu = false; confirm("trash", item) }) }
                                }
                            }
                        }
                    }
                    if (model.tab == Tab.Trash) Row(Modifier.fillMaxWidth().padding(start = 48.dp, end = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(onClick = { model.mutate(item, "restore") }, enabled = !model.busy) { Text("Restore") }
                        TextButton(onClick = { confirm("permanent", item) }, enabled = !model.busy) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
            }
        }
        items(list.runs, key = { it.id }) { run ->
            Surface(shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (run.trigger == "MANUAL") "Manual backup" else "Automatic backup", fontWeight = FontWeight.SemiBold)
                    Text(run.state.lowercase().replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.labelMedium)
                    Text(run.startedAt.replace('T', ' ').take(16), style = MaterialTheme.typography.bodySmall)
                    Text("${run.fileCount} files • ${bytesLabel(run.sizeBytes)}", style = MaterialTheme.typography.bodySmall)
                    run.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        if (list.cursor != null) item { TextButton(onClick = { model.refresh(more = true) }, enabled = !list.loading, modifier = Modifier.fillMaxWidth()) { Text("Load more") } }
        item { Spacer(Modifier.height(16.dp)) }
    }
}
