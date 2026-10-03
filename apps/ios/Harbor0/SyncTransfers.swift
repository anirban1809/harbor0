import Foundation
import UniformTypeIdentifiers

struct UploadStatus: Decodable {
    struct Upload: Decodable { let id: String; let state: String; var partSizeBytes: Int64? = nil; var item: DriveItem? = nil }
    let upload: Upload
    var parts: [CompletedPart]? = nil
}

/// Resumable uploads and verified downloads for sync and backup (apps/desktop/src/transfers.ts).
/// Upload state is persisted after every step so an interrupted transfer resumes where it stopped.
enum SyncTransfers {
    static let storage: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 120
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    static func hash(_ url: URL) throws -> String { try FileTransfers.digest(url).hash }

    struct Changed: LocalizedError {
        var errorDescription: String? { "File changed while uploading. The next attempt will restart safely." }
    }

    static func upload(api: HarborAPI, file: URL, name: String, parentId: String?, state: inout UploadState,
                       persist: (UploadState) -> Void, existing: (itemId: String, revision: Int)? = nil,
                       backup: (rootId: String, runId: String)? = nil,
                       progress: ((Int64, Int64) -> Void)? = nil,
                       beforeComplete: (() async throws -> Void)? = nil) async throws -> DriveItem {
        guard let info = try LocalInfo.of(file), info.kind == .file else { throw CocoaError(.fileNoSuchFile) }
        if let mtime = state.mtime, mtime != info.mtime || state.size != info.size {
            if let uploadId = state.uploadId { let _: EmptyResponse? = try? await api.request("/v1/uploads/\(uploadId)", method: "DELETE") }
            state = UploadState(operationId: UUID().uuidString.lowercased())
        }
        state.mtime = info.mtime
        state.size = info.size
        if state.hash == nil { state.hash = try hash(file) }
        persist(state)
        // A freshly created upload has no parts yet; only a resumed one needs its server status.
        var created = false
        if state.uploadId == nil {
            var body: [String: Any] = [
                "operationId": state.operationId, "parentId": parentId as Any? ?? NSNull(), "name": name,
                "sizeBytes": info.size, "contentHash": state.hash!,
                "mimeType": UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream",
            ]
            if let existing { body["driveItemId"] = existing.itemId; body["baseRevision"] = existing.revision }
            let result: UploadResponse = try await api.request(backup.map { "/v1/backups/\($0.rootId)/runs/\($0.runId)/uploads" } ?? "/v1/uploads",
                                                               method: "POST", body: body)
            state.uploadId = result.upload.id
            state.partSize = result.upload.partSizeBytes
            state.parts = []
            persist(state)
            created = true
        }
        var parts = state.parts ?? []
        if !created {
            let status: UploadStatus = try await api.request("/v1/uploads/\(state.uploadId!)")
            if status.upload.state == "COMPLETED", let item = status.upload.item { return item }
            if ["ABORTED", "FAILED", "EXPIRED"].contains(status.upload.state) {
                state = UploadState(operationId: UUID().uuidString.lowercased())
                persist(state)
                return try await upload(api: api, file: file, name: name, parentId: parentId, state: &state, persist: persist,
                                        existing: existing, backup: backup, progress: progress, beforeComplete: beforeComplete)
            }
            if status.upload.state != "COMPLETING" { parts = status.parts ?? [] }
            if state.partSize == nil { state.partSize = status.upload.partSizeBytes }
        }
        guard let partSize = state.partSize, partSize > 0 else { throw URLError(.badServerResponse) }
        let size = info.size
        let count = max(1, Int((size + partSize - 1) / partSize))
        let done = Set(parts.map(\.partNumber))
        func bytes(_ n: Int) -> Int64 { min(partSize, size - Int64(n - 1) * partSize) }
        var loaded = parts.reduce(Int64(0)) { $0 + bytes($1.partNumber) }
        progress?(loaded, size)
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("HarborSync-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: scratch) }
        for number in 1...count where !done.contains(number) {
            try Task.checkCancellation()
            try handle.seek(toOffset: UInt64(Int64(number - 1) * partSize))
            FileManager.default.createFile(atPath: scratch.path, contents: nil)
            let output = try FileHandle(forWritingTo: scratch)
            var remaining = bytes(number)
            do {
                while remaining > 0 {
                    guard let data = try handle.read(upToCount: Int(min(remaining, 1024 * 1024))), !data.isEmpty else {
                        throw APIError(status: 0, message: "File changed during upload. Retry to preserve the latest content.")
                    }
                    try output.write(contentsOf: data)
                    remaining -= Int64(data.count)
                }
                try output.close()
            } catch { try? output.close(); throw error }
            var etag: String?
            for attempt in 0..<3 {
                do {
                    let urls: PartURLs = try await api.request("/v1/uploads/\(state.uploadId!)/parts", method: "POST", body: ["partNumbers": [number]])
                    guard let url = urls.parts.first(where: { $0.partNumber == number })?.uploadUrl else { throw URLError(.badServerResponse) }
                    try FileTransfers.validateStorageURL(url, apiURL: await api.baseURL)
                    var request = URLRequest(url: url)
                    request.httpMethod = "PUT"
                    request.timeoutInterval = 300
                    let (_, response) = try await storage.upload(for: request, fromFile: scratch)
                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                          let value = http.value(forHTTPHeaderField: "ETag"), !value.isEmpty else {
                        throw APIError(status: 0, message: "Storage upload failed. It will resume automatically.")
                    }
                    etag = value
                    break
                } catch {
                    try Task.checkCancellation()
                    if attempt == 2 { throw error }
                }
            }
            parts.append(CompletedPart(partNumber: number, etag: etag!))
            state.parts = parts
            persist(state)
            loaded += bytes(number)
            progress?(loaded, size)
        }
        guard let after = try LocalInfo.of(file), after.mtime == state.mtime, after.size == state.size else { throw Changed() }
        try await beforeComplete?()
        let sorted = parts.sorted { $0.partNumber < $1.partNumber }
        let result: ItemResponse = try await api.request("/v1/uploads/\(state.uploadId!)/complete", method: "POST", body: [
            "parts": sorted.map { ["partNumber": $0.partNumber, "etag": $0.etag] as [String: Any] },
            "contentHash": state.hash!,
        ])
        return result.item
    }

    struct IntegrityFailed: LocalizedError {
        var errorDescription: String? { "Download integrity check failed. The original local file was kept." }
    }

    /// Downloads authorized content, verifies size and SHA-256, then replaces `destination`.
    /// `beforeReplace` runs after verification and right before the local file is replaced.
    @discardableResult
    static func download(api: HarborAPI, _ body: [String: String], to destination: URL,
                         beforeReplace: (() async throws -> Void)? = nil) async throws -> String {
        for target in [destination, destination.appendingPathExtension("harbor-part")] {
            if try LocalInfo.of(target)?.kind == .link { throw SyncPaths.UnsafePath(message: "Refusing to write through a symbolic link.") }
        }
        let signed: DownloadResponse = try await api.request("/v1/downloads", method: "POST", body: body)
        try FileTransfers.validateStorageURL(signed.downloadUrl, apiURL: await api.baseURL)
        let (temporary, response) = try await storage.download(from: signed.downloadUrl)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(status: 0, message: "Download interrupted. It will resume automatically.")
        }
        let digest = try FileTransfers.digest(temporary)
        guard digest.size == signed.sizeBytes, digest.hash == signed.contentHash else { throw IntegrityFailed() }
        // Stage beside the destination so the final replacement is a same-volume rename.
        let part = destination.appendingPathExtension("harbor-part")
        try? FileManager.default.removeItem(at: part)
        try FileManager.default.copyItem(at: temporary, to: part)
        do {
            try await beforeReplace?()
            if try LocalInfo.of(destination) != nil {
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: part, backupItemName: nil, options: [])
            } else {
                try FileManager.default.moveItem(at: part, to: destination)
            }
        } catch {
            try? FileManager.default.removeItem(at: part)
            throw error
        }
        return signed.contentHash
    }
}
