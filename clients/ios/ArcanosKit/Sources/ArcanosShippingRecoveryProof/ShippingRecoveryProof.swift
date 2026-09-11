import ArcanosKit
import ArcanosFixtureSupport
import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

private struct ProofFailure: Error { let code: String }
private func require(_ condition: Bool, _ code: String) throws {
    guard condition else { throw ProofFailure(code: code) }
}

private struct Configuration: Decodable {
    let version: String
    let mode: String
    let runId: String
    let sourceSha: String
    let baseURL: URL
    let origin: URL
    let storePath: String
    let token: String
    let deviceID: String
    let operationID: UUID?
    let disableRecovery: Bool

    func validate() throws {
        try require(version == "ios-shipping-recovery-e2e/v1", "VERSION_INVALID")
        try require(UUID(uuidString: runId) != nil && UUID(uuidString: deviceID) != nil, "IDENTITY_INVALID")
        try require(sourceSha.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil, "SOURCE_SHA_INVALID")
        try require(origin.absoluteString == "https://recovery.example.invalid", "ORIGIN_INVALID")
        try require((storePath as NSString).isAbsolutePath && storePath.utf8.count <= 4096
            && !storePath.contains("\0") && !storePath.contains("\n") && !storePath.contains("\r"), "STORE_INVALID")
        try require(token.hasPrefix("agd1.") && token.utf8.count == 48
            && token.dropFirst(5).utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                || (48...57).contains($0) || $0 == 45 || $0 == 95 }), "SYNTHETIC_CREDENTIAL_INVALID")
    }
}

/// In-memory replacement for the Apple Keychain boundary. Each new process
/// receives a new synthetic validated device session; records never authenticate.
private final class FixtureCredentialStorage: CredentialItemStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var locked = false
    func setLocked() { lock.lock(); defer { lock.unlock() }; locked = true }
    func read(account: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        if locked { throw CredentialStoreError.lockedOrUnavailable }
        return items[account]
    }
    func replace(account: String, data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        if locked { throw CredentialStoreError.lockedOrUnavailable }
        items[account] = data
    }
    func remove(account: String) throws {
        lock.lock(); defer { lock.unlock() }
        if locked { throw CredentialStoreError.lockedOrUnavailable }
        items.removeValue(forKey: account)
    }
}

private struct FixtureLocalAI: ArcanosAI {
    func availability() async -> AIAvailability { .available }
    func respond(to request: AIRequest) async throws -> AIResponse {
        try require(request.command == "hello", "UNEXPECTED_LOCAL_MODEL_REQUEST")
        return AIResponse(text: "LOCAL_FIXTURE_RESULT", execution: .local)
    }
}

private struct Report: Encodable {
    let version = "ios-shipping-recovery-e2e/v1"
    let ok: Bool
    let mode: String
    let runId: String
    let sourceSha: String
    let pid = ProcessInfo.processInfo.processIdentifier
    let operationID: UUID?
    let jobID: String?
    let assertions: [String]
    let requestsMade: Int
    let failure: String?
}

@main
enum ArcanosShippingRecoveryProof {
    private static let job = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    // The same deterministic clock is injected into credentials, the shipping
    // composition, its Gateway client and recovery tracker.
    private static let fixtureNow = Date(timeIntervalSince1970: 2_051_222_400)

    static func main() async {
        var configuration: Configuration?
        var transport: FixtureLoopbackTransport?
        do {
            try require(Array(CommandLine.arguments.dropFirst()) == ["--execute", "--allow-loopback"], "EXPLICIT_OPT_IN_REQUIRED")
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 16_385 - input.count), !chunk.isEmpty {
                input.append(chunk); try require(input.count <= 16_384, "INPUT_BUDGET_EXCEEDED")
            }
            let config = try JSONDecoder().decode(Configuration.self, from: input)
            try config.validate(); configuration = config
            let wire = try FixtureLoopbackTransport(configuration: FixtureLoopbackConfiguration(
                baseURL: config.baseURL, origin: config.origin, token: config.token, runId: config.runId, maxRequests: 8))
            transport = wire
            let report = try await run(config, transport: wire)
            emit(report)
            if config.mode == "submit-held" {
                // The product interaction has already returned pending and persisted
                // the receipt. The parent forcibly terminates this process next.
                while true { try await Task.sleep(for: .seconds(30)) }
            }
        } catch {
            emit(Report(ok: false, mode: configuration?.mode ?? "unparsed", runId: configuration?.runId ?? "",
                sourceSha: configuration?.sourceSha ?? "", operationID: nil, jobID: nil, assertions: [],
                requestsMade: await transport?.count() ?? 0,
                failure: (error as? ProofFailure)?.code ?? "SHIPPING_PROOF_FAILED"))
            exit(1)
        }
    }

    private static func emit(_ report: Report) {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(report) else { exit(1) }
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }

    private static func readRecord(_ config: Configuration) throws -> TrackedOperation {
        let records = try JSONDecoder().decode([TrackedOperation].self, from: Data(contentsOf: URL(fileURLWithPath: config.storePath)))
        try require(records.count == 1, "OPERATION_COUNT_INVALID")
        if let id = config.operationID { try require(records[0].id == id, "RESTORED_OPERATION_CHANGED") }
        let partition = try OperationPartition(origin: config.origin, deviceID: config.deviceID)
        try require(records[0].partition == partition, "RESTORED_PARTITION_CHANGED")
        return records[0]
    }

    private static func run(_ config: Configuration, transport: FixtureLoopbackTransport) async throws -> Report {
        let itemStorage = FixtureCredentialStorage()
        let initialCredentials = KeychainCredentialStore(storage: itemStorage, now: { fixtureNow })
        let credentialOrigin = config.mode == "wrong-origin" ? URL(string: "https://other.example.invalid")! : config.origin
        let deviceID = config.mode == "wrong-device" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : config.deviceID
        let formatter = ISO8601DateFormatter()
        if config.mode != "unpaired" {
            try await initialCredentials.storePairedSession(DeviceCredentialResponse(ok: true, deviceId: deviceID,
                credential: config.token, tokenType: "Bearer", audience: "gpt-access-device-v1", origin: credentialOrigin.absoluteString,
                issuedAt: formatter.string(from: fixtureNow.addingTimeInterval(-10)),
                expiresAt: formatter.string(from: fixtureNow.addingTimeInterval(600)),
                renewalExpiresAt: formatter.string(from: fixtureNow.addingTimeInterval(1200)),
                scopes: ["jobs.create", "jobs.result"], capabilityActions: [], gptIds: ["arcanos-core"]), for: credentialOrigin)
        }
        let credentials: KeychainCredentialStore
        if config.mode == "expired" { credentials = KeychainCredentialStore(storage: itemStorage, now: { fixtureNow.addingTimeInterval(700) }) }
        else { credentials = initialCredentials }
        if config.mode == "revoked" { await credentials.rejectedCredential(config.token, for: credentialOrigin, error: .credentialRevoked) }
        if config.mode == "locked" { itemStorage.setLocked() }
        let composition = ShippingSessionComposition(origin: credentialOrigin, credentials: credentials,
            persistence: FileOperationPersistence(fileURL: URL(fileURLWithPath: config.storePath)),
            local: FixtureLocalAI(), transport: transport, now: { fixtureNow })
        var assertions: [String] = []
        var observed: SessionResult?

        switch config.mode {
        case "submit-held", "submit-uncertain", "submit-crash":
            try require(!FileManager.default.fileExists(atPath: config.storePath), "EXISTING_SUBMISSION_STORE")
            let result = await composition.ask("SHIPPING_RECOVERY_PROMPT_SENTINEL")
            let record = try readRecord(config)
            if config.mode == "submit-uncertain" {
                let failures = await transport.transportFailureCount()
                try require(result.kind != .answer && record.localState == .submissionUncertain
                    && record.backendJobID == nil && failures == 1, "UNCERTAINTY_NOT_DURABLE")
                assertions.append("shipping_submission_uncertainty_persisted")
            } else {
                try require(config.mode == "submit-held" && result.kind == .pending && result.jobID == job
                    && result.operationID == record.id && result.partition == record.partition
                    && record.backendJobID == job && record.localState == .accepted, "SHIPPING_ACCEPTANCE_NOT_DURABLE")
                assertions.append("shipping_ask_returned_pending_with_durable_receipt")
                observed = result
            }
        case "startup":
            let first = config.disableRecovery ? [] : await composition.startup()
            try require(first.count == 1, "SHIPPING_RECOVERY_WIRING_BYPASSED")
            let foreground = await composition.foreground()
            let repeated = await composition.startup()
            try require(foreground.count == 1 && repeated.count == 1, "REPEATED_LIFECYCLE_RECOVERY_MISSING")
            let record = try readRecord(config)
            for result in first + foreground + repeated {
                try require(result.kind == .pending && result.operationID == record.id && result.jobID == job
                    && result.partition == record.partition, "RESTORED_PENDING_IDENTITY_INVALID")
            }
            observed = repeated[0]
            assertions += ["shipping_startup_restored_accepted_operation", "repeated_startup_foreground_read_only"]
        case "recover-uncertain":
            let before = try Data(contentsOf: URL(fileURLWithPath: config.storePath))
            let results = await composition.startup()
            let status = await composition.checkLatest(operationID: config.operationID)
            let record = try readRecord(config)
            try require([.prepared, .submissionUncertain].contains(record.localState) && record.backendJobID == nil,
                "UNCERTAIN_OPERATION_REPLACED")
            try require(status.kind != .answer && results.allSatisfy({ $0.kind != .answer }), "UNCERTAINTY_REPORTED_AS_SUCCESS")
            try require(try Data(contentsOf: URL(fileURLWithPath: config.storePath)) == before, "UNCERTAIN_INDEX_CHANGED")
            assertions.append("shipping_restart_does_not_replay_uncertain_submission")
        case "status", "terminal-status":
            let result = await composition.checkLatest(operationID: config.operationID)
            let record = try readRecord(config)
            try require(result.kind == .answer && result.text == "SHIPPING_RECOVERY_RESULT_SENTINEL"
                && result.operationID == record.id && result.jobID == job && result.partition == record.partition
                && record.localState == .terminal && record.backendStatus == "completed", "VERIFIED_RESULT_INVALID")
            observed = result
            assertions.append("shipping_intent_adapter_verified_same_operation_result")
        case "race-pending":
            let result = await composition.checkLatest(operationID: config.operationID)
            let record = try readRecord(config)
            try require(result.kind == .unavailable && record.localState == .terminal
                && record.backendStatus == "completed", "LATE_PROCESS_OBSERVATION_REPLACED_COMPLETION")
            assertions.append("late_process_observation_preserves_verified_completion")
        case "mismatch", "corrupt", "network", "denied", "unpaired", "expired", "revoked", "locked", "wrong-device", "wrong-origin":
            let before = try Data(contentsOf: URL(fileURLWithPath: config.storePath))
            let result = await composition.checkLatest(operationID: config.operationID)
            try require(result.kind != .answer && result.kind != .pending, "UNVERIFIED_RESULT_PRESENTED")
            try require(try Data(contentsOf: URL(fileURLWithPath: config.storePath)) == before, "FAILED_READ_CHANGED_DURABLE_INDEX")
            let local = await composition.ask("hello")
            try require(local.kind == .answer && local.text == "LOCAL_FIXTURE_RESULT", "LOCAL_REQUEST_REQUIRED_CREDENTIALS")
            assertions += ["shipping_unavailable_or_foreign_result_rejected", "local_request_independent_of_credentials"]
        default: throw ProofFailure(code: "MODE_INVALID")
        }
        let record = try readRecord(config)
        return Report(ok: true, mode: config.mode, runId: config.runId, sourceSha: config.sourceSha,
            operationID: record.id, jobID: observed?.jobID ?? record.backendJobID,
            assertions: assertions, requestsMade: await transport.count(), failure: nil)
    }
}
