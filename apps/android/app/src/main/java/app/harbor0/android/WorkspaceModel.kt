package app.harbor0.android

import android.app.Application
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

enum class Tab(val label: String) { Drive("Drive"), Sync("Sync"), Backups("Backups"), Trash("Trash"), Settings("Settings") }
data class Listing(val items: List<DriveItem> = emptyList(), val runs: List<BackupRun> = emptyList(), val cursor: String? = null,
    val loading: Boolean = false, val loaded: Boolean = false, val error: String? = null)
data class TransferProgress(val label: String, val fraction: Float?)
data class Preview(val file: File, val mime: String)

class WorkspaceModel(application: Application): AndroidViewModel(application) {
    val api = HarborApi(BuildConfig.API_URL, KeystoreCredentials(application))
    private val transfers = FileTransfers(api)
    var signedIn by mutableStateOf(false); private set
    var restoring by mutableStateOf(true); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)
    var message by mutableStateOf<String?>(null)
    var tab by mutableStateOf(Tab.Drive); private set
    var stacks by mutableStateOf<Map<Tab, List<DriveItem>>>(emptyMap()); private set
    var listings by mutableStateOf<Map<Tab, Listing>>(emptyMap()); private set
    var backups by mutableStateOf<List<BackupRoot>>(emptyList()); private set
    var statuses by mutableStateOf<Map<String, SyncStatus>>(emptyMap()); private set
    var history by mutableStateOf(false); private set
    var account by mutableStateOf<Account?>(null); private set
    var appearance by mutableStateOf(Appearance())
    var savedAppearance by mutableStateOf(Appearance()); private set
    var transfer by mutableStateOf<TransferProgress?>(null); private set
    var preview by mutableStateOf<Preview?>(null)
    private var loadJob: Job? = null
    private var actionJob: Job? = null
    private var transferJob: Job? = null
    private var generation = 0
    private var accountGeneration = 0
    val path get() = stacks[tab].orEmpty()
    val folder get() = path.lastOrNull()
    val listing get() = listings[tab] ?: Listing()
    val readOnly get() = tab == Tab.Backups || folder?.backupRootId != null
    val canWrite get() = (tab == Tab.Drive || tab == Tab.Sync && folder != null) && !readOnly
    val title get() = if (history) "Backup history" else folder?.name ?: if (tab == Tab.Drive) "My Drive" else tab.label
    val currentBackup get() = backups.firstOrNull { it.remoteRootDriveItemId == path.firstOrNull()?.id }
    init {
        // Foreground transfers do not survive process death. Remove previous temporary snapshots.
        viewModelScope.launch(Dispatchers.IO) {
            File(application.cacheDir, "transfers").deleteRecursively()
            File(application.cacheDir, "previews").deleteRecursively()
        }
        viewModelScope.launch {
            api.signedIn.collect { active ->
                signedIn = active
                if (!active) {
                    generation++; loadJob?.cancel(); transferJob?.cancel()
                    account = null; appearance = Appearance(); savedAppearance = Appearance()
                    stacks = emptyMap(); listings = emptyMap(); backups = emptyList(); statuses = emptyMap()
                    tab = Tab.Drive; history = false; preview = null
                }
            }
        }
        restore()
    }
    fun restore() {
        if (busy) return
        actionJob = viewModelScope.launch {
            busy = true; restoring = true; error = null
            try { api.restore(); if (api.signedIn.value) opened() }
            catch (e: Exception) { report(e) }
            finally { busy = false; restoring = false }
        }
    }
    fun login(email: String, password: String) = action {
        api.login(email, password, "${Build.MANUFACTURER} ${Build.MODEL}")
        opened()
    }
    private suspend fun opened() {
        signedIn = true
        // A profile/network failure must leave a retryable signed-in workspace.
        try { loadAccount() } catch (e: Exception) { report(e) }
        refresh()
    }
    fun logout() {
        if (transfer != null) { error = "Finish or cancel the transfer before signing out."; return }
        action { api.logout() }
    }
    fun forget() = action { api.forget() }
    private fun report(e: Exception) {
        if (e is CancellationException) throw e
        error = if (e is java.io.IOException) "Could not connect. Check your connection and try again." else e.message ?: "This action could not be completed. Try again."
    }
    private fun action(block: suspend () -> Unit) {
        if (busy) return
        actionJob = viewModelScope.launch {
            busy = true; error = null; message = null
            try { block() } catch (e: Exception) { report(e) } finally { busy = false }
        }
    }
    fun select(next: Tab) { if (tab == next) return; tab = next; history = false; refresh() }
    fun enter(item: DriveItem) { stacks = stacks + (tab to (path + item)); history = false; refresh() }
    fun back() {
        if (history) history = false else if (path.isNotEmpty()) stacks = stacks + (tab to path.dropLast(1))
        refresh()
    }
    fun showHistory() { history = true; refresh() }
    private suspend fun loadAccount() {
        val stamp = generation
        val accountStamp = accountGeneration
        val result = api.get<Account>("/v1/users/me")
        if (stamp != generation || accountStamp != accountGeneration) return
        if (appearance == savedAppearance) { appearance = result.user.appearance; savedAppearance = appearance }
        account = result
    }
    fun refresh(more: Boolean = false) {
        loadJob?.cancel()
        val destination = tab
        val parent = folder?.id
        val showRuns = history
        val backup = currentBackup
        val previous = listings[destination] ?: Listing()
        val cursor = if (more) previous.cursor else null
        loadJob = viewModelScope.launch {
            listings = listings + (destination to (if (more) previous else Listing()).copy(loading = true))
            try {
                var page = DrivePage(emptyList())
                var runs = RunPage(emptyList())
                when {
                    destination == Tab.Settings -> loadAccount()
                    showRuns && backup != null -> runs = api.get(HarborApi.pagePath("/v1/backups/${HarborApi.segment(backup.id)}/runs", cursor))
                    destination == Tab.Trash -> page = api.get(HarborApi.pagePath("/v1/search?trash=true", cursor))
                    parent != null -> page = api.list(parent, cursor)
                    destination == Tab.Sync -> {
                        page = api.get("/v1/sync/folders")
                        val found = mutableMapOf<String, SyncStatus>()
                        for (batch in page.items.chunked(50)) {
                            val ids = HarborApi.segment(batch.joinToString(",") { it.id })
                            val result = api.get<StatusPage>("/v1/sync/status?ids=$ids&recursive=true")
                            result.items.forEach { found[it.itemId] = it }
                        }
                        statuses = found
                    }
                    destination == Tab.Backups -> {
                        backups = api.get<Backups>("/v1/backups").items.filter { it.state != "REMOVED" }
                        page = DrivePage(backups.map { it.folder })
                    }
                    else -> {
                        val synced = api.get<DrivePage>("/v1/sync/folders").items.map { it.id }.toSet()
                        val roots = api.get<Backups>("/v1/backups").items.map { it.remoteRootDriveItemId }.toSet()
                        page = api.list(null, cursor).let { it.copy(items = it.items.filter { item -> item.id !in synced && item.id !in roots && item.backupRootId == null }) }
                    }
                }
                ensureActive()
                val nextCursor = if (showRuns) runs.nextCursor else page.nextCursor
                check(nextCursor == null || nextCursor != cursor) { "The server repeated this page. Refresh and try again." }
                listings = listings + (destination to Listing(
                    items = ((if (more) previous.items else emptyList()) + page.items).distinctBy { it.id },
                    runs = ((if (more) previous.runs else emptyList()) + runs.items).distinctBy { it.id },
                    cursor = nextCursor, loaded = true))
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                listings = listings + (destination to (if (more) previous else Listing()).copy(error = e.message ?: "Could not load this page. Try again."))
            }
        }
    }
    fun createFolder(name: String) { if (!canWrite) return; val parent = folder?.id; action { api.createFolder(name, parent); refresh() } }
    fun mutate(item: DriveItem, action: String) {
        if (readOnly) return
        action { api.trash(item, action); refresh() }
    }
    fun emptyTrash() = action { api.emptyTrash(); refresh() }
    fun saveAppearance() {
        if (account == null) return
        if (busy) return
        val snapshot = appearance
        accountGeneration++
        action {
            api.request("/v1/users/me", "PATCH", buildJsonObject {
                operation().forEach { (k, v) -> put(k, v) }; put("appearance", harborJson.encodeToJsonElement(snapshot))
            })
            savedAppearance = snapshot; message = "Appearance saved to your account."
        }
    }
    fun openFile(item: DriveItem) {
        if (item.cloudState == "REQUESTED") return
        if (item.cloudState == "RELEASED") {
            action { api.request("/v1/sync/items/${HarborApi.segment(item.id)}/request-content", "POST"); message = "Copy requested. Refresh after your computer uploads it."; refresh() }; return
        }
        startTransfer {
            val file = transfers.download(item, File(getApplication<Application>().cacheDir, "previews"), ::progress)
            preview = Preview(file, item.mimeType ?: "application/octet-stream")
        }
    }
    private fun progress(label: String, fraction: Float?) { viewModelScope.launch { transfer = TransferProgress(label, fraction) } }
    private fun startTransfer(block: suspend () -> Unit) {
        if (transferJob?.isActive == true) return
        transferJob = viewModelScope.launch {
            transfer = TransferProgress("Preparing file…", null); error = null
            try { block() } catch (e: Exception) { if (e !is CancellationException) report(e) }
            finally { transfer = null }
        }
    }
    fun cancelTransfer() { transferJob?.cancel() }
    fun upload(uri: Uri) {
        if (!canWrite) return
        val parent = folder?.id
        startTransfer {
            val context = getApplication<Application>()
            val scratch = File(context.cacheDir, "transfers/${UUID.randomUUID()}")
            try {
                val (name, mime) = withContext(Dispatchers.IO) {
                    val resolver = context.contentResolver
                    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) cursor.getString(0) else null
                    } ?: "Upload"
                    safeName(name)
                    check(scratch.parentFile!!.mkdirs() || scratch.parentFile!!.isDirectory)
                    resolver.openInputStream(uri)?.use { input -> scratch.outputStream().use { output ->
                        val buffer = ByteArray(256 * 1024)
                        while (true) { ensureActive(); val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n) }
                    } } ?: error("The selected file could not be opened. Select it again.")
                    name to (resolver.getType(uri) ?: "application/octet-stream")
                }
                transfers.upload(scratch, name, mime, parent, ::progress)
                message = "$name uploaded."; refresh()
            } finally { withContext(Dispatchers.IO) { scratch.delete() } }
        }
    }
    fun saveDownload(uri: Uri, file: File) = action {
        withContext(Dispatchers.IO) {
            getApplication<Application>().contentResolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } }
                ?: error("Could not save this file. Choose another location.")
        }
        message = "File saved."
    }
}
