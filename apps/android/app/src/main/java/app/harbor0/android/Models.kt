package app.harbor0.android

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.UUID

val harborJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; coerceInputValues = true }
fun operation(vararg values: Pair<String, String?>): JsonObject = buildJsonObject {
    put("operationId", UUID.randomUUID().toString())
    values.forEach { (key, value) -> put(key, value) }
}
@Serializable data class Tokens(val accessToken: String, val refreshToken: String, val expiresIn: Double)
@Serializable data class SavedSession(val tokens: Tokens, val expiresAt: Long, val deviceProven: Boolean = false)
@Serializable data class DriveItem(
    val id: String, val name: String, val type: String, val parentId: String? = null,
    val mimeType: String? = null, val sizeBytes: Long = 0, val revision: Int? = null,
    val updatedAt: String = "", val deletedAt: String? = null, val backupRootId: String? = null,
    val cloudState: String? = null, val createdAt: String = "", val favorite: Boolean = false,
    val currentVersionId: String? = null, val ownerUserId: String? = null, val normalizedName: String = "", val syncRemovedAt: String? = null,
    /** Only on `GET /v1/sync/folders`: the devices that keep this folder in sync. */
    val syncDevices: List<SyncDevice> = emptyList(),
) { val isFolder get() = type == "FOLDER" }
@Serializable data class DrivePage(val items: List<DriveItem>, val nextCursor: String? = null)
@Serializable data class ItemResponse(val item: DriveItem)
@Serializable data class Appearance(val preference: String = "system", val preset: String = "default", val palettes: Palettes = Palettes())
@Serializable data class Palettes(val light: Map<String, String> = emptyMap(), val dark: Map<String, String> = emptyMap())
@Serializable data class User(val id: String, val email: String, val displayName: String, val appearance: Appearance = Appearance(),
    val username: String = "", val emailVerified: Boolean = true)
@Serializable data class Storage(val quotaBytes: Long, val usedBytes: Long, val reservedBytes: Long) {
    val availableBytes get() = maxOf(0, quotaBytes - usedBytes - reservedBytes)
}
@Serializable data class Account(val user: User, val storage: Storage)
@Serializable data class Backups(val items: List<BackupRoot>)
@Serializable data class BackupRoot(val id: String, val localPathDisplayName: String, val remoteRootDriveItemId: String,
    val state: String, val deviceName: String? = null, val updatedAt: String = "", val deviceId: String = "",
    val devicePublicId: String? = null, val createdAt: String = "") {
    val folder get() = DriveItem(remoteRootDriveItemId, localPathDisplayName, "FOLDER", backupRootId = id)
}
@Serializable data class BackupRun(val id: String, val state: String, val trigger: String, val startedAt: String,
    val fileCount: Int, val sizeBytes: Long, val error: String? = null, val completedAt: String? = null)
@Serializable data class RunPage(val items: List<BackupRun>, val nextCursor: String? = null)
@Serializable data class SyncStatus(val itemId: String, val state: String, val requiredDevices: Int, val confirmedDevices: Int,
    val cloudState: String? = null, val pendingItems: Int = 0) {
    val label get() = when (state) { "SYNCED" -> "Up to date"; "SYNCING" -> "Syncing"; "PENDING" -> "Waiting for a computer"; else -> "Status unavailable" }
}
@Serializable data class StatusPage(val items: List<SyncStatus>)
@Serializable data class Upload(val id: String, val partSizeBytes: Long)
@Serializable data class UploadResponse(val upload: Upload)
@Serializable data class Part(val partNumber: Int, val uploadUrl: String)
@Serializable data class Parts(val parts: List<Part>)
@Serializable data class CompletedPart(val partNumber: Int, val etag: String)
@Serializable data class Download(val downloadUrl: String, val sizeBytes: Long, val contentHash: String)
class ApiException(val status: Int, override val message: String, val code: String? = null, val details: JsonObject? = null): Exception(message)
fun safeName(name: String): String {
    require(name.isNotBlank() && name != "." && name != ".." && name.length <= 255 && name.none { it == '/' || it == '\\' || it.isISOControl() }) { "Choose a valid file or folder name." }
    return name
}
fun bytesLabel(bytes: Long): String {
    if (bytes < 1000) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble() / 1000
    var index = 0
    while (value >= 1000 && index < units.lastIndex) { value /= 1000; index++ }
    return "%.1f %s".format(value, units[index])
}
/** Formats an API timestamp for the device locale; unparseable values fall back to their date part. */
fun dateLabel(iso: String, time: Boolean = false): String = runCatching {
    val local = Instant.parse(iso).atZone(ZoneId.systemDefault())
    local.format(if (time) DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT) else DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
}.getOrElse { iso.replace('T', ' ').take(if (time) 16 else 10) }

@Serializable data class Page<T>(val items: List<T>, val nextCursor: String? = null)
@Serializable data class BackupEntry(val relativePath: String, val itemId: String, val versionId: String, val sizeBytes: Long = 0,
    val modifiedAt: String = "", val savedAt: String = "")
@Serializable data class BackupRestore(val id: String, val itemId: String = "", val versionId: String = "", val relativePath: String = "",
    val state: String, val requestedAt: String = "", val completedAt: String? = null, val error: String? = null)
@Serializable data class Version(val id: String, val versionNumber: Int = 0, val sizeBytes: Long = 0, val createdAt: String = "", val cloudState: String? = null)
@Serializable data class Device(val id: String, val name: String, val platform: String = "", val lastSeenAt: String? = null,
    val createdAt: String = "", val revokedAt: String? = null, val status: String? = null, val devicePublicId: String? = null) {
    val isPhone get() = platform == "IOS" || platform == "ANDROID"
}
@Serializable data class Notice(val id: String, val type: String, val readAt: String? = null, val createdAt: String = "")
@Serializable data class Person(val displayName: String = "", val username: String = "")
@Serializable data class ManifestEntry(val id: String, val displayName: String, val relativePath: String = "", val itemType: String = "FILE",
    val sizeBytes: Long = 0, val mimeType: String? = null)
@Serializable data class Transfer(val id: String, val state: String, val createdAt: String = "", val expiresAt: String? = null,
    val totalSizeBytes: Long = 0, val savedAt: String? = null, val recipientEmail: String? = null, val displayNames: List<String> = emptyList(),
    val preparationState: String? = null, val saveState: String? = null, val failure: String? = null,
    val items: List<ManifestEntry> = emptyList(), val nextEntryCursor: String? = null, val sender: Person? = null, val recipient: Person? = null)
@Serializable data class Share(val id: String, val driveItemId: String = "", val ownerUserId: String = "", val permission: String = "VIEWER",
    val revokedAt: String? = null, val item: DriveItem? = null)
@Serializable data class FolderDownload(val id: String, val name: String = "", val state: String, val files: Int = 0, val bytes: Long = 0,
    val totalFiles: Int = 0, val totalBytes: Long? = null, val currentFile: String? = null, val error: String? = null,
    val downloadUrl: String? = null, val sizeBytes: Long? = null, val contentHash: String? = null)

/** The web's `fileKind`: a readable type name from the extension or MIME type. */
fun fileKind(item: DriveItem): String {
    if (item.isFolder) return "Folder"
    val extension = item.name.substringAfterLast('.', "").lowercase()
    val known = mapOf("pdf" to "PDF document", "md" to "Markdown document", "txt" to "Text document", "doc" to "Word document",
        "docx" to "Word document", "xls" to "Spreadsheet", "xlsx" to "Spreadsheet", "csv" to "CSV spreadsheet", "ppt" to "Presentation",
        "pptx" to "Presentation", "zip" to "ZIP archive", "json" to "JSON file")
    known[extension]?.let { return it }
    val type = item.mimeType?.substringBefore('/')
    if (type in listOf("image", "video", "audio")) return (if (extension.isNotEmpty()) extension.uppercase() + " " else "") + type
    return if (extension.isNotEmpty()) "${extension.uppercase()} file" else "File"
}
/** A full local date and time, as `fileDate(...).full` on the web. */
fun fullDate(iso: String?): String = if (iso.isNullOrBlank()) "Date unavailable" else dateLabel(iso, time = true)
fun plural(count: Int, noun: String) = "$count $noun${if (count == 1) "" else "s"}"
/** The web's `sentence`: TRANSFER_RECEIVED → "Transfer received". */
fun sentence(value: String) = value.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }
val notificationTitles = mapOf(
    "TRANSFER_RECEIVED" to "Someone sent you files", "TRANSFER_ACCEPTED" to "Your transfer was accepted",
    "TRANSFER_DECLINED" to "Your transfer was declined", "TRANSFER_CANCELLED" to "A transfer was cancelled",
    "TRANSFER_EXPIRED" to "A transfer expired", "SHARE_RECEIVED" to "Someone shared an item with you")
val platformNames = mapOf("WEB" to "Web browser", "MACOS" to "Mac", "WINDOWS" to "Windows PC", "LINUX" to "Linux computer",
    "IOS" to "iPhone or iPad", "ANDROID" to "Android device")

/** A folder synced on at least one linked device, with the devices that sync it. */
@Serializable data class SyncDevice(val id: String, val name: String)
@Serializable data class SyncFolder(val id: String, val name: String, val ownerUserId: String? = null, val parentId: String? = null,
    val syncRemovedAt: String? = null, val syncDevices: List<SyncDevice> = emptyList(), val revision: Int? = null, val updatedAt: String = "")
@Serializable data class SyncPerson(val id: String = "", val username: String = "", val displayName: String = "")
/** An invitation to two-way folder sync, sent or received. */
@Serializable data class SyncInvitation(val id: String, val driveItemId: String, val ownerUserId: String = "", val recipientUserId: String = "",
    val syncState: String? = null, val revokedAt: String? = null, val name: String = "", val direction: String = "",
    val owner: SyncPerson = SyncPerson(), val recipient: SyncPerson = SyncPerson(), val createdAt: String = "")
@Serializable data class DeviceResponse(val device: Device)
/** `GET /v1/drive/usage`: quota bytes of every stored version in a folder's subtree. `complete` false: lower bounds. */
@Serializable data class Usage(val itemId: String, val bytes: Long = 0, val files: Int = 0, val complete: Boolean = true)
@Serializable data class UsagePage(val items: List<Usage>)
/** A summed usage. Not complete when any part was too large to finish counting. */
data class UsageTotal(val bytes: Long, val files: Int, val complete: Boolean)
/** Sums usage over unique folder ids; null until every one of them has loaded. */
fun sumUsage(ids: Collection<String>, usage: Map<String, Usage>): UsageTotal? {
    val parts = ids.toSet().map { usage[it] ?: return null }
    return UsageTotal(parts.sumOf { it.bytes }, parts.sumOf { it.files }, parts.all { it.complete })
}
/** "4.2 GB"; a partial count reads "At least 4.2 GB", or "4.2 GB+" where space is tight. */
fun usageLabel(total: UsageTotal, tight: Boolean = false): String = bytesLabel(total.bytes).let {
    if (total.complete) it else if (tight) "$it+" else "At least $it"
}
