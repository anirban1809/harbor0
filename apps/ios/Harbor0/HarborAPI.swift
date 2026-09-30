import Foundation
import Combine

@MainActor
final class HarborAPI: ObservableObject {
    @Published private(set) var signedIn = false
    @Published private(set) var restoring = true
    @Published var sessionMessage: String?
    let baseURL: URL
    private let session: URLSession
    private let credentials: CredentialStore
    private var saved: SavedSession?
    private var refreshTask: Task<Void, Error>?
    private var generation = UUID()
    private struct Envelope: Decodable {
        struct Failure: Decodable { let message: String; let code: String? }
        let error: Failure
    }
    var canRestore: Bool { saved != nil }

    init(baseURL: URL = HarborConfiguration.apiURL, session: URLSession = .shared, credentials: CredentialStore? = nil) {
        self.baseURL = baseURL
        self.session = session
        self.credentials = credentials ?? KeychainStore(service: "app.harbor0.ios." + baseURL.absoluteString)
    }

    func restore() async {
        restoring = true
        sessionMessage = nil
        defer { restoring = false }
        do {
            saved = try credentials.load()
            guard saved != nil else { return }
            try await refresh()
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
        try persist(tokens)
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

    private func clear() throws {
        generation = UUID()
        refreshTask?.cancel()
        refreshTask = nil
        saved = nil
        signedIn = false
        try credentials.clear()
    }

    private func persist(_ tokens: Tokens) throws {
        let next = SavedSession(tokens: tokens, expiresAt: Date().addingTimeInterval(tokens.expiresIn))
        try credentials.save(next)
        saved = next
    }

    private func refresh() async throws {
        if let pending = refreshTask { return try await pending.value }
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
            throw APIError(status: http.statusCode, message: detail?.error.message ?? "The server could not complete this request (\(http.statusCode)). Try again.", code: detail?.error.code)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func list(parentID: String?, cursor: String? = nil) async throws -> DrivePage {
        var query = URLComponents()
        if let cursor { query.queryItems = [URLQueryItem(name: "cursor", value: cursor)] }
        let suffix = query.percentEncodedQuery.map { "?" + $0 } ?? ""
        return try await request("/v1/drive/folders/\(parentID ?? "root")/children" + suffix)
    }

    func createFolder(name: String, parentID: String?) async throws {
        let _: ItemResponse = try await request("/v1/drive/folders", method: "POST", body: [
            "name": name, "parentId": parentID as Any? ?? NSNull(), "operationId": UUID().uuidString
        ])
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
