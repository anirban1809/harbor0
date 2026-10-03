import SwiftUI
import Combine
import UniformTypeIdentifiers

enum UploadPhase: String { case queued, hashing, uploading, paused, done, failed }

/// One file's upload. Files from a chosen folder share a group (web FileUpload).
struct FileUpload: Identifiable, Equatable {
    let key: String
    let name: String
    let size: Int64
    var fraction: Double = 0
    var phase: UploadPhase = .queued
    var error: String?
    var groupKey: String?
    var groupName: String?
    var id: String { key }
    var loaded: Int64 { phase == .done ? size : Int64(Double(size) * fraction) }
}

/// A row in the upload tray: a single file, or a whole folder rolled up (web summarizeUploads).
struct UploadActivity: Identifiable {
    let key: String
    let folder: Bool
    let name: String
    let size: Int64
    let loaded: Int64
    let phase: UploadPhase
    let error: String?
    let files: Int
    let filesDone: Int
    let filesFailed: Int
    let keys: [String]
    var id: String { key }

    static func summarize(_ uploads: [FileUpload]) -> [UploadActivity] {
        var order: [String] = []
        var groups: [String: [FileUpload]] = [:]
        for upload in uploads {
            let key = upload.groupKey ?? upload.key
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(upload)
        }
        return order.map { key in
            let members = groups[key]!
            let first = members[0]
            let phases = members.map(\.phase)
            let phase: UploadPhase = first.groupKey == nil ? first.phase
                : phases.contains(where: { $0 == .hashing || $0 == .uploading }) ? .uploading
                : phases.contains(.paused) ? .paused
                : phases.contains(.queued) ? .queued
                : phases.contains(.failed) ? .failed : .done
            return UploadActivity(key: key, folder: first.groupKey != nil, name: first.groupName ?? first.name,
                                  size: members.reduce(0) { $0 + $1.size }, loaded: members.reduce(0) { $0 + $1.loaded },
                                  phase: phase, error: members.first { $0.phase == .failed }?.error, files: members.count,
                                  filesDone: phases.filter { $0 == .done }.count, filesFailed: phases.filter { $0 == .failed }.count,
                                  keys: members.map(\.key))
        }
    }
    /// The tray's detail line (upload-tray.tsx detail()).
    var detail: String {
        let amount = "\(Self.bytes(loaded)) of \(Self.bytes(size))"
        if !folder {
            switch phase {
            case .queued: return "Waiting…"
            case .hashing: return "Preparing file…"
            case .uploading: return amount
            case .paused: return "Paused · " + amount
            case .done: return "Uploaded"
            case .failed: return error ?? "Upload failed"
            }
        }
        let failed = filesFailed > 0 ? " · \(filesFailed) failed" : ""
        let progress = "\(filesDone) of \(Format.count(files, "file"))"
        switch phase {
        case .queued: return "Waiting · " + Format.count(files, "file")
        case .hashing, .uploading: return "\(progress) · \(amount)\(failed)"
        case .paused: return "Paused · \(progress)\(failed)"
        case .done: return "\(Format.count(files, "file")) uploaded"
        case .failed: return "\(filesFailed) of \(Format.count(files, "file")) failed" + (error.map { " · " + $0 } ?? "")
        }
    }
    static func bytes(_ n: Int64) -> String {
        let value = Double(n)
        if n < 1000 { return "\(n) B" }
        if n < 1_000_000 { return String(format: "%.1f KB", value / 1e3) }
        if n < 1_000_000_000 { return String(format: "%.1f MB", value / 1e6) }
        return String(format: "%.1f GB", value / 1e9)
    }
}

/// Keeps a picked folder readable while its files upload.
private final class ScopedAccess {
    let url: URL
    let active: Bool
    init(_ url: URL) { self.url = url; active = url.startAccessingSecurityScopedResource() }
    deinit { if active { url.stopAccessingSecurityScopedResource() } }
}

private final class UploadJob {
    let url: URL
    let folders: [String]
    let batch: String
    let base: String?
    let scope: ScopedAccess?
    var parent: String??
    var stopped = false
    var running = false
    var task: Task<Void, Never>?
    init(url: URL, folders: [String], batch: String, base: String?, scope: ScopedAccess?) {
        self.url = url; self.folders = folders; self.batch = batch; self.base = base; self.scope = scope
    }
}

struct ZipStatus: Equatable {
    enum Phase { case queued, listing, building, finalizing, downloading }
    let name: String
    var phase: Phase = .queued
    var files = 0
    var bytes: Int64 = 0
    var currentFile: String?
    var total: Int64?
    var percent: Int? {
        guard phase == .building, let total else { return nil }
        return total == 0 ? 100 : min(100, Int(Double(bytes) / Double(total) * 100))
    }
    var message: String {
        switch phase {
        case .queued: "Starting ZIP preparation…"
        case .listing: "Finding files and folders…"
        case .building: percent.map { "Preparing ZIP · \($0)%" } ?? "Preparing your ZIP…"
        case .finalizing: "Finishing your ZIP…"
        case .downloading: "Downloading ZIP…"
        }
    }
}

/// Uploads, downloads, folder ZIPs, previews and the share sheet.
@MainActor
final class TransferCenter: ObservableObject {
    @Published private(set) var uploads: [FileUpload] = []
    @Published private(set) var downloadLabel: String?
    @Published private(set) var zip: ZipStatus?
    @Published var previewURL: URL?
    @Published var showingPreview = false
    @Published var shareURLs: [URL] = []
    @Published var error: String?
    /// Bumped when uploaded files land, so listings refresh.
    @Published private(set) var revision = 0
    private let api: HarborAPI
    private let files: FileTransfers
    private var jobs: [String: UploadJob] = [:]
    private var batchFolders: [String: [String: Task<String, Error>]] = [:]
    private var downloadTask: Task<Void, Never>?
    private var zipTask: Task<Void, Never>?
    private var generation = UUID()
    var notify: ((String) -> Void)?

    init(api: HarborAPI) {
        self.api = api
        files = FileTransfers(api: api)
    }

    var downloading: Bool { downloadLabel != nil }
    var activity: [UploadActivity] { UploadActivity.summarize(uploads) }

    // MARK: Downloads

    /// Opens a file in the native preview (Quick Look), which can share or save it.
    func open(_ item: DriveItem) {
        download(label: "Opening \(item.name)…") { [files] update in [try await files.download(item, progress: update)] } done: { [weak self] urls in
            self?.previewURL = urls.first
            self?.showingPreview = urls.first != nil
        }
    }
    /// Downloads files (or a file version / transfer entry) and offers them in the share sheet.
    func save(_ items: [DriveItem], versionID: String? = nil) {
        download(label: items.count == 1 ? "Downloading \(items[0].name)…" : "Downloading \(items.count) files…") { [files] update in
            var urls: [URL] = []
            for item in items {
                var body = ["driveItemId": item.id]
                if let versionID { body["versionId"] = versionID }
                urls.append(try await files.download(body, name: item.name, progress: update))
            }
            return urls
        } done: { [weak self] urls in self?.shareURLs = urls }
    }
    func saveEntry(transferID: String, entry: ManifestEntry) {
        download(label: "Downloading \(entry.displayName)…") { [files] update in
            [try await files.download(["transferId": transferID, "entryId": entry.id], name: entry.displayName, progress: update)]
        } done: { [weak self] urls in self?.shareURLs = urls }
    }
    private func download(label: String, work: @escaping (@escaping @MainActor @Sendable (String, Double?) -> Void) async throws -> [URL], done: @escaping ([URL]) -> Void) {
        guard downloadTask == nil else { return }
        downloadLabel = label
        error = nil
        let stamp = generation
        downloadTask = Task {
            defer { if generation == stamp { downloadLabel = nil; downloadTask = nil } }
            do {
                let urls = try await work { [weak self] text, _ in
                    guard let self, self.generation == stamp else { return }
                    self.downloadLabel = text
                }
                guard generation == stamp, !Task.isCancelled else { urls.forEach(FileTransfers.removePreview); return }
                done(urls)
            } catch {
                guard generation == stamp, !Task.isCancelled else { return }
                if (error as? URLError)?.code == .cancelled { return }
                self.error = error.localizedDescription
            }
        }
    }
    func cancelDownload() { downloadTask?.cancel() }
    func dismissPreview() {
        if let previewURL { FileTransfers.removePreview(previewURL) }
        previewURL = nil
    }
    func finishSharing() {
        shareURLs.forEach(FileTransfers.removePreview)
        shareURLs = []
    }

    // MARK: Folder ZIP (archive-download.ts)

    func downloadFolder(_ item: DriveItem) {
        guard zipTask == nil else { return }
        error = nil
        zip = ZipStatus(name: item.name)
        let stamp = generation
        zipTask = Task {
            var job: FolderDownload?
            defer { if generation == stamp { zip = nil; zipTask = nil } }
            do {
                // The creation request is not cancelled, so its job can be cleaned up.
                job = try await api.request("/v1/folder-downloads", method: "POST",
                                            body: ["driveItemId": item.id, "operationId": UUID().uuidString])
                while true {
                    try Task.checkCancellation()
                    guard let current = job else { break }
                    if current.state == "READY" { break }
                    if ["FAILED", "CANCELLED", "EXPIRED"].contains(current.state) {
                        throw APIError(status: 0, message: current.error ?? "ZIP preparation ended. Please try again.")
                    }
                    let phase: ZipStatus.Phase = switch current.state {
                    case "LISTING": .listing
                    case "BUILDING": .building
                    case "FINALIZING": .finalizing
                    default: .queued
                    }
                    zip = ZipStatus(name: item.name, phase: phase, files: current.files, bytes: current.bytes,
                                    currentFile: current.currentFile, total: current.totalBytes)
                    try await Task.sleep(nanoseconds: 1_500_000_000)
                    job = try await api.request("/v1/folder-downloads/\(current.id)")
                }
                guard let ready = job, let url = ready.downloadUrl else {
                    throw APIError(status: 0, message: "The ZIP download is unavailable. Please try again.")
                }
                zip?.phase = .downloading
                let file = try await files.fetch(url, name: item.name + ".zip", size: ready.sizeBytes, hash: ready.contentHash) { _, _ in }
                guard generation == stamp, !Task.isCancelled else { FileTransfers.removePreview(file); return }
                shareURLs = [file]
                notify?("\(item.name).zip is ready to save.")
            } catch {
                if let job, !["READY", "FAILED", "CANCELLED", "EXPIRED"].contains(job.state) {
                    let id = job.id
                    Task { [api] in let _: EmptyResponse? = try? await api.request("/v1/folder-downloads/\(id)", method: "DELETE") }
                }
                guard generation == stamp, !Task.isCancelled, !(error is CancellationError) else { return }
                self.error = error.localizedDescription
            }
        }
    }
    func cancelZip() { zipTask?.cancel() }

    // MARK: Uploads (one file at a time, like the web queue)

    func upload(_ urls: [URL], parentID: String?) {
        let batch = UUID().uuidString
        let queued = urls.enumerated().map { index, url -> FileUpload in
            let key = "\(batch)/\(index)"
            jobs[key] = UploadJob(url: url, folders: [], batch: batch, base: parentID, scope: nil)
            return FileUpload(key: key, name: url.lastPathComponent, size: Self.size(of: url))
        }
        uploads += queued
        Task { await drain(queued.map(\.key)) }
    }
    /// Uploads a picked folder, recreating its subfolders under `parentID`.
    func uploadFolder(_ folder: URL, parentID: String?) {
        let scope = ScopedAccess(folder)
        let batch = UUID().uuidString
        let root = folder.lastPathComponent
        var queued: [FileUpload] = []
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants])
        let base = folder.standardizedFileURL.pathComponents
        while let url = enumerator?.nextObject() as? URL {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            let components = url.standardizedFileURL.pathComponents
            let relative = Array(components.dropFirst(base.count).dropLast())
            let key = "\(batch)/\(queued.count)"
            jobs[key] = UploadJob(url: url, folders: [root] + relative, batch: batch, base: parentID, scope: scope)
            let size = Int64((try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
            queued.append(FileUpload(key: key, name: url.lastPathComponent, size: size, groupKey: "\(batch)/\(root)", groupName: root))
        }
        if queued.isEmpty {
            error = "“\(root)” has no files to upload."
            return
        }
        uploads += queued
        Task { await drain(queued.map(\.key)) }
    }
    private static func size(of url: URL) -> Int64 {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return Int64((try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0)
    }
    private func update(_ key: String, _ change: (inout FileUpload) -> Void) {
        guard let index = uploads.firstIndex(where: { $0.key == key }) else { return }
        change(&uploads[index])
    }
    private func drain(_ keys: [String]) async {
        for key in keys { await start(key) }
    }
    private func parent(for job: UploadJob) async throws -> String? {
        var parent = job.base
        var path = ""
        for name in job.folders {
            path += "/" + name
            var created = batchFolders[job.batch] ?? [:]
            if created[path] == nil {
                let parentID = parent
                created[path] = Task { [api] in try await api.createFolder(name: name, parentID: parentID).id }
                batchFolders[job.batch] = created
            }
            do { parent = try await created[path]!.value }
            catch { batchFolders[job.batch]?[path] = nil; throw error }
        }
        return parent
    }
    private func start(_ key: String) async {
        guard let job = jobs[key], !job.stopped, !job.running else { return }
        job.running = true
        let stamp = generation
        let task = Task { @MainActor [weak self, files] in
            guard let self else { return }
            do {
                if job.parent == nil { job.parent = .some(try await self.parent(for: job)) }
                try Task.checkCancellation()
                try await files.upload(job.url, parentID: job.parent ?? nil) { [weak self] label, fraction in
                    guard let self, self.generation == stamp else { return }
                    self.update(key) {
                        $0.phase = label.hasPrefix("Preparing") ? .hashing : .uploading
                        if let fraction { $0.fraction = fraction }
                        if label.hasPrefix("Finishing") { $0.fraction = 1 }
                    }
                }
                guard self.generation == stamp else { return }
                self.jobs[key] = nil
                self.update(key) { $0.phase = .done; $0.fraction = 1; $0.error = nil }
                self.revision += 1
            } catch {
                guard self.generation == stamp else { return }
                let paused = job.stopped || error is CancellationError || (error as? URLError)?.code == .cancelled
                self.update(key) {
                    $0.phase = paused ? .paused : .failed
                    $0.error = paused ? nil : error.localizedDescription
                    $0.fraction = paused ? 0 : $0.fraction
                }
            }
        }
        job.task = task
        await task.value
        job.running = false
        job.task = nil
    }
    func pause(_ keys: [String]) {
        for key in keys {
            guard let job = jobs[key] else { continue }
            job.stopped = true
            if job.running { job.task?.cancel() } else { update(key) { $0.phase = .paused } }
        }
    }
    func resume(_ keys: [String]) {
        let waiting = keys.filter { jobs[$0] != nil }
        for key in waiting {
            jobs[key]?.stopped = false
            update(key) { $0.phase = .queued; $0.error = nil }
        }
        Task { await drain(waiting) }
    }
    func cancel(_ keys: [String]) {
        for key in keys {
            guard let job = jobs.removeValue(forKey: key) else { continue }
            job.stopped = true
            job.task?.cancel()
        }
        let removed = Set(keys)
        uploads.removeAll { removed.contains($0.key) }
    }
    func dismissFinished() {
        let finished = Set(activity.filter { $0.phase == .done || $0.phase == .failed }.flatMap(\.keys))
        for key in finished { jobs[key] = nil }
        uploads.removeAll { finished.contains($0.key) }
    }

    func reset() {
        generation = UUID()
        downloadTask?.cancel(); zipTask?.cancel()
        for job in jobs.values { job.stopped = true; job.task?.cancel() }
        jobs = [:]; batchFolders = [:]; uploads = []
        downloadLabel = nil; zip = nil; error = nil
        showingPreview = false
        dismissPreview()
        finishSharing()
    }
}

/// The system share sheet, used to save downloads to Files or send them elsewhere.
struct ShareSheet: UIViewControllerRepresentable {
    let urls: [URL]
    let done: () -> Void
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: urls, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in done() }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
