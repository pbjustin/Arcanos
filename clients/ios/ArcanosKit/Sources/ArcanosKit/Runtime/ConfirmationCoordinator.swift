import Foundation

public struct PendingApproval: Sendable {
    /// Local opaque handle, never the Gateway challenge token.
    public let id: UUID
    public let summary: String
}

public enum ConfirmationOutcome: Sendable {
    case response(CapabilityRunResponse)
    case approval(PendingApproval)
}

public enum ConfirmationError: Error, Sendable {
    case notPending
    case expired
    case repeatedChallenge
    case busy
}

/// Memory-only. Termination, cancellation, expiry, failures, and uncertain delivery fail closed.
/// An approval consumes its handle BEFORE suspension, so concurrent approvals cannot retry twice.
public actor ConfirmationCoordinator {
    private struct Pending {
        let approval: PendingApproval
        let request: PreparedCapabilityRequest
        let challengeID: String
        let expiresAt: Date
    }
    private let capabilities: CapabilityClient
    private let now: @Sendable () -> Date
    private var pending: Pending?
    private var inFlight = false

    public init(capabilities: CapabilityClient, now: @escaping @Sendable () -> Date = { Date() }) {
        self.capabilities = capabilities
        self.now = now
    }

    public func submit(_ request: PreparedCapabilityRequest, summary: String) async throws -> ConfirmationOutcome {
        guard !inFlight, pending == nil else { throw ConfirmationError.busy }
        inFlight = true
        defer { inFlight = false }
        do { return .response(try await capabilities.invoke(request)) }
        catch GatewayError.confirmationRequired(let challenge) {
            try Task.checkCancellation()
            guard !challenge.id.isEmpty else { throw GatewayError.invalidResponse }
            // A malformed expiry is not permission to prolong a server challenge.
            let expires: Date
            if let value = challenge.expiresAt {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let fractional = formatter.date(from: value)
                formatter.formatOptions = [.withInternetDateTime]
                guard let parsed = fractional ?? formatter.date(from: value) else { throw GatewayError.invalidResponse }
                expires = min(parsed, now().addingTimeInterval(120))
            } else {
                // Server remains authoritative; client conservatively caps the default lifetime.
                expires = now().addingTimeInterval(120)
            }
            guard expires > now() else { throw ConfirmationError.expired }
            let approval = PendingApproval(id: UUID(), summary: summary)
            pending = Pending(approval: approval, request: request, challengeID: challenge.id, expiresAt: expires)
            return .approval(approval)
        }
    }

    /// Call only after a successful explicit system approval, never from AI output or phrase parsing.
    public func approve(_ id: UUID) async throws -> CapabilityRunResponse {
        guard let stored = pending, stored.approval.id == id else { throw ConfirmationError.notPending }
        pending = nil
        guard stored.expiresAt > now() else { throw ConfirmationError.expired }
        guard !inFlight else { throw ConfirmationError.busy }
        inFlight = true
        defer { inFlight = false }
        try Task.checkCancellation()
        do {
            return try await capabilities.invoke(stored.request, confirmationToken: stored.challengeID)
        } catch GatewayError.confirmationRequired {
            // Do not store this challenge and never recurse or issue a third request.
            throw ConfirmationError.repeatedChallenge
        }
    }

    @discardableResult public func cancel(_ id: UUID) -> Bool {
        guard pending?.approval.id == id else { return false }
        pending = nil
        return true
    }
}
