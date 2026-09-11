import Foundation
#if canImport(OSLog)
import OSLog
#endif

public enum LocalTask: String, Sendable { case greeting, summarize, transform, recall }

public struct RouteDecision: Sendable, Equatable {
    public enum Destination: String, Sendable { case local, remote }
    public enum Reason: String, Sendable {
        case boundedLocalTask, modelUnavailable, localFailure, requiresGateway, insufficientContext
    }
    public let destination: Destination
    public let reason: Reason
    public let task: LocalTask?
}

/// This allowlist decides locality. Model output never grants tool access or approval.
public enum RoutingPolicy {
    public static func normalize(_ command: String) -> String {
        command.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".!?"))
    }

    public static func localTask(for request: AIRequest) -> LocalTask? {
        let command = normalize(request.command)
        if ["hello", "hi", "hey arcanos", "hello arcanos"].contains(command) { return .greeting }
        // Exact commands prevent a prefix like "summarize ... and apply a patch" becoming local.
        if ["summarize this note", "summarize my note", "summarize this", "summarize the note"].contains(command) {
            return .summarize
        }
        if ["rewrite this note", "make this note shorter", "turn this note into bullet points"].contains(command) {
            return .transform
        }
        if ["what did i just capture", "read my note", "read this note"].contains(command) { return .recall }
        return nil
    }

    public static func decide(_ request: AIRequest, localAvailability: AIAvailability) -> RouteDecision {
        guard let task = localTask(for: request) else {
            return RouteDecision(destination: .remote, reason: .requiresGateway, task: nil)
        }
        if task != .greeting {
            guard let context = request.localContext,
                  !context.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  context.utf8.count <= 8_000 else {
                return RouteDecision(destination: .remote, reason: .insufficientContext, task: task)
            }
        }
        guard localAvailability == .available else {
            return RouteDecision(destination: .remote, reason: .modelUnavailable, task: task)
        }
        return RouteDecision(destination: .local, reason: .boundedLocalTask, task: task)
    }
}

public actor AIRouter: ArcanosAI {
    private let local: any ArcanosAI
    private let remote: any ArcanosAI
    private let audit: (@Sendable (RouteDecision) -> Void)?

    public init(local: any ArcanosAI = LocalAI(), remote: any ArcanosAI = UnavailableRemoteAI(),
                audit: (@Sendable (RouteDecision) -> Void)? = nil) {
        self.local = local
        self.remote = remote
        self.audit = audit
    }

    public func availability() async -> AIAvailability {
        if await local.availability() == .available { return .available }
        return await remote.availability()
    }

    public func respond(to request: AIRequest) async throws -> AIResponse {
        guard !request.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              request.command.utf8.count <= 8_000 else { throw AIError.invalidInput }
        let decision = RoutingPolicy.decide(request, localAvailability: await local.availability())
        record(decision)
        if decision.destination == .local {
            do { return try await local.respond(to: request) }
            catch is CancellationError { throw CancellationError() }
            catch {
                try Task.checkCancellation()
                record(RouteDecision(destination: .remote, reason: .localFailure, task: decision.task))
            }
        }
        return try await remote.respond(to: request)
    }

    private func record(_ decision: RouteDecision) {
        // Only finite enum values reach logs. Never command, context, result, ID, or credentials.
        #if DEBUG
        audit?(decision)
        #if canImport(OSLog)
        Logger(subsystem: "org.arcanos.voice", category: "routing").debug(
            "route=\(decision.destination.rawValue, privacy: .public) reason=\(decision.reason.rawValue, privacy: .public)"
        )
        #endif
        #endif
    }
}
