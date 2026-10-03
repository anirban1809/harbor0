import XCTest
import CryptoKit
@testable import Harbor0

private final class MemoryCredentials: CredentialStore {
    var value: SavedSession?
    var shouldFail = false
    func load() throws -> SavedSession? { value }
    func save(_ session: SavedSession) throws {
        if shouldFail { throw APIError(status: 0, message: "Keychain unavailable") }
        value = session
    }
    func clear() throws { value = nil }
}

private final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor
final class Harbor0Tests: XCTestCase {
    private let tokens = "{\"accessToken\":\"access\",\"refreshToken\":\"refresh\",\"expiresIn\":3600}"
    private func client(_ store: MemoryCredentials = MemoryCredentials()) -> HarborAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return HarborAPI(baseURL: URL(string: "https://test.harbor.invalid")!, session: URLSession(configuration: config), credentials: store)
    }
    private func json(_ value: String) -> Data { Data(value.utf8) }

    func testAppearanceRefreshPreservesDraftAndFailedSaveCanRetry() async throws {
        let api = client()
        let response = json(tokens)
        var failSave = true
        let account = Data(#"{"user":{"id":"test","email":"a@b.com","displayName":"Test","appearance":{"preference":"system","preset":"forest","palettes":{"light":{},"dark":{}}}},"storage":{"quotaBytes":100,"usedBytes":1,"reservedBytes":0}}"#.utf8)
        StubProtocol.handler = { request in
            if request.url!.path.contains("auth") { return (200, response) }
            if request.httpMethod == "PATCH" && failSave { return (503, Data(#"{"error":{"message":"Temporarily unavailable"}}"#.utf8)) }
            return (200, account)
        }
        try await api.login(email: "a@b.com", password: "secret", deviceName: "iPhone")
        let store = AppearanceStore()
        await store.load(api)
        XCTAssertEqual(store.appearance.preset, "forest")
        store.appearance.preset = "ocean"
        await store.load(api)
        XCTAssertEqual(store.appearance.preset, "ocean")
        await store.save(api)
        XCTAssertNotNil(store.error)
        XCTAssertTrue(store.dirty)
        XCTAssertEqual(store.saved.preset, "forest")
        failSave = false
        await store.save(api)
        XCTAssertNil(store.error)
        XCTAssertFalse(store.dirty)
        XCTAssertEqual(store.saved.preset, "ocean")
        store.reset()
        XCTAssertNil(store.account)
        XCTAssertEqual(store.appearance, Appearance())
    }

    func testAppearanceUsesSystemModeAndValidCustomOverrides() {
        var value = Appearance()
        value.preset = "ocean"
        XCTAssertEqual(value.palette(for: .dark).values["background"], "#0b1220")
        value.preference = "light"
        value.palettes.light = ["sidebar": "#123456", "card": "invalid"]
        let result = value.palette(for: .dark)
        XCTAssertEqual(result.values["background"], "#eff6ff")
        XCTAssertEqual(result.values["sidebar"], "#123456")
        XCTAssertEqual(result.values["card"], "#ffffff")
        XCTAssertFalse(HarborPalette.useBlackInk("#123456"))
        XCTAssertTrue(HarborPalette.useBlackInk("#ffffff"))
    }

    func testLoginRegistersIOSAndStoresCredential() async throws {
        let store = MemoryCredentials()
        let api = client(store)
        let response = json(tokens)
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/auth/login")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let stream = request.httpBodyStream!
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = stream.read(&bytes, maxLength: bytes.count)
            let body = try JSONSerialization.jsonObject(with: Data(bytes.prefix(count))) as! [String: Any]
            XCTAssertEqual(body["platform"] as? String, "IOS")
            XCTAssertEqual(body["email"] as? String, "hello@example.com")
            return (200, response)
        }
        try await api.login(email: " Hello@Example.com ", password: "secret", deviceName: "iPhone")
        XCTAssertTrue(api.signedIn)
        XCTAssertEqual(store.value?.tokens.refreshToken, "refresh")
    }

    func testLoginProvesDeviceKeyWithSignedChallenge() async throws {
        struct MemoryKeys: DeviceKeyStore {
            let key = P256.Signing.PrivateKey()
            func key(for account: String) throws -> DeviceKey { DeviceKey(key) }
        }
        let keys = MemoryKeys()
        let store = MemoryCredentials()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let api = HarborAPI(baseURL: URL(string: "https://test.harbor.invalid")!, session: URLSession(configuration: config), credentials: store, deviceKeys: keys)
        let response = json(tokens)
        var calls: [String] = []
        var registration: [String: Any] = [:]
        StubProtocol.handler = { request in
            calls.append(request.url!.path)
            switch request.url!.path {
            case "/v1/auth/session/challenge":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access")
                return (200, Data(#"{"challenge":"nonce","userId":"user-1","expiresAt":"2030-01-01T00:00:00Z"}"#.utf8))
            case "/v1/auth/session":
                let stream = request.httpBodyStream!
                stream.open(); defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 4096)
                let count = stream.read(&bytes, maxLength: bytes.count)
                registration = try JSONSerialization.jsonObject(with: Data(bytes.prefix(count))) as! [String: Any]
                return (200, Data("{}".utf8))
            default: return (200, response)
            }
        }
        try await api.login(email: "a@b.com", password: "secret", deviceName: "iPhone")
        XCTAssertEqual(calls, ["/v1/auth/login", "/v1/auth/session/challenge", "/v1/auth/session"])
        XCTAssertEqual(store.value?.deviceProven, true)
        let fingerprint = DeviceKey(keys.key).fingerprint
        XCTAssertEqual(registration["devicePublicId"] as? String, fingerprint)
        XCTAssertEqual(registration["platform"] as? String, "IOS")
        let proof = registration["proof"] as! [String: String]
        func decode(_ value: String) -> Data {
            var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            while text.count % 4 != 0 { text += "=" }
            return Data(base64Encoded: text)!
        }
        let publicKey = try P256.Signing.PublicKey(derRepresentation: decode(proof["publicKey"]!))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: decode(proof["signature"]!))
        let message = Data("harbor0-device-v1\nnonce\nuser-1\n\(fingerprint)".utf8)
        XCTAssertTrue(publicKey.isValidSignature(signature, for: message))
    }

    func testKeychainFailureDoesNotEnterApp() async throws {
        let store = MemoryCredentials(); store.shouldFail = true
        let api = client(store)
        let response = json(tokens)
        StubProtocol.handler = { _ in (200, response) }
        do { try await api.login(email: "a@b.com", password: "secret", deviceName: "iPhone"); XCTFail("Must fail") }
        catch { XCTAssertFalse(api.signedIn) }
    }

    func testUnauthorizedRequestRotatesTokenAndRetriesOnce() async throws {
        let api = client()
        var calls: [String] = []
        let response = json(tokens)
        StubProtocol.handler = { request in
            let path = request.url!.path
            calls.append(path)
            if path.contains("auth") { return (200, response) }
            if calls.filter({ $0 == path }).count == 1 { return (401, Data("{\"error\":{\"message\":\"Expired\"}}".utf8)) }
            return (200, Data("{\"items\":[],\"nextCursor\":null}".utf8))
        }
        try await api.login(email: "a@b.com", password: "secret", deviceName: "iPhone")
        let result = try await api.list(parentID: nil)
        XCTAssertTrue(result.items.isEmpty)
        XCTAssertEqual(calls, ["/v1/auth/login", "/v1/drive/folders/root/children", "/v1/auth/refresh", "/v1/drive/folders/root/children"])
    }

    func testRevokedSessionClearsKeychain() async throws {
        let store = MemoryCredentials()
        store.value = SavedSession(tokens: Tokens(accessToken: "a", refreshToken: "r", expiresIn: 0), expiresAt: .distantPast)
        let api = client(store)
        StubProtocol.handler = { _ in (401, Data("{\"error\":{\"message\":\"Revoked\"}}".utf8)) }
        await api.restore()
        XCTAssertFalse(api.signedIn)
        XCTAssertNil(store.value)
    }

    func testLogoutUsesTheRotatedRefreshToken() async throws {
        let store = MemoryCredentials()
        let api = client(store)
        StubProtocol.handler = { request in
            switch request.url!.path {
            case "/v1/auth/login":
                return (200, Data("{\"accessToken\":\"old-access\",\"refreshToken\":\"old-refresh\",\"expiresIn\":0}".utf8))
            case "/v1/auth/refresh":
                return (200, Data("{\"accessToken\":\"new-access\",\"refreshToken\":\"new-refresh\",\"expiresIn\":3600}".utf8))
            default:
                XCTAssertEqual(request.url!.path, "/v1/auth/logout")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer new-access")
                let stream = request.httpBodyStream!
                stream.open(); defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 4096)
                let count = stream.read(&bytes, maxLength: bytes.count)
                let body = try JSONSerialization.jsonObject(with: Data(bytes.prefix(count))) as! [String: String]
                XCTAssertEqual(body["refreshToken"], "new-refresh")
                return (200, Data("{}".utf8))
            }
        }
        try await api.login(email: "a@b.com", password: "secret", deviceName: "iPhone")
        try await api.logout()
        XCTAssertFalse(api.signedIn)
        XCTAssertNil(store.value)
    }

    func testOfflineRestoreKeepsCredentialForRetry() async throws {
        let store = MemoryCredentials()
        store.value = SavedSession(tokens: Tokens(accessToken: "a", refreshToken: "r", expiresIn: 0), expiresAt: .distantPast)
        let api = client(store)
        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        await api.restore()
        XCTAssertFalse(api.signedIn)
        XCTAssertNotNil(store.value)
        XCTAssertNotNil(api.sessionMessage)
    }

    func testFilePermissionDenialDoesNotSignOut() async throws {
        let api = client()
        let response = json(tokens)
        StubProtocol.handler = { request in
            if request.url!.path == "/v1/auth/login" { return (200, response) }
            return (403, Data("{\"error\":{\"code\":\"FORBIDDEN\",\"message\":\"No access to this folder\"}}".utf8))
        }
        try await api.login(email: "a@b.com", password: "secret", deviceName: "iPhone")
        do { _ = try await api.list(parentID: "private"); XCTFail("Expected permission failure") }
        catch { XCTAssertTrue(api.signedIn) }
    }

    func testZeroByteUpload() async throws {
        let api = HarborAPI(baseURL: URL(string: "http://127.0.0.1:18987")!, credentials: MemoryCredentials())
        try await api.login(email: "ios-test@example.test", password: "fixture-password", deviceName: "iOS tests")
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("empty-\(UUID().uuidString).txt")
        try Data().write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }
        let transfers = FileTransfers(api: api)
        try await transfers.upload(source, parentID: nil) { _, _ in }
        let page = try await api.list(parentID: nil)
        let item = try XCTUnwrap(page.items.first { $0.name == source.lastPathComponent })
        XCTAssertEqual(item.sizeBytes, 0)
        let downloaded = try await transfers.download(item) { _, _ in }
        defer { FileTransfers.removePreview(downloaded) }
        XCTAssertEqual(try FileTransfers.digest(downloaded).size, 0)
    }

    func testCursorIsEncodedWithoutAddingQueryParameters() async throws {
        let api = client()
        let response = json(tokens)
        StubProtocol.handler = { request in
            if request.url!.path == "/v1/auth/login" { return (200, response) }
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            XCTAssertEqual(components.queryItems, [URLQueryItem(name: "cursor", value: "a&limit=999+?/=")])
            return (200, Data("{\"items\":[],\"nextCursor\":null}".utf8))
        }
        try await api.login(email: "a@b.com", password: "secret", deviceName: "iPhone")
        _ = try await api.list(parentID: nil, cursor: "a&limit=999+?/=")
    }

    func testFileHashAndUnsafeNames() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("abc".utf8).write(to: url)
        let result = try FileTransfers.digest(url)
        XCTAssertEqual(result.size, 3)
        XCTAssertEqual(result.hash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        for name in ["../secret", "..", ".", "a/b", "a\\b", "a\n.txt"] { XCTAssertThrowsError(try FileTransfers.safeName(name)) }
        XCTAssertEqual(try FileTransfers.safeName("Résumé 2026.pdf"), "Résumé 2026.pdf")
        XCTAssertThrowsError(try FileTransfers.validateStorageURL(URL(string: "http://insecure.example/file")!, apiURL: HarborConfiguration.productionURL))
    }

    func testMultipartUploadAndVerifiedDownloadAgainstLocalFixture() async throws {
        let base = URL(string: "http://127.0.0.1:18987")!
        let api = HarborAPI(baseURL: base, credentials: MemoryCredentials())
        try await api.login(email: "ios-test@example.test", password: "fixture-password", deviceName: "iOS tests")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("roundtrip-\(UUID().uuidString).txt")
        let original = Data(repeating: 0x5a, count: 2 * 1024 * 1024 + 37)
        try original.write(to: source)
        let transfers = FileTransfers(api: api)
        try await transfers.upload(source, parentID: nil) { _, _ in }
        let page = try await api.list(parentID: nil)
        let item = try XCTUnwrap(page.items.first { $0.name == source.lastPathComponent })
        let downloaded = try await transfers.download(item) { _, _ in }
        defer { FileTransfers.removePreview(downloaded) }
        XCTAssertEqual(try Data(contentsOf: downloaded), original)
        try await api.logout()
        XCTAssertFalse(api.signedIn)
    }

    func testDownloadRejectsCorruptedBytes() async throws {
        let api = HarborAPI(baseURL: URL(string: "http://127.0.0.1:18987")!, credentials: MemoryCredentials())
        try await api.login(email: "ios-test@example.test", password: "fixture-password", deviceName: "iOS tests")
        let item = DriveItem(id: "corrupt", parentId: nil, type: "FILE", name: "corrupt.txt", mimeType: "text/plain", sizeBytes: 3, updatedAt: "", backupRootId: nil, cloudState: nil)
        do { _ = try await FileTransfers(api: api).download(item) { _, _ in }; XCTFail("Corrupt download accepted") }
        catch { XCTAssertTrue(error.localizedDescription.contains("integrity check")) }
    }

    func testUsageTotalSumsUniqueFolderIDs() {
        let usage = ["a": FolderUsage(itemId: "a", bytes: 4_000_000_000, files: 3, complete: true),
                     "b": FolderUsage(itemId: "b", bytes: 200_000_000, files: 2, complete: true)]
        // A folder synced on two devices (or listed twice) counts once.
        let total = UsageTotal.sum(["a", "b", "a"], usage: usage)
        XCTAssertEqual(total, UsageTotal(bytes: 4_200_000_000, files: 5, complete: true))
        XCTAssertEqual(total?.label, Format.size(4_200_000_000))
        XCTAssertEqual(total?.short, Format.size(4_200_000_000))
        XCTAssertEqual(UsageTotal.sum([String](), usage: usage), UsageTotal(bytes: 0, files: 0, complete: true))
        // Sizes fill in only once every folder has loaded.
        XCTAssertNil(UsageTotal.sum(["a", "missing"], usage: usage))
    }

    func testPartialUsageShowsAtLeast() {
        let usage = ["a": FolderUsage(itemId: "a", bytes: 4_000_000_000, files: 3, complete: true),
                     "big": FolderUsage(itemId: "big", bytes: 200_000_000, files: 9, complete: false)]
        let total = UsageTotal.sum(["a", "big"], usage: usage)
        XCTAssertEqual(total?.complete, false)
        XCTAssertEqual(total?.bytes, 4_200_000_000)
        XCTAssertEqual(total?.label, "At least " + Format.size(4_200_000_000))
        XCTAssertEqual(total?.short, Format.size(4_200_000_000) + "+")
    }
}
