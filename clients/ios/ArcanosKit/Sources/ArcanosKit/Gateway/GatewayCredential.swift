import Foundation

/// Interface for a future paired-device issuer. Never supply the generic GPT Access master
/// credential or the separate Local Agent executor credential through an iPhone provider.
public protocol GatewayCredentialProvider: Sendable {
    func credential(for origin: URL) async throws -> GatewayCredential?
}

public struct GatewayCredential: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let token: String
    public let origin: URL
    public let expiresAt: Date

    public init(token: String, origin: URL, expiresAt: Date) {
        self.token = token
        self.origin = origin
        self.expiresAt = expiresAt
    }

    public var description: String { "GatewayCredential(<redacted>)" }
    public var debugDescription: String { description }
}

public enum GatewayError: Error, Equatable, Sendable, LocalizedError {
    case unpaired
    case credentialExpired
    case invalidConfiguration
    case invalidRequest
    case unavailable
    case invalidResponse
    case redirectRejected
    case confirmationRequired(ConfirmationChallenge)
    case http(status: Int, code: String)

    /// Fixed messages avoid reflecting user payloads, server exception text, URLs or tokens.
    public var errorDescription: String? { userFacingMessage }
    public var userFacingMessage: String {
        switch self {
        case .unpaired: "This iPhone is not paired with an ARCANOS device session."
        case .credentialExpired: "The ARCANOS device session has expired. Pair again to reconnect."
        case .invalidConfiguration: "The ARCANOS Gateway configuration is invalid."
        case .invalidRequest: "This ARCANOS request is incomplete or unsupported."
        case .unavailable: "ARCANOS could not reach the Gateway. No remote completion was confirmed."
        case .invalidResponse: "ARCANOS received an unsupported Gateway response. No completion was confirmed."
        case .redirectRejected: "The Gateway redirected the request. Recheck the paired server address."
        case .confirmationRequired: "ARCANOS needs your explicit approval before continuing."
        case .http(let status, _):
            status == 401 ? "The ARCANOS device session was rejected. Pair again to reconnect."
                : status == 403 ? "This device is not authorized for that ARCANOS operation."
                : "The Gateway could not complete this request. No remote completion was confirmed."
        }
    }
}
