import Foundation
import Testing
@testable import ArcanosKit

private let shippingOrigin = URL(string: "https://shipping.fixture.invalid")!
private let shippingDevice = "11111111-2222-4333-8444-555555555555"
private let shippingJob = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
private let shippingOtherJob = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"
private let shippingInstant = Date(timeIntervalSince1970: 2_050_000_000)
private let shippingToken = "agd1." + String(repeating: "F", count: 43)

private final class ShippingCredentialItems: CredentialItemStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var unavailable = false
    func read(account: String) throws -> Data? {
        try lock.withLock {
            if unavailable { throw CredentialStoreError.lockedOrUnavailable }
            return items[account]
        }
    }
    func replace(account: String, data: Data) throws { lock.withLock { items[account] = data } }
    func remove(account: String) throws { lock.withLock { _ = items.removeValue(forKey: account) } }
    func setUnavailable(_ value: Bool) { lock.withLock { unavailable = value } }
    func snapshot() -> [String: Data] { lock.withLock { items } }
}

private final class ShippingClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = shippingInstant
    func now() -> Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
}

private struct ShippingLocalAI: ArcanosAI {
    func availability() async -> AIAvailability { .available }
    func respond(to request: AIRequest) async throws -> AIResponse { AIResponse(text: "Local fixture answer", execution: .local) }
}

private actor ShippingTransport: GatewayTransport {
    private var responses: [GatewayResponse]
    private var requests: [GatewayRequest] = []
    private let hook: (@Sendable (GatewayRequest, Int) async throws -> Void)?
    init(_ responses: [GatewayResponse] = [], hook: (@Sendable (GatewayRequest, Int) async throws -> Void)? = nil) {
        self.responses = responses
        self.hook = hook
    }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        requests.append(request)
        let index = requests.count
        try await hook?(request, index)
        guard !responses.isEmpty else { throw GatewayError.unavailable }
        return responses.removeFirst()
    }
    func recorded() -> [GatewayRequest] { requests }
}

private actor ShippingHeldReadTransport: GatewayTransport {
    private var firstRead: CheckedContinuation<GatewayResponse, Never>?
    private var waiting: CheckedContinuation<Void, Never>?
    private var reads = 0
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        if request.url.path.hasSuffix("/create") { return try shippingReceipt() }
        reads += 1
        if reads == 1 {
            return await withCheckedContinuation { continuation in
                firstRead = continuation
                waiting?.resume()
                waiting = nil
            }
        }
        return try shippingResult()
    }
    func waitForHeldRead() async {
        if firstRead != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func releasePending() throws {
        firstRead?.resume(returning: try shippingResult(status: "pending", lifecycle: "running"))
        firstRead = nil
    }
}

private actor ShippingHeldReceiptTransport: GatewayTransport {
    private var receipt: CheckedContinuation<GatewayResponse, Never>?
    private var waiting: CheckedContinuation<Void, Never>?
    private var requests = 0
    private let requiresApproval: Bool
    init(requiresApproval: Bool = false) { self.requiresApproval = requiresApproval }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        requests += 1
        if requiresApproval && requests == 1 {
            return try shippingWire(ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
                confirmationChallenge: ConfirmationChallenge(id: "held-approval-challenge")), status: 403)
        }
        return await withCheckedContinuation { continuation in
            receipt = continuation
            waiting?.resume()
            waiting = nil
        }
    }
    func waitForSubmission() async {
        if receipt != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func deliverReceipt() throws {
        receipt?.resume(returning: try requiresApproval ? shippingCapabilityReceipt() : shippingReceipt())
        receipt = nil
    }
    func count() -> Int { requests }
}

private func shippingSession(device: String = shippingDevice, origin: URL = shippingOrigin,
                             now: Date = shippingInstant) -> DeviceCredentialResponse {
    let format = ISO8601DateFormatter()
    return DeviceCredentialResponse(ok: true, deviceId: device, credential: shippingToken, tokenType: "Bearer",
        audience: "gpt-access-device-v1", origin: origin.absoluteString, issuedAt: format.string(from: now),
        expiresAt: format.string(from: now.addingTimeInterval(3_600)),
        renewalExpiresAt: format.string(from: now.addingTimeInterval(30 * 24 * 3_600)),
        scopes: ["jobs.create", "jobs.result", "capabilities.read", "capabilities.run"],
        capabilityActions: ["git.status", "tests.run", "patch.preview", "patch.apply"], gptIds: ["arcanos-core"])
}

private func shippingWire<T: Encodable>(_ value: T, status: Int = 200) throws -> GatewayResponse {
    GatewayResponse(statusCode: status, data: try JSONEncoder().encode(value))
}

private func shippingReceipt(jobID: String = shippingJob) throws -> GatewayResponse {
    try shippingWire(CreateAIJobResponse(ok: true, jobId: jobID, traceId: "fixture", status: "queued", deduped: false,
        resultEndpoint: "/gpt-access/jobs/result"), status: 202)
}

private func shippingResult(jobID: String = shippingJob, status: String = "completed", lifecycle: String? = nil,
                            jobStatus: String? = nil, value: JSONValue = .object(["text": .string("Verified fixture answer")])) throws -> GatewayResponse {
    try shippingWire(JobResultResponse(ok: true, jobId: jobID, status: status, jobStatus: jobStatus,
        lifecycleStatus: lifecycle ?? status, poll: "/gpt-access/jobs/result", stream: "/gpt-access/jobs/result",
        resultEndpoint: "/gpt-access/jobs/result", result: value))
}

private func shippingCapabilityReceipt() throws -> GatewayResponse {
    try shippingWire(CapabilityRunResponse(ok: true, result: .object([
        "ok": .bool(true), "accepted": .bool(true), "persisted": .bool(true), "jobId": .string(shippingJob)
    ])))
}

private struct ShippingFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let items = ShippingCredentialItems()
    let clock = ShippingClock()
    let credentials: KeychainCredentialStore
    var persistence: FileOperationPersistence { FileOperationPersistence(fileURL: directory.appendingPathComponent("operations.json")) }
    init() {
        credentials = KeychainCredentialStore(storage: items, now: { [clock] in clock.now() })
    }
    func pair(device: String = shippingDevice, origin: URL = shippingOrigin) async throws {
        try await credentials.storePairedSession(shippingSession(device: device, origin: origin, now: clock.now()), for: origin)
    }
    func composition(_ transport: any GatewayTransport, origin: URL? = shippingOrigin) -> ShippingSessionComposition {
        ShippingSessionComposition(origin: origin, credentials: credentials, persistence: persistence,
            local: ShippingLocalAI(), transport: transport, now: { [clock] in clock.now() })
    }
    func records() throws -> [TrackedOperation] {
        try JSONDecoder().decode([TrackedOperation].self, from: #require(try persistence.load()))
    }
    func cleanup() { try? FileManager.default.removeItem(at: directory) }
}

@Suite("Phase 3B shipping recovery integration")
struct ShippingSessionTests {
    @Test func acceptedReceiptRestoresThroughIntentWithoutHostLaunch() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingTransport(try [shippingReceipt(), shippingResult(status: "pending", lifecycle: "queued"),
            shippingResult(status: "pending", lifecycle: "running"), shippingResult(), shippingResult()])
        let accepted = await fixture.composition(transport).ask("Investigate a synthetic problem", localContext: "never upload unrelated note")
        #expect(accepted.kind == .pending)
        let operationID = try #require(accepted.operationID)
        #expect(accepted.jobID == shippingJob)
        #expect(try fixture.records().first?.localState == .accepted)
        #expect(await transport.recorded().count == 1)

        let restarted = fixture.composition(transport)
        #expect(await restarted.startup().first?.operationID == operationID)
        #expect(await restarted.foreground().first?.text.contains("still running") == true)
        let result = await fixture.composition(transport).checkLatest()
        #expect(result.kind == .answer)
        #expect(result.text == "Verified fixture answer")
        #expect(result.operationID == operationID)
        #expect(result.partition == accepted.partition)
        #expect(await restarted.checkJob(shippingJob).kind == .answer)
        let requests = await transport.recorded()
        #expect(requests.filter { $0.url.path.hasSuffix("/create") }.count == 1)
        #expect(requests.allSatisfy { $0.headers["X-Arcanos-Device-Origin"] == shippingOrigin.absoluteString })
        let file = String(decoding: try #require(try fixture.persistence.load()), as: UTF8.self)
        #expect(!file.contains(shippingToken))
        #expect(!file.contains("Investigate"))
        #expect(!file.contains("Verified fixture answer"))
    }

    @Test func preflightIsSavedBeforeTransportAndLostReceiptNeverReplays() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingTransport(hook: { _, _ in
            let records = try fixture.records()
            #expect(records.first?.localState == .prepared)
        })
        let lost = await fixture.composition(transport).ask("Synthetic remote operation")
        #expect(lost.kind == .unavailable)
        let before = try fixture.records()
        #expect(before.first?.localState == .submissionUncertain)
        #expect(before.first?.backendJobID == nil)
        let restored = fixture.composition(transport)
        #expect(await restored.startup().first?.text.contains("Submission is uncertain") == true)
        #expect(await restored.foreground().first?.kind == .unavailable)
        #expect(await restored.checkLatest().kind == .unavailable)
        #expect(try fixture.records() == before)
        #expect(await transport.recorded().count == 1)
    }

    @Test(arguments: ["missing", "expired", "revoked", "locked"])
    func unavailableCredentialsPreserveRecoveryAndLocalFunctionality(mode: String) async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingTransport(try [shippingReceipt()])
        _ = await fixture.composition(transport).ask("Synthetic remote operation")
        let before = try fixture.persistence.load()
        switch mode {
        case "missing": try await fixture.credentials.removeCredential(for: shippingOrigin)
        case "expired": fixture.clock.advance(3_601)
        case "revoked": await fixture.credentials.rejectedCredential(shippingToken, for: shippingOrigin, error: .credentialRevoked)
        default: fixture.items.setUnavailable(true)
        }
        let keychainBefore = fixture.items.snapshot()
        let restored = fixture.composition(transport)
        #expect(await restored.checkLatest().kind != .answer)
        #expect(await restored.ask("Hello").text == "Local fixture answer")
        #expect(await restored.ask("Synthetic remote operation").kind != .answer)
        #expect(await transport.recorded().count == 1)
        #expect(try fixture.persistence.load() == before)
        #expect(fixture.items.snapshot() == keychainBefore)
        if mode == "locked" {
            fixture.items.setUnavailable(false)
            #expect(try await fixture.credentials.authenticatedContext(for: shippingOrigin)?.deviceID == shippingDevice)
        }
    }

    @Test(arguments: ["other-device", "other-origin"])
    func authenticatedPartitionIsolation(mode: String) async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingTransport(try [shippingReceipt()])
        let original = await fixture.composition(transport).ask("Synthetic remote operation")
        let origin = mode == "other-origin" ? URL(string: "https://other.fixture.invalid")! : shippingOrigin
        try await fixture.pair(device: mode == "other-device" ? shippingOtherJob : shippingDevice, origin: origin)
        let other = fixture.composition(transport, origin: origin)
        #expect(await other.checkLatest(operationID: original.operationID).kind == .unavailable)
        #expect(await other.checkJob(shippingJob).kind == .unavailable)
        #expect(await transport.recorded().count == 1)
    }

    @Test(arguments: ["mismatch", "corrupt", "contradictory-status", "offline"])
    func unavailableOrUnverifiedCompletionNeverMutatesIndex(mode: String) async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        var responses = try [shippingReceipt()]
        switch mode {
        case "mismatch": responses.append(try shippingResult(jobID: shippingOtherJob))
        case "corrupt": responses.append(try shippingResult(value: .object(["ok": .bool(false), "text": .string("false success")])))
        case "contradictory-status": responses.append(try shippingResult(jobStatus: "running"))
        default: break
        }
        let transport = ShippingTransport(responses)
        _ = await fixture.composition(transport).ask("Synthetic remote operation")
        let before = try fixture.persistence.load()
        #expect(await fixture.composition(transport).checkLatest().kind == .unavailable)
        #expect(try fixture.persistence.load() == before)
        #expect(await transport.recorded().filter { $0.url.path.hasSuffix("/create") }.count == 1)
    }

    @Test func ambiguousFollowupNeverChoosesLatestOrSubmitsAI() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingTransport(try [shippingReceipt(), shippingReceipt(jobID: shippingOtherJob), shippingResult()])
        let first = await fixture.composition(transport).ask("First remote operation")
        _ = await fixture.composition(transport).ask("Second remote operation")
        let followup = fixture.composition(transport)
        #expect(await followup.ask("Read the result").kind == .clarificationRequired)
        #expect(await transport.recorded().count == 2)
        #expect(await followup.checkLatest(operationID: first.operationID).kind == .answer)
        let records = try fixture.records()
        #expect(Set(records.map(\.idempotencyKey)).count == 2)
    }

    @Test func twoCompositionsKeepSeparateConcurrentSemanticRequests() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingTransport(try [shippingReceipt(), shippingReceipt(jobID: shippingOtherJob)])
        async let app = fixture.composition(transport).ask("App initiated operation")
        async let intent = fixture.composition(transport).ask("Intent initiated operation")
        let results = await [app, intent]
        #expect(results.allSatisfy { $0.kind == .pending })
        #expect(try fixture.records().count == 2)
        #expect(Set(results.compactMap(\.operationID)).count == 2)
        #expect(await transport.recorded().count == 2)
    }

    @Test func heldPendingResponseCannotOverrideVerifiedCompletion() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingHeldReadTransport()
        let app = fixture.composition(transport)
        _ = await app.ask("Synthetic remote operation")
        let slow = Task { await app.checkLatest() }
        await transport.waitForHeldRead()
        #expect(await fixture.composition(transport).checkLatest().kind == .answer)
        try await transport.releasePending()
        #expect(await slow.value.kind == .unavailable)
        #expect(try fixture.records().first?.backendStatus == "completed")
    }

    @Test func acceptedReceiptSurvivesCredentialsRemovedDuringResponse() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingTransport(try [shippingReceipt()], hook: { _, _ in
            try await fixture.credentials.removeCredential(for: shippingOrigin)
        })
        let result = await fixture.composition(transport).ask("Synthetic remote operation")
        #expect(result.kind == .unavailable)
        #expect(result.jobID == shippingJob)
        #expect(result.text.contains("accepted the request"))
        #expect(!result.text.contains("No action was sent"))
        #expect(try fixture.records().first?.localState == .accepted)
    }

    @Test(arguments: ["failed", "cancelled", "expired", "not_found"])
    func canonicalTerminalStatesRemainDistinct(lifecycle: String) async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let status = lifecycle == "cancelled" ? "failed" : lifecycle
        let transport = ShippingTransport(try [shippingReceipt(), shippingResult(status: status, lifecycle: lifecycle, value: .null)])
        _ = await fixture.composition(transport).ask("Synthetic remote operation")
        let result = await fixture.composition(transport).checkLatest()
        #expect(result.kind == (["failed", "cancelled"].contains(lifecycle) ? .failure : .unavailable))
        #expect(!result.text.contains("completed successfully"))
    }

    @Test func confirmationPersistsOperationButNeverApprovalAndRetriesExactlyOnce() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "raw-specific-challenge"))
        let transport = ShippingTransport(try [shippingWire(challenge, status: 403), shippingCapabilityReceipt()])
        let live = fixture.composition(transport)
        let approval = await live.ask("Run tests")
        #expect(approval.kind == .confirmationRequired)
        let id = try #require(approval.approvalID)
        #expect(try fixture.records().first?.localState == .prepared)
        let restored = fixture.composition(transport)
        #expect(await restored.startup().first?.kind == .unavailable)
        #expect(await restored.approve(id).kind == .failure)
        #expect(await transport.recorded().count == 1)
        #expect(await live.approve(id).kind == .pending)
        #expect(await live.approve(id).kind == .failure)
        let requests = await transport.recorded()
        #expect(requests.count == 2)
        #expect(requests[0].url == requests[1].url)
        #expect(requests[0].method == requests[1].method)
        #expect(requests[0].headers["Idempotency-Key"] == requests[1].headers["Idempotency-Key"])
        let original = try JSONDecoder().decode(JSONValue.self, from: #require(requests[0].body))
        let retry = try JSONDecoder().decode(JSONValue.self, from: #require(requests[1].body))
        #expect(original["action"] == retry["action"])
        #expect(original["payload"] == retry["payload"])
        #expect(retry["confirmation_token"]?.stringValue == "raw-specific-challenge")
        #expect(retry["payload"]?["confirmation_token"] == nil)
        let stored = String(decoding: try #require(try fixture.persistence.load()), as: UTF8.self)
        #expect(!stored.contains("raw-specific-challenge"))
        #expect(!stored.contains("confirmation_token"))
        #expect(!stored.contains(shippingToken))
    }

    @Test(arguments: [false, true])
    func uncertainOrRepeatedPrivilegedRetryStopsAndCannotRestoreApproval(repeatedChallenge: Bool) async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "one-use-challenge"))
        var responses = try [shippingWire(challenge, status: 403)]
        if repeatedChallenge { responses.append(try shippingWire(challenge, status: 403)) }
        let transport = ShippingTransport(responses)
        let live = fixture.composition(transport)
        let approval = await live.ask("Run tests")
        let id = try #require(approval.approvalID)
        #expect(await live.approve(id).kind != .pending)
        #expect(await live.approve(id).kind == .failure)
        _ = await fixture.composition(transport).startup()
        #expect(await transport.recorded().count == 2)
        #expect(try fixture.records().first?.localState == .submissionUncertain)
    }

    @Test func unavailableCredentialsWhilePresentingChallengeCannotLeaveOrphanedApproval() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "specific-challenge"))
        let transport = ShippingTransport(try [shippingWire(challenge, status: 403), shippingWire(challenge, status: 403),
            shippingCapabilityReceipt()], hook: { _, index in
                if index == 1 { fixture.items.setUnavailable(true) }
            })
        let live = fixture.composition(transport)
        let unavailable = await live.ask("Run tests")
        #expect(unavailable.kind == .unavailable)
        #expect(unavailable.approvalID == nil)
        fixture.items.setUnavailable(false)
        let fresh = await live.ask("Run tests")
        #expect(fresh.kind == .confirmationRequired)
        #expect(await live.approve(try #require(fresh.approvalID)).kind == .pending)
        #expect(await transport.recorded().count == 3)
    }

    @Test func expiredShippingApprovalRequiresFreshUserInitiatedFlow() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "expiring-challenge"))
        let transport = ShippingTransport(try [shippingWire(challenge, status: 403), shippingWire(challenge, status: 403)])
        let live = fixture.composition(transport)
        let first = await live.ask("Run tests")
        fixture.clock.advance(121)
        #expect(await live.approve(try #require(first.approvalID)).text.contains("expired"))
        #expect(await transport.recorded().count == 1)
        #expect(await live.ask("Run tests").kind == .confirmationRequired)
        #expect(await transport.recorded().count == 2)
    }

    @Test func cancelledApprovalDoesNotRemainAnUncertainRecoveryCandidate() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "cancelled-challenge"))
        let transport = ShippingTransport(try [shippingWire(challenge, status: 403), shippingReceipt(), shippingResult()])
        let live = fixture.composition(transport)
        let approval = await live.ask("Run tests")
        let approvalID = try #require(approval.approvalID)
        let operationID = try #require(approval.operationID)
        #expect(await live.cancel(approvalID).kind == .cancelled)
        #expect(try fixture.records().first?.localState == .dismissed)
        #expect(await fixture.composition(transport).startup().isEmpty)
        let cancelled = await fixture.composition(transport).checkLatest(operationID: operationID)
        #expect(cancelled.kind == .cancelled)
        #expect(cancelled.text.contains("No approved retry was sent"))
        #expect(await live.cancel(approvalID).kind == .failure)
        #expect(await transport.recorded().count == 1)

        let accepted = await live.ask("Synthetic remote operation after cancelling approval")
        #expect(accepted.kind == .pending)
        let result = await fixture.composition(transport).checkLatest()
        #expect(result.kind == .answer)
        #expect(result.operationID == accepted.operationID)
        #expect(await transport.recorded().count == 3)
    }

    @Test func newCapabilityDuringApprovalCannotCreateUnsentRecoveryRecord() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingHeldReceiptTransport(requiresApproval: true)
        let live = fixture.composition(transport)
        let approval = await live.ask("Run tests")
        let approvalID = try #require(approval.approvalID)
        let approved = Task { await live.approve(approvalID) }
        await transport.waitForSubmission()

        #expect(await live.cancel(approvalID).kind == .failure)
        #expect(try fixture.records().first?.localState == .prepared)
        let overlapping = await live.ask("Check my repository")
        #expect(overlapping.text == SessionResult.failure(ConfirmationError.busy).text)
        #expect(try fixture.records().count == 1)
        #expect(await transport.count() == 2)

        try await transport.deliverReceipt()
        #expect(await approved.value.kind == .pending)
        #expect(try fixture.records().count == 1)
        #expect(try fixture.records().first?.localState == .accepted)
    }

    @Test func cancellationDismissalCannotHideUncertainOrAcceptedWork() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        let partition = try OperationPartition(origin: shippingOrigin, deviceID: shippingDevice)
        let tracker = OperationTracker(persistence: fixture.persistence, now: { shippingInstant })
        let uncertain = try TrackedOperation(partition: partition, kind: .confirmation,
            displaySummary: "Uncertain approval", createdAt: shippingInstant, idempotencyKey: "uncertain-approval")
        let accepted = try TrackedOperation(partition: partition, kind: .confirmation,
            displaySummary: "Accepted approval", createdAt: shippingInstant, idempotencyKey: "accepted-approval")
        try await tracker.prepare(uncertain)
        try await tracker.markSubmissionUncertain(uncertain.id)
        try await tracker.prepare(accepted)
        try await tracker.accept(accepted.id, jobID: shippingJob, backendStatus: "queued")
        let before = try fixture.records()

        await #expect(throws: GatewayError.invalidRequest) { try await tracker.dismissUnsubmittedApproval(uncertain.id) }
        await #expect(throws: GatewayError.invalidRequest) { try await tracker.dismissUnsubmittedApproval(accepted.id) }
        #expect(try fixture.records() == before)
    }

    @Test(arguments: [false, true])
    func expiredApprovalDoesNotRemainAnUncertainRecoveryCandidate(expiredOnArrival: Bool) async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let expiresAt = expiredOnArrival ? ISO8601DateFormatter().string(from: shippingInstant.addingTimeInterval(-1)) : nil
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "expired-challenge", expiresAt: expiresAt))
        let transport = ShippingTransport(try [shippingWire(challenge, status: 403), shippingReceipt(), shippingResult()])
        let live = fixture.composition(transport)
        let approval = await live.ask("Run tests")
        if expiredOnArrival {
            #expect(approval.text.contains("approval expired"))
        } else {
            fixture.clock.advance(121)
            #expect(await live.approve(try #require(approval.approvalID)).text.contains("approval expired"))
        }
        #expect(try fixture.records().first?.localState == .dismissed)
        let operationID = try #require(try fixture.records().first?.id)
        let expired = await fixture.composition(transport).checkLatest(operationID: operationID)
        #expect(expired.kind == .cancelled)
        #expect(expired.text.contains("No approved retry was sent"))
        #expect(await transport.recorded().count == 1)

        let accepted = await live.ask("Synthetic remote operation after approval expired")
        #expect(accepted.kind == .pending)
        let result = await fixture.composition(transport).checkLatest()
        #expect(result.kind == .answer)
        #expect(result.operationID == accepted.operationID)
        #expect(await transport.recorded().count == 3)
    }

    @Test func cancellationDuringReceiptDeliveryStillPersistsAcceptance() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let transport = ShippingHeldReceiptTransport()
        let live = fixture.composition(transport)
        let interaction = Task { await live.ask("Synthetic remote operation") }
        await transport.waitForSubmission()
        #expect(try fixture.records().first?.localState == .prepared)
        interaction.cancel()
        try await transport.deliverReceipt()
        let result = await interaction.value
        #expect(result.kind == .pending)
        #expect(try fixture.records().first?.backendJobID == shippingJob)
        #expect(try fixture.records().first?.localState == .accepted)
        #expect(await transport.count() == 1)
        let read = ShippingTransport(try [shippingResult()])
        #expect(await fixture.composition(read).checkLatest().kind == .answer)
    }

    @Test func changedDeviceWhileStatusIsInFlightCannotPublishOldPartitionResult() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let submit = ShippingTransport(try [shippingReceipt()])
        _ = await fixture.composition(submit).ask("Synthetic remote operation")
        let before = try fixture.persistence.load()
        let read = ShippingTransport(try [shippingResult()], hook: { _, _ in
            try await fixture.pair(device: shippingOtherJob)
        })
        let result = await fixture.composition(read).checkLatest()
        #expect(result.kind == .unavailable)
        #expect(result.text != "Verified fixture answer")
        #expect(try fixture.persistence.load() == before)
    }

    @Test func deduplicatedCancelledCapabilityReceiptHasCanonicalFailureResult() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let receipt = try shippingWire(CapabilityRunResponse(ok: true, result: .object([
            "ok": .bool(true), "accepted": .bool(true), "persisted": .bool(true),
            "jobId": .string(shippingJob), "status": .string("cancelled")
        ])))
        let transport = ShippingTransport(try [receipt, shippingResult(status: "failed", lifecycle: "cancelled", jobStatus: "cancelled", value: .null)])
        #expect(await fixture.composition(transport).ask("Check my repository").kind == .pending)
        let result = await fixture.composition(transport).checkLatest()
        #expect(result.kind == .failure)
        #expect(result.text.contains("backend job was cancelled"))
    }

    @Test func statusAdapterPreservesLivePatchPreviewButRestorationNeverArmsApply() async throws {
        let fixture = ShippingFixture()
        defer { fixture.cleanup() }
        try await fixture.pair()
        let preview: JSONValue = .object(["outcome": .string("succeeded"), "output": .object([
            "applicable": .bool(true), "patchSha256": .string(String(repeating: "a", count: 64))
        ])])
        let challenge = ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: "exact-patch-challenge"))
        let transport = ShippingTransport(try [shippingCapabilityReceipt(), shippingResult(value: preview),
            shippingResult(value: preview), shippingWire(challenge, status: 403)])
        let live = fixture.composition(transport)
        let accepted = await live.previewPatch("synthetic exact patch")
        #expect(accepted.kind == .pending)
        #expect(await live.checkLatest().text.contains("Say Apply that patch"))
        let restored = fixture.composition(transport)
        #expect(await restored.checkLatest().kind == .answer)
        #expect(await restored.ask("Apply that patch").kind == .failure)
        #expect(await transport.recorded().count == 3)
        #expect(await live.ask("Apply that patch").kind == .confirmationRequired)
        #expect(await transport.recorded().count == 4)
        let stored = String(decoding: try #require(try fixture.persistence.load()), as: UTF8.self)
        #expect(!stored.contains("synthetic exact patch"))
        #expect(!stored.contains("exact-patch-challenge"))
    }
}
