package app.harbor0.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

suspend fun Call.awaitResponse(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (!continuation.isCancelled) continuation.resumeWithException(e) }
        override fun onResponse(call: Call, response: Response) {
            continuation.resume(response) { _, value, _ -> value.close() }
        }
    })
}

class HarborApi(val baseUrl: String, private val credentials: CredentialStore,
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(45, TimeUnit.SECONDS).followRedirects(false).build(),
    private val now: () -> Long = System::currentTimeMillis, private val deviceKeys: DeviceKeyStore? = null) {
    private val sessionLock = Mutex()
    private var saved: SavedSession? = null
    private val _signedIn = MutableStateFlow(false)
    val signedIn = _signedIn.asStateFlow()
    var canRestore = false; private set

    private var deviceName: String? = null
    private suspend fun persist(tokens: Tokens, deviceProven: Boolean = saved?.deviceProven ?: false) {
        val next = SavedSession(tokens, now() + (tokens.expiresIn * 1000).toLong(), deviceProven)
        withContext(Dispatchers.IO) { credentials.save(next) }
        saved = next; canRestore = true
    }
    private suspend fun clear() {
        // Invalidate memory even when storage fails; the caller can retry removing local data.
        saved = null; _signedIn.value = false
        withContext(Dispatchers.IO) { credentials.clear() }
        canRestore = false
    }
    suspend fun forget() = sessionLock.withLock { clear() }
    suspend fun restore() = sessionLock.withLock {
        canRestore = true
        saved = withContext(Dispatchers.IO) { credentials.load() }
        canRestore = saved != null
        if (saved != null) {
            refresh()
            // Sessions from before signed device identity are upgraded once; a failure retries next launch.
            saved?.takeIf { !it.deviceProven }?.let { current ->
                if (runCatching { proveDevice(current.tokens.accessToken) }.isSuccess) {
                    val next = current.copy(deviceProven = true)
                    runCatching { withContext(Dispatchers.IO) { credentials.save(next) } }.onSuccess { saved = next }
                }
            }
            _signedIn.value = true
        }
    }
    suspend fun login(email: String, password: String, deviceName: String) = sessionLock.withLock {
        val tokens = harborJson.decodeFromJsonElement<Tokens>(raw("/v1/auth/login", "POST", buildJsonObject {
            put("email", email.trim().lowercase()); put("password", password)
            put("platform", "ANDROID"); put("deviceName", deviceName)
        }))
        this.deviceName = deviceName
        // Servers without signed device identity don't offer the challenge; restore() upgrades later.
        val proven = try { proveDevice(tokens.accessToken); true }
            catch (e: ApiException) { if (e.status != 404) throw e; false }
        persist(tokens, deviceProven = proven); _signedIn.value = true
    }
    /** Binds this session to the installation's key so the server can tell devices apart. */
    private suspend fun proveDevice(token: String) {
        val keys = deviceKeys ?: return
        val challenge = raw("/v1/auth/session/challenge", "POST", null, token)
        val nonce = challenge["challenge"]!!.jsonPrimitive.content
        val userId = challenge["userId"]!!.jsonPrimitive.content
        val key = withContext(Dispatchers.IO) { keys.key(userId) }
        raw("/v1/auth/session", "POST", buildJsonObject {
            put("name", deviceName ?: "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"); put("platform", "ANDROID"); put("devicePublicId", key.fingerprint)
            put("proof", key.proof(nonce, userId))
        }, token)
    }
    private suspend fun refresh() {
        val token = saved?.tokens?.refreshToken ?: throw ApiException(401, "Sign in to continue.")
        try {
            persist(harborJson.decodeFromJsonElement(raw("/v1/auth/refresh", "POST", buildJsonObject { put("refreshToken", token) })))
        } catch (e: ApiException) { if (e.status == 401 || e.status == 403) clear(); throw e }
    }
    suspend fun logout() = sessionLock.withLock {
        if (saved != null) {
            try {
                authorized("/v1/auth/logout", "POST") { buildJsonObject { put("refreshToken", saved?.tokens?.refreshToken) } }
            } catch (e: ApiException) { if (_signedIn.value && e.code != "DEVICE_REVOKED") throw e }
        }
        clear()
    }
    /** Unauthenticated account flows: sign-up, email confirmation, resend and password reset. */
    suspend fun anonymous(path: String, body: JsonObject): JsonObject {
        require(path.startsWith("/v1/auth/"))
        return raw(path, "POST", body)
    }
    suspend fun request(path: String, method: String = "GET", body: JsonObject? = null): JsonObject = sessionLock.withLock {
        authorized(path, method) { body }
    }
    suspend inline fun <reified T> get(path: String): T = harborJson.decodeFromJsonElement(request(path))
    private suspend fun authorized(path: String, method: String, body: () -> JsonObject?): JsonObject {
        if ((saved?.expiresAt ?: 0) - now() < 60_000) refresh()
        val token = saved?.tokens?.accessToken ?: throw ApiException(401, "Sign in to continue.")
        try { return raw(path, method, body(), token) }
        catch (e: ApiException) {
            if (e.code == "DEVICE_REVOKED") { clear(); throw e }
            if (e.status != 401) throw e
            refresh()
            try { return raw(path, method, body(), saved?.tokens?.accessToken) }
            catch (retry: ApiException) { if (retry.status == 401 || retry.code == "DEVICE_REVOKED") clear(); throw retry }
        }
    }
    private suspend fun raw(path: String, method: String, body: JsonObject?, token: String? = null): JsonObject = withContext(Dispatchers.IO) {
        require(path.startsWith("/v1/"))
        val request = Request.Builder().url(baseUrl.trimEnd('/') + path)
        if (token != null) request.header("Authorization", "Bearer $token")
        val payload = body?.toString()?.toRequestBody("application/json".toMediaType())
        request.method(method, payload ?: if (method == "POST" || method == "PATCH") "{}".toRequestBody("application/json".toMediaType()) else null)
        client.newCall(request.build()).awaitResponse().use { response ->
            val text = response.body?.string().orEmpty()
            val json = runCatching { harborJson.parseToJsonElement(text).jsonObject }.getOrNull()
            if (!response.isSuccessful) {
                val error = json?.get("error") as? JsonObject
                throw ApiException(response.code, error?.get("message")?.jsonPrimitive?.contentOrNull ?: "The server could not complete this request (${response.code}). Try again.",
                    error?.get("code")?.jsonPrimitive?.contentOrNull, error?.get("details") as? JsonObject)
            }
            json ?: if (text.isBlank()) buildJsonObject {} else throw IOException("The server returned an unreadable response.")
        }
    }
    companion object {
        fun pagePath(path: String, cursor: String?): String {
            val url = ("https://harbor.invalid" + path).toHttpUrl().newBuilder()
            if (cursor != null) url.addQueryParameter("cursor", cursor)
            val built = url.build()
            return built.encodedPath + (built.encodedQuery?.let { "?$it" } ?: "")
        }
        fun segment(value: String): String = "https://harbor.invalid".toHttpUrl().newBuilder().addPathSegment(value).build().encodedPath.drop(1)
    }
    suspend fun list(parent: String?, cursor: String? = null): DrivePage = get(pagePath("/v1/drive/folders/${segment(parent ?: "root")}/children", cursor))
    suspend fun createFolder(name: String, parent: String?): DriveItem =
        harborJson.decodeFromJsonElement<ItemResponse>(request("/v1/drive/folders", "POST", operation("name" to safeName(name.trim()), "parentId" to parent))).item
    /** Follows every page of a list endpoint, stopping if the server repeats a cursor. */
    suspend inline fun <reified T> all(path: String): List<T> {
        val result = mutableListOf<T>()
        val seen = mutableSetOf<String>()
        var cursor: String? = null
        do {
            val page = get<Page<T>>(pagePath(path, cursor))
            result += page.items
            cursor = page.nextCursor
            check(cursor == null || seen.add(cursor)) { "Could not load the remaining files. Please retry." }
        } while (cursor != null)
        return result
    }
    /** A mutation body: a fresh operation ID, the item's revision, and any extra fields. */
    fun mutation(item: DriveItem, extra: JsonObjectBuilder.() -> Unit = {}): JsonObject = buildJsonObject {
        operation().forEach { (k, v) -> put(k, v) }
        item.revision?.let { put("baseRevision", it) }
        extra()
    }
    suspend fun trash(item: DriveItem, action: String) {
        val revision = item.revision ?: throw IllegalStateException("Refresh this list before changing the file.")
        require(revision > 0)
        require(action in listOf("trash", "restore", "permanent"))
        val suffix = if (action == "trash") "" else "/$action"
        request("/v1/drive/items/${segment(item.id)}$suffix", if (action == "restore") "POST" else "DELETE", buildJsonObject {
            operation().forEach { (k, v) -> put(k, v) }; put("baseRevision", revision)
        })
    }
    suspend fun emptyTrash() {
        var cursor: String? = null
        val seen = mutableSetOf<String>()
        do {
            val result = request("/v1/drive/trash/empty", "POST", buildJsonObject {
                operation().forEach { (k, v) -> put(k, v) }; cursor?.let { put("cursor", it) }
            })
            cursor = result["nextCursor"]?.jsonPrimitive?.contentOrNull
            check(cursor == null || seen.add(cursor)) { "Trash cleanup stopped unexpectedly. Refresh and try again." }
        } while (cursor != null)
    }
}
