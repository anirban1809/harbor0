import FileProvider

/// Lists a folder's children, or reports changes from the account's change feed.
final class FileProviderEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: NSFileProviderItemIdentifier
    private let session: FileProviderSession

    init(container: NSFileProviderItemIdentifier, session: FileProviderSession) {
        self.container = container
        self.session = session
    }
    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        // Changes anywhere arrive through the working set; it lists nothing up front.
        guard container != .workingSet, container != .trashContainer else {
            observer.finishEnumerating(upTo: nil)
            return
        }
        let initial = page.rawValue == NSFileProviderPage.initialPageSortedByName as Data
            || page.rawValue == NSFileProviderPage.initialPageSortedByDate as Data
        let cursor = initial ? nil : String(data: page.rawValue, encoding: .utf8)
        Task { @MainActor in
            do {
                let api = try session.api()
                let result = try await api.list(parentID: FileProviderItem.driveID(container), cursor: cursor)
                observer.didEnumerate(result.items.filter { $0.deletedAt == nil }.map(FileProviderItem.init))
                observer.finishEnumerating(upTo: result.nextCursor.map { NSFileProviderPage(Data($0.utf8)) })
            } catch {
                observer.finishEnumeratingWithError(FileProviderSession.fileProviderError(error))
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        // Only the working set reports changes; folders defer to it.
        guard container == .workingSet, let cursor = Self.cursor(anchor) else {
            observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
            return
        }
        Task { @MainActor in
            do {
                let api = try session.api()
                let page: SyncChangesPage = try await api.request("/v1/sync/changes?cursor=\(cursor)&limit=200")
                var updated: [String: DriveItem] = [:]
                var deleted = Set<String>()
                for change in page.changes {
                    guard let item = change.item else { continue }
                    if item.deletedAt != nil { deleted.insert(item.id); updated[item.id] = nil }
                    else { updated[item.id] = item; deleted.remove(item.id) }
                }
                if !updated.isEmpty { observer.didUpdate(updated.values.map(FileProviderItem.init)) }
                if !deleted.isEmpty { observer.didDeleteItems(withIdentifiers: deleted.map { NSFileProviderItemIdentifier($0) }) }
                observer.finishEnumeratingChanges(upTo: Self.anchor(page.nextCursor), moreComing: page.hasMore)
            } catch let error as APIError where error.code == "SYNC_CURSOR_EXPIRED" {
                observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            } catch {
                observer.finishEnumeratingWithError(FileProviderSession.fileProviderError(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task { @MainActor in
            do { completionHandler(Self.anchor(try await session.latestCursor())) }
            catch { completionHandler(nil) }
        }
    }

    static func anchor(_ cursor: Int) -> NSFileProviderSyncAnchor { NSFileProviderSyncAnchor(Data("cursor:\(cursor)".utf8)) }
    static func cursor(_ anchor: NSFileProviderSyncAnchor) -> Int? {
        guard let text = String(data: anchor.rawValue, encoding: .utf8), text.hasPrefix("cursor:") else { return nil }
        return Int(text.dropFirst(7))
    }
}
