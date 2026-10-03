import Foundation

/// Formatting shared by every screen, matching apps/web/lib/file-metadata.ts.
enum Format {
    /// fileSize(): decimal units with one fraction digit, e.g. "4.2 MB", "12.0 KB", "512 B".
    static func size(_ value: Int64?) -> String {
        guard let value, value >= 0 else { return "—" }
        if value < 1000 { return "\(value) B" }
        let units = ["KB", "MB", "GB", "TB"]
        var amount = Double(value) / 1000
        var unit = 0
        while amount >= 1000 && unit < units.count - 1 { amount /= 1000; unit += 1 }
        return amount.formatted(.number.precision(.fractionLength(1))) + " " + units[unit]
    }

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()
    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
    /// "Sep 30, 2026"
    static func date(_ value: String?) -> String {
        guard let date = parse(value) else { return "—" }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
    /// The full local date and time, like toLocaleString().
    static func full(_ value: String?) -> String {
        guard let date = parse(value) else { return "Date unavailable" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    /// "Sep 30, 2:15 PM", for activity entries.
    static func short(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
    /// The backups page's relative time: "just now", "5 minutes ago", "on Sep 30, 2026 at 2:15 PM".
    static func ago(_ value: String?) -> String {
        guard let date = parse(value) else { return "—" }
        let minutes = Int((date.timeIntervalSinceNow / 60).rounded())
        if abs(minutes) < 1 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        if abs(minutes) < 60 || abs(minutes) < 60 * 24 * 7 { return formatter.localizedString(fromTimeInterval: date.timeIntervalSinceNow) }
        return "on " + full(value)
    }
    static func count(_ value: Int, _ noun: String) -> String { "\(value) \(noun)\(value == 1 ? "" : "s")" }

    /// fileKind(): "PDF document", "JPG image", "Folder", …
    static func kind(_ item: DriveItem) -> String {
        if item.isFolder { return "Folder" }
        let parts = item.name.split(separator: ".")
        let ext = parts.count > 1 ? parts.last!.lowercased() : ""
        let known = ["pdf": "PDF document", "md": "Markdown document", "txt": "Text document", "doc": "Word document",
                     "docx": "Word document", "xls": "Spreadsheet", "xlsx": "Spreadsheet", "csv": "CSV spreadsheet",
                     "ppt": "Presentation", "pptx": "Presentation", "zip": "ZIP archive", "json": "JSON file"]
        if let label = known[ext] { return label }
        if let type = item.mimeType?.split(separator: "/").first.map(String.init), ["image", "video", "audio"].contains(type) {
            return (ext.isEmpty ? "" : ext.uppercased() + " ") + type
        }
        return ext.isEmpty ? "File" : ext.uppercased() + " file"
    }
    /// The phone row's meta line: "4.2 MB · Sep 30, 2026" or "Folder · Sep 30, 2026".
    static func meta(_ item: DriveItem) -> String {
        (item.isFolder ? "Folder" : size(item.sizeBytes)) + " · " + date(item.deletedAt ?? item.updatedAt)
    }
}
