package app.harbor0.android

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.UUID

class BackendIntegrationTest {
    @Test fun realBackendMultipartRoundTripAppearanceTrashAndRevocation() = runBlocking {
        assumeTrue("Run with test-android.mjs for isolated backend coverage", System.getenv("HARBOR_ANDROID_INTEGRATION") == "true")
        val base = "http://127.0.0.1:18990"
        val marker = UUID.randomUUID().toString().replace("-", "")
        val email = "android-$marker@example.test"
        val password = "Development-only-123!"
        val client = OkHttpClient()
        fun post(path: String, fields: Map<String, String>) {
            val payload = harborJson.encodeToString(fields).toRequestBody("application/json".toMediaType())
            client.newCall(Request.Builder().url(base + path).post(payload).build()).execute().use {
                assertTrue(it.body?.string(), it.isSuccessful)
            }
        }
        post("/v1/auth/signup", mapOf("email" to email, "password" to password, "username" to "android_${marker.take(20)}", "displayName" to "Android integration"))
        post("/v1/auth/confirm", mapOf("email" to email, "code" to "123456"))
        val credentials = MemoryCredentials()
        val api = HarborApi(base, credentials)
        api.login(email, password, "Android integration")
        assertEquals(email, api.get<Account>("/v1/users/me").user.email)
        api.createFolder("Android uploads", null)
        val folder = api.list(null).items.first { it.name == "Android uploads" }
        val directory = Files.createTempDirectory("harbor-android-integration").toFile()
        try {
            val source = File(directory, "Android-roundtrip.bin")
            source.outputStream().use { output -> repeat(65) { output.write(ByteArray(1024 * 1024) { 0x41 }) } }
            val transfers = FileTransfers(api, allowLocal = true)
            val item = transfers.upload(source, source.name, "application/octet-stream", folder.id) { _, _ -> }
            assertEquals(65L * 1024 * 1024, item.sizeBytes)
            val download = transfers.download(item, File(directory, "previews")) { _, _ -> }
            assertEquals(FileTransfers.digest(source), FileTransfers.digest(download))
            val appearance = Appearance("dark", "forest", Palettes(dark = mapOf("sidebar" to "#123456")))
            api.request("/v1/users/me", "PATCH", buildJsonObject {
                operation().forEach { (k, v) -> put(k, v) }; put("appearance", harborJson.encodeToJsonElement(appearance))
            })
            assertEquals(appearance, api.get<Account>("/v1/users/me").user.appearance)
            api.get<DrivePage>("/v1/sync/folders"); api.get<Backups>("/v1/backups")
            api.trash(item, "trash")
            val deleted = api.get<DrivePage>("/v1/search?trash=true").items.first { it.id == item.id }
            assertNotNull(deleted.deletedAt)
            api.trash(deleted, "restore")
            val restored = api.list(folder.id).items.first { it.id == item.id }
            assertNull(restored.deletedAt)
            api.trash(restored, "trash"); api.emptyTrash()
            assertTrue(api.get<DrivePage>("/v1/search?trash=true").items.isEmpty())
            val second = HarborApi(base, credentials)
            second.restore(); assertTrue(second.signedIn.value)
            second.logout(); assertNull(credentials.value)
            assertTrue(runCatching { api.get<Account>("/v1/users/me") }.isFailure)
            assertFalse(api.signedIn.value)
        } finally { directory.deleteRecursively() }
    }
}
