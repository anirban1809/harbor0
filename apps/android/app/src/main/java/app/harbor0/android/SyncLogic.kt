package app.harbor0.android

import kotlinx.serialization.Serializable
import java.security.MessageDigest
import java.text.Normalizer
import java.time.LocalDateTime

// Pure sync rules shared with the desktop engine (apps/desktop/src/paths.ts, sync-state.ts, backups.ts).
// Nothing here touches Android APIs, so it is covered by JVM unit tests.

/** A remote name as a safe local file name; unsafe-but-valid names get the item's id appended. */
fun safeSegment(name: String, id: String): String {
    require(name.isNotEmpty() && name != "." && name != ".." && name.none { it == '\\' || it == '/' || it == '\u0000' }) { "Unsafe remote filename." }
    val reserved = Regex("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)", RegexOption.IGNORE_CASE)
    if (Regex("[<>:\"|?*\\u0000-\\u001f]").containsMatchIn(name) || Regex("[. ]$").containsMatchIn(name) || reserved.containsMatchIn(name)) {
        val cleaned = name.replace(Regex("[^a-zA-Z0-9._ -]"), "_").replace(Regex("[. ]+$"), "").ifEmpty { "file" }
        return "$cleaned~${id.take(8)}"
    }
    return name
}

// OS and file-manager bookkeeping that should never be synced or backed up.
private val metadataNames = setOf(".ds_store", ".appledouble", ".lsoverride", ".spotlight-v100", ".trashes", ".fseventsd", ".temporaryitems",
    ".documentrevisions-v100", ".apdisk", "icon\r", "thumbs.db", "ehthumbs.db", "desktop.ini", "\$recycle.bin", ".directory",
    // Android: generated gallery thumbnails. MediaStore trash and in-progress files are matched by prefix below.
    ".thumbnails")
fun metadataSegment(name: String) = name.startsWith("._") || name.lowercase() in metadataNames || name.startsWith(".trashed-") || name.startsWith(".pending-")

private val recoveredPattern = Regex(" \\(Recovered by harbor0 \\d{4}-\\d{2}-\\d{2} \\d{2}\\.\\d{2}\\.\\d{2}\\)$")
/** Local copies kept after a remote folder deletion: visible to the user, but never synced again. */
fun recoveredName(name: String, at: LocalDateTime): String {
    fun two(value: Int) = value.toString().padStart(2, '0')
    return "$name (Recovered by harbor0 ${at.year}-${two(at.monthValue)}-${two(at.dayOfMonth)} ${two(at.hour)}.${two(at.minute)}.${two(at.second)})"
}
fun internalPath(relative: String) = relative.split('/').any { p ->
    p.startsWith(".harbor-") || p.endsWith(".harbor-part") || recoveredPattern.containsMatchIn(p) || metadataSegment(p)
}
/** Node's path.extname: the last ".ext", or nothing for names like ".profile". */
fun extension(name: String): String { val dot = name.lastIndexOf('.'); return if (dot <= 0) "" else name.substring(dot) }
fun conflictName(name: String, device: String, operationId: String): String {
    val ext = extension(name)
    val label = device.replace(Regex("\\.local$", RegexOption.IGNORE_CASE), "").replace(Regex("[^\\p{L}\\p{N} '-]"), "_").trim().take(40).ifEmpty { "another device" }
    return "${name.dropLast(ext.length)} (Conflict - $label - ${operationId.take(8)})$ext"
}
fun excludedPath(excluded: List<String>, relative: String) = excluded.any { relative == it || relative.startsWith("$it/") }
fun ignoredPath(excluded: List<String>, relative: String) = internalPath(relative) || excludedPath(excluded, relative)
fun parentPath(relative: String) = relative.substringBeforeLast('/', "")
fun baseName(relative: String) = relative.substringAfterLast('/')
fun joinPath(parent: String, name: String) = if (parent.isEmpty() || parent == ".") name else "$parent/$name"
/** A relative path from the engine or user input: no empty, "." or ".." segments and no absolute paths. */
fun validRelative(relative: String) = relative.isNotEmpty() && !relative.startsWith("/") && relative.split('/').none { it.isEmpty() || it == "." || it == ".." }
fun normalizedName(name: String): String = Normalizer.normalize(name, Normalizer.Form.NFC).lowercase()

// Failed files and folders retry with growing delays (4s up to 5 minutes).
fun retryDelay(attempts: Int): Long = minOf(300_000L, 2000L * (1L shl minOf(attempts, 10)))
const val REMOTE_POLL_MIN = 2_000L
const val REMOTE_POLL_MAX = 30_000L
const val BACKUP_QUIET_MS = 60 * 60 * 1000L
fun backupReady(mtimeMs: Long, observedAt: Long = 0, now: Long = System.currentTimeMillis()) = now - maxOf(mtimeMs, observedAt) >= BACKUP_QUIET_MS

/** A stable UUID-shaped operation id for a numbered fallback folder, as desktop derives it. */
fun numberedOperationId(operationId: String, number: Int): String {
    val hash = MessageDigest.getInstance("SHA-256").digest("sync-folder:$operationId:$number".toByteArray()).joinToString("") { "%02x".format(it) }
    return "${hash.take(8)}-${hash.substring(8, 12)}-4${hash.substring(13, 16)}-a${hash.substring(17, 20)}-${hash.substring(20, 32)}"
}

// Local snapshots ----------------------------------------------------------------------------
/** What a scan knows about one local entry. Folder sizes and times are not compared. */
@Serializable data class LocalStat(val folder: Boolean, val size: Long, val mtime: Long)
data class LocalChange(val relativePath: String, val kind: String, val stat: LocalStat?, val changed: Boolean)
/**
 * Android has no file watcher for document trees, so each scan is compared with the last one:
 * new entries are upserts, edited files are upserts marked as changes, and missing entries are deletes.
 * Parents come before children for upserts; children before parents for deletes.
 */
fun diffSnapshot(previous: Map<String, LocalStat>, current: Map<String, LocalStat>): List<LocalChange> {
    val upserts = current.entries.mapNotNull { (path, stat) ->
        val before = previous[path]
        when {
            before == null || before.folder != stat.folder -> LocalChange(path, "upsert", stat, false)
            !stat.folder && (before.size != stat.size || before.mtime != stat.mtime) -> LocalChange(path, "upsert", stat, true)
            else -> null
        }
    }.sortedWith(compareBy({ it.relativePath.count { c -> c == '/' } }, { it.relativePath }))
    val deletes = previous.keys.filter { it !in current }.map { LocalChange(it, "delete", null, false) }
        .sortedWith(compareByDescending<LocalChange> { it.relativePath.count { c -> c == '/' } }.thenBy { it.relativePath })
    return upserts + deletes
}

// Engine state ---------------------------------------------------------------------------------
object IssueCode {
    const val MAPPING_REQUIRED = "MAPPING_REQUIRED"; const val FOLDER_MISSING = "FOLDER_MISSING"; const val PERMISSION_DENIED = "PERMISSION_DENIED"
    const val STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED"; const val DISK_FULL = "DISK_FULL"; const val AUTH_INVALID = "AUTH_INVALID"
    const val CONFLICT = "CONFLICT"; const val FOLDER_RECOVERED = "FOLDER_RECOVERED"; const val SYNC_ERROR = "SYNC_ERROR"
}
@Serializable data class SyncIssue(val id: String, val rootId: String, val code: String, val message: String, val relativePath: String? = null,
    val conflictPath: String? = null, val jobId: String? = null, val scope: String? = null, val at: String = "")
/** Kept until the user dismisses them; a later successful sync does not clear these. */
fun stickyIssue(issue: SyncIssue) = issue.code == IssueCode.CONFLICT || issue.code == IssueCode.FOLDER_RECOVERED
data class SyncProgress(val rootId: String, val direction: String, val relativePath: String, val loaded: Long, val total: Long)
@Serializable data class SyncActivityItem(val id: String, val rootId: String, val direction: String, val relativePath: String, val at: String,
    val itemId: String? = null, val name: String? = null)
@Serializable data class WaitingItem(val rootId: String, val relativePath: String)
data class SyncRuntime(val running: Boolean = false, val paused: Boolean = false, val online: Boolean = true, val message: String = "Ready",
    val queued: Int = 0, val lastSync: String? = null, val active: SyncProgress? = null, val issues: List<SyncIssue> = emptyList(),
    val recent: List<SyncActivityItem> = emptyList(), val waiting: List<WaitingItem> = emptyList(), val confirmationPendingRoots: List<String> = emptyList())
data class SyncJobView(val id: String, val rootId: String, val relativePath: String, val kind: String, val error: String?, val attempts: Int)

const val WAITING = "Waiting for another device"
/** One folder's status label, as desktop `folderState`. */
fun folderState(root: SyncRoot, state: SyncRuntime, jobs: List<SyncJobView>): String {
    val issues = state.issues.filter { it.rootId == root.id && it.code != IssueCode.FOLDER_RECOVERED }
    if (issues.any { it.code == IssueCode.FOLDER_MISSING }) return "Folder unavailable"
    if (issues.any { it.code == IssueCode.CONFLICT }) return "Conflict"
    if (issues.isNotEmpty()) return "Action required"
    if (state.paused || root.paused) return "Paused"
    if (!state.online) return "Offline"
    if (jobs.any { it.rootId == root.id && it.error != null }) return "Action required"
    if (state.active?.rootId == root.id || jobs.any { it.rootId == root.id }) return "Syncing"
    if (state.waiting.any { it.rootId == root.id }) return WAITING
    return if (root.needsReconcile || root.id in state.confirmationPendingRoots) "Syncing" else "Up to date"
}
/** The status of every folder together, as desktop `globalSyncState`. */
fun globalSyncState(roots: List<SyncRoot>, state: SyncRuntime, jobs: List<SyncJobView>): String {
    val ids = roots.map { it.id }.toSet()
    if (state.issues.any { (it.rootId in ids || it.rootId.isEmpty()) && it.code != IssueCode.FOLDER_RECOVERED }) return "Action required"
    if (state.paused) return "Paused"
    if (!state.online) return "Offline"
    if (jobs.any { it.rootId in ids && it.error != null }) return "Action required"
    if ((state.active != null && state.active.rootId in ids) || state.confirmationPendingRoots.any { it in ids } ||
        roots.any { !it.paused && (it.needsReconcile || jobs.any { job -> job.rootId == it.id }) }) return "Syncing"
    return if (state.waiting.any { it.rootId in ids }) WAITING else "Up to date"
}
/** Problems derived from current engine state, so resolved ones disappear at once. */
fun syncRequirements(roots: List<SyncRoot>, state: SyncRuntime, jobs: List<SyncJobView>): List<SyncIssue> {
    val ids = roots.filter { it.mode == "sync" }.map { it.id }.toSet()
    val issues = state.issues.filter { it.rootId in ids || it.rootId.isEmpty() }.toMutableList()
    for (job in jobs) {
        if (job.rootId !in ids || !state.online || job.error == null) continue
        if (issues.any { it.rootId == job.rootId && !stickyIssue(it) }) continue
        issues += SyncIssue(job.id, job.rootId, IssueCode.SYNC_ERROR, job.error, job.relativePath, jobId = job.id)
    }
    return issues
}
/** Local folder errors carry POSIX-like codes so issues are classified as on desktop. */
class LocalFsException(val code: String, message: String, val relativePath: String? = null, cause: Throwable? = null): Exception(message, cause)
fun syncIssueCode(error: Throwable, item: Boolean = false): String {
    val code = (error as? LocalFsException)?.code ?: (error as? ApiException)?.code
    return when (code) {
        "ENOENT", "ENOTDIR" -> if (item) IssueCode.SYNC_ERROR else IssueCode.FOLDER_MISSING
        "EACCES", "EPERM" -> IssueCode.PERMISSION_DENIED
        "ENOSPC" -> IssueCode.DISK_FULL
        IssueCode.STORAGE_QUOTA_EXCEEDED -> IssueCode.STORAGE_QUOTA_EXCEEDED
        "AUTH_INVALID", "DEVICE_REVOKED" -> IssueCode.AUTH_INVALID
        else -> IssueCode.SYNC_ERROR
    }
}
/** Copy for each issue code, as the desktop sync page words them. */
fun issueText(issue: SyncIssue): String = when (issue.code) {
    IssueCode.MAPPING_REQUIRED -> "Finish setting up this local folder to start syncing."
    IssueCode.FOLDER_MISSING -> "The local folder can no longer be found."
    IssueCode.PERMISSION_DENIED -> "harbor0 no longer has access to this folder. Choose it again to continue."
    IssueCode.STORAGE_QUOTA_EXCEEDED -> "Your cloud storage is full. New changes cannot be uploaded."
    IssueCode.DISK_FULL -> "This phone does not have enough free space to download new changes."
    IssueCode.AUTH_INVALID -> "Your session ended. Sign in again to continue syncing."
    IssueCode.CONFLICT -> "This file was changed in more than one place. The local version has been preserved separately for review."
    IssueCode.FOLDER_RECOVERED -> "This folder was removed from sync elsewhere. The copy on this phone was kept under a new name and no longer syncs."
    else -> issue.message.ifBlank { "A change could not be synchronized." }
}

// Journal records ---------------------------------------------------------------------------------
/** A local folder on this phone, kept in step with a cloud folder (sync) or saved to the cloud (backup). */
@Serializable data class SyncRoot(
    val id: String, val treeUri: String, val localName: String, val remoteId: String?, val mode: String,
    val backupId: String? = null,
    // Backup folders only: set while the local copy is being removed, is gone, or is coming back.
    val archive: String? = null, val archiveError: String? = null,
    val paused: Boolean = false, val excluded: List<String> = emptyList(), val cloudPath: String? = null, val needsReconcile: Boolean = false,
    val shareId: String? = null, val sharedBy: String? = null, val sharedSequence: Long? = null, val lastSyncedAt: String? = null,
)
@Serializable data class LocalFile(val rootId: String, val relativePath: String, val itemId: String, val revision: Int, val hash: String?, val type: String)
@Serializable data class JobEntry(val type: String, val sizeBytes: Long, val updatedAt: Long)
@Serializable data class UploadState(var operationId: String, var uploadId: String? = null, var partSize: Long? = null, var hash: String? = null,
    var size: Long? = null, var mtime: Long? = null, var parts: List<CompletedPart>? = null)
@Serializable data class JobPayload(var entry: JobEntry? = null, var retryAt: Long? = null, var observedAt: Long? = null, var relayVersion: String? = null,
    var upload: UploadState? = null, var backupRunId: String? = null, var backupManual: Boolean? = null, var backupEntry: BackupEntry? = null,
    var retryAfter: Long? = null)
data class LocalJob(val id: String, val rootId: String, val relativePath: String, val kind: String, val payload: JobPayload, var attempts: Int, var error: String?)
@Serializable data class PendingRun(val id: String, val trigger: String, val jobs: List<String>, val error: String? = null)
