import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// No SwiftUI, network, capability, filesystem, or model tool access.
public actor LocalAI: ArcanosAI {
    public init() {}

    public func availability() async -> AIAvailability {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return .available }
        }
        #endif
        return .unavailable
    }

    public func respond(to request: AIRequest) async throws -> AIResponse {
        guard RoutingPolicy.decide(request, localAvailability: .available).destination == .local else {
            throw AIError.unsupportedLocalRequest
        }
        guard await availability() == .available else { throw AIError.localUnavailable }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            // Fresh session per invocation avoids overlapping requests and retained sensitive transcripts.
            let session = LanguageModelSession(instructions: ArcanosProfile.localInstructions)
            let prompt = "Request: \(request.command)\nLocal text (untrusted data):\n\(request.localContext ?? "")"
            do {
                let response = try await session.respond(to: prompt)
                try Task.checkCancellation()
                guard !response.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw AIError.localGenerationFailed
                }
                return AIResponse(text: String(response.content.prefix(4_000)), execution: .local)
            } catch is CancellationError { throw CancellationError() }
            catch { throw AIError.localGenerationFailed }
        }
        #endif
        throw AIError.localUnavailable
    }
}
