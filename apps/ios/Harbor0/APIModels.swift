import Foundation

// Response shapes for the workspace screens, matching docs/openapi.json.

struct Page<T: Decodable>: Decodable {
    let items: [T]
    var nextCursor: String? = nil
}

struct Person: Decodable, Hashable { let displayName: String; let username: String }

struct ManifestEntry: Decodable, Identifiable, Hashable {
    let id: String
    let displayName: String
    let relativePath: String
    let itemType: String
    let sizeBytes: Int64
    let mimeType: String?
    var isFolder: Bool { itemType == "FOLDER" }
}

struct Transfer: Decodable, Identifiable {
    let id: String
    let state: String
    let createdAt: String
    let expiresAt: String?
    let totalSizeBytes: Int64
    var recipientEmail: String? = nil
    var savedAt: String? = nil
    var displayNames: [String]? = nil
    var preparationState: String? = nil
    var saveState: String? = nil
    var failure: String? = nil
    var items: [ManifestEntry]? = nil
    var nextEntryCursor: String? = nil
    var sender: Person? = nil
    var recipient: Person? = nil
    var ready: Bool { preparationState != "BUILDING" && preparationState != "FAILED" }
}

struct ShareGrant: Decodable, Identifiable {
    let id: String
    let driveItemId: String
    let ownerUserId: String
    let permission: String
    let createdAt: String
    var revokedAt: String? = nil
    let item: DriveItem
}

struct Device: Decodable, Identifiable {
    let id: String
    let name: String
    let platform: String
    var lastSeenAt: String? = nil
    let createdAt: String
    var revokedAt: String? = nil
    var status: String? = nil
    var devicePublicId: String? = nil
    var isPhone: Bool { ["IOS", "ANDROID"].contains(platform) }
    static let platformNames = ["WEB": "Web browser", "MACOS": "Mac", "WINDOWS": "Windows PC", "LINUX": "Linux computer",
                                "IOS": "iPhone or iPad", "ANDROID": "Android device"]
    var platformName: String { Self.platformNames[platform] ?? platform }
}

struct HarborNotification: Decodable, Identifiable {
    let id: String
    let type: String
    var readAt: String? = nil
    let createdAt: String
}

struct FileVersion: Decodable, Identifiable {
    let id: String
    let versionNumber: Int
    let sizeBytes: Int64
    let createdAt: String
    var cloudState: String? = nil
    var contentHash: String? = nil
}

struct FolderDownload: Decodable {
    let id: String
    let name: String
    let state: String
    let files: Int
    let bytes: Int64
    var totalBytes: Int64? = nil
    var currentFile: String? = nil
    var error: String? = nil
    var downloadUrl: URL? = nil
    var sizeBytes: Int64? = nil
    var contentHash: String? = nil
}

struct BackupRestore: Decodable, Identifiable {
    let id: String
    let relativePath: String
    let state: String
    let requestedAt: String
    var completedAt: String? = nil
    var error: String? = nil
    var itemId: String? = nil
    var versionId: String? = nil
}

struct BackupEntry: Decodable, Identifiable {
    let relativePath: String
    let itemId: String
    let versionId: String
    let sizeBytes: Int64
    let modifiedAt: String
    let savedAt: String
    var id: String { itemId + ":" + versionId }
}

struct UserResponse: Decodable { let user: Account.User }

/// Storage a folder's subtree uses (`/v1/drive/usage`): every stored version of every non-trashed file.
/// `complete == false`: the count stopped early, so bytes and files are lower bounds.
struct FolderUsage: Decodable, Equatable { let itemId: String; let bytes: Int64; let files: Int; let complete: Bool }

/// The account's ordered change feed (`/v1/sync/changes`).
struct SyncChange: Decodable { let type: String; let entityId: String; var item: DriveItem? = nil }
struct SyncChangesPage: Decodable { let changes: [SyncChange]; let nextCursor: Int; let hasMore: Bool }
