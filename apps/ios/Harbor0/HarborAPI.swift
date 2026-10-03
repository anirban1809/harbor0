import Foundation
import Combine
import UIKit

@MainActor
final class HarborAPI: ObservableObject {
    @Published private(set) var signedIn = false
    @Published private(set) var restoring = true
    @Published var sessionMessage: String?
    let baseURL: URL
    private let session: URLSession
    private let credentials: CredentialStore
    private let deviceKeys: DeviceKeyStore?
    private(set) var deviceName = UIDevice.current.model
    private var pendingDeviceName: String?
    private struct DeviceResponse: Decodable { struct Device: Decodable { let id: String; let name: String }; let device: Device }
    private var saved: SavedSession?
    private var refreshTask: Task<Void, Error>?
    private var generation = UUID()
    private struct Envelope: Decodable {
        struct Details: Decodable { let folderId: String? }
        struct Failure: Decodable {
            let message: String
            let code: String?
            let details: Details?
            enum Keys: String, CodingKey { case message, code, details }
            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                message = try container.decode(String.self, forKey: .message)
                code = try container.decodeIfPresent(String.self, forKey: .code)
                details = try? container.decodeIfPresent(Details.self, forKey: .details)
            }
        }
        let error: Failure
    }
    var canRestore: Bool { saved != nil }

    /// Device keys default to the Keychain alongside default credentials; injected stores opt in explicitly.
    init(baseURL: URL = HarborConfiguration.apiURL, session: URLSession = .shared, credentials: CredentialStore? = nil, deviceKeys: DeviceKeyStore? = nil) {
        self.baseURL = baseURL
        self.session = session
        self.credentials = credentials ?? KeychainStore(service: SharedAccount.credentialService(for: baseURL))
        self.deviceKeys = deviceKeys ?? (credentials == nil ? KeychainDeviceKeys(service: "app.harbor0.ios." + baseURL.absoluteString) : nil)
    }

    func restore() async {
        restoring = true
        sessionMessage = nil
        defer { restoring = false }
        do {
            saved = try credentials.load()
            guard saved != nil else { return }
            if let name = saved?.deviceName { deviceName = name }
            try await refresh()
            // Sessions from before signed device identity are upgraded once; a failure retries next launch.
            if var current = saved, current.deviceProven != true,
               (try? await proveDevice(token: current.tokens.accessToken)) != nil {
                current.deviceProven = true
                try? credentials.save(current)
                saved = current
            }
            signedIn = true
        } catch {
            sessionMessage = error.localizedDescription
        }
    }

    func login(email: String, password: String, deviceName: String) async throws {
        let tokens: Tokens = try await raw("/v1/auth/login", method: "POST", body: [
            "email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            "password": password, "deviceName": deviceName, "platform": "IOS"
        ])
        self.deviceName = deviceName
        pendingDeviceName = deviceName
        // Servers without signed device identity don't offer the challenge; restore() upgrades later.
        var proven = true
        do { try await proveDevice(token: tokens.accessToken) }
        catch let error as APIError where error.status == 404 { proven = false }
        try persist(tokens, deviceProven: proven)
        generation = UUID()
        sessionMessage = nil
        signedIn = true
    }

    func logout() async throws {
        // Revoke remotely before removing the local credential, so failures are retryable.
        let stamp = generation
        if saved != nil {
            if saved!.expiresAt.timeIntervalSinceNow < 60 { try await refresh() }
            func revoke() async throws {
                guard let tokens = saved?.tokens else { return }
                let _: EmptyResponse = try await raw("/v1/auth/logout", method: "POST", body: ["refreshToken": tokens.refreshToken], token: tokens.accessToken)
            }
            do { try await revoke() }
            catch let error as APIError where error.status == 401 {
                try await refresh()
                try await revoke()
            } catch let error as APIError where error.code == "DEVICE_REVOKED" {
                // The server has already revoked this session.
            }
        }
        guard generation == stamp else { throw CancellationError() }
        try clear()
    }

    func forgetLocalSession() throws { try clear() }

    /// For the Files extension: use the session the app saved, without refreshing or proving it.
    @discardableResult
    func loadStoredSession() -> Bool {
        saved = try? credentials.load()
        signedIn = saved != nil
        return signedIn
    }

    /// The app and the Files extension share one session and refresh tokens rotate, so adopt
    /// tokens the other process saved instead of refreshing with a stale one.
    private func adoptStoredTokens() -> Bool {
        guard let stored = try? credentials.load(), stored.tokens.refreshToken != saved?.tokens.refreshToken else { return false }
        saved = stored
        return true
    }

    /// This session's device record. Sync checkpoints and backups are tied to its id; the
    /// existing signed device identity is kept because no devicePublicId is sent.
    func registerSyncDevice() async throws -> (id: String, name: String) {
        let response: DeviceResponse = try await request("/v1/sync/devices/register", method: "POST",
                                                         body: ["name": String(deviceName.prefix(100)), "platform": "IOS"])
        return (response.device.id, response.device.name)
    }

    /// Signed-out account flows: sign up, confirm, resend, forgot and reset.
    func publicRequest<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        try await raw(path, method: "POST", body: body)
    }

    private func clear() throws {
        generation = UUID()
        refreshTask?.cancel()
        refreshTask = nil
        saved = nil
        signedIn = false
        try credentials.clear()
    }

    /// Binds this session to the installation's key so the server can tell devices apart.
    private func proveDevice(token: String) async throws {
        guard let deviceKeys else { return }
        let challenge: DeviceChallenge = try await raw("/v1/auth/session/challenge", method: "POST", body: nil, token: token)
        let key = try deviceKeys.key(for: challenge.userId)
        let _: EmptyResponse = try await raw("/v1/auth/session", method: "POST", body: [
            "name": deviceName, "platform": "IOS", "devicePublicId": key.fingerprint,
            "proof": try key.proof(challenge: challenge.challenge, userID: challenge.userId)
        ], token: token)
    }

    private func persist(_ tokens: Tokens, deviceProven: Bool? = nil) throws {
        let next = SavedSession(tokens: tokens, expiresAt: Date().addingTimeInterval(tokens.expiresIn),
                                deviceProven: deviceProven ?? saved?.deviceProven,
                                deviceName: pendingDeviceName ?? saved?.deviceName)
        pendingDeviceName = nil
        try credentials.save(next)
        saved = next
    }

    private func refresh() async throws {
        if let pending = refreshTask { return try await pending.value }
        if adoptStoredTokens(), let saved, saved.expiresAt.timeIntervalSinceNow > 60 { return }
        guard let token = saved?.tokens.refreshToken else {
            throw APIError(status: 401, message: "Sign in to continue.")
        }
        let stamp = generation
        let task = Task { @MainActor in
            let tokens: Tokens = try await self.raw("/v1/auth/refresh", method: "POST", body: ["refreshToken": token])
            try Task.checkCancellation()
            guard self.generation == stamp else { throw CancellationError() }
            try self.persist(tokens)
        }
        refreshTask = task
        defer { if generation == stamp { refreshTask = nil } }
        do { try await task.value }
        catch let error as APIError where error.status == 401 || error.status == 403 {
            guard generation == stamp else { throw CancellationError() }
            // The other process may have rotated the refresh token at the same moment.
            if adoptStoredTokens(), let saved, saved.expiresAt.timeIntervalSinceNow > 60 { return }
            try clear()
            sessionMessage = "Your session expired. Sign in again."
            throw error
        }
    }

    func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        let stamp = generation
        if let saved, saved.expiresAt.timeIntervalSinceNow < 60 { try await refresh() }
        guard let token = saved?.tokens.accessToken else { throw APIError(status: 401, message: "Sign in to continue.") }
        do {
            let value: T = try await raw(path, method: method, body: body, token: token)
            guard stamp == generation else { throw CancellationError() }
            return value
        } catch let error as APIError where error.code == "DEVICE_REVOKED" {
            guard generation == stamp else { throw CancellationError() }
            try clear()
            sessionMessage = "This device was signed out. Sign in again."
            throw error
        } catch let error as APIError where error.status == 401 {
            guard stamp == generation else { throw CancellationError() }
            try await refresh()
            do {
                let value: T = try await raw(path, method: method, body: body, token: saved?.tokens.accessToken)
                guard stamp == generation else { throw CancellationError() }
                return value
            } catch let retryError as APIError where retryError.status == 401 || retryError.code == "DEVICE_REVOKED" {
                guard generation == stamp else { throw CancellationError() }
                try clear()
                sessionMessage = "Your session expired. Sign in again."
                throw retryError
            }
        }
    }

    private func raw<T: Decodable>(_ path: String, method: String, body: [String: Any]?, token: String? = nil) async throws -> T {
        guard let url = URL(string: baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw APIError(status: 0, message: "The server address is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 45
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let detail = try? JSONDecoder().decode(Envelope.self, from: data)
            throw APIError(status: http.statusCode, message: detail?.error.message ?? "The server could not complete this request (\(http.statusCode)). Try again.", code: detail?.error.code, folderID: detail?.error.details?.folderId)
        }
        if data.isEmpty, let empty = EmptyResponse() as? T { return empty }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func list(parentID: String?, cursor: String? = nil) async throws -> DrivePage {
        var query = URLComponents()
        if let cursor { query.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
        let suffix = query.percentEncodedQuery.map { "?" + $0 } ?? ""
        return try await request("/v1/drive/folders/\(parentID ?? "root")/children" + suffix)
    }

    @discardableResult
    func createFolder(name: String, parentID: String?) async throws -> DriveItem {
        let response: ItemResponse = try await request("/v1/drive/folders", method: "POST", body: [
            "name": name, "parentId": parentID as Any? ?? NSNull(), "operationId": UUID().uuidString
        ])
        return response.item
    }

    static func pagePath(_ path: String, cursor: String?) -> String {
        guard let cursor else { return path }
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "cursor", value: cursor)]
        return path + (path.contains("?") ? "&" : "?") + (query.percentEncodedQuery ?? "")
    }

    func trashPage(cursor: String? = nil) async throws -> DrivePage {
        try await request(Self.pagePath("/v1/search?trash=true", cursor: cursor))
    }

    enum TrashAction { case trash, restore, permanent }
    func changeTrash(_ item: DriveItem, action: TrashAction) async throws {
        guard let revision = item.revision, revision > 0 else {
            throw APIError(status: 0, message: "Refresh this list before changing the file.")
        }
        let suffix = action == .restore ? "/restore" : (action == .permanent ? "/permanent" : "")
        let _: EmptyResponse = try await request("/v1/drive/items/\(item.id)" + suffix,
            method: action == .restore ? "POST" : "DELETE",
            body: ["operationId": UUID().uuidString, "baseRevision": revision])
    }

    func emptyTrash() async throws {
        var cursor: String?
        var seen = Set<String>()
        repeat {
            var body: [String: Any] = ["operationId": UUID().uuidString]
            if let cursor { body["cursor"] = cursor }
            let page: TrashResult = try await request("/v1/drive/trash/empty", method: "POST", body: body)
            cursor = page.nextCursor
            if let cursor, !seen.insert(cursor).inserted {
                throw APIError(status: 0, message: "Trash cleanup stopped unexpectedly. Refresh and try again.")
            }
        } while cursor != nil
    }
}
