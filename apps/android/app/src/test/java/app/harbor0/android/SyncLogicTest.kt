package app.harbor0.android

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.time.LocalDateTime

/** A [LocalTree] over a plain directory, standing in for a document tree in JVM tests. */
class FileTree(private val base: File): LocalTree {
    override val name: String get() = base.name
    private fun file(relative: String) = if (relative.isEmpty()) base else File(base, relative)
    override fun check() { if (!base.isDirectory) throw LocalFsException("ENOENT", "The local folder is unavailable.") }
    override fun list(relative: String) = (file(relative).listFiles() ?: throw LocalFsException("ENOENT", "Missing", relative)).map {
        LocalEntry(it.name, it.path, it.isDirectory, if (it.isDirectory) 0 else it.length(), it.lastModified())
    }
    override fun stat(relative: String) = file(relative).takeIf { it.exists() }?.let { LocalEntry(it.name, it.path, it.isDirectory, it.length(), it.lastModified()) }
    override fun ensureParents(relative: String, create: Boolean) {
        val parent = file(relative).parentFile
        if (parent.isFile) throw LocalFsException("ENOTDIR", "A file blocks this destination.", relative)
        if (!parent.exists()) { if (create) parent.mkdirs() else throw LocalFsException("ENOENT", "Missing", relative) }
    }
    override fun mkdirs(relative: String) { file(relative).mkdirs() }
    override fun openRead(relative: String): InputStream = try { file(relative).inputStream() } catch (e: FileNotFoundException) { throw localError(e, relative) }
    override fun createFile(relative: String) { if (!file(relative).createNewFile()) throw LocalFsException("EEXIST", "Exists", relative) }
    override fun openWrite(relative: String, append: Boolean): OutputStream = java.io.FileOutputStream(file(relative), append)
    override fun rename(from: String, to: String) {
        if (file(to).exists()) throw LocalFsException("EEXIST", "Exists", to)
        if (!file(from).renameTo(file(to))) throw LocalFsException("ENOENT", "Missing", from)
    }
    override fun delete(relative: String) { file(relative).deleteRecursively() }
}

private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

class SyncLogicTest {
    @Test fun safeSegmentKeepsOrdinaryNamesAndRewritesUnsafeOnes() {
        assertEquals("Report.pdf", safeSegment("Report.pdf", "1234567890"))
        assertEquals("a_b~12345678", safeSegment("a:b", "1234567890"))
        assertEquals("CON~abcdefgh", safeSegment("CON", "abcdefghij"))
        assertEquals("notes~abcdefgh", safeSegment("notes. ", "abcdefghij"))
        assertEquals("___~abcdefgh", safeSegment("???", "abcdefghij"))
        assertEquals("file~abcdefgh", safeSegment("...", "abcdefghij"))
        assertThrows(IllegalArgumentException::class.java) { safeSegment("..", "x") }
        assertThrows(IllegalArgumentException::class.java) { safeSegment("a/b", "x") }
        assertThrows(IllegalArgumentException::class.java) { safeSegment("", "x") }
    }
    @Test fun internalPathsAreNeverSynced() {
        assertTrue(internalPath("a/.harbor-state"))
        assertTrue(internalPath("photo.jpg.harbor-part"))
        assertTrue(internalPath("docs/.DS_Store"))
        assertTrue(internalPath("._resource"))
        assertTrue(internalPath("Thumbs.db"))
        assertTrue(internalPath("DCIM/.trashed-1700000000-IMG_1.jpg"))
        assertTrue(internalPath(recoveredName("Old", LocalDateTime.of(2026, 10, 1, 9, 5, 7)) + "/a.txt"))
        assertFalse(internalPath("docs/report.pdf"))
        assertFalse(internalPath(".profile"))
        assertEquals("Old (Recovered by harbor0 2026-10-01 09.05.07)", recoveredName("Old", LocalDateTime.of(2026, 10, 1, 9, 5, 7)))
    }
    @Test fun excludedPathsMatchWholeSegments() {
        assertTrue(ignoredPath(listOf("Photos/Old"), "Photos/Old"))
        assertTrue(ignoredPath(listOf("Photos/Old"), "Photos/Old/a.jpg"))
        assertFalse(ignoredPath(listOf("Photos/Old"), "Photos/Older/a.jpg"))
        assertTrue(validRelative("a/b.txt")); assertFalse(validRelative("../a")); assertFalse(validRelative("/a")); assertFalse(validRelative("a//b"))
    }
    @Test fun conflictNamesKeepTheExtensionAndLabelTheDevice() {
        assertEquals("notes (Conflict - Pixel 9 - 12345678).txt", conflictName("notes.txt", "Pixel 9", "1234567890ab"))
        assertEquals("Makefile (Conflict - mac_book - abcdefgh)", conflictName("Makefile", "mac/book.local", "abcdefghijk"))
        assertEquals(".env (Conflict - another device - abcdefgh)", conflictName(".env", "", "abcdefghijk"))
    }
    @Test fun snapshotDiffQueuesAddsEditsAndDeletesInOrder() {
        val before = mapOf("a" to LocalStat(true, 0, 0), "a/old.txt" to LocalStat(false, 3, 100), "a/same.txt" to LocalStat(false, 5, 100),
            "a/edit.txt" to LocalStat(false, 5, 100), "gone" to LocalStat(true, 0, 0), "gone/x.txt" to LocalStat(false, 1, 1))
        val after = mapOf("a" to LocalStat(true, 0, 0), "a/same.txt" to LocalStat(false, 5, 100), "a/edit.txt" to LocalStat(false, 6, 200),
            "b" to LocalStat(true, 0, 0), "b/new.txt" to LocalStat(false, 1, 1))
        val changes = diffSnapshot(before, after)
        assertEquals(listOf("b" to "upsert", "a/edit.txt" to "upsert", "b/new.txt" to "upsert", "a/old.txt" to "delete", "gone/x.txt" to "delete", "gone" to "delete"),
            changes.map { it.relativePath to it.kind })
        assertTrue(changes.first { it.relativePath == "a/edit.txt" }.changed)
        assertFalse(changes.first { it.relativePath == "b/new.txt" }.changed)
        assertTrue(diffSnapshot(after, after).isEmpty())
    }
    @Test fun backupsWaitForAnHourOfQuiet() {
        val now = 10 * BACKUP_QUIET_MS
        assertTrue(backupReady(now - BACKUP_QUIET_MS, 0, now))
        assertFalse(backupReady(now - BACKUP_QUIET_MS + 1, 0, now))
        assertFalse(backupReady(0, now - 1000, now))
        assertEquals(4000L, retryDelay(1)); assertEquals(300_000L, retryDelay(20))
    }
    @Test fun folderStatesFollowDesktopPriorities() {
        val root = SyncRoot("r", "content://tree", "Docs", "remote", "sync")
        val idle = SyncRuntime()
        assertEquals("Up to date", folderState(root, idle, emptyList()))
        assertEquals("Syncing", folderState(root.copy(needsReconcile = true), idle, emptyList()))
        assertEquals("Syncing", folderState(root, idle, listOf(SyncJobView("j", "r", "a", "upsert", null, 0))))
        assertEquals("Action required", folderState(root, idle, listOf(SyncJobView("j", "r", "a", "upsert", "Failed", 1))))
        assertEquals("Paused", folderState(root.copy(paused = true), idle, emptyList()))
        assertEquals("Offline", folderState(root, idle.copy(online = false), emptyList()))
        assertEquals(WAITING, folderState(root, idle.copy(waiting = listOf(WaitingItem("r", "a"))), emptyList()))
        val missing = SyncIssue("i", "r", IssueCode.FOLDER_MISSING, "Missing")
        assertEquals("Folder unavailable", folderState(root, idle.copy(issues = listOf(missing)), emptyList()))
        assertEquals("Conflict", folderState(root, idle.copy(issues = listOf(missing.copy(code = IssueCode.CONFLICT))), emptyList()))
        // A kept folder is informational only.
        assertEquals("Up to date", folderState(root, idle.copy(issues = listOf(missing.copy(code = IssueCode.FOLDER_RECOVERED))), emptyList()))
        assertEquals("Action required", globalSyncState(listOf(root), idle.copy(issues = listOf(missing), paused = true), emptyList()))
        assertEquals("Paused", globalSyncState(listOf(root), idle.copy(paused = true), emptyList()))
        assertEquals("Up to date", globalSyncState(listOf(root.copy(paused = true, needsReconcile = true)), idle, emptyList()))
    }
    @Test fun requirementsIncludeFailedFilesUnlessTheFolderHasAProblem() {
        val root = SyncRoot("r", "content://tree", "Docs", "remote", "sync")
        val job = SyncJobView("j", "r", "a.txt", "upsert", "Disk error", 2)
        assertEquals(listOf("j"), syncRequirements(listOf(root), SyncRuntime(), listOf(job)).map { it.id })
        val folder = SyncIssue("f", "r", IssueCode.PERMISSION_DENIED, "No access")
        assertEquals(listOf("f"), syncRequirements(listOf(root), SyncRuntime(issues = listOf(folder)), listOf(job)).map { it.id })
        assertTrue(syncRequirements(listOf(root), SyncRuntime(online = false), listOf(job)).isEmpty())
    }
    @Test fun issueCodesSeparateFolderAndItemProblems() {
        assertEquals(IssueCode.FOLDER_MISSING, syncIssueCode(LocalFsException("ENOENT", "x")))
        assertEquals(IssueCode.SYNC_ERROR, syncIssueCode(LocalFsException("ENOENT", "x", "a.txt"), item = true))
        assertEquals(IssueCode.PERMISSION_DENIED, syncIssueCode(LocalFsException("EACCES", "x")))
        assertEquals(IssueCode.DISK_FULL, syncIssueCode(LocalFsException("ENOSPC", "x")))
        assertEquals(IssueCode.STORAGE_QUOTA_EXCEEDED, syncIssueCode(ApiException(409, "Full", "STORAGE_QUOTA_EXCEEDED")))
        assertEquals(IssueCode.AUTH_INVALID, syncIssueCode(ApiException(403, "Revoked", "DEVICE_REVOKED")))
    }
    @Test fun numberedFolderOperationsAreStableUuids() {
        val first = numberedOperationId("op", 2)
        assertEquals(first, numberedOperationId("op", 2))
        assertNotEquals(first, numberedOperationId("op", 3))
        assertTrue(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$").matches(first))
    }
    @Test fun scanSkipsInternalAndExcludedEntries() {
        val dir = Files.createTempDirectory("scan").toFile()
        try {
            File(dir, "a/b").mkdirs(); File(dir, "a/b/c.txt").writeText("c"); File(dir, "a/.DS_Store").writeText("x")
            File(dir, "skip").mkdirs(); File(dir, "skip/d.txt").writeText("d"); File(dir, "e.txt.harbor-part").writeText("p")
            val scanned = scanTree(FileTree(dir), listOf("skip"))!!
            assertEquals(setOf("a", "a/b", "a/b/c.txt"), scanned.keys)
            assertTrue(scanned["a"]!!.folder); assertEquals(1L, scanned["a/b/c.txt"]!!.size)
        } finally { dir.deleteRecursively() }
    }
}

class SyncTransfersTest {
    private fun json(text: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(text)
    private suspend fun signedIn(server: MockWebServer): HarborApi {
        val api = HarborApi(server.url("/").toString(), MemoryCredentials())
        server.enqueue(json("""{"accessToken":"a","refreshToken":"r","expiresIn":3600}"""))
        api.login("a@b.test", "secret", "Test"); server.takeRequest()
        return api
    }
    @Test fun downloadResumesAPartFileVerifiesItAndReplacesTheDestination() = runBlocking {
        val server = MockWebServer(); server.start()
        val dir = Files.createTempDirectory("download").toFile()
        try {
            val api = signedIn(server)
            val content = "hello harbor0".toByteArray()
            File(dir, "a.txt").writeText("old")
            File(dir, "a.txt.harbor-part").writeBytes(content.copyOfRange(0, 5))
            server.enqueue(json("""{"downloadUrl":"${server.url("/blob")}","sizeBytes":${content.size},"contentHash":"${sha(content)}"}"""))
            server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 5-${content.size - 1}/${content.size}").setBody(Buffer().write(content.copyOfRange(5, content.size))))
            var preserved = false
            val hash = SyncTransfers(api, allowLocal = true).download(FileTree(dir), buildJsonObject { put("driveItemId", "item") }, "a.txt") { preserved = true }
            assertEquals(sha(content), hash); assertTrue(preserved)
            assertArrayEquals(content, File(dir, "a.txt").readBytes())
            assertFalse(File(dir, "a.txt.harbor-part").exists())
            server.takeRequest()
            assertEquals("bytes=5-", server.takeRequest().getHeader("Range"))
        } finally { server.shutdown(); dir.deleteRecursively() }
    }
    @Test fun corruptDownloadKeepsTheOriginalFile() = runBlocking {
        val server = MockWebServer(); server.start()
        val dir = Files.createTempDirectory("download").toFile()
        try {
            val api = signedIn(server)
            File(dir, "a.txt").writeText("keep me")
            server.enqueue(json("""{"downloadUrl":"${server.url("/blob")}","sizeBytes":3,"contentHash":"${sha("abc".toByteArray())}"}"""))
            server.enqueue(MockResponse().setBody("xyz"))
            val error = runCatching { SyncTransfers(api, allowLocal = true).download(FileTree(dir), buildJsonObject { put("driveItemId", "item") }, "a.txt") }.exceptionOrNull()
            assertTrue(error is LocalFsException)
            assertEquals("keep me", File(dir, "a.txt").readText())
            assertFalse(File(dir, "a.txt.harbor-part").exists())
        } finally { server.shutdown(); dir.deleteRecursively() }
    }
    @Test fun uploadResumesOnlyMissingPartsFromSavedState() = runBlocking {
        val server = MockWebServer(); server.start()
        val dir = Files.createTempDirectory("upload").toFile()
        try {
            val api = signedIn(server)
            val file = File(dir, "big.bin").apply { writeBytes(ByteArray(10) { it.toByte() }) }
            val tree = FileTree(dir)
            val state = UploadState("op", uploadId = "up-1", partSize = 4, hash = sha(file.readBytes()), size = 10, mtime = file.lastModified(),
                parts = listOf(CompletedPart(1, "e1")))
            server.enqueue(json("""{"upload":{"id":"up-1","state":"UPLOADING","partSizeBytes":4},"parts":[{"partNumber":1,"etag":"e1"}]}"""))
            for (n in 2..3) {
                server.enqueue(json("""{"parts":[{"partNumber":$n,"uploadUrl":"${server.url("/part$n")}"}]}"""))
                server.enqueue(MockResponse().setHeader("ETag", "e$n"))
            }
            server.enqueue(json("""{"item":{"id":"item","name":"big.bin","type":"FILE","revision":1,"currentVersionId":"v1"}}"""))
            var saves = 0
            val item = SyncTransfers(api, allowLocal = true).upload(tree, "big.bin", "big.bin", "parent", state, { saves++ })
            assertEquals("item", item.id)
            assertEquals("/v1/uploads/up-1", server.takeRequest().path)
            assertEquals("/v1/uploads/up-1/parts", server.takeRequest().path)
            assertEquals(4L, server.takeRequest().bodySize)
            server.takeRequest()
            assertEquals(2L, server.takeRequest().bodySize)
            val complete = harborJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            assertEquals(listOf(1, 2, 3), complete["parts"]!!.jsonArray.map { it.jsonObject["partNumber"]!!.jsonPrimitive.int })
            assertEquals(listOf(1, 2, 3), state.parts!!.map { it.partNumber }.sorted())
            assertTrue(saves >= 2)
        } finally { server.shutdown(); dir.deleteRecursively() }
    }
}
