import ArcanosKit
import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

struct RecoveryFailure: Error, Sendable {
    let code: String
    init(_ code: String) { self.code = code }
}

func recoveryRequire(_ condition: Bool, _ code: String) throws {
    guard condition else { throw RecoveryFailure(code) }
}

enum RecoveryMode: String, Decodable, Sendable {
    case submit, recover, mismatch, denied
    case submitUncertain = "submit-uncertain"
    case submitCrash = "submit-crash"
    case recoverUncertain = "recover-uncertain"
    case wrongDevice = "wrong-device"
    case wrongOrigin = "wrong-origin"
    case checkTerminal = "check-terminal"
}

struct RecoveryConfiguration: Decodable, Sendable {
    let version: String
    let mode: RecoveryMode
    let runId: String
    let sourceSha: String
    let baseURL: URL
    let storePath: String
    let operationID: String
    let deviceID: String
    let token: String
    let origin: URL

    var fileURL: URL { URL(fileURLWithPath: storePath) }
    var idempotencyKey: String { "fixture-operation-" + operationID }

    func validate() throws {
        try recoveryRequire(version == "ios-operation-recovery-e2e/v1", "FIXTURE_VERSION_INVALID")
        try recoveryRequire(UUID(uuidString: runId) != nil && UUID(uuidString: operationID) != nil
                            && UUID(uuidString: deviceID) != nil, "FIXTURE_IDENTITY_INVALID")
        try recoveryRequire(sourceSha.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
                            "SOURCE_SHA_INVALID")
        guard let parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port,
              (1024...65_535).contains(port), parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              baseURL.absoluteString == "http://127.0.0.1:\(port)" else {
            throw RecoveryFailure("LOOPBACK_ORIGIN_INVALID")
        }
        try recoveryRequire(origin.absoluteString == "https://recovery.example.invalid", "LOGICAL_ORIGIN_INVALID")
        try recoveryRequire((storePath as NSString).isAbsolutePath && storePath.utf8.count <= 4096
                            && !storePath.contains("\0") && !storePath.contains("\n") && !storePath.contains("\r"),
                            "STORE_PATH_INVALID")
        try recoveryRequire(token.hasPrefix("fixture-only-") && token.utf8.count <= 240
                            && token.utf8.allSatisfy({ (33...126).contains($0) }), "FIXTURE_CREDENTIAL_INVALID")
    }
}

/// Every process receives its disposable credential independently. The recovery file
/// never supplies authentication and this fixture makes no Apple Keychain claim.
private struct RecoveryCredentials: GatewayCredentialProvider {
    let configuration: RecoveryConfiguration
    func credential(for origin: URL) async throws -> GatewayCredential? {
        guard origin == configuration.origin else { return nil }
        let bearer = configuration.token
        return GatewayCredential(token: bearer, origin: origin, expiresAt: Date().addingTimeInterval(120))
    }
}

private struct RecoveryReport: Encodable {
    let version = "ios-operation-recovery-e2e/v1"
    let ok: Bool
    let mode: String
    let runId: String
    let sourceSha: String
    let pid = ProcessInfo.processInfo.processIdentifier
    let assertions: [String]
    let requestsMade: Int
    let failure: String?
}

@main
enum ArcanosRecoveryProof {
    private static let jobID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    static func main() async {
        var configuration: RecoveryConfiguration?
        var transport: RecoveryLoopbackTransport?
        var assertions: [String] = []
        do {
            try recoveryRequire(Array(CommandLine.arguments.dropFirst()) == ["--execute", "--allow-loopback"],
                                "EXPLICIT_LOOPBACK_OPT_IN_REQUIRED")
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 16_385 - input.count), !chunk.isEmpty {
                input.append(chunk)
                try recoveryRequire(input.count <= 16_384, "CONFIGURATION_TOO_LARGE")
            }
            guard let parsed = try? JSONDecoder().decode(RecoveryConfiguration.self, from: input) else {
                throw RecoveryFailure("CONFIGURATION_INVALID")
            }
            try parsed.validate()
            configuration = parsed
            let actual = try RecoveryLoopbackTransport(configuration: parsed)
            transport = actual
            try await run(parsed, transport: actual, assertions: &assertions)
            emit(RecoveryReport(ok: true, mode: parsed.mode.rawValue, runId: parsed.runId, sourceSha: parsed.sourceSha,
                                assertions: assertions, requestsMade: await actual.count(), failure: nil))
        } catch {
            // Only fixed codes cross stdout; arbitrary errors may carry private request data.
            emit(RecoveryReport(ok: false, mode: configuration?.mode.rawValue ?? "unparsed",
                                runId: configuration?.runId ?? "", sourceSha: configuration?.sourceSha ?? "",
                                assertions: assertions, requestsMade: await transport?.count() ?? 0,
                                failure: (error as? RecoveryFailure)?.code ?? "RECOVERY_PROOF_FAILED"))
            exit(1)
        }
    }

    private static func emit(_ report: RecoveryReport) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(report) else { exit(1) }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    private static func record(_ tracker: OperationTracker, partition: OperationPartition,
                               operationID: UUID) async throws -> TrackedOperation {
        let values = try await tracker.operations(for: partition)
        try recoveryRequire(values.count == 1 && values[0].id == operationID, "RESTORED_OPERATION_MISMATCH")
        return values[0]
    }

    private static func run(_ config: RecoveryConfiguration, transport: RecoveryLoopbackTransport,
                            assertions: inout [String]) async throws {
        let partition = try OperationPartition(origin: config.origin, deviceID: config.deviceID)
        guard let operationID = UUID(uuidString: config.operationID) else { throw RecoveryFailure("FIXTURE_IDENTITY_INVALID") }
        let persistence = FileOperationPersistence(fileURL: config.fileURL)
        let tracker = OperationTracker(persistence: persistence)
        let gateway = try GatewayClient(baseURL: config.origin, credentials: RecoveryCredentials(configuration: config), transport: transport)
        let jobs = JobClient(gateway: gateway)

        switch config.mode {
        case .submit, .submitUncertain, .submitCrash:
            try recoveryRequire(!FileManager.default.fileExists(atPath: config.storePath), "SUBMISSION_STORE_ALREADY_EXISTS")
            let operation = try TrackedOperation(id: operationID, partition: partition, kind: .remoteAI,
                displaySummary: "Synthetic recovery request", createdAt: Date(), idempotencyKey: config.idempotencyKey)
            try await tracker.prepare(operation)
            let written = try JSONDecoder().decode([TrackedOperation].self, from: Data(contentsOf: config.fileURL))
            let requestsBeforeCreate = await transport.count()
            try recoveryRequire(written == [operation] && requestsBeforeCreate == 0, "INTENT_NOT_PERSISTED_BEFORE_CREATE")
            assertions.append("intent_persisted_before_create")
            let receipt: CreateAIJobResponse
            do {
                receipt = try await jobs.create(CreateAIJobRequest(gptId: "arcanos-core", task: "RECOVERY_PROMPT_SENTINEL",
                    maxOutputTokens: 32, idempotencyKey: operation.idempotencyKey))
            } catch GatewayError.unavailable where config.mode == .submitUncertain {
                try recoveryRequire(await transport.transportFailureCount() == 1, "ACTUAL_TRANSPORT_LOSS_REQUIRED")
                try await tracker.markSubmissionUncertain(operationID)
                let stored = try await record(tracker, partition: partition, operationID: operationID)
                try recoveryRequire(stored.localState == .submissionUncertain && stored.backendJobID == nil, "UNCERTAIN_STATE_NOT_PERSISTED")
                assertions.append("transport_loss_recorded_uncertain")
                return
            }
            try recoveryRequire(config.mode == .submit, "INTERRUPTED_SUBMISSION_RETURNED_RECEIPT")
            try recoveryRequire(receipt.jobId == jobID && receipt.status == "queued", "ACCEPTANCE_RECEIPT_MISMATCH")
            try await tracker.accept(operationID, jobID: receipt.jobId, backendStatus: receipt.status)
            let stored = try await record(tracker, partition: partition, operationID: operationID)
            try recoveryRequire(stored.localState == .accepted && stored.backendJobID == jobID, "ACCEPTANCE_NOT_PERSISTED")
            assertions.append("accepted_handle_persisted")

        case .wrongDevice, .wrongOrigin:
            let before = try Data(contentsOf: config.fileURL)
            let otherDevice = config.deviceID.lowercased() == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
                ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            let other = try OperationPartition(origin: config.mode == .wrongOrigin
                ? URL(string: "https://other-recovery.example.invalid")! : config.origin,
                deviceID: config.mode == .wrongDevice ? otherDevice : config.deviceID)
            try recoveryRequire(try await tracker.operations(for: other).isEmpty, "FOREIGN_PARTITION_VISIBLE")
            try recoveryRequire(try Data(contentsOf: config.fileURL) == before, "FOREIGN_LOOKUP_CHANGED_INDEX")
            assertions.append("foreign_partition_hidden")
            try recoveryRequire(await transport.count() == 0, "FOREIGN_LOOKUP_TRANSMITTED")
            assertions.append("no_network")

        case .recoverUncertain:
            let restored = try await record(tracker, partition: partition, operationID: operationID)
            try recoveryRequire([.prepared, .submissionUncertain].contains(restored.localState)
                                && restored.backendJobID == nil && restored.idempotencyKey == config.idempotencyKey,
                                "UNRESOLVED_INTENT_NOT_RESTORED")
            assertions.append("unresolved_intent_restored")
            let duplicate = try TrackedOperation(partition: partition, kind: .remoteAI,
                displaySummary: "Synthetic recovery request", createdAt: Date(), idempotencyKey: restored.idempotencyKey)
            do { try await tracker.prepare(duplicate); throw RecoveryFailure("DUPLICATE_INTENT_ACCEPTED") }
            catch GatewayError.invalidRequest {}
            assertions.append("duplicate_prepare_rejected")
            try recoveryRequire(await transport.count() == 0, "UNRESOLVED_INTENT_REPLAYED")
            assertions.append("no_automatic_replay")

        case .checkTerminal:
            let restored = try await record(tracker, partition: partition, operationID: operationID)
            try recoveryRequire(restored.localState == .terminal && restored.backendStatus == "completed"
                                && restored.backendJobID == jobID, "TERMINAL_STATE_NOT_RESTORED")
            assertions.append("terminal_state_restored")
            try recoveryRequire(await transport.count() == 0, "TERMINAL_CHECK_TRANSMITTED")
            assertions.append("no_network")

        case .recover, .mismatch, .denied:
            let restored = try await record(tracker, partition: partition, operationID: operationID)
            try recoveryRequire(restored.localState == .accepted && restored.backendJobID == jobID
                                && restored.idempotencyKey == config.idempotencyKey, "ACCEPTED_HANDLE_NOT_RESTORED")
            assertions.append("accepted_handle_restored")
            let before = try Data(contentsOf: config.fileURL)
            if config.mode == .mismatch {
                do { _ = try await jobs.result(jobID: jobID); throw RecoveryFailure("MISMATCHED_RESULT_ACCEPTED") }
                catch GatewayError.invalidResponse {}
                assertions.append("mismatched_result_rejected")
                try recoveryRequire(try Data(contentsOf: config.fileURL) == before, "MISMATCH_CHANGED_INDEX")
                assertions.append("durable_index_unchanged")
                return
            }
            if config.mode == .denied {
                do { _ = try await jobs.result(jobID: jobID); throw RecoveryFailure("AUTHENTICATION_DENIAL_IGNORED") }
                catch GatewayError.authenticationFailure {}
                try recoveryRequire(try Data(contentsOf: config.fileURL) == before, "AUTHENTICATION_DENIAL_CHANGED_INDEX")
                assertions.append("authentication_denial_preserves_index")
                return
            }
            let pending = try await jobs.result(jobID: jobID)
            try recoveryRequire(pending.status == "pending", "PENDING_RESULT_REQUIRED")
            try await tracker.observe(operationID, jobID: pending.jobId, backendStatus: pending.status, terminal: false)
            assertions.append("pending_observed")
            let completed = try await jobs.result(jobID: jobID)
            try recoveryRequire(completed.status == "completed" && completed.error == nil
                                && completed.result.stringValue == "RECOVERY_RESULT_SENTINEL", "COMPLETED_RESULT_MISMATCH")
            try await tracker.observe(operationID, jobID: completed.jobId, backendStatus: completed.status, terminal: true)
            assertions.append("completed_result_observed")
            let terminalBytes = try Data(contentsOf: config.fileURL)
            let durable = try JSONDecoder().decode([TrackedOperation].self, from: terminalBytes)
            try recoveryRequire(durable.count == 1 && durable[0].localState == .terminal
                                && durable[0].backendStatus == "completed" && durable[0].backendJobID == jobID, "TERMINAL_STATE_NOT_DURABLE")
            assertions.append("terminal_state_durable")
            try await tracker.observe(operationID, jobID: jobID, backendStatus: "pending", terminal: false)
            try await tracker.accept(operationID, jobID: jobID, backendStatus: "queued")
            try recoveryRequire(try Data(contentsOf: config.fileURL) == terminalBytes, "LATE_CALLBACK_CHANGED_TERMINAL")
            assertions.append("late_callbacks_preserve_terminal")
        }
    }
}
