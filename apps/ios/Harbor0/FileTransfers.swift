import Foundation
import CryptoKit
import UniformTypeIdentifiers

actor FileTransfers {
    private let api: HarborAPI
    private let storage: URLSession
    init(api: HarborAPI, storage: URLSession = URLSession(configuration: .ephemeral)) {
        self.api = api
        self.storage = storage
    }

    static func digest(_ file: URL) throws -> (hash: String, size: Int64) {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        var size: Int64 = 0
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            try Task.checkCancellation()
            hash.update(data: data)
            size += Int64(data.count)
        }
        return (hash.finalize().map { String(format: "%02x", $0) }.joined(), size)
    }

    static func safeName(_ value: String) throws -> String {
        guard !value.isEmpty, value != ".", value != "..",
              !value.contains("/"), !value.contains("\\"),
              value.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw APIError(status: 0, message: "This file has an invalid name.")
        }
        return value
    }

    private func workspace() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("HarborTransfers", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                              attributes: [.protectionKey: FileProtectionType.complete])
        return url
    }

    func upload(_ source: URL, parentID: String?, progress: @escaping @MainActor @Sendable (String, Double?) -> Void) async throws {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let directory = try workspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let snapshot = directory.appendingPathComponent("source")
        await progress("Preparing \(source.lastPathComponent)…", nil)
        // Coordinate with Files providers and freeze the bytes before hashing/uploading.
        var coordinationError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinationError) { readable in
            do { try FileManager.default.copyItem(at: readable, to: snapshot) }
            catch { copyError = error }
        }
        if let error = coordinationError ?? copyError as NSError? { throw error }
        let fingerprint = try Self.digest(snapshot)
        let name = try Self.safeName(source.lastPathComponent)
        let mime = UTType(filenameExtension: source.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let result: UploadResponse = try await api.request("/v1/uploads", method: "POST", body: [
            "operationId": UUID().uuidString, "parentId": parentID as Any? ?? NSNull(),
            "name": name, "sizeBytes": fingerprint.size, "mimeType": mime, "contentHash": fingerprint.hash
        ])
        let upload = result.upload
        do {
            guard upload.partSizeBytes > 0 else { throw URLError(.badServerResponse) }
            let count = max(1, Int((fingerprint.size + upload.partSizeBytes - 1) / upload.partSizeBytes))
            guard count <= 10_000 else { throw APIError(status: 0, message: "This file is too large to upload.") }
            let input = try FileHandle(forReadingFrom: snapshot)
            defer { try? input.close() }
            var completed: [CompletedPart] = []
            var sent: Int64 = 0
            for number in 1...count {
                try Task.checkCancellation()
                let chunk = directory.appendingPathComponent("part")
                FileManager.default.createFile(atPath: chunk.path, contents: nil)
                let output = try FileHandle(forWritingTo: chunk)
                do {
                    var remaining = min(upload.partSizeBytes, fingerprint.size - sent)
                    while remaining > 0 {
                        try Task.checkCancellation()
                        guard let data = try input.read(upToCount: Int(min(remaining, 1024 * 1024))), !data.isEmpty else {
                            throw APIError(status: 0, message: "The selected file could not be read. Try selecting it again.")
                        }
                        try output.write(contentsOf: data)
                        remaining -= Int64(data.count)
                    }
                    try output.close()
                } catch { try? output.close(); throw error }
                var etag: String?
                for attempt in 0..<3 {
                    do {
                        let urls: PartURLs = try await api.request("/v1/uploads/\(upload.id)/parts", method: "POST", body: ["partNumbers": [number]])
                        guard let url = urls.parts.first(where: { $0.partNumber == number })?.uploadUrl else { throw URLError(.badServerResponse) }
                        try Self.validateStorageURL(url, apiURL: api.baseURL)
                        var request = URLRequest(url: url)
                        request.httpMethod = "PUT"
                        request.timeoutInterval = 300
                        let (_, response) = try await storage.upload(for: request, fromFile: chunk)
                        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                              let value = http.value(forHTTPHeaderField: "ETag"), !value.isEmpty else { throw URLError(.badServerResponse) }
                        etag = value
                        break
                    } catch {
                        try Task.checkCancellation()
                        if attempt == 2 { throw error }
                    }
                }
                guard let etag else { throw URLError(.badServerResponse) }
                completed.append(CompletedPart(partNumber: number, etag: etag))
                sent += min(upload.partSizeBytes, fingerprint.size - sent)
                await progress("Uploading \(name)…", fingerprint.size == 0 ? 1 : Double(sent) / Double(fingerprint.size))
                try FileManager.default.removeItem(at: chunk)
            }
            await progress("Finishing \(name)…", nil)
            let _: ItemResponse = try await api.request("/v1/uploads/\(upload.id)/complete", method: "POST", body: [
                "parts": completed.map { ["partNumber": $0.partNumber, "etag": $0.etag] as [String: Any] },
                "contentHash": fingerprint.hash
            ])
        } catch {
            // A separate task can release quota even if the transfer was cancelled.
            let cleanup = Task { @MainActor [api] in
                let _: EmptyResponse? = try? await api.request("/v1/uploads/\(upload.id)", method: "DELETE")
            }
            await cleanup.value
            throw error
        }
    }

    func download(_ item: DriveItem, progress: @escaping @MainActor @Sendable (String, Double?) -> Void) async throws -> URL {
        let name = try Self.safeName(item.name)
        await progress("Downloading \(name)…", nil)
        let authorization: DownloadResponse = try await api.request("/v1/downloads", method: "POST", body: ["driveItemId": item.id])
        try Self.validateStorageURL(authorization.downloadUrl, apiURL: api.baseURL)
        let (temporary, response) = try await storage.download(from: authorization.downloadUrl)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        await progress("Checking \(name)…", nil)
        let fingerprint = try Self.digest(temporary)
        guard fingerprint.hash == authorization.contentHash, fingerprint.size == authorization.sizeBytes else {
            throw APIError(status: 0, message: "The downloaded file failed its integrity check. Try downloading it again.")
        }
        let directory = try workspace()
        let target = directory.appendingPathComponent(name)
        do { try FileManager.default.moveItem(at: temporary, to: target) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
        return target
    }

    static func validateStorageURL(_ url: URL, apiURL: URL) throws {
        if url.scheme == "https", url.host != nil { return }
        #if DEBUG
        if apiURL.scheme == "http", ["localhost", "127.0.0.1"].contains(apiURL.host ?? ""),
           url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? "") { return }
        #endif
        throw APIError(status: 0, message: "The file server did not provide a secure transfer address.")
    }

    static func removePreview(_ url: URL) {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    static func cleanPreviousLaunch() {
        // No background transfers are retained in this first version.
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("HarborTransfers", isDirectory: true)
        try? FileManager.default.removeItem(at: scratch)
    }
}
