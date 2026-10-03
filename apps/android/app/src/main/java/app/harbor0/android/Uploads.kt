package app.harbor0.android

import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.compose.runtime.*
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import java.io.File
import java.util.UUID

enum class UploadPhase { Queued, Hashing, Uploading, Paused, Done, Failed }
/** One file's upload. Files from a chosen folder share a group, shown as one row. */
data class UploadEntry(val key: String, val name: String, val size: Long, val loaded: Long = 0, val phase: UploadPhase = UploadPhase.Queued,
    val error: String? = null, val groupKey: String? = null, val groupName: String? = null)
data class UploadActivity(val key: String, val folder: Boolean, val name: String, val size: Long, val loaded: Long, val phase: UploadPhase,
    val error: String?, val files: Int, val filesDone: Int, val filesFailed: Int, val keys: List<String>)
/** A file picked on this device, with the folders to create above it for folder uploads. */
data class PickedFile(val uri: Uri, val name: String, val size: Long, val mime: String, val folders: List<String> = emptyList())

/** Rolls folder uploads into one row each, as the web upload tray does. */
fun summarizeUploads(entries: List<UploadEntry>): List<UploadActivity> = entries.groupBy { it.groupKey ?: it.key }.map { (key, members) ->
    val first = members.first()
    val phases = members.map { it.phase }
    val active = phases.any { it == UploadPhase.Hashing || it == UploadPhase.Uploading }
    val phase = if (first.groupKey == null) first.phase else when {
        active -> UploadPhase.Uploading
        UploadPhase.Paused in phases -> UploadPhase.Paused
        UploadPhase.Queued in phases -> UploadPhase.Queued
        UploadPhase.Failed in phases -> UploadPhase.Failed
        else -> UploadPhase.Done
    }
    UploadActivity(key, first.groupKey != null, first.groupName ?: first.name, members.sumOf { it.size },
        members.sumOf { if (it.phase == UploadPhase.Done) it.size else it.loaded }, phase, members.firstOrNull { it.phase == UploadPhase.Failed }?.error,
        members.size, phases.count { it == UploadPhase.Done }, phases.count { it == UploadPhase.Failed }, members.map { it.key })
}
fun uploadDetail(a: UploadActivity): String {
    val amount = "${bytesLabel(a.loaded)} of ${bytesLabel(a.size)}"
    val count = { n: Int -> plural(n, "file") }
    if (!a.folder) return when (a.phase) {
        UploadPhase.Queued -> "Waiting…"; UploadPhase.Hashing -> "Preparing file…"; UploadPhase.Uploading -> amount
        UploadPhase.Paused -> "Paused · $amount"; UploadPhase.Done -> "Uploaded"; UploadPhase.Failed -> a.error ?: "Upload failed"
    }
    val failed = if (a.filesFailed > 0) " · ${a.filesFailed} failed" else ""
    val files = "${a.filesDone} of ${count(a.files)}"
    return when (a.phase) {
        UploadPhase.Queued -> "Waiting · ${count(a.files)}"
        UploadPhase.Hashing, UploadPhase.Uploading -> "$files · $amount$failed"
        UploadPhase.Paused -> "Paused · $files$failed"
        UploadPhase.Done -> "${count(a.files)} uploaded"
        UploadPhase.Failed -> "${a.filesFailed} of ${count(a.files)} failed${a.error?.let { " · $it" } ?: ""}"
    }
}

/** Uploads one file at a time; paused, cancelled or already running files are skipped. Pausing restarts that file when resumed. */
class UploadQueue(private val m: WorkspaceModel) {
    var entries by mutableStateOf<List<UploadEntry>>(emptyList()); private set
    private class Job(val file: PickedFile, val batch: String, val base: String?, var stopped: Boolean = false)
    private val jobs = mutableMapOf<String, Job>()
    // Folders created for each batch, by path, so files in a folder share it.
    private val created = mutableMapOf<String, MutableMap<String, String>>()
    private var runner: kotlinx.coroutines.Job? = null
    private var current: Pair<String, kotlinx.coroutines.Job>? = null
    val active get() = entries.any { it.phase == UploadPhase.Queued || it.phase == UploadPhase.Hashing || it.phase == UploadPhase.Uploading }
    private fun update(key: String, change: (UploadEntry) -> UploadEntry) { entries = entries.map { if (it.key == key) change(it) else it } }

    fun clear() { runner?.cancel(); current?.second?.cancel(); jobs.clear(); created.clear(); entries = emptyList() }
    fun addUris(uris: List<Uri>) {
        m.viewModelScope.launch {
            try { add(withContext(Dispatchers.IO) { uris.map { describe(it) } }) } catch (e: CancellationException) { throw e } catch (e: Exception) { m.report(e) }
        }
    }
    /** Walks a folder chosen with the system picker and uploads every file inside it, recreating its subfolders. */
    fun addTree(tree: Uri) {
        m.viewModelScope.launch {
            try {
                val files = withContext(Dispatchers.IO) {
                    val resolver = m.context.contentResolver
                    val rootId = DocumentsContract.getTreeDocumentId(tree)
                    val rootName = resolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                        ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "Folder"
                    val out = mutableListOf<PickedFile>()
                    fun walk(id: String, path: List<String>) {
                        resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE), null, null, null)?.use { c ->
                            while (c.moveToNext()) {
                                val child = c.getString(0); val name = c.getString(1) ?: continue; val mime = c.getString(2) ?: "application/octet-stream"
                                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) walk(child, path + name)
                                else out += PickedFile(DocumentsContract.buildDocumentUriUsingTree(tree, child), name, if (c.isNull(3)) 0 else c.getLong(3), mime, path)
                            }
                        }
                    }
                    walk(rootId, listOf(rootName))
                    out
                }
                if (files.isEmpty()) m.notify("This folder has no files to upload.") else add(files)
            } catch (e: CancellationException) { throw e } catch (e: Exception) { m.report(e) }
        }
    }
    private fun describe(uri: Uri): PickedFile {
        val resolver = m.context.contentResolver
        var name = "Upload"; var size = 0L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) { c.getString(0)?.let { name = it }; if (!c.isNull(1)) size = c.getLong(1) }
        }
        return PickedFile(uri, name, size, resolver.getType(uri) ?: "application/octet-stream")
    }
    fun add(files: List<PickedFile>) {
        val drive = m.drive
        if (!drive.canWriteHere) { m.error = "Uploads are unavailable in this location"; return }
        val batch = UUID.randomUUID().toString()
        val base = drive.folderId
        val queued = files.mapIndexed { index, file ->
            val key = "$batch/$index"
            jobs[key] = Job(file, batch, base)
            UploadEntry(key, file.name, file.size, groupKey = file.folders.firstOrNull()?.let { "$batch/$it" }, groupName = file.folders.firstOrNull())
        }
        entries = entries + queued
        drain()
    }
    private fun drain() {
        if (runner?.isActive == true) return
        runner = m.viewModelScope.launch {
            while (true) {
                val key = entries.firstOrNull { it.phase == UploadPhase.Queued && jobs[it.key]?.stopped == false }?.key ?: break
                val job = launch { run(key) }
                current = key to job
                job.join()
                current = null
            }
        }
    }
    private suspend fun run(key: String) {
        val job = jobs[key] ?: return
        val scratch = File(m.context.cacheDir, "transfers/${UUID.randomUUID()}")
        try {
            update(key) { it.copy(phase = UploadPhase.Hashing, error = null, loaded = 0) }
            val parent = parentFor(job)
            val name = safeName(job.file.name)
            withContext(Dispatchers.IO) {
                check(scratch.parentFile!!.mkdirs() || scratch.parentFile!!.isDirectory)
                m.context.contentResolver.openInputStream(job.file.uri)?.use { input -> scratch.outputStream().use { output ->
                    val buffer = ByteArray(256 * 1024)
                    while (true) { ensureActive(); val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n) }
                } } ?: error("The selected file could not be opened. Select it again.")
            }
            val size = scratch.length()
            update(key) { it.copy(size = size) }
            m.transfers.upload(scratch, name, job.file.mime, parent) { label, fraction ->
                m.viewModelScope.launch {
                    update(key) { it.copy(phase = if (label.startsWith("Uploading")) UploadPhase.Uploading else UploadPhase.Hashing,
                        loaded = ((fraction ?: 0f) * size).toLong()) }
                }
            }
            update(key) { it.copy(phase = UploadPhase.Done, loaded = it.size) }
            jobs.remove(key)
            m.drive.refresh(); m.refreshAccount()
        } catch (e: CancellationException) {
            if (jobs[key]?.stopped == true) update(key) { it.copy(phase = UploadPhase.Paused) }
            if (!currentCoroutineContext().isActive && jobs[key] == null) return
        } catch (e: Exception) {
            update(key) { it.copy(phase = UploadPhase.Failed, error = m.message(e)) }
        } finally { withContext(NonCancellable + Dispatchers.IO) { scratch.delete() } }
    }
    private suspend fun parentFor(job: Job): String? {
        val folders = created.getOrPut(job.batch) { mutableMapOf() }
        var parent = job.base
        var path = ""
        for (name in job.file.folders) {
            path += "/$name"
            parent = folders[path] ?: m.api.createFolder(name, parent).id.also { folders[path] = it }
        }
        return parent
    }
    fun pause(keys: List<String>) {
        for (key in keys) {
            val job = jobs[key] ?: continue
            job.stopped = true
            if (current?.first == key) current?.second?.cancel() else update(key) { if (it.phase == UploadPhase.Queued) it.copy(phase = UploadPhase.Paused) else it }
        }
    }
    fun resume(keys: List<String>) {
        for (key in keys) { jobs[key]?.stopped = false; if (jobs.containsKey(key)) update(key) { it.copy(phase = UploadPhase.Queued, error = null) } }
        drain()
    }
    fun cancel(keys: List<String>) {
        for (key in keys) { jobs.remove(key)?.stopped = true; if (current?.first == key) current?.second?.cancel() }
        entries = entries.filter { it.key !in keys }
    }
    fun dismiss() {
        val finished = summarizeUploads(entries).filter { it.phase == UploadPhase.Done || it.phase == UploadPhase.Failed }.flatMap { it.keys }.toSet()
        finished.forEach { jobs.remove(it) }
        entries = entries.filter { it.key !in finished }
    }
}
