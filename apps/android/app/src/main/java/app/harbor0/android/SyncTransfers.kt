package app.harbor0.android

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/** A local read that failed while a request body was being sent: a problem with the file, not the network. */
class LocalReadException(val error: LocalFsException): IOException(error.message, error)

/**
 * Resumable transfers between a local folder and the cloud (desktop `transfers.ts`): multipart uploads whose
 * state is persisted in the job, and downloads to a `.harbor-part` file that is verified by size and SHA-256
 * before it replaces the destination.
 */
class SyncTransfers(private val api: HarborApi, private val storage: OkHttpClient = OkHttpClient.Builder()
    .callTimeout(10, TimeUnit.MINUTES).readTimeout(60, TimeUnit.SECONDS).followRedirects(false).build(), private val allowLocal: Boolean = BuildConfig.DEBUG) {

    suspend fun upload(tree: LocalTree, relative: String, name: String, parentId: String?, state: UploadState, persist: () -> Unit,
        existing: LocalFile? = null, progress: (Long, Long) -> Unit = { _, _ -> }, beforeComplete: suspend () -> Unit = {},
        backup: Pair<String, String>? = null): DriveItem {
        val info = tree.stat(relative) ?: throw LocalFsException("ENOENT", "“$name” could not be found.", relative)
        if (state.mtime != null && (state.mtime != info.mtime || state.size != info.size)) {
            state.uploadId?.let { runCatching { api.request("/v1/uploads/${HarborApi.segment(it)}", "DELETE") } }
            state.operationId = UUID.randomUUID().toString(); state.uploadId = null; state.partSize = null; state.hash = null; state.parts = null
        }
        state.mtime = info.mtime; state.size = info.size
        if (state.hash == null) state.hash = tree.hash(relative)
        persist()
        // A freshly created upload has no parts yet; only a resumed one needs its server status.
        var created = false
        if (state.uploadId == null) {
            val input = buildJsonObject {
                put("operationId", state.operationId); put("parentId", parentId); put("name", name); put("sizeBytes", info.size)
                put("mimeType", "application/octet-stream"); put("contentHash", state.hash)
                if (existing != null) { put("driveItemId", existing.itemId); put("baseRevision", existing.revision) }
            }
            val result = if (backup != null) api.request("/v1/backups/${HarborApi.segment(backup.first)}/runs/${HarborApi.segment(backup.second)}/uploads", "POST", input)
                else api.request("/v1/uploads", "POST", input)
            val upload = result["upload"]!!.jsonObject
            state.uploadId = upload["id"]!!.jsonPrimitive.content
            state.partSize = upload["partSizeBytes"]!!.jsonPrimitive.long
            persist()
            created = true
        }
        val route = "/v1/uploads/${HarborApi.segment(state.uploadId!!)}"
        val status = if (created) null else api.request(route)
        val upload = status?.get("upload")?.jsonObject
        val uploadState = upload?.get("state")?.jsonPrimitive?.contentOrNull
        if (uploadState == "COMPLETED") return harborJson.decodeFromJsonElement(upload["item"]!!)
        if (uploadState in listOf("ABORTED", "FAILED", "EXPIRED")) {
            state.uploadId = null; state.operationId = UUID.randomUUID().toString(); persist()
            return upload(tree, relative, name, parentId, state, persist, existing, progress, beforeComplete, backup)
        }
        val partSize = state.partSize ?: throw IllegalStateException("The server returned an invalid upload size.")
        require(partSize > 0) { "The server returned an invalid upload size." }
        val parts = (if (uploadState == "COMPLETING") state.parts.orEmpty() else status?.get("parts")?.let { harborJson.decodeFromJsonElement<List<CompletedPart>>(it) }.orEmpty()).toMutableList()
        val count = maxOf(1L, (info.size + partSize - 1) / partSize).toInt()
        val done = parts.map { it.partNumber }.toSet()
        fun bytes(n: Int) = minOf(partSize, info.size - (n - 1) * partSize)
        var loaded = parts.sumOf { bytes(it.partNumber) }
        progress(loaded, info.size)
        for (number in (1..count).filter { it !in done }) {
            currentCoroutineContext().ensureActive()
            val offset = (number - 1) * partSize
            val length = bytes(number)
            var etag: String? = null
            for (attempt in 0..2) {
                try {
                    val urls = api.request("$route/parts", "POST", buildJsonObject { put("partNumbers", JsonArray(listOf(JsonPrimitive(number)))) })
                    val url = urls["parts"]!!.jsonArray.map { it.jsonObject }.first { it["partNumber"]!!.jsonPrimitive.int == number }["uploadUrl"]!!.jsonPrimitive.content
                    FileTransfers.validateUrl(url, api.baseUrl, allowLocal)
                    val body = object: RequestBody() {
                        override fun contentType(): MediaType? = null
                        override fun contentLength() = length
                        override fun writeTo(sink: BufferedSink) {
                            // Failures reading the local file are reported as that file's problem, not a network error.
                            fun <T> local(block: () -> T): T = try { block() } catch (e: LocalFsException) { throw LocalReadException(e) }
                                catch (e: IOException) { throw LocalReadException(localError(e, relative)) }
                            val input = try { tree.openRead(relative) } catch (e: LocalFsException) { throw LocalReadException(e) }
                            input.use {
                                var skipped = 0L
                                while (skipped < offset) {
                                    val n = local { input.skip(offset - skipped) }
                                    if (n <= 0) throw LocalReadException(LocalFsException("EIO", "File changed during upload. Retry to preserve the latest content.", relative))
                                    skipped += n
                                }
                                var remaining = length
                                val buffer = ByteArray(256 * 1024)
                                while (remaining > 0) {
                                    val read = local { input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt()) }
                                    if (read <= 0) throw LocalReadException(LocalFsException("EIO", "File changed during upload. Retry to preserve the latest content.", relative))
                                    sink.write(buffer, 0, read); remaining -= read
                                }
                            }
                        }
                    }
                    storage.newCall(Request.Builder().url(url).put(body).build()).awaitResponse().use { response ->
                        etag = if (response.isSuccessful) response.header("ETag") else null
                    }
                    if (etag.isNullOrBlank()) throw IOException("Storage upload failed. It will resume automatically.")
                    break
                } catch (e: LocalReadException) { throw e.error }
                catch (e: IOException) { if (attempt == 2) throw e }
            }
            parts += CompletedPart(number, etag!!)
            state.parts = parts.toList(); persist()
            loaded += length
            progress(loaded, info.size)
        }
        val after = tree.stat(relative)
        if (after == null || after.mtime != state.mtime || after.size != state.size) throw LocalFsException("EIO", "File changed while uploading. The next attempt will restart safely.", relative)
        beforeComplete()
        return harborJson.decodeFromJsonElement<ItemResponse>(api.request("$route/complete", "POST", buildJsonObject {
            put("parts", harborJson.encodeToJsonElement(parts.sortedBy { it.partNumber })); put("contentHash", state.hash)
        })).item
    }

    /** Downloads into `name.harbor-part` (resuming a partial one), verifies it, then replaces [destination]. Returns its hash. */
    suspend fun download(tree: LocalTree, input: JsonObject, destination: String, progress: (Long, Long) -> Unit = { _, _ -> },
        beforeReplace: suspend () -> Unit = {}): String {
        val part = "$destination.harbor-part"
        val existing = tree.stat(part)
        var offset = if (existing != null && !existing.folder) existing.size else 0L
        if (existing?.folder == true) throw LocalFsException("EEXIST", "A folder blocks this download.", part)
        val signed = harborJson.decodeFromJsonElement<Download>(api.request("/v1/downloads", "POST", input))
        FileTransfers.validateUrl(signed.downloadUrl, api.baseUrl, allowLocal)
        if (offset > signed.sizeBytes) { tree.delete(part); offset = 0 }
        var digest = MessageDigest.getInstance("SHA-256")
        if (offset > 0) tree.openRead(part).use { stream ->
            val buffer = ByteArray(1024 * 1024)
            while (true) { val n = try { stream.read(buffer) } catch (e: IOException) { throw localError(e, part) }; if (n < 0) break; digest.update(buffer, 0, n) }
        }
        if (offset < signed.sizeBytes || signed.sizeBytes == 0L) {
            val request = Request.Builder().url(signed.downloadUrl).apply { if (offset > 0) header("Range", "bytes=$offset-") }.build()
            storage.newCall(request).awaitResponse().use { response ->
                if (!response.isSuccessful) throw IOException("Download interrupted. It will resume automatically.")
                if (response.code == 206 && response.header("Content-Range") != "bytes $offset-${signed.sizeBytes - 1}/${signed.sizeBytes}")
                    throw IOException("Storage returned an unexpected download range.")
                // Servers that ignore Range send the complete file; start over.
                if (offset > 0 && response.code != 206) { offset = 0; digest = MessageDigest.getInstance("SHA-256"); tree.delete(part) }
                if (offset == 0L && tree.stat(part) == null) tree.createFile(part)
                val body = response.body ?: throw IOException("Download interrupted. It will resume automatically.")
                tree.openWrite(part, append = offset > 0).use { output ->
                    body.byteStream().use { stream ->
                        val buffer = ByteArray(256 * 1024)
                        var loaded = offset
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val n = stream.read(buffer)
                            if (n < 0) break
                            if (loaded + n > signed.sizeBytes) throw IOException("Download exceeded its expected size.")
                            try { output.write(buffer, 0, n) } catch (e: IOException) { throw localError(e, part) }
                            digest.update(buffer, 0, n)
                            loaded += n
                            progress(loaded, signed.sizeBytes)
                        }
                    }
                }
            }
        }
        val written = tree.stat(part)
        if (written?.size != signed.sizeBytes || !digest.digest().joinToString("") { "%02x".format(it) }.equals(signed.contentHash, ignoreCase = true)) {
            runCatching { tree.delete(part) }
            throw LocalFsException("EIO", "Download integrity check failed. The original local file was kept.", destination)
        }
        beforeReplace()
        if (tree.stat(destination) != null) tree.delete(destination)
        tree.rename(part, destination)
        return signed.contentHash.lowercase()
    }
}
