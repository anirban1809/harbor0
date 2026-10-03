import XCTest
@testable import Harbor0

/// The phone sync and backup engine against the real local backend started by test-ios.mjs.
@MainActor
final class SyncIntegrationTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:18988")!

    private func signIn() async throws -> (HarborAPI, KeychainStore) {
        let marker = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let email = "sync-\(marker)@example.test"
        let password = "Development-only-123!"
        func post(_ path: String, _ body: [String: String]) async throws {
            var request = URLRequest(url: base.appendingPathComponent(path))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertTrue((200..<300).contains((response as! HTTPURLResponse).statusCode), String(decoding: data, as: UTF8.self))
        }
        try await post("v1/auth/signup", ["email": email, "password": password, "username": "sync_" + marker.prefix(20), "displayName": "Sync integration"])
        try await post("v1/auth/confirm", ["email": email, "code": "123456"])
        let keychain = KeychainStore(service: "app.harbor0.sync-integration." + marker)
        let api = HarborAPI(baseURL: base, credentials: keychain)
        try await api.login(email: email, password: password, deviceName: "iPhone")
        return (api, keychain)
    }
    private func write(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }
    private func children(_ api: HarborAPI, _ parent: String) async throws -> [DriveItem] {
        try await api.list(parentID: parent).items
    }
    private func eventually(_ engine: SyncEngine, _ what: String, seconds: Double = 40, _ check: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            await engine.drain(until: Date().addingTimeInterval(8))
            if try await check() { return }
        }
        let state = await engine.state
        XCTFail("Timed out waiting for \(what). Engine: \(state.message); issues: \(state.issues.map(\.message))")
    }

    func testTwoWaySyncDeletesAndDeliveryReceipts() async throws {
        let (api, keychain) = try await signIn()
        defer { try? keychain.clear() }
        let folder = try await api.createFolder(name: "Phone sync", parentID: nil)
        // Another device puts a file in the folder first.
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: scratch) }
        try write("from the cloud", to: scratch.appendingPathComponent("remote.txt"))
        try await FileTransfers(api: api).upload(scratch.appendingPathComponent("remote.txt"), parentID: folder.id) { _, _ in }

        let device = try await api.registerSyncDevice()
        let journal = try SyncJournal(url: scratch.appendingPathComponent("journal.sqlite"))
        journal.set("deviceName", device.name)
        let engine = SyncEngine(api: api, journal: journal, deviceId: device.id) { _ in }
        let local = "SyncTest-" + UUID().uuidString.prefix(8)
        let directory = SyncEngine.documents.appendingPathComponent(local)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        await engine.start(foreground: false)
        try await engine.addRoot(SyncRoot(id: UUID().uuidString, place: LocalPlace(documents: local), name: local, remoteId: folder.id, mode: .sync, cloudPath: "My Drive / Phone sync"))

        // Cloud → phone.
        try await eventually(engine, "the cloud file to download") {
            (try? String(contentsOf: directory.appendingPathComponent("remote.txt"), encoding: .utf8)) == "from the cloud"
        }
        // Phone → cloud, including a new subfolder.
        try write("from the phone", to: directory.appendingPathComponent("Notes/local.txt"))
        var uploaded: DriveItem?
        try await eventually(engine, "the phone file to upload") {
            guard let notes = try await children(api, folder.id).first(where: { $0.name == "Notes" }) else { return false }
            uploaded = try await children(api, notes.id).first { $0.name == "local.txt" }
            return uploaded != nil
        }
        let copy = try await FileTransfers(api: api).download(uploaded!) { _, _ in }
        defer { FileTransfers.removePreview(copy) }
        XCTAssertEqual(try String(contentsOf: copy, encoding: .utf8), "from the phone")

        // This phone is now a sync participant and confirms its copy.
        struct Status: Decodable { let itemId: String; let requiredDevices: Int; let confirmedDevices: Int }
        try await eventually(engine, "the delivery receipt") {
            let page: Page<Status> = try await api.request("/v1/sync/status?recursive=false&ids=\(uploaded!.id)")
            return page.items.first.map { $0.requiredDevices == 1 && $0.confirmedDevices == 1 } ?? false
        }

        // Concurrent edits: the cloud edit keeps the name; the phone's edit is kept beside it and uploaded.
        let listed = try await children(api, folder.id)
        let remoteItem = try XCTUnwrap(listed.first { $0.name == "remote.txt" })
        try write("cloud edit", to: scratch.appendingPathComponent("edit/remote.txt"))
        var state = UploadState(operationId: UUID().uuidString.lowercased())
        _ = try await SyncTransfers.upload(api: api, file: scratch.appendingPathComponent("edit/remote.txt"), name: "remote.txt",
                                           parentId: folder.id, state: &state, persist: { _ in },
                                           existing: (remoteItem.id, remoteItem.revision ?? 1))
        try write("phone edit", to: directory.appendingPathComponent("remote.txt"))
        try await eventually(engine, "the conflict to resolve") {
            let names = try LocalFS.children(directory)
            guard let kept = names.first(where: { $0.hasPrefix("remote (Conflict - iPhone - ") }) else { return false }
            let cloud = try await children(api, folder.id).map(\.name)
            return (try? String(contentsOf: directory.appendingPathComponent("remote.txt"), encoding: .utf8)) == "cloud edit"
                && (try? String(contentsOf: directory.appendingPathComponent(kept), encoding: .utf8)) == "phone edit"
                && cloud.contains(kept)
        }
        let conflicts = await engine.state.issues.filter { $0.code == "CONFLICT" }
        XCTAssertEqual(conflicts.count, 1)

        // A deletion elsewhere removes the local copy; a local deletion trashes the cloud file.
        let fresh: ItemResponse = try await api.request("/v1/drive/items/\(uploaded!.id)")
        try await api.changeTrash(fresh.item, action: .trash)
        try await eventually(engine, "the remote deletion to apply") {
            !FileManager.default.fileExists(atPath: directory.appendingPathComponent("Notes/local.txt").path)
        }
        try FileManager.default.removeItem(at: directory.appendingPathComponent("remote.txt"))
        try await eventually(engine, "the local deletion to upload") {
            try await !children(api, folder.id).contains { $0.name == "remote.txt" }
        }
        let issues = await engine.state.issues.filter { !$0.sticky }
        XCTAssertTrue(issues.isEmpty, "\(issues)")
        await engine.stop()
    }

    func testBackupRunArchiveRestoreAndRequestedRestore() async throws {
        let (api, keychain) = try await signIn()
        defer { try? keychain.clear() }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let device = try await api.registerSyncDevice()
        let journal = try SyncJournal(url: scratch.appendingPathComponent("journal.sqlite"))
        let engine = SyncEngine(api: api, journal: journal, deviceId: device.id) { _ in }
        let local = "BackupTest-" + UUID().uuidString.prefix(8)
        let directory = SyncEngine.documents.appendingPathComponent(local)
        try write("version one", to: directory.appendingPathComponent("Docs/notes.txt"))
        defer { try? FileManager.default.removeItem(at: directory) }

        struct Created: Decodable { let root: BackupRoot }
        let created: Created = try await api.request("/v1/backups", method: "POST", body: [
            "operationId": UUID().uuidString.lowercased(), "deviceId": device.id, "name": local,
        ])
        let root = SyncRoot(id: UUID().uuidString, place: LocalPlace(documents: local), name: local,
                            remoteId: created.root.remoteRootDriveItemId, mode: .backup, backupId: created.root.id)
        await engine.start(foreground: false)
        try await engine.addRoot(root)

        // Back up now saves every file without waiting for the quiet hour.
        try await engine.backupNow(root.id)
        var runs: [BackupRun] = []
        try await eventually(engine, "the manual backup run") {
            let page: Page<BackupRun> = try await api.request("/v1/backups/\(created.root.id)/runs")
            runs = page.items
            return runs.contains { $0.state == "COMPLETED" && $0.fileCount == 1 }
        }
        XCTAssertEqual(runs.first?.trigger, "MANUAL")
        let top = try await children(api, created.root.remoteRootDriveItemId)
        let docs = try XCTUnwrap(top.first { $0.name == "Docs" })
        let inside = try await children(api, docs.id)
        let saved = try XCTUnwrap(inside.first { $0.name == "notes.txt" })

        // A restore requested from another device replaces the local file with the saved version.
        try write("edited on the phone", to: directory.appendingPathComponent("Docs/notes.txt"))
        let _: EmptyResponse = try await api.request("/v1/backups/\(created.root.id)/restores", method: "POST", body: [
            "id": UUID().uuidString.lowercased(), "itemId": saved.id, "versionId": saved.currentVersionId ?? "",
        ])
        try await eventually(engine, "the requested restore") {
            (try? String(contentsOf: directory.appendingPathComponent("Docs/notes.txt"), encoding: .utf8)) == "version one"
        }

        // Archive: a final backup, then the verified local files are removed.
        try await engine.archiveBackup(root.id, archived: true)
        try await eventually(engine, "the archive", seconds: 60) {
            journal.root(root.id)?.archive == .archived
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("Docs/notes.txt").path))
        let archived: Created = try await api.request("/v1/backups/\(created.root.id)")
        XCTAssertEqual(archived.root.state, "ARCHIVED")

        // Restore folder brings the saved files back and resumes backing up.
        try await engine.archiveBackup(root.id, archived: false)
        try await eventually(engine, "the folder to be restored", seconds: 60) {
            journal.root(root.id)?.archive == nil
                && (try? String(contentsOf: directory.appendingPathComponent("Docs/notes.txt"), encoding: .utf8)) == "version one"
        }
        let resumed: Created = try await api.request("/v1/backups/\(created.root.id)")
        XCTAssertNotEqual(resumed.root.state, "ARCHIVED")
        let issues = await engine.state.issues
        XCTAssertTrue(issues.isEmpty, "\(issues)")
        await engine.stop()
    }

    func testPathRulesMatchDesktop() throws {
        XCTAssertEqual(try SyncPaths.safeSegment("Report.pdf", id: "abcdef123"), "Report.pdf")
        XCTAssertEqual(try SyncPaths.safeSegment("a:b?.txt", id: "abcdef123"), "a_b_.txt~abcdef12")
        XCTAssertThrowsError(try SyncPaths.safeSegment("..", id: "x"))
        XCTAssertTrue(SyncPaths.internalPath("a/.DS_Store"))
        XCTAssertTrue(SyncPaths.internalPath("a/file.txt.harbor-part"))
        XCTAssertTrue(SyncPaths.internalPath("Photos (Recovered by harbor0 2026-10-01 10.00.00)/x.jpg"))
        XCTAssertFalse(SyncPaths.internalPath("a/.config"))
        XCTAssertEqual(SyncPaths.conflictName("Report.docx", device: "iPhone", operationID: "1234567890"), "Report (Conflict - iPhone - 12345678).docx")
        XCTAssertThrowsError(try SyncPaths.contained(URL(fileURLWithPath: "/tmp/root"), "../escape"))
        XCTAssertTrue(FolderBackups.ready(mtime: 0, observedAt: 0, now: FolderBackups.quietMs))
        XCTAssertFalse(FolderBackups.ready(mtime: 10, observedAt: 0, now: FolderBackups.quietMs))
    }
}
