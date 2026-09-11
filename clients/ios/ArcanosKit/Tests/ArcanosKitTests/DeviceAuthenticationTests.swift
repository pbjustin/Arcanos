import Foundation
import Testing
@testable import ArcanosKit

private let authOrigin = URL(string: "https://paired.example.invalid")!
private let authDeviceID = "a1111111-1111-4111-8111-111111111111"
private let authJobID = "b1111111-1111-4111-8111-111111111111"
private let authToken = "agd1." + String(repeating: "A", count: 43)
private let authPairingToken = "agp1." + String(repeating: "P", count: 43)

private final class MemoryCredentialItems: CredentialItemStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var rejectWrites = false
    func read(account: String) throws -> Data? { lock.withLock { items[account] } }
    func replace(account: String, data: Data) throws {
        try lock.withLock {
            if rejectWrites { throw CredentialStoreError.lockedOrUnavailable }
            items[account] = data
        }
    }
    func remove(account: String) throws { lock.withLock { _ = items.removeValue(forKey: account) } }
    func all() -> [String: Data] { lock.withLock { items } }
    func lockWrites() { lock.withLock { rejectWrites = true } }
}

private final class DeviceClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ value: Date = Date()) { self.value = value }
    func now() -> Date { lock.withLock { value } }
    func advance(_ interval: TimeInterval) { lock.withLock { value += interval } }
}

private actor DeviceTestTransport: GatewayTransport {
    private var responses: [GatewayResponse]
    private var requests: [GatewayRequest] = []
    private let unavailable: Bool
    private let afterResponse: (@Sendable () -> Void)?
    init(_ responses: [GatewayResponse] = [], unavailable: Bool = false, afterResponse: (@Sendable () -> Void)? = nil) {
        self.responses = responses
        self.unavailable = unavailable
        self.afterResponse = afterResponse
    }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        requests.append(request)
        if unavailable { throw GatewayError.unavailable }
        guard !responses.isEmpty else { throw GatewayError.invalidResponse }
        afterResponse?()
        return responses.removeFirst()
    }
    func recorded() -> [GatewayRequest] { requests }
}

private actor HeldRenewalTransport: GatewayTransport {
    private var sent = false
    private var sentObserver: CheckedContinuation<Void, Never>?
    private var response: CheckedContinuation<GatewayResponse, Never>?
    func waitForRequest() async {
        if sent { return }
        await withCheckedContinuation { sentObserver = $0 }
    }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        sent = true
        sentObserver?.resume()
        sentObserver = nil
        return await withCheckedContinuation { response = $0 }
    }
    func finish(_ value: GatewayResponse) { response?.resume(returning: value); response = nil }
}

private func issuedSession(now: Date = Date(), token: String = authToken,
                           origin: String = authOrigin.absoluteString,
                           audience: String = "gpt-access-device-v1",
                           scopes: [String] = ["jobs.create", "jobs.result", "capabilities.read", "capabilities.run"],
                           expiresAfter: TimeInterval = 3600) -> DeviceCredentialResponse {
    let date = ISO8601DateFormatter()
    return DeviceCredentialResponse(ok: true, deviceId: authDeviceID, credential: token,
        tokenType: "Bearer", audience: audience, origin: origin,
        issuedAt: date.string(from: now), expiresAt: date.string(from: now.addingTimeInterval(expiresAfter)),
        renewalExpiresAt: date.string(from: now.addingTimeInterval(30 * 24 * 3600)),
        scopes: scopes, capabilityActions: ["git.status", "tests.run"], gptIds: ["arcanos-core"])
}

private func authResponse<T: Encodable>(_ value: T, status: Int = 200) throws -> GatewayResponse {
    GatewayResponse(statusCode: status, data: try JSONEncoder().encode(value))
}

private func authJSON(_ value: String, status: Int = 200) -> GatewayResponse {
    GatewayResponse(statusCode: status, data: Data(value.utf8))
}

private struct DeviceLocalAI: ArcanosAI {
    func availability() async -> AIAvailability { .available }
    func respond(to request: AIRequest) async throws -> AIResponse { AIResponse(text: "Local answer", execution: .local) }
}

@Suite("Paired-device authentication and secure client state")
struct DeviceAuthenticationTests {
    @Test func stateValuesDecodeWithoutInventingAuthorization() throws {
        for state in [DeviceCredentialState.unpaired, .paired, .expired, .revoked, .renewalRequired, .authenticationFailure] {
            #expect(try JSONDecoder().decode(DeviceCredentialState.self, from: JSONEncoder().encode(state)) == state)
        }
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(DeviceCredentialState.self, from: Data("\"operator\"".utf8))
        }
    }

    @Test func pairRegistersPersistentRandomIdentityAndStoresOnlySessionSecrets() async throws {
        let items = MemoryCredentialItems(), store = KeychainCredentialStore(storage: MemoryCredentialItems())
        #expect(try await store.state(for: authOrigin) == .unpaired)
        let persistent = KeychainCredentialStore(storage: items)
        let transport = DeviceTestTransport([try authResponse(issuedSession(), status: 201)])
        let pairing = try DevicePairingClient(origin: authOrigin, store: persistent, transport: transport)
        try await pairing.pair(pairingToken: authPairingToken)
        let request = try #require(await transport.recorded().first)
        #expect(request.url.path == "/gpt-access/devices/pair")
        #expect(request.headers["Authorization"] == nil)
        #expect(request.headers["X-Arcanos-Device-Origin"] == authOrigin.absoluteString)
        let body = try JSONDecoder().decode(DevicePairRequest.self, from: #require(request.body))
        #expect(body.pairingToken == authPairingToken)
        #expect(UUID(uuidString: body.localIdentity) != nil)
        #expect(try await persistent.state(for: authOrigin) == .paired)
        #expect(try await persistent.credential(for: authOrigin)?.token == authToken)
        #expect(items.all().count == 2)
        #expect(items.all().values.allSatisfy { !String(decoding: $0, as: UTF8.self).contains(authPairingToken) })
        let restarted = KeychainCredentialStore(storage: items)
        #expect(try await restarted.localIdentity(for: authOrigin) == body.localIdentity)
        try await restarted.removeCredential(for: authOrigin)
        #expect(try await restarted.state(for: authOrigin) == .unpaired)
        #expect(try await restarted.localIdentity(for: authOrigin) == body.localIdentity)
    }

    @Test(arguments: ["operator-secret", "agp1.short", "agp1." + String(repeating: "P", count: 42) + "\n", authToken])
    func malformedOrWrongClassPairingMaterialNeverTransmits(token: String) async throws {
        let transport = DeviceTestTransport(), store = KeychainCredentialStore(storage: MemoryCredentialItems())
        let client = try DevicePairingClient(origin: authOrigin, store: store, transport: transport)
        await #expect(throws: GatewayError.invalidRequest) { try await client.pair(pairingToken: token) }
        #expect(await transport.recorded().isEmpty)
    }

    @Test(arguments: ["PAIRING_EXPIRED", "PAIRING_USED", "PAIRING_INVALID"])
    func rejectedPairingNeverCreatesSession(code: String) async throws {
        let response = authJSON("{\"ok\":false,\"error\":{\"code\":\"\(code)\",\"message\":\"private fixture marker\"}}", status: 400)
        let transport = DeviceTestTransport([response]), store = KeychainCredentialStore(storage: MemoryCredentialItems())
        let client = try DevicePairingClient(origin: authOrigin, store: store, transport: transport)
        await #expect(throws: GatewayError.http(status: 400, code: code)) { try await client.pair(pairingToken: authPairingToken) }
        #expect(try await store.state(for: authOrigin) == .unpaired)
        #expect(await transport.recorded().count == 1)
    }

    @Test func issuedMetadataMustMatchAudienceOriginLifetimeAndScopes() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        for value in [issuedSession(origin: "https://different.example.invalid"), issuedSession(audience: "operator"),
                      issuedSession(scopes: ["shell"]), issuedSession(scopes: []),
                      issuedSession(scopes: ["jobs.create", "jobs.create"]), issuedSession(expiresAfter: 7200),
                      issuedSession(token: "test-master-token"), issuedSession(expiresAfter: -1)] {
            await #expect(throws: GatewayError.invalidResponse) { try await store.storePairedSession(value, for: authOrigin) }
        }
        #expect(try await store.state(for: authOrigin) == .unpaired)
    }

    @Test func expirationAndRenewalStateAreDerivedFromKeychainRecord() async throws {
        let clock = DeviceClock(), store = KeychainCredentialStore(storage: MemoryCredentialItems(), now: { clock.now() })
        try await store.storePairedSession(issuedSession(now: clock.now()), for: authOrigin)
        clock.advance(3301)
        #expect(try await store.state(for: authOrigin) == .renewalRequired)
        clock.advance(300)
        #expect(try await store.state(for: authOrigin) == .expired)
        await #expect(throws: GatewayError.credentialExpired) { try await store.credential(for: authOrigin) }
    }

    @Test func renewalReplacesOneCompleteSecretRecordAndRetainsDeviceIdentity() async throws {
        let items = MemoryCredentialItems(), store = KeychainCredentialStore(storage: items)
        let identity = try await store.localIdentity(for: authOrigin)
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let newToken = "agd1." + String(repeating: "B", count: 43)
        let transport = DeviceTestTransport([try authResponse(issuedSession(token: newToken))])
        try await DevicePairingClient(origin: authOrigin, store: store, transport: transport).renew()
        #expect(try await store.credential(for: authOrigin)?.token == newToken)
        #expect(try await store.localIdentity(for: authOrigin) == identity)
        #expect(items.all().count == 2)
        #expect(items.all().values.allSatisfy { !String(decoding: $0, as: UTF8.self).contains(authToken) })
        let request = try #require(await transport.recorded().first)
        #expect(request.url.path == "/gpt-access/devices/renew")
        #expect(request.headers["Authorization"] == "Bearer \(authToken)")
        #expect(request.body == Data("{}".utf8))
        await store.rejectedCredential(authToken, for: authOrigin, error: .credentialRevoked)
        #expect(try await store.state(for: authOrigin) == .paired)
    }

    @Test func uncertainRotationPersistsFailureAndDoesNotReplayAfterRestart() async throws {
        let items = MemoryCredentialItems(), store = KeychainCredentialStore(storage: items)
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let transport = DeviceTestTransport(unavailable: true)
        let pairing = try DevicePairingClient(origin: authOrigin, store: store, transport: transport)
        await #expect(throws: GatewayError.unavailable) { try await pairing.renew() }
        #expect(try await store.state(for: authOrigin) == .authenticationFailure)
        let restarted = KeychainCredentialStore(storage: items)
        await #expect(throws: GatewayError.authenticationFailure) { try await restarted.credential(for: authOrigin) }
        await #expect(throws: GatewayError.authenticationFailure) { try await pairing.renew() }
        #expect(await transport.recorded().count == 1)
    }

    @Test func lockedKeychainBlocksRenewalBeforeTransmission() async throws {
        let items = MemoryCredentialItems(), store = KeychainCredentialStore(storage: items)
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        items.lockWrites()
        let transport = DeviceTestTransport()
        let pairing = try DevicePairingClient(origin: authOrigin, store: store, transport: transport)
        await #expect(throws: (any Error).self) { try await pairing.renew() }
        #expect(await transport.recorded().isEmpty)
        #expect(try await store.credential(for: authOrigin)?.token == authToken)
    }

    @Test func failedAtomicReplacementAfterServerRotationCannotRestoreOldSecret() async throws {
        let items = MemoryCredentialItems(), store = KeychainCredentialStore(storage: items)
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let replacement = issuedSession(token: "agd1." + String(repeating: "B", count: 43))
        let transport = DeviceTestTransport([try authResponse(replacement)], afterResponse: { items.lockWrites() })
        let pairing = try DevicePairingClient(origin: authOrigin, store: store, transport: transport)
        await #expect(throws: (any Error).self) { try await pairing.renew() }
        #expect(try await store.state(for: authOrigin) == .authenticationFailure)
        let restarted = KeychainCredentialStore(storage: items)
        await #expect(throws: GatewayError.authenticationFailure) { try await restarted.credential(for: authOrigin) }
        #expect(await transport.recorded().count == 1)
    }

    @Test func concurrentRenewalCannotIssueDuplicateRotationRequests() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let transport = HeldRenewalTransport()
        let pairing = try DevicePairingClient(origin: authOrigin, store: store, transport: transport)
        let first = Task { try await pairing.renew() }
        await transport.waitForRequest()
        await #expect(throws: GatewayError.invalidRequest) { try await pairing.renew() }
        await transport.finish(try authResponse(issuedSession(token: "agd1." + String(repeating: "B", count: 43))))
        try await first.value
        #expect(try await store.state(for: authOrigin) == .paired)
    }

    @Test func distinctClientsCannotPairRenewOrOverwriteDuringSharedStoreChange() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let held = HeldRenewalTransport(), unused = DeviceTestTransport()
        let firstClient = try DevicePairingClient(origin: authOrigin, store: store, transport: held)
        let secondClient = try DevicePairingClient(origin: authOrigin, store: store, transport: unused)
        let first = Task { try await firstClient.renew() }
        await held.waitForRequest()
        await #expect(throws: GatewayError.invalidRequest) { try await secondClient.renew() }
        await #expect(throws: GatewayError.invalidRequest) { try await secondClient.pair(pairingToken: authPairingToken) }
        await #expect(throws: GatewayError.invalidRequest) { try await store.storePairedSession(issuedSession(), for: authOrigin) }
        await #expect(throws: GatewayError.invalidRequest) { try await store.removeCredential(for: authOrigin) }
        #expect(await unused.recorded().isEmpty)
        let replacement = issuedSession(token: "agd1." + String(repeating: "B", count: 43))
        await held.finish(try authResponse(replacement))
        try await first.value
        #expect(try await store.credential(for: authOrigin)?.token == replacement.credential)
    }

    @Test func cancelledUncertainRotationReleasesSharedLeaseButKeepsFailureMarker() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let held = HeldRenewalTransport()
        let client = try DevicePairingClient(origin: authOrigin, store: store, transport: held)
        let first = Task { try await client.renew() }
        await held.waitForRequest()
        first.cancel()
        await held.finish(authJSON("{}", status: 503))
        await #expect(throws: CancellationError.self) { try await first.value }
        #expect(try await store.state(for: authOrigin) == .authenticationFailure)
        let replacement = issuedSession(token: "agd1." + String(repeating: "B", count: 43))
        let recovery = try DevicePairingClient(origin: authOrigin, store: store,
            transport: DeviceTestTransport([try authResponse(replacement, status: 201)]))
        try await recovery.pair(pairingToken: authPairingToken)
        #expect(try await store.credential(for: authOrigin)?.token == replacement.credential)
    }

    @Test func staleStoreChangeCannotOverwriteNewerSession() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let stale = try await store.beginSessionChange(for: authOrigin, requiresCredential: true)
        await store.endSessionChange(stale)
        let replacement = issuedSession(token: "agd1." + String(repeating: "B", count: 43))
        try await store.storePairedSession(replacement, for: authOrigin)
        let current = try await store.beginSessionChange(for: authOrigin, requiresCredential: false)
        await #expect(throws: GatewayError.invalidRequest) { try await store.completeSessionChange(issuedSession(), change: stale) }
        await store.endSessionChange(stale)
        await #expect(throws: GatewayError.invalidRequest) { try await store.removeCredential(for: authOrigin) }
        await store.endSessionChange(current)
        #expect(try await store.credential(for: authOrigin)?.token == replacement.credential)
    }

    @Test(arguments: ["DEVICE_REVOKED", "DEVICE_CREDENTIAL_EXPIRED", "DEVICE_AUTH_INVALID", "DEVICE_ORIGIN_DENIED"])
    func serverAuthenticationRejectionPersistsAndStopsLaterRequests(code: String) async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let response = authJSON("{\"ok\":false,\"error\":{\"code\":\"\(code)\",\"message\":\"private fixture marker\"}}", status: 401)
        let transport = DeviceTestTransport([response])
        let gateway = try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport)
        let error = try #require(GatewayError.authenticationError(status: 401, code: code))
        await #expect(throws: error) { try await gateway.listCapabilities() }
        await #expect(throws: error) { try await gateway.listCapabilities() }
        #expect(await transport.recorded().count == 1)
        #expect(!error.userFacingMessage.contains("private fixture marker"))
    }

    @Test func revokeCallsOnlyTheStoredDeviceAndStopsPolling() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let transport = DeviceTestTransport([try authResponse(DeviceRevokeResponse(ok: true, deviceId: authDeviceID, state: "revoked"))])
        try await DevicePairingClient(origin: authOrigin, store: store, transport: transport).revoke()
        #expect(try await store.state(for: authOrigin) == .revoked)
        let gateway = try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport)
        await #expect(throws: GatewayError.credentialRevoked) { try await gateway.jobResult(JobResultRequest(jobId: authJobID)) }
        #expect(await transport.recorded().count == 1)
        #expect(await transport.recorded().first?.url.path == "/gpt-access/devices/\(authDeviceID)/revoke")
    }

    @Test func sessionInspectionValidatesGeneratedMetadataAndStoredDevice() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        let issued = issuedSession()
        try await store.storePairedSession(issued, for: authOrigin)
        var body = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(issued))
        body.removeValue(forKey: "credential")
        body["state"] = .string("paired")
        let valid = try authResponse(body)
        body["scopes"] = .array([.string("shell")])
        let forged = try authResponse(body)
        let transport = DeviceTestTransport([valid, forged])
        let pairing = try DevicePairingClient(origin: authOrigin, store: store, transport: transport)
        #expect(try await pairing.inspect().deviceId == authDeviceID)
        await #expect(throws: GatewayError.invalidResponse) { try await pairing.inspect() }
        #expect(await transport.recorded().allSatisfy { $0.url.path == "/gpt-access/devices/session" })
    }

    @Test func revokedPollingKeepsAcceptedJobButReportsAuthenticationState() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let receipt = authJSON("{\"ok\":true,\"jobId\":\"\(authJobID)\",\"traceId\":\"fixture\",\"status\":\"queued\",\"deduped\":false,\"resultEndpoint\":\"/gpt-access/jobs/result\"}", status: 202)
        let denied = authJSON(#"{"ok":false,"error":{"code":"DEVICE_REVOKED","message":"denied"}}"#, status: 401)
        let transport = DeviceTestTransport([receipt, denied])
        let jobs = JobClient(gateway: try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport))
        let result = try await RemoteAI(jobs: jobs).respond(to: AIRequest(command: "Explain this result"))
        #expect(result.jobID == authJobID)
        #expect(result.text.contains("revoked"))
        #expect(result.text.contains("could not be read"))
        #expect(try await store.state(for: authOrigin) == .revoked)
        #expect(await transport.recorded().count == 2)
    }

    @Test func ownedJobReadDenialNeverFallsBackToPublicReadTokenRoutes() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let denied = authJSON(#"{"ok":false,"error":{"code":"DEVICE_SCOPE_DENIED","message":"denied"}}"#, status: 403)
        let transport = DeviceTestTransport([denied])
        let jobs = JobClient(gateway: try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport))
        await #expect(throws: GatewayError.http(status: 403, code: "DEVICE_SCOPE_DENIED")) { try await jobs.result(jobID: authJobID) }
        #expect(try await store.state(for: authOrigin) == .paired)
        #expect(await transport.recorded().count == 1)
        #expect(await transport.recorded().first?.url.path == "/gpt-access/jobs/result")
    }

    @Test func localWorksUnpairedWhileRemoteClearlyFailsWithoutTransmission() async throws {
        let transport = DeviceTestTransport(), store = KeychainCredentialStore(storage: MemoryCredentialItems())
        let jobs = JobClient(gateway: try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport))
        let session = ArcanosSession(router: AIRouter(local: DeviceLocalAI(), remote: RemoteAI(jobs: jobs)), jobs: jobs)
        #expect(await session.ask("Hello").text == "Local answer")
        let remote = await session.ask("Explain my failing integration test")
        #expect(remote.kind == .failure)
        #expect(remote.text.contains("pairing"))
        #expect(await transport.recorded().isEmpty)
    }

    @Test func pairedDeviceCreatesAndPollsUsingCredentialNotJobIDAsAuthority() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let receipt = authJSON("{\"ok\":true,\"jobId\":\"\(authJobID)\",\"traceId\":\"fixture\",\"status\":\"queued\",\"deduped\":false,\"resultEndpoint\":\"/gpt-access/jobs/result\"}", status: 202)
        let result = authJSON("{\"ok\":true,\"jobId\":\"\(authJobID)\",\"status\":\"completed\",\"lifecycleStatus\":\"completed\",\"poll\":\"unused\",\"stream\":\"unused\",\"resultEndpoint\":\"/gpt-access/jobs/result\",\"result\":{\"answer\":\"Owned answer\"}}")
        let transport = DeviceTestTransport([receipt, result])
        let jobs = JobClient(gateway: try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport))
        let response = try await RemoteAI(jobs: jobs).respond(to: AIRequest(command: "Explain this test"))
        #expect(response.text == "Owned answer")
        #expect(response.execution == .remote)
        let requests = await transport.recorded()
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.headers["Authorization"] == "Bearer \(authToken)"
            && $0.headers["X-Arcanos-Device-Origin"] == authOrigin.absoluteString })
        let read = try JSONDecoder().decode(JobResultRequest.self, from: #require(requests[1].body))
        #expect(read.jobId == authJobID)
        #expect(requests[1].url.path == "/gpt-access/jobs/result")
    }

    @Test func pairedDeviceConfirmationStillRequiresApprovalAndOneExactRetry() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let challenge = authJSON(#"{"code":"CONFIRMATION_REQUIRED","confirmationRequired":true,"confirmationChallenge":{"id":"synthetic-explicit-approval","expiresAt":"2099-01-01T00:00:00Z"}}"#, status: 403)
        let transport = DeviceTestTransport([challenge, authJSON(#"{"ok":true,"result":{"accepted":true}}"#)])
        let client = CapabilityClient(gateway: try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport))
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let request = try client.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run", payload: .object(["profile": .string("typescript-unit")]))
        guard case .approval(let approval) = try await coordinator.submit(request, summary: "Approve tests.run?") else {
            Issue.record("Pairing bypassed confirmation"); return
        }
        #expect(await transport.recorded().count == 1)
        _ = try await coordinator.approve(approval.id)
        await #expect(throws: ConfirmationError.notPending) { try await coordinator.approve(approval.id) }
        let calls = await transport.recorded()
        #expect(calls.count == 2)
        #expect(calls[0].url == calls[1].url && calls[0].method == calls[1].method && calls[0].headers == calls[1].headers)
        let original = try #require(calls[0].body), approved = try #require(calls[1].body)
        #expect(approved.starts(with: original.dropLast()))
        var decoded = try JSONDecoder().decode([String: JSONValue].self, from: approved)
        #expect(decoded.removeValue(forKey: "confirmation_token") == .string("synthetic-explicit-approval"))
        #expect(decoded == (try JSONDecoder().decode([String: JSONValue].self, from: original)))
    }

    @Test func generatedSecretBearingDTODescriptionsAreRedacted() {
        let issued = issuedSession()
        let pair = DevicePairRequest(pairingToken: authPairingToken, localIdentity: authDeviceID)
        let challenge = DevicePairingResponse(ok: true, pairingToken: authPairingToken, expiresAt: "2099-01-01T00:00:00Z", origin: authOrigin.absoluteString)
        for description in [String(describing: issued), String(reflecting: issued), String(describing: pair),
                            String(reflecting: pair), String(describing: challenge), String(reflecting: challenge)] {
            #expect(!description.contains(authToken))
            #expect(!description.contains(authPairingToken))
        }
    }

    @Test func pairedDeviceSecondChallengeStopsInsteadOfGrantingPermanentApproval() async throws {
        let store = KeychainCredentialStore(storage: MemoryCredentialItems())
        try await store.storePairedSession(issuedSession(), for: authOrigin)
        let challenge = authJSON(#"{"code":"CONFIRMATION_REQUIRED","confirmationRequired":true,"confirmationChallenge":{"id":"synthetic-one-use-challenge","expiresAt":"2099-01-01T00:00:00Z"}}"#, status: 403)
        let transport = DeviceTestTransport([challenge, challenge])
        let client = CapabilityClient(gateway: try GatewayClient(baseURL: authOrigin, credentials: store, transport: transport))
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let request = try client.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run", payload: .object(["profile": .string("typescript-unit")]))
        guard case .approval(let approval) = try await coordinator.submit(request, summary: "Approve tests.run?") else {
            Issue.record("Expected explicit approval"); return
        }
        await #expect(throws: ConfirmationError.repeatedChallenge) { try await coordinator.approve(approval.id) }
        await #expect(throws: ConfirmationError.notPending) { try await coordinator.approve(approval.id) }
        #expect(await transport.recorded().count == 2)
        #expect(try await store.state(for: authOrigin) == .paired)
    }
}
