import Foundation
import Security
import CryptoKit

protocol CredentialStore {
    func load() throws -> SavedSession?
    func save(_ session: SavedSession) throws
    func clear() throws
}

struct KeychainStore: CredentialStore {
    let service: String
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "session"]
    }

    func load() throws -> SavedSession? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let attributes = result as? [String: Any], let data = attributes[kSecValueData as String] as? Data else { throw failure() }
        let session = try JSONDecoder().decode(SavedSession.self, from: data)
        // Sessions saved before the Files extension existed live in the app's private keychain
        // group, or are only readable while unlocked. Move them where the extension can use them.
        let group = attributes[kSecAttrAccessGroup as String] as? String ?? ""
        let accessible = attributes[kSecAttrAccessible as String] as? String
        if !group.hasSuffix(Self.sharedGroupSuffix) || accessible != (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String) {
            var legacy = query
            legacy[kSecAttrAccessGroup as String] = group
            if SecItemDelete(legacy as CFDictionary) == errSecSuccess {
                do { try save(session) }
                catch {
                    // Put it back where it was rather than lose the session.
                    let values: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: accessible ?? kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
                    SecItemAdd(legacy.merging(values) { _, new in new } as CFDictionary, nil)
                }
            }
        }
        return session
    }
    /// The shared keychain group is listed first in the entitlements, so new items land there.
    static let sharedGroupSuffix = ".app.harbor0.shared"

    func save(_ session: SavedSession) throws {
        let values: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(session),
            // The Files extension may upload while the phone is locked.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            try check(SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil))
        } else { try check(status) }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    private func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw failure() }
    }
    private func failure() -> APIError {
        APIError(status: 0, message: "Your secure sign-in storage is unavailable. Unlock your device and try again.")
    }
}


/// An installation's ECDSA P-256 signing key. Its fingerprint is the installation's device ID.
struct DeviceKey {
    let publicKey: Data
    let sign: (Data) throws -> Data

    init<Key: P256SigningKey>(_ key: Key) {
        publicKey = key.publicKeyDER
        sign = { try key.derSignature(for: $0) }
    }

    var fingerprint: String { Data(SHA256.hash(data: publicKey)).base64URLEncodedString() }

    /// Signs the server's session-bound challenge; matches `deviceProofMessage` in contracts.
    func proof(challenge: String, userID: String) throws -> [String: Any] {
        let message = ["harbor0-device-v1", challenge, userID, fingerprint].joined(separator: "\n")
        return ["publicKey": publicKey.base64URLEncodedString(), "challenge": challenge,
                "signature": try sign(Data(message.utf8)).base64URLEncodedString()]
    }
}

protocol P256SigningKey {
    var publicKeyDER: Data { get }
    func derSignature(for data: Data) throws -> Data
}
extension P256.Signing.PrivateKey: P256SigningKey {
    var publicKeyDER: Data { publicKey.derRepresentation }
    func derSignature(for data: Data) throws -> Data { try signature(for: data).derRepresentation }
}
extension SecureEnclave.P256.Signing.PrivateKey: P256SigningKey {
    var publicKeyDER: Data { publicKey.derRepresentation }
    func derSignature(for data: Data) throws -> Data { try signature(for: data).derRepresentation }
}

protocol DeviceKeyStore {
    func key(for account: String) throws -> DeviceKey
}

/// One key per account and server, so installations are not linkable across accounts.
/// Secure Enclave keys never leave the device; the Keychain holds only an encrypted handle.
struct KeychainDeviceKeys: DeviceKeyStore {
    let service: String
    private static let enclave: UInt8 = 1, software: UInt8 = 0

    func key(for account: String) throws -> DeviceKey {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: "device-key." + account]
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        if SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data, let key = try? Self.restore(data) { return key }
        // A missing or unusable key starts a new device identity.
        let (key, data) = try Self.create()
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query.merging([
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]) { _, new in new } as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw APIError(status: 0, message: "Your secure device storage is unavailable. Unlock your device and try again.")
        }
        return key
    }

    private static func create() throws -> (DeviceKey, Data) {
        if SecureEnclave.isAvailable {
            let key = try SecureEnclave.P256.Signing.PrivateKey()
            return (DeviceKey(key), Data([enclave]) + key.dataRepresentation)
        }
        let key = P256.Signing.PrivateKey()
        return (DeviceKey(key), Data([software]) + key.rawRepresentation)
    }

    private static func restore(_ data: Data) throws -> DeviceKey {
        let body = Data(data.dropFirst())
        switch data.first {
        case enclave: return DeviceKey(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: body))
        case software: return DeviceKey(try P256.Signing.PrivateKey(rawRepresentation: body))
        default: throw CryptoKitError.incorrectParameterSize
        }
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
