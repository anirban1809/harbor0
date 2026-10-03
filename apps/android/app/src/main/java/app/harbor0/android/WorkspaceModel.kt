package app.harbor0.android

import android.app.Application
import android.content.ContentValues
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

/** Pages of the phone layout. Drive, Shared, Backups and Trash are tabs; the rest open from More, the bell or the account menu. */
enum class Section(val title: String) {
    Drive("My Drive"), Shared("Shared"), Backups("Backups"), Trash("Trash"),
    Sync("Sync"), Devices("Devices"), Storage("Storage"), Settings("Settings"), Notifications("Notifications");
    val inMore get() = this in listOf(Sync, Devices, Storage, Settings, Notifications)
}
enum class AuthMode { Login, Signup, Confirm, Forgot, Reset }
data class Confirmation(val title: String, val description: String, val label: String, val done: String? = null,
    val danger: Boolean = true, val cancel: String = "Go back", val note: String? = null, val run: suspend () -> Unit)
data class ActivityEntry(val id: String, val message: String, val status: String, val time: Long, val read: Boolean = false)
data class TransferProgress(val label: String, val fraction: Float?)
data class Preview(val file: File, val mime: String, val item: DriveItem? = null)
data class ZipProgress(val name: String, val phase: String, val files: Int = 0, val bytes: Long = 0, val currentFile: String? = null,
    val totalBytes: Long? = null, val fraction: Float? = null)
data class Loadable<T>(val data: T? = null, val loading: Boolean = false, val error: String? = null)

/** Sheets and dialogs. One is shown at a time; Back closes it. */
sealed interface Overlay {
    data object More : Overlay
    data object Activity : Overlay
    data object NewFolder : Overlay
    data object SelectionMenu : Overlay
    data object DeleteAccount : Overlay
    data class ItemMenu(val item: DriveItem) : Overlay
    data class TrashMenu(val item: DriveItem) : Overlay
    data class Details(val item: DriveItem) : Overlay
    data class Versions(val item: DriveItem) : Overlay
    data class Rename(val item: DriveItem) : Overlay
    data class Move(val items: List<DriveItem>) : Overlay
    data class Send(val items: List<DriveItem>) : Overlay
    data class ShareAccess(val item: DriveItem) : Overlay
    data class BackupFile(val item: DriveItem) : Overlay
    data class SyncSetupSheet(val kind: SyncSetup) : Overlay
    data class SyncFolderMenu(val root: SyncRoot) : Overlay
    data class SyncExclusions(val root: SyncRoot) : Overlay
    data class SyncShare(val root: SyncRoot) : Overlay
    data class SyncIssues(val root: SyncRoot?) : Overlay
    data class Confirm(val confirmation: Confirmation) : Overlay
}

class WorkspaceModel(application: Application): AndroidViewModel(application) {
    // Shared with background sync, which runs without this screen.
    val api = Harbor.api(application)
    val syncController = Harbor.sync(application)
    val transfers = FileTransfers(api)
    val drive = DriveState(this)
    val trash = TrashState(this)
    val shared = SharedState(this)
    val backups = BackupsState(this)
    val search = SearchState(this)
    val uploads = UploadQueue(this)
    val sync = SyncState(this)
    var signedIn by mutableStateOf(false); private set
    var restoring by mutableStateOf(true); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)
    var toast by mutableStateOf<String?>(null)
    var online by mutableStateOf(true); private set
    var section by mutableStateOf(Section.Drive); private set
    var query by mutableStateOf("")
    var overlay by mutableStateOf<Overlay?>(null)
    var account by mutableStateOf<Account?>(null); private set
    var appearance by mutableStateOf(Appearance()); private set
    var savedAppearance by mutableStateOf(Appearance()); private set
    /** idle, saving, saved or error, as the web appearance footer. */
    var appearanceStatus by mutableStateOf("idle"); private set
    var transfer by mutableStateOf<TransferProgress?>(null); private set
    var zip by mutableStateOf<ZipProgress?>(null); private set
    var preview by mutableStateOf<Preview?>(null)
    var activity by mutableStateOf<List<ActivityEntry>>(emptyList()); private set
    var devices by mutableStateOf(Loadable<List<Device>>()); private set
    var notices by mutableStateOf(Loadable<List<Notice>>()); private set
    // Sign-in, sign-up, confirmation and password reset.
    var authMode by mutableStateOf(AuthMode.Login); private set
    var authEmail by mutableStateOf("")
    var authNotice by mutableStateOf<Pair<AuthMode, String>?>(null); private set
    var authError by mutableStateOf<Pair<String, Boolean>?>(null)
    var cooldown by mutableIntStateOf(0); private set
    private var actionJob: Job? = null
    private var transferJob: Job? = null
    private var zipJob: Job? = null
    private var appearanceJob: Job? = null
    private var pollJob: Job? = null
    private var cooldownJob: Job? = null
    private var syncStartJob: Job? = null
    private var accountGeneration = 0
    val context: Context get() = getApplication()
    val user get() = account?.user
    val storage get() = account?.storage
    val unread get() = activity.count { !it.read }

    init {
        // Foreground transfers do not survive process death. Remove previous temporary snapshots.
        viewModelScope.launch(Dispatchers.IO) {
            File(application.cacheDir, "transfers").deleteRecursively()
            File(application.cacheDir, "previews").deleteRecursively()
        }
        drive.grid = preferences.getBoolean("drive-grid", false)
        viewModelScope.launch {
            api.signedIn.collect { active ->
                signedIn = active
                if (!active) {
                    transferJob?.cancel(); zipJob?.cancel(); uploads.clear(); pollJob?.cancel(); syncStartJob?.cancel()
                    launch { runCatching { syncController.disconnect() } }
                    sync.reset()
                    account = null; appearance = Appearance(); savedAppearance = Appearance(); appearanceStatus = "idle"
                    section = Section.Drive; overlay = null; preview = null; query = ""; activity = emptyList()
                    drive.reset(); trash.reset(); shared.reset(); backups.reset(); search.reset()
                    devices = Loadable(); notices = Loadable()
                }
            }
        }
        val connectivity = application.getSystemService(ConnectivityManager::class.java)
        online = connectivity?.activeNetwork != null
        runCatching {
            connectivity?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { viewModelScope.launch { online = true } }
                override fun onLost(network: Network) { viewModelScope.launch { online = false } }
            })
        }
        restore()
    }
    private val preferences get() = context.getSharedPreferences("workspace", Context.MODE_PRIVATE)
    fun setGrid(value: Boolean) { drive.grid = value; preferences.edit().putBoolean("drive-grid", value).apply() }

    // Session ---------------------------------------------------------------
    fun restore() {
        if (busy) return
        actionJob = viewModelScope.launch {
            busy = true; restoring = true; error = null
            try { api.restore(); if (api.signedIn.value) opened() }
            catch (e: Exception) { report(e) }
            finally { busy = false; restoring = false }
        }
    }
    private suspend fun opened() {
        signedIn = true
        // A profile/network failure must leave a retryable signed-in workspace.
        try { loadAccount() } catch (e: Exception) { report(e) }
        section = Section.Drive
        drive.refresh()
        startPolling()
        startSync()
    }
    /** Starts this account's sync engine, retrying while offline. */
    private fun startSync() {
        syncStartJob?.cancel()
        syncStartJob = viewModelScope.launch {
            while (isActive && signedIn) {
                try {
                    val id = user?.id ?: api.get<Account>("/v1/users/me").user.id
                    syncController.connect(id); sync.refresh(); break
                } catch (e: CancellationException) { throw e } catch (e: ApiException) {
                    if (e.status == 401 || e.code == "DEVICE_REVOKED") break
                } catch (_: Exception) {}
                delay(30_000)
            }
        }
    }
    fun logout() {
        if (transfer != null || uploads.active) { error = "Finish or cancel the transfer before signing out."; return }
        action {
            syncController.disconnect()
            try { api.logout() } catch (e: Exception) { startSync(); throw e }
        }
    }
    fun forget() = action { api.forget() }
    fun report(e: Throwable) {
        if (e is CancellationException) throw e
        error = message(e)
    }
    fun message(e: Throwable) = if (e is java.io.IOException) "Could not connect. Check your connection and try again." else e.message ?: "This action could not be completed. Try again."
    /** Runs one action at a time. A failure shows the error banner (or the open sheet's alert) and keeps the sheet open. */
    fun action(done: String? = null, close: Boolean = false, block: suspend () -> Unit) {
        if (busy) return
        actionJob = viewModelScope.launch {
            busy = true; error = null
            try { block(); if (close) overlay = null; done?.let(::notify) } catch (e: Exception) { report(e) } finally { busy = false }
        }
    }
    fun confirm(confirmation: Confirmation) { error = null; overlay = Overlay.Confirm(confirmation) }
    fun runConfirmation(confirmation: Confirmation) = action(confirmation.done, close = true) { confirmation.run() }
    /** A toast that also lands in the activity feed, as drive notices do on the web. */
    fun notify(text: String, status: String = "info") {
        toast = text
        publish(UUID.randomUUID().toString(), text, status)
    }
    fun publish(id: String, message: String, status: String) {
        val current = activity.firstOrNull { it.id == id }
        if (current?.message == message && current.status == status) return
        activity = (listOf(ActivityEntry(id, message, status, System.currentTimeMillis())) + activity.filter { it.id != id }).take(100)
    }
    fun markActivityRead() { if (activity.any { !it.read }) activity = activity.map { it.copy(read = true) } }

    // Auth ------------------------------------------------------------------
    fun authGo(mode: AuthMode, notice: String? = null) {
        authNotice = notice?.let { mode to it }; authError = null; authMode = mode
    }
    private fun startCooldown() {
        cooldownJob?.cancel(); cooldown = 30
        cooldownJob = viewModelScope.launch { while (cooldown > 0) { delay(1000); cooldown-- } }
    }
    private fun authAction(block: suspend () -> Unit) {
        if (busy) return
        actionJob = viewModelScope.launch {
            busy = true; authError = null; authNotice = null; error = null
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { authError = message(e) to (e is ApiException && e.code == "EMAIL_NOT_VERIFIED") }
            finally { busy = false }
        }
    }
    fun login(email: String, password: String) = authAction {
        authEmail = email.trim()
        api.login(email, password, "${Build.MANUFACTURER} ${Build.MODEL}")
        opened()
    }
    fun signup(email: String, displayName: String, username: String, password: String) = authAction {
        authEmail = email.trim()
        api.anonymous("/v1/auth/signup", buildJsonObject {
            put("email", email.trim()); put("password", password); put("username", username); put("displayName", displayName.trim())
        })
        startCooldown(); authGo(AuthMode.Confirm, "We sent a verification code to ${email.trim()}.")
    }
    fun confirmEmail(email: String, code: String) = authAction {
        api.anonymous("/v1/auth/confirm", buildJsonObject { put("email", email.trim()); put("code", code.trim()) })
        authGo(AuthMode.Login, "Email verified. Sign in to continue.")
    }
    fun forgot(email: String) = authAction {
        authEmail = email.trim()
        api.anonymous("/v1/auth/forgot", buildJsonObject { put("email", email.trim()) })
        startCooldown(); authGo(AuthMode.Reset, "If ${email.trim()} has an account, a reset code is on its way.")
    }
    fun resetPassword(email: String, code: String, password: String) = authAction {
        api.anonymous("/v1/auth/reset", buildJsonObject { put("email", email.trim()); put("code", code.trim()); put("password", password) })
        authGo(AuthMode.Login, "Password updated. Sign in with your new password.")
    }
    fun resend(goConfirm: Boolean = false) {
        if (authEmail.isBlank()) { authError = "Enter your email to get a new code." to false; return }
        authAction {
            api.anonymous("/v1/auth/resend", buildJsonObject { put("email", authEmail.trim()) })
            startCooldown()
            if (goConfirm) authMode = AuthMode.Confirm
            authNotice = AuthMode.Confirm to "A new code is on its way to ${authEmail.trim()}."
        }
    }

    // Navigation ------------------------------------------------------------
    /** Bumped on every navigation so pages start scrolled to the top. */
    var epoch by mutableIntStateOf(0); private set
    fun navigate(next: Section) {
        epoch++
        overlay = null; query = ""; error = null; search.reset()
        drive.selected = emptySet(); trash.selected = emptySet()
        if (next == Section.Drive) {
            // Coming from another page opens My Drive fresh on Cloud, as the web remounts it.
            drive.location = Location.Cloud
            if (section != Section.Drive) drive.filters = DriveFilters()
            drive.trail = emptyList(); drive.scope = "all"; drive.leavePlace()
        }
        if (next == Section.Backups) backups.close()
        section = next
        refreshSection()
    }
    /** Opens a search result: folders open in My Drive, files in the preview. */
    fun openResult(item: DriveItem) {
        if (!item.isFolder) return drive.open(item)
        navigate(Section.Drive)
        drive.location = if (item.backupRootId != null) Location.Backup else Location.Cloud
        drive.enter(item)
    }
    fun clearSearch() { query = ""; search.reset(); refreshSection() }
    fun refreshSection() {
        if (query.isNotBlank() && section != Section.Drive && section != Section.Trash) return search.refresh()
        when (section) {
            Section.Drive -> drive.refresh()
            Section.Trash -> trash.refresh()
            Section.Shared -> shared.refresh()
            Section.Backups -> backups.refresh()
            Section.Sync -> sync.refresh()
            Section.Devices -> loadDevices()
            Section.Notifications -> loadNotices()
            Section.Storage, Section.Settings -> refreshAccount()
        }
    }
    /** Called when the app returns to the foreground, as the web refreshes on focus. */
    fun resumed() { if (signedIn) { refreshAccount(); refreshSection() } }
    private fun startPolling() {
        pollJob?.cancel()
        // Changes from other devices stay current without flashing a loading state.
        pollJob = viewModelScope.launch {
            while (isActive) {
                delay(15_000)
                if (!foreground || overlay != null || busy) continue
                when (section) { Section.Drive -> if (!drive.loading) drive.refresh(); Section.Shared -> shared.refresh(); Section.Sync -> sync.refresh(wake = false); else -> {} }
            }
        }
    }
    var foreground = true
        set(value) { field = value; syncController.foreground = value }
    /** System Back: closes sheets, clears selection or search, then goes up a level. */
    fun back(): Boolean {
        when {
            overlay != null -> overlay = null
            section == Section.Drive && drive.selected.isNotEmpty() -> drive.selected = emptySet()
            section == Section.Trash && trash.selected.isNotEmpty() -> trash.selected = emptySet()
            query.isNotEmpty() -> clearSearch()
            section == Section.Drive && drive.canGoUp -> drive.up()
            section == Section.Backups && backups.canGoBack -> backups.back()
            section != Section.Drive -> navigate(Section.Drive)
            else -> return false
        }
        return true
    }
    val canGoBack get() = overlay != null || query.isNotEmpty() || section != Section.Drive || drive.canGoUp || drive.selected.isNotEmpty()

    // Account and appearance ---------------------------------------------------
    suspend fun loadAccount() {
        val stamp = accountGeneration
        val result = api.get<Account>("/v1/users/me")
        if (stamp != accountGeneration) return
        if (appearanceStatus != "saving" && appearance == savedAppearance) { appearance = result.user.appearance; savedAppearance = appearance }
        account = result
    }
    fun refreshAccount() { viewModelScope.launch { try { loadAccount() } catch (e: CancellationException) { throw e } catch (_: Exception) {} } }
    /** Applies a theme change at once and saves it to the account shortly after, as the web settings do. */
    fun updateAppearance(next: Appearance) {
        appearance = next
        if (account == null) return
        accountGeneration++
        appearanceJob?.cancel()
        appearanceStatus = "saving"
        appearanceJob = viewModelScope.launch {
            delay(400)
            try {
                api.request("/v1/users/me", "PATCH", buildJsonObject {
                    operation().forEach { (k, v) -> put(k, v) }; put("appearance", harborJson.encodeToJsonElement(next))
                })
                savedAppearance = next; appearanceStatus = "saved"
            } catch (e: CancellationException) { throw e } catch (_: Exception) { appearanceStatus = "error" }
        }
    }
    fun retryAppearance() = updateAppearance(appearance)
    /** Theme toggles in More and on the sign-in screen switch between light and dark. */
    fun toggleTheme(dark: Boolean) = updateAppearance(appearance.copy(preference = if (dark) "light" else "dark"))
    fun saveProfile(displayName: String, username: String) {
        val current = user ?: return
        action("Profile updated.") {
            api.request("/v1/users/me", "PATCH", buildJsonObject {
                operation().forEach { (k, v) -> put(k, v) }
                // Only changed fields are sent, so an unchanged username never counts as a rename.
                if (displayName.trim() != current.displayName) put("displayName", displayName.trim())
                if (username != current.username) put("username", username)
            })
            loadAccount()
        }
    }
    fun deleteAccount(email: String) = action(close = true) {
        api.request("/v1/users/me/delete", "POST", buildJsonObject { operation().forEach { (k, v) -> put(k, v) }; put("email", email.trim()) })
        api.forget()
    }

    // Devices and notifications --------------------------------------------
    fun loadDevices() {
        devices = devices.copy(loading = true, error = null)
        viewModelScope.launch {
            devices = try { Loadable(api.get<Page<Device>>("/v1/devices").items) }
            catch (e: CancellationException) { throw e } catch (e: Exception) { devices.copy(loading = false, error = message(e)) }
        }
    }
    fun revoke(device: Device) = confirm(Confirmation("Revoke access for ${device.name}?",
        "This device will be signed out and will stop syncing. If it is the browser you are using now, you will need to sign in again.",
        "Revoke access", "Device access removed.") {
        api.request("/v1/devices/${HarborApi.segment(device.id)}", "DELETE"); loadDevices()
    })
    fun loadNotices() {
        notices = notices.copy(loading = true, error = null)
        viewModelScope.launch {
            notices = try { Loadable(api.get<Page<Notice>>("/v1/notifications").items) }
            catch (e: CancellationException) { throw e } catch (e: Exception) { notices.copy(loading = false, error = message(e)) }
        }
    }
    fun markRead(notice: Notice) = action {
        api.request("/v1/notifications/${HarborApi.segment(notice.id)}/read", "POST"); loadNotices()
    }

    // Files on this device ------------------------------------------------------
    private fun progress(label: String, fraction: Float?) { viewModelScope.launch { transfer = TransferProgress(label, fraction) } }
    fun startTransfer(block: suspend () -> Unit) {
        if (transferJob?.isActive == true) { error = "Wait for the current download to finish."; return }
        transferJob = viewModelScope.launch {
            transfer = TransferProgress("Preparing file…", null); error = null
            try { block() } catch (e: Exception) { if (e !is CancellationException) report(e) }
            finally { transfer = null }
        }
    }
    fun cancelTransfer() { transferJob?.cancel() }
    private val previews get() = File(context.cacheDir, "previews")
    /** Downloads, checks and shows a file; the preview offers opening in another app, sharing and saving. */
    fun openFile(item: DriveItem) = startTransfer {
        val file = transfers.download(item, previews, ::progress)
        preview = Preview(file, item.mimeType ?: "application/octet-stream", item)
    }
    /** Saves a verified copy to the public Downloads folder. Android 9 and earlier choose a location instead. */
    fun downloadToDevice(name: String, body: JsonObject, mime: String?) = startTransfer { fetchAndSave(name, body, mime) }
    suspend fun fetchAndSave(name: String, body: JsonObject, mime: String?) {
        val file = transfers.download(name, body, previews, ::progress)
        save(file, mime ?: "application/octet-stream")
    }
    private suspend fun save(file: File, mime: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            withContext(Dispatchers.IO) {
                val resolver = context.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, file.name); put(MediaStore.Downloads.MIME_TYPE, mime); put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Could not save this file. Try again.")
                try {
                    resolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("Could not save this file. Try again.")
                    resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                } catch (e: Exception) { resolver.delete(uri, null, null); throw e }
                file.parentFile?.deleteRecursively()
            }
            notify("Saved “${file.name}” to Downloads.", "success")
        } else preview = Preview(file, mime)
    }
    fun saveDownload(uri: Uri, file: File) = action("File saved.") {
        withContext(Dispatchers.IO) {
            context.contentResolver.openOutputStream(uri)?.use { output -> file.inputStream().use { it.copyTo(output) } }
                ?: error("Could not save this file. Choose another location.")
        }
    }
    fun savePreview() {
        val current = preview ?: return
        action { save(current.file.copyTo(File(previews, UUID.randomUUID().toString() + "/" + current.file.name)), current.mime) }
    }
    /** Folder ZIPs are built by the backend; this polls its progress, then downloads and saves the archive. */
    fun downloadFolder(item: DriveItem) {
        if (zipJob?.isActive == true) return
        zipJob = viewModelScope.launch {
            zip = ZipProgress(item.name, "queued"); error = null
            var job: FolderDownload? = null
            try {
                job = harborJson.decodeFromJsonElement<FolderDownload>(api.request("/v1/folder-downloads", "POST", buildJsonObject {
                    put("driveItemId", item.id); put("operationId", UUID.randomUUID().toString())
                }))
                while (true) {
                    val current = job!!
                    if (current.state == "READY") break
                    if (current.state in listOf("FAILED", "CANCELLED", "EXPIRED")) error(current.error ?: "ZIP preparation ended. Please try again.")
                    zip = ZipProgress(item.name, current.state.lowercase(), current.files, current.bytes, current.currentFile, current.totalBytes,
                        current.totalBytes?.let { if (it == 0L) 1f else current.bytes.toFloat() / it })
                    delay(1500)
                    job = api.get<FolderDownload>("/v1/folder-downloads/${HarborApi.segment(current.id)}")
                }
                val ready = job!!
                val url = ready.downloadUrl ?: error("The ZIP download is unavailable. Please try again.")
                val file = transfers.fetch(url, "${safeName(item.name)}.zip", ready.sizeBytes, ready.contentHash, previews) { _, fraction ->
                    viewModelScope.launch { zip = zip?.copy(phase = "downloading", fraction = fraction, bytes = ((fraction ?: 0f) * (ready.sizeBytes ?: 0)).toLong()) }
                }
                save(file, "application/zip")
            } catch (e: CancellationException) {
                job?.takeIf { it.state !in listOf("FAILED", "CANCELLED", "EXPIRED", "READY") }?.let {
                    withContext(NonCancellable) { runCatching { api.request("/v1/folder-downloads/${HarborApi.segment(it.id)}", "DELETE") } }
                }
                throw e
            } catch (e: Exception) { report(e) }
            finally { zip = null }
        }
    }
    fun cancelZip() { zipJob?.cancel() }

    // Uploads (used by the Drive FAB and tests) ----------------------------------
    fun upload(uri: Uri) = uploads.addUris(listOf(uri))
    override fun onCleared() { uploads.clear(); super.onCleared() }
}
