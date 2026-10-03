import Foundation

/// Durable delivery confirmations for the sync relay (apps/desktop/src/sync-receipts.ts).
/// The outbox survives restarts. Audits also recover copies completed before receipts existed.
final class SyncReceipts: @unchecked Sendable {
    struct Receipt: Codable, Equatable {
        var rootId: String
        var remoteId: String
        var relative: String
        var itemId: String
        var type: String
        var revision: Int
        var versionId: String?
        var hash: String?
    }
    private struct Candidate { let rootId: String; let itemId: String; let isRoot: Bool }
    private struct Status: Decodable {
        let itemId: String
        var revision: Int? = nil
        var deviceConfirmed: Bool? = nil
    }
    private struct StatusPage: Decodable { let items: [Status] }
    private struct Acknowledged: Decodable { let ok: Bool }

    // A pass that finds every copy confirmed waits an hour, or until nudge() reports new activity.
    private static let auditRetry: Double = 15_000
    private static let auditIdle: Double = 3_600_000
    private static let auditBatch = 25
    private let api: HarborAPI
    private let journal: SyncJournal
    private weak var engine: SyncEngine?
    private let lock = NSLock()
    private var candidates: [Candidate] = []
    private var nextAuditAt: Double = 0
    private var passFound = false

    init(api: HarborAPI, journal: SyncJournal, engine: SyncEngine) {
        self.api = api
        self.journal = journal
        self.engine = engine
    }

    private func pending() -> [String: Receipt] { journal.get("syncReceipts", as: [String: Receipt].self) ?? [:] }
    func pendingRoots() -> [String] { Array(Set(pending().values.map(\.rootId))) }

    func queue(_ root: SyncRoot, _ relative: String, _ item: DriveItem, hash: String?) {
        guard root.mode == .sync, let remoteId = root.remoteId, let revision = item.revision,
              item.isFolder || (item.currentVersionId != nil && hash != nil) else { return }
        lock.lock(); defer { lock.unlock() }
        var all = pending()
        all[item.id] = Receipt(rootId: root.id, remoteId: remoteId, relative: relative, itemId: item.id, type: item.type,
                               revision: revision, versionId: item.currentVersionId, hash: hash)
        journal.set("syncReceipts", all)
    }
    private func remove(_ id: String, _ receipt: Receipt, retry: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        // Transfers may queue a newer revision while the network request is outstanding.
        var current = pending()
        guard current[id] == receipt else { return }
        current[id] = nil
        if retry { current[id] = receipt } // A failing item must not starve other confirmations.
        journal.set("syncReceipts", current)
    }
    private func reconcile(_ rootId: String) {
        if var root = journal.root(rootId) { root.needsReconcile = true; journal.save(root) }
    }
    /// Sync activity may have left copies unconfirmed; audit again soon.
    func nudge() {
        lock.lock(); defer { lock.unlock() }
        nextAuditAt = min(nextAuditAt, SyncClock.now + Self.auditRetry)
    }
    private func passEnded() { nextAuditAt = SyncClock.now + (passFound ? Self.auditRetry : Self.auditIdle) }

    func audit() async {
        if candidates.isEmpty {
            if SyncClock.now < nextAuditAt { return }
            passFound = false
            candidates = journal.roots().filter { $0.mode == .sync && $0.remoteId != nil && !$0.paused }.flatMap { root in
                [Candidate(rootId: root.id, itemId: root.remoteId!, isRoot: true)]
                    + journal.files(root.id).map { Candidate(rootId: root.id, itemId: $0.itemId, isRoot: false) }
            }
        }
        let batch = Array(candidates.prefix(Self.auditBatch))
        guard !batch.isEmpty else { passEnded(); return }
        let statuses: [Status]
        do {
            let page: StatusPage = try await api.request("/v1/sync/status?recursive=false&ids=" + batch.map(\.itemId).joined(separator: ","))
            statuses = page.items
        } catch let error as APIError where ["ITEM_NOT_FOUND", "PARENT_NOT_FOUND", "ITEM_DELETING", "SYNC_REMOVED"].contains(error.code ?? "") {
            passFound = true
            for candidate in batch { reconcile(candidate.rootId) }
            candidates.removeFirst(min(batch.count, candidates.count))
            return
        } catch { return }
        for candidate in batch {
            if Task.isCancelled { return }
            guard let root = journal.root(candidate.rootId), !root.paused, root.mode == .sync else { continue }
            let known = candidate.isRoot ? nil : journal.file(root.id, item: candidate.itemId)
            if !candidate.isRoot && known == nil { continue }
            let relative = candidate.isRoot ? "." : known!.relativePath
            if root.excluded.contains(where: { relative == $0 || relative.hasPrefix($0 + "/") }) { continue }
            guard let status = statuses.first(where: { $0.itemId == candidate.itemId }) else { continue }
            if status.deviceConfirmed == true && (candidate.isRoot || status.revision == known?.revision) { continue }
            passFound = true
            do {
                let response: ItemResponse = try await api.request("/v1/drive/items/\(candidate.itemId)")
                let item = response.item
                if item.deletedAt != nil { reconcile(root.id); continue }
                if let known, item.revision != known.revision || (!item.isFolder && known.hash == nil) { reconcile(root.id); continue }
                queue(root, relative, item, hash: known?.hash)
            } catch {
                // Revisit this copy on the next audit; other files can still be confirmed.
            }
        }
        candidates.removeFirst(min(batch.count, candidates.count))
        if candidates.isEmpty { passEnded() }
    }

    func flush() async {
        let deadline = SyncClock.now + 5000
        for (id, receipt) in pending() {
            if Task.isCancelled || SyncClock.now >= deadline { break }
            guard let root = journal.root(receipt.rootId), root.mode == .sync, root.remoteId == receipt.remoteId,
                  !root.excluded.contains(where: { receipt.relative == $0 || receipt.relative.hasPrefix($0 + "/") }) else {
                remove(id, receipt)
                continue
            }
            if root.paused { continue }
            do {
                guard let base = try await engine?.location(root) else { continue }
                let full = receipt.relative == "." ? base : try LocalFS.safeParents(base, receipt.relative, create: false)
                let info = try LocalInfo.of(full)
                if receipt.type == "FILE" {
                    // Confirm only a local copy that still holds exactly the delivered bytes.
                    guard let info, info.kind == .file, try SyncTransfers.hash(full) == receipt.hash,
                          try LocalInfo.of(full) == info else { remove(id, receipt); continue }
                } else if info?.kind != .folder {
                    remove(id, receipt)
                    continue
                }
                let response: Acknowledged = try await api.request("/v1/sync/items/\(id)/acknowledge", method: "POST", body: [
                    "versionId": receipt.versionId as Any? ?? NSNull(), "revision": receipt.revision,
                    "contentHash": receipt.hash as Any? ?? NSNull(),
                ])
                if response.ok {
                    remove(id, receipt)
                    journal.set("syncConfirmedAt", SyncClock.iso())
                } else { remove(id, receipt, retry: true) }
            } catch {
                if LocalFS.missing(error) || ["REVISION_CONFLICT", "ITEM_NOT_FOUND", "PARENT_NOT_FOUND"].contains(error.apiCode ?? "") {
                    reconcile(root.id)
                    remove(id, receipt)
                } else { remove(id, receipt, retry: true) }
            }
        }
    }
}
