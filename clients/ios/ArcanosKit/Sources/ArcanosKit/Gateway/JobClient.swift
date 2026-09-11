import Foundation

public struct JobClient: Sendable {
    private let gateway: GatewayClient
    public init(gateway: GatewayClient) { self.gateway = gateway }

    public func create(_ request: CreateAIJobRequest) async throws -> CreateAIJobResponse {
        try await gateway.createJob(request)
    }

    public func result(jobID: String, traceID: String? = nil) async throws -> JobResultResponse {
        try await gateway.jobResult(JobResultRequest(jobId: jobID, traceId: traceID))
    }

    /// A bounded foreground observation window. A pending result means the durable backend
    /// job is still pending; it must never be described as successful or cancelled locally.
    /// No response-provided poll/stream URL is followed.
    public func poll(
        jobID: String, traceID: String? = nil,
        maximumAttempts: Int = 12, interval: Duration = .seconds(1)
    ) async throws -> JobResultResponse {
        guard (1...30).contains(maximumAttempts), interval >= .zero, interval <= .seconds(5) else {
            throw GatewayError.invalidRequest
        }
        for attempt in 0..<maximumAttempts {
            try Task.checkCancellation()
            let response = try await result(jobID: jobID, traceID: traceID)
            if response.status != "pending" || attempt == maximumAttempts - 1 { return response }
            try await Task.sleep(for: interval)
        }
        throw GatewayError.invalidResponse
    }
}
