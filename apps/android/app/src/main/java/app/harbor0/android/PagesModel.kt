package app.harbor0.android

import androidx.compose.runtime.*
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToLong

/** Trash: a paged search of deleted items with restore, permanent deletion and Empty Trash. */
class TrashState(private val m: WorkspaceModel) {
    private val api get() = m.api
    var items by mutableStateOf<List<DriveItem>>(emptyList()); private set
    var page by mutableStateOf<String?>(null); private set
    var nextCursor by mutableStateOf<String?>(null); private set
    var loading by mutableStateOf(false); private set
    var loaded by mutableStateOf(false); private set
    var loadError by mutableStateOf<String?>(null); private set
    var selected by mutableStateOf<Set<String>>(emptySet())
    var grid by mutableStateOf(false)
    var loadedQuery by mutableStateOf<String?>(null); private set
    private var job: Job? = null
    fun reset() { job?.cancel(); items = emptyList(); page = null; nextCursor = null; loaded = false; loadError = null; selected = emptySet() }
    fun refresh(cursor: String? = page) {
        job?.cancel()
        if (cursor != page) { loaded = false; items = emptyList() }
        page = cursor
        val query = m.query.trim().takeIf { it.isNotEmpty() }
        loadedQuery = query.orEmpty()
        job = m.viewModelScope.launch {
            loading = true; loadError = null
            try {
                val result = api.get<Page<DriveItem>>(withQuery("/v1/search", "q" to query, "trash" to "true", "cursor" to cursor))
                items = result.items; nextCursor = result.nextCursor; loaded = true
                selected = selected.filter { id -> result.items.any { it.id == id } }.toSet()
            } catch (e: CancellationException) { throw e } catch (e: Exception) { loadError = m.message(e) }
            finally { loading = false }
        }
    }
    val selection get() = items.filter { it.id in selected }
    fun restore(targets: List<DriveItem>) = m.action(close = true) {
        val errors = mutableListOf<String>()
        for (item in targets) try {
            api.request("/v1/drive/items/${HarborApi.segment(item.id)}/restore", "POST", api.mutation(item))
            items = items.filter { it.id != item.id }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { errors += "Could not save “${item.name}”. ${m.message(e)}" }
        selected = emptySet(); refresh(); m.drive.refresh()
        if (errors.isNotEmpty()) error(errors.joinToString(" "))
    }
    fun deletePermanently(targets: List<DriveItem>) = m.confirm(Confirmation(
        if (targets.size > 1) "Delete ${targets.size} items permanently?" else "Delete ${targets.firstOrNull()?.name ?: "this item"} permanently?",
        "This removes the selected items and their version history, and cannot be undone. Content needed by your sent transfers remains stored and counted until those transfers are cancelled or expire.",
        "Delete permanently", cancel = "Cancel") {
        val errors = mutableListOf<String>()
        for (item in targets) try {
            api.request("/v1/drive/items/${HarborApi.segment(item.id)}/permanent", "DELETE", api.mutation(item))
            items = items.filter { it.id != item.id }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { errors += "Could not save “${item.name}”. ${m.message(e)}" }
        selected = emptySet(); refresh(); m.refreshAccount()
        if (errors.isNotEmpty()) error(errors.joinToString(" "))
    })
    fun empty() = m.confirm(Confirmation("Empty Trash?",
        "Permanently delete all items in Trash, including items on other pages and their version history? This cannot be undone. Content needed by sent transfers remains stored until those transfers end.",
        "Empty Trash", "Trash emptied.", cancel = "Cancel") {
        api.emptyTrash(); selected = emptySet(); refresh(null); m.refreshAccount()
    })
}

/** Shared: transfers received or sent, with the shared-access list underneath. */
class SharedState(private val m: WorkspaceModel) {
    private val api get() = m.api
    var tab by mutableStateOf("Received"); private set
    var transfers by mutableStateOf(Loadable<List<Transfer>>()); private set
    var page by mutableStateOf<String?>(null); private set
    var nextCursor by mutableStateOf<String?>(null); private set
    var shares by mutableStateOf(Loadable<List<Share>>()); private set
    /** Extra manifest entries loaded with “Show more files”, and the cursor for the next page. */
    var entries by mutableStateOf<Map<String, Pair<List<ManifestEntry>, String?>>>(emptyMap()); private set
    var entriesLoading by mutableStateOf<String?>(null); private set
    private var job: Job? = null
    fun reset() { job?.cancel(); tab = "Received"; transfers = Loadable(); shares = Loadable(); page = null; nextCursor = null; entries = emptyMap() }
    fun select(next: String) { if (next == tab) return; tab = next; page = null; transfers = Loadable(); shares = Loadable(); entries = emptyMap(); refresh() }
    fun refresh(cursor: String? = page) {
        job?.cancel()
        if (cursor != page) transfers = Loadable()
        page = cursor
        val direction = tab.lowercase()
        job = m.viewModelScope.launch {
            transfers = transfers.copy(loading = true, error = null)
            try {
                val result = api.get<Page<Transfer>>(withQuery("/v1/transfers/$direction", "cursor" to cursor))
                transfers = Loadable(result.items); nextCursor = result.nextCursor
            } catch (e: CancellationException) { throw e } catch (e: Exception) { transfers = transfers.copy(loading = false, error = m.message(e)) }
            shares = shares.copy(loading = true, error = null)
            try { shares = Loadable(api.get<Page<Share>>("/v1/shares/$direction").items.filter { it.item != null && it.revokedAt == null }) }
            catch (e: CancellationException) { throw e } catch (e: Exception) { shares = shares.copy(loading = false, error = m.message(e)) }
        }
    }
    fun moreEntries(transfer: Transfer) {
        val cursor = entries[transfer.id]?.second ?: transfer.nextEntryCursor ?: return
        entriesLoading = transfer.id
        m.viewModelScope.launch {
            try {
                val result = api.get<Page<ManifestEntry>>(withQuery("/v1/transfers/${HarborApi.segment(transfer.id)}/items", "cursor" to cursor))
                entries = entries + (transfer.id to ((entries[transfer.id]?.first.orEmpty() + result.items) to result.nextCursor))
            } catch (e: CancellationException) { throw e } catch (e: Exception) { m.report(e) }
            finally { entriesLoading = null }
        }
    }
    fun act(transfer: Transfer, action: String) {
        val path = "/v1/transfers/${HarborApi.segment(transfer.id)}/$action"
        // Declining or cancelling cannot be undone, so ask first.
        if (action == "decline" || action == "cancel") return m.confirm(Confirmation(
            if (action == "decline") "Decline this transfer?" else "Cancel this transfer?",
            if (action == "decline") "You won’t be able to download these files unless they are sent again." else "The recipient will no longer be able to accept or download these files.",
            if (action == "decline") "Decline transfer" else "Cancel transfer", if (action == "decline") "Transfer declined." else "Transfer cancelled.") {
            api.request(path, "POST", operation()); refresh()
        })
        m.action(if (action == "save") "Saving to My Drive. Large folders finish in the background." else "Transfer accepted. You can now download or save the files.") {
            api.request(path, "POST", buildJsonObject {
                operation().forEach { (k, v) -> put(k, v) }
                if (action == "save") put("targetParentId", JsonNull)
            })
            refresh()
        }
    }
    fun download(transfer: Transfer, entry: ManifestEntry) = m.downloadToDevice(entry.displayName, buildJsonObject {
        put("transferId", transfer.id); put("entryId", entry.id)
    }, entry.mimeType)
    fun removeAccess(share: Share) = m.confirm(Confirmation("Remove access to ${share.item?.name}?",
        "The person you shared this with will no longer be able to open it.", "Remove access", "Access removed.") {
        api.request("/v1/shares/${HarborApi.segment(share.id)}", "DELETE", operation()); refresh()
    })
}
fun transferStatus(t: Transfer, received: Boolean): Pair<String, Tone> {
    val label = when {
        t.preparationState == "BUILDING" -> "Preparing files"
        t.preparationState == "FAILED" -> "Preparation failed"
        t.saveState == "SAVING" -> "Saving…"
        t.savedAt != null -> "Saved to My Drive"
        else -> when (t.state) {
            "PENDING_RECIPIENT_SIGNUP" -> "Waiting for sign-up"; "PENDING" -> if (received) "Waiting for you" else "Waiting for recipient"
            "ACCEPTED" -> "Accepted"; "DECLINED" -> "Declined"; "CANCELLED" -> "Cancelled"; "EXPIRED" -> "Expired"; else -> t.state
        }
    }
    val tone = when { t.preparationState == "FAILED" -> Tone.Danger; t.state == "ACCEPTED" -> Tone.Success; t.state.startsWith("PENDING") -> Tone.Accent; else -> Tone.Neutral }
    return label to tone
}

/** Relative time as the web backups page shows it: “5 minutes ago”, “yesterday”, “on Sep 30, 2026”. */
fun ago(iso: String, now: Long = System.currentTimeMillis()): String {
    val time = runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull() ?: return iso
    val minutes = ((time - now) / 60000.0).roundToLong()
    fun unit(value: Long, name: String) = if (value < 0) (if (value == -1L && name == "day") "yesterday" else "${-value} $name${if (value == -1L) "" else "s"} ago")
        else (if (value == 1L && name == "day") "tomorrow" else "in $value $name${if (value == 1L) "" else "s"}")
    if (abs(minutes) < 1) return "just now"
    if (abs(minutes) < 60) return unit(minutes, "minute")
    val hours = (minutes / 60.0).roundToLong()
    if (abs(hours) < 24) return unit(hours, "hour")
    val days = (hours / 24.0).roundToLong()
    return if (abs(days) < 7) unit(days, "day") else "on ${dateLabel(iso, time = true)}"
}

/** Backups: the folder list and one folder's files, versions, runs and restores, as the web backups page. */
class BackupsState(private val m: WorkspaceModel) {
    private val api get() = m.api
    var roots by mutableStateOf<List<BackupRoot>>(emptyList()); private set
    var loaded by mutableStateOf(false); private set
    var loadError by mutableStateOf<String?>(null); private set
    var rootId by mutableStateOf<String?>(null); private set
    var tab by mutableStateOf("Files")
    var trail by mutableStateOf<List<DriveItem>>(emptyList()); private set
    var items by mutableStateOf<List<DriveItem>?>(null); private set
    var runs by mutableStateOf<List<BackupRun>?>(null); private set
    var restores by mutableStateOf<List<BackupRestore>>(emptyList()); private set
    var expandedRun by mutableStateOf<String?>(null); private set
    var runFiles by mutableStateOf<List<BackupEntry>?>(null); private set
    var filter by mutableStateOf("")
    private var jobs = mutableListOf<Job>()
    val root get() = roots.firstOrNull { it.id == rootId }
    val removed get() = root?.state == "REMOVED"
    val archived get() = root?.state == "ARCHIVED"
    val canGoBack get() = rootId != null
    fun reset() { close(); roots = emptyList(); loaded = false; loadError = null }
    fun close() { jobs.forEach { it.cancel() }; rootId = null; trail = emptyList(); items = null; runs = null; restores = emptyList(); expandedRun = null; runFiles = null; tab = "Files" }
    fun back() { if (trail.isNotEmpty()) openFolder(trail.dropLast(1)) else close() }
    private fun launch(block: suspend CoroutineScope.() -> Unit) { jobs += m.viewModelScope.launch(block = block) }
    fun refresh() {
        launch {
            try {
                // Active folders first; stopped backups stay listed so their history remains reachable.
                roots = api.all<BackupRoot>("/v1/backups").sortedWith(compareBy<BackupRoot> { it.state == "REMOVED" }.thenBy { it.localPathDisplayName.lowercase() })
                loaded = true; loadError = null
                if (rootId != null && roots.none { it.id == rootId }) close()
            } catch (e: CancellationException) { throw e } catch (e: Exception) { loadError = m.message(e); loaded = true }
        }
        if (rootId != null) { loadFolder(); loadHistory() }
    }
    fun open(id: String) { close(); rootId = id; loadFolder(); loadHistory() }
    fun openFolder(next: List<DriveItem>) { trail = next; items = null; loadFolder() }
    private fun loadFolder() {
        val folder = trail.lastOrNull()?.id ?: root?.remoteRootDriveItemId ?: return
        launch {
            try {
                items = api.all<DriveItem>("/v1/drive/folders/${HarborApi.segment(folder)}/children")
                    .sortedWith { a, b -> if (a.isFolder != b.isFolder) (if (a.isFolder) -1 else 1) else a.name.compareTo(b.name) }
            } catch (e: CancellationException) { throw e } catch (e: Exception) { m.report(e) }
        }
    }
    private fun loadHistory() {
        val id = rootId ?: return
        launch {
            try {
                runs = api.all<BackupRun>("/v1/backups/${HarborApi.segment(id)}/runs").sortedByDescending { it.startedAt }
                restores = api.all<BackupRestore>("/v1/backups/${HarborApi.segment(id)}/restores").sortedByDescending { it.requestedAt }
            } catch (e: CancellationException) { throw e } catch (e: Exception) { m.report(e) }
        }
    }
    fun toggleRun(run: BackupRun) {
        if (expandedRun == run.id) { expandedRun = null; return }
        expandedRun = run.id; runFiles = null
        val id = rootId ?: return
        launch {
            try { runFiles = api.all<BackupEntry>("/v1/backups/${HarborApi.segment(id)}/runs/${HarborApi.segment(run.id)}/files") }
            catch (e: CancellationException) { throw e } catch (e: Exception) { m.report(e) }
        }
    }
    val deviceName get() = root?.deviceName ?: "the source computer"
    /** The folder's status badge and explanation, from its state and latest runs. */
    fun status(): Triple<String, Tone, String> {
        val r = root ?: return Triple("", Tone.Success, "")
        val latest = runs?.firstOrNull()
        val good = runs?.firstOrNull { it.state == "COMPLETED" || it.state == "PARTIAL" }
        return when {
            removed -> Triple("Stopped", Tone.Neutral, "No new versions are saved. The backed-up files are now regular files in My Drive → Cloud.")
            archived -> Triple("Archived", Tone.Neutral, "Backups are stopped and the folder was removed from $deviceName. Its files and versions are kept here.")
            r.state == "PAUSED" -> Triple("Paused", Tone.Neutral, "No new versions are saved until you resume. Saved versions are still here.")
            latest?.state == "RUNNING" -> Triple("Backing up", Tone.Accent, "Saving ${plural(latest.fileCount, "file")} so far…")
            r.state == "ERROR" || latest?.state == "FAILED" -> Triple("Needs attention", Tone.Danger,
                latest?.error?.let { "The last backup didn’t finish: $it" } ?: "The last backup didn’t finish. It will try again automatically.")
            good != null -> Triple(if (latest?.state == "PARTIAL") "Some files skipped" else "Backed up", if (latest?.state == "PARTIAL") Tone.Danger else Tone.Success,
                "Last backed up ${ago(good.completedAt ?: good.startedAt)}.")
            else -> Triple("Waiting", Tone.Success, if (runs == null) "Checking backup status…" else "The first backup runs once files have been unchanged for an hour.")
        }
    }
    fun rootStatus(value: BackupRoot): Pair<String, Tone> = when {
        value.id == rootId -> status().let { it.first to it.second }
        value.state == "REMOVED" -> "Stopped" to Tone.Neutral
        value.state == "ARCHIVED" -> "Archived" to Tone.Neutral
        value.state == "PAUSED" -> "Paused" to Tone.Neutral
        value.state == "ERROR" -> "Needs attention" to Tone.Danger
        else -> "On" to Tone.Success
    }
    fun stop() {
        val r = root ?: return
        m.confirm(Confirmation("Stop backing up ${r.localPathDisplayName}?",
            "No new versions will be saved. Everything already backed up moves to My Drive → Cloud as regular files. Nothing on your computer is deleted.",
            "Stop backing up", "Stopped backing up ${r.localPathDisplayName}. Its files are in My Drive → Cloud.", cancel = "Keep backing up") {
            api.request("/v1/backups/${HarborApi.segment(r.id)}", "DELETE"); refresh()
        })
    }
    fun remove() {
        val r = root ?: return
        m.confirm(Confirmation("Remove ${r.localPathDisplayName} from Backups?",
            "This removes the folder and its backup history from this list. Its files stay in My Drive → Cloud, and nothing on your computer is deleted.",
            "Remove", "Removed ${r.localPathDisplayName} from Backups.", cancel = "Cancel") {
            api.request("/v1/backups/${HarborApi.segment(r.id)}/forget", "POST"); close(); refresh()
        })
    }
    fun restore(itemId: String, versionId: String, name: String, createdAt: String) {
        val r = root ?: return
        m.confirm(Confirmation("Restore $name?", "The copy of $name on $deviceName will be replaced with the version from ${dateLabel(createdAt, time = true)}.",
            "Restore", "Restoring $name. Follow its progress in History.", danger = false, cancel = "Cancel",
            note = "If $deviceName is offline, the restore happens the next time it’s online. To keep both, download this version instead.") {
            api.request("/v1/backups/${HarborApi.segment(r.id)}/restores", "POST", buildJsonObject {
                put("id", UUID.randomUUID().toString()); put("itemId", itemId); put("versionId", versionId)
            })
            loadHistory()
        })
    }
    fun download(itemId: String, versionId: String, name: String) = m.downloadToDevice(name, buildJsonObject {
        put("driveItemId", itemId); put("versionId", versionId)
    }, null)
    suspend fun versions(item: DriveItem) = m.drive.versions(item)
}

/** Search results shown in place on pages without their own search (Shared, Backups, Devices…), as the web does. */
class SearchState(private val m: WorkspaceModel) {
    private val api get() = m.api
    var items by mutableStateOf<List<DriveItem>>(emptyList()); private set
    var page by mutableStateOf<String?>(null); private set
    var nextCursor by mutableStateOf<String?>(null); private set
    var loading by mutableStateOf(false); private set
    var loaded by mutableStateOf(false); private set
    var loadError by mutableStateOf<String?>(null); private set
    var loadedQuery by mutableStateOf<String?>(null); private set
    var grid by mutableStateOf(false)
    private var job: Job? = null
    fun reset() { job?.cancel(); items = emptyList(); page = null; nextCursor = null; loaded = false; loadError = null; loadedQuery = null; loading = false }
    fun refresh(cursor: String? = page) {
        val query = m.query.trim()
        job?.cancel()
        if (query.isEmpty()) return reset()
        if (query != loadedQuery || cursor != page) { loaded = false; items = emptyList() }
        page = cursor; loadedQuery = query
        job = m.viewModelScope.launch {
            loading = true; loadError = null
            try {
                val result = api.get<Page<DriveItem>>(withQuery("/v1/search", "q" to query, "cursor" to cursor))
                items = result.items; nextCursor = result.nextCursor; loaded = true
            } catch (e: CancellationException) { throw e } catch (e: Exception) { loadError = m.message(e) }
            finally { loading = false }
        }
    }
}
