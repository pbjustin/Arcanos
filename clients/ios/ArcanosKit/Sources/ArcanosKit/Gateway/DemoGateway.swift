import Foundation

/// An explicit, isolated demonstration. This factory never creates a network transport.
/// Its credentials, confirmation challenges, jobs, and execution results are synthetic.
public enum DemoGateway {
    public static let origin = URL(string: "https://demo.arcanos.invalid")!

    public static func makeSession() throws -> ArcanosSession {
        let gateway = try GatewayClient(
            baseURL: origin, credentials: DemoCredentials(), transport: DemoGatewayTransport()
        )
        let jobs = JobClient(gateway: gateway)
        return ArcanosSession(
            router: AIRouter(local: LocalAI(), remote: RemoteAI(jobs: jobs)),
            capabilities: CapabilityClient(gateway: gateway), jobs: jobs
        )
    }
}

private struct DemoCredentials: GatewayCredentialProvider {
    func credential(for origin: URL) async throws -> GatewayCredential? {
        guard origin == DemoGateway.origin else { return nil }
        return GatewayCredential(token: "synthetic-demo-test-only", origin: origin,
                                 expiresAt: Date().addingTimeInterval(3_600))
    }
}

/// Only reached by explicit demo selection. There is no URLSession or network fallback.
actor DemoGatewayTransport: GatewayTransport {
    private struct Challenge {
        let url: URL
        let method: String
        let headers: [String: String]
        let semanticBody: [String: JSONValue]
        let expiresAt: Date
    }

    private struct Job {
        let result: JSONValue
        var pendingReads: Int
    }

    private var challenges: [String: Challenge] = [:]
    private var jobs: [String: Job] = [:]
    private let resultPath = "/gpt-access/jobs/result"
    private let capabilityPath = "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run"

    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        guard request.url.scheme == "https", request.url.host == "demo.arcanos.invalid",
              request.url.port == nil, request.url.user == nil, request.url.password == nil,
              request.url.query == nil, request.url.fragment == nil else {
            return try failure("DEMO_ORIGIN_DENIED", "Synthetic demo accepts only its reserved origin.")
        }
        let path = request.url.path
        if request.method == "GET", path == "/gpt-access/capabilities/v1" {
            return try response(CapabilitiesV1Response(ok: true, capabilities: [
                CapabilityV1Summary(id: "ARCANOS:LOCAL_AGENT", description: "Synthetic demo only",
                                    route: "local-agent", actions: ["git.status", "tests.run"], enabled: true)
            ]))
        }
        guard request.method == "POST", let body = request.body,
              var fields = try? JSONDecoder().decode([String: JSONValue].self, from: body) else {
            return try failure("DEMO_REQUEST_UNSUPPORTED", "Synthetic demo does not support this request.")
        }
        switch path {
        case "/gpt-access/jobs/create":
            let jobID = UUID().uuidString.lowercased()
            jobs[jobID] = Job(result: .object([
                "text": .string("Synthetic demo: ARCANOS received the example request. No remote model was called.")
            ]), pendingReads: 1)
            return try response(CreateAiJobResponse(ok: true, jobId: jobID, traceId: "synthetic-demo",
                                                   status: "queued", deduped: false,
                                                   resultEndpoint: resultPath), status: 202)
        case resultPath:
            guard case let .string(jobID)? = fields["jobId"] else {
                return try failure("DEMO_JOB_ID_REQUIRED", "Synthetic demo job ID is required.")
            }
            guard var job = jobs[jobID] else {
                return try jobResponse(jobID, status: "not_found", result: .null)
            }
            if job.pendingReads > 0 {
                job.pendingReads -= 1
                jobs[jobID] = job
                return try jobResponse(jobID, status: "pending", result: .null)
            }
            return try jobResponse(jobID, status: "completed", result: job.result)
        case capabilityPath:
            guard Set(fields.keys).isSubset(of: ["action", "payload", "confirmation_token"]),
                  case let .string(action)? = fields["action"],
                  case let .object(payload)? = fields["payload"] else {
                return try failure("DEMO_CAPABILITY_INVALID", "Synthetic demo capability request is invalid.")
            }
            if action == "git.status", payload.isEmpty, fields["confirmation_token"] == nil {
                return try acceptedJob(action: action, result: .object([
                    "branch": .string("synthetic-demo"), "clean": .bool(true), "changes": .array([]),
                    "gitAvailable": .bool(true), "workspaceType": .string("git"),
                    "message": .string("Synthetic demo repository status. No repository was inspected.")
                ]))
            }
            let providedToken = fields.removeValue(forKey: "confirmation_token")
            if let providedToken {
                guard case let .string(token) = providedToken,
                      let challenge = challenges.removeValue(forKey: token),
                      challenge.expiresAt > Date(), challenge.url == request.url,
                      challenge.method == request.method, challenge.headers == request.headers,
                      challenge.semanticBody == fields else {
                    return try failure("DEMO_CONFIRMATION_INVALID", "Synthetic demo approval was invalid or already used.")
                }
                return try acceptedJob(action: action, result: .object([
                    "profile": .string("typescript-unit"), "status": .string("passed"),
                    "exitCode": .number(0), "stdout": .string("Synthetic demo: the example test passed. No tests were executed."),
                    "stderr": .string(""), "durationMs": .number(0), "truncated": .bool(false)
                ]))
            }
            guard action == "tests.run", payload == ["profile": .string("typescript-unit")] else {
                return try failure("DEMO_CAPABILITY_UNSUPPORTED", "Synthetic demo supports only git.status and the example TypeScript tests.")
            }
            let challengeID = UUID().uuidString.lowercased()
            let expiration = Date().addingTimeInterval(120)
            challenges[challengeID] = Challenge(url: request.url, method: request.method,
                                          headers: request.headers, semanticBody: fields,
                                          expiresAt: expiration)
            return try response(ConfirmationRequiredResponse(
                message: "Synthetic demo: approve the example test operation?", code: "CONFIRMATION_REQUIRED",
                endpoint: capabilityPath, method: "POST", confirmationRequired: true,
                confirmationStatus: "pending", confirmationChallenge: ConfirmationChallenge(
                    id: challengeID, issuedAt: ISO8601DateFormatter().string(from: Date()),
                    expiresAt: ISO8601DateFormatter().string(from: expiration), ttlMs: 120_000
                )
            ), status: 403)
        default:
            return try failure("DEMO_REQUEST_UNSUPPORTED", "Synthetic demo does not support this request.")
        }
    }

    private func acceptedJob(action: String, result: JSONValue) throws -> GatewayResponse {
        let jobID = UUID().uuidString.lowercased()
        jobs[jobID] = Job(result: .object([
            "protocolVersion": .string("local-agent-job-v1"), "outcome": .string("succeeded"),
            "output": result, "metrics": .object(["durationMs": .integer(0)]),
            "correlation": .object(["requestId": .string("synthetic-demo"),
                                    "traceId": .string("synthetic-demo")])
        ]), pendingReads: 0)
        return try response(CapabilityRunResponse(ok: true, result: .object([
            "ok": .bool(true), "accepted": .bool(true), "persisted": .bool(true),
            "action": .string(action), "jobId": .string(jobID), "status": .string("pending"),
            "deduped": .bool(false), "traceId": .string("synthetic-demo"),
            "requestId": .string("synthetic-demo"), "poll": .string(resultPath)
        ])))
    }

    private func jobResponse(_ jobID: String, status: String, result: JSONValue) throws -> GatewayResponse {
        let model = JobResultResponse(ok: true, traceId: "synthetic-demo", jobId: jobID,
                                      status: status, jobStatus: status == "not_found" ? nil : status,
                                      lifecycleStatus: status, poll: resultPath, stream: resultPath,
                                      resultEndpoint: resultPath, result: result)
        var fields = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(model))
        // These response properties are required but nullable in the shared OpenAPI contract.
        // Synthesized Codable omits nil properties; the simulated server emits explicit nulls.
        for key in ["jobStatus", "createdAt", "updatedAt", "completedAt", "retentionUntil",
                    "idempotencyUntil", "expiresAt", "error"] where fields[key] == nil {
            fields[key] = .null
        }
        return try response(fields)
    }

    private func failure(_ code: String, _ message: String) throws -> GatewayResponse {
        try response(ErrorResponse(ok: false, error: ErrorResponseError(code: code, message: message)), status: 403)
    }

    private func response<T: Encodable>(_ body: T, status: Int = 200) throws -> GatewayResponse {
        GatewayResponse(statusCode: status, data: try JSONEncoder().encode(body))
    }
}
