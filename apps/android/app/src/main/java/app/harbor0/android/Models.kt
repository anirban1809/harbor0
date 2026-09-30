package app.harbor0.android

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

val harborJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }
fun operation(vararg values: Pair<String, String?>): JsonObject = buildJsonObject {
    put("operationId", UUID.randomUUID().toString())
    values.forEach { (key, value) -> put(key, value) }
}
@Serializable data class Tokens(val accessToken: String, val refreshToken: String, val expiresIn: Double)
@Serializable data class SavedSession(val tokens: Tokens, val expiresAt: Long)
@Serializable data class DriveItem(
    val id: String, val name: String, val type: String, val parentId: String? = null,
    val mimeType: String? = null, val sizeBytes: Long = 0, val revision: Int? = null,
    val updatedAt: String = "", val deletedAt: String? = null, val backupRootId: String? = null,
    val cloudState: String? = null,
) { val isFolder get() = type == "FOLDER" }
@Serializable data class DrivePage(val items: List<DriveItem>, val nextCursor: String? = null)
@Serializable data class ItemResponse(val item: DriveItem)
@Serializable data class Appearance(val preference: String = "system", val preset: String = "default", val palettes: Palettes = Palettes())
@Serializable data class Palettes(val light: Map<String, String> = emptyMap(), val dark: Map<String, String> = emptyMap())
@Serializable data class User(val id: String, val email: String, val displayName: String, val appearance: Appearance = Appearance())
@Serializable data class Storage(val quotaBytes: Long, val usedBytes: Long, val reservedBytes: Long)
@Serializable data class Account(val user: User, val storage: Storage)
@Serializable data class Backups(val items: List<BackupRoot>)
@Serializable data class BackupRoot(val id: String, val localPathDisplayName: String, val remoteRootDriveItemId: String,
    val state: String, val deviceName: String? = null, val updatedAt: String = "") {
    val folder get() = DriveItem(remoteRootDriveItemId, localPathDisplayName, "FOLDER", backupRootId = id)
}
@Serializable data class BackupRun(val id: String, val state: String, val trigger: String, val startedAt: String,
    val fileCount: Int, val sizeBytes: Long, val error: String? = null)
@Serializable data class RunPage(val items: List<BackupRun>, val nextCursor: String? = null)
@Serializable data class SyncStatus(val itemId: String, val state: String, val requiredDevices: Int, val confirmedDevices: Int) {
    val label get() = when (state) { "SYNCED" -> "Up to date"; "SYNCING" -> "Syncing"; "PENDING" -> "Waiting for a computer"; else -> "Status unavailable" }
}
@Serializable data class StatusPage(val items: List<SyncStatus>)
@Serializable data class Upload(val id: String, val partSizeBytes: Long)
@Serializable data class UploadResponse(val upload: Upload)
@Serializable data class Part(val partNumber: Int, val uploadUrl: String)
@Serializable data class Parts(val parts: List<Part>)
@Serializable data class CompletedPart(val partNumber: Int, val etag: String)
@Serializable data class Download(val downloadUrl: String, val sizeBytes: Long, val contentHash: String)
class ApiException(val status: Int, override val message: String, val code: String? = null): Exception(message)
fun safeName(name: String): String {
    require(name.isNotBlank() && name != "." && name != ".." && name.length <= 255 && name.none { it == '/' || it == '\\' || it.isISOControl() }) { "Choose a valid file or folder name." }
    return name
}
fun bytesLabel(bytes: Long): String {
    if (bytes < 1000) return "$bytes B"
    val units = listOf("kB", "MB", "GB", "TB")
    var value = bytes.toDouble() / 1000
    var index = 0
    while (value >= 1000 && index < units.lastIndex) { value /= 1000; index++ }
    return "%.1f %s".format(value, units[index])
}
