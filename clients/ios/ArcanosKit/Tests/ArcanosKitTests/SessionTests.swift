import Foundation
import Testing
@testable import ArcanosKit

private let sessionJobID = "22222222-2222-4222-8222-222222222222"

private struct SessionCredential: GatewayCredentialProvider {
    func credential(for origin: URL) async throws -> GatewayCredential? {
        GatewayCredential(token: "synthetic-session-test-fixture", origin: origin, expiresAt: .distantFuture)
    }
}

private actor SessionTransport: GatewayTransport {
    private var responses: [GatewayResponse]
    private var requests: [GatewayRequest] = []
    init(_ responses: [GatewayResponse]) { self.responses = responses }
    func recorded() -> [GatewayRequest] { requests }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw GatewayError.unavailable }
        return responses.removeFirst()
    }
}

private actor ContextObserver: ArcanosAI {
    private var last: AIRequest?
    func availability() -> AIAvailability { .unavailable }
    func request() -> AIRequest? { last }
    func respond(to request: AIRequest) async throws -> AIResponse {
        last = request
        return AIResponse(text: "fixture", execution: .remote)
    }
}

private func wire<T: Encodable>(_ value: T, status: Int = 200) throws -> GatewayResponse {
    GatewayResponse(statusCode: status, data: try JSONEncoder().encode(value))
}

private func receipt() throws -> GatewayResponse {
    try wire(CreateAIJobResponse(ok: true, jobId: sessionJobID, traceId: "fixture", status: "queued", deduped: false,
                                resultEndpoint: "/gpt-access/jobs/result"), status: 202)
}

private func job(_ result: JSONValue, status: String = "completed") throws -> GatewayResponse {
    try wire(JobResultResponse(ok: true, jobId: sessionJobID, status: status, lifecycleStatus: status,
                               poll: "/gpt-access/jobs/result", stream: "/gpt-access/jobs/result",
                               resultEndpoint: "/gpt-access/jobs/result", result: result))
}

private func gateway(_ transport: SessionTransport) throws -> GatewayClient {
    try GatewayClient(baseURL: URL(string: "https://session.arcanos.invalid")!, credentials: SessionCredential(), transport: transport)
}

struct SessionTests {
    @Test func canonicalDispatchAndTrinityEnvelopeProducesAnswer() async throws {
        let result: JSONValue = .object(["ok": .bool(true), "result": .object([
            "result": .string("The canonical ARCANOS answer"), "module": .string("fixture")
        ]), "_route": .object([:])])
        let transport = SessionTransport(try [receipt(), job(result)])
        let response = try await RemoteAI(jobs: JobClient(gateway: gateway(transport)))
            .respond(to: AIRequest(command: "Explain a complex problem"))
        #expect(response.text == "The canonical ARCANOS answer")
        #expect(response.jobID == nil)
    }

    @Test func nestedFailedResultCannotProduceSuccess() {
        #expect(ResultProjection.aiText(.object(["ok": .bool(true), "result": .object([
            "ok": .bool(false), "error": .string("fixture failure"), "text": .string("false success")
        ])])) == nil)
        #expect(ResultProjection.aiText(.object(["tool": .object(["text": .string("arbitrary log")])])) == nil)
        #expect(ResultProjection.localAgentOutput(.object(["outcome": .string("failed"), "output": .object(["applied": .bool(true)])])) == nil)
    }

    @Test func unavailablePollPreservesAcceptedJobForSubsequentCheck() async throws {
        let transport = SessionTransport(try [receipt(),
            wire(ErrorResponse(ok: false, error: ErrorResponseError(code: "GPT_ACCESS_JOBS_UNAVAILABLE", message: "fixture")), status: 503),
            job(.object(["text": .string("Recovered answer")]))])
        let jobs = JobClient(gateway: try gateway(transport))
        let session = ArcanosSession(router: AIRouter(remote: RemoteAI(jobs: jobs)), jobs: jobs)
        let accepted = await session.ask("Explain a complex problem")
        #expect(accepted.kind == .pending)
        #expect(accepted.jobID == sessionJobID)
        let completed = await session.checkJob(sessionJobID)
        #expect(completed.kind == .answer)
        #expect(completed.text == "Recovered answer")
        let requests = await transport.recorded()
        #expect(requests.filter { $0.url.path == "/gpt-access/jobs/create" }.count == 1)
    }

    @Test(arguments: ["failed", "expired", "not_found"])
    func terminalAIJobFailuresNeverReportCompletion(status: String) async throws {
        let transport = SessionTransport(try [receipt(), job(.null, status: status)])
        do {
            _ = try await RemoteAI(jobs: JobClient(gateway: gateway(transport))).respond(to: AIRequest(command: "reason"))
            Issue.record("Terminal failure reported as answer")
        } catch AIError.jobFailed {} catch { Issue.record("Unexpected failure") }
    }

    @Test func unknownJobCannotSendARead() async throws {
        let transport = SessionTransport([])
        let session = ArcanosSession(router: AIRouter(), jobs: JobClient(gateway: try gateway(transport)))
        let response = await session.checkJob(sessionJobID)
        #expect(response.kind == .failure)
        #expect(await transport.recorded().isEmpty)
    }

    @Test(arguments: ["Hello", "Why are my tests failing?"])
    func unrelatedRequestsNeverUploadCapturedNote(command: String) async {
        let observer = ContextObserver()
        let session = ArcanosSession(router: AIRouter(local: ContextObserver(), remote: observer))
        _ = await session.ask(command, localContext: "private captured note")
        #expect(await observer.request()?.localContext == nil)
    }

    @Test func explicitNoteFallbackIncludesUserSuppliedContext() async {
        let observer = ContextObserver()
        let session = ArcanosSession(router: AIRouter(local: ContextObserver(), remote: observer))
        _ = await session.ask("Summarize this note", localContext: "fixture note")
        #expect(await observer.request()?.localContext == "fixture note")
    }

    @Test func alreadyExpiredChallengeIsRejectedWithoutRetry() async throws {
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "expired-fixture", expiresAt: "2000-01-01T00:00:00Z"))
        let transport = SessionTransport(try [wire(challenge, status: 403)])
        let client = CapabilityClient(gateway: try gateway(transport))
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let prepared = try client.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run", payload: .object(["profile": .string("typescript-unit")]))
        do { _ = try await coordinator.submit(prepared, summary: "fixture"); Issue.record("Expired challenge accepted") }
        catch ConfirmationError.expired {} catch { Issue.record("Wrong error") }
        #expect(await transport.recorded().count == 1)
    }

    @Test func malformedExpiryIsRejected() async throws {
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "malformed-fixture", expiresAt: "not-a-date"))
        let transport = SessionTransport(try [wire(challenge, status: 403)])
        let client = CapabilityClient(gateway: try gateway(transport))
        let prepared = try client.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run", payload: .object([:]))
        do { _ = try await ConfirmationCoordinator(capabilities: client).submit(prepared, summary: "fixture"); Issue.record("Malformed expiry accepted") }
        catch GatewayError.invalidResponse {} catch { Issue.record("Wrong error") }
    }
}
