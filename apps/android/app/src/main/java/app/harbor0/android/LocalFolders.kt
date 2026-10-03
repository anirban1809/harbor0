package app.harbor0.android

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/** One entry in a local folder. */
data class LocalEntry(val name: String, val id: String, val folder: Boolean, val size: Long, val mtime: Long) {
    val stat get() = LocalStat(folder, if (folder) 0 else size, if (folder) 0 else mtime)
}

/**
 * A local folder chosen by the user. Paths are relative ("a/b.txt", "" for the folder itself). Every failure is a
 * [LocalFsException] with a POSIX-like code, and carries the relative path when it concerns an item inside the folder.
 */
interface LocalTree {
    val name: String
    /** Fails with ENOENT, ENOTDIR or EACCES when the folder itself is unavailable. */
    fun check()
    fun list(relative: String): List<LocalEntry>
    fun stat(relative: String): LocalEntry?
    /** Creates the folders above [relative]; a file in the way is an error. */
    fun ensureParents(relative: String, create: Boolean = true)
    fun mkdirs(relative: String)
    fun openRead(relative: String): InputStream
    /** Creates an empty file named exactly as the last segment; an existing entry is an error. */
    fun createFile(relative: String)
    fun openWrite(relative: String, append: Boolean): OutputStream
    /** Renames or moves; the destination must not exist. */
    fun rename(from: String, to: String)
    fun delete(relative: String)
}

fun LocalTree.hash(relative: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    openRead(relative).use { input ->
        val buffer = ByteArray(1024 * 1024)
        while (true) {
            val count = try { input.read(buffer) } catch (e: IOException) { throw localError(e, relative) }
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/** Walks a folder, skipping internal and excluded paths, as one directory listing per folder. */
fun scanTree(tree: LocalTree, excluded: List<String>, stopped: () -> Boolean = { false }): Map<String, LocalStat>? {
    val result = linkedMapOf<String, LocalStat>()
    val pending = ArrayDeque(listOf(""))
    while (pending.isNotEmpty()) {
        if (stopped()) return null
        val folder = pending.removeFirst()
        val entries = try { tree.list(folder) } catch (e: LocalFsException) {
            // A folder deleted during the scan simply has no entries now.
            if (folder.isNotEmpty() && e.code == "ENOENT") continue else throw e
        }
        for (entry in entries) {
            val path = joinPath(folder, entry.name)
            if (entry.name.isEmpty() || entry.name.contains('/') || ignoredPath(excluded, path)) continue
            result[path] = entry.stat
            if (entry.folder) pending.addLast(path)
        }
    }
    return result
}

fun localError(e: Throwable, relative: String?): LocalFsException = when (e) {
    is LocalFsException -> e
    is FileNotFoundException -> LocalFsException("ENOENT", "“${relative?.ifEmpty { null } ?: "The folder"}” could not be found.", relative, e)
    is SecurityException -> LocalFsException("EACCES", "harbor0 no longer has access to this folder. Choose it again to continue.", null, e)
    is IllegalArgumentException, is IllegalStateException -> LocalFsException("ENOENT", "“${relative?.ifEmpty { null } ?: "The folder"}” could not be found.", relative, e)
    is IOException -> if ((e.message ?: "").let { it.contains("ENOSPC") || it.contains("No space", ignoreCase = true) })
        LocalFsException("ENOSPC", "This phone is out of storage space.", relative, e)
        else LocalFsException("EIO", e.message ?: "The local file could not be read.", relative, e)
    is UnsupportedOperationException -> LocalFsException("EIO", "This storage location does not support that change.", relative, e)
    else -> LocalFsException("EIO", e.message ?: "The local file could not be read.", relative, e)
}

/** Whether one chosen folder is inside another (or the same), judged by their document ids. */
fun treesOverlap(a: Uri, b: Uri): Boolean {
    if (a.authority != b.authority) return false
    val x = runCatching { DocumentsContract.getTreeDocumentId(a) }.getOrNull() ?: return a == b
    val y = runCatching { DocumentsContract.getTreeDocumentId(b) }.getOrNull() ?: return a == b
    fun inside(child: String, parent: String) = child == parent || child.startsWith(if (parent.endsWith(":") || parent.endsWith("/")) parent else "$parent/")
    return inside(x, y) || inside(y, x)
}

/** A document tree from the Storage Access Framework, with persisted read and write access. */
class SafTree(private val context: Context, val uri: Uri): LocalTree {
    private val resolver: ContentResolver get() = context.contentResolver
    private val rootId = DocumentsContract.getTreeDocumentId(uri)
    private val ids = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val projection = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)
    private fun documentUri(id: String) = DocumentsContract.buildDocumentUriUsingTree(uri, id)
    override val name: String get() = runCatching { query(documentUri(rootId)).firstOrNull()?.name }.getOrNull() ?: uri.lastPathSegment?.substringAfterLast(':')?.substringAfterLast('/') ?: "Folder"

    private fun <T> local(relative: String?, block: () -> T): T = try { block() } catch (e: Exception) { throw localError(e, relative) }
    private fun query(target: Uri): List<LocalEntry> = (resolver.query(target, projection, null, null, null) ?: throw FileNotFoundException(target.toString())).use { c ->
        buildList {
            while (c.moveToNext()) add(LocalEntry(c.getString(1) ?: "", c.getString(0), c.getString(2) == Document.MIME_TYPE_DIR,
                if (c.isNull(3)) 0 else c.getLong(3), if (c.isNull(4)) 0 else c.getLong(4)))
        }
    }
    override fun check() {
        val granted = resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission && it.isWritePermission }
        if (!granted) throw LocalFsException("EACCES", "harbor0 no longer has access to this folder. Choose it again to continue.")
        val root = try { query(documentUri(rootId)).firstOrNull() } catch (e: Exception) {
            val code = if (localError(e, null).code == "EACCES") "EACCES" else "ENOENT"
            throw LocalFsException(code, "The local folder is unavailable.", null, e)
        } ?: throw LocalFsException("ENOENT", "The local folder is unavailable.")
        if (!root.folder) throw LocalFsException("ENOTDIR", "The local folder is unavailable.")
    }
    private fun childrenOf(relative: String, id: String): List<LocalEntry> {
        val entries = query(DocumentsContract.buildChildDocumentsUriUsingTree(uri, id))
        entries.forEach { ids[joinPath(relative, it.name)] = it.id }
        return entries
    }
    /** The document id for a path, or null when it does not exist. */
    private fun resolve(relative: String): String? {
        if (relative.isEmpty()) return rootId
        ids[relative]?.let { cached ->
            val found = runCatching { query(documentUri(cached)).firstOrNull() }.getOrNull()
            if (found != null && found.name == baseName(relative)) return cached
            forget(relative)
        }
        val parent = resolve(parentPath(relative)) ?: return null
        return childrenOf(parentPath(relative), parent).firstOrNull { it.name == baseName(relative) }?.id
    }
    private fun forget(relative: String) { ids.keys.removeAll { it == relative || it.startsWith("$relative/") } }
    private fun need(relative: String) = resolve(relative) ?: throw FileNotFoundException(relative)
    override fun list(relative: String): List<LocalEntry> = local(relative) {
        val id = need(relative)
        childrenOf(relative, id)
    }
    override fun stat(relative: String): LocalEntry? = local(relative) {
        if (relative.isEmpty()) return@local query(documentUri(rootId)).firstOrNull()
        val id = resolve(relative) ?: return@local null
        query(documentUri(id)).firstOrNull()
    }
    override fun ensureParents(relative: String, create: Boolean) = local(relative) {
        var current = ""
        for (segment in relative.split('/').dropLast(1)) {
            val next = joinPath(current, segment)
            val existing = stat(next)
            if (existing != null) {
                if (!existing.folder) throw LocalFsException("ENOTDIR", "A file blocks this destination.", next)
            } else if (create) createDocument(next, Document.MIME_TYPE_DIR)
            else throw FileNotFoundException(next)
            current = next
        }
    }
    override fun mkdirs(relative: String) = local(relative) {
        if (relative.isEmpty()) return@local
        ensureParents(relative)
        val existing = stat(relative)
        if (existing == null) createDocument(relative, Document.MIME_TYPE_DIR)
        else if (!existing.folder) throw LocalFsException("ENOTDIR", "A file blocks this folder.", relative)
    }
    private fun createDocument(relative: String, mime: String) {
        val parent = need(parentPath(relative))
        val created = DocumentsContract.createDocument(resolver, documentUri(parent), mime, baseName(relative)) ?: throw IOException("Could not create “${baseName(relative)}”.")
        val id = DocumentsContract.getDocumentId(created)
        // Providers pick a unique name when one is taken; never write somewhere other than asked.
        val actual = query(documentUri(id)).firstOrNull()?.name
        if (actual != baseName(relative)) {
            runCatching { DocumentsContract.deleteDocument(resolver, documentUri(id)) }
            throw LocalFsException("EEXIST", "“${baseName(relative)}” could not be created here.", relative)
        }
        ids[relative] = id
    }
    override fun openRead(relative: String): InputStream = local(relative) { resolver.openInputStream(documentUri(need(relative))) ?: throw FileNotFoundException(relative) }
    override fun createFile(relative: String) = local(relative) {
        if (stat(relative) != null) throw LocalFsException("EEXIST", "“${baseName(relative)}” already exists.", relative)
        createDocument(relative, "application/octet-stream")
    }
    override fun openWrite(relative: String, append: Boolean): OutputStream = local(relative) {
        resolver.openOutputStream(documentUri(need(relative)), if (append) "wa" else "wt") ?: throw FileNotFoundException(relative)
    }
    override fun rename(from: String, to: String) = local(from) {
        if (stat(to) != null) throw LocalFsException("EEXIST", "“${baseName(to)}” already exists.", to)
        val id = need(from)
        var current = documentUri(id)
        if (parentPath(from) != parentPath(to)) {
            ensureParents(to)
            val source = documentUri(need(parentPath(from)))
            val target = documentUri(need(parentPath(to)))
            current = try { DocumentsContract.moveDocument(resolver, current, source, target) ?: throw UnsupportedOperationException() }
                catch (e: UnsupportedOperationException) { copyThenDelete(from, to); forget(from); forget(to); return@local }
        }
        if (baseName(from) != baseName(to)) {
            current = DocumentsContract.renameDocument(resolver, current, baseName(to)) ?: current
            val actual = query(current).firstOrNull()?.name
            if (actual != baseName(to)) throw LocalFsException("EIO", "“${baseName(from)}” could not be renamed.", from)
        }
        forget(from); forget(to)
        ids[to] = DocumentsContract.getDocumentId(current)
    }
    /** For storage that cannot move documents: copy everything, then remove the original. */
    private fun copyThenDelete(from: String, to: String) {
        val entry = stat(from) ?: throw FileNotFoundException(from)
        if (entry.folder) {
            mkdirs(to)
            list(from).forEach { copyThenDelete(joinPath(from, it.name), joinPath(to, it.name)) }
        } else {
            createFile(to)
            openRead(from).use { input -> openWrite(to, false).use { input.copyTo(it) } }
        }
        delete(from)
    }
    override fun delete(relative: String) = local(relative) {
        require(relative.isNotEmpty()) { "The selected folder itself is never deleted." }
        val id = resolve(relative) ?: return@local
        DocumentsContract.deleteDocument(resolver, documentUri(id))
        forget(relative)
    }

    companion object {
        const val FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        /** Keeps access to a folder chosen with the system picker across restarts. */
        fun persist(context: Context, uri: Uri) = try { context.contentResolver.takePersistableUriPermission(uri, FLAGS) }
            catch (e: SecurityException) { throw IllegalStateException("harbor0 could not keep access to this folder. Choose a different folder.") }
        fun release(context: Context, uri: Uri) { runCatching { context.contentResolver.releasePersistableUriPermission(uri, FLAGS) } }
    }
}
