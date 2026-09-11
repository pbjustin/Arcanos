import Foundation
#if canImport(Security)
import Security
#endif

/// A future pairing broker supplies this store. There is deliberately no master-token UI.
/// Credentials are tied to one HTTPS origin and expire; nothing is synced through iCloud.
public actor KeychainCredentialStore: GatewayCredentialProvider {
    private struct Record: Codable {
        let token: String
        let origin: URL
        let expiresAt: Date
    }
    private let service: String
    public init(service: String = "org.arcanos.voice.credentials") { self.service = service }

    public func credential(for origin: URL) async throws -> GatewayCredential? {
        #if canImport(Security)
        var query = try baseQuery(origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw CredentialStoreError.lockedOrUnavailable }
        guard let record = try? JSONDecoder().decode(Record.self, from: data), record.origin == origin else {
            throw CredentialStoreError.invalidRecord
        }
        guard record.expiresAt > Date() else { throw GatewayError.credentialExpired }
        let value = record.token
        return GatewayCredential(token: value, origin: record.origin, expiresAt: record.expiresAt)
        #else
        throw CredentialStoreError.unsupportedPlatform
        #endif
    }

    /// Integration seam only: accept ONLY an origin-bound, scoped device credential issued by the
    /// future authenticated pairing flow. Keychain storage cannot turn a master token into one.
    public func storePairedCredential(token: String, origin: URL, expiresAt: Date) throws {
        guard !token.isEmpty, !token.contains("\r"), !token.contains("\n"), expiresAt > Date() else {
            throw CredentialStoreError.invalidRecord
        }
        #if canImport(Security)
        let query = try baseQuery(origin)
        let data = try JSONEncoder().encode(Record(token: token, origin: origin, expiresAt: expiresAt))
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecItemNotFound {
            var new = query
            attributes.forEach { new[$0.key] = $0.value }
            guard SecItemAdd(new as CFDictionary, nil) == errSecSuccess else { throw CredentialStoreError.lockedOrUnavailable }
        } else if update != errSecSuccess { throw CredentialStoreError.lockedOrUnavailable }
        #else
        throw CredentialStoreError.unsupportedPlatform
        #endif
    }

    public func removeCredential(for origin: URL) throws {
        #if canImport(Security)
        let status = SecItemDelete(try baseQuery(origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialStoreError.lockedOrUnavailable }
        #else
        throw CredentialStoreError.unsupportedPlatform
        #endif
    }

    #if canImport(Security)
    private func baseQuery(_ origin: URL) throws -> [String: Any] {
        guard origin.scheme == "https", origin.host != nil, origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path) else {
            throw CredentialStoreError.invalidRecord
        }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: origin.absoluteString, kSecAttrSynchronizable as String: false]
    }
    #endif
}

public enum CredentialStoreError: Error, Sendable {
    case unsupportedPlatform, lockedOrUnavailable, invalidRecord
}
