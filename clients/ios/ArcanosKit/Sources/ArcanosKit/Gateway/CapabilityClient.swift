import Foundation

/// Frozen original operation. Its encoded body is never reconstructed on an approval retry.
public struct PreparedCapabilityRequest: Sendable {
    public let capabilityID: String
    public let action: String
    public let payload: JSONValue
    public let idempotencyKey: String
    private let encodedBody: Data

    fileprivate init(capabilityID: String, action: String, payload: JSONValue, idempotencyKey: String, encodedBody: Data) {
        self.capabilityID = capabilityID
        self.action = action
        self.payload = payload
        self.idempotencyKey = idempotencyKey
        self.encodedBody = encodedBody
    }

    func body(confirmationToken: String?) throws -> Data {
        guard let confirmationToken else { return encodedBody }
        guard !confirmationToken.isEmpty, confirmationToken.utf8.count <= 4096,
              confirmationToken.utf8.allSatisfy({ (33...126).contains($0) }),
              encodedBody.last == 125 else { throw GatewayError.invalidRequest }
        // Add the only permitted field, preserving every byte of original action/payload.
        var body = Data(encodedBody.dropLast())
        body.append(Data(",\"confirmation_token\":".utf8))
        body.append(try JSONEncoder().encode(confirmationToken))
        body.append(125)
        return body
    }
}

public struct CapabilityClient: Sendable {
    private let gateway: GatewayClient

    public init(gateway: GatewayClient) { self.gateway = gateway }

    public func list() async throws -> CapabilitiesV1Response { try await gateway.listCapabilities() }
    public func detail(id: String) async throws -> CapabilityV1DetailResponse { try await gateway.capability(id: id) }

    public func prepare(
        id: String, action: String, payload: JSONValue,
        idempotencyKey: String = UUID().uuidString
    ) throws -> PreparedCapabilityRequest {
        try GatewayClient.validateCapabilityID(id)
        guard !action.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              action == action.trimmingCharacters(in: .whitespacesAndNewlines),
              !action.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              action.utf8.count <= 256,
              !idempotencyKey.isEmpty, idempotencyKey.utf8.count <= 240,
              idempotencyKey.utf8.allSatisfy({ (33...126).contains($0) }) else { throw GatewayError.invalidRequest }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let body = try encoder.encode(CapabilityRunRequest(action: action, payload: payload))
        guard body.count <= 1_048_576 else { throw GatewayError.invalidRequest }
        return PreparedCapabilityRequest(capabilityID: id, action: action, payload: payload, idempotencyKey: idempotencyKey, encodedBody: body)
    }

    /// Call through ConfirmationCoordinator for user-facing actions. This transport never
    /// automatically approves/retries; the coordinator owns the explicit one-use decision.
    public func invoke(_ prepared: PreparedCapabilityRequest, confirmationToken: String? = nil) async throws -> CapabilityRunResponse {
        try await gateway.invoke(prepared, confirmationToken: confirmationToken)
    }
}
