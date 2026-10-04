package app.harbor0.android

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import java.io.IOException
import java.time.Instant
import java.util.UUID

private const val ARCHIVE_ATTEMPTS = 3
/** A request the server will keep refusing; retrying every pass would stall all other folders. */
private fun refused(error: Throwable): String? {
    if (error !is ApiException || error.status < 400 || error.status >= 500 || error.status in listOf(401, 429) ||
        error.code in listOf("BACKUP_DISCONNECTED", "AUTH_INVALID", "DEVICE_REVOKED")) return null
    return if (error.status == 404) "This harbor0 server does not support archiving yet. Update the server and try again." else error.message
}
/** A transient failure: keep the run and its upload state for the next pass. */
private fun transient(error: Throwable) = (error is IOException && error !is LocalReadException) || (error is ApiException && error.status >= 500)

/**
 * Folder backups on this phone (desktop `backups.ts`): runs after files have been quiet for an hour, "Back up now",
 * archive (a final full backup, then removal of only the local files whose content is saved) and restore of an
 * archived folder, and restores requested from other devices.
 */
class FolderBackups(private val api: HarborApi, private val journal: SyncJournal, private val transfers: SyncTransfers, private val tree: (SyncRoot) -> LocalTree) {
    private val nextRestoreCheck = mutableMapOf<String, Long>()
    private fun ignored(root: SyncRoot, relative: String) = ignoredPath(root.excluded, relative)

    fun request(root: SyncRoot) {
        if (root.paused) throw IllegalStateException("Resume this backup folder before backing up now.")
        if (journal.get<PendingRun>("backup-run:${root.id}") != null) throw IllegalStateException("A backup is already running for this folder.")
        // Persist intent before scanning; an interrupted scan is repeated by the next pass.
        journal.set("backup-now:${root.id}", true)
    }
    private fun scan(root: SyncRoot) {
        val local = tree(root)
        local.check()
        scanTree(local, root.excluded)?.forEach { (path, stat) -> if (!stat.folder) journal.enqueue(root.id, path, "upsert") }
    }

    suspend fun process(input: SyncRoot, perform: suspend (SyncRoot, LocalJob) -> Unit, stopped: () -> Boolean) {
        var root = input
        if (root.backupId == null) {
            val match = api.all<BackupRoot>("/v1/backups").firstOrNull { it.remoteRootDriveItemId == root.remoteId }
                ?: throw IllegalStateException("Backup folder registration was not found. Add this folder again.")
            root = root.copy(backupId = match.id); journal.root(root)
        }
        val url = "/v1/backups/${HarborApi.segment(root.backupId!!)}"
        val connection = api.request(url)["root"]?.jsonObject
        if (connection?.get("state")?.jsonPrimitive?.contentOrNull == "REMOVED") throw ApiException(409, "Backup folder disconnected.", "BACKUP_DISCONNECTED")
        restores(root, url)
        val key = "backup-run:${root.id}"
        val local = tree(root)
        val saved = journal.get<PendingRun>(key)
        var run: PendingRun = saved ?: kotlin.run {
            val manual = journal.flag("backup-now:${root.id}")
            if (manual) scan(root)
            val ready = mutableListOf<String>()
            for (job in journal.jobs(root.id)) {
                if (ignored(root, job.relativePath)) { journal.finish(job.id); continue }
                if (!manual && System.currentTimeMillis() < (job.payload.retryAfter ?: 0)) continue
                val info = try { local.ensureParents(job.relativePath, create = false); local.stat(job.relativePath) }
                    catch (e: LocalFsException) { if (e.code != "ENOENT" && e.code != "ENOTDIR") throw e; null }
                if (info == null || info.folder) { journal.finish(job.id); continue }
                if (job.kind == "delete") { journal.finish(job.id); journal.enqueue(root.id, job.relativePath, "upsert"); continue }
                if (!manual && !backupReady(info.mtime, job.payload.observedAt ?: 0)) continue
                // Rescans and touched-but-identical files queue entries too; they are already saved.
                val known = journal.file(root.id, job.relativePath)
                if (job.payload.upload?.uploadId == null && job.payload.backupEntry == null && known?.type == "FILE" &&
                    known.hash != null && local.hash(job.relativePath) == known.hash) { journal.finish(job.id); continue }
                ready += job.id
            }
            // Nothing changed: no backup is recorded, and a Back up now request is settled.
            if (ready.isEmpty()) {
                if (manual) journal.set("backup-now:${root.id}", false)
                upToDate(root, url)
                return
            }
            val created = PendingRun(UUID.randomUUID().toString(), if (manual) "MANUAL" else "AUTOMATIC", ready)
            journal.set(key, created)
            journal.set("backup-now:${root.id}", false)
            created
        }
        api.request("$url/runs", "POST", buildJsonObject { put("id", run.id); put("trigger", run.trigger) })
        var error = run.error
        for (id in run.jobs.toList()) {
            if (stopped()) return
            val job = journal.job(id)
            if (job != null) {
                val before = try { local.ensureParents(job.relativePath, create = false); local.stat(job.relativePath) }
                    catch (e: LocalFsException) { if (e.code != "ENOENT" && e.code != "ENOTDIR") throw e; null }
                if (job.payload.backupEntry != null || (before != null && !before.folder && (run.trigger == "MANUAL" || backupReady(before.mtime, job.payload.observedAt ?: 0)))) {
                    try {
                        if (job.payload.backupEntry == null) {
                            job.payload.backupManual = run.trigger == "MANUAL"
                            job.payload.backupRunId = run.id
                            perform(root, job)
                        }
                        var entry = journal.job(job.id)?.payload?.backupEntry ?: job.payload.backupEntry
                        if (entry == null) {
                            val known = journal.file(root.id, job.relativePath) ?: throw IllegalStateException("File changed before it could be backed up.")
                            val item = api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(known.itemId)}").item
                            entry = BackupEntry(job.relativePath, item.id, item.currentVersionId ?: "", item.sizeBytes, Instant.ofEpochMilli(before!!.mtime).toString(), Instant.now().toString())
                            job.payload.backupEntry = entry
                            journal.saveJob(job)
                        }
                        api.request("$url/runs/${HarborApi.segment(run.id)}/files", "POST", harborJson.encodeToJsonElement(entry).jsonObject)
                        journal.finish(job.id)
                        // Changes observed during a transfer must survive completion of its old queue entry.
                        val after = runCatching { local.stat(job.relativePath) }.getOrNull()
                        if (after != null && (before == null || after.mtime != before.mtime || after.size != before.size || Instant.ofEpochMilli(after.mtime).toString() != entry.modifiedAt)) {
                            journal.enqueue(root.id, job.relativePath, "upsert", observedAt = System.currentTimeMillis())
                        }
                    } catch (e: CancellationException) { throw e } catch (e: Exception) {
                        // Retain upload state and the run for network retries, including acknowledgement loss.
                        if (transient(e)) throw e
                        if (e is ApiException && e.code == "BACKUP_DISCONNECTED") throw e
                        val current = journal.job(job.id) ?: job
                        current.payload.upload?.uploadId?.let {
                            runCatching { api.request("/v1/uploads/${HarborApi.segment(it)}", "DELETE") }
                            current.payload.upload = UploadState(UUID.randomUUID().toString())
                        }
                        current.attempts++
                        current.payload.retryAfter = System.currentTimeMillis() + 60_000
                        current.error = e.message ?: "This file could not be backed up."
                        journal.saveJob(current)
                        error = "${job.relativePath}: ${current.error}".take(2000)
                    }
                }
            }
            run = run.copy(jobs = run.jobs.filter { it != id }, error = error)
            journal.set(key, run)
        }
        api.request("$url/runs/${HarborApi.segment(run.id)}/complete", "POST", buildJsonObject { error?.let { put("error", it) } })
        journal.remove(key)
    }

    /** Files whose current content is exactly what the cloud copy holds; everything else is left alone. */
    private fun saved(root: SyncRoot): Pair<List<Pair<String, LocalEntry>>, List<String>> {
        val local = tree(root)
        val saved = mutableListOf<Pair<String, LocalEntry>>()
        val changed = mutableListOf<String>()
        val entries = scanTree(local, root.excluded) ?: return saved to listOf(".")
        for ((path, stat) in entries) {
            if (stat.folder) continue
            val known = journal.file(root.id, path)
            val info = local.stat(path) ?: continue
            if (known?.type == "FILE" && known.hash != null && local.hash(path) == known.hash) saved += path to info else changed += path
        }
        return saved to changed
    }
    /** Removes emptied folders, deepest first. The chosen folder itself stays so access to it is kept for a restore. */
    private fun prune(root: SyncRoot) {
        val local = tree(root)
        val folders = (scanTree(local, emptyList()) ?: return).filterValues { it.folder }.keys.filter { !ignored(root, it) }
            .sortedByDescending { it.count { c -> c == '/' } }
        for (folder in folders) {
            val rest = runCatching { local.list(folder) }.getOrNull() ?: continue
            // File-manager bookkeeping alone must not keep an emptied folder around.
            if (rest.all { !it.folder && metadataSegment(it.name) }) runCatching { local.delete(folder) }
        }
    }

    /** Finishes a requested archive once a full backup has saved everything, removing only verified local files. */
    suspend fun archive(input: SyncRoot, stopped: () -> Boolean) {
        var root = input
        val url = "/v1/backups/${HarborApi.segment(root.backupId!!)}"
        val attemptsKey = "backup-archive:${root.id}"
        // Nothing local has been removed yet, so a failed archive simply keeps backing up.
        fun cancel(reason: String) { journal.root(root.copy(archive = null, archiveError = reason)); journal.set(attemptsKey, 0) }
        if (root.archive == "pending") {
            if (journal.get<PendingRun>("backup-run:${root.id}") != null || journal.flag("backup-now:${root.id}")) return
            val jobs = journal.jobs(root.id)
            jobs.firstOrNull { it.error != null }?.let { return cancel("${it.relativePath} could not be backed up: ${it.error}") }
            val changed = if (jobs.isNotEmpty()) listOf(".") else saved(root).second
            if (stopped()) return
            if (changed.isNotEmpty()) {
                val attempts = (journal.get<Int>(attemptsKey) ?: 0) + 1
                if (attempts >= ARCHIVE_ATTEMPTS) return cancel("Its files keep changing. Try again when nothing is editing them.")
                // Edits made during the final backup need one more pass before anything is removed.
                journal.set(attemptsKey, attempts)
                changed.filter { it != "." }.forEach { journal.enqueue(root.id, it, "upsert") }
                journal.set("backup-now:${root.id}", true)
                return
            }
            try { api.request("$url/archive", "POST") } catch (e: CancellationException) { throw e } catch (e: Exception) {
                val reason = refused(e) ?: throw e
                return cancel(reason)
            }
            root = root.copy(archive = "removing"); journal.root(root)
        }
        val local = tree(root)
        if (runCatching { local.check(); true }.getOrDefault(false)) {
            for ((path, before) in saved(root).first) {
                val info = local.stat(path)
                if (info != null && !info.folder && info.size == before.size && info.mtime == before.mtime) local.delete(path)
            }
            prune(root)
        }
        journal.resetRootFiles(root.id)
        journal.set(attemptsKey, 0)
        journal.root(root.copy(archive = "archived"))
    }

    /** Brings an archived folder back: resumes the backup and downloads the latest saved files. */
    suspend fun unarchive(root: SyncRoot, stopped: () -> Boolean) {
        try { api.request("/v1/backups/${HarborApi.segment(root.backupId!!)}/unarchive", "POST") } catch (e: CancellationException) { throw e } catch (e: Exception) {
            val reason = refused(e) ?: throw e
            journal.root(root.copy(archive = "archived", archiveError = reason)); return
        }
        val local = tree(root)
        suspend fun walk(parentId: String, relative: String): Boolean {
            for (item in api.all<DriveItem>("/v1/drive/folders/${HarborApi.segment(parentId)}/children")) {
                if (stopped()) return false
                val path = joinPath(relative, safeSegment(item.name, item.id))
                if (ignored(root, path)) continue
                local.ensureParents(path)
                if (item.isFolder) { local.mkdirs(path); journal.snapshotPut(root.id, path, LocalStat(true, 0, 0)); if (!walk(item.id, path)) return false }
                // Anything already in the folder is newer local work; the next backup saves it.
                else if (local.stat(path) == null) {
                    transfers.download(local, buildJsonObject { put("driveItemId", item.id) }, path)
                    journal.snapshotPut(root.id, path, local.stat(path)?.stat)
                }
            }
            return true
        }
        if (walk(root.remoteId!!, "")) journal.root(root.copy(archive = null, archiveError = null))
    }

    /**
     * Nothing new records no run, so harbor0 is told the folder is still backed up; otherwise an
     * untouched folder would get a stale-backup reminder. Waiting changes don't count.
     */
    private suspend fun upToDate(root: SyncRoot, url: String) {
        if (journal.jobs(root.id).isNotEmpty()) return
        val key = "backup-checked:${root.id}"
        val now = System.currentTimeMillis()
        if (now - (journal.get<Long>(key) ?: 0L) < 12 * 3600_000L) return
        api.request("$url/checked", "POST")
        journal.set(key, now)
    }
    private suspend fun restores(root: SyncRoot, url: String) {
        if (System.currentTimeMillis() < (nextRestoreCheck[root.id] ?: 0)) return
        nextRestoreCheck[root.id] = System.currentTimeMillis() + 10_000
        val local = tree(root)
        // Pending entries are removed on acknowledgement; always read from the beginning.
        for (request in api.all<BackupRestore>("$url/pending-restores")) {
            val relative = journal.fileByItem(root.id, request.itemId)?.relativePath ?: request.relativePath
            val receiptKey = "backup-restore:${request.id}"
            var receipt = journal.element(receiptKey)?.jsonObject
            if (receipt == null) {
                receipt = try {
                    if (!validRelative(relative)) throw IllegalStateException("Invalid restore destination.")
                    local.ensureParents(relative)
                    val before = local.stat(relative)
                    // A part file from a different selected version must not be resumed.
                    if (local.stat("$relative.harbor-part") != null) local.delete("$relative.harbor-part")
                    transfers.download(local, buildJsonObject { put("driveItemId", request.itemId); put("versionId", request.versionId) }, relative, beforeReplace = {
                        val connection = api.request(url)["root"]?.jsonObject
                        if (connection?.get("state")?.jsonPrimitive?.contentOrNull == "REMOVED") throw ApiException(409, "Backup folder disconnected.", "BACKUP_DISCONNECTED")
                        val current = local.stat(relative)
                        if ((before == null) != (current == null) || (before != null && current != null && (before.mtime != current.mtime || before.size != current.size)))
                            throw IllegalStateException("The local file changed during restore. Retry after editing is finished.")
                    })
                    // Record completion before acknowledging so an offline retry cannot overwrite newer edits.
                    journal.snapshotPut(root.id, relative, local.stat(relative)?.stat)
                    buildJsonObject {}
                } catch (e: CancellationException) { throw e } catch (e: Exception) {
                    if (transient(e)) throw e
                    buildJsonObject { put("error", (e.message ?: "The file could not be restored.").take(2000)) }
                }
                journal.setRaw(receiptKey, receipt.toString())
            }
            api.request("$url/restores/${HarborApi.segment(request.id)}/complete", "POST", receipt)
        }
    }
}
