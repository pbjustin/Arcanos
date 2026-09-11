import Foundation

public struct RemoteAI: ArcanosAI {
    private let jobs: JobClient
    public init(jobs: JobClient) { self.jobs = jobs }
    public func availability() async -> AIAvailability { .available }

    public func respond(to request: AIRequest) async throws -> AIResponse {
        let receipt = try await jobs.create(CreateAIJobRequest(
            gptId: "arcanos-core", task: request.command, context: request.localContext,
            maxOutputTokens: 1_024, idempotencyKey: UUID().uuidString
        ))
        // Short foreground window; the durable backend owns all further execution.
        // Once accepted, even a poll transport failure preserves the job handle.
        let result: JobResultResponse
        do {
            result = try await jobs.poll(jobID: receipt.jobId, traceID: receipt.traceId,
                                             maximumAttempts: 2, interval: .seconds(1))
        } catch {
            // Creation is already confirmed. Even a cancelled/failed observation must not lose
            // that accepted job handle or cause the original creation request to be repeated.
            return pending(receipt.jobId)
        }
        if result.status == "pending" { return pending(receipt.jobId) }
        guard result.status == "completed", result.ok, result.error == nil else { throw AIError.jobFailed }
        guard let text = ResultProjection.aiText(result.result) else { return pending(receipt.jobId) }
        return AIResponse(text: text, execution: .remote)
    }

    private func pending(_ jobID: String) -> AIResponse {
        AIResponse(text: "ARCANOS accepted the request. Completion has not been verified; check the backend job result shortly.",
                   execution: .remote, jobID: jobID)
    }
}

enum ResultProjection {
    static func aiText(_ value: JSONValue) -> String? {
        // Public generic job output remains polymorphic. Recognize bounded answer fields only;
        // never dump arbitrary output, tool logs, internal metadata, or errors into Siri.
        if let text = value.stringValue, !text.isEmpty { return String(text.prefix(4_000)) }
        guard isSuccessful(value) else { return nil }
        // The worker persists the dispatch envelope around the Trinity result. Unwrap only
        // this known object level, not arbitrary nested tool data or logs.
        if case .object? = value["result"], value["ok"]?.boolValue == true,
           let nested = value["result"], isSuccessful(nested) {
            return directText(nested)
        }
        return directText(value)
    }

    private static func isSuccessful(_ value: JSONValue) -> Bool {
        value["ok"]?.boolValue != false && (value["error"] == nil || value["error"] == .null)
    }

    private static func directText(_ value: JSONValue) -> String? {
        for key in ["result", "response", "answer", "text"] {
            if let text = value[key]?.stringValue, !text.isEmpty { return String(text.prefix(4_000)) }
        }
        return nil
    }

    static func localAgentOutput(_ value: JSONValue) -> JSONValue? {
        guard value["outcome"]?.stringValue == "succeeded",
              let output = value["output"], output["ok"]?.boolValue != false else { return nil }
        return output
    }
}
