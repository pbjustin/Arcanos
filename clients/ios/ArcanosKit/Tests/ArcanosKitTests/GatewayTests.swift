import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import ArcanosKit

private let gatewayTestOrigin = URL(string: "https://gateway.example.invalid")!
private let gatewayTestJobID = "11111111-1111-4111-8111-111111111111"

private struct FixtureCredentials: GatewayCredentialProvider {
    let value: GatewayCredential?
    init(origin: URL = gatewayTestOrigin, token: String = "synthetic-test-device-credential", expiresAt: Date = .distantFuture) {
        value = GatewayCredential(token: token, origin: origin, expiresAt: expiresAt)
    }
    init(unpaired: Bool) { value = nil }
    func credential(for origin: URL) async throws -> GatewayCredential? { value }
}

private actor FixtureGatewayTransport: GatewayTransport {
    private var responses: [GatewayResponse]
    private var requests: [GatewayRequest] = []
    private let offline: Bool
    init(_ responses: [GatewayResponse] = [], offline: Bool = false) {
        self.responses = responses
        self.offline = offline
    }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        requests.append(request)
        if offline { throw URLError(.notConnectedToInternet) }
        guard !responses.isEmpty else { throw GatewayError.invalidResponse }
        return responses.removeFirst()
    }
    func recorded() -> [GatewayRequest] { requests }
}

private func fixtureResponse(_ json: String, status: Int = 200) -> GatewayResponse {
    GatewayResponse(statusCode: status, data: Data(json.utf8))
}

private func jobResponse(status: String = "pending") -> GatewayResponse {
    fixtureResponse("""
    {"ok":true,"jobId":"\(gatewayTestJobID)","status":"\(status)","jobStatus":"running",
    "lifecycleStatus":"active","createdAt":null,"updatedAt":null,"completedAt":null,
    "retentionUntil":null,"idempotencyUntil":null,"expiresAt":null,
    "poll":"/jobs/unused","stream":"/jobs/unused/stream","resultEndpoint":"/gpt-access/jobs/result",
    "result":\(status == "completed" ? "{\"output\":\"Finished\"}" : "null"),"error":null}
    """)
}

@Suite("Gateway contracts and failure boundaries")
struct GatewayTests {
    @Test func generatedCreateModelUsesExistingWireContract() throws {
        let request = CreateAIJobRequest(gptId: "arcanos-core", task: "Explain this result", idempotencyKey: "fixture-request")
        let body = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(request))
        #expect(body["gptId"] == .string("arcanos-core"))
        #expect(body["task"] == .string("Explain this result"))
        #expect(body["idempotencyKey"] == .string("fixture-request"))
        #expect(body["prompt"] == nil)
    }

    @Test func generatedMetadataDecodesLocalAgentSchema() throws {
        let data = Data("""
        {"ok":true,"exists":true,"capability":{"id":"ARCANOS:LOCAL_AGENT","name":"ARCANOS:LOCAL_AGENT",
        "description":null,"route":null,"actions":["tests.run"],"defaultAction":null,"defaultTimeoutMs":null,
        "actionMetadata":{"tests.run":{"risk":"privileged","requiresConfirmation":true,
        "executionTarget":"python-daemon","inputSchema":{"type":"object","required":["profile"]}}}}}
        """.utf8)
        let result = try JSONDecoder().decode(CapabilityV1DetailResponse.self, from: data)
        #expect(result.capability?.actionMetadata?["tests.run"]?.requiresConfirmation == true)
        #expect(result.capability?.actionMetadata?["tests.run"]?.executionTarget == "python-daemon")
    }

    @Test func largeIntegerPayloadIsPreserved() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data("{\"value\":9007199254740993}".utf8))
        #expect(value["value"] == .integer(9_007_199_254_740_993))
        #expect(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) == value)
    }

    @Test func confirmationHasRawTopLevelTokenAndFrozenOriginalBytes() async throws {
        let challenge = fixtureResponse("""
        {"code":"CONFIRMATION_REQUIRED","confirmationRequired":true,"method":"POST",
        "endpoint":"/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run",
        "confirmationChallenge":{"id":"fixture-challenge","issuedAt":"2026-09-10T12:00:00.000Z","expiresAt":"2099-01-01T12:00:00.000Z","ttlMs":120000}}
        """, status: 403)
        let transport = FixtureGatewayTransport([challenge, fixtureResponse("{\"ok\":true,\"result\":{\"accepted\":true}}")])
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport)
        let client = CapabilityClient(gateway: gateway)
        let prepared = try client.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run", payload: .object([
            "profile": .string("typescript-unit"), "counter": .integer(9_007_199_254_740_993)
        ]), idempotencyKey: "fixture-idempotency")
        do {
            _ = try await client.invoke(prepared)
            Issue.record("Expected an approval challenge")
        } catch GatewayError.confirmationRequired(let value) {
            #expect(value.id == "fixture-challenge")
            #expect(value.expiresAt == "2099-01-01T12:00:00.000Z")
        }
        let beforeApproval = await transport.recorded()
        #expect(beforeApproval.count == 1)
        _ = try await client.invoke(prepared, confirmationToken: "fixture-challenge")
        let requests = await transport.recorded()
        #expect(requests.count == 2)
        #expect(requests[0].url == requests[1].url)
        #expect(requests[0].method == requests[1].method)
        #expect(requests[0].headers == requests[1].headers)
        let original = try #require(requests[0].body)
        let approved = try #require(requests[1].body)
        #expect(approved.starts(with: original.dropLast()))
        let originalJSON = try JSONDecoder().decode(JSONValue.self, from: original)
        let approvedJSON = try JSONDecoder().decode(JSONValue.self, from: approved)
        #expect(approvedJSON["payload"] == originalJSON["payload"])
        #expect(approvedJSON["action"] == originalJSON["action"])
        #expect(approvedJSON["confirmation_token"] == .string("fixture-challenge"))
        #expect(originalJSON["confirmation_token"] == nil)
        #expect(requests[1].headers["x-confirmed"] == nil)
    }

    @Test func mismatchedChallengeEndpointIsRejected() async throws {
        let transport = FixtureGatewayTransport([fixtureResponse("""
        {"code":"CONFIRMATION_REQUIRED","confirmationRequired":true,"endpoint":"/other",
        "confirmationChallenge":{"id":"fixture-challenge"}}
        """, status: 403)])
        let client = CapabilityClient(gateway: try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport))
        let request = try client.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run", payload: .object(["profile": .string("typescript-unit")]))
        await #expect(throws: GatewayError.invalidResponse) { try await client.invoke(request) }
    }

    @Test func unpairedNeverTransmitsRequest() async throws {
        let transport = FixtureGatewayTransport()
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(unpaired: true), transport: transport)
        await #expect(throws: GatewayError.unpaired) { try await gateway.listCapabilities() }
        let requests = await transport.recorded()
        #expect(requests.isEmpty)
    }

    @Test func expiredCredentialNeverTransmitsRequest() async throws {
        let transport = FixtureGatewayTransport()
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(expiresAt: .distantPast), transport: transport)
        await #expect(throws: GatewayError.credentialExpired) { try await gateway.listCapabilities() }
        let requests = await transport.recorded()
        #expect(requests.isEmpty)
    }

    @Test func credentialOriginMismatchNeverTransmitsRequest() async throws {
        let transport = FixtureGatewayTransport()
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(origin: URL(string: "https://other.example.invalid")!), transport: transport)
        await #expect(throws: GatewayError.invalidConfiguration) { try await gateway.listCapabilities() }
        let requests = await transport.recorded()
        #expect(requests.isEmpty)
    }

    @Test func credentialControlCharactersAreRejected() async throws {
        let transport = FixtureGatewayTransport()
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(token: "test-fixture\r\nInjected: yes"), transport: transport)
        await #expect(throws: GatewayError.invalidConfiguration) { try await gateway.listCapabilities() }
    }

    @Test func credentialDescriptionsRedactTheValue() {
        let value = GatewayCredential(token: "synthetic-private-test-value", origin: gatewayTestOrigin, expiresAt: .distantFuture)
        #expect(!String(describing: value).contains("synthetic-private-test-value"))
        #expect(!String(reflecting: value).contains("synthetic-private-test-value"))
    }

    @Test(arguments: ["http://gateway.example.invalid", "https://user:password@gateway.example.invalid", "https://gateway.example.invalid/path", "https://gateway.example.invalid?token=bad", "https://gateway.example.invalid#fragment"])
    func invalidOriginIsRejected(address: String) {
        #expect(throws: GatewayError.invalidConfiguration) {
            try GatewayClient(baseURL: URL(string: address)!, credentials: FixtureCredentials())
        }
    }

    @Test func pathTraversalCapabilityIsRejected() throws {
        let client = CapabilityClient(gateway: try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials()))
        #expect(throws: GatewayError.invalidRequest) {
            try client.prepare(id: "../local-agent/jobs/claim", action: "run", payload: .object([:]))
        }
    }

    @Test func connectivityFailureIsUnavailableWithoutAutomaticRetry() async throws {
        let transport = FixtureGatewayTransport(offline: true)
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport)
        await #expect(throws: GatewayError.unavailable) { try await gateway.createJob(CreateAIJobRequest(gptId: "arcanos-core", task: "Investigate this test failure")) }
        let requests = await transport.recorded()
        #expect(requests.count == 1)
    }

    @Test func errorEnvelopeDoesNotReflectServerMessage() async throws {
        let transport = FixtureGatewayTransport([fixtureResponse("""
        {"ok":false,"error":{"code":"GPT_ACCESS_JOBS_UNAVAILABLE","message":"synthetic-sensitive-server-message"}}
        """, status: 503)])
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport)
        await #expect(throws: GatewayError.http(status: 503, code: "GPT_ACCESS_JOBS_UNAVAILABLE")) {
            try await gateway.createJob(CreateAIJobRequest(gptId: "arcanos-core", task: "Explain this failure"))
        }
        #expect(!GatewayError.http(status: 503, code: "GPT_ACCESS_JOBS_UNAVAILABLE").userFacingMessage.contains("synthetic-sensitive-server-message"))
    }

    @Test func redirectIsRejectedWithoutFollowingIt() async throws {
        let transport = FixtureGatewayTransport([fixtureResponse("{}", status: 307)])
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport)
        await #expect(throws: GatewayError.redirectRejected) { try await gateway.listCapabilities() }
        let requests = await transport.recorded()
        #expect(requests.count == 1)
    }

    @Test func malformedResponseFailsClosed() async throws {
        let transport = FixtureGatewayTransport([fixtureResponse("<html>not JSON</html>")])
        let gateway = try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport)
        await #expect(throws: GatewayError.invalidResponse) { try await gateway.listCapabilities() }
    }

    @Test func pollStopsAtBoundAndUsesCanonicalEndpoint() async throws {
        let transport = FixtureGatewayTransport([jobResponse(), jobResponse(), jobResponse(status: "completed")])
        let client = JobClient(gateway: try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport))
        let response = try await client.poll(jobID: gatewayTestJobID, maximumAttempts: 2, interval: .zero)
        #expect(response.status == "pending")
        let requests = await transport.recorded()
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url.path == "/gpt-access/jobs/result" && $0.method == "POST" })
    }

    @Test(arguments: ["failed", "expired", "not_found", "completed"])
    func pollStopsOnEveryTerminalState(status: String) async throws {
        let transport = FixtureGatewayTransport([jobResponse(status: status), jobResponse()])
        let client = JobClient(gateway: try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport))
        let response = try await client.poll(jobID: gatewayTestJobID, maximumAttempts: 2, interval: .zero)
        #expect(response.status == status)
        let requests = await transport.recorded()
        #expect(requests.count == 1)
    }

    @Test func unknownJobStateFailsClosed() async throws {
        let transport = FixtureGatewayTransport([jobResponse(status: "unexpected-state")])
        let client = JobClient(gateway: try GatewayClient(baseURL: gatewayTestOrigin, credentials: FixtureCredentials(), transport: transport))
        await #expect(throws: GatewayError.invalidResponse) { try await client.result(jobID: gatewayTestJobID) }
    }
}
