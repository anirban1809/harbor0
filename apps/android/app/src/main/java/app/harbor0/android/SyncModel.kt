package app.harbor0.android

import android.net.Uri
import androidx.compose.runtime.*
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.util.UUID

/** How the sync setup sheet was opened. */
sealed interface SyncSetup {
    /** A new local folder; the cloud folder is created or chosen. */
    data object New: SyncSetup
    /** A folder already synced on another device, linked on this phone. */
    data class Remote(val folder: SyncFolder): SyncSetup
    /** An invitation from another account. */
    data class Invite(val invitation: SyncInvitation): SyncSetup
    /** A different local folder for an existing sync or backup folder. */
    data class ChangeLocal(val root: SyncRoot): SyncSetup
}

/** The Sync page and this phone's backup controls: engine state, folders synced elsewhere, and invitations. */
class SyncState(private val m: WorkspaceModel) {
    private val controller get() = m.syncController
    var view by mutableStateOf<SyncView?>(null); private set
    var startError by mutableStateOf<String?>(null); private set
    var remoteFolders by mutableStateOf<List<SyncFolder>>(emptyList()); private set
    var invitations by mutableStateOf(Loadable<List<SyncInvitation>>()); private set
    private var job: Job? = null

    init {
        m.viewModelScope.launch { controller.view.collect { view = it } }
        m.viewModelScope.launch { controller.startError.collect { startError = it } }
    }
    val roots get() = view?.roots.orEmpty()
    val syncRoots get() = roots.filter { it.mode == "sync" }
    val backupRoots get() = roots.filter { it.mode == "backup" }
    val runtime get() = view?.runtime ?: SyncRuntime()
    val jobs get() = view?.jobs.orEmpty()
    fun reset() { job?.cancel(); remoteFolders = emptyList(); invitations = Loadable() }
    /** This phone's status across its sync folders. */
    val label: String get() = if (view == null) (if (startError != null) "Offline" else "Starting") else globalSyncState(syncRoots, runtime, jobs.filter { j -> syncRoots.any { it.id == j.rootId } })
    fun state(root: SyncRoot) = folderState(root, runtime, jobs)
    fun tone(label: String) = when (label) {
        "Up to date" -> Tone.Success; "Syncing", "Starting" -> Tone.Accent; "Paused", "Offline", WAITING -> Tone.Neutral; else -> Tone.Danger
    }
    val requirements get() = syncRequirements(syncRoots, runtime, jobs)
    /** Folders synced on other devices that are not on this phone. Folders shared by someone else are linked from their invitation. */
    val available get() = remoteFolders.filter { f -> f.syncRemovedAt == null && (m.user == null || f.ownerUserId == null || f.ownerUserId == m.user?.id) && syncRoots.none { it.remoteId == f.id } }
    val receivedInvitations get() = invitations.data.orEmpty().filter { it.direction == "RECEIVED" && it.revokedAt == null && it.syncState != "DECLINED" && syncRoots.none { r -> r.remoteId == it.driveItemId } }
    fun isLocal(item: DriveItem) = syncRoots.any { it.remoteId == item.id }
    fun canLinkHere(item: DriveItem) = view != null && item.isFolder && item.syncRemovedAt == null && (item.id in m.drive.syncIds || remoteFolders.any { it.id == item.id }) &&
        syncRoots.none { it.remoteId == item.id } && (item.ownerUserId == null || m.user == null || item.ownerUserId == m.user?.id)
    fun linkHere(item: DriveItem) = setup(SyncSetup.Remote(remoteFolders.firstOrNull { it.id == item.id } ?: SyncFolder(item.id, item.name, item.ownerUserId, item.parentId)))
    /** The backup folder on this phone for a backup listed by the server, if any. */
    fun localBackup(backup: BackupRoot) = backupRoots.firstOrNull { it.backupId == backup.id || it.remoteId == backup.remoteRootDriveItemId }

    fun refresh(wake: Boolean = true) {
        job?.cancel()
        if (wake) controller.wake()
        job = m.viewModelScope.launch {
            try { remoteFolders = m.api.all<SyncFolder>("/v1/sync/folders") } catch (e: CancellationException) { throw e } catch (_: Exception) {}
            invitations = invitations.copy(loading = true, error = null)
            invitations = try { Loadable(m.api.all<SyncInvitation>("/v1/sync/shares")) }
                catch (e: CancellationException) { throw e } catch (e: Exception) { invitations.copy(loading = false, error = m.message(e)) }
        }
    }
    private fun run(done: String? = null, close: Boolean = true, block: suspend () -> Unit) = m.action(done, close) { block(); refresh() }

    // Setup -------------------------------------------------------------------------------------
    fun setup(kind: SyncSetup) { m.error = null; m.overlay = Overlay.SyncSetupSheet(kind) }
    fun start(kind: SyncSetup, local: Uri?, cloud: CloudChoice) = run("Sync started. Files will appear as they sync.") {
        when (kind) {
            SyncSetup.New -> controller.addSyncRoot(local ?: error("Choose a folder on this phone."), cloud = cloud)
            is SyncSetup.Remote -> controller.addSyncRoot(local ?: error("Choose a folder on this phone."), cloud = CloudChoice.Existing(kind.folder.id))
            is SyncSetup.Invite -> {
                val uri = local ?: error("Choose a folder on this phone.")
                if (kind.invitation.syncState == "PENDING") respond(kind.invitation, "ACCEPTED")
                controller.addSyncRoot(uri, cloud = CloudChoice.Existing(kind.invitation.driveItemId), shareId = kind.invitation.id)
            }
            is SyncSetup.ChangeLocal -> controller.changeLocal(kind.root.id, local ?: error("Choose a folder on this phone."))
        }
    }
    private suspend fun respond(invitation: SyncInvitation, action: String) {
        m.api.request("/v1/sync/shares/${HarborApi.segment(invitation.id)}/respond", "POST", buildJsonObject { put("action", action) })
    }
    fun decline(invitation: SyncInvitation) = m.confirm(Confirmation("Decline “${invitation.name}”?",
        "${invitation.owner.displayName.ifBlank { "The owner" }} will see that you declined. You can be invited again later.", "Decline", "Invitation declined.", cancel = "Cancel") {
        respond(invitation, "DECLINED"); refresh()
    })
    suspend fun cloudFolders(parentId: String?): List<DriveItem> = m.api.all<DriveItem>("/v1/drive/folders/${HarborApi.segment(parentId ?: "root")}/children")
        .filter { it.isFolder && it.backupRootId == null }.sortedWith { a, b -> naturalCompare(a.name, b.name) }

    // Folder actions ----------------------------------------------------------------------------
    fun backUpFolder(uri: Uri) = run("Backup added. Files are saved after they have been unchanged for an hour.", close = false) { controller.addBackup(uri); m.backups.refresh() }
    fun pauseAll(paused: Boolean) = run(if (paused) "Sync paused." else "Sync resumed.", close = false) { controller.pauseAll(paused) }
    fun togglePause(root: SyncRoot) = run(if (root.paused) "Resumed ${root.localName}." else "Paused ${root.localName}.", close = false) { controller.rootSettings(root.id, !root.paused, root.excluded) }
    fun saveExclusions(root: SyncRoot, text: String) = run("Exclusions saved.") {
        controller.rootSettings(root.id, root.paused, text.lines().map { it.trim().trim('/') }.filter { it.isNotEmpty() }.distinct())
    }
    fun stopHere(root: SyncRoot) = m.confirm(Confirmation(if (root.mode == "backup") "Stop backing up ${root.localName} on this phone?" else "Stop syncing on this phone?",
        if (root.shareId != null) "This shared folder will stop syncing on this phone. Your local files will stay where they are. Other devices and the owner’s folder are unaffected."
        else "“${root.localName}” will stop syncing on this phone. Your local files will stay where they are, and your other devices keep syncing it.",
        "Stop syncing here", "Stopped syncing ${root.localName} on this phone. Local files are preserved.", cancel = "Cancel") {
        controller.stopOnThisPhone(root.id); refresh()
    })
    fun removeEverywhere(folderId: String, name: String) = m.confirm(Confirmation("Remove “$name” from sync?",
        "This folder will stop syncing on all linked devices and disappear from the app. Your local files will stay where they are.",
        "Remove from sync", "Folder removed from sync. Local files are preserved on every device.", cancel = "Cancel",
        note = "Local folders and their contents are preserved on every device. Offline devices will stop syncing this folder when they reconnect.") {
        controller.removeEverywhere(folderId); refresh(); m.drive.refresh()
    })
    fun dismiss(issue: SyncIssue) = run(close = false) { controller.dismiss(issue.id) }
    fun retry(jobId: String) = run("Retrying.", close = false) { controller.retry(jobId) }
    fun backupNow(root: SyncRoot) = run("Backing up ${root.localName} now.", close = false) { controller.backupNow(root.id) }
    fun archive(root: SyncRoot) = m.confirm(Confirmation("Archive ${root.localName}?",
        "harbor0 makes one last full backup, then removes the local files whose content is saved. Files that keep changing are left in place. Restore the folder at any time to download everything again.",
        "Archive folder", "Archiving ${root.localName}. Local files are removed once everything is saved.", cancel = "Cancel") {
        controller.archive(root.id, true); m.backups.refresh()
    })
    fun restoreArchive(root: SyncRoot) = run("Restoring ${root.localName}. Files download in the background.", close = false) { controller.archive(root.id, false); m.backups.refresh() }
    fun disconnectBackup(root: SyncRoot) = m.confirm(Confirmation("Disconnect ${root.localName}?",
        "Stop backing up this folder. All archived files and versions remain in Cloud and become editable. Local files stay where they are.",
        "Disconnect backup", "Backup disconnected. Its folder and versions are now in Cloud.", danger = false, cancel = "Cancel") {
        controller.disconnectBackup(root.id); m.backups.close(); m.backups.refresh()
    })

    // Sharing -------------------------------------------------------------------------------------
    fun members(root: SyncRoot) = invitations.data.orEmpty().filter { it.direction == "SENT" && it.driveItemId == root.remoteId && it.revokedAt == null }
    fun invite(root: SyncRoot, recipient: String) = m.action("Invitation sent. Sync starts after they accept and choose a local folder.") {
        m.api.request("/v1/sync/shares", "POST", buildJsonObject {
            put("operationId", UUID.randomUUID().toString()); put("driveItemId", root.remoteId); put("recipient", recipientJson(recipient))
        })
        refresh()
    }
    fun removeMember(member: SyncInvitation) = m.confirm(Confirmation("Remove access for ${member.recipient.displayName.ifBlank { "@" + member.recipient.username }}?",
        "Sync will stop on their devices when they reconnect. Files already downloaded will remain.", "Remove access", "Access removed. Their existing local files are preserved.", cancel = "Keep access") {
        m.api.request("/v1/shares/${HarborApi.segment(member.id)}", "DELETE", operation()); refresh()
    })
}
