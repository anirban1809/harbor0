package app.harbor0.android

import android.net.Uri
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException

/** The sync status line for this phone, shared by the Sync page and the card at the top of My Drive → Sync. */
@Composable fun SyncStatusCard(model: WorkspaceModel, compact: Boolean = false, modifier: Modifier = Modifier) {
    val sync = model.sync
    val runtime = sync.runtime
    val label = sync.label
    val shape = RoundedCornerShape(Radius.lg)
    Card(modifier.then(if (compact) Modifier.clip(shape).clickable(role = Role.Button) { model.navigate(Section.Sync) } else Modifier).testTag("sync-status")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IconBox(Lucide.Smartphone, 38.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(if (compact) "This phone" else "Sync on this phone", style = Type.h3)
                Text(syncDetail(model), style = Type.xs, color = theme.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            StatusPill(label, sync.tone(label))
            if (compact) Icon(Lucide.ChevronRight, null, Modifier.size(16.dp), tint = theme.text2)
        }
        runtime.active?.let { active ->
            Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("${if (active.direction == "upload") "Uploading" else "Downloading"} ${baseName(active.relativePath).ifEmpty { "folder" }}", style = Type.xs, color = theme.text2,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Progress(if (active.total > 0) active.loaded.toFloat() / active.total else null, height = 4.dp)
            }
        }
    }
}
private fun syncDetail(model: WorkspaceModel): String {
    val sync = model.sync
    val runtime = sync.runtime
    if (sync.view == null) return sync.startError?.let { "Sync starts when harbor0 can reach the server. $it" } ?: "Starting sync…"
    val folders = sync.syncRoots.size
    val parts = mutableListOf(if (folders == 0) "No folders yet" else plural(folders, "folder"))
    val queued = sync.jobs.count { j -> sync.syncRoots.any { it.id == j.rootId } }
    if (queued > 0) parts += "${plural(queued, "change")} queued"
    if (runtime.waiting.isNotEmpty()) parts += "${plural(runtime.waiting.size, "file")} waiting for another device"
    parts += runtime.lastSync?.let { "Checked ${ago(it)}" } ?: "Not checked yet"
    return parts.joinToString(" · ")
}

@Composable fun SyncScreen(model: WorkspaceModel) {
    val sync = model.sync
    val pickers = LocalPickers.current
    val t = theme
    Refreshable(false, { sync.refresh() }) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("sync-page").padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            PageTitle("Sync")
            Text("Keep folders on this phone in step with your other devices. Changes, including deletions, sync both ways and conflicting edits are preserved. harbor0 syncs while it is open, and in the background about every 15 minutes when Android allows.",
                style = Type.body.copy(lineHeight = 22.sp), color = t.text2)
            SyncStatusCard(model)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HButton("Sync a folder", { sync.setup(SyncSetup.New) }, Modifier.weight(1f).testTag("sync-add"), icon = Lucide.FolderPlus, enabled = sync.view != null && !model.busy)
                if (sync.view != null) HButton(if (sync.runtime.paused) "Resume" else "Pause", { sync.pauseAll(!sync.runtime.paused) }, variant = Variant.Outline,
                    icon = if (sync.runtime.paused) Lucide.Play else Lucide.Pause, enabled = !model.busy)
                HIconButton(Lucide.RefreshCw, "Sync now", { sync.refresh() }, enabled = sync.view != null)
            }
            if (sync.runtime.paused) Alert("Sync is paused. Changes are being queued and will continue when syncing resumes.", tone = Tone.Warning)
            else if (!sync.runtime.online) Alert("You’re offline. Changes will sync when the connection returns.", tone = Tone.Warning)
            val problems = sync.requirements
            if (problems.isNotEmpty()) Card {
                CardHeader("Needs attention", "Resolve these to keep your folders in sync.")
                IssueList(model, problems.take(6))
                if (problems.size > 6) HButton("Show all ${problems.size}", { model.overlay = Overlay.SyncIssues(null) }, variant = Variant.Link)
            }
            Section("On this phone") {
                val roots = sync.syncRoots
                if (roots.isEmpty()) EmptyState(Lucide.FolderSync, "No folders sync with this phone", "Choose a folder on this phone and a cloud folder. Its files stay the same on every linked device.", compact = true) {
                    HButton("Sync a folder", { sync.setup(SyncSetup.New) }, small = true, enabled = sync.view != null && !model.busy)
                }
                roots.forEachIndexed { index, root ->
                    if (index > 0) Divider()
                    val state = sync.state(root)
                    val (files, _) = sync.view?.counts?.get(root.id) ?: (0 to 0)
                    FolderRow(Lucide.Folder, root.localName, root.cloudPath ?: "Cloud folder", "${plural(files, "file")} · ${root.lastSyncedAt?.let { "Synced ${ago(it)}" } ?: "Not synced yet"}",
                        state, sync.tone(state), "sync-root-${root.localName}") { model.error = null; model.overlay = Overlay.SyncFolderMenu(root) }
                }
            }
            if (sync.runtime.waiting.isNotEmpty()) Section(WAITING) {
                Text("These older files are still held on another linked device. They download here once that device is online.", style = Type.sm, color = t.text2)
                sync.runtime.waiting.take(20).forEach { w ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Lucide.Clock, null, Modifier.size(16.dp), tint = t.text2)
                        Text(w.relativePath, style = Type.sm, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            val invitations = sync.receivedInvitations
            if (invitations.isNotEmpty() || sync.invitations.error != null) Section("Shared with you") {
                sync.invitations.error?.let { Alert(it, tone = Tone.Danger, action = "Retry") { sync.refresh() } }
                invitations.forEachIndexed { index, invitation ->
                    if (index > 0) Divider()
                    Column(Modifier.padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Lucide.Users, null, Modifier.size(18.dp), tint = t.text2)
                            Column(Modifier.weight(1f)) {
                                Text(invitation.name, style = Type.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("From ${invitation.owner.displayName} (@${invitation.owner.username}) · Two-way sync", style = Type.xs, color = t.text2)
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            HButton(if (invitation.syncState == "PENDING") "Accept invitation" else "Sync on this phone", { sync.setup(SyncSetup.Invite(invitation)) }, variant = Variant.Outline, small = true,
                                enabled = sync.view != null && !model.busy)
                            if (invitation.syncState == "PENDING") HButton("Decline", { sync.decline(invitation) }, variant = Variant.Ghost, small = true, enabled = !model.busy)
                        }
                    }
                }
            }
            val available = sync.available
            if (available.isNotEmpty()) Section("On your other devices") {
                available.forEachIndexed { index, folder ->
                    if (index > 0) Divider()
                    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Lucide.Folder, null, Modifier.size(18.dp), tint = t.text2)
                        Column(Modifier.weight(1f)) {
                            Text(folder.name, style = Type.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(folder.syncDevices.joinToString(", ") { it.name }.ifEmpty { "Not synced on any device right now" }, style = Type.xs, color = t.text2, maxLines = 2)
                        }
                        HButton("Sync here", { sync.setup(SyncSetup.Remote(folder)) }, variant = Variant.Outline, small = true, icon = Lucide.Plus, enabled = sync.view != null && !model.busy)
                    }
                }
            }
            if (sync.runtime.recent.isNotEmpty()) Section("Recent activity") {
                sync.runtime.recent.take(10).forEach { a ->
                    val root = sync.roots.firstOrNull { it.id == a.rootId }
                    Row(Modifier.padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (a.direction == "upload") Lucide.CloudUpload else Lucide.Download, null, Modifier.size(16.dp), tint = t.text2)
                        Column(Modifier.weight(1f)) {
                            Text(baseName(a.relativePath), style = Type.sm, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${if (a.direction == "upload") "Uploaded from" else "Downloaded to"} ${root?.localName ?: "this phone"} · ${ago(a.at)}", style = Type.xs, color = t.text2, maxLines = 1)
                        }
                    }
                }
            }
            val backups = sync.backupRoots
            Section("Backups from this phone") {
                Text(if (backups.isEmpty()) "Save earlier versions of a folder on this phone. A new version is saved about an hour after you stop editing a file."
                    else "${plural(backups.size, "folder")} backed up from this phone. Manage them in Backups.", style = Type.sm, color = t.text2)
                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HButton("Back up a folder", { pickers.chooseFolder { sync.backUpFolder(it) } }, variant = Variant.Outline, small = true, icon = Lucide.Archive, enabled = sync.view != null && !model.busy)
                    if (backups.isNotEmpty()) HButton("Open Backups", { model.navigate(Section.Backups) }, variant = Variant.Ghost, small = true)
                }
            }
        }
    }
}

@Composable private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = Type.h3)
        Card(padding = 12.dp, content = content)
    }
}
@Composable private fun FolderRow(icon: ImageVector, title: String, subtitle: String, meta: String, status: String, tone: Tone, tag: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md)).clickable(role = Role.Button, onClick = onClick).padding(vertical = 10.dp).testTag(tag),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(18.dp), tint = theme.text2)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = Type.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = Type.xs, color = theme.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(meta, style = Type.xs, color = theme.text2, maxLines = 1)
        }
        StatusPill(status, tone)
        Icon(Lucide.ChevronRight, null, Modifier.size(16.dp), tint = theme.text2)
    }
}

@Composable private fun IssueList(model: WorkspaceModel, issues: List<SyncIssue>) {
    val sync = model.sync
    issues.forEachIndexed { index, issue ->
        if (index > 0) Divider()
        val root = sync.roots.firstOrNull { it.id == issue.rootId }
        Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(if (stickyIssue(issue)) Lucide.Info else Lucide.CircleAlert, null, Modifier.padding(top = 2.dp).size(16.dp),
                    tint = if (stickyIssue(issue)) theme.text2 else theme.dangerText)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(when (issue.code) { IssueCode.CONFLICT -> "Conflict"; IssueCode.FOLDER_RECOVERED -> "Folder kept on this phone"; else -> root?.localName ?: "Sync" },
                        style = Type.label)
                    Text(issueText(issue), style = Type.sm, color = theme.text2)
                    (issue.conflictPath ?: issue.relativePath)?.let { Text(listOfNotNull(root?.localName, it).joinToString(" / "), style = Type.xs, color = theme.text3, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    if (issue.code == IssueCode.SYNC_ERROR && issue.message.isNotBlank() && issueText(issue) != issue.message) Text(issue.message, style = Type.xs, color = theme.text2)
                }
            }
            Row(Modifier.padding(start = 26.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (stickyIssue(issue)) HButton("Mark reviewed", { sync.dismiss(issue) }, variant = Variant.Outline, small = true, enabled = !model.busy)
                issue.jobId?.let { job -> HButton("Retry", { sync.retry(job) }, variant = Variant.Outline, small = true, icon = Lucide.RotateCcw, enabled = !model.busy) }
                if (root != null && issue.code in listOf(IssueCode.FOLDER_MISSING, IssueCode.PERMISSION_DENIED, IssueCode.MAPPING_REQUIRED) && issue.scope == null)
                    HButton(if (issue.code == IssueCode.MAPPING_REQUIRED) "Finish setup" else "Locate folder", { sync.setup(SyncSetup.ChangeLocal(root)) }, variant = Variant.Outline, small = true)
                if (issue.code == IssueCode.STORAGE_QUOTA_EXCEEDED) HButton("Manage storage", { model.navigate(Section.Storage) }, variant = Variant.Outline, small = true)
            }
        }
    }
}

@Composable fun SyncIssuesSheet(model: WorkspaceModel, root: SyncRoot?) {
    val problems = (if (root?.mode == "backup") model.sync.runtime.issues else model.sync.requirements).filter { root == null || it.rootId == root.id }
    HSheet({ model.overlay = null }, if (root == null) "Needs attention" else "${root.localName}: needs attention", tall = problems.size > 4) {
        if (problems.isEmpty()) Text("Nothing needs your attention in this folder any more.", style = Type.sm, color = theme.text2)
        IssueList(model, problems)
    }
}

/** Choose a local folder (and for a new folder, its cloud location), then start syncing. */
@Composable fun SyncSetupSheet(model: WorkspaceModel, kind: SyncSetup) {
    val sync = model.sync
    val pickers = LocalPickers.current
    var local by remember { mutableStateOf<Uri?>(null) }
    var localName by remember { mutableStateOf<String?>(null) }
    var choose by remember { mutableStateOf(false) }
    var trail by remember { mutableStateOf<List<DriveItem>>(emptyList()) }
    var folders by remember { mutableStateOf<List<DriveItem>?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var newName by remember { mutableStateOf("") }
    val context = model.context
    LaunchedEffect(choose, trail) {
        if (!choose) return@LaunchedEffect
        folders = null; failure = null
        try { folders = sync.cloudFolders(trail.lastOrNull()?.id) } catch (e: CancellationException) { throw e } catch (e: Exception) { failure = model.message(e) }
    }
    val (title, description) = when (kind) {
        SyncSetup.New -> "Sync a folder" to "Choose a folder on this phone. Its files are kept in the cloud, and every linked device downloads changes from there."
        is SyncSetup.Remote -> "Sync “${kind.folder.name}” to this phone" to "Choose where this folder lives on this phone. Its files download from the cloud."
        is SyncSetup.Invite -> "Sync “${kind.invitation.name}”" to "Shared by ${kind.invitation.owner.displayName.ifBlank { "@" + kind.invitation.owner.username }}. Both of you can edit these files."
        is SyncSetup.ChangeLocal -> "Change local folder" to "Choose where “${kind.root.localName}” lives on this phone. It is checked again before ${if (kind.root.mode == "backup") "backups resume" else "syncing resumes"}."
    }
    val cloud: CloudChoice? = when {
        kind != SyncSetup.New || !choose -> CloudChoice.Automatic
        newName.isNotBlank() -> if (runCatching { safeName(newName.trim()) }.isSuccess) CloudChoice.NewIn(trail.lastOrNull()?.id, newName.trim()) else null
        trail.isNotEmpty() -> CloudChoice.Existing(trail.last().id)
        else -> null
    }
    val pending = kind is SyncSetup.Invite && kind.invitation.syncState == "PENDING"
    HSheet({ model.overlay = null }, title, description, tall = choose, footer = {
        HButton(if (model.busy) "Starting…" else when (kind) { is SyncSetup.ChangeLocal -> "Use folder and resume"; is SyncSetup.Invite -> if (pending) "Accept and start syncing" else "Start syncing"; else -> "Start syncing" },
            { sync.start(kind, local, cloud ?: return@HButton) }, Modifier.fillMaxWidth().testTag("sync-start"), enabled = local != null && cloud != null && !model.busy)
        if (pending && kind is SyncSetup.Invite) HButton("Decline", { sync.decline(kind.invitation) }, Modifier.fillMaxWidth(), Variant.Outline, enabled = !model.busy)
        HButton("Cancel", { model.overlay = null }, Modifier.fillMaxWidth(), Variant.Outline, enabled = !model.busy)
    }) {
        Field("Local folder") {
            val shape = RoundedCornerShape(Radius.lg)
            Row(Modifier.fillMaxWidth().clip(shape).border(1.dp, theme.line, shape).padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Lucide.Smartphone, null, Modifier.size(18.dp), tint = theme.text2)
                Text(localName ?: "Choose a folder on this phone", Modifier.weight(1f), style = Type.sm, color = if (localName == null) theme.text2 else theme.text, maxLines = 2)
                HButton(if (local == null) "Choose" else "Change", {
                    pickers.chooseFolder { uri -> local = uri; localName = runCatching { SafTree(context, uri).name }.getOrNull() ?: uri.lastPathSegment }
                }, variant = Variant.Outline, small = true, enabled = !model.busy)
            }
        }
        if (kind == SyncSetup.New) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Cloud folder", style = Type.label)
            Choice("Create a new folder in My Drive", "Named after the local folder. If that name is taken, a number is added.", !choose) { choose = false }
            Choice("Choose a cloud folder", "Pick a folder in My Drive, or create one inside it.", choose) { choose = true }
            if (choose) {
                Breadcrumbs(listOf("My Drive") + trail.map { it.name }) { trail = trail.take(it) }
                when {
                    failure != null -> Alert(failure!!, tone = Tone.Danger, action = "Retry") { trail = trail.toList() }
                    folders == null -> Text("Loading folders…", style = Type.sm, color = theme.text2)
                    folders!!.isEmpty() -> Text("No subfolders here.", style = Type.sm, color = theme.text2)
                    else -> folders!!.forEach { folder ->
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md)).clickable(role = Role.Button) { trail = trail + folder }.heightIn(min = 44.dp).padding(horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Icon(if (folder.id in model.drive.syncIds) Lucide.FolderSync else Lucide.Folder, null, Modifier.size(18.dp), tint = theme.accentText)
                            Text(folder.name, Modifier.weight(1f), style = Type.body, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Icon(Lucide.ChevronRight, null, Modifier.size(16.dp), tint = theme.text3)
                        }
                    }
                }
                Field("New folder here (optional)", hint = if (trail.isEmpty() && newName.isBlank()) "Open a folder to sync it, or name a new folder to create in My Drive." else null) {
                    HInput(newName, { newName = it.take(200) }, placeholder = "Folder name", invalid = newName.isNotBlank() && runCatching { safeName(newName.trim()) }.isFailure)
                }
                Text("Syncs with: ${if (newName.isNotBlank()) (listOf("My Drive") + trail.map { it.name } + newName.trim()).joinToString(" / ") else if (trail.isEmpty()) "Choose a folder" else (listOf("My Drive") + trail.map { it.name }).joinToString(" / ")}",
                    style = Type.xs, color = theme.text2)
            }
        }
        Text(when (kind) {
            is SyncSetup.Remote -> "Choose an empty folder, or one that already holds a copy of these files. Anything else in it will sync to your other devices. "
            is SyncSetup.Invite -> "Files already in the local folder will be shared too. Use an empty folder to start with the owner’s files. "
            else -> ""
        } + if (kind is SyncSetup.ChangeLocal) "harbor0 compares the new folder with the cloud before changing anything. Nothing is deleted."
            else "Changes, including deletions, sync between linked devices. Synced files are kept in the cloud, and every device downloads changes from there. Conflicting versions are preserved.",
            style = Type.xs, color = theme.text2)
        model.error?.let { Alert(it, tone = Tone.Danger) }
    }
}

/** One sync folder's details and actions. */
@Composable fun SyncFolderMenu(model: WorkspaceModel, root: SyncRoot) {
    val sync = model.sync
    val current = sync.roots.firstOrNull { it.id == root.id } ?: root
    val state = sync.state(current)
    val (files, folders) = sync.view?.counts?.get(root.id) ?: (0 to 0)
    val owned = current.shareId == null
    fun go(action: () -> Unit) { model.overlay = null; action() }
    HSheet({ model.overlay = null }, current.localName, current.cloudPath) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { StatusPill(state, sync.tone(state)) }
        DetailRows(listOf("This phone" to current.localName, "Cloud" to (current.cloudPath ?: "Cloud folder"),
            "Tracked" to "${plural(files, "file")} · ${plural(folders, "folder")}", "Last synced" to (current.lastSyncedAt?.let { fullDate(it) } ?: "Not synced yet"),
            "Excluded" to (current.excluded.joinToString(", ").ifEmpty { "Nothing" })))
        Column {
            if (sync.requirements.any { it.rootId == root.id }) HMenuItem("Show what needs attention", Lucide.CircleAlert, { model.overlay = Overlay.SyncIssues(current) })
            HMenuItem(if (current.paused) "Resume folder sync" else "Pause folder sync", if (current.paused) Lucide.Play else Lucide.Pause, { go { sync.togglePause(current) } }, enabled = !model.busy)
            HMenuItem("Manage exclusions", Lucide.EyeOff, { model.overlay = Overlay.SyncExclusions(current) })
            HMenuItem("Change local folder", Lucide.FolderOpen, { sync.setup(SyncSetup.ChangeLocal(current)) })
            if (owned) HMenuItem("Share with another account", Lucide.UserPlus, { model.error = null; model.overlay = Overlay.SyncShare(current) })
            HMenuSeparator()
            HMenuItem("Stop syncing on this phone", Lucide.Unplug, { sync.stopHere(current) }, enabled = !model.busy)
            if (owned && current.remoteId != null) HMenuItem("Remove from sync everywhere", Lucide.X, { sync.removeEverywhere(current.remoteId, current.localName) }, danger = true, enabled = !model.busy)
        }
    }
}

/** A multi-line text field in the kit's input style. */
@Composable fun HTextArea(value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier, placeholder: String = "") {
    val t = theme
    val shape = RoundedCornerShape(Radius.md)
    BasicTextField(value, onChange, modifier.fillMaxWidth(), textStyle = Type.mono.copy(fontSize = 14.sp, color = t.text), cursorBrush = SolidColor(t.primary), minLines = 4) { inner ->
        Box(Modifier.fillMaxWidth().border(1.dp, t.line, shape).padding(12.dp)) {
            if (value.isEmpty()) Text(placeholder, style = Type.mono.copy(fontSize = 14.sp), color = t.text3)
            inner()
        }
    }
}

@Composable fun SyncExclusionsSheet(model: WorkspaceModel, root: SyncRoot) {
    var text by remember { mutableStateOf(root.excluded.joinToString("\n")) }
    val entries = text.lines().map { it.trim().trim('/') }.filter { it.isNotEmpty() }
    val valid = entries.all(::validRelative)
    HDialog("Manage exclusions", { model.overlay = null }, "Folders inside “${root.localName}” that should not ${if (root.mode == "backup") "be backed up" else "sync"}, one per line, like Photos/Old. Excluded files stay where they are.", actions = {
        HButton(if (model.busy) "Saving…" else "Save exclusions", { model.sync.saveExclusions(root, text) }, Modifier.fillMaxWidth(), enabled = valid && !model.busy)
        HButton("Cancel", { model.overlay = null }, Modifier.fillMaxWidth(), Variant.Outline)
    }) {
        HTextArea(text, { text = it }, Modifier.testTag("exclusions"), placeholder = "Relative folders to exclude, one per line")
        if (!valid) Text("Use paths inside this folder, without “..”.", style = Type.xs, color = theme.dangerText)
        model.error?.let { Alert(it, tone = Tone.Danger) }
    }
}

@Composable fun SyncShareSheet(model: WorkspaceModel, root: SyncRoot) {
    val sync = model.sync
    var recipient by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { sync.refresh(wake = false) }
    HSheet({ model.overlay = null }, "Share “${root.localName}”", "Everyone you invite can add, edit, rename, and delete files. Changes sync across linked devices. Only you can manage access.",
        footer = { HButton("Done", { model.overlay = null }, Modifier.fillMaxWidth(), Variant.Outline) }) {
        Field("Email or username", hint = "Invite an existing harbor0 account. Shared files use your storage allowance while waiting for delivery.") {
            HInput(recipient, { recipient = it.take(254) }, Modifier.testTag("sync-share-recipient"), placeholder = "name@example.com or username")
        }
        HButton(if (model.busy) "Please wait…" else "Send invitation", { sync.invite(root, recipient); recipient = "" }, Modifier.fillMaxWidth(),
            enabled = recipient.trim().removePrefix("@").length >= 3 && !model.busy)
        model.error?.let { Alert(it, tone = Tone.Danger) }
        Text("People with access", style = Type.h3)
        val members = sync.members(root)
        when {
            sync.invitations.data == null -> Text("Loading access…", style = Type.sm, color = theme.text2)
            members.isEmpty() -> Text("No invitations yet.", style = Type.sm, color = theme.text2)
            else -> members.forEach { member ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Avatar(member.recipient.displayName.ifBlank { member.recipient.username }, 32.dp)
                    Column(Modifier.weight(1f)) {
                        Text(member.recipient.displayName.ifBlank { "@" + member.recipient.username }, style = Type.name, maxLines = 1)
                        Text("@${member.recipient.username} · ${if (member.syncState == "PENDING") "Invited" else "Can edit and sync"}", style = Type.xs, color = theme.text2)
                    }
                    HButton("Remove", { sync.removeMember(member) }, variant = Variant.Outline, small = true, enabled = !model.busy)
                }
            }
        }
    }
}
