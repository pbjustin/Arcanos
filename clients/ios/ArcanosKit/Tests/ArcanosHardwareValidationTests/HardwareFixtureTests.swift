import Foundation
import Testing
import ArcanosKit
@testable import ArcanosHardwareValidation

private final class SyntheticItems: CredentialItemStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var unavailable = false
    func read(account: String) throws -> Data? {
        try lock.withLock {
            if unavailable { throw CredentialStoreError.lockedOrUnavailable }
            return values[account]
        }
    }
    func replace(account: String, data: Data) throws { lock.withLock { values[account] = data } }
    func remove(account: String) throws { lock.withLock { _ = values.removeValue(forKey: account) } }
    func setUnavailable(_ value: Bool) { lock.withLock { unavailable = value } }
}

private struct SyntheticLocal: ArcanosAI {
    func availability() async -> AIAvailability { .available }
    func respond(to request: AIRequest) async throws -> AIResponse { AIResponse(text: "Synthetic local substitution", execution: .local) }
}

private struct FailingLocal: ArcanosAI {
    let available: Bool
    func availability() async -> AIAvailability { available ? .available : .unavailable }
    func respond(to request: AIRequest) async throws -> AIResponse { throw AIError.localGenerationFailed }
}

private struct Fixture: Sendable {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("arcanos-phase3c-hardware-fixture-\(UUID().uuidString)")
    let items = SyntheticItems()
    let credentials: KeychainCredentialStore
    init() { credentials = KeychainCredentialStore(storage: items) }
    var ledgerURL: URL { directory.appendingPathComponent("synthetic-ledger.json") }
    var persistence: FileOperationPersistence { FileOperationPersistence(fileURL: directory.appendingPathComponent("operations.json")) }
    func transport() -> HardwareFixtureTransport { HardwareFixtureTransport(fileURL: ledgerURL) }
    func composition(_ transport: HardwareFixtureTransport, local: any ArcanosAI = SyntheticLocal()) -> ShippingSessionComposition {
        ShippingSessionComposition(origin: HardwareFixtureConfiguration.origin, credentials: credentials,
            persistence: persistence, local: local, transport: transport)
    }
    func initialize() async throws {
        try await credentials.storePairedSession(HardwareFixtureConfiguration.credentialSession(), for: HardwareFixtureConfiguration.origin)
    }
    func records() throws -> [TrackedOperation] {
        try JSONDecoder().decode([TrackedOperation].self, from: #require(try persistence.load()))
    }
    func gateway(_ transport: HardwareFixtureTransport) throws -> GatewayClient {
        try GatewayClient(baseURL: HardwareFixtureConfiguration.origin, credentials: credentials, transport: transport)
    }
}

/// Files remain in the OS temp directory for inspection. Tests never recursively delete
/// artifacts; this suite proves injected transport + shipping composition on its host,
/// not real Keychain, app/process lifecycle, Siri, Foundation Models, or HTTP delivery.
@Suite struct HardwareFixtureTests {
    @Test func defaultLocalOnlyRecordsAndBlocksRemoteRequestsWithoutAcceptingWork() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        #expect(await fixture.composition(transport).ask(HardwareFixtureConfiguration.remoteCommand).kind == .failure)
        let snapshot = try await transport.snapshot()
        #expect(snapshot.configuration.mode == .localOnly)
        #expect(snapshot.requestAttempts == 1)
        #expect(snapshot.submissionAttempts == 1)
        #expect(snapshot.rejectedAttempts == 1)
        #expect(snapshot.jobs.isEmpty)
        #expect(snapshot.semanticExecutionCount == 0)
    }

    @Test(arguments: [true, false]) func unavailableOrFailedLocalModelCannotProduceFixtureSuccess(available: Bool) async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        let composition = fixture.composition(transport, local: FailingLocal(available: available))
        let result = await composition.ask("Summarize this note", localContext: "Bring the blue notebook Tuesday.")
        #expect(result.kind == .failure)
        let snapshot = try await transport.snapshot()
        #expect(snapshot.requestAttempts == 1)
        #expect(snapshot.rejectedAttempts == 1)
        #expect(snapshot.jobs.isEmpty)
        #expect(snapshot.semanticExecutionCount == 0)
    }

    @Test func successfulInjectedLocalRouteAttemptsNoGatewayTransport() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        let result = await fixture.composition(transport).ask("Summarize this note", localContext: "Bring the blue notebook Tuesday.")
        #expect(result.kind == .answer)
        #expect(try await transport.snapshot().requestAttempts == 0)
        #expect(try fixture.persistence.load() == nil)
    }

    @Test func acceptedReceiptRestoresSameJobAcrossFreshCompositionsAndDurableFixtureInstances() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let firstTransport = fixture.transport()
        try await firstTransport.configure(mode: .fixtures)
        let accepted = await fixture.composition(firstTransport).ask(HardwareFixtureConfiguration.remoteCommand)
        #expect(accepted.kind == .pending)
        let operationID = try #require(accepted.operationID)
        let jobID = try #require(accepted.jobID)
        #expect(try fixture.records().first?.localState == .accepted)
        let restoredTransport = fixture.transport()
        let restored = fixture.composition(restoredTransport)
        #expect(await restored.startup().first?.kind == .pending)
        try await restoredTransport.completePendingJobs()
        try await restoredTransport.completePendingJobs()
        let completed = await restored.checkLatest()
        #expect(completed.kind == .answer)
        #expect(completed.operationID == operationID)
        #expect(completed.jobID == jobID)
        #expect(completed.text == HardwareFixtureConfiguration.resultText)
        let snapshot = try await firstTransport.snapshot()
        #expect(snapshot.submissionAttempts == 1)
        #expect(snapshot.resultAttempts == 2)
        #expect(snapshot.semanticExecutionCount == 1)
        #expect(snapshot.jobs.count == 1)
        let restoredRecords = try fixture.records()
        #expect(snapshot.jobs.first?.idempotencyKey == restoredRecords.first?.idempotencyKey)
    }

    @Test func separateTransportsSerializeConcurrentFixtureAcceptances() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        try await fixture.transport().configure(mode: .fixtures)
        async let first = fixture.composition(fixture.transport()).ask(HardwareFixtureConfiguration.remoteCommand)
        async let second = fixture.composition(fixture.transport()).ask(HardwareFixtureConfiguration.remoteCommand)
        let results = await [first, second]
        #expect(results.allSatisfy { $0.kind == .pending })
        let snapshot = try await fixture.transport().snapshot()
        #expect(snapshot.submissionAttempts == 2)
        #expect(snapshot.jobs.count == 2)
        #expect(Set(snapshot.jobs.map(\.jobID)).count == 2)
        #expect(try fixture.records().count == 2)
    }

    @Test func lostReceiptRemainsUncertainAcrossRestorationAndNeverReplays() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures, nextReceipt: .lostAfterAcceptance)
        #expect(await fixture.composition(transport).ask(HardwareFixtureConfiguration.remoteCommand).kind == .unavailable)
        #expect(try fixture.records().first?.localState == .submissionUncertain)
        #expect(try fixture.records().first?.backendJobID == nil)
        try await fixture.transport().completePendingJobs()
        let restored = fixture.composition(fixture.transport())
        #expect(await restored.startup().first?.kind == .unavailable)
        #expect(await restored.checkLatest().kind == .unavailable)
        let snapshot = try await transport.snapshot()
        #expect(snapshot.requestAttempts == 1)
        #expect(snapshot.semanticExecutionCount == 1)
        #expect(snapshot.jobs.count == 1)
    }

    @Test func confirmationRequiresOriginalLiveApprovalAndNeverPersistsTheChallenge() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures)
        let live = fixture.composition(transport)
        let approval = await live.ask("Run tests")
        let id = try #require(approval.approvalID)
        #expect(approval.kind == .confirmationRequired)
        let restored = fixture.composition(fixture.transport())
        #expect(await restored.startup().first?.kind == .unavailable)
        #expect(await restored.approve(id).kind == .failure)
        #expect(await live.approve(id).kind == .pending)
        #expect(await live.approve(id).kind == .failure)
        let snapshot = try await transport.snapshot()
        #expect(snapshot.submissionAttempts == 2)
        #expect(snapshot.jobs.first?.action == "tests.run")
        #expect(snapshot.semanticExecutionCount == 0)
        let evidence = String(decoding: try Data(contentsOf: fixture.ledgerURL), as: UTF8.self)
        #expect(!evidence.contains("confirmation_token"))
        #expect(!evidence.contains("hardware-fixture-"))
        #expect(!evidence.contains("agd1."))
        #expect(!evidence.contains("payload"))
        #expect(!evidence.contains(HardwareFixtureConfiguration.remoteCommand))
    }

    @Test(arguments: [HardwareFixtureControls.ApprovedRetry.challengeAgain, .unavailable])
    func failedApprovedRetryStopsAndRestorationCannotRetry(outcome: HardwareFixtureControls.ApprovedRetry) async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures, approvedRetry: outcome)
        let live = fixture.composition(transport)
        let approval = await live.ask("Run tests")
        let id = try #require(approval.approvalID)
        #expect(await live.approve(id).kind != .pending)
        #expect(await live.approve(id).kind == .failure)
        _ = await fixture.composition(fixture.transport()).startup()
        #expect(try await transport.snapshot().submissionAttempts == 2)
        #expect(try await transport.snapshot().jobs.isEmpty)
    }

    @Test func changedPayloadAndNestedConfirmationAreRejectedAndConsumeRetry() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures)
        let capability = CapabilityClient(gateway: try fixture.gateway(transport))
        let prepared = try capability.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run",
            payload: .object(["profile": .string("typescript-unit")]))
        var rawChallenge: String?
        do { _ = try await capability.invoke(prepared) }
        catch GatewayError.confirmationRequired(let challenge) { rawChallenge = challenge.id }
        let challenge = try #require(rawChallenge)
        let changed = try capability.prepare(id: prepared.capabilityID, action: prepared.action,
            payload: .object(["profile": .string("typescript-unit"), "confirmation_token": .string(challenge)]),
            idempotencyKey: prepared.idempotencyKey)
        await #expect(throws: GatewayError.invalidRequest) { try await capability.invoke(changed, confirmationToken: challenge) }
        await #expect(throws: GatewayError.invalidRequest) { try await capability.invoke(prepared, confirmationToken: challenge) }
        #expect(try await transport.snapshot().jobs.isEmpty)
    }

    @Test func patchApplyUsesShippingPreviewAndSpecificApproval() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures)
        let live = fixture.composition(transport)
        #expect(await live.ask("Apply that patch").kind == .failure)
        let preview = await live.previewPatch(HardwareFixtureConfiguration.syntheticPatch)
        #expect(preview.kind == .pending)
        try await transport.completePendingJobs()
        #expect(await live.checkLatest().text.contains("Say Apply that patch"))
        #expect(await fixture.composition(fixture.transport()).ask("Apply that patch").kind == .failure)
        let approval = await live.ask("Apply that patch")
        #expect(approval.kind == .confirmationRequired)
        #expect(await live.approve(try #require(approval.approvalID)).kind == .pending)
        #expect(try await transport.snapshot().jobs.map(\.action) == ["patch.preview", "patch.apply"])
    }

    @Test(arguments: [HardwareFixtureControls.Authentication.expired, .revoked, .invalid, .unavailable])
    func syntheticAuthenticationFailureNeverAcceptsOrExecutes(authentication: HardwareFixtureControls.Authentication) async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures, authentication: authentication)
        #expect(await fixture.composition(transport).ask(HardwareFixtureConfiguration.remoteCommand).kind != .pending)
        #expect(try await transport.snapshot().jobs.isEmpty)
        #expect(try await transport.snapshot().semanticExecutionCount == 0)
    }

    @Test func unavailableInjectedSecureStoragePreservesReceiptAndCannotResubmit() async throws {
        let fixture = Fixture()
        try await fixture.initialize()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures)
        let accepted = await fixture.composition(transport).ask(HardwareFixtureConfiguration.remoteCommand)
        fixture.items.setUnavailable(true)
        #expect(await fixture.composition(transport).startup().first?.kind == .unavailable)
        fixture.items.setUnavailable(false)
        try await transport.completePendingJobs()
        let restored = await fixture.composition(fixture.transport()).checkLatest()
        #expect(restored.jobID == accepted.jobID)
        #expect(restored.kind == .answer)
        #expect(try await transport.snapshot().submissionAttempts == 1)
    }

    @Test func unexpectedURLAndRequestNeverEscapeTransport() async throws {
        let fixture = Fixture()
        let transport = fixture.transport()
        try await transport.configure(mode: .fixtures)
        let request = GatewayRequest(url: URL(string: "https://unexpected.invalid/health")!, method: "GET", headers: [:])
        await #expect(throws: GatewayError.invalidRequest) { try await transport.send(request) }
        #expect(try await transport.snapshot().requestAttempts == 1)
        #expect(try await transport.snapshot().rejectedAttempts == 1)
        #expect(try await transport.snapshot().jobs.isEmpty)
    }

    @Test func corruptLedgerFailsClosedWithoutReplacement() async throws {
        let fixture = Fixture()
        try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: true)
        let invalid = Data("invalid fixture ledger".utf8)
        try invalid.write(to: fixture.ledgerURL)
        await #expect(throws: OperationTrackingError.corruptStore) { try await fixture.transport().snapshot() }
        #expect(try Data(contentsOf: fixture.ledgerURL) == invalid)
    }
}
