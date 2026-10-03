package app.harbor0.android

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private fun statusIcon(tone: Tone, label: String): ImageVector = when {
    label == "Archived" -> Lucide.Archive
    label == "Paused" -> Lucide.Pause
    label == "Stopped" -> Lucide.X
    tone == Tone.Success -> Lucide.CircleCheck
    tone == Tone.Accent -> Lucide.LoaderCircle
    else -> Lucide.CircleAlert
}
/** A backup status pill with its icon, as the web `StatusBadge`. */
@Composable fun StatusPill(label: String, tone: Tone) {
    val t = theme
    val (fill, ink) = when (tone) { Tone.Success -> t.successSoft to t.successText; Tone.Accent -> t.accentSoft to t.accentText; Tone.Danger -> t.dangerSoft to t.dangerText; else -> t.fill2 to t.text2 }
    Row(Modifier.clip(RoundedCornerShape(50)).background(fill).padding(horizontal = 9.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(statusIcon(tone, label), null, Modifier.size(13.dp), tint = ink)
        Text(label, style = Type.xs.copy(fontSize = 13.sp, fontWeight = FontWeight(500)), color = ink, maxLines = 1)
    }
}

@Composable fun BackupsScreen(model: WorkspaceModel) {
    val backups = model.backups
    val t = theme
    val pickers = LocalPickers.current
    val addFolder = { pickers.chooseFolder { model.sync.backUpFolder(it) } }
    Refreshable(false, { backups.refresh() }) {
        LazyColumn(Modifier.fillMaxSize().testTag("backups-list"), state = remember(model.epoch, model.backups.rootId) { androidx.compose.foundation.lazy.LazyListState() }, contentPadding = PaddingValues(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val root = backups.root
            if (root == null) {
                item {
                    PageTitle("Backups")
                    Text("harbor0 keeps earlier versions of every file in these folders. A new version is saved about an hour after you stop editing a file, so you can always go back.",
                        Modifier.padding(top = 10.dp), style = Type.body.copy(lineHeight = 22.sp), color = t.text2)
                    HButton("Back up a folder", addFolder, Modifier.padding(top = 12.dp).testTag("backup-add"), icon = Lucide.FolderPlus, small = true,
                        enabled = model.sync.view != null && !model.busy)
                }
                backups.loadError?.let { item { Alert(it, tone = Tone.Danger, action = "Try again") { backups.refresh() } } }
                when {
                    !backups.loaded -> item { Text("Loading backup folders…", style = Type.sm, color = t.text2) }
                    backups.roots.isEmpty() -> item {
                        EmptyState(Lucide.Archive, "Back up a folder", "Choose a folder on this phone, or add one from the harbor0 desktop app on your computer. Saved versions will then appear here.") {
                            HButton("Choose a folder", addFolder, small = true, enabled = model.sync.view != null && !model.busy)
                        }
                    }
                    else -> {
                        if (backups.roots.size >= 7) item { HInput(backups.filter, { backups.filter = it }, placeholder = "Filter ${backups.roots.size} folders") }
                        val needle = backups.filter.trim().lowercase().takeIf { backups.roots.size >= 7 }.orEmpty()
                        val shown = backups.roots.filter { needle.isEmpty() || "${it.localPathDisplayName} ${it.deviceName.orEmpty()}".lowercase().contains(needle) }
                        if (shown.isEmpty()) item { Text("No folders match.", style = Type.sm, color = t.text2) }
                        items(shown, key = { it.id }) { r ->
                            val (label, tone) = backups.rootStatus(r)
                            val shape = RoundedCornerShape(Radius.lg)
                            Row(Modifier.fillMaxWidth().clip(shape).border(1.dp, t.line, shape).clickable(role = Role.Button) { backups.open(r.id) }
                                .padding(start = 14.dp, end = 12.dp, top = 12.dp, bottom = 12.dp).testTag("backup-${r.localPathDisplayName}"),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Icon(Lucide.Folder, null, Modifier.size(18.dp), tint = t.text2)
                                Column(Modifier.weight(1f)) {
                                    Text(r.localPathDisplayName, style = Type.h3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(if (model.sync.localBackup(r) != null) "This phone" else r.deviceName ?: "Another computer", style = Type.sm.copy(fontSize = 14.sp), color = t.text2, maxLines = 1)
                                }
                                StatusPill(label, tone)
                                Icon(Lucide.ChevronRight, null, Modifier.size(16.dp), tint = t.text2)
                            }
                        }
                    }
                }
            } else backupDetail(model, root)
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.backupDetail(model: WorkspaceModel, root: BackupRoot) {
    val backups = model.backups
    item { HButton("All backup folders", backups::close, variant = Variant.Ghost, small = true, icon = Lucide.ArrowLeft) }
    item {
        val (label, tone, detail) = backups.status()
        Card {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                IconBox(Lucide.Folder, 40.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(root.localPathDisplayName, style = Type.h2)
                    StatusPill(label, tone)
                    Text("${if (model.sync.localBackup(root) != null) "This phone" else root.deviceName ?: "Another computer"} · $detail", style = Type.sm, color = theme.text2)
                }
            }
            Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val local = model.sync.localBackup(root)
                if (backups.removed) HButton("Remove from Backups", backups::remove, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.Trash, enabled = !model.busy)
                else if (local != null) LocalBackupControls(model, local)
                else {
                    Text(if (backups.archived) "To restore this folder, open the desktop app on ${backups.deviceName}."
                        else "To back up now, pause or archive, open the desktop app on ${backups.deviceName}.", style = Type.xs, color = theme.text2)
                    HButton("Stop backing up", backups::stop, Modifier.fillMaxWidth(), Variant.DangerGhost, enabled = !model.busy)
                }
            }
        }
    }
    item {
        val waiting = backups.restores.count { it.state == "PENDING" }
        Segmented(listOf("Files" to "Files & versions", "History" to if (waiting > 0) "History · $waiting waiting" else "History"), backups.tab, { backups.tab = it }, Modifier.fillMaxWidth())
    }
    if (backups.tab == "Files") {
        if (backups.trail.isNotEmpty()) item {
            Breadcrumbs(listOf(root.localPathDisplayName) + backups.trail.map { it.name }) { depth -> backups.openFolder(backups.trail.take(depth)) }
        }
        val files = backups.items
        when {
            files == null -> item { SkeletonRows() }
            files.isEmpty() -> item {
                Text(if (backups.trail.isNotEmpty()) "This folder has no backed-up files." else "Nothing backed up yet. Files appear here after their first backup.",
                    Modifier.padding(vertical = 16.dp), style = Type.sm, color = theme.text2)
            }
            else -> items(files, key = { it.id }) { item ->
                Column {
                    Row(Modifier.fillMaxWidth().height(64.dp).clickable(role = Role.Button) {
                        if (item.isFolder) backups.openFolder(backups.trail + item) else { model.error = null; model.overlay = Overlay.BackupFile(item) }
                    }.testTag("file-${item.name}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        FileTile(item)
                        Column(Modifier.weight(1f)) {
                            Text(item.name, style = Type.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(meta(item), style = Type.xs, color = theme.text2)
                        }
                        if (item.isFolder) Icon(Lucide.ChevronRight, null, Modifier.size(16.dp), tint = theme.text3)
                    }
                    Divider()
                }
            }
        }
    } else {
        if (backups.restores.isNotEmpty()) {
            item { Text("Restores", Modifier.padding(top = 6.dp), style = Type.h3) }
            items(backups.restores, key = { "restore-" + it.id }) { r ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(Lucide.RotateCcw, null, Modifier.padding(top = 2.dp).size(18.dp), tint = theme.text2)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(r.relativePath, style = Type.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("Requested ${dateLabel(r.requestedAt, time = true)}${r.completedAt?.let { " · Finished ${dateLabel(it, time = true)}" } ?: ""}", style = Type.xs, color = theme.text2)
                        if (r.state == "PENDING") Text("Will be restored the next time ${backups.deviceName} is online.", style = Type.xs, color = theme.text2)
                        r.error?.let { Text(it, style = Type.xs, color = theme.dangerText) }
                    }
                    StatusPill(when (r.state) { "PENDING" -> "Waiting"; "COMPLETED" -> "Restored"; else -> "Failed" },
                        when (r.state) { "PENDING" -> Tone.Accent; "FAILED" -> Tone.Danger; else -> Tone.Success })
                }
            }
        }
        item { Text("Backups", Modifier.padding(top = 6.dp), style = Type.h3) }
        val runs = backups.runs
        if (runs.isNullOrEmpty()) item { Text(if (runs == null) "Loading history…" else "No backups have run yet.", style = Type.sm, color = theme.text2) }
        else items(runs, key = { "run-" + it.id }) { run ->
            val shape = RoundedCornerShape(Radius.lg)
            Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, theme.line, shape)) {
                Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { backups.toggleRun(run) }.padding(12.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(Lucide.Archive, null, Modifier.size(18.dp), tint = theme.text2)
                    Column(Modifier.weight(1f)) {
                        Text(dateLabel(run.startedAt, time = true), style = Type.name)
                        Text("${if (run.trigger == "MANUAL") "Backed up manually" else "Automatic backup"} · ${plural(run.fileCount, "file")} saved · ${bytesLabel(run.sizeBytes)}",
                            style = Type.xs, color = theme.text2)
                    }
                    StatusPill(when (run.state) { "RUNNING" -> "In progress"; "COMPLETED" -> "Done"; "PARTIAL" -> "Some files skipped"; else -> "Failed" },
                        when (run.state) { "RUNNING" -> Tone.Accent; "COMPLETED" -> Tone.Success; else -> Tone.Danger })
                }
                if (backups.expandedRun == run.id) Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    run.error?.let { Alert(it, tone = Tone.Danger) }
                    val entries = backups.runFiles
                    when {
                        entries == null -> Text("Loading files…", style = Type.sm, color = theme.text2)
                        entries.isEmpty() -> Text("No files were saved in this backup.", style = Type.sm, color = theme.text2)
                        else -> entries.forEach { entry ->
                            Divider()
                            Text(entry.relativePath, style = Type.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text("${bytesLabel(entry.sizeBytes)} · Edited ${dateLabel(entry.modifiedAt, time = true)}", style = Type.xs, color = theme.text2)
                            VersionActions(model, entry.itemId, entry.versionId, entry.relativePath.substringAfterLast('/'), entry.savedAt)
                        }
                    }
                }
            }
        }
    }
}

@Composable fun VersionActions(model: WorkspaceModel, itemId: String, versionId: String, name: String, createdAt: String) {
    val backups = model.backups
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!backups.removed && !backups.archived) HButton("Restore", { backups.restore(itemId, versionId, name, createdAt) }, variant = Variant.Outline, small = true,
            icon = Lucide.RotateCcw, enabled = !model.busy)
        HButton("Download", { backups.download(itemId, versionId, name) }, variant = Variant.Ghost, small = true, icon = Lucide.Download, enabled = !model.busy)
    }
}

/** Controls for a backup folder on this phone: back up now, pause, exclusions, archive and restore, disconnect. */
@Composable private fun LocalBackupControls(model: WorkspaceModel, root: SyncRoot) {
    val sync = model.sync
    val queued = sync.jobs.count { it.rootId == root.id }
    val failed = sync.jobs.count { it.rootId == root.id && it.error != null }
    val active = sync.runtime.active?.takeIf { it.rootId == root.id }
    val issues = sync.runtime.issues.filter { it.rootId == root.id }
    val paused = sync.runtime.paused || root.paused
    Text(when (root.archive) {
        "pending" -> "Archiving: making a final backup before removing the local files."
        "removing" -> "Archiving: removing local files whose content is saved…"
        "archived" -> "Archived. The local files were removed from this phone; everything is kept here."
        "restoring" -> "Restoring this folder to this phone…"
        else -> when {
            paused -> "Paused on this phone. No new versions are saved until you resume."
            active != null -> "Backing up ${baseName(active.relativePath)}…"
            queued > 0 -> "${plural(queued, "file")} waiting. Files are saved after they have been unchanged for an hour, or right away with Back up now."
            else -> "Backed up from this phone. Files are saved about an hour after they last change."
        }
    }, style = Type.xs, color = theme.text2)
    active?.let { Progress(if (it.total > 0) it.loaded.toFloat() / it.total else null, height = 4.dp) }
    root.archiveError?.let { Alert("Archive stopped: $it", tone = Tone.Danger) }
    if (failed > 0) Alert("${plural(failed, "file")} could not be backed up yet. ${sync.jobs.firstOrNull { it.rootId == root.id && it.error != null }?.error ?: ""}".trim(), tone = Tone.Warning)
    issues.firstOrNull { it.scope == null }?.let { issue ->
        Alert(issueText(issue), tone = Tone.Danger, action = if (issue.code in listOf(IssueCode.FOLDER_MISSING, IssueCode.PERMISSION_DENIED)) "Locate folder" else null) {
            sync.setup(SyncSetup.ChangeLocal(root))
        }
    }
    if (root.archive == "archived") HButton("Restore archived folder", { sync.restoreArchive(root) }, Modifier.fillMaxWidth(), icon = Lucide.ArchiveRestore, enabled = !model.busy && !paused)
    else if (root.archive == null) {
        HButton("Back up now", { sync.backupNow(root) }, Modifier.fillMaxWidth().testTag("backup-now"), icon = Lucide.CloudUpload, enabled = !model.busy && !paused)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HButton(if (root.paused) "Resume" else "Pause", { sync.togglePause(root) }, Modifier.weight(1f), Variant.Outline, icon = if (root.paused) Lucide.Play else Lucide.Pause, enabled = !model.busy)
            HButton("Exclusions", { model.error = null; model.overlay = Overlay.SyncExclusions(root) }, Modifier.weight(1f), Variant.Outline, icon = Lucide.EyeOff)
        }
        HButton("Archive folder", { sync.archive(root) }, Modifier.fillMaxWidth(), Variant.Outline, icon = Lucide.Archive, enabled = !model.busy && !paused)
    }
    HButton("Disconnect backup", { sync.disconnectBackup(root) }, Modifier.fillMaxWidth(), Variant.DangerGhost, enabled = !model.busy)
}
