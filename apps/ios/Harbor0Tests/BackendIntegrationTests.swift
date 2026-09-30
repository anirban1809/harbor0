import XCTest
@testable import Harbor0

@MainActor
final class BackendIntegrationTests: XCTestCase {
    func testRealBackendFolderUploadDownloadAndRevocation() async throws {
        // Started by test-ios.mjs with an isolated local DynamoDB table and MinIO bucket.
        let base = URL(string: "http://127.0.0.1:18988")!
        let marker = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let email = "ios-\(marker)@example.test"
        let password = "Development-only-123!"
        func post(_ path: String, _ body: [String: String]) async throws {
            var request = URLRequest(url: base.appendingPathComponent(path))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertTrue((200..<300).contains((response as! HTTPURLResponse).statusCode), String(decoding: data, as: UTF8.self))
        }
        try await post("v1/auth/signup", ["email": email, "password": password, "username": "ios_" + marker.prefix(20), "displayName": "iOS integration"])
        try await post("v1/auth/confirm", ["email": email, "code": "123456"])
        let keychain = KeychainStore(service: "app.harbor0.integration." + marker)
        defer { try? keychain.clear() }
        let api = HarborAPI(baseURL: base, credentials: keychain)
        try await api.login(email: email, password: password, deviceName: "iPhone simulator")
        let account: Account = try await api.request("/v1/users/me")
        XCTAssertEqual(account.user.email, email)
        try await api.createFolder(name: "iPhone uploads", parentID: nil)
        let root = try await api.list(parentID: nil)
        let folder = try XCTUnwrap(root.items.first { $0.name == "iPhone uploads" })
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(marker)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        // Crosses Harbor0's 64 MiB multipart boundary without keeping the file in memory.
        let source = directory.appendingPathComponent("iPhone-roundtrip.bin")
        FileManager.default.createFile(atPath: source.path, contents: nil)
        let handle = try FileHandle(forWritingTo: source)
        for _ in 0..<65 { try handle.write(contentsOf: Data(repeating: 0x41, count: 1024 * 1024)) }
        try handle.close()
        let transfers = FileTransfers(api: api)
        try await transfers.upload(source, parentID: folder.id) { _, _ in }
        let listing = try await api.list(parentID: folder.id)
        let item = try XCTUnwrap(listing.items.first)
        XCTAssertEqual(item.sizeBytes, 65 * 1024 * 1024)
        let downloaded = try await transfers.download(item) { _, _ in }
        defer { FileTransfers.removePreview(downloaded) }
        XCTAssertEqual(try FileTransfers.digest(downloaded).hash, try FileTransfers.digest(source).hash)
        let appearance = AppearanceStore()
        await appearance.load(api)
        appearance.appearance.preset = "forest"
        appearance.appearance.preference = "dark"
        appearance.appearance.palettes.dark["sidebar"] = "#123456"
        await appearance.save(api)
        XCTAssertNil(appearance.error)
        XCTAssertFalse(appearance.dirty)
        let saved: Account = try await api.request("/v1/users/me")
        XCTAssertEqual(saved.user.appearance, appearance.appearance)
        let catalog = WorkspaceCatalog()
        await catalog.load(api)
        XCTAssertTrue(catalog.ready)
        XCTAssertNil(catalog.syncError)
        XCTAssertNil(catalog.backupError)
        try await api.changeTrash(item, action: .trash)
        let trashed = try await api.trashPage()
        let deleted = try XCTUnwrap(trashed.items.first { $0.id == item.id })
        XCTAssertNotNil(deleted.deletedAt)
        try await api.changeTrash(deleted, action: .restore)
        let afterRestore = try await api.list(parentID: folder.id)
        let restoredItem = try XCTUnwrap(afterRestore.items.first { $0.id == item.id })
        XCTAssertNil(restoredItem.deletedAt)
        try await api.changeTrash(restoredItem, action: .trash)
        try await api.emptyTrash()
        let empty = try await api.trashPage()
        XCTAssertTrue(empty.items.isEmpty)
        let restored = HarborAPI(baseURL: base, credentials: keychain)
        await restored.restore()
        XCTAssertTrue(restored.signedIn)
        try await restored.logout()
        XCTAssertNil(try keychain.load())
        do { let _: Account = try await api.request("/v1/users/me"); XCTFail("Revoked session remained usable") }
        catch { XCTAssertFalse(api.signedIn) }
    }
}
