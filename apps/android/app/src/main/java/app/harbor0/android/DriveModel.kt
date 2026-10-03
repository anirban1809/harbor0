package app.harbor0.android

import androidx.compose.runtime.*
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.time.Instant
import java.util.UUID

enum class Location { Cloud, Backup, Sync }
/** The pinned, virtual folders at the root of My Drive. Each lists devices, then the folders a device keeps there. */
enum class Place(val title: String, val unit: String, val hint: String, val states: Set<String> = emptySet()) {
    Synced("Synced Folders", "synced folder", "Folders kept in sync on your devices"),
    Backups("Backups", "backup folder", "Folders backed up from your devices", setOf("ACTIVE", "PAUSED", "ERROR")),
    Archives("Archives", "archived folder", "Archived backups from your devices", setOf("ARCHIVED")),
}
/** The cloud folder ids a place holds: synced folders, or the backup roots in the place's states. */
fun placeFolderIds(place: Place, syncFolders: List<DriveItem>, backupRoots: List<BackupRoot>): List<String> =
    if (place == Place.Synced) syncFolders.map { it.id }.distinct()
    else backupRoots.filter { it.state in place.states }.map { it.remoteRootDriveItemId }.distinct()
/** A device inside a place, with its folders there. `device` is null for folders whose device is no longer listed. */
data class DeviceGroup(val id: String, val name: String, val platform: String, val device: Device?, val folders: List<DriveItem>)
/** A place's own page: its device list (group null), or one device's folders. */
data class PlaceView(val place: Place, val group: String? = null, val groupName: String = "")

/** Whether a backup root was made on this device: device keys when both have one, else the session id or the name. */
fun ownsBackup(root: BackupRoot, device: Device): Boolean {
    val rootKey = root.devicePublicId?.ifBlank { null }
    val deviceKey = device.devicePublicId?.ifBlank { null }
    if (rootKey != null && deviceKey != null) return rootKey == deviceKey
    return root.deviceId == device.id || (!root.deviceName.isNullOrBlank() && root.deviceName == device.name)
}
/** Groups a place's folders by device. Browsers and revoked devices are left out, as are devices with no folders there. */
fun placeGroups(place: Place, devices: List<Device>, syncFolders: List<DriveItem>, backupRoots: List<BackupRoot>): List<DeviceGroup> {
    val listed = devices.filter { it.platform != "WEB" && it.status != "REVOKED" && it.revokedAt == null }
    val byName = Comparator<DriveItem> { a, b -> naturalCompare(a.name, b.name) }
    val groups = if (place == Place.Synced) listed.map { device ->
        DeviceGroup(device.id, device.name, device.platform, device, syncFolders.filter { f -> f.syncDevices.any { it.id == device.id } }.sortedWith(byName))
    } else {
        val found = linkedMapOf<String, Pair<Device?, MutableList<BackupRoot>>>()
        for (root in backupRoots.filter { it.state in place.states }) {
            val device = listed.firstOrNull { ownsBackup(root, it) }
            val name = device?.name ?: root.deviceName?.ifBlank { null } ?: "Other device"
            found.getOrPut(device?.id ?: "other:$name") { device to mutableListOf() }.second += root
        }
        found.map { (id, entry) ->
            val (device, roots) = entry
            DeviceGroup(id, device?.name ?: roots[0].deviceName?.ifBlank { null } ?: "Other device", device?.platform ?: "", device, roots.map { it.folder }.sortedWith(byName))
        }
    }
    return groups.filter { it.folders.isNotEmpty() }.sortedWith { a, b -> naturalCompare(a.name, b.name) }
}
data class DriveFilters(val type: String = "all", val modified: String = "all", val sort: String = "modified-desc",
    val foldersFirst: Boolean = true, val showSystem: Boolean = false) {
    val narrowed get() = type != "all" || modified != "all"
}
val typeOptions = listOf("all" to "Type: All items", "folders" to "Type: Folders", "files" to "Type: Files", "image" to "Type: Images",
    "video" to "Type: Videos", "audio" to "Type: Audio")
val modifiedOptions = listOf("all" to "Modified: Any time", "1" to "Modified: Last 24 hours", "7" to "Modified: Last 7 days", "30" to "Modified: Last 30 days")
val sortOptions = listOf("modified-desc" to "Modified, newest first", "modified-asc" to "Modified, oldest first", "name-asc" to "Name, A–Z",
    "name-desc" to "Name, Z–A", "size-desc" to "Size, largest first", "size-asc" to "Size, smallest first",
    "created-desc" to "Created, newest first", "created-asc" to "Created, oldest first")
fun isSystemFile(name: String) = name.lowercase() in setOf(".ds_store", "thumbs.db", "desktop.ini")
private fun millis(iso: String?) = runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)
/** The web's `driveView`: filters by type and date, then sorts with folders first. */
fun driveView(items: List<DriveItem>, filters: DriveFilters, now: Long = System.currentTimeMillis()): List<DriveItem> {
    val days = filters.modified.toLongOrNull()
    val shown = items.filter { item ->
        (filters.showSystem || !isSystemFile(item.name)) &&
            when (filters.type) { "all" -> true; "folders" -> item.isFolder; "files" -> !item.isFolder; else -> item.mimeType?.startsWith(filters.type + "/") == true } &&
            (days == null || (item.updatedAt.isNotEmpty() && millis(item.updatedAt) >= now - days * 86_400_000))
    }
    val (field, direction) = filters.sort.split('-').let { it[0] to it.getOrElse(1) { "desc" } }
    val byName = Comparator<DriveItem> { a, b -> naturalCompare(a.name, b.name) }
    val order: Comparator<DriveItem> = when (field) {
        "name" -> byName
        "size" -> compareBy { it.sizeBytes }
        "created" -> compareBy { millis(it.createdAt) }
        else -> compareBy { millis(it.updatedAt) }
    }
    return shown.sortedWith { a, b ->
        if (filters.foldersFirst && a.isFolder != b.isFolder) return@sortedWith if (a.isFolder) -1 else 1
        val value = order.compare(a, b).let { if (direction == "desc") -it else it }
        if (value != 0) value else a.name.compareTo(b.name)
    }
}
/** Case-insensitive comparison that orders embedded numbers by value ("File 2" before "File 10"). */
fun naturalCompare(a: String, b: String): Int {
    val pattern = Regex("\\d+|\\D+")
    val left = pattern.findAll(a.lowercase()).map { it.value }.toList()
    val right = pattern.findAll(b.lowercase()).map { it.value }.toList()
    for (i in 0 until minOf(left.size, right.size)) {
        val x = left[i]; val y = right[i]
        val result = if (x[0].isDigit() && y[0].isDigit()) x.toBigInteger().compareTo(y.toBigInteger()) else x.compareTo(y)
        if (result != 0) return result
    }
    return left.size - right.size
}
/** Builds `/v1/...?a=b` with encoded query values; null values are left out. */
fun withQuery(path: String, vararg params: Pair<String, String?>): String {
    val url = ("https://harbor.invalid" + path).toHttpUrl().newBuilder()
    params.forEach { (key, value) -> if (value != null) url.addQueryParameter(key, value) }
    val built = url.build()
    return built.encodedPath + (built.encodedQuery?.let { "?$it" } ?: "")
}
fun recipientJson(value: String) = buildJsonObject {
    val text = value.trim()
    put("type", if (text.contains('@') && !text.startsWith('@')) "EMAIL" else "USERNAME")
    put("value", text.removePrefix("@"))
}
fun countLabel(items: List<DriveItem>) = if (items.size == 1) "“${items[0].name}”" else "${items.size} items"

/** My Drive: cloud files, the Synced Folders, Backups and Archives places, folders, search, filters, selection and item actions. */
class DriveState(private val m: WorkspaceModel) {
    private val api get() = m.api
    var location by mutableStateOf(Location.Cloud)
    var trail by mutableStateOf<List<DriveItem>>(emptyList())
    var items by mutableStateOf<List<DriveItem>>(emptyList()); private set
    var locations by mutableStateOf<Map<String, Location>>(emptyMap()); private set
    var syncFolders by mutableStateOf<List<DriveItem>>(emptyList()); private set
    var backupRoots by mutableStateOf<List<BackupRoot>>(emptyList()); private set
    var statuses by mutableStateOf<Map<String, SyncStatus>>(emptyMap()); private set
    var cursor by mutableStateOf<String?>(null); private set
    var loading by mutableStateOf(false); private set
    var loaded by mutableStateOf(false); private set
    var loadError by mutableStateOf<String?>(null); private set
    var catalogError by mutableStateOf(false); private set
    var syncFoldersError by mutableStateOf(false); private set
    var syncStatusError by mutableStateOf(false); private set
    var filters by mutableStateOf(DriveFilters())
    var grid by mutableStateOf(false)
    var selected by mutableStateOf<Set<String>>(emptySet())
    var scope by mutableStateOf("all")
    /** Set while a place (or one of its devices) is open. */
    var placeView by mutableStateOf<PlaceView?>(null); private set
    /** The place and device a folder was opened from, so the path stays My Drive › place › device › folder. */
    var placeVia by mutableStateOf<PlaceView?>(null); private set
    /** Folder usage by item id, for the places and the folders inside them. Filled in after the list shows. */
    var usage by mutableStateOf<Map<String, Usage>>(emptyMap()); private set
    private var usageJob: Job? = null
    /** The search text the shown list was loaded for. */
    var loadedQuery by mutableStateOf<String?>(null); private set
    private val ancestors = mutableMapOf<String, DriveItem>()
    private var job: Job? = null
    private var generation = 0
    private var loadedKey: List<Any?>? = null

    fun reset() { job?.cancel(); location = Location.Cloud; trail = emptyList(); items = emptyList(); locations = emptyMap()
        syncFolders = emptyList(); backupRoots = emptyList(); statuses = emptyMap(); loaded = false; loadError = null
        selected = emptySet(); filters = DriveFilters(); ancestors.clear(); loadedKey = null; leavePlace(); usageJob?.cancel(); usage = emptyMap() }
    val syncIds get() = syncFolders.map { it.id }.toSet()
    val searching get() = m.query.isNotBlank()
    private val separate get() = trail.isEmpty() && !searching
    fun locationOf(item: DriveItem): Location = when {
        item.backupRootId != null -> Location.Backup
        else -> locations[item.id] ?: if (item.id in syncIds) Location.Sync else if (trail.isNotEmpty()) location else Location.Cloud
    }
    /** What the list shows: cloud items at the root (synced and backed-up folders live in their places), search results from everywhere. */
    val files: List<DriveItem> get() {
        val scoped = when {
            separate -> items.filter { locationOf(it) == Location.Cloud }
            searching && scope == "folder" && trail.isNotEmpty() -> items.filter { it.name.contains(m.query.trim(), ignoreCase = true) }
            else -> items
        }
        return driveView(scoped, filters)
    }
    val selection get() = files.filter { it.id in selected }
    fun canModify(item: DriveItem) = item.backupRootId == null && !catalogError
    fun isSyncFolder(item: DriveItem) = item.isFolder && item.id in syncIds
    fun canTrash(item: DriveItem) = canModify(item) && (!item.isFolder || (item.id !in syncIds && !syncFoldersError))
    fun isBackupRoot(item: DriveItem) = backupRoots.any { it.remoteRootDriveItemId == item.id }
    val inPlace get() = placeView != null && !searching
    /** The pinned places are listed first at the Cloud root, but not while searching or filtering. */
    val showsPlaces get() = location == Location.Cloud && trail.isEmpty() && !searching && !filters.narrowed && placeView == null
    val canWriteHere get() = !inPlace && loaded && loadError == null && !catalogError && location != Location.Backup && (location == Location.Cloud || trail.isNotEmpty())
    val folderId get() = trail.lastOrNull()?.id
    val lowStorage get() = m.storage?.let { it.quotaBytes > 0 && (it.usedBytes + it.reservedBytes).toDouble() / it.quotaBytes >= .9 } == true

    /** Inside a synced, backed-up or archived folder (or any subfolder), where folder sizes are shown. */
    val inPlaceFolder get() = trail.isNotEmpty() && !searching &&
        (location != Location.Cloud || trail.any { it.id in syncIds || it.backupRootId != null || isBackupRoot(it) })
    fun placeTotal(place: Place) = sumUsage(placeFolderIds(place, syncFolders, backupRoots), usage)
    fun usageOf(ids: Collection<String>) = sumUsage(ids, usage)
    /** A folder row's size inside the places, or null to keep the plain “Folder” label. */
    fun folderSize(item: DriveItem): String? = if (!item.isFolder || !(inPlace || inPlaceFolder)) null else usageOf(listOf(item.id))?.let { usageLabel(it, tight = true) }
    /** Fetches usage in batches of 50 without holding up the list; failures leave sizes out. */
    private fun loadUsage(ids: List<String>) {
        usageJob?.cancel()
        if (ids.isEmpty()) return
        usageJob = m.viewModelScope.launch {
            for (batch in ids.distinct().chunked(50)) {
                try {
                    val found = api.get<UsagePage>(withQuery("/v1/drive/usage", "ids" to batch.joinToString(","))).items
                    usage = usage + found.associateBy { it.itemId }
                } catch (e: CancellationException) { throw e } catch (_: Exception) {}
            }
        }
    }
    fun groups(place: Place) = placeGroups(place, m.devices.data.orEmpty(), syncFolders, backupRoots)
    /** Path names for the breadcrumbs, including a place's steps. */
    val crumbs: List<String> get() {
        val view = placeView
        val via = placeVia
        return when {
            view != null -> listOfNotNull("My Drive", view.place.title, view.groupName.takeIf { view.group != null })
            via != null -> listOf("My Drive", via.place.title, via.groupName) + trail.map { it.name }
            else -> listOf("My Drive") + trail.map { it.name }
        }
    }
    val canGoUp get() = trail.isNotEmpty() || placeView != null
    fun up() { crumbs.let { if (it.size > 1) openCrumb(it.size - 2) } }
    fun openCrumb(depth: Int) {
        val view = placeVia ?: placeView
        when {
            depth == 0 -> home()
            view == null -> openTrail(depth)
            depth == 1 -> openPlace(view.place)
            depth == 2 && view.group != null -> openPlace(view.place, view.group, view.groupName)
            else -> openTrail(depth - 2)
        }
    }
    /** Opens a place, or one device inside it. */
    fun openPlace(place: Place, group: String? = null, groupName: String = "") {
        placeView = PlaceView(place, group, groupName); placeVia = null; location = Location.Cloud; trail = emptyList()
        selected = emptySet(); filters = DriveFilters(); m.query = ""
        refresh()
    }
    /** Opens a folder listed in a place in the normal browser, keeping the place path. */
    private fun openPlaceFolder(view: PlaceView, folder: DriveItem) {
        placeView = null; placeVia = view; location = if (view.place == Place.Synced) Location.Sync else Location.Backup; trail = listOf(folder)
        selected = emptySet(); filters = DriveFilters()
        refresh()
    }
    fun leavePlace() { placeView = null; placeVia = null }
    /** Back to the root of My Drive. */
    fun home() { leavePlace(); location = Location.Cloud; openTrail(0) }
    fun enter(item: DriveItem) {
        if (!searching) placeView?.takeIf { it.group != null }?.let { return openPlaceFolder(it, item) }
        if (searching && scope == "all") {
            leavePlace()
            // A search result: rebuild its folder path from the ancestors loaded while classifying it.
            val path = mutableListOf(item)
            var parent = item.parentId
            while (parent != null) { val next = ancestors[parent] ?: break; path.add(0, next); parent = next.parentId }
            location = locations[item.id] ?: location
            trail = path
            m.query = ""
        } else trail = trail + item
        selected = emptySet(); filters = DriveFilters()
        refresh()
    }
    fun openTrail(depth: Int) { trail = trail.take(depth); selected = emptySet(); filters = DriveFilters(); refresh() }
    fun toggle(item: DriveItem) { selected = if (item.id in selected) selected - item.id else selected + item.id }
    fun selectAll(on: Boolean) { val ids = files.map { it.id }; selected = if (on) selected + ids else selected - ids.toSet() }
    fun setFilter(next: DriveFilters) { selected = emptySet(); filters = next }

    /** Reloads the current view. The current list stays visible during background refreshes. */
    fun refresh(more: Boolean = false) {
        // Another page is searching in place: changes made from its results refresh those results instead.
        if (m.section != Section.Drive) { if (m.query.isNotBlank() && m.section != Section.Trash) m.search.refresh(); return }
        job?.cancel()
        val parent = trail.lastOrNull()
        val query = m.query.trim()
        val folderScope = scope == "folder" && parent != null
        val tab = location
        val key = listOf(parent?.id, query, scope, tab)
        if (key != loadedKey && !more) { loaded = false; items = emptyList(); statuses = emptyMap(); locations = emptyMap() }
        val after = if (more) cursor else null
        val stamp = ++generation
        loadedQuery = query
        job = m.viewModelScope.launch {
            loading = true; loadError = null
            try {
                try { syncFolders = api.all<DriveItem>("/v1/sync/folders"); syncFoldersError = false }
                catch (e: CancellationException) { throw e } catch (e: Exception) { syncFoldersError = true; if (!loaded) throw e }
                if (placeView != null) m.loadDevices()
                val roots = try { api.all<BackupRoot>("/v1/backups").filter { it.state != "REMOVED" } } catch (e: CancellationException) { throw e } catch (e: Exception) { catalogError = true; throw e }
                catalogError = false; backupRoots = roots
                val page = if (query.isNotEmpty() && !folderScope) api.get<Page<DriveItem>>(withQuery("/v1/search", "q" to query, "cursor" to after))
                    else api.get<Page<DriveItem>>(HarborApi.pagePath("/v1/drive/folders/${HarborApi.segment(parent?.id ?: "root")}/children", after))
                check(page.nextCursor == null || page.nextCursor != after) { "Could not load the remaining files. Please retry." }
                val all = ((if (more) items else emptyList()) + page.items).distinctBy { it.id }
                val backupMap = roots.associate { it.remoteRootDriveItemId to it.id }
                val synced = syncIds
                val found = if (more) locations.toMutableMap() else mutableMapOf()
                if (query.isNotEmpty() && !folderScope) page.items.forEach { found[it.id] = classify(it, backupMap, synced) }
                else if (parent == null) all.forEach { found[it.id] = when { it.id in backupMap -> Location.Backup; it.id in synced -> Location.Sync; else -> Location.Cloud } }
                ensureActive()
                items = all; locations = found; cursor = page.nextCursor; loaded = true; loadedKey = key
                val ids = (all + syncFolders).map { it.id }.toSet()
                selected = selected.filter { it in ids }.toSet()
                loadUsage(when {
                    query.isNotEmpty() -> emptyList()
                    parent == null -> Place.entries.flatMap { placeFolderIds(it, syncFolders, roots) }
                    inPlaceFolder -> listOf(parent.id) + all.filter { it.isFolder }.map { it.id }
                    else -> emptyList()
                })
                loadStatuses(ids.toList())
            } catch (e: CancellationException) { throw e }
            catch (e: ApiException) {
                if (e.code == "SYNC_REMOVED") { trail = emptyList(); placeVia = null; refresh() } else loadError = e.message
            } catch (e: Exception) { loadError = m.message(e) }
            finally { if (stamp == generation) loading = false }
        }
    }
    private suspend fun classify(item: DriveItem, backupMap: Map<String, String>, synced: Set<String>): Location {
        var current = item
        var sync = false
        val seen = mutableSetOf<String>()
        while (true) {
            if (current.backupRootId != null || current.id in backupMap) return Location.Backup
            if (current.id in synced) sync = true
            val parent = current.parentId ?: return if (sync) Location.Sync else Location.Cloud
            check(seen.add(parent) && seen.size < 33) { "Could not identify this folder location." }
            current = ancestors[parent] ?: api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(parent)}").item.also { ancestors[parent] = it }
        }
    }
    private suspend fun loadStatuses(ids: List<String>) {
        try {
            val found = mutableMapOf<String, SyncStatus>()
            for (batch in ids.chunked(50)) api.get<StatusPage>(withQuery("/v1/sync/status", "ids" to batch.joinToString(","))).items.forEach { found[it.itemId] = it }
            statuses = found; syncStatusError = false
        } catch (e: CancellationException) { throw e } catch (_: Exception) { statuses = emptyMap(); syncStatusError = ids.isNotEmpty() }
    }
    /** The web's sync badge: Synced, Syncing, Pending or Status unavailable. */
    fun syncBadge(item: DriveItem): Pair<String, Tone>? = statuses[item.id]?.let {
        when (it.state) { "SYNCED" -> "Synced" to Tone.Success; "SYNCING" -> "Syncing" to Tone.Accent; "PENDING" -> "Pending" to Tone.Neutral; else -> "Status unavailable" to Tone.Neutral }
    }
    fun cloudState(item: DriveItem) = statuses[item.id]?.cloudState ?: item.cloudState

    // Actions -----------------------------------------------------------------
    fun open(item: DriveItem) {
        if (item.isFolder) return enter(item)
        when (cloudState(item)) {
            "REQUESTED" -> m.notify("Waiting for a linked device to upload this file to the cloud.")
            "RELEASED" -> m.confirm(Confirmation("Request a copy of ${item.name}?",
                "This older file is only stored on your linked devices. A linked device will upload it to the cloud so you can open it here.",
                "Request a copy", "Copy requested. Refresh after your computer uploads it.", danger = false, cancel = "Cancel") {
                api.request("/v1/sync/items/${HarborApi.segment(item.id)}/request-content", "POST"); refresh()
            })
            else -> m.openFile(item)
        }
    }
    fun download(targets: List<DriveItem>) {
        if (targets.any { !it.isFolder && cloudState(it).let { state -> state != null && state != "AVAILABLE" } }) {
            m.error = "This file is stored on linked devices. Open its local copy in the desktop app."; return
        }
        targets.filter { it.isFolder }.take(1).forEach { m.downloadFolder(it) }
        val files = targets.filter { !it.isFolder }
        if (files.isNotEmpty()) m.startTransfer {
            for (item in files) m.fetchAndSave(item.name, buildJsonObject { put("driveItemId", item.id) }, item.mimeType)
        }
    }
    fun downloadVersion(item: DriveItem, version: Version) = m.downloadToDevice(item.name, buildJsonObject {
        put("driveItemId", item.id); put("versionId", version.id)
    }, item.mimeType)
    fun favorite(targets: List<DriveItem>) {
        if (!targets.all(::canModify)) return
        m.action {
            try {
                for (item in targets) api.request("/v1/drive/items/${HarborApi.segment(item.id)}/favorite", if (item.favorite) "DELETE" else "PUT", api.mutation(item))
            } finally { refresh() }
        }
    }
    /** Opens an action sheet unless the item can't take it, as the web `show()` does. */
    fun show(mode: String, targets: List<DriveItem>) {
        if (targets.isEmpty()) return
        if (mode !in listOf("details", "versions", "disconnect") && !targets.all(::canModify)) return
        if (mode == "trash" && !targets.all(::canTrash)) return
        if (mode == "move" && targets.any(::isSyncFolder)) return
        m.error = null
        m.overlay = when (mode) {
            "rename" -> Overlay.Rename(targets[0])
            "move" -> Overlay.Move(targets)
            "send" -> Overlay.Send(targets)
            "share" -> Overlay.ShareAccess(targets[0])
            "details" -> Overlay.Details(targets[0])
            "versions" -> Overlay.Versions(targets[0])
            "trash" -> Overlay.Confirm(Confirmation("Move ${if (targets.size == 1) targets[0].name else "${targets.size} items"} to trash?",
                "You can restore ${if (targets.size == 1) "this item" else "these items"} from Trash.", "Move to trash",
                "Moved ${countLabel(targets)} to trash.", cancel = "Cancel") { mutate(targets) { item ->
                    api.request("/v1/drive/items/${HarborApi.segment(item.id)}", "DELETE", api.mutation(item)) } })
            "remove-sync" -> Overlay.Confirm(Confirmation("Remove “${targets[0].name}” from sync?",
                "Stop syncing on all linked devices and remove this folder from the app. Local folders and files will stay where they are. Offline devices will stop syncing when they reconnect.",
                "Remove from sync", "Folder removed from sync. Local files are preserved on every device.", cancel = "Cancel") {
                api.request("/v1/sync/folders/${HarborApi.segment(targets[0].id)}", "DELETE"); selected = emptySet(); refresh() })
            "disconnect" -> Overlay.Confirm(Confirmation("Disconnect backup?",
                "Stop backing up this folder. All archived files and versions will remain in Cloud and become editable. Local files stay where they are.",
                "Disconnect backup", "Backup disconnected. Its folder and versions are now in Cloud.", danger = false, cancel = "Cancel") {
                val root = targets[0].backupRootId ?: backupRoots.first { it.remoteRootDriveItemId == targets[0].id }.id
                api.request("/v1/backups/${HarborApi.segment(root)}", "DELETE"); home() })
            else -> null
        }
    }
    /** Applies a change to each item; a failure names the item and the rest still refresh. */
    private suspend fun mutate(targets: List<DriveItem>, save: suspend (DriveItem) -> Unit) {
        val errors = mutableListOf<String>()
        for (item in targets) try { save(item) } catch (e: CancellationException) { throw e } catch (e: Exception) { errors += "Could not save “${item.name}”. ${m.message(e)}" }
        selected = emptySet(); refresh()
        if (errors.isNotEmpty()) error(errors.joinToString(" "))
    }
    fun rename(item: DriveItem, name: String) = m.action("Renamed.", close = true) {
        safeName(name.trim())
        mutate(listOf(item)) { api.request("/v1/drive/items/${HarborApi.segment(it.id)}", "PATCH", api.mutation(it) { put("name", name.trim()) }) }
    }
    fun move(targets: List<DriveItem>, destination: List<DriveItem>) {
        val parent = destination.lastOrNull()
        m.action("Moved ${countLabel(targets)} to ${parent?.name ?: "My Drive"}.", close = true) {
            mutate(targets) { api.request("/v1/drive/items/${HarborApi.segment(it.id)}/move", "POST", api.mutation(it) { put("parentId", parent?.id) }) }
        }
    }
    fun send(targets: List<DriveItem>, recipient: String) = m.action("Sent ${countLabel(targets)}. Track it in Shared → Sent.", close = true) {
        api.request("/v1/transfers", "POST", buildJsonObject {
            operation().forEach { (k, v) -> put(k, v) }
            put("recipient", recipientJson(recipient))
            put("items", JsonArray(targets.map { buildJsonObject { put("driveItemId", it.id) } }))
        })
        selected = emptySet()
    }
    fun share(item: DriveItem, recipient: String, permission: String) = m.action("Access shared.", close = true) {
        api.request("/v1/shares", "POST", buildJsonObject {
            operation().forEach { (k, v) -> put(k, v) }
            put("recipient", recipientJson(recipient)); put("driveItemId", item.id); put("permission", permission)
        })
    }
    fun createFolder(name: String) {
        if (!canWriteHere) return
        val parent = folderId
        m.action("Folder created.", close = true) {
            api.createFolder(name, parent)
            filters = DriveFilters(); m.query = ""
            refresh()
        }
    }
    fun restoreVersion(item: DriveItem, version: Version) = m.action("Restored version ${version.versionNumber} of ${item.name}.", close = true) {
        api.request("/v1/drive/items/${HarborApi.segment(item.id)}/versions/${HarborApi.segment(version.id)}/restore", "POST", api.mutation(item))
        refresh()
    }
    fun restoreLocally(item: DriveItem, version: Version) {
        val root = item.backupRootId ?: return
        m.confirm(Confirmation("Restore this local file?",
            "Replace the current local copy of ${item.name} with the version saved ${fullDate(version.createdAt)}. The archive will stay unchanged. The source computer must be online with backups running.",
            "Restore locally", "Local restore requested. Track progress in Backups → History.", danger = false, cancel = "Cancel") {
            api.request("/v1/backups/${HarborApi.segment(root)}/restores", "POST", buildJsonObject {
                put("id", UUID.randomUUID().toString()); put("itemId", item.id); put("versionId", version.id)
            })
        })
    }
    suspend fun versions(item: DriveItem): List<Version> = api.get<Page<Version>>("/v1/drive/items/${HarborApi.segment(item.id)}/versions").items
    /** Folders that can receive a move: no backups, and none of the items being moved. */
    suspend fun destinations(parent: String?, moving: List<DriveItem>): List<DriveItem> =
        api.all<DriveItem>("/v1/drive/folders/${HarborApi.segment(parent ?: "root")}/children")
            .filter { it.isFolder && it.backupRootId == null && moving.none { m -> m.id == it.id } }
            .sortedWith { a, b -> naturalCompare(a.name, b.name) }
    suspend fun locationPath(item: DriveItem): String {
        val names = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        var id = item.parentId
        while (id != null) {
            check(seen.add(id)) { "Folder path is unavailable." }
            val folder = ancestors[id] ?: api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(id)}").item.also { ancestors[it.id] = it }
            names.add(0, folder.name); id = folder.parentId
        }
        return (listOf("My Drive") + names).joinToString(" / ")
    }
    suspend fun sharing(item: DriveItem): String =
        if (api.all<Share>("/v1/shares/sent").any { it.driveItemId == item.id && it.revokedAt == null }) "Shared access" else "No direct shares"
}
