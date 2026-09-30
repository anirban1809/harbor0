import Foundation

struct Tokens: Codable, Sendable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Double
}

struct SavedSession: Codable {
    let tokens: Tokens
    let expiresAt: Date
}

struct DriveItem: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let parentId: String?
    let type: String
    let name: String
    let mimeType: String?
    let sizeBytes: Int64
    let updatedAt: String
    let backupRootId: String?
    let cloudState: String?
    var revision: Int? = nil
    var deletedAt: String? = nil

    var isFolder: Bool { type == "FOLDER" }
    var symbol: String {
        if isFolder { return "folder.fill" }
        if mimeType?.hasPrefix("image/") == true { return "photo" }
        if mimeType == "application/pdf" { return "doc.richtext" }
        if mimeType?.hasPrefix("video/") == true { return "film" }
        if mimeType?.hasPrefix("audio/") == true { return "waveform" }
        return "doc"
    }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: sizeBytes, countStyle: .file) }
}

struct DrivePage: Decodable { let items: [DriveItem]; let nextCursor: String? }
struct ItemResponse: Decodable { let item: DriveItem }
struct Account: Decodable {
    struct User: Decodable { let id: String; let email: String; let displayName: String; var appearance: Appearance? = nil }
    struct Storage: Decodable { let quotaBytes: Int64; let usedBytes: Int64; let reservedBytes: Int64 }
    let user: User
    let storage: Storage
}
struct ProfileResponse: Decodable { let user: Account.User }
struct FolderCatalog: Decodable { let items: [DriveItem] }
struct BackupCatalog: Decodable { let items: [BackupRoot] }
struct BackupRoot: Decodable, Identifiable, Hashable {
    let id: String
    let deviceName: String?
    let localPathDisplayName: String
    let remoteRootDriveItemId: String
    let state: String
    let updatedAt: String
    var folder: DriveItem {
        DriveItem(id: remoteRootDriveItemId, parentId: nil, type: "FOLDER", name: localPathDisplayName,
                  mimeType: nil, sizeBytes: 0, updatedAt: updatedAt, backupRootId: id, cloudState: nil)
    }
}
struct BackupRunPage: Decodable { let items: [BackupRun]; let nextCursor: String? }
struct BackupRun: Decodable, Identifiable {
    let id: String
    let state: String
    let trigger: String
    let startedAt: String
    let fileCount: Int
    let sizeBytes: Int64
    let error: String?
}
struct SyncStatusPage: Decodable { let items: [SyncStatus] }
struct SyncStatus: Decodable {
    let itemId: String
    let state: String
    let cloudState: String
    let requiredDevices: Int
    let confirmedDevices: Int
    var label: String {
        switch state {
        case "SYNCED": return "Up to date"
        case "SYNCING": return "Syncing"
        case "PENDING": return "Waiting for a computer"
        default: return "Status unavailable"
        }
    }
}
struct TrashResult: Decodable { let count: Int; let nextCursor: String? }
struct UploadResponse: Decodable {
    struct Upload: Decodable { let id: String; let partSizeBytes: Int64 }
    let upload: Upload
}
struct PartURLs: Decodable {
    struct Part: Decodable { let partNumber: Int; let uploadUrl: URL }
    let parts: [Part]
}
struct CompletedPart: Codable { let partNumber: Int; let etag: String }
struct DownloadResponse: Decodable { let downloadUrl: URL; let sizeBytes: Int64; let contentHash: String }
struct EmptyResponse: Decodable {}
struct APIError: LocalizedError {
    let status: Int
    let message: String
    let code: String?
    init(status: Int, message: String, code: String? = nil) {
        self.status = status
        self.message = message
        self.code = code
    }
    var errorDescription: String? { message }
}

enum HarborConfiguration {
    static let productionURL = URL(string: "https://zlh5nzxdy6.execute-api.us-east-1.amazonaws.com")!
    static var apiURL: URL {
        #if DEBUG
        if let value = ProcessInfo.processInfo.environment["HARBOR_API_URL"],
           let url = URL(string: value),
           url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "")) {
            return url
        }
        #endif
        return productionURL
    }
}
