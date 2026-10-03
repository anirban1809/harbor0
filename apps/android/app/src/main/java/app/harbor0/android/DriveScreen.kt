package app.harbor0.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.layout
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Pull-to-refresh around a page, with the indicator in the theme colors. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun Refreshable(refreshing: Boolean, onRefresh: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberPullToRefreshState()
    val palette = theme.palette
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, state = state, modifier = Modifier.fillMaxSize(),
        indicator = { PullToRefreshDefaults.Indicator(state, refreshing, Modifier.align(Alignment.TopCenter), containerColor = palette.card, color = palette.primary) }) {
        content()
    }
}

@Composable fun DriveScreen(model: WorkspaceModel) {
    val drive = model.drive
    val files = drive.files
    val selection = drive.selection
    val t = theme
    val pinned = drive.showsPlaces
    Refreshable(drive.loading && drive.loaded, { drive.refresh() }) {
        LazyColumn(Modifier.fillMaxSize().testTag("drive-list"), state = remember(model.epoch, model.drive.location, model.drive.trail.size, model.drive.placeView) { androidx.compose.foundation.lazy.LazyListState() }, contentPadding = PaddingValues(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 104.dp)) {
            item {
                PageTitle(if (drive.searching) "Search results" else "My Drive")
            }
            if (drive.inPlace) { placeItems(model); return@LazyColumn }
            if (drive.trail.isNotEmpty()) item { Breadcrumbs(drive.crumbs) { drive.openCrumb(it) } }
            if (drive.searching) item {
                Row(Modifier.padding(top = 10.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Results for “${model.query.trim()}”", Modifier.weight(1f), style = Type.sm, color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (drive.trail.isNotEmpty()) {
                        var open by remember { mutableStateOf(false) }
                        Box {
                            FilterChip(if (drive.scope == "folder") "Search this folder" else "Search all files", { open = true })
                            HMenu(open, { open = false }) {
                                listOf("all" to "Search all files", "folder" to "Search this folder").forEach { (value, label) ->
                                    HMenuItem(label, onClick = { open = false; drive.scope = value; drive.refresh() }, checked = drive.scope == value)
                                }
                            }
                        }
                    }
                    HIconButton(Lucide.X, "Clear search", { model.query = "" })
                }
            }
            if (drive.lowStorage) item {
                model.storage?.let { s ->
                    Alert("${bytesLabel(s.usedBytes)} of ${bytesLabel(s.quotaBytes)} used. You’re running low on storage.", Modifier.padding(top = 12.dp), Tone.Warning, "Manage storage") { model.navigate(Section.Storage) }
                }
            }
            drive.loadError?.takeIf { files.isNotEmpty() }?.let { item { Alert(it, Modifier.padding(top = 12.dp), Tone.Danger, "Try again") { drive.refresh() } } }
            item {
                Row(Modifier.fillMaxWidth().padding(top = 14.dp).heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (selection.isNotEmpty()) {
                        Text("${selection.size} selected", Modifier.weight(1f), style = Type.label.copy(fontSize = 15.sp, fontWeight = FontWeight(600)))
                        HIconButton(Lucide.X, "Clear selection", { drive.selected = emptySet() })
                    } else {
                        val total = drive.folderId?.takeIf { drive.inPlaceFolder }?.let { drive.usageOf(listOf(it)) }?.let { " · ${usageLabel(it)} in total" } ?: ""
                        Text(if (!drive.loaded) "Loading…" else "${files.size}${if (drive.cursor != null) "+" else ""} ${if (files.size == 1) "item" else "items"}$total",
                            Modifier.weight(1f), style = Type.body, color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        ViewSwitch(drive.grid, model::setGrid)
                    }
                }
                if (selection.isEmpty()) Filters(drive)
            }
            when {
                !drive.loaded && drive.loadError == null -> item { SkeletonRows(drive.grid) }
                drive.loadError != null && files.isEmpty() -> item { LoadError("We couldn’t load these files.") { drive.refresh() } }
                files.isEmpty() && !pinned -> item { DriveEmpty(model) }
                else -> {
                    if (drive.syncStatusError) item { Text("Sync status is temporarily unavailable.", Modifier.padding(top = 8.dp), style = Type.xs, color = t.text2) }
                    fileList(files, drive.grid, drive.selected, onSelect = { ids -> drive.selected = ids },
                        onOpen = drive::open, onMenu = { model.overlay = Overlay.ItemMenu(it) },
                        badge = { drive.syncBadge(it) }, size = drive::folderSize, leading = if (pinned) { {
                            Place.entries.forEach { place ->
                                VirtualFolder(place.title, place.icon, listOfNotNull(drive.placeTotal(place)?.let { usageLabel(it, tight = true) }, place.hint).joinToString(" · "), drive.grid) { drive.openPlace(place) }
                            }
                        } } else null)
                    if (drive.grid) item { HButton("Select all files", { drive.selectAll(true) }, Modifier.padding(top = 10.dp), Variant.Link) }
                }
            }
            if (drive.cursor != null && drive.loaded) item { LoadMore(drive.loading, drive.loadError != null) { drive.refresh(more = true) } }
        }
    }
}

val Place.icon get() = when (this) { Place.Synced -> Lucide.FolderSync; Place.Backups -> Lucide.Archive; Place.Archives -> Lucide.Package }

/** A place (Synced Folders, Backups or Archives): one folder per device, then that device's folders. */
private fun LazyListScope.placeItems(model: WorkspaceModel) {
    val drive = model.drive
    val view = drive.placeView ?: return
    val place = view.place
    val groups = drive.groups(place)
    val failed = model.devices.error != null || drive.catalogError || (place == Place.Synced && drive.syncFoldersError)
    val loading = (!drive.loaded && drive.loadError == null) || (model.devices.data == null && model.devices.error == null)
    item { Breadcrumbs(drive.crumbs) { drive.openCrumb(it) } }
    if (place == Place.Synced && view.group == null) item { SyncStatusCard(model, compact = true, modifier = Modifier.padding(top = 12.dp)) }
    if (view.group != null) {
        val folders = groups.firstOrNull { it.id == view.group }?.folders.orEmpty()
        when {
            folders.isEmpty() && loading -> item { SkeletonRows(drive.grid) }
            folders.isEmpty() && failed -> item { LoadError("We couldn’t load these folders.") { drive.refresh() } }
            folders.isEmpty() -> item { EmptyState(place.icon, "No ${place.unit}s", "${view.groupName} has no ${place.unit}s right now.") }
            else -> {
                item { UsageLine(drive.usageOf(folders.map { it.id })) }
                fileList(folders, drive.grid, emptySet(), onSelect = {}, onOpen = drive::open, onMenu = { model.overlay = Overlay.ItemMenu(it) },
                    badge = { drive.syncBadge(it) }, selectable = false, size = drive::folderSize)
            }
        }
        return
    }
    when {
        groups.isEmpty() && loading -> item { SkeletonRows(drive.grid) }
        groups.isEmpty() && failed -> item { LoadError("We couldn’t load ${place.title.lowercase()}.") { drive.refresh() } }
        groups.isEmpty() -> item {
            EmptyState(place.icon, "No ${place.unit}s", when (place) {
                Place.Synced -> "Folders you sync on your computers and phones appear here, grouped by device. Synced files are kept in the cloud and every device downloads changes from there."
                Place.Backups -> "Folders you back up from your computers and phones appear here, grouped by device."
                Place.Archives -> "Archived backups appear here, grouped by the device they came from."
            }) {
                if (place == Place.Synced) HButton("Sync a folder", { model.sync.setup(SyncSetup.New) }, small = true, enabled = model.sync.view != null && !model.busy)
            }
        }
        else -> {
            item { UsageLine(drive.placeTotal(place)) }
            items(groups, key = { it.id }) { g ->
                val size = drive.usageOf(g.folders.map { it.id })?.let { usageLabel(it, tight = true) }
                VirtualFolder(g.name, if (g.device?.isPhone == true) Lucide.Smartphone else Lucide.Laptop,
                    listOfNotNull(size, platformNames[g.platform] ?: "Device", plural(g.folders.size, place.unit)).joinToString(" · "), drive.grid) { drive.openPlace(place, g.id, g.name) }
            }
        }
    }
}

/** The storage a place or device uses, under the breadcrumbs; nothing until it has loaded. */
@Composable private fun UsageLine(total: UsageTotal?) {
    total?.let { Text("${usageLabel(it)} used", Modifier.padding(top = 4.dp).testTag("usage-total"), style = Type.sm, color = theme.text2) }
}

/** A folder that isn't a drive item (a place or one of its devices): it opens, and has no selection or actions. */
@Composable fun VirtualFolder(name: String, icon: androidx.compose.ui.graphics.vector.ImageVector, meta: String, grid: Boolean, onOpen: () -> Unit) {
    val t = theme
    if (grid) {
        val shape = RoundedCornerShape(Radius.lg)
        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Sheet(t.palette.card, Modifier.weight(1f).border(1.dp, t.line, shape), shape) {
                Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onOpen).testTag("file-$name").padding(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    VirtualTile(icon, 44.dp)
                    Text(name, Modifier.padding(top = 6.dp), style = Type.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(meta, style = Type.xs, color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.weight(1f))
        }
        return
    }
    Column {
        Row(Modifier.fillMaxWidth().height(64.dp).clickable(role = Role.Button, onClick = onOpen).testTag("file-$name"), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.padding(start = 4.dp, end = 12.dp)) { VirtualTile(icon) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(name, style = Type.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(meta, style = Type.xs, color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Lucide.ChevronRight, null, Modifier.padding(horizontal = 11.dp).size(18.dp), tint = t.text3)
        }
        Divider()
    }
}
@Composable private fun VirtualTile(icon: androidx.compose.ui.graphics.vector.ImageVector, size: androidx.compose.ui.unit.Dp = 40.dp) {
    Box(Modifier.size(size).background(theme.accentSoft, RoundedCornerShape(size / 4)), contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(size / 2), tint = theme.accentText)
    }
}

@Composable fun Breadcrumbs(names: List<String>, onOpen: (Int) -> Unit) {
    Row(Modifier.padding(top = 10.dp).horizontalScroll(rememberScrollState(), reverseScrolling = true), verticalAlignment = Alignment.CenterVertically) {
        names.forEachIndexed { depth, name ->
            val current = depth == names.lastIndex
            if (depth > 0) Icon(Lucide.ChevronRight, null, Modifier.size(14.dp), tint = theme.text3)
            Text(name, Modifier.clip(RoundedCornerShape(Radius.sm)).clickable(enabled = !current, role = Role.Button) { onOpen(depth) }.padding(horizontal = 4.dp, vertical = 8.dp),
                style = if (current) Type.label.copy(fontSize = 14.sp) else Type.sm.copy(fontSize = 14.sp), color = if (current) theme.text else theme.text2, maxLines = 1)
        }
    }
}

@Composable private fun Filters(drive: DriveState) {
    val f = drive.filters
    // The chips scroll sideways from edge to edge, past the page gutter, as on the web.
    Row(Modifier.padding(top = 8.dp).layout { measurable, constraints ->
        val gutter = 16.dp.roundToPx()
        val width = constraints.maxWidth + gutter * 2
        val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
        layout(constraints.maxWidth, placeable.height) { placeable.place(-gutter, 0) }
    }.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ChoiceChip(typeOptions, f.type, f.type != "all") { drive.setFilter(f.copy(type = it)) }
        ChoiceChip(modifiedOptions, f.modified, f.modified != "all") { drive.setFilter(f.copy(modified = it)) }
        var open by remember { mutableStateOf(false) }
        Box {
            FilterChip("Sort: " + (sortOptions.firstOrNull { it.first == f.sort }?.second ?: ""), { open = true })
            HMenu(open, { open = false }) {
                sortOptions.forEach { (value, label) -> HMenuItem(label, onClick = { open = false; drive.filters = drive.filters.copy(sort = value) }, checked = f.sort == value) }
                HMenuSeparator()
                HMenuItem("Folders first", onClick = { drive.filters = drive.filters.copy(foldersFirst = !f.foldersFirst) }, checked = f.foldersFirst)
                HMenuItem("Show system files", onClick = { drive.filters = drive.filters.copy(showSystem = !f.showSystem) }, checked = f.showSystem)
            }
        }
        if (f.narrowed) FilterChip("Clear filters", { drive.setFilter(f.copy(type = "all", modified = "all")) }, chevron = false)
    }
}
@Composable private fun ChoiceChip(options: List<Pair<String, String>>, value: String, active: Boolean, onChange: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        FilterChip(options.first { it.first == value }.second, { open = true }, active = active)
        HMenu(open, { open = false }) {
            options.forEach { (key, label) -> HMenuItem(label, onClick = { open = false; onChange(key) }, checked = key == value) }
        }
    }
}

@Composable private fun DriveEmpty(model: WorkspaceModel) {
    val drive = model.drive
    val pickers = LocalPickers.current
    val filtered = drive.searching || drive.filters.narrowed
    val inFolder = drive.trail.isNotEmpty()
    EmptyState(Lucide.Folder, when {
        filtered -> "No matching files"
        inFolder -> "This folder is empty"
        else -> "No files yet"
    }, when {
        filtered -> "Try a different search or reset your filters."
        inFolder && drive.location == Location.Backup -> "Files appear here after their first backup."
        inFolder && drive.location == Location.Sync -> "Files will appear here when this folder syncs."
        else -> "Upload files or create a folder to get started."
    }) {
        if (filtered) HButton("Clear search and filters", { drive.filters = DriveFilters(); model.query = "" }, variant = Variant.Outline, small = true)
        else if (drive.canWriteHere) {
            HButton("Upload files", pickers.uploadFiles, small = true, enabled = !model.busy)
            HButton("New folder", { model.overlay = Overlay.NewFolder }, variant = Variant.Outline, small = true, enabled = !model.busy)
        }
    }
}

/** List rows or a two-column grid of files, with checkboxes, long-press selection and an actions button. */
fun LazyListScope.fileList(files: List<DriveItem>, grid: Boolean, selected: Set<String>, onSelect: (Set<String>) -> Unit, onOpen: (DriveItem) -> Unit,
    onMenu: (DriveItem) -> Unit, badge: (DriveItem) -> Pair<String, Tone>? = { null }, trash: Boolean = false, selectable: Boolean = true,
    leading: (@Composable () -> Unit)? = null, size: (DriveItem) -> String? = { null }) {
    fun toggle(item: DriveItem) = onSelect(if (item.id in selected) selected - item.id else selected + item.id)
    val tap: (DriveItem) -> Unit = { if (selected.isNotEmpty()) toggle(it) else onOpen(it) }
    if (grid) {
        leading?.let { item { Column { it() } } }
        items(files.chunked(2), key = { row -> row.joinToString { it.id } }) { row ->
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { item -> FileCard(item, item.id in selected, { toggle(item) }, { tap(item) }, { onMenu(item) }, badge(item), trash, Modifier.weight(1f), selectable, size(item)) }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    } else {
        item {
            val count = files.count { it.id in selected }
            Row(Modifier.padding(top = 8.dp).fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
                if (selectable) HCheckbox(files.isNotEmpty() && count == files.size, { on -> onSelect(if (on) selected + files.map { it.id } else selected - files.map { it.id }.toSet()) },
                    "Select all files on this page", indeterminate = count > 0 && count < files.size)
                Text("Name", Modifier.padding(start = if (selectable) 6.dp else 4.dp), style = Type.sm, color = theme.text2)
            }
            Divider()
        }
        leading?.let { item { Column { it() } } }
        items(files, key = { it.id }) { item -> FileRow(item, item.id in selected, { toggle(item) }, { tap(item) }, { onMenu(item) }, badge(item), trash, selectable, size(item)) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable fun FileRow(item: DriveItem, selected: Boolean, onToggle: () -> Unit, onOpen: () -> Unit, onMenu: () -> Unit, badge: Pair<String, Tone>?, trash: Boolean,
    selectable: Boolean = true, size: String? = null) {
    val t = theme
    Column(Modifier.background(if (selected) t.accentSoft else Color.Transparent)) {
        Row(Modifier.fillMaxWidth().height(64.dp).combinedClickable(role = Role.Button, onLongClick = if (selectable) onToggle else null, onClick = onOpen).testTag("file-${item.name}"),
            verticalAlignment = Alignment.CenterVertically) {
            if (selectable) HCheckbox(selected, { onToggle() }, "Select ${item.name}")
            Box(Modifier.padding(start = if (selectable) 6.dp else 4.dp, end = 12.dp)) { FileTile(item) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(item.name, style = Type.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(meta(item, size), style = Type.xs, color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    badge?.let { (label, tone) -> Badge(label, tone) }
                }
            }
            if (item.favorite) Icon(Lucide.StarFilled, "Favorite", Modifier.padding(start = 8.dp).size(15.dp), tint = t.palette.warning)
            if (trash) Icon(Lucide.Trash, "In trash", Modifier.padding(start = 8.dp).size(15.dp), tint = t.text2)
            Box(Modifier.padding(start = 4.dp).size(40.dp).clip(RoundedCornerShape(Radius.md)).clickable(role = Role.Button, onClick = onMenu)
                .semantics { contentDescription = "Actions for ${item.name}" }, contentAlignment = Alignment.Center) {
                Icon(Lucide.Ellipsis, null, Modifier.size(18.dp), tint = t.text2)
            }
        }
        Divider()
    }
}
/** Size and date. Folders show their usage when known (inside the places), else “Folder”. */
fun meta(item: DriveItem, size: String? = null) = "${if (item.isFolder) size ?: "Folder" else bytesLabel(item.sizeBytes)} · ${dateLabel(item.deletedAt ?: item.updatedAt)}"

@OptIn(ExperimentalFoundationApi::class)
@Composable private fun FileCard(item: DriveItem, selected: Boolean, onToggle: () -> Unit, onOpen: () -> Unit, onMenu: () -> Unit, badge: Pair<String, Tone>?, trash: Boolean, modifier: Modifier, selectable: Boolean = true, size: String? = null) {
    val t = theme
    val shape = RoundedCornerShape(Radius.lg)
    Sheet(if (selected) t.accentSoft else t.palette.card, modifier.border(1.dp, if (selected) t.primary else t.line, shape), shape) {
        Column(Modifier.fillMaxWidth().combinedClickable(role = Role.Button, onLongClick = if (selectable) onToggle else null, onClick = onOpen).testTag("file-${item.name}").padding(start = 4.dp, end = 4.dp, bottom = 12.dp)) {
            Row(Modifier.heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                if (selectable) HCheckbox(selected, { onToggle() }, "Select ${item.name}")
                Spacer(Modifier.weight(1f))
                if (item.favorite) Icon(Lucide.StarFilled, "Favorite", Modifier.size(14.dp), tint = t.palette.warning)
                if (trash) Icon(Lucide.Trash, "In trash", Modifier.size(14.dp), tint = theme.text2)
                Box(Modifier.size(40.dp).clip(RoundedCornerShape(Radius.md)).clickable(role = Role.Button, onClick = onMenu).semantics { contentDescription = "Actions for ${item.name}" },
                    contentAlignment = Alignment.Center) { Icon(Lucide.Ellipsis, null, Modifier.size(18.dp), tint = theme.text2) }
            }
            Column(Modifier.padding(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FileTile(item, 44.dp)
                Text(item.name, Modifier.padding(top = 6.dp), style = Type.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(meta(item, size), style = Type.xs, color = theme.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                badge?.let { (label, tone) -> Badge(label, tone) }
            }
        }
    }
}

@Composable fun SkeletonRows(grid: Boolean = false) {
    Column(Modifier.padding(top = 8.dp)) {
        if (grid) repeat(3) {
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) { repeat(2) { Skeleton(Modifier.weight(1f).height(140.dp)) } }
        } else repeat(6) { index ->
            Row(Modifier.fillMaxWidth().height(64.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Skeleton(Modifier.padding(start = 11.dp).size(18.dp))
                Skeleton(Modifier.size(40.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { Skeleton(Modifier.size(width = (120 + index % 3 * 40).dp, height = 12.dp)); Skeleton(Modifier.size(90.dp, 10.dp)) }
            }
        }
    }
}
@Composable fun LoadError(title: String = "This view couldn’t be loaded.", compact: Boolean = false, onRetry: () -> Unit) {
    EmptyState(Lucide.WifiOff, title, "Your data hasn’t changed. Check your connection and try again.", compact = compact) {
        HButton("Try again", onRetry, variant = Variant.Outline, small = true, icon = Lucide.RefreshCw)
    }
}
@Composable fun LoadMore(loading: Boolean, error: Boolean, onLoad: () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(top = 16.dp), contentAlignment = Alignment.Center) {
        HButton(if (loading) "Loading more files…" else if (error) "Retry loading more files" else "Load more files", onLoad, variant = Variant.Outline, enabled = !loading)
    }
}

/** The FAB with its “New” menu, or the selection dock while files are selected. */
@Composable fun DriveFloating(model: WorkspaceModel) {
    val drive = model.drive
    val selection = drive.selection
    val pickers = LocalPickers.current
    if (selection.isNotEmpty()) {
        val blocked = model.busy
        val modify = selection.all(drive::canModify)
        val hasSync = selection.any(drive::isSyncFolder)
        SelectionDock {
            DockButton(Lucide.Download, "Download", { drive.download(selection) }, !blocked)
            if (modify) {
                DockButton(Lucide.Send, "Send", { drive.show("send", selection) }, !blocked)
                if (!hasSync) DockButton(Lucide.FolderInput, "Move", { drive.show("move", selection) }, !blocked)
            }
            if (selection.all(drive::canTrash)) DockButton(Lucide.Trash, "Move to trash", { drive.show("trash", selection) }, !blocked)
            DockButton(Lucide.Ellipsis, "More selection actions", { model.overlay = Overlay.SelectionMenu }, iconOnly = true)
        }
    } else if (drive.canWriteHere && !model.busy) {
        var open by remember { mutableStateOf(false) }
        Box(Modifier.padding(end = 16.dp, bottom = 16.dp, top = 4.dp)) {
            Fab({ open = true })
            HMenu(open, { open = false }, Modifier.widthIn(min = 230.dp)) {
                HMenuItem("Upload files", Lucide.ArrowUpFromLine, { open = false; pickers.uploadFiles() })
                HMenuItem("Upload a folder", Lucide.FolderUp, { open = false; pickers.uploadFolder() })
                HMenuSeparator()
                HMenuItem("New folder", Lucide.FolderPlus, { open = false; model.error = null; model.overlay = Overlay.NewFolder })
            }
        }
    }
}
