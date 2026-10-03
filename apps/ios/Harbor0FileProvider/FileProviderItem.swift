import FileProvider
import UniformTypeIdentifiers

/// A My Drive file or folder as the Files app sees it.
final class FileProviderItem: NSObject, NSFileProviderItem {
    let item: DriveItem?

    init(_ item: DriveItem) { self.item = item }
    /// My Drive itself.
    private override init() { item = nil }
    static let root = FileProviderItem()

    static func identifier(_ id: String?) -> NSFileProviderItemIdentifier {
        id.map { NSFileProviderItemIdentifier($0) } ?? .rootContainer
    }
    /// The API id of a Files identifier; nil for My Drive itself.
    static func driveID(_ identifier: NSFileProviderItemIdentifier) -> String? {
        identifier == .rootContainer ? nil : identifier.rawValue
    }

    var itemIdentifier: NSFileProviderItemIdentifier { item.map { Self.identifier($0.id) } ?? .rootContainer }
    var parentItemIdentifier: NSFileProviderItemIdentifier { item.map { Self.identifier($0.parentId) } ?? .rootContainer }
    var filename: String { item?.name ?? "harbor0" }
    var contentType: UTType {
        guard let item, !item.isFolder else { return .folder }
        if let mime = item.mimeType, mime != "application/octet-stream", let type = UTType(mimeType: mime) { return type }
        return UTType(filenameExtension: (item.name as NSString).pathExtension) ?? .data
    }
    /// Backed-up folders are a read-only history kept by their source device.
    private var readOnly: Bool { item?.backupRootId != nil }
    var capabilities: NSFileProviderItemCapabilities {
        if readOnly { return item?.isFolder == true ? [.allowsReading, .allowsContentEnumerating] : [.allowsReading] }
        if item == nil { return [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems] }
        if item!.isFolder { return [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems, .allowsRenaming, .allowsReparenting, .allowsDeleting] }
        return [.allowsReading, .allowsWriting, .allowsRenaming, .allowsReparenting, .allowsDeleting]
    }
    var itemVersion: NSFileProviderItemVersion {
        guard let item else { return NSFileProviderItemVersion(contentVersion: Data("root".utf8), metadataVersion: Data("root".utf8)) }
        let content = item.isFolder ? "folder" : (item.currentVersionId ?? "\(item.revision ?? 0)")
        return NSFileProviderItemVersion(contentVersion: Data(content.utf8), metadataVersion: Data("\(item.revision ?? 0)".utf8))
    }
    var documentSize: NSNumber? { item.flatMap { $0.isFolder ? nil : NSNumber(value: $0.sizeBytes) } }
    var contentModificationDate: Date? { item.flatMap { Self.date($0.updatedAt) } }
    var creationDate: Date? { item.flatMap { $0.createdAt.flatMap(Self.date) } }

    private static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
