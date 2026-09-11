import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The phone can consume an operator-created challenge, inspect its session, renew,
/// and revoke itself. No operator pairing-creation or device-administration API exists here.
public actor DevicePairingClient {
    public let origin: URL
    private let store: KeychainCredentialStore
    private let transport: any GatewayTransport
    private var changingCredential = false

    public init(origin: URL, store: KeychainCredentialStore,
                transport: any GatewayTransport = URLSessionGatewayTransport()) throws {
        self.origin = try DeviceAuthentication.origin(origin)
        self.store = store
        self.transport = transport
    }

    public func pair(pairingToken: String) async throws {
        guard DeviceAuthentication.validToken(pairingToken, prefix: "agp1.") else { throw GatewayError.invalidRequest }
        try await withSessionChange(requiresCredential: false) { change in
            try await exchangePairing(pairingToken: pairingToken, change: change)
        }
    }

    private func exchangePairing(pairingToken: String, change: KeychainCredentialStore.CredentialChange) async throws {
        let identity = try await store.localIdentity(for: origin)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let body = try encoder.encode(DevicePairRequest(pairingToken: pairingToken, localIdentity: identity))
        let url = origin.appendingPathComponent("gpt-access/devices/pair")
        let response: GatewayResponse
        do {
            try Task.checkCancellation()
            response = try await transport.send(GatewayRequest(url: url, method: "POST", headers: [
                "X-Arcanos-Device-Origin": origin.absoluteString, "Content-Type": "application/json",
                "Accept": "application/json", "Cache-Control": "no-store"
            ], body: body))
        } catch is CancellationError { throw CancellationError() }
        catch let error as GatewayError { throw error }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch { throw GatewayError.unavailable }
        guard response.data.count <= 65_536 else { throw GatewayError.invalidResponse }
        guard !(300...399).contains(response.statusCode) else { throw GatewayError.redirectRejected }
        guard response.statusCode == 200 || response.statusCode == 201 else {
            let envelope = try? JSONDecoder().decode(ErrorResponse.self, from: response.data)
            let code = envelope?.error.code ?? "PAIRING_INVALID"
            let allowed = ["PAIRING_INVALID", "PAIRING_EXPIRED", "PAIRING_USED", "DEVICE_ORIGIN_DENIED", "DEVICE_AUTH_UNAVAILABLE"]
            throw GatewayError.http(status: response.statusCode, code: allowed.contains(code) ? code : "PAIRING_INVALID")
        }
        guard let session = try? JSONDecoder().decode(DeviceCredentialResponse.self, from: response.data) else {
            throw GatewayError.invalidResponse
        }
        // An accepted pairing is saved even if cancellation arrived with its successful reply.
        // The one-use bootstrap secret never reaches persistent storage.
        try await store.completeSessionChange(session, change: change)
    }

    public func inspect() async throws -> DeviceSessionResponse {
        let response = try await GatewayClient(baseURL: origin, credentials: store, transport: transport).deviceSession()
        guard response.deviceId == (try await store.pairedDeviceID(for: origin)) else { throw GatewayError.invalidResponse }
        return response
    }

    public func renew() async throws {
        try await withSessionChange(requiresCredential: true) { change in
            guard let credential = change.credential, let deviceID = change.deviceID else { throw GatewayError.unpaired }
            try Task.checkCancellation()
            try await store.beginCredentialReplacement(change)
            let gateway = try GatewayClient(baseURL: origin, credentials: CapturedCredential(credential: credential, store: store), transport: transport)
            let replacement = try await gateway.renewDeviceCredential()
            guard replacement.deviceId == deviceID, replacement.credential != credential.token else { throw GatewayError.invalidResponse }
            try await store.completeSessionChange(replacement, change: change)
        }
    }

    public func revoke() async throws {
        try await withSessionChange(requiresCredential: true) { change in
            guard let credential = change.credential, let deviceID = change.deviceID else { throw GatewayError.unpaired }
            try Task.checkCancellation()
            try await store.beginCredentialReplacement(change)
            let gateway = try GatewayClient(baseURL: origin, credentials: CapturedCredential(credential: credential, store: store), transport: transport)
            _ = try await gateway.revokeDevice(deviceID)
            await store.rejectedCredential(credential.token, for: origin, error: .credentialRevoked)
        }
    }

    private func withSessionChange(requiresCredential: Bool,
        operation: (KeychainCredentialStore.CredentialChange) async throws -> Void) async throws {
        guard !changingCredential else { throw GatewayError.invalidRequest }
        changingCredential = true
        defer { changingCredential = false }
        try Task.checkCancellation()
        let change = try await store.beginSessionChange(for: origin, requiresCredential: requiresCredential)
        do {
            try await operation(change)
            await store.endSessionChange(change)
        } catch {
            // Release is awaited even on cancellation; no unstructured cleanup task can
            // race a later pairing or accidentally clear another operation's lease.
            await store.endSessionChange(change)
            throw error
        }
    }
}

private struct CapturedCredential: GatewayCredentialProvider {
    let credential: GatewayCredential
    let store: KeychainCredentialStore
    func credential(for origin: URL) async throws -> GatewayCredential? { credential }
    func rejectedCredential(_ token: String, for origin: URL, error: GatewayError) async {
        await store.rejectedCredential(token, for: origin, error: error)
    }
}
