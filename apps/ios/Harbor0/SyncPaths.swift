import Foundation

/// Path rules shared with the desktop sync engine (apps/desktop/src/paths.ts).
enum SyncPaths {
    struct UnsafePath: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static func safeSegment(_ name: String, id: String) throws -> String {
        if name.isEmpty || name == "." || name == ".." || name.contains("/") || name.contains("\\") || name.contains("\0") {
            throw UnsafePath(message: "Unsafe remote filename.")
        }
        let reserved = try! NSRegularExpression(pattern: "^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)", options: .caseInsensitive)
        let awkward = name.unicodeScalars.contains { "<>:\"|?*".unicodeScalars.contains($0) || $0.value < 0x20 }
            || name.hasSuffix(".") || name.hasSuffix(" ")
            || reserved.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
        guard awkward else { return name }
        var cleaned = String(name.unicodeScalars.map { scalar -> Character in
            let allowed = CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII || "._ -".unicodeScalars.contains(scalar)
            return allowed ? Character(scalar) : "_"
        })
        while cleaned.hasSuffix(".") || cleaned.hasSuffix(" ") { cleaned.removeLast() }
        return "\(cleaned.isEmpty ? "file" : cleaned)~\(id.prefix(8))"
    }

    /// OS and file-manager bookkeeping that should never be synced or backed up.
    private static let metadataNames: Set<String> = [
        ".ds_store", ".appledouble", ".lsoverride", ".spotlight-v100", ".trashes", ".fseventsd", ".temporaryitems",
        ".documentrevisions-v100", ".apdisk", "icon\r", "thumbs.db", "ehthumbs.db", "desktop.ini", "$recycle.bin", ".directory",
        // iOS: the Files app's trash and iCloud placeholders for files not downloaded yet.
        ".trash", ".localized",
    ]
    static func metadataSegment(_ name: String) -> Bool {
        name.hasPrefix("._") || metadataNames.contains(name.lowercased()) || (name.hasPrefix(".") && name.hasSuffix(".icloud"))
    }

    private static let recovered = try! NSRegularExpression(pattern: " \\(Recovered by harbor0 \\d{4}-\\d{2}-\\d{2} \\d{2}\\.\\d{2}\\.\\d{2}\\)$")
    static func recoveredName(_ name: String, at date: Date) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd HH.mm.ss"
        return "\(name) (Recovered by harbor0 \(format.string(from: date)))"
    }
    static func internalPath(_ relative: String) -> Bool {
        relative.split(separator: "/").contains { piece in
            let p = String(piece)
            return p.hasPrefix(".harbor-") || p.hasSuffix(".harbor-part")
                || recovered.firstMatch(in: p, range: NSRange(p.startIndex..., in: p)) != nil || metadataSegment(p)
        }
    }

    /// The absolute URL of a relative path, refusing anything that leaves the root.
    static func contained(_ root: URL, _ relative: String) throws -> URL {
        if relative.hasPrefix("/") || relative.split(whereSeparator: { $0 == "/" || $0 == "\\" }).contains("..") {
            throw UnsafePath(message: "Unsafe relative path.")
        }
        if relative.isEmpty || relative == "." { return root }
        return relative.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }
    }

    static func dirname(_ relative: String) -> String {
        guard let slash = relative.lastIndex(of: "/") else { return "." }
        return String(relative[..<slash])
    }
    static func basename(_ relative: String) -> String {
        relative.split(separator: "/").last.map(String.init) ?? relative
    }
    static func join(_ directory: String, _ name: String) -> String {
        directory == "." || directory.isEmpty ? name : directory + "/" + name
    }

    static func conflictName(_ name: String, device: String, operationID: String) -> String {
        let ext = (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
        var label = device.replacingOccurrences(of: ".local", with: "", options: [.caseInsensitive, .anchored, .backwards])
        label = String(label.unicodeScalars.map { scalar -> Character in
            CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar) || " '-".unicodeScalars.contains(scalar) ? Character(scalar) : "_"
        }).trimmingCharacters(in: .whitespaces)
        label = String(label.prefix(40))
        if label.isEmpty { label = "another device" }
        return "\(stem) (Conflict - \(label) - \(operationID.prefix(8)))" + (ext.isEmpty ? "" : "." + ext)
    }

    /// Comparable form of a remote name (the API's normalizedName).
    static func normalized(_ name: String) -> String { name.precomposedStringWithCanonicalMapping.lowercased() }
}

/// What lstat would report for a local path; nil means it does not exist.
struct LocalInfo: Equatable {
    enum Kind: String { case file, folder, link, other }
    let kind: Kind
    let size: Int64
    let mtime: Double
    let inode: UInt64

    static func of(_ url: URL) throws -> LocalInfo? {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            let type = attributes[.type] as? FileAttributeType
            let kind: Kind = type == .typeDirectory ? .folder : type == .typeRegular ? .file : type == .typeSymbolicLink ? .link : .other
            return LocalInfo(kind: kind, size: (attributes[.size] as? NSNumber)?.int64Value ?? 0,
                             mtime: ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000,
                             inode: (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0)
        } catch let error as NSError where LocalFS.missing(error) {
            return nil
        }
    }
}

enum LocalFS {
    static func missing(_ error: Error) -> Bool {
        let error = error as NSError
        if error.domain == NSCocoaErrorDomain, [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) { return true }
        if error.domain == NSPOSIXErrorDomain, error.code == Int(ENOENT) { return true }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError { return missing(underlying) }
        return false
    }
    static func denied(_ error: Error) -> Bool {
        let error = error as NSError
        if error.domain == NSCocoaErrorDomain, [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(error.code) { return true }
        if error.domain == NSPOSIXErrorDomain, [Int(EACCES), Int(EPERM)].contains(error.code) { return true }
        return false
    }
    static func full(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSCocoaErrorDomain && error.code == NSFileWriteOutOfSpaceError)
            || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOSPC))
    }

    /// Creates missing parent folders and refuses to write through links or files (paths.ts safeParents).
    @discardableResult
    static func safeParents(_ root: URL, _ relative: String, create: Bool = true) throws -> URL {
        guard let base = try LocalInfo.of(root), base.kind == .folder else {
            throw SyncFolderMissing()
        }
        var current = root
        for piece in relative.split(separator: "/").dropLast() {
            current = try SyncPaths.contained(current, String(piece))
            if let info = try LocalInfo.of(current) {
                if info.kind != .folder { throw SyncPaths.UnsafePath(message: "A symbolic link or file blocks this destination.") }
            } else if create {
                try FileManager.default.createDirectory(at: current, withIntermediateDirectories: false)
            } else {
                throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: current.path])
            }
        }
        let target = try SyncPaths.contained(root, relative)
        if try LocalInfo.of(target)?.kind == .link { throw SyncPaths.UnsafePath(message: "Refusing to overwrite a symbolic link.") }
        return target
    }

    static func children(_ url: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: url.path)
    }
}

/// The sync or backup folder itself is unavailable (ENOENT on the root).
struct SyncFolderMissing: LocalizedError {
    var errorDescription: String? { "The local folder is unavailable." }
}
