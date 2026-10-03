package app.harbor0.android

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.work.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Process-wide services shared by the UI and background work. */
object Harbor {
    @Volatile private var api: HarborApi? = null
    @Volatile private var sync: SyncController? = null
    fun api(context: Context): HarborApi = api ?: synchronized(this) {
        api ?: HarborApi(BuildConfig.API_URL, KeystoreCredentials(context.applicationContext), deviceKeys = KeystoreDeviceKeys(context.applicationContext)).also { api = it }
    }
    fun sync(context: Context): SyncController = sync ?: synchronized(this) {
        sync ?: SyncController(context.applicationContext, api(context)).also { sync = it }
    }
}

/** Where a new sync folder lives in the cloud, as the desktop `addSyncRoot` options. */
sealed interface CloudChoice {
    /** Keep the current folder, or create one named after the local folder (numbered if the name is taken). */
    data object Automatic: CloudChoice
    data class Existing(val id: String): CloudChoice
    data class NewIn(val parentId: String?, val name: String): CloudChoice
}

/**
 * Runs the sync engine for the signed-in account: registers this phone as a sync device, keeps the engine running
 * while the process is alive, schedules periodic background passes, and carries out folder setup (desktop main.ts).
 */
class SyncController(private val context: Context, val api: HarborApi) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private var relay: Job? = null
    private var account: String? = null
    @Volatile var engine: SyncEngine? = null; private set
    private val _view = MutableStateFlow<SyncView?>(null)
    /** Null until sync has started for the signed-in account. */
    val view: StateFlow<SyncView?> = _view.asStateFlow()
    private val _startError = MutableStateFlow<String?>(null)
    val startError: StateFlow<String?> = _startError.asStateFlow()
    var foreground = true
        set(value) { field = value; engine?.foreground = value; if (value) engine?.wake() }
    private val transfers by lazy { SyncTransfers(api) }
    val deviceName: String get() = "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(100).ifEmpty { "Android phone" }

    /** Starts sync for [userId]; returns the running engine. Safe to call repeatedly. */
    suspend fun connect(userId: String): SyncEngine = lock.withLock {
        engine?.takeIf { account == userId }?.let { return it }
        stopLocked()
        val journal = SyncJournal(context, userId)
        // The backend's device id is this session's id; registering keeps the proven installation identity.
        val deviceId = try {
            val device = harborJson.decodeFromJsonElement<DeviceResponse>(api.request("/v1/sync/devices/register", "POST", buildJsonObject {
                put("name", deviceName); put("platform", "ANDROID")
            })).device
            journal.set("deviceId", device.id); journal.set("deviceName", device.name)
            device.id
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            journal.get<String>("deviceId") ?: run { journal.close(); _startError.value = message(e); throw e }
        }
        _startError.value = null
        // Keep the last known cloud location while offline.
        for (root in journal.roots()) runCatching { journal.root(root.copy(cloudPath = if (root.shareId != null) root.cloudPath else cloudLocation(root.remoteId))) }
        val created = SyncEngine(api, journal, deviceId, { SafTree(context, Uri.parse(it.treeUri)) }, transfers, scope) {
            journal.get<String>("deviceName") ?: deviceName
        }
        created.foreground = foreground
        account = userId; engine = created
        relay = scope.launch { created.view.collect { _view.value = it } }
        created.start()
        schedule(journal.roots().isNotEmpty())
        created
    }
    /** Stops sync, e.g. on sign-out. Local files, the journal and queued work are kept. */
    suspend fun disconnect(cancelBackground: Boolean = true) = lock.withLock {
        stopLocked()
        if (cancelBackground) WorkManager.getInstance(context).cancelUniqueWork(WORK)
    }
    private suspend fun stopLocked() {
        engine?.let { it.stop(); it.journal.close() }
        relay?.cancel(); relay = null
        engine = null; account = null; _view.value = null
    }
    fun message(e: Throwable) = if (e is java.io.IOException) "Could not connect. Check your connection and try again." else e.message ?: "This action could not be completed. Try again."
    private fun running() = engine ?: throw IllegalStateException("Sync is starting. Try again in a moment.")

    /** Background passes run about every 15 minutes while any folder is set up; Android may run them later. */
    fun schedule(enabled: Boolean) {
        val work = WorkManager.getInstance(context)
        if (!enabled) { work.cancelUniqueWork(WORK); return }
        work.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES).build())
    }

    /** "My Drive / a / b" for a cloud folder. */
    suspend fun cloudLocation(id: String?): String {
        val names = mutableListOf<String>()
        val seen = mutableSetOf<String>()
        var current = id
        while (current != null) {
            check(seen.add(current) && seen.size < 64) { "Folder path is unavailable." }
            val item = api.get<ItemResponse>("/v1/drive/items/${HarborApi.segment(current)}").item
            names.add(0, item.name); current = item.parentId
        }
        return (listOf("My Drive") + names).joinToString(" / ")
    }

    // Folder setup (desktop IPC handlers) -----------------------------------------------------------------
    private fun treeName(uri: Uri) = SafTree(context, uri).name
    /** Backs up a folder chosen with the system picker. */
    suspend fun addBackup(uri: Uri) {
        val engine = running()
        SafTree.persist(context, uri)
        try {
            val name = withContext(Dispatchers.IO) { treeName(uri) }.take(255)
            val probe = SyncRoot(UUID.randomUUID().toString(), uri.toString(), name, null, "backup")
            engine.validateRoot(probe, uri)
            val response = api.request("/v1/backups", "POST", buildJsonObject {
                put("operationId", UUID.randomUUID().toString()); put("deviceId", engine.deviceId); put("name", safeName(name))
            })["root"]!!.jsonObject
            engine.addRoot(probe.copy(remoteId = response["remoteRootDriveItemId"]!!.jsonPrimitive.content, backupId = response["id"]!!.jsonPrimitive.content,
                cloudPath = "Backups / $name"))
            schedule(true)
        } catch (e: Exception) { releaseIfUnused(uri); throw e }
    }
    /** Starts syncing a local folder with a cloud folder, or changes an existing folder's mapping. */
    suspend fun addSyncRoot(uri: Uri?, rootId: String? = null, cloud: CloudChoice = CloudChoice.Automatic, shareId: String? = null): String {
        val engine = running()
        val existing = rootId?.let { id -> engine.journal.root(id)?.takeIf { it.mode == "sync" } ?: throw IllegalStateException("Sync folder was not found.") }
        val selected = uri ?: existing?.treeUri?.let(Uri::parse) ?: throw IllegalStateException("Choose your local folder again.")
        if (uri != null) SafTree.persist(context, uri)
        try {
            val localName = withContext(Dispatchers.IO) { treeName(selected) }
            val automatic = cloud is CloudChoice.Automatic
            val remoteId: String? = when (cloud) { CloudChoice.Automatic -> existing?.remoteId; is CloudChoice.Existing -> cloud.id; is CloudChoice.NewIn -> cloud.parentId }
            val newFolderName = when {
                automatic && remoteId == null -> localName.take(200).ifBlank { "Synced folder" }
                cloud is CloudChoice.NewIn -> safeName(cloud.name.trim())
                else -> null
            }
            val shared = shareId?.let { api.request("/v1/sync/shares/${HarborApi.segment(it)}/status") }
            val sharedItem = shared?.get("item")?.let { harborJson.decodeFromJsonElement<DriveItem>(it) }
            if (shared != null && (rootId != null || cloud is CloudChoice.NewIn || remoteId != sharedItem?.id)) throw IllegalStateException("Choose the invited folder to start shared sync.")
            val parentPath = if (sharedItem != null) "Shared with me / ${sharedItem.name}" else cloudLocation(remoteId)
            if (!automatic && newFolderName == null && remoteId == null) throw IllegalStateException("Choose a cloud folder. My Drive itself cannot be selected.")
            val share = shared?.get("share")?.jsonObject
            var root = SyncRoot(existing?.id ?: UUID.randomUUID().toString(), selected.toString(), localName, remoteId, "sync", cloudPath = parentPath,
                shareId = share?.get("id")?.jsonPrimitive?.contentOrNull, sharedBy = share?.get("ownerUserId")?.jsonPrimitive?.contentOrNull,
                excluded = existing?.excluded.orEmpty())
            // Validate local overlap before creating a cloud folder.
            engine.validateRoot(if (newFolderName != null) root.copy(remoteId = "__new__") else root, selected)
            if (newFolderName != null) {
                // Synced files are kept in the cloud; every linked device downloads changes from there.
                val operationId = root.id
                suspend fun create(name: String, op: String) = harborJson.decodeFromJsonElement<ItemResponse>(api.request("/v1/drive/folders", "POST", buildJsonObject {
                    put("name", name); put("parentId", remoteId); put("operationId", op)
                })).item
                val item = try { create(newFolderName, operationId) } catch (e: ApiException) {
                    if (!automatic || e.code != "NAME_CONFLICT") throw e
                    // Number the folder like a file manager would. Each attempt uses its own stable operation so retries stay safe.
                    var found: DriveItem? = null
                    var number = 2
                    while (found == null) {
                        try { found = create("${newFolderName.take(190)} $number", numberedOperationId(operationId, number)) }
                        catch (numbered: ApiException) { if (number >= 50 || numbered.code != "NAME_CONFLICT") throw numbered }
                        number++
                    }
                    found
                }
                root = root.copy(remoteId = item.id, cloudPath = "$parentPath / ${item.name}")
            }
            if (existing != null) engine.updateRoot(root) else engine.addRoot(root)
            if (existing != null && existing.treeUri != root.treeUri) releaseIfUnused(Uri.parse(existing.treeUri))
            schedule(true)
            return root.id
        } catch (e: Exception) { if (uri != null) releaseIfUnused(uri); throw e }
    }
    /** Stops syncing one folder on this phone only; other devices keep syncing it. Local files stay. */
    suspend fun stopOnThisPhone(id: String) {
        val engine = running()
        val root = engine.journal.root(id) ?: throw IllegalStateException("Folder was not found.")
        engine.removeRoot(id)
        releaseIfUnused(Uri.parse(root.treeUri))
        schedule(engine.journal.roots().isNotEmpty())
    }
    /** Removes a folder from sync on every linked device. Local copies are preserved everywhere. */
    suspend fun removeEverywhere(folderId: String) {
        val engine = running()
        val uris = engine.journal.roots().filter { it.remoteId == folderId }.map { it.treeUri }
        engine.removeSyncedFolder(folderId)
        uris.forEach { releaseIfUnused(Uri.parse(it)) }
        schedule(engine.journal.roots().isNotEmpty())
    }
    suspend fun changeLocal(id: String, uri: Uri) {
        val engine = running()
        val root = engine.journal.root(id) ?: throw IllegalStateException("Folder was not found.")
        if (root.mode == "sync") { addSyncRoot(uri, id); return }
        SafTree.persist(context, uri)
        try {
            val name = withContext(Dispatchers.IO) { treeName(uri) }
            engine.updateRoot(root.copy(treeUri = uri.toString(), localName = name, paused = false))
            releaseIfUnused(Uri.parse(root.treeUri))
        } catch (e: Exception) { releaseIfUnused(uri); throw e }
    }
    suspend fun rootSettings(id: String, paused: Boolean, excluded: List<String>) {
        val engine = running()
        val root = engine.journal.root(id) ?: throw IllegalStateException("Folder was not found.")
        require(excluded.size <= 1000 && excluded.all(::validRelative)) { "Enter folders inside this folder, like Photos/Old." }
        engine.updateRoot(root.copy(paused = paused, excluded = excluded))
    }
    suspend fun pauseAll(paused: Boolean) = running().pause(paused)
    suspend fun dismiss(issueId: String) = running().dismissConflict(issueId)
    suspend fun retry(jobId: String) = running().retry(jobId)
    suspend fun backupNow(id: String) = running().backupNow(id)
    suspend fun archive(id: String, archived: Boolean) = running().archiveBackup(id, archived)
    suspend fun disconnectBackup(id: String) {
        val engine = running()
        val root = engine.journal.root(id)
        engine.disconnectBackup(id)
        root?.let { releaseIfUnused(Uri.parse(it.treeUri)) }
        schedule(engine.journal.roots().isNotEmpty())
    }
    fun wake() = engine?.wake()
    private fun releaseIfUnused(uri: Uri) {
        if (engine?.journal?.roots()?.any { it.treeUri == uri.toString() } == true) return
        SafTree.release(context, uri)
    }

    companion object { const val WORK = "harbor0-sync" }
}

/** One background pass: restores the session if needed, then syncs every folder once. */
class SyncWorker(context: Context, params: WorkerParameters): CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val api = Harbor.api(applicationContext)
        val controller = Harbor.sync(applicationContext)
        return try {
            if (!api.signedIn.value) api.restore()
            if (!api.signedIn.value) { controller.schedule(false); return Result.success() }
            val user = api.get<Account>("/v1/users/me").user
            val engine = controller.connect(user.id)
            if (engine.journal.roots().isEmpty()) { controller.schedule(false); return Result.success() }
            engine.tick()
            Result.success()
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            if (e is ApiException && (e.status == 401 || e.code == "DEVICE_REVOKED")) Result.success() else Result.retry()
        }
    }
}
