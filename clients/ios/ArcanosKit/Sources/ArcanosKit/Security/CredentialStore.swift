import Foundation
#if canImport(Security)
import Security
#endif

/// A single item's replacement must be atomic. Tests inject an in-memory implementation;
/// the shipping app uses only Apple Keychain and never UserDefaults/files for secrets.
public protocol CredentialItemStorage: Sendable {
    func read(account: String) throws -> Data?
    func replace(account: String, data: Data) throws
    func remove(account: String) throws
}

public struct AppleKeychainItemStorage: CredentialItemStorage {
    private let service: String
    public init(service: String = "org.arcanos.voice.credentials") { self.service = service }

    public func read(account: String) throws -> Data? {
        #if canImport(Security)
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw CredentialStoreError.lockedOrUnavailable }
        return data
        #else
        throw CredentialStoreError.unsupportedPlatform
        #endif
    }

    public func replace(account: String, data: Data) throws {
        #if canImport(Security)
        let query = baseQuery(account)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var new = query
            attributes.forEach { new[$0.key] = $0.value }
            guard SecItemAdd(new as CFDictionary, nil) == errSecSuccess else { throw CredentialStoreError.lockedOrUnavailable }
        } else if status != errSecSuccess { throw CredentialStoreError.lockedOrUnavailable }
        #else
        throw CredentialStoreError.unsupportedPlatform
        #endif
    }

    public func remove(account: String) throws {
        #if canImport(Security)
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialStoreError.lockedOrUnavailable }
        #else
        throw CredentialStoreError.unsupportedPlatform
        #endif
    }

    #if canImport(Security)
    private func baseQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
    }
    #endif
}

public actor KeychainCredentialStore: GatewayCredentialProvider {
    struct CredentialChange: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
        let id: UUID
        let origin: URL
        let expectedToken: String?
        let credential: GatewayCredential?
        let deviceID: String?
        var description: String { "CredentialChange(<redacted>)" }
        var debugDescription: String { description }
    }
    private struct Record: Codable {
        let session: DeviceCredentialResponse
        var state: DeviceCredentialState
    }
    private let storage: any CredentialItemStorage
    private let now: @Sendable () -> Date
    private var blockedOrigins: Set<String> = []
    private var changes: [String: UUID] = [:]

    public init(service: String = "org.arcanos.voice.credentials") {
        storage = AppleKeychainItemStorage(service: service)
        now = { Date() }
    }

    public init(storage: any CredentialItemStorage, now: @escaping @Sendable () -> Date = { Date() }) {
        self.storage = storage
        self.now = now
    }

    /// Random installation identity is registration material, never authentication.
    /// It survives credential replacement and local forget; no hardware identifier is read.
    public func localIdentity(for origin: URL) throws -> String {
        let account = "identity:\(try DeviceAuthentication.origin(origin).absoluteString)"
        if let data = try storage.read(account: account) {
            guard let value = String(data: data, encoding: .utf8), UUID(uuidString: value) != nil else {
                throw CredentialStoreError.invalidRecord
            }
            return value
        }
        let value = UUID().uuidString.lowercased()
        try storage.replace(account: account, data: Data(value.utf8))
        return value
    }

    public func state(for origin: URL) throws -> DeviceCredentialState {
        let key = try DeviceAuthentication.origin(origin).absoluteString
        if blockedOrigins.contains(key) { return .authenticationFailure }
        guard let record = try read(origin) else { return .unpaired }
        if record.state != .paired && record.state != .renewalRequired { return record.state }
        guard let expires = DeviceAuthentication.date(record.session.expiresAt),
              let renewal = DeviceAuthentication.date(record.session.renewalExpiresAt) else { throw CredentialStoreError.invalidRecord }
        if expires <= now() { return .expired }
        if renewal <= now() || expires.timeIntervalSince(now()) <= 300 { return .renewalRequired }
        return record.state
    }

    public func credential(for origin: URL) async throws -> GatewayCredential? {
        try availableCredential(for: origin)
    }

    private func availableCredential(for origin: URL) throws -> GatewayCredential? {
        switch try state(for: origin) {
        case .unpaired: return nil
        case .expired: throw GatewayError.credentialExpired
        case .revoked: throw GatewayError.credentialRevoked
        case .authenticationFailure: throw GatewayError.authenticationFailure
        case .paired, .renewalRequired: break
        }
        guard let record = try read(origin), let expires = DeviceAuthentication.date(record.session.expiresAt) else {
            throw CredentialStoreError.invalidRecord
        }
        let credential = record.session.credential
        return GatewayCredential(token: credential, origin: try DeviceAuthentication.origin(origin), expiresAt: expires)
    }

    public func pairedDeviceID(for origin: URL) throws -> String? { try read(origin)?.session.deviceId }

    /// One SecItemUpdate replaces the complete old secret and metadata. Pairing tokens
    /// are never stored, and renewal creates no duplicate credential item.
    public func storePairedSession(_ session: DeviceCredentialResponse, for origin: URL) throws {
        let canonical = try DeviceAuthentication.origin(origin)
        guard changes[canonical.absoluteString] == nil else { throw GatewayError.invalidRequest }
        try persistSession(session, for: canonical)
    }

    private func persistSession(_ session: DeviceCredentialResponse, for canonical: URL) throws {
        try DeviceAuthentication.validate(session, origin: canonical, now: now())
        try storage.replace(account: account(canonical), data: JSONEncoder().encode(Record(session: session, state: .paired)))
        blockedOrigins.remove(canonical.absoluteString)
    }

    public func rejectedCredential(_ token: String, for origin: URL, error: GatewayError) async {
        // A delayed 401 from an old request cannot invalidate a rotated session.
        guard var record = try? read(origin), record.session.credential == token else { return }
        switch error {
        case .credentialExpired: record.state = .expired
        case .credentialRevoked: record.state = .revoked
        case .renewalRequired: record.state = .renewalRequired
        case .authenticationFailure: record.state = .authenticationFailure
        default: return
        }
        do {
            try storage.replace(account: account(origin), data: JSONEncoder().encode(record))
            blockedOrigins.remove(origin.absoluteString)
        }
        catch { blockedOrigins.insert(origin.absoluteString) }
    }

    /// Persist a fail-closed marker before rotation. A lost reply followed by a restart
    /// must not resurrect a possibly consumed old credential.
    func beginCredentialReplacement(_ change: CredentialChange) throws {
        try validateChange(change)
        guard var record = try read(change.origin) else { throw GatewayError.unpaired }
        record.state = .authenticationFailure
        try storage.replace(account: account(change.origin), data: JSONEncoder().encode(record))
        blockedOrigins.insert(change.origin.absoluteString)
    }

    /// A lease covers every suspended pairing/rotation step across all clients sharing
    /// this store. Credential and server device identity are captured in one actor turn.
    func beginSessionChange(for origin: URL, requiresCredential: Bool) throws -> CredentialChange {
        let canonical = try DeviceAuthentication.origin(origin)
        guard changes[canonical.absoluteString] == nil else { throw GatewayError.invalidRequest }
        let credential = requiresCredential ? try availableCredential(for: canonical) : nil
        if requiresCredential && credential == nil { throw GatewayError.unpaired }
        let record = try read(canonical)
        let change = CredentialChange(id: UUID(), origin: canonical,
            expectedToken: record?.session.credential, credential: credential, deviceID: record?.session.deviceId)
        changes[canonical.absoluteString] = change.id
        return change
    }

    func completeSessionChange(_ session: DeviceCredentialResponse, change: CredentialChange) throws {
        try validateChange(change)
        try persistSession(session, for: change.origin)
    }

    func endSessionChange(_ change: CredentialChange) {
        if changes[change.origin.absoluteString] == change.id { changes.removeValue(forKey: change.origin.absoluteString) }
    }

    private func validateChange(_ change: CredentialChange) throws {
        guard changes[change.origin.absoluteString] == change.id,
              try read(change.origin)?.session.credential == change.expectedToken else { throw GatewayError.invalidRequest }
    }

    public func removeCredential(for origin: URL) throws {
        let canonical = try DeviceAuthentication.origin(origin)
        guard changes[canonical.absoluteString] == nil else { throw GatewayError.invalidRequest }
        try storage.remove(account: account(canonical))
        blockedOrigins.remove(canonical.absoluteString)
    }

    private func account(_ origin: URL) -> String { "session:\(origin.absoluteString)" }

    private func read(_ origin: URL) throws -> Record? {
        let canonical = try DeviceAuthentication.origin(origin)
        guard let data = try storage.read(account: account(canonical)) else { return nil }
        guard let record = try? JSONDecoder().decode(Record.self, from: data), record.session.origin == canonical.absoluteString else {
            throw CredentialStoreError.invalidRecord
        }
        return record
    }
}

public enum CredentialStoreError: Error, Sendable {
    case unsupportedPlatform, lockedOrUnavailable, invalidRecord
}

enum DeviceAuthentication {
    static func origin(_ url: URL) throws -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https", components.host?.isEmpty == false,
              components.user == nil, components.password == nil, components.query == nil,
              components.fragment == nil, ["", "/"].contains(components.path) else { throw GatewayError.invalidConfiguration }
        components.scheme = "https"
        components.host = components.host?.lowercased()
        components.path = ""
        if components.port == 443 { components.port = nil }
        guard let result = components.url else { throw GatewayError.invalidConfiguration }
        return result
    }

    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func validToken(_ value: String, prefix: String) -> Bool {
        value.hasPrefix(prefix) && value.utf8.count == prefix.utf8.count + 43
            && value.dropFirst(prefix.count).utf8.allSatisfy {
                (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
            }
    }

    static func validate(_ value: DeviceCredentialResponse, origin: URL, now: Date) throws {
        guard value.ok, validToken(value.credential, prefix: "agd1.") else { throw GatewayError.invalidResponse }
        try validateMetadata(deviceID: value.deviceId, tokenType: value.tokenType, audience: value.audience,
            serverOrigin: value.origin, issuedAt: value.issuedAt, expiresAt: value.expiresAt, renewalExpiresAt: value.renewalExpiresAt,
            scopes: value.scopes, actions: value.capabilityActions, gptIDs: value.gptIds, origin: origin, now: now)
    }

    static func validate(_ value: DeviceSessionResponse, origin: URL, now: Date) throws {
        guard value.ok, ["paired", "renewal_required"].contains(value.state) else { throw GatewayError.invalidResponse }
        try validateMetadata(deviceID: value.deviceId, tokenType: value.tokenType, audience: value.audience,
            serverOrigin: value.origin, issuedAt: value.issuedAt, expiresAt: value.expiresAt, renewalExpiresAt: value.renewalExpiresAt,
            scopes: value.scopes, actions: value.capabilityActions, gptIDs: value.gptIds, origin: origin, now: now)
    }

    private static func validateMetadata(deviceID: String, tokenType: String, audience: String,
        serverOrigin: String, issuedAt: String, expiresAt: String, renewalExpiresAt: String,
        scopes: [String], actions: [String], gptIDs: [String], origin: URL, now: Date) throws {
        guard UUID(uuidString: deviceID) != nil, tokenType == "Bearer", audience == "gpt-access-device-v1",
              serverOrigin == origin.absoluteString,
              let issued = date(issuedAt), let expires = date(expiresAt), let renewal = date(renewalExpiresAt),
              issued <= now.addingTimeInterval(300), expires > now, expires > issued,
              expires.timeIntervalSince(issued) <= 3_600, renewal > issued, renewal >= expires,
              renewal.timeIntervalSince(issued) <= 30 * 24 * 3_600,
              (1...4).contains(scopes.count), Set(scopes).count == scopes.count,
              Set(scopes).isSubset(of: ["jobs.create", "jobs.result", "capabilities.read", "capabilities.run"]),
              actions.count <= 4, Set(actions).count == actions.count,
              Set(actions).isSubset(of: ["git.status", "tests.run", "patch.preview", "patch.apply"]),
              gptIDs == ["arcanos-core"] else { throw GatewayError.invalidResponse }
    }
}
