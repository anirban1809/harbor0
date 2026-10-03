package app.harbor0.android

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.serializer
import java.security.MessageDigest
import java.util.UUID

/**
 * The sync journal, one SQLite database per account (desktop `journal.ts`): settings, folders, the files
 * each folder tracks, queued local jobs, and the last scan of every local folder (Android has no file watcher).
 */
class SyncJournal(context: Context, account: String, realm: String = BuildConfig.API_URL):
    SQLiteOpenHelper(context, "sync-" + MessageDigest.getInstance("SHA-256").digest("${realm.trimEnd('/')}\n$account".toByteArray())
        .joinToString("") { "%02x".format(it) }.take(32) + ".db", null, 1) {
    override fun onConfigure(db: SQLiteDatabase) { db.enableWriteAheadLogging() }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execSQL("CREATE TABLE roots(id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execSQL("CREATE TABLE files(root_id TEXT NOT NULL, relative_path TEXT NOT NULL, item_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(root_id, relative_path))")
        db.execSQL("CREATE INDEX files_item ON files(root_id, item_id)")
        db.execSQL("CREATE TABLE jobs(id TEXT PRIMARY KEY, root_id TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX jobs_path ON jobs(root_id, relative_path, kind)")
        db.execSQL("CREATE TABLE snapshot(root_id TEXT NOT NULL, relative_path TEXT NOT NULL, folder INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, PRIMARY KEY(root_id, relative_path))")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}
    private val db get() = writableDatabase
    private var lastCreated = 0L

    // Settings --------------------------------------------------------------------------------
    fun raw(key: String): String? = db.rawQuery("SELECT value FROM settings WHERE key=?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }
    inline fun <reified T> get(key: String): T? = raw(key)?.let { runCatching { harborJson.decodeFromString(serializer<T>(), it) }.getOrNull() }
    inline fun <reified T> set(key: String, value: T) = setRaw(key, harborJson.encodeToString(serializer<T>(), value))
    fun setRaw(key: String, value: String) {
        db.insertWithOnConflict("settings", null, ContentValues().apply { put("key", key); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE)
    }
    fun remove(key: String) { db.delete("settings", "key=?", arrayOf(key)) }
    fun flag(key: String) = raw(key)?.let { it != "false" && it != "null" && it != "0" } == true
    fun element(key: String): JsonElement? = raw(key)?.let { runCatching { harborJson.parseToJsonElement(it) }.getOrNull() }

    // Folders ------------------------------------------------------------------------------------
    fun roots(): List<SyncRoot> = db.rawQuery("SELECT data FROM roots ORDER BY rowid", null).use { c ->
        buildList { while (c.moveToNext()) runCatching { harborJson.decodeFromString<SyncRoot>(c.getString(0)) }.getOrNull()?.let(::add) }
    }
    fun root(id: String) = roots().firstOrNull { it.id == id }
    fun root(root: SyncRoot) {
        val values = ContentValues().apply { put("data", harborJson.encodeToString(SyncRoot.serializer(), root)) }
        if (db.update("roots", values, "id=?", arrayOf(root.id)) == 0) db.insert("roots", null, values.apply { put("id", root.id) })
    }
    /** Removes only local bookkeeping. Neither copy of the files is deleted. */
    fun removeRoot(id: String) = transaction {
        db.delete("jobs", "root_id=?", arrayOf(id)); db.delete("files", "root_id=?", arrayOf(id))
        db.delete("snapshot", "root_id=?", arrayOf(id)); db.delete("roots", "id=?", arrayOf(id))
    }
    fun resetRootFiles(id: String) = transaction {
        db.delete("jobs", "root_id=?", arrayOf(id)); db.delete("files", "root_id=?", arrayOf(id)); db.delete("snapshot", "root_id=?", arrayOf(id))
    }
    fun <T> transaction(block: () -> T): T {
        db.beginTransaction()
        try { return block().also { db.setTransactionSuccessful() } } finally { db.endTransaction() }
    }

    // Tracked files ---------------------------------------------------------------------------------
    private fun fileRows(where: String, args: Array<String>): List<LocalFile> = db.rawQuery("SELECT data FROM files WHERE $where", args).use { c ->
        buildList { while (c.moveToNext()) add(harborJson.decodeFromString<LocalFile>(c.getString(0))) }
    }
    fun file(rootId: String, relativePath: String) = fileRows("root_id=? AND relative_path=?", arrayOf(rootId, relativePath)).firstOrNull()
    fun fileByItem(rootId: String, itemId: String) = fileRows("root_id=? AND item_id=?", arrayOf(rootId, itemId)).firstOrNull()
    fun files(rootId: String) = fileRows("root_id=?", arrayOf(rootId))
    fun fileCounts(rootId: String): Pair<Int, Int> = db.rawQuery("SELECT COALESCE(SUM(type='FILE'),0), COALESCE(SUM(type='FOLDER'),0) FROM files WHERE root_id=?", arrayOf(rootId))
        .use { if (it.moveToFirst()) it.getInt(0) to it.getInt(1) else 0 to 0 }
    fun putFile(file: LocalFile) {
        db.insertWithOnConflict("files", null, ContentValues().apply {
            put("root_id", file.rootId); put("relative_path", file.relativePath); put("item_id", file.itemId); put("type", file.type)
            put("data", harborJson.encodeToString(LocalFile.serializer(), file))
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }
    fun deleteFile(rootId: String, relativePath: String) { db.delete("files", "root_id=? AND relative_path=?", arrayOf(rootId, relativePath)) }

    // Jobs --------------------------------------------------------------------------------------------
    fun enqueue(rootId: String, relativePath: String, kind: String, entry: JobEntry? = null, observedAt: Long? = null) {
        val existing = db.rawQuery("SELECT id, payload FROM jobs WHERE root_id=? AND relative_path=? AND kind=?", arrayOf(rootId, relativePath, kind))
            .use { if (it.moveToFirst()) it.getString(0) to it.getString(1) else null }
        if (existing != null) {
            // A fresh local change retries immediately instead of waiting out an earlier failure.
            val payload = runCatching { harborJson.decodeFromString<JobPayload>(existing.second) }.getOrElse { JobPayload() }
            payload.retryAt = null
            if (entry != null) payload.entry = entry
            if (observedAt != null) payload.observedAt = observedAt
            db.update("jobs", ContentValues().apply { put("payload", harborJson.encodeToString(JobPayload.serializer(), payload)) }, "id=?", arrayOf(existing.first))
            return
        }
        // Strictly increasing creation times keep jobs in the order the scan produced them.
        val created = maxOf(System.currentTimeMillis(), lastCreated + 1).also { lastCreated = it }
        db.insert("jobs", null, ContentValues().apply {
            put("id", UUID.randomUUID().toString()); put("root_id", rootId); put("relative_path", relativePath); put("kind", kind); put("created_at", created)
            put("payload", harborJson.encodeToString(JobPayload.serializer(), JobPayload(entry = entry, observedAt = observedAt)))
        })
    }
    fun jobCount(): Int = db.rawQuery("SELECT COUNT(*) FROM jobs", null).use { if (it.moveToFirst()) it.getInt(0) else 0 }
    fun jobs(rootId: String? = null): List<LocalJob> = db.rawQuery("SELECT id, root_id, relative_path, kind, payload, attempts, error FROM jobs" +
        (if (rootId != null) " WHERE root_id=?" else "") + " ORDER BY created_at, id", rootId?.let { arrayOf(it) }).use { c ->
        buildList {
            while (c.moveToNext()) add(LocalJob(c.getString(0), c.getString(1), c.getString(2), c.getString(3),
                runCatching { harborJson.decodeFromString<JobPayload>(c.getString(4)) }.getOrElse { JobPayload() }, c.getInt(5), c.getString(6)))
        }
    }
    fun job(id: String) = db.rawQuery("SELECT id, root_id, relative_path, kind, payload, attempts, error FROM jobs WHERE id=?", arrayOf(id)).use { c ->
        if (!c.moveToFirst()) null else LocalJob(c.getString(0), c.getString(1), c.getString(2), c.getString(3),
            runCatching { harborJson.decodeFromString<JobPayload>(c.getString(4)) }.getOrElse { JobPayload() }, c.getInt(5), c.getString(6))
    }
    fun findJob(rootId: String, relativePath: String, kind: String) = jobs(rootId).firstOrNull { it.relativePath == relativePath && it.kind == kind }
    fun hasJob(rootId: String, relativePath: String) = db.rawQuery("SELECT 1 FROM jobs WHERE root_id=? AND relative_path=? LIMIT 1", arrayOf(rootId, relativePath)).use { it.moveToFirst() }
    /** Queue rows without payloads, for status screens. */
    fun jobViews(limit: Int = 5000): List<SyncJobView> = db.rawQuery("SELECT id, root_id, relative_path, kind, error, attempts FROM jobs ORDER BY created_at, id LIMIT $limit", null).use { c ->
        buildList { while (c.moveToNext()) add(SyncJobView(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4), c.getInt(5))) }
    }
    fun saveJob(job: LocalJob) {
        db.update("jobs", ContentValues().apply {
            put("payload", harborJson.encodeToString(JobPayload.serializer(), job.payload)); put("attempts", job.attempts); put("error", job.error)
        }, "id=?", arrayOf(job.id))
    }
    fun finish(id: String) { db.delete("jobs", "id=?", arrayOf(id)) }

    // Local scans -------------------------------------------------------------------------------------
    fun snapshot(rootId: String): Map<String, LocalStat> = db.rawQuery("SELECT relative_path, folder, size, mtime FROM snapshot WHERE root_id=?", arrayOf(rootId)).use { c ->
        buildMap { while (c.moveToNext()) put(c.getString(0), LocalStat(c.getInt(1) == 1, c.getLong(2), c.getLong(3))) }
    }
    fun replaceSnapshot(rootId: String, entries: Map<String, LocalStat>) = transaction {
        db.delete("snapshot", "root_id=?", arrayOf(rootId))
        entries.forEach { (path, stat) -> insertSnapshot(rootId, path, stat) }
    }
    private fun insertSnapshot(rootId: String, path: String, stat: LocalStat) {
        db.insertWithOnConflict("snapshot", null, ContentValues().apply {
            put("root_id", rootId); put("relative_path", path); put("folder", if (stat.folder) 1 else 0); put("size", stat.size); put("mtime", stat.mtime)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }
    /** Records a change the engine made itself, so the next scan does not report it as a local edit. */
    fun snapshotPut(rootId: String, path: String, stat: LocalStat?) {
        if (stat == null) snapshotRemove(rootId, path) else insertSnapshot(rootId, path, stat)
    }
    fun snapshotRemove(rootId: String, path: String) {
        db.delete("snapshot", "root_id=? AND (relative_path=? OR substr(relative_path, 1, ?)=?)", arrayOf(rootId, path, (path.length + 1).toString(), "$path/"))
    }
    fun snapshotMove(rootId: String, from: String, to: String) = transaction {
        val moved = snapshot(rootId).filterKeys { it == from || it.startsWith("$from/") }
        snapshotRemove(rootId, from)
        moved.forEach { (path, stat) -> insertSnapshot(rootId, to + path.substring(from.length), stat) }
    }
}
