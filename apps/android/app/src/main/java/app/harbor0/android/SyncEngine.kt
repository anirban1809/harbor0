package app.harbor0.android

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.IOException
import java.time.Instant
import java.time.LocalDateTime
import java.util.UUID

/** Everything the sync screens show: engine state plus the folders and queue it is working on. */
data class SyncView(val runtime: SyncRuntime = SyncRuntime(), val roots: List<SyncRoot> = emptyList(), val jobs: List<SyncJobView> = emptyList(),
    val counts: Map<String, Pair<Int, Int>> = emptyMap(), val deviceId: String = "")

/**
 * The sync engine, ported from desktop `sync.ts`. One instance per signed-in account. All of its work runs on one
 * thread, so (as in the desktop's JavaScript) state is only interleaved at suspension points.
 *
 * Differences from desktop: local changes are found by comparing each folder with its last scan instead of a file
 * watcher, and local folders are Storage Access Framework document trees.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SyncEngine(private val api: HarborApi, val journal: SyncJournal, val deviceId: String, private val treeFor: (SyncRoot) -> LocalTree,
    private val transfers: SyncTransfers, private val scope: CoroutineScope, private val deviceName: () -> String) {
    val dispatcher = Dispatchers.IO.limitedParallelism(1)
    private val trees = mutableMapOf<String, Pair<String, LocalTree>>()
    private fun tree(root: SyncRoot): LocalTree = trees[root.id]?.takeIf { it.first == root.treeUri }?.second ?: treeFor(root).also { trees[root.id] = root.treeUri to it }
    private val receipts = SyncReceipts(api, journal, ::tree)
    private val backups = FolderBackups(api, journal, transfers, ::tree)
    private var loop: Job? = null
    private var confirmationWork: Job? = null
    private var publishWork: Job? = null
    private val wakeups = Channel<Unit>(Channel.CONFLATED)
    private val mutation = Mutex()
    private val passes = MutableStateFlow(0L)
    private var running = false
    @Volatile private var stopped = true
    private var lastProgressEmit = 0L
    private var currentRootId = ""
    private var publishedFolders = ""
    private var publishingFolders = false
    private var publishRetryAt = 0L
    private var publishedAt = 0L
    private val removedRemoteIds = mutableSetOf<String>()
    private var nextConfirmationAt = 0L
    private val rootRetry = mutableMapOf<String, Pair<Int, Long>>()
    private val waiting = linkedMapOf<String, WaitingItem>()
    private var remoteDelay = REMOTE_POLL_MIN
    private var nextRemoteAt = 0L
    private var checkpointed: Long? = null
    @Volatile private var hurried = false
    private val nextScanAt = mutableMapOf<String, Long>()
    /** While the app is on screen, local folders are rescanned every few seconds; otherwise once a minute. */
    @Volatile var foreground = true
    private var st = SyncRuntime()
    private val _view = MutableStateFlow(SyncView(deviceId = deviceId))
    val view: StateFlow<SyncView> = _view.asStateFlow()

    init {
        st = st.copy(lastSync = journal.get<String>("lastSync"),
            // An ended session returns the app to sign-in by itself; never restore that as a sync problem.
            issues = journal.get<List<SyncIssue>>("syncIssues").orEmpty().filter { it.code != IssueCode.AUTH_INVALID },
            recent = journal.get<List<SyncActivityItem>>("syncRecent").orEmpty(), paused = journal.get<Boolean>("paused") ?: false)
    }
    private fun roots() = journal.roots()
    private fun ignored(root: SyncRoot, relative: String) = ignoredPath(root.excluded, relative)

    // Lifecycle -----------------------------------------------------------------------------------
    suspend fun start() = withContext(dispatcher) {
        if (!stopped) return@withContext
        stopped = false
        nextConfirmationAt = 0; remoteDelay = REMOTE_POLL_MIN; nextRemoteAt = 0
        for (root in roots()) {
            var current = root
            if (current.mode == "sync" && current.remoteId == null) {
                current = current.copy(paused = true); journal.root(current)
                st = st.copy(issues = st.issues.filter { it.rootId != current.id || stickyIssue(it) } + SyncIssue("${current.id}:mapping", current.id,
                    IssueCode.MAPPING_REQUIRED, "Choose a cloud folder for this local folder before syncing resumes.", at = now()))
                persistIssues()
            }
            if (current.mode == "sync") journal.root(current.copy(needsReconcile = true))
        }
        loop = scope.launch(dispatcher) {
            while (isActive && !stopped) {
                run()
                // Checks every 2s, or sooner when woken; a short settle batches bursts of wake-ups.
                if (withTimeoutOrNull(REMOTE_POLL_MIN) { wakeups.receive() } != null) delay(150)
            }
        }
        emit()
    }
    suspend fun stop() {
        withContext(dispatcher) { stopped = true }
        confirmationWork?.cancelAndJoin()
        loop?.cancelAndJoin()
        publishWork?.cancelAndJoin()
        deferredEmit?.cancelAndJoin()
        withContext(dispatcher) { running = false; st = st.copy(running = false, active = null); lastFullEmit = 0; emit(); passes.value++ }
    }
    /** Runs one complete pass now (including the server check) and returns when it has finished. */
    suspend fun tick() {
        if (stopped) return
        // A pass already under way may have checked the server before this request; wait for the next one too.
        val target = withContext(dispatcher) { hurry(); nextScanAt.clear(); passes.value + if (running) 2 else 1 }
        wakeups.trySend(Unit)
        withTimeoutOrNull(9 * 60_000L) { passes.first { it >= target || stopped } }
    }
    // The next pass checks the server instead of waiting out the idle backoff.
    private fun hurry() { hurried = true; remoteDelay = REMOTE_POLL_MIN; nextRemoteAt = 0; receipts.nudge() }
    /** Check the server and rescan local folders now, e.g. when the app returns to the foreground. */
    fun wake() { scope.launch(dispatcher) { hurry(); nextScanAt.clear(); wakeups.trySend(Unit) } }
    suspend fun pause(paused: Boolean) = withContext(dispatcher) {
        st = st.copy(paused = paused); journal.set("paused", paused)
        if (!paused) {
            for (root in roots()) if (root.mode == "sync") journal.root(root.copy(needsReconcile = true))
            // Resuming is also the user's way to retry failed work now.
            rootRetry.clear(); hurry()
            for (job in journal.jobs()) if (job.payload.retryAt != null) { job.payload.retryAt = null; journal.saveJob(job) }
            wakeups.trySend(Unit)
        }
        emit()
    }
    /** Retries one failed file now. */
    suspend fun retry(jobId: String) = withContext(dispatcher) {
        journal.job(jobId)?.let { it.payload.retryAt = null; it.payload.retryAfter = null; journal.saveJob(it) }
        rootRetry.clear(); hurry(); wakeups.trySend(Unit); emit()
    }

    private var lastFullEmit = 0L
    private var deferredEmit: Job? = null
    /** Publishes state. Folder and queue listings are re-read at most every 300ms; runtime changes go out at once. */
    private fun emit(progressOnly: Boolean = false) {
        val time = System.currentTimeMillis()
        if (progressOnly && time - lastProgressEmit < 150) return
        lastProgressEmit = time
        val runtime = st.copy(queued = journal.jobCount(), waiting = waiting.values.toList())
        if (progressOnly || time - lastFullEmit < 300) {
            _view.value = _view.value.copy(runtime = runtime)
            if (!progressOnly && deferredEmit?.isActive != true) deferredEmit = scope.launch(dispatcher) { delay(300); emit() }
            return
        }
        lastFullEmit = time
        val roots = roots()
        _view.value = SyncView(runtime, roots, journal.jobViews(), roots.associate { it.id to journal.fileCounts(it.id) }, deviceId)
    }

    // Configuration ---------------------------------------------------------------------------------
    fun validateRoot(root: SyncRoot, treeUri: android.net.Uri) {
        if (root.mode == "sync" && root.remoteId == null) throw IllegalStateException("Choose a cloud folder before syncing.")
        for (other in roots().filter { it.id != root.id }) {
            if (treesOverlap(android.net.Uri.parse(other.treeUri), treeUri)) throw IllegalStateException("Sync and backup folders must not overlap.")
            if (root.mode == "sync" && other.mode == "sync" && root.remoteId == other.remoteId) throw IllegalStateException("This cloud folder is already synced on this phone.")
        }
    }
    private suspend fun changeConfiguration(change: suspend () -> Unit) = mutation.withLock {
        // Finish the current step before detaching its mapping; no files are deleted.
        stop()
        try { withContext(dispatcher) { change() } } finally { start() }
    }
    suspend fun addRoot(root: SyncRoot) = changeConfiguration {
        validateRoot(root, android.net.Uri.parse(root.treeUri))
        journal.root(root.copy(needsReconcile = root.mode == "sync"))
    }
    suspend fun updateRoot(root: SyncRoot) = changeConfiguration {
        validateRoot(root, android.net.Uri.parse(root.treeUri))
        val previous = journal.root(root.id) ?: throw IllegalStateException("Folder was not found.")
        if (previous.treeUri != root.treeUri || previous.remoteId != root.remoteId) journal.resetRootFiles(root.id)
        // Newly excluded paths stop syncing; newly included ones are picked up by the next scan.
        if (previous.excluded != root.excluded) journal.replaceSnapshot(root.id, journal.snapshot(root.id).filterKeys { !excludedPath(root.excluded, it) && !excludedPath(previous.excluded, it) })
        journal.root(root.copy(needsReconcile = root.mode == "sync"))
        rootRetry.remove(root.id); nextScanAt.remove(root.id)
        st = st.copy(issues = st.issues.filter { it.rootId != root.id || stickyIssue(it) }); persistIssues()
    }
    suspend fun removeRoot(id: String) = changeConfiguration {
        journal.removeRoot(id); trees.remove(id); forgetWaiting(id)
        st = st.copy(issues = st.issues.filter { it.rootId != id }); persistIssues()
        publishedFolders = ""
    }
    suspend fun removeSyncedFolder(folderId: String) {
        api.request("/v1/sync/folders/${HarborApi.segment(folderId)}", "DELETE")
        changeConfiguration {
            for (root in roots()) {
                if (root.mode != "sync") continue
                if (root.remoteId == folderId) journal.removeRoot(root.id) else excludeRemovedFolder(root, folderId)
            }
            val ids = roots().map { it.id }.toSet()
            st = st.copy(issues = st.issues.filter { it.rootId in ids }); persistIssues()
            publishedFolders = ""
        }
    }
    suspend fun disconnectBackup(id: String) {
        val root = journal.root(id)?.takeIf { it.mode == "backup" } ?: throw IllegalStateException("Backup folder was not found on this phone.")
        val backup = api.all<BackupRoot>("/v1/backups").firstOrNull { it.remoteRootDriveItemId == root.remoteId } ?: throw IllegalStateException("Backup connection was not found.")
        api.request("/v1/backups/${HarborApi.segment(backup.id)}", "DELETE")
        removeRoot(root.id)
    }
    /** Archive: one last full backup, then the local copy is removed and only the cloud copy stays. */
    suspend fun archiveBackup(id: String, archived: Boolean) = withContext(dispatcher) {
        val root = journal.root(id)?.takeIf { it.mode == "backup" } ?: throw IllegalStateException("Backup folder was not found on this phone.")
        if (st.paused || root.paused) throw IllegalStateException("Resume backups before ${if (archived) "archiving" else "restoring"} this folder.")
        if (archived) {
            if (root.archive != null) throw IllegalStateException("This folder is already archived.")
            journal.root(root.copy(archive = "pending", archiveError = null))
            journal.set("backup-now:${root.id}", true)
        } else {
            if (root.archive != "archived") throw IllegalStateException("This folder is not archived.")
            journal.root(root.copy(archive = "restoring"))
        }
        emit(); hurry(); wakeups.trySend(Unit)
    }
    suspend fun backupNow(id: String) = withContext(dispatcher) {
        val root = journal.root(id)?.takeIf { it.mode == "backup" } ?: throw IllegalStateException("Backup folder was not found on this phone.")
        if (st.paused) throw IllegalStateException("Resume backups before backing up now.")
        if (root.archive != null) throw IllegalStateException("Restore this archived folder before backing up.")
        backups.request(root)
        emit(); hurry(); wakeups.trySend(Unit)
    }
    suspend fun dismissConflict(id: String) = withContext(dispatcher) {
        st = st.copy(issues = st.issues.filter { it.id != id || !stickyIssue(it) }); persistIssues(); emit()
    }
    private fun excludeRemovedFolder(root: SyncRoot, folderId: String) {
        val known = journal.fileByItem(root.id, folderId)
        if (known == null || known.type != "FOLDER") return
        journal.root(root.copy(excluded = (root.excluded + known.relativePath).distinct()))
        for (job in journal.jobs(root.id)) if (job.relativePath == known.relativePath || job.relativePath.startsWith(known.relativePath + "/")) journal.finish(job.id)
        for (file in journal.files(root.id)) if (file.relativePath == known.relativePath || file.relativePath.startsWith(known.relativePath + "/")) journal.deleteFile(root.id, file.relativePath)
    }
    private fun detachRoot(root: SyncRoot) {
        journal.removeRoot(root.id); trees.remove(root.id)
        forgetWaiting(root.id)
        st = st.copy(issues = st.issues.filter { it.rootId != root.id }); persistIssues()
        emit()
    }
    private fun persistIssues() { journal.set("syncIssues", st.issues) }
    private fun forgetWaiting(rootId: String) { waiting.entries.removeAll { it.value.rootId == rootId } }

    // Errors and activity ---------------------------------------------------------------------------
    // Errors that are not about one file or folder: stop the pass and retry everything later.
    private fun interrupts(error: Throwable): Boolean = when (error) {
        is ApiException -> error.status >= 500 || error.status == 429 || error.code in listOf("AUTH_INVALID", "DEVICE_REVOKED", "SYNC_REMOVED", "SYNC_CURSOR_EXPIRED")
        is LocalReadException -> false
        is IOException -> true
        else -> false
    }
    private fun offline(error: Throwable) = error is IOException && error !is LocalReadException
    private fun rootFailed(root: SyncRoot, error: Throwable) {
        val attempts = (rootRetry[root.id]?.first ?: 0) + 1
        rootRetry[root.id] = attempts to System.currentTimeMillis() + retryDelay(attempts)
        // A full reconcile repairs whatever this pass could not apply.
        journal.root(root.id)?.takeIf { !it.needsReconcile }?.let { journal.root(it.copy(needsReconcile = true)) }
        issue(root.id, error)
    }
    private fun issue(rootId: String, error: Throwable, relativePath: String? = null, jobId: String? = null) {
        // Errors below the folder itself concern one item, not the folder's own access.
        val inside = (error as? LocalFsException)?.relativePath?.takeIf { it.isNotEmpty() }
        val item = jobId != null || inside != null
        val code = syncIssueCode(error, item)
        st = st.copy(issues = st.issues.filter { it.rootId != rootId || stickyIssue(it) || (if (jobId != null) it.jobId != jobId else it.jobId != null) } +
            SyncIssue(if (jobId != null) "job:$jobId" else "$rootId:$code", rootId, code, error.message ?: "A change could not be synchronized.",
                relativePath ?: inside, jobId = jobId, scope = if (item) "item" else null, at = now()))
        persistIssues(); emit()
    }
    private fun now() = Instant.now().toString()
    private fun recovered(root: SyncRoot, relativePath: String, recoveredPath: String) {
        st = st.copy(issues = st.issues + SyncIssue(UUID.randomUUID().toString(), root.id, IssueCode.FOLDER_RECOVERED,
            "This folder was removed from sync elsewhere. The copy on this phone was kept under a new name and no longer syncs.", relativePath, recoveredPath, at = now()))
        persistIssues(); emit()
    }
    private fun conflict(root: SyncRoot, relativePath: String, conflictPath: String) {
        st = st.copy(issues = st.issues + SyncIssue(UUID.randomUUID().toString(), root.id, IssueCode.CONFLICT,
            "This file changed in more than one place. Your local version has been preserved separately.", relativePath, conflictPath, at = now()))
        persistIssues(); emit()
    }
    private fun activity(root: SyncRoot, relativePath: String, direction: String, item: DriveItem? = null) {
        val at = now()
        st = st.copy(recent = (listOf(SyncActivityItem(UUID.randomUUID().toString(), root.id, direction, relativePath, at, item?.id, item?.name)) + st.recent).take(30))
        journal.set("syncRecent", st.recent)
        journal.root(root.id)?.let { journal.root(it.copy(lastSyncedAt = at)) }
        // Upload jobs remain active until their queue entry has been removed.
        if (direction == "download") { st = st.copy(active = null); emit() }
    }
    private fun progress(root: SyncRoot, direction: String, relativePath: String, loaded: Long, total: Long) {
        st = st.copy(active = SyncProgress(root.id, direction, relativePath, loaded, total))
        if (direction == "upload" && total > 0) st = st.copy(message = "Uploading ${(loaded * 100 / maxOf(1, total))}%")
        emit(loaded < total)
    }
    private fun checkRoot(root: SyncRoot): Boolean = try { tree(root).check(); true } catch (e: LocalFsException) {
        if (root.mode == "sync") journal.root(root.copy(needsReconcile = true))
        issue(root.id, e); false
    }

    // Local changes ------------------------------------------------------------------------------------
    /** Compares a folder with its last scan and queues what changed, as desktop's watcher events would. */
    private fun scan(root: SyncRoot) {
        val due = nextScanAt[root.id] ?: 0
        if (System.currentTimeMillis() < due) return
        val started = System.currentTimeMillis()
        val current = scanTree(tree(root), root.excluded) { stopped } ?: return
        val previous = journal.snapshot(root.id)
        val changes = diffSnapshot(previous, current)
        if (changes.isNotEmpty()) journal.transaction {
            for (change in changes) {
                if (ignored(root, change.relativePath)) continue
                journal.enqueue(root.id, change.relativePath, change.kind, change.stat?.let { JobEntry(if (it.folder) "FOLDER" else "FILE", it.size, it.mtime) },
                    if (root.mode == "backup" && change.changed) System.currentTimeMillis() else null)
            }
            journal.replaceSnapshot(root.id, current)
        }
        if (changes.isNotEmpty()) { hurry(); emit() }
        // Large folders are scanned less often so scanning never dominates the phone's work.
        val took = System.currentTimeMillis() - started
        nextScanAt[root.id] = System.currentTimeMillis() + maxOf(if (foreground) 5_000L else 60_000L, took * 4)
    }

    // Server checks -------------------------------------------------------------------------------------
    // Folder paths resolved during the current pass, so deep trees do not refetch every ancestor for each file.
    private val folderPaths = mutableMapOf<String, String>()
    private suspend fun relative(root: SyncRoot, item: DriveItem): String? {
        val segments = mutableListOf(safeSegment(item.name, item.id))
        var parentId = item.parentId
        var depth = 0
        while (parentId != root.remoteId) {
            if (parentId == null || depth++ > 32) return null
            folderPaths["${root.id}:$parentId"]?.let { segments.add(0, it); break }
            val parent = api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(parentId)}").item
            segments.add(0, safeSegment(parent.name, parent.id))
            parentId = parent.parentId
        }
        return segments.joinToString("/").also { if (item.isFolder && item.deletedAt == null) folderPaths["${root.id}:${item.id}"] = it }
    }
    suspend fun reconcile(root: SyncRoot) {
        if (root.mode == "backup" || root.paused || st.paused || stopped) return
        val seen = mutableSetOf<String>()
        forgetWaiting(root.id)
        suspend fun walk(parent: String): Boolean {
            var cursor: String? = null
            do {
                val page = api.list(parent, cursor)
                for (item in page.items) {
                    if (stopped || st.paused) return false
                    seen += item.id
                    val relative = relative(root, item)
                    if (relative == null || ignored(root, relative)) continue
                    val known = journal.fileByItem(root.id, item.id)
                    val pending = journal.hasJob(root.id, relative)
                    // A shared-folder scan can be triggered by an unrelated sibling edit.
                    // Do not overwrite this device's queued edits/deletes when this item is unchanged.
                    if (!(pending && known != null && known.revision == item.revision && known.relativePath == relative && item.cloudState != "REQUESTED")) remoteItem(root, item)
                    if (item.isFolder && !walk(item.id)) return false
                }
                cursor = page.nextCursor
            } while (cursor != null)
            return true
        }
        val rootItem = api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(root.remoteId!!)}").item
        receipts.queue(root, ".", rootItem, null)
        if (!walk(root.remoteId)) return
        // Paused or unavailable folders can miss feed events while other folders advance the device cursor.
        // Check tracked items absent from the current subtree.
        for (known in journal.files(root.id)) {
            if (stopped || st.paused) return
            if (known.itemId in seen || ignored(root, known.relativePath)) continue
            try {
                remoteItem(root, api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(known.itemId)}").item)
            } catch (e: ApiException) {
                if (e.code == "SYNC_REMOVED") continue
                if (e.code !in listOf("ITEM_NOT_FOUND", "PARENT_NOT_FOUND") + if (root.shareId != null) listOf("FORBIDDEN") else emptyList()) throw e
                if (root.shareId != null) api.request("/v1/sync/shares/${HarborApi.segment(root.shareId)}/status")
                remoteItem(root, DriveItem(known.itemId, "", known.type, revision = known.revision + 1, deletedAt = now()))
            }
        }
    }
    private suspend fun publishSyncFolders() {
        val folderIds = roots().filter { it.mode == "sync" && it.remoteId != null }.map { it.remoteId!! }.sorted()
        val signature = folderIds.joinToString(",")
        val time = System.currentTimeMillis()
        if (publishingFolders || (signature == publishedFolders && time - publishedAt < 60_000) || time < publishRetryAt) return
        publishingFolders = true
        try {
            val response = api.request("/v1/sync/folders", "PUT", buildJsonObject { put("folderIds", JsonArray(folderIds.map(::JsonPrimitive))) })
            response["removedFolderIds"]?.jsonArray?.forEach { removedRemoteIds += it.jsonPrimitive.content }
            publishedFolders = signature; publishedAt = System.currentTimeMillis(); publishRetryAt = 0
        } catch (e: CancellationException) { throw e } catch (_: Exception) {
            // Retry while offline without interrupting file transfers or local configuration changes.
            publishRetryAt = System.currentTimeMillis() + 15_000
        } finally { publishingFolders = false }
    }
    private fun confirmStatus() {
        if (stopped || st.paused || confirmationWork?.isActive == true || System.currentTimeMillis() < nextConfirmationAt) return
        confirmationWork = scope.launch(dispatcher) {
            try {
                receipts.flush(); receipts.audit(); receipts.flush()
            } catch (e: CancellationException) { throw e } catch (_: Exception) {
                // Keep the durable outbox and retry independently of file transfer work.
            } finally {
                nextConfirmationAt = System.currentTimeMillis() + 5000
                if (!stopped) {
                    val pending = receipts.pendingRoots()
                    st = st.copy(confirmationPendingRoots = pending)
                    if (st.active == null && journal.jobCount() == 0 && st.issues.isEmpty()) {
                        if (pending.isNotEmpty()) st = st.copy(message = "Files transferred; waiting for backend confirmation")
                        else if (st.message == "Files transferred; waiting for backend confirmation") st = st.copy(message = "Everything is up to date")
                    }
                    emit()
                }
            }
        }
    }
    private suspend fun run() {
        if (!stopped && !publishingFolders) publishWork = scope.launch(dispatcher) { publishSyncFolders() }
        confirmStatus()
        if (running || stopped || (st.paused && removedRemoteIds.isEmpty())) { if (st.paused) passes.value++; return }
        runTick()
    }
    private suspend fun runTick() {
        running = true
        st = st.copy(running = true)
        // Local work runs every pass; server checks only when due.
        val remote = System.currentTimeMillis() >= nextRemoteAt
        var active = false
        hurried = false
        folderPaths.clear()
        try {
            for (root in roots()) if (root.mode == "sync" && root.remoteId != null && root.remoteId in removedRemoteIds) detachRoot(root)
            removedRemoteIds.clear()
            val available = mutableSetOf<String>()
            for (listed in roots()) {
                var root = listed
                if (stopped || st.paused) return
                if (root.shareId != null && remote) {
                    try {
                        val status = api.request("/v1/sync/shares/${HarborApi.segment(root.shareId!!)}/status")
                        val sequence = status["sequence"]?.jsonPrimitive?.longOrNull
                        if (root.sharedSequence != sequence) { root = root.copy(needsReconcile = true, sharedSequence = sequence); journal.root(root) }
                    } catch (e: ApiException) {
                        if (e.code in listOf("SYNC_ACCESS_REMOVED", "FORBIDDEN", "SYNC_REMOVED", "ITEM_NOT_FOUND", "PARENT_NOT_FOUND")) { detachRoot(root); continue }
                        throw e
                    }
                }
                if (root.archive == "archived") continue
                if (root.paused || !checkRoot(root)) continue
                if (root.mode == "sync" && st.issues.any { it.rootId == root.id && it.code == IssueCode.FOLDER_MISSING && it.scope == null }) {
                    // A folder that was unavailable is rebuilt on recovery instead of replaying deletions.
                    journal.resetRootFiles(root.id)
                }
                available += root.id
                currentRootId = root.id
                // Keep a problem visible while its file or folder is still waiting to retry.
                val retrying = (rootRetry[root.id]?.second ?: 0) > System.currentTimeMillis()
                val queued = journal.jobViews().map { it.id }.toSet()
                st = st.copy(issues = st.issues.filter { it.rootId != root.id || stickyIssue(it) || (if (it.jobId != null) it.jobId in queued else retrying) })
                if (root.archive != "restoring") {
                    try { scan(root) } catch (e: LocalFsException) { issue(root.id, e); continue }
                    root = journal.root(root.id) ?: continue
                }
                if (root.needsReconcile && root.mode == "sync" && !retrying) {
                    try { reconcile(root) } catch (e: CancellationException) { throw e } catch (e: Exception) {
                        if (interrupts(e)) throw e
                        // One blocked folder must not stop the others or this folder's own uploads.
                        rootFailed(root, e); continue
                    }
                    if (stopped || st.paused) return
                    active = true
                    rootRetry.remove(root.id)
                    journal.root(root.id)?.let { journal.root(it.copy(needsReconcile = false)) }
                }
            }
            // Backup runs wait for the server check; an archive in progress keeps the fast rate.
            for (root in roots().filter { it.mode == "backup" && !it.paused && it.id in available && (remote || it.archive != null) }) {
                if (stopped || st.paused) return
                if (root.archive != null) active = true
                currentRootId = root.id
                val halted = { stopped || st.paused }
                try {
                    if (root.archive == "restoring") {
                        st = st.copy(message = "Restoring archived folder")
                        backups.unarchive(root, halted)
                        nextScanAt.remove(root.id)
                        continue
                    }
                    if (root.archive != "removing") {
                        // A backup run resumes from the journal, so it yields between files when a local edit arrives.
                        var yielded = false
                        backups.process(root, { r, job -> localJob(r, job) }, { halted() || hurried.also { if (it) yielded = true } })
                        if (yielded) continue
                    }
                    val current = journal.root(root.id)
                    if (current?.archive != null && !halted()) backups.archive(current, halted)
                } catch (e: ApiException) {
                    if (e.code == "BACKUP_DISCONNECTED") detachRoot(root) else throw e
                }
            }
            val full = mutableSetOf<String>()
            for (job in journal.jobs()) {
                if (stopped || st.paused) return
                val root = journal.root(job.rootId)
                if (root == null || root.mode == "backup" || root.id !in available || root.paused || ignored(root, job.relativePath) ||
                    (job.payload.retryAt ?: 0) > System.currentTimeMillis() || (job.kind == "upsert" && root.id in full)) continue
                active = true
                currentRootId = root.id
                try {
                    localJob(root, job)
                    journal.finish(job.id)
                    if (st.issues.any { it.jobId == job.id }) { st = st.copy(issues = st.issues.filter { it.jobId != job.id }); persistIssues() }
                    st = st.copy(active = null); emit()
                } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    val current = journal.job(job.id) ?: job
                    current.attempts++
                    current.error = e.message ?: "A change could not be synchronized."
                    if (interrupts(e)) { journal.saveJob(current); throw e }
                    // One failing file waits for its own retry; the rest of the queue keeps moving.
                    current.payload.retryAt = System.currentTimeMillis() + retryDelay(current.attempts)
                    journal.saveJob(current)
                    // Every further upload would fail the same way until storage is freed.
                    if (e is ApiException && e.code == IssueCode.STORAGE_QUOTA_EXCEEDED) full += root.id
                    issue(root.id, e, job.relativePath, job.id)
                    st = st.copy(active = null)
                }
            }
            if (stopped || st.paused || !remote) return
            currentRootId = ""
            var cursor = journal.get<Long>("cursor") ?: 0L
            var more = true
            while (more && !stopped) {
                val page = api.request("/v1/sync/changes?cursor=$cursor")
                val changes = page["changes"]?.jsonArray?.map { it.jsonObject }.orEmpty()
                if (changes.isNotEmpty()) active = true
                for (change in changes) {
                    val type = change["type"]?.jsonPrimitive?.contentOrNull
                    val entityId = change["entityId"]?.jsonPrimitive?.contentOrNull ?: ""
                    if (type == "BACKUP_DISCONNECTED") roots().filter { it.mode == "backup" && it.remoteId == entityId }.forEach(::detachRoot)
                    if (type == "SYNC_FOLDER_REMOVED") for (root in roots().filter { it.mode == "sync" }) {
                        if (root.remoteId == entityId) detachRoot(root) else excludeRemovedFolder(root, entityId)
                    }
                    // Folders waiting to retry are repaired by their next reconcile instead.
                    fun targets() = roots().filter { it.mode == "sync" && it.shareId == null && !it.paused && it.id in available && it.id !in rootRetry }
                    suspend fun apply(root: SyncRoot, work: suspend () -> Unit) {
                        currentRootId = root.id
                        try { work() } catch (e: CancellationException) { throw e } catch (e: Exception) { if (interrupts(e)) throw e; rootFailed(root, e) }
                    }
                    if (type == "TRANSFER_SAVED") for (root in targets()) apply(root) { reconcile(root) }
                    val item = change["item"]?.let { runCatching { harborJson.decodeFromJsonElement<DriveItem>(it) }.getOrNull() }
                    if (item != null) for (root in targets()) apply(root) { remoteItem(root, item) }
                }
                cursor = page["nextCursor"]?.jsonPrimitive?.longOrNull ?: cursor
                journal.set("cursor", cursor)
                more = page["hasMore"]?.jsonPrimitive?.booleanOrNull == true
            }
            if (stopped || st.paused) return
            currentRootId = ""
            st = st.copy(issues = st.issues.filter { it.rootId != "" || stickyIssue(it) }); persistIssues()
            // Each checkpoint is a database write; only send one when the cursor moved.
            if (cursor != checkpointed) {
                api.request("/v1/sync/checkpoints", "POST", buildJsonObject { put("deviceId", deviceId); put("cursor", cursor) })
                checkpointed = cursor
            }
            val last = now()
            journal.set("lastSync", last)
            val pending = receipts.pendingRoots()
            st = st.copy(online = true, lastSync = last, confirmationPendingRoots = pending,
                message = if (pending.isNotEmpty()) "Files transferred; waiting for backend confirmation" else "Everything is up to date")
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            if (e is ApiException && e.code == "SYNC_REMOVED") {
                val root = journal.root(currentRootId)
                if (root != null) {
                    try { api.request("/v1/drive/items/${HarborApi.segment(root.remoteId ?: "")}") }
                    catch (rootError: ApiException) { if (rootError.code == "SYNC_REMOVED") detachRoot(root) }
                    catch (_: Exception) {}
                    val folderId = e.details?.get("folderId")?.jsonPrimitive?.contentOrNull
                    if (folderId != null) journal.root(root.id)?.let { excludeRemovedFolder(it, folderId) }
                }
                return
            }
            if (e is ApiException && e.code == "SYNC_CURSOR_EXPIRED") {
                for (root in roots()) if (root.mode == "sync") journal.root(root.copy(needsReconcile = true))
                journal.set("cursor", 0L)
            }
            st = st.copy(online = !offline(e), message = if (offline(e)) "Waiting for a connection" else e.message ?: "Sync stopped unexpectedly.")
            // An ended session returns the app to sign-in by itself; there is nothing to fix here.
            val sessionEnded = e is ApiException && (e.status == 401 || e.code in listOf("AUTH_INVALID", "DEVICE_REVOKED"))
            if (!offline(e) && !sessionEnded && !(e is ApiException && e.code == "SYNC_CURSOR_EXPIRED") &&
                st.issues.none { it.rootId == currentRootId && !stickyIssue(it) }) issue(currentRootId, e)
            if (e is ApiException && e.code in listOf("DEVICE_REVOKED", "AUTH_INVALID")) st = st.copy(paused = true)
        } finally {
            // Activity keeps checks every 2s; each quiet or failed check doubles the wait.
            if (active) {
                remoteDelay = REMOTE_POLL_MIN
                nextRemoteAt = if (remote) System.currentTimeMillis() + REMOTE_POLL_MIN else 0
                receipts.nudge()
            } else if (remote) {
                remoteDelay = minOf(REMOTE_POLL_MAX, remoteDelay * 2)
                nextRemoteAt = System.currentTimeMillis() + remoteDelay
            }
            // A wake() during this pass still gets its immediate check.
            if (hurried) hurry()
            confirmStatus()
            running = false
            st = st.copy(running = false, active = null)
            emit()
            if (remote || st.paused) passes.value++
        }
    }

    // Folders and uploads ----------------------------------------------------------------------------------
    private suspend fun child(parentId: String?, name: String): DriveItem? {
        val wanted = normalizedName(name)
        var cursor: String? = null
        do {
            val page = api.list(parentId, cursor)
            page.items.firstOrNull { (it.normalizedName.ifEmpty { normalizedName(it.name) }) == wanted }?.let { return it }
            cursor = page.nextCursor
        } while (cursor != null)
        return null
    }
    private suspend fun ensureFolder(name: String, parentId: String?, operationId: String = UUID.randomUUID().toString(), backup: Pair<String, String>? = null): DriveItem {
        val body = buildJsonObject { put("name", name); put("parentId", parentId); put("operationId", operationId) }
        return try {
            harborJson.decodeFromJsonElement<ItemResponse>(if (backup != null)
                api.request("/v1/backups/${HarborApi.segment(backup.first)}/runs/${HarborApi.segment(backup.second)}/folders", "POST", body)
                else api.request("/v1/drive/folders", "POST", body)).item
        } catch (e: ApiException) {
            if (e.code == "NAME_CONFLICT") child(parentId, name)?.takeIf { it.isFolder }?.let { return it }
            throw e
        }
    }
    private suspend fun remoteParent(root: SyncRoot, relative: String, backup: Pair<String, String>?): String? {
        val dirname = parentPath(relative)
        if (dirname.isEmpty()) return root.remoteId
        journal.file(root.id, dirname)?.let { return it.itemId }
        val parentId = remoteParent(root, dirname, backup)
        val item = ensureFolder(baseName(dirname), parentId, backup = backup)
        journal.putFile(LocalFile(root.id, dirname, item.id, item.revision ?: 1, null, "FOLDER"))
        return item.id
    }
    private suspend fun localJob(root: SyncRoot, job: LocalJob) {
        if (!validRelative(job.relativePath)) return
        val local = tree(root)
        var known = journal.file(root.id, job.relativePath)
        if (job.kind == "delete") {
            if (local.stat(job.relativePath) != null) return
            if (root.mode == "backup") return
            if (known != null) {
                try {
                    api.request("/v1/drive/items/${HarborApi.segment(known.itemId)}", "DELETE", buildJsonObject { put("operationId", job.id); put("baseRevision", known.revision) })
                } catch (e: ApiException) {
                    if (e.code == "REVISION_CONFLICT") {
                        remoteItem(root, api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(known.itemId)}").item)
                        return
                    }
                    if (e.code !in listOf("ITEM_NOT_FOUND", "PARENT_NOT_FOUND")) throw e
                }
                journal.deleteFile(root.id, job.relativePath)
            }
            return
        }
        val info = local.stat(job.relativePath) ?: return
        val name = baseName(job.relativePath)
        progress(root, "upload", job.relativePath, 0, if (info.folder) 0 else info.size)
        val backup = if (root.mode == "backup") root.backupId!! to (job.payload.backupRunId ?: throw IllegalStateException("Backup run is missing.")) else null
        val parentId = remoteParent(root, job.relativePath, backup)
        if (info.folder) {
            if (known == null) {
                val item = ensureFolder(name, parentId, job.id, backup)
                journal.putFile(LocalFile(root.id, job.relativePath, item.id, item.revision ?: 1, null, "FOLDER"))
                receipts.queue(root, job.relativePath, item, null)
                activity(root, job.relativePath, "upload", item)
            }
            return
        }
        if (root.mode == "backup") {
            local.ensureParents(job.relativePath, create = false)
            val remote = if (known != null) api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(known.itemId)}").item else child(parentId, name)
            if (remote?.type == "FILE") {
                if (normalizedName(remote.name) != normalizedName(name) || java.text.Normalizer.normalize(remote.name, java.text.Normalizer.Form.NFC) != java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFC))
                    throw IllegalStateException("Another archived file has the same name with different capitalization. Rename the local file to back up both.")
                var savedHash = if (known?.revision == remote.revision) known?.hash else null
                if (savedHash == null) {
                    savedHash = api.request("/v1/drive/items/${HarborApi.segment(remote.id)}/versions")["items"]?.jsonArray?.map { it.jsonObject }
                        ?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == remote.currentVersionId }?.get("contentHash")?.jsonPrimitive?.contentOrNull
                }
                known = LocalFile(root.id, job.relativePath, remote.id, remote.revision ?: 1, savedHash, "FILE")
                journal.putFile(known)
            }
        }
        val hash = local.hash(job.relativePath)
        if (job.payload.relayVersion != null && known != null) {
            if (known.hash != hash) {
                // An edit arriving while a relay request is queued is still a normal local edit.
                job.payload.relayVersion = null
                job.payload.upload = UploadState(UUID.randomUUID().toString())
                journal.saveJob(job)
            } else {
                val current = api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(known.itemId)}").item
                if (current.cloudState != "REQUESTED" || current.currentVersionId != job.payload.relayVersion) return
            }
        } else if (known?.hash == hash) return
        val state = job.payload.upload ?: UploadState(job.id).also { job.payload.upload = it }
        // Reuse this checksum only when the file remained stable during hashing.
        val hashedInfo = local.stat(job.relativePath)
        if (state.uploadId == null && hashedInfo != null && info.size == hashedInfo.size && info.mtime == hashedInfo.mtime) {
            state.hash = hash; state.size = info.size; state.mtime = info.mtime
        }
        val verifyBackupQuiet: suspend () -> Unit = {
            if (root.mode == "backup" && job.payload.backupManual != true) {
                val current = local.stat(job.relativePath) ?: throw LocalFsException("ENOENT", "“$name” could not be found.", job.relativePath)
                val observed = journal.job(job.id)?.payload?.observedAt ?: job.payload.observedAt ?: 0
                if (!backupReady(current.mtime, observed)) throw IllegalStateException("This file changed recently. Automatic backup will wait one hour.")
            }
        }
        verifyBackupQuiet()
        progress(root, "upload", job.relativePath, 0, info.size)
        val item = try {
            transfers.upload(local, job.relativePath, name, parentId, state, { journal.saveJob(job) }, known,
                { loaded, total -> progress(root, "upload", job.relativePath, loaded, total) }, verifyBackupQuiet, backup)
        } catch (e: ApiException) {
            if (root.mode == "backup" || e.code !in listOf("REVISION_CONFLICT", "NAME_CONFLICT")) throw e
            state.uploadId?.let { runCatching { api.request("/v1/uploads/${HarborApi.segment(it)}", "DELETE") } }
            if (job.payload.relayVersion != null) return
            val conflictPath = joinPath(parentPath(job.relativePath), conflictName(name, deviceName(), job.id))
            local.rename(job.relativePath, conflictPath)
            journal.snapshotMove(root.id, job.relativePath, conflictPath)
            conflict(root, job.relativePath, conflictPath)
            journal.enqueue(root.id, conflictPath, "upsert")
            val remote = if (known != null) api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(known.itemId)}").item else child(parentId, name)
            if (remote != null) remoteItem(root, remote)
            return
        }
        if (root.mode == "backup") {
            job.payload.backupEntry = BackupEntry(job.relativePath, item.id, item.currentVersionId ?: "", item.sizeBytes, Instant.ofEpochMilli(state.mtime ?: info.mtime).toString(), now())
            journal.saveJob(job)
        }
        journal.putFile(LocalFile(root.id, job.relativePath, item.id, item.revision ?: 1, state.hash, "FILE"))
        receipts.queue(root, job.relativePath, item, state.hash)
        activity(root, job.relativePath, "upload", item)
    }

    // Remote changes ---------------------------------------------------------------------------------------
    /** Keeps a local edit that a remote change would overwrite, under a conflict name beside it. */
    private fun preserve(root: SyncRoot, relative: String, knownHash: String?): Boolean {
        val local = tree(root)
        val info = local.stat(relative) ?: return false
        if (!info.folder && local.hash(relative) != knownHash) {
            val conflictPath = joinPath(parentPath(relative), conflictName(baseName(relative), deviceName(), UUID.randomUUID().toString()))
            local.rename(relative, conflictPath)
            journal.snapshotMove(root.id, relative, conflictPath)
            conflict(root, relative, conflictPath)
            journal.enqueue(root.id, conflictPath, "upsert")
            return true
        }
        return false
    }
    suspend fun remoteItem(root: SyncRoot, eventItem: DriveItem) {
        if (stopped || st.paused || root.paused || root.mode != "sync") return
        if (root.remoteId == eventItem.id) { if (eventItem.deletedAt == null) receipts.queue(root, ".", eventItem, null); return }
        val local = tree(root)
        val known = journal.fileByItem(root.id, eventItem.id)
        if (known != null && ignored(root, known.relativePath)) return
        if (eventItem.deletedAt != null && known != null && known.revision >= (eventItem.revision ?: 0)) return
        if (eventItem.deletedAt != null) {
            waiting.remove(eventItem.id)
            if (known == null) return
            if (known.type == "FILE") {
                preserve(root, known.relativePath, known.hash)
                if (local.stat(known.relativePath)?.folder == false) local.delete(known.relativePath)
                journal.snapshotRemove(root.id, known.relativePath)
            } else {
                // Preserve the entire local folder on remote deletion. It may contain unsynced work.
                // The copy stays visible beside its old location and is excluded from further syncing.
                try {
                    if (local.list(known.relativePath).all { !it.folder && metadataSegment(it.name) }) local.delete(known.relativePath)
                    else {
                        val kept = joinPath(parentPath(known.relativePath), recoveredName(baseName(known.relativePath), LocalDateTime.now()))
                        local.rename(known.relativePath, kept)
                        recovered(root, known.relativePath, kept)
                    }
                } catch (e: LocalFsException) { if (e.code != "ENOENT") throw e }
                journal.snapshotRemove(root.id, known.relativePath)
                journal.files(root.id).filter { it.relativePath.startsWith(known.relativePath + "/") }.forEach { journal.deleteFile(root.id, it.relativePath) }
            }
            journal.deleteFile(root.id, known.relativePath)
            return
        }
        // Resolve the latest metadata when processing historical feed entries.
        val item = try { api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(eventItem.id)}").item }
            catch (e: ApiException) { if (e.code in listOf("ITEM_NOT_FOUND", "PARENT_NOT_FOUND")) return; throw e }
        val relative = relative(root, item) ?: return
        if (ignored(root, relative)) return
        local.ensureParents(relative)
        if (known != null && known.relativePath != relative) {
            if (local.stat(relative) != null) throw LocalFsException("EEXIST", "A local item blocks a remote move. Move it aside to continue safely.", relative)
            try { local.rename(known.relativePath, relative); journal.snapshotMove(root.id, known.relativePath, relative) }
            catch (e: LocalFsException) { if (e.code != "ENOENT") throw e }
            journal.deleteFile(root.id, known.relativePath)
            if (known.type == "FOLDER") for (child in journal.files(root.id).filter { it.relativePath.startsWith(known.relativePath + "/") }) {
                journal.deleteFile(root.id, child.relativePath)
                journal.putFile(child.copy(relativePath = relative + child.relativePath.substring(known.relativePath.length)))
            }
        }
        if (item.isFolder) {
            local.mkdirs(relative)
            journal.snapshotPut(root.id, relative, LocalStat(true, 0, 0))
            journal.putFile(LocalFile(root.id, relative, item.id, item.revision ?: 1, null, "FOLDER"))
            receipts.queue(root, relative, item, null)
            return
        }
        // A new file skips the version lookup: the download is verified against its own hash.
        val existing = local.stat(relative)
        if (existing?.folder == true) throw LocalFsException("EEXIST", "A local folder blocks this file. Move it aside to continue safely.", relative)
        val localHash = if (existing != null) local.hash(relative) else null
        if (localHash != null) {
            val hash = api.request("/v1/drive/items/${HarborApi.segment(item.id)}/versions")["items"]?.jsonArray?.map { it.jsonObject }
                ?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == item.currentVersionId }?.get("contentHash")?.jsonPrimitive?.contentOrNull
                ?: throw IllegalStateException("File version is unavailable.")
            if (localHash.equals(hash, ignoreCase = true)) {
                journal.putFile(LocalFile(root.id, relative, item.id, item.revision ?: 1, localHash, "FILE"))
                journal.snapshotPut(root.id, relative, existing!!.stat)
                receipts.queue(root, relative, item, localHash)
                waiting.remove(item.id)
                if (item.cloudState == "REQUESTED") {
                    journal.enqueue(root.id, relative, "upsert")
                    val relay = journal.findJob(root.id, relative, "upsert")!!
                    if (relay.payload.relayVersion != item.currentVersionId) {
                        relay.payload.relayVersion = item.currentVersionId
                        relay.payload.upload = UploadState(UUID.randomUUID().toString())
                    }
                    journal.saveJob(relay)
                    wakeups.trySend(Unit)
                }
                return
            }
        }
        if (item.cloudState == "RELEASED" || item.cloudState == "REQUESTED") {
            api.request("/v1/sync/items/${HarborApi.segment(item.id)}/request-content", "POST")
            st = st.copy(message = "Waiting for a linked device to provide this file")
            waiting[item.id] = WaitingItem(root.id, relative)
            emit()
            return
        }
        progress(root, "download", relative, 0, item.sizeBytes)
        val hash = transfers.download(local, buildJsonObject { put("driveItemId", item.id); put("versionId", item.currentVersionId) }, relative,
            { loaded, total -> progress(root, "download", relative, loaded, total) }) { preserve(root, relative, known?.hash) }
        journal.snapshotPut(root.id, relative, local.stat(relative)?.stat)
        journal.putFile(LocalFile(root.id, relative, item.id, item.revision ?: 1, hash, "FILE"))
        receipts.queue(root, relative, item, hash)
        waiting.remove(item.id)
        activity(root, relative, "download", item)
    }
}
