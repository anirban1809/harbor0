package app.harbor0.android

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

class MemoryCredentials: CredentialStore {
    var value: SavedSession? = null
    var failSave = false
    override fun load() = value
    override fun save(session: SavedSession) { check(!failSave) { "Secure storage failed" }; value = session }
    override fun clear() { value = null }
}
class HarborApiTest {
    private lateinit var server: MockWebServer
    private lateinit var store: MemoryCredentials
    private lateinit var api: HarborApi
    private val tokens = """{"accessToken":"access","refreshToken":"refresh","expiresIn":3600}"""
    @Before fun setup() { server = MockWebServer(); server.start(); store = MemoryCredentials(); api = HarborApi(server.url("/").toString(), store) }
    @After fun cleanup() { server.shutdown() }
    private fun json(text: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(text)
    private suspend fun login() { server.enqueue(json(tokens)); api.login(" TEST@Example.test ", "secret", "Android test") }
    @Test fun loginRegistersAndroidAndNormalizesEmail() = runBlocking {
        login()
        val request = server.takeRequest()
        val body = harborJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("ANDROID", body["platform"]!!.jsonPrimitive.content)
        assertEquals("test@example.test", body["email"]!!.jsonPrimitive.content)
        assertTrue(api.signedIn.value); assertNotNull(store.value)
    }
    @Test fun loginProvesDeviceKeyWithSignedChallenge() = runBlocking {
        val pair = java.security.KeyPairGenerator.getInstance("EC").apply {
            initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        val key = DeviceKey(pair.public.encoded, pair.private)
        val signed = HarborApi(server.url("/").toString(), store, deviceKeys = object: DeviceKeyStore {
            override fun key(account: String) = key.also { assertEquals("user-1", account) }
        })
        server.enqueue(json(tokens))
        server.enqueue(json("""{"challenge":"nonce","userId":"user-1","expiresAt":"2030-01-01T00:00:00Z"}"""))
        server.enqueue(json("{}"))
        signed.login("a@b.test", "secret", "Pixel")
        assertEquals("/v1/auth/login", server.takeRequest().path)
        val challenge = server.takeRequest()
        assertEquals("/v1/auth/session/challenge", challenge.path)
        assertEquals("Bearer access", challenge.getHeader("Authorization"))
        val body = harborJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(key.fingerprint, body["devicePublicId"]!!.jsonPrimitive.content)
        assertEquals("Pixel", body["name"]!!.jsonPrimitive.content)
        val proof = body["proof"]!!.jsonObject
        val decode = { name: String -> java.util.Base64.getUrlDecoder().decode(proof[name]!!.jsonPrimitive.content) }
        val publicKey = java.security.KeyFactory.getInstance("EC").generatePublic(java.security.spec.X509EncodedKeySpec(decode("publicKey")))
        val valid = java.security.Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey); update("harbor0-device-v1\nnonce\nuser-1\n${key.fingerprint}".toByteArray()); verify(decode("signature"))
        }
        assertTrue(valid)
        assertTrue(store.value!!.deviceProven)
    }
    @Test fun failedPersistenceNeverSignsIn() = runBlocking {
        store.failSave = true
        assertTrue(runCatching { login() }.isFailure)
        assertFalse(api.signedIn.value); assertNull(store.value)
    }
    @Test fun invalidRefreshClearsSession() = runBlocking {
        store.value = SavedSession(Tokens("old", "old-refresh", 1.0), 0)
        server.enqueue(json("""{"error":{"message":"Expired"}}""", 401))
        assertTrue(runCatching { api.restore() }.isFailure)
        assertFalse(api.signedIn.value); assertNull(store.value)
    }
    @Test fun offlineRestoreRetainsCredentialForRetry() = runBlocking {
        store.value = SavedSession(Tokens("old", "old-refresh", 1.0), 0)
        server.enqueue(json("{}", 503))
        assertTrue(runCatching { api.restore() }.isFailure)
        assertNotNull(store.value); assertTrue(api.canRestore)
    }
    @Test fun unauthorizedRequestRefreshesAndRetries() = runBlocking {
        login(); server.takeRequest()
        server.enqueue(json("{}", 401)); server.enqueue(json(tokens.replace("\"access\"", "\"new-access\""))); server.enqueue(json("""{"items":[]}"""))
        api.list(null)
        assertEquals("Bearer access", server.takeRequest().getHeader("Authorization"))
        assertEquals("/v1/auth/refresh", server.takeRequest().path)
        assertEquals("Bearer new-access", server.takeRequest().getHeader("Authorization"))
    }
    @Test fun revokedDeviceInvalidatesMemoryAndDisk() = runBlocking {
        login(); server.enqueue(json("""{"error":{"message":"Revoked","code":"DEVICE_REVOKED"}}""", 403))
        assertTrue(runCatching { api.list(null) }.isFailure)
        assertNull(store.value); assertFalse(api.signedIn.value)
    }
    @Test fun failedLogoutRetainsSessionForRetry() = runBlocking {
        login(); server.enqueue(json("{}", 503))
        assertTrue(runCatching { api.logout() }.isFailure)
        assertTrue(api.signedIn.value); assertNotNull(store.value)
        server.enqueue(json("{}")); api.logout(); assertNull(store.value)
    }
    @Test fun cursorAndPathAreEncodedWithoutChangingTheirMeaning() {
        val path = HarborApi.pagePath("/v1/search?trash=true", "a+b&other=x?/=")
        val url = server.url(path)
        assertEquals("true", url.queryParameter("trash"))
        assertEquals("a+b&other=x?/=", url.queryParameter("cursor"))
        assertEquals("a%2Fb", HarborApi.segment("a/b"))
    }
    @Test fun unsafeNamesAndInsecureStorageAreRejected() {
        listOf("", ".", "..", "../secret", "a\\b", "a\u0000b").forEach { assertTrue(runCatching { safeName(it) }.isFailure) }
        assertEquals("Report 2026.pdf", safeName("Report 2026.pdf"))
        assertTrue(runCatching { FileTransfers.validateUrl("http://example.com/file", "https://api.test", false) }.isFailure)
        assertTrue(runCatching { FileTransfers.validateUrl("http://localhost/file", "https://api.test", true) }.isFailure)
        FileTransfers.validateUrl(server.url("/file").toString(), server.url("/").toString(), true)
    }
    @Test fun repeatedTrashCursorStopsInsteadOfLooping() = runBlocking {
        login(); repeat(2) { server.enqueue(json("""{"count":1,"nextCursor":"same"}""")) }
        assertTrue(runCatching { api.emptyTrash() }.isFailure)
        assertEquals(3, server.requestCount)
    }
    @Test fun downloadRejectsChecksumMismatchAndRemovesTemporaryFile() = runBlocking {
        login()
        server.enqueue(json("""{"downloadUrl":"${server.url("/storage")}","sizeBytes":3,"contentHash":"wrong"}"""))
        server.enqueue(MockResponse().setBody("abc"))
        val directory = Files.createTempDirectory("harbor-test").toFile()
        try {
            assertTrue(runCatching { FileTransfers(api, allowLocal = true).download(DriveItem("file", "note.txt", "FILE"), directory) { _, _ -> } }.isFailure)
            assertTrue(directory.listFiles().orEmpty().isEmpty())
            server.takeRequest(); server.takeRequest()
            assertNull(server.takeRequest().getHeader("Authorization"))
        } finally { directory.deleteRecursively() }
    }
    @Test fun multipartRetriesStorageAndCompletesWithChecksum() = runBlocking {
        val directory = Files.createTempDirectory("harbor-upload").toFile()
        val file = File(directory, "hello.txt").apply { writeText("hello") }
        val storageAttempts = AtomicInteger()
        var completed: JsonObject? = null
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/v1/auth/login" -> json(tokens)
                "/v1/uploads" -> json("""{"upload":{"id":"upload","partSizeBytes":3}}""")
                "/v1/uploads/upload/parts" -> {
                    val n = harborJson.parseToJsonElement(request.body.readUtf8()).jsonObject["partNumbers"]!!.jsonArray[0].jsonPrimitive.int
                    json("""{"parts":[{"partNumber":$n,"uploadUrl":"${server.url("/storage/$n")}"}]}""")
                }
                "/storage/1", "/storage/2" -> {
                    assertNull(request.getHeader("Authorization"))
                    if (storageAttempts.incrementAndGet() == 1) json("{}", 503) else MockResponse().setHeader("ETag", "part-${request.path!!.last()}")
                }
                "/v1/uploads/upload/complete" -> {
                    completed = harborJson.parseToJsonElement(request.body.readUtf8()).jsonObject
                    json("""{"item":{"id":"file","name":"hello.txt","type":"FILE","sizeBytes":5}}""")
                }
                else -> json("{}", 404)
            }
        }
        try {
            api.login("test@example.test", "secret", "test")
            val item = FileTransfers(api, allowLocal = true).upload(file, "hello.txt", "text/plain", null) { _, _ -> }
            assertEquals(5L, item.sizeBytes); assertEquals(3, storageAttempts.get())
            assertEquals(FileTransfers.digest(file), completed!!["contentHash"]!!.jsonPrimitive.content)
            assertEquals(2, completed!!["parts"]!!.jsonArray.size)
        } finally { directory.deleteRecursively() }
    }
    @Test fun failedUploadAbortsReservation() = runBlocking {
        login(); server.takeRequest()
        val directory = Files.createTempDirectory("harbor-abort").toFile()
        val source = File(directory, "file").apply { writeText("abc") }
        server.enqueue(json("""{"upload":{"id":"abort","partSizeBytes":0}}""")); server.enqueue(json("{}"))
        try {
            assertTrue(runCatching { FileTransfers(api, allowLocal = true).upload(source, "file", "text/plain", null) { _, _ -> } }.isFailure)
            server.takeRequest()
            val abort = server.takeRequest()
            assertEquals("DELETE", abort.method); assertEquals("/v1/uploads/abort", abort.path)
        } finally { directory.deleteRecursively() }
    }
    @Test fun syncFoldersAndDevicesDecodeForSyncedFolders() = runBlocking {
        login(); server.takeRequest()
        server.enqueue(json("""{"items":[{"id":"f1","name":"Photos","type":"FOLDER","syncDevices":[{"id":"mac","name":"Studio Mac"}]}],"nextCursor":null}"""))
        server.enqueue(json("""{"items":[{"id":"mac","name":"Studio Mac","platform":"MACOS","status":"ACTIVE","devicePublicId":"k1"},{"id":"w","name":"Chrome","platform":"WEB","status":"ACTIVE"}]}"""))
        val folders = api.all<DriveItem>("/v1/sync/folders")
        val devices = api.get<Page<Device>>("/v1/devices").items
        assertEquals(listOf("mac"), folders.single().syncDevices.map { it.id })
        assertEquals("ACTIVE", devices[0].status); assertFalse(devices[0].isPhone)
        assertEquals("/v1/sync/folders", server.takeRequest().path)
    }
}
