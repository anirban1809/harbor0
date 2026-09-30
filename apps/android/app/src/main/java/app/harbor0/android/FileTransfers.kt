package app.harbor0.android

import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okio.BufferedSink
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

class FileTransfers(private val api: HarborApi, private val storage: OkHttpClient = OkHttpClient.Builder()
    .callTimeout(5, TimeUnit.MINUTES).followRedirects(false).build(), private val allowLocal: Boolean = BuildConfig.DEBUG) {
    companion object {
        suspend fun digest(file: File): String = withContext(Dispatchers.IO) {
            val hash = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(1024 * 1024)
                while (true) { ensureActive(); val count = input.read(buffer); if (count < 0) break; hash.update(buffer, 0, count) }
            }
            hash.digest().joinToString("") { "%02x".format(it) }
        }
        fun validateUrl(value: String, base: String, allowLocal: Boolean) {
            val url = value.toHttpUrl()
            val apiUrl = base.toHttpUrl()
            val local = setOf("localhost", "127.0.0.1", "10.0.2.2")
            require(url.username.isEmpty() && url.password.isEmpty() && (url.isHttps ||
                (allowLocal && !apiUrl.isHttps && apiUrl.host in local && url.host in local))) { "The file server did not provide a secure transfer address." }
        }
    }
    suspend fun upload(source: File, name: String, mime: String, parent: String?, progress: (String, Float?) -> Unit): DriveItem = withContext(Dispatchers.IO) {
        safeName(name)
        progress("Checking $name…", null)
        val hash = digest(source)
        val size = source.length()
        val result = harborJson.decodeFromJsonElement<UploadResponse>(api.request("/v1/uploads", "POST", buildJsonObject {
            operation("name" to name, "parentId" to parent).forEach { (k, v) -> put(k, v) }
            put("sizeBytes", size); put("mimeType", mime); put("contentHash", hash)
        }))
        val upload = result.upload
        val route = "/v1/uploads/${HarborApi.segment(upload.id)}"
        try {
            require(upload.partSizeBytes > 0) { "The server returned an invalid upload size." }
            val count = if (size == 0L) 1 else (size - 1) / upload.partSizeBytes + 1
            require(count <= 10_000) { "This file is too large to upload." }
            val parts = mutableListOf<CompletedPart>()
            for (number in 1..count.toInt()) {
                ensureActive()
                val offset = (number - 1L) * upload.partSizeBytes
                val length = minOf(upload.partSizeBytes, size - offset)
                var completed: CompletedPart? = null
                for (attempt in 0..2) {
                    try {
                        val urls = harborJson.decodeFromJsonElement<Parts>(api.request("$route/parts", "POST", buildJsonObject { put("partNumbers", JsonArray(listOf(JsonPrimitive(number)))) }))
                        val url = urls.parts.first { it.partNumber == number }.uploadUrl
                        validateUrl(url, api.baseUrl, allowLocal)
                        val body = object : RequestBody() {
                            override fun contentType(): MediaType? = null
                            override fun contentLength() = length
                            override fun writeTo(sink: BufferedSink) {
                                RandomAccessFile(source, "r").use { input ->
                                    input.seek(offset)
                                    var remaining = length
                                    val buffer = ByteArray(256 * 1024)
                                    while (remaining > 0) {
                                        val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                                        check(read > 0) { "The selected file could not be read." }
                                        sink.write(buffer, 0, read); remaining -= read
                                    }
                                }
                            }
                        }
                        storage.newCall(Request.Builder().url(url).put(body).build()).awaitResponse().use { response ->
                            check(response.isSuccessful) { "File upload failed (${response.code}). Try again." }
                            val etag = response.header("ETag")
                            check(!etag.isNullOrBlank()) { "File storage did not confirm the upload." }
                            completed = CompletedPart(number, etag)
                        }
                        break
                    } catch (e: Exception) { ensureActive(); if (attempt == 2) throw e; delay(250L * (attempt + 1)) }
                }
                parts += checkNotNull(completed)
                progress("Uploading $name…", if (size == 0L) 1f else (offset + length).toFloat() / size)
            }
            progress("Finishing $name…", null)
            harborJson.decodeFromJsonElement<ItemResponse>(api.request("$route/complete", "POST", buildJsonObject {
                put("parts", harborJson.encodeToJsonElement(parts)); put("contentHash", hash)
            })).item
        } catch (e: Exception) {
            withContext(NonCancellable) { runCatching { withTimeout(15_000) { api.request(route, "DELETE") } } }
            throw e
        }
    }
    suspend fun download(item: DriveItem, previewDirectory: File, progress: (String, Float?) -> Unit): File = withContext(Dispatchers.IO) {
        val name = safeName(item.name)
        val authorization = harborJson.decodeFromJsonElement<Download>(api.request("/v1/downloads", "POST", buildJsonObject { put("driveItemId", item.id) }))
        validateUrl(authorization.downloadUrl, api.baseUrl, allowLocal)
        val folder = File(previewDirectory, UUID.randomUUID().toString()).apply { check(mkdirs()) }
        val file = File(folder, name)
        try {
            progress("Downloading $name…", null)
            storage.newCall(Request.Builder().url(authorization.downloadUrl).build()).awaitResponse().use { response ->
                check(response.isSuccessful) { "Download failed (${response.code}). Try again." }
                val body = checkNotNull(response.body)
                body.byteStream().use { input -> file.outputStream().use { output ->
                    val buffer = ByteArray(256 * 1024)
                    var received = 0L
                    while (true) {
                        ensureActive(); val n = input.read(buffer); if (n < 0) break
                        received += n
                        check(received <= authorization.sizeBytes) { "The downloaded file failed its integrity check." }
                        output.write(buffer, 0, n)
                        progress("Downloading $name…", if (authorization.sizeBytes == 0L) 1f else received.toFloat() / authorization.sizeBytes)
                    }
                } }
            }
            progress("Checking $name…", null)
            check(file.length() == authorization.sizeBytes && digest(file).equals(authorization.contentHash, ignoreCase = true)) { "The downloaded file failed its integrity check. Try downloading it again." }
            file
        } catch (e: Exception) { folder.deleteRecursively(); throw e }
    }
}
