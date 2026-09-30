import Foundation
import Security

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
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data else { throw failure() }
        return try JSONDecoder().decode(SavedSession.self, from: data)
    }

    func save(_ session: SavedSession) throws {
        let values: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(session),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
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

