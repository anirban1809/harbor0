import Foundation

/// What the app shares with the harbor0 Files extension: the server, the signed-in account and
/// the session in the shared keychain group (see Keychain.swift).
enum SharedAccount {
    static let appGroup = "group.app.harbor0.ios"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func credentialService(for baseURL: URL) -> String { "app.harbor0.ios." + baseURL.absoluteString }

    /// Recorded by the app after sign-in so the extension uses the same server and account.
    static func save(apiURL: URL, userId: String) {
        defaults?.set(apiURL.absoluteString, forKey: "apiURL")
        defaults?.set(userId, forKey: "userId")
    }
    static var apiURL: URL? { defaults?.string(forKey: "apiURL").flatMap(URL.init(string:)) }
    static var userId: String? { defaults?.string(forKey: "userId") }
    static func clear() {
        defaults?.removeObject(forKey: "userId")
    }
}
