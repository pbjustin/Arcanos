import Foundation

/// Interface for the paired-device issuer. Never supply the generic GPT Access master
/// credential or the separate Local Agent executor credential through an iPhone provider.
public protocol GatewayCredentialProvider: Sendable {
    func credential(for origin: URL) async throws -> GatewayCredential?
    func rejectedCredential(_ token: String, for origin: URL, error: GatewayError) async
}

public extension GatewayCredentialProvider {
    func rejectedCredential(_ token: String, for origin: URL, error: GatewayError) async {}
}

public enum DeviceCredentialState: String, Codable, Equatable, Sendable {
    case unpaired, paired, expired, revoked
    case renewalRequired = "renewal_required"
    case authenticationFailure = "authentication_failure"

    public var message: String {
        switch self {
        case .unpaired: "Pair this iPhone from a trusted ARCANOS operator session."
        case .paired: "This iPhone is paired with ARCANOS."
        case .expired: "The device credential expired. Pair again to reconnect."
        case .revoked: "This device was revoked. Pair again with operator approval."
        case .renewalRequired: "Renew before credential expiry. The pairing window may require pairing again."
        case .authenticationFailure: "Device authentication failed. Pair again to reconnect."
        }
    }
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
    case credentialRevoked
    case renewalRequired
    case authenticationFailure
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
        case .credentialRevoked: "This ARCANOS device was revoked. Pair again with operator approval."
        case .renewalRequired: "The ARCANOS pairing renewal window ended. Pair again to reconnect."
        case .authenticationFailure: "ARCANOS rejected device authentication. Pair again to reconnect."
        case .invalidConfiguration: "The ARCANOS Gateway configuration is invalid."
        case .invalidRequest: "This ARCANOS request is incomplete or unsupported."
        case .unavailable: "ARCANOS could not reach the Gateway. No remote completion was confirmed."
        case .invalidResponse: "ARCANOS received an unsupported Gateway response. No completion was confirmed."
        case .redirectRejected: "The Gateway redirected the request. Recheck the paired server address."
        case .confirmationRequired: "ARCANOS needs your explicit approval before continuing."
        case .http(let status, let code):
            switch code {
            case "PAIRING_EXPIRED": "The pairing token expired. Create a new one in the trusted operator context."
            case "PAIRING_USED": "The pairing token was already used. Create a new one in the trusted operator context."
            case "PAIRING_INVALID": "The pairing token was rejected. Check the trusted Gateway and obtain a new pairing token."
            case "DEVICE_AUTH_UNAVAILABLE": "The Gateway's device authentication service is unavailable. No remote completion was confirmed."
            default:
                status == 401 ? "The ARCANOS device session was rejected. Pair again to reconnect."
                    : status == 403 ? "This device is not authorized for that ARCANOS operation."
                    : "The Gateway could not complete this request. No remote completion was confirmed."
            }
        }
    }

    static func authenticationError(status: Int, code: String) -> GatewayError? {
        guard status == 401 || status == 403 else { return nil }
        switch code {
        case "DEVICE_CREDENTIAL_EXPIRED": return .credentialExpired
        case "DEVICE_REVOKED": return .credentialRevoked
        case "DEVICE_RENEWAL_REQUIRED": return .renewalRequired
        case "DEVICE_AUTH_REQUIRED", "DEVICE_AUTH_INVALID", "DEVICE_ORIGIN_DENIED": return .authenticationFailure
        default: return status == 401 ? .authenticationFailure : nil
        }
    }
}
