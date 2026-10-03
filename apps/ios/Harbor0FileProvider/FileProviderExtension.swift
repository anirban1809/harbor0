import FileProvider
import UniformTypeIdentifiers

/// harbor0 in the Files app. iOS starts this extension on its own to list folders, download files
/// when they are opened and upload changes made in any app, so My Drive stays in sync without
/// the harbor0 app running.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    private let domain: NSFileProviderDomain
    private let session: FileProviderSession

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        session = FileProviderSession(domain: domain)
        super.init()
    }
    func invalidate() {}

    // MARK: Reading

    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        guard let id = FileProviderItem.driveID(identifier) else {
            completionHandler(FileProviderItem.root, nil)
            return progress
        }
        Task { @MainActor in
            do {
                let item = try await session.item(id)
                if item.deletedAt != nil { throw NSFileProviderError(.noSuchItem) }
                completionHandler(FileProviderItem(item), nil)
            } catch { completionHandler(nil, FileProviderSession.fileProviderError(error)) }
            progress.completedUnitCount = 1
        }
        return progress
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        FileProviderEnumerator(container: containerItemIdentifier, session: session)
    }

    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest, completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        let task = Task { @MainActor in
            do {
                guard let id = FileProviderItem.driveID(itemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
                let item = try await session.available(id)
                progress.completedUnitCount = 10
                let url = try await session.download(item, into: try temporaryDirectory()) { fraction in
                    progress.completedUnitCount = 10 + Int64(fraction * 90)
                }
                progress.completedUnitCount = 100
                completionHandler(url, FileProviderItem(item), nil)
            } catch { completionHandler(nil, nil, FileProviderSession.fileProviderError(error)) }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    // MARK: Changes made on this iPhone

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                    options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        let task = Task { @MainActor in
            do {
                let parent = FileProviderItem.driveID(itemTemplate.parentItemIdentifier)
                let name = itemTemplate.filename
                let type = itemTemplate.contentType ?? .data
                let created: DriveItem
                if type.conforms(to: .folder) {
                    created = try await session.createFolder(name, parentID: parent, mayExist: options.contains(.mayAlreadyExist))
                } else if type.conforms(to: .symbolicLink) || type.conforms(to: .aliasFile) {
                    throw NSError(domain: NSCocoaErrorDomain, code: NSFeatureUnsupportedError,
                                  userInfo: [NSLocalizedDescriptionKey: "harbor0 can’t store shortcuts or links."])
                } else {
                    guard let url else { throw NSFileProviderError(.noSuchItem) }
                    created = try await session.upload(url, name: name, parentID: parent, existing: nil) { fraction in
                        progress.completedUnitCount = Int64(fraction * 100)
                    }
                }
                progress.completedUnitCount = 100
                completionHandler(FileProviderItem(created), [], false, nil)
            } catch { completionHandler(nil, [], false, FileProviderSession.fileProviderError(error)) }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields,
                    contents newContents: URL?, options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        let task = Task { @MainActor in
            do {
                guard let id = FileProviderItem.driveID(item.itemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
                var current = try await session.item(id)
                if changedFields.contains(.parentItemIdentifier) && item.parentItemIdentifier == .trashContainer {
                    try await session.trash(current)
                    completionHandler(nil, [], false, nil)
                    return
                }
                if changedFields.contains(.filename) && item.filename != current.name {
                    current = try await session.rename(current, to: item.filename)
                }
                if changedFields.contains(.parentItemIdentifier) {
                    let parent = FileProviderItem.driveID(item.parentItemIdentifier)
                    if parent != current.parentId { current = try await session.move(current, to: parent) }
                }
                if changedFields.contains(.contents), let newContents, !current.isFolder {
                    // An edit based on an older version is kept beside the newer one instead of replacing it.
                    let edited = String(data: version.contentVersion, encoding: .utf8)
                    let stale = current.currentVersionId != nil && edited != current.currentVersionId
                    if stale {
                        _ = try await session.upload(newContents, name: SyncPaths.conflictName(current.name, device: "iPhone", operationID: UUID().uuidString.lowercased()),
                                                     parentID: current.parentId, existing: nil) { progress.completedUnitCount = Int64($0 * 100) }
                        completionHandler(FileProviderItem(current), [], true, nil)
                        return
                    }
                    current = try await session.upload(newContents, name: current.name, parentID: current.parentId, existing: current) { fraction in
                        progress.completedUnitCount = Int64(fraction * 100)
                    }
                }
                progress.completedUnitCount = 100
                completionHandler(FileProviderItem(current), [], false, nil)
            } catch { completionHandler(nil, [], false, FileProviderSession.fileProviderError(error)) }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task { @MainActor in
            do {
                guard let id = FileProviderItem.driveID(identifier) else { throw NSFileProviderError(.deletionRejected) }
                // Deleting in Files moves the item to harbor0's Trash, where it can be restored.
                try await session.trash(try await session.item(id))
                completionHandler(nil)
            } catch let error as APIError where ["ITEM_NOT_FOUND", "PARENT_NOT_FOUND"].contains(error.code ?? "") {
                completionHandler(nil)
            } catch { completionHandler(FileProviderSession.fileProviderError(error)) }
            progress.completedUnitCount = 1
        }
        return progress
    }

    private func temporaryDirectory() throws -> URL {
        guard let manager = NSFileProviderManager(for: domain) else { throw NSFileProviderError(.providerNotFound) }
        return try manager.temporaryDirectoryURL()
    }
}
