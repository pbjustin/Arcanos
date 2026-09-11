import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Only the existing GPT Access operations used by this client are exposed. There is no
/// arbitrary URL/header proxy, shell endpoint, or Local Agent executor-protocol access.
public actor GatewayClient {
    public let baseURL: URL
    private let credentials: any GatewayCredentialProvider
    private let transport: any GatewayTransport
    private let now: @Sendable () -> Date

    public init(
        baseURL: URL,
        credentials: any GatewayCredentialProvider,
        transport: any GatewayTransport = URLSessionGatewayTransport(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) throws {
        guard let components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https", components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            throw GatewayError.invalidConfiguration
        }
        self.baseURL = try DeviceAuthentication.origin(baseURL)
        self.credentials = credentials
        self.transport = transport
        self.now = now
    }

    public func createJob(_ request: CreateAIJobRequest) async throws -> CreateAIJobResponse {
        let response: CreateAIJobResponse = try await send(
            path: "/gpt-access/jobs/create", method: "POST", body: encode(request), accepted: [202]
        )
        guard response.ok, UUID(uuidString: response.jobId) != nil,
              ["queued", "running", "completed", "failed"].contains(response.status),
              response.resultEndpoint == "/gpt-access/jobs/result" else { throw GatewayError.invalidResponse }
        return response
    }

    public func jobResult(_ request: JobResultRequest) async throws -> JobResultResponse {
        guard UUID(uuidString: request.jobId) != nil else { throw GatewayError.invalidRequest }
        let response: JobResultResponse = try await send(
            path: "/gpt-access/jobs/result", method: "POST", body: encode(request), accepted: [200]
        )
        guard response.ok, response.jobId == request.jobId,
              ["pending", "completed", "failed", "expired", "not_found"].contains(response.status),
              response.resultEndpoint == "/gpt-access/jobs/result" else { throw GatewayError.invalidResponse }
        return response
    }

    public func listCapabilities() async throws -> CapabilitiesV1Response {
        let response: CapabilitiesV1Response = try await send(path: "/gpt-access/capabilities/v1", method: "GET", accepted: [200])
        guard response.ok else { throw GatewayError.invalidResponse }
        return response
    }

    public func capability(id: String) async throws -> CapabilityV1DetailResponse {
        try Self.validateCapabilityID(id)
        let response: CapabilityV1DetailResponse = try await send(
            path: "/gpt-access/capabilities/v1/\(id)", method: "GET", accepted: [200]
        )
        guard response.ok, response.exists == (response.capability != nil),
              response.capability == nil || response.capability?.id == id else { throw GatewayError.invalidResponse }
        return response
    }

    public func invoke(_ prepared: PreparedCapabilityRequest, confirmationToken: String? = nil) async throws -> CapabilityRunResponse {
        let response: CapabilityRunResponse = try await send(
            path: "/gpt-access/capabilities/v1/\(prepared.capabilityID)/run",
            method: "POST", body: prepared.body(confirmationToken: confirmationToken),
            idempotencyKey: prepared.idempotencyKey, accepted: [200]
        )
        guard response.ok else { throw GatewayError.invalidResponse }
        return response
    }

    public func deviceSession() async throws -> DeviceSessionResponse {
        let response: DeviceSessionResponse = try await send(path: "/gpt-access/devices/session", method: "GET", accepted: [200])
        try DeviceAuthentication.validate(response, origin: baseURL, now: Date())
        return response
    }

    func renewDeviceCredential() async throws -> DeviceCredentialResponse {
        try await send(path: "/gpt-access/devices/renew", method: "POST", body: encode(DeviceRenewRequest()), accepted: [200])
    }

    func revokeDevice(_ deviceID: String) async throws -> DeviceRevokeResponse {
        guard UUID(uuidString: deviceID) != nil else { throw GatewayError.invalidRequest }
        let response: DeviceRevokeResponse = try await send(
            path: "/gpt-access/devices/\(deviceID)/revoke", method: "POST", body: encode(DeviceRevokeRequest()), accepted: [200])
        guard response.ok, response.deviceId == deviceID, response.state == "revoked" else { throw GatewayError.invalidResponse }
        return response
    }

    static func validateCapabilityID(_ id: String) throws {
        guard !id.isEmpty, id.utf8.count <= 128,
              id.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 58, 95].contains($0) }) else {
            throw GatewayError.invalidRequest
        }
    }

    private func encode<T: Encodable>(_ request: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }

    private func send<T: Decodable & Sendable>(
        path: String, method: String, body: Data? = nil,
        idempotencyKey: String? = nil, accepted: Set<Int>
    ) async throws -> T {
        try Task.checkCancellation()
        guard body == nil || body!.count <= 1_048_576,
              let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw GatewayError.invalidRequest }
        guard let credential = try await credentials.credential(for: baseURL) else { throw GatewayError.unpaired }
        guard credential.expiresAt > now() else { throw GatewayError.credentialExpired }
        guard let credentialOrigin = URLComponents(url: credential.origin, resolvingAgainstBaseURL: false),
              credentialOrigin.scheme?.lowercased() == baseURL.scheme?.lowercased(),
              credentialOrigin.host?.lowercased() == baseURL.host?.lowercased(),
              (credentialOrigin.port ?? 443) == (baseURL.port ?? 443),
              credentialOrigin.user == nil, credentialOrigin.password == nil,
              credentialOrigin.query == nil, credentialOrigin.fragment == nil,
              credentialOrigin.path.isEmpty || credentialOrigin.path == "/",
              !credential.token.isEmpty, credential.token.utf8.count <= 4096,
              credential.token.utf8.allSatisfy({ (33...126).contains($0) }) else {
            throw GatewayError.invalidConfiguration
        }
        var headers = [
            "Authorization": "Bearer \(credential.token)",
            "X-Arcanos-Device-Origin": baseURL.absoluteString,
            "Accept": "application/json",
            "Cache-Control": "no-store"
        ]
        if body != nil { headers["Content-Type"] = "application/json" }
        if let idempotencyKey { headers["Idempotency-Key"] = idempotencyKey }
        let response: GatewayResponse
        do {
            // Credential lookup can suspend. Cancellation must stop a request before transmission.
            try Task.checkCancellation()
            response = try await transport.send(GatewayRequest(url: url, method: method, headers: headers, body: body))
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as GatewayError {
            throw error
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw GatewayError.unavailable
        }
        // A delivered success may acknowledge a durable job. Finish validating it even if
        // cancellation arrived during transport; discarding it would lose the accepted job handle.
        guard response.data.count <= 2_097_152 else { throw GatewayError.invalidResponse }
        guard !(300...399).contains(response.statusCode) else { throw GatewayError.redirectRejected }
        let decoder = JSONDecoder()
        if !accepted.contains(response.statusCode) {
            // Cancellation must not leave a new approval challenge waiting for a later retry.
            try Task.checkCancellation()
            if response.statusCode == 403,
               let confirmation = try? decoder.decode(ConfirmationRequiredResponse.self, from: response.data),
               confirmation.code == "CONFIRMATION_REQUIRED", confirmation.confirmationRequired {
                let challenge = confirmation.confirmationChallenge
                guard !challenge.id.isEmpty, challenge.id.utf8.count <= 4096,
                      challenge.id.utf8.allSatisfy({ (33...126).contains($0) }),
                      confirmation.endpoint == nil || confirmation.endpoint == path,
                      confirmation.method == nil || confirmation.method == method else { throw GatewayError.invalidResponse }
                throw GatewayError.confirmationRequired(challenge)
            }
            let envelope = try? decoder.decode(ErrorResponse.self, from: response.data)
            let code = envelope?.error.code ?? "UNKNOWN_API_ERROR"
            let safeCode = code.utf8.count <= 100 && code.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) || $0 == 95 })
                ? code : "UNKNOWN_API_ERROR"
            if let error = GatewayError.authenticationError(status: response.statusCode, code: safeCode) {
                await credentials.rejectedCredential(credential.token, for: baseURL, error: error)
                throw error
            }
            throw GatewayError.http(status: response.statusCode, code: safeCode)
        }
        do { return try decoder.decode(T.self, from: response.data) }
        catch { throw GatewayError.invalidResponse }
    }
}
