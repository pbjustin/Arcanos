import ArcanosKit
import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

struct PreviewRecoveryConfiguration: Sendable {
    enum Phase: String, Sendable { case submit, recover, checkTerminal = "check-terminal" }
    let phase: Phase
    let fileURL: URL
    let operationID: UUID
    let deviceID: UUID
    let preview: ProofConfiguration

    init(arguments: [String]) throws {
        try require(arguments.count >= 8 && arguments[0] == "--recovery-phase"
                    && arguments[2] == "--store-path" && arguments[4] == "--operation-id"
                    && arguments[6] == "--device-id", "RECOVERY_ARGUMENTS_INVALID")
        guard let phase = Phase(rawValue: arguments[1]),
              let operationID = UUID(uuidString: arguments[5]), let deviceID = UUID(uuidString: arguments[7]),
              arguments[3].hasPrefix("/"), arguments[3].utf8.count <= 4096,
              !arguments[3].contains("\0"), !arguments[3].contains("\n"), !arguments[3].contains("\r") else {
            throw ProofFailure("RECOVERY_IDENTITY_OR_PATH_INVALID")
        }
        self.phase = phase
        self.operationID = operationID
        self.deviceID = deviceID
        fileURL = URL(fileURLWithPath: arguments[3]).standardizedFileURL
        preview = try ProofConfiguration(arguments: Array(arguments.dropFirst(8)))
        // Recovery evidence stays outside the clean Git checkout used for source attestation.
        try require(fileURL.path != preview.repositoryRoot.path
                    && !fileURL.path.hasPrefix(preview.repositoryRoot.path + "/"), "RECOVERY_STORE_INSIDE_CHECKOUT")
    }

    var idempotencyKey: String { "ios-https-recovery-" + operationID.uuidString.lowercased() }
}

struct PreviewRecoveryReport: Encodable, Sendable {
    let status: String
    let kind = "ios_operation_recovery_https_proof"
    let proofVersion = "ios-operation-recovery-https/v1"
    let scope = "shipping Swift HTTPS transport and file recovery across CLI processes against a sealed synthetic preview; no device credential, Keychain, app lifecycle, Siri, provider, database, or active worker proof"
    let controlPlaneProvenanceAsserted = false
    let phase: String
    let executed: Bool
    let networkAttempted: Bool
    let prNumber: Int
    let sourceCommit: String
    let webBaseURL: URL
    let workerBaseURL: URL
    let processID = ProcessInfo.processInfo.processIdentifier
    let operationID: UUID
    let backendJobID: String?
    let requestsMade: Int
    let responseBytes: Int
    let createRequests: Int
    let resultRequests: Int
    let checks: [String]
    let code: String?
}

enum PreviewRecoveryProof {
    static func main(arguments: [String]) async {
        var runner: PreviewRecoveryRunner?
        do {
            let configuration = try PreviewRecoveryConfiguration(arguments: arguments)
            try configuration.preview.verifyGit()
            let active = PreviewRecoveryRunner(configuration: configuration)
            runner = active
            let report = try await withThrowingTaskGroup(of: PreviewRecoveryReport.self) { group in
                group.addTask { try await active.run() }
                group.addTask {
                    try await Task.sleep(for: .seconds(120))
                    throw ProofFailure("RECOVERY_TOTAL_TIMEOUT")
                }
                defer { group.cancelAll() }
                guard let report = try await group.next() else { throw ProofFailure("RECOVERY_RESULT_MISSING") }
                return report
            }
            emit(report)
        } catch {
            let code = (error as? ProofFailure)?.code ?? "HTTPS_RECOVERY_PROOF_FAILED"
            if let runner { emit(await runner.report(status: "FAIL", code: code), toError: true) }
            else {
                // Failed admission has no network or file effects, and reflects no raw arguments/errors.
                let failure = ["status": "FAIL", "kind": "ios_operation_recovery_https_proof",
                               "proofVersion": "ios-operation-recovery-https/v1", "code": code]
                emit(failure, toError: true)
            }
            exit(1)
        }
    }

    private static func emit<T: Encodable>(_ value: T, toError: Bool = false) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value) else { exit(1) }
        let output = toError ? FileHandle.standardError : FileHandle.standardOutput
        output.write(data)
        output.write(Data([10]))
    }
}

actor PreviewRecoveryRunner {
    let configuration: PreviewRecoveryConfiguration
    private let gates: ProofRunner
    private var checks = ["clean_exact_git_head_and_canonical_origin", "pr_scoped_https_origins", "network_opt_in_gate_validated"]
    private var backendJobID: String?

    init(configuration: PreviewRecoveryConfiguration) {
        self.configuration = configuration
        gates = ProofRunner(configuration: configuration.preview)
    }

    func run() async throws -> PreviewRecoveryReport {
        guard configuration.preview.execute else { return await report(status: "PASS") }
        let initial = try await identity()
        checks.append("initial_roles_device_policy_and_metadata_verified")
        await gates.transport.admit()
        let partition = try OperationPartition(origin: configuration.preview.web, deviceID: configuration.deviceID.uuidString)
        let tracker = OperationTracker(persistence: FileOperationPersistence(fileURL: configuration.fileURL))
        let gateway = try GatewayClient(baseURL: configuration.preview.web,
            credentials: PreviewCredentials(permittedOrigin: configuration.preview.web), transport: gates.transport)
        let jobs = JobClient(gateway: gateway)

        switch configuration.phase {
        case .submit:
            try require(!FileManager.default.fileExists(atPath: configuration.fileURL.path), "RECOVERY_SUBMISSION_STORE_EXISTS")
            let operation = try TrackedOperation(id: configuration.operationID, partition: partition, kind: .remoteAI,
                displaySummary: "Synthetic HTTPS recovery request", createdAt: Date(), idempotencyKey: configuration.idempotencyKey)
            try await tracker.prepare(operation)
            try require(try diskRecords() == [operation], "RECOVERY_INTENT_NOT_DURABLE")
            let before = await gates.transport.recorded()
            try require(!before.contains { $0.request.url.path == PreviewFixture.createPath }, "RECOVERY_CREATE_PRECEDED_INTENT")
            checks.append("file_intent_persisted_before_https_create")
            let receipt = try await jobs.create(CreateAIJobRequest(gptId: "arcanos-core", task: PreviewFixture.aiTask,
                maxOutputTokens: 1024, idempotencyKey: configuration.idempotencyKey))
            try require(receipt.status == "queued" && !receipt.deduped, "RECOVERY_ACCEPTANCE_NOT_FRESH")
            backendJobID = receipt.jobId
            try await tracker.accept(configuration.operationID, jobID: receipt.jobId, backendStatus: receipt.status)
            let stored = try diskRecords()
            try require(stored.count == 1 && stored[0].id == configuration.operationID
                        && stored[0].backendJobID == receipt.jobId && stored[0].localState == .accepted,
                        "RECOVERY_ACCEPTANCE_NOT_DURABLE")
            checks.append("accepted_job_handle_persisted_to_file")

        case .recover:
            let operation = try await restored(tracker, partition: partition, state: .accepted)
            guard let jobID = operation.backendJobID else { throw ProofFailure("RECOVERY_HANDLE_MISSING") }
            backendJobID = jobID
            checks.append("accepted_job_handle_restored_from_file")
            try await verifyPartitionIsolation(tracker, partition: partition)
            checks.append("foreign_device_and_origin_partitions_hidden")
            let before = try diskData()
            let pending = try await jobs.result(jobID: jobID)
            if pending.status == "not_found" {
                try require(try diskData() == before, "MISSING_JOB_CHANGED_RECOVERY_INDEX")
                throw ProofFailure("JOB_RESULT_NOT_FOUND")
            }
            try require(pending.status == "pending" && pending.result == .null, "RECOVERY_PENDING_RESULT_MISMATCH")
            try await tracker.observe(configuration.operationID, jobID: pending.jobId, backendStatus: pending.status, terminal: false)
            checks.append("restored_job_pending_result_observed_over_https")
            let terminal = try await jobs.result(jobID: jobID)
            let expected: JSONValue = .object(["ok": .bool(true), "result": .object(["result": .string(PreviewFixture.aiAnswer)])])
            try require(terminal.status == "completed" && terminal.error == nil && terminal.result == expected,
                        "RECOVERY_COMPLETED_RESULT_MISMATCH")
            try await tracker.observe(configuration.operationID, jobID: terminal.jobId, backendStatus: terminal.status, terminal: true)
            checks.append("restored_job_completed_result_observed_over_https")
            let terminalBytes = try diskData()
            let records = try diskRecords()
            try require(records.count == 1 && records[0].localState == .terminal && records[0].backendJobID == jobID
                        && records[0].backendStatus == "completed", "RECOVERY_TERMINAL_NOT_DURABLE")
            checks.append("terminal_state_persisted_to_file")
            try await tracker.observe(configuration.operationID, jobID: jobID, backendStatus: "pending", terminal: false)
            try await tracker.accept(configuration.operationID, jobID: jobID, backendStatus: "queued")
            try require(try diskData() == terminalBytes, "RECOVERY_LATE_CALLBACK_CHANGED_TERMINAL")
            checks.append("late_callbacks_leave_terminal_file_unchanged")

        case .checkTerminal:
            let operation = try await restored(tracker, partition: partition, state: .terminal)
            try require(operation.backendStatus == "completed", "RECOVERY_TERMINAL_STATUS_MISMATCH")
            backendJobID = operation.backendJobID
            checks.append("terminal_state_restored_in_new_process")
        }

        try await verifyJobExchanges()
        checks.append("phase_job_request_counts_and_identities_verified")
        let final = try await identity()
        try require(final == initial, "RECOVERY_PREVIEW_IDENTITY_DRIFT")
        try configuration.preview.verifyGit()
        checks.append("final_roles_device_policy_metadata_and_git_unchanged")
        return await report(status: "PASS")
    }

    func report(status: String, code: String? = nil) async -> PreviewRecoveryReport {
        let recorded = await gates.transport.recorded()
        return PreviewRecoveryReport(status: status, phase: configuration.phase.rawValue,
            executed: configuration.preview.execute, networkAttempted: await gates.transport.count() > 0,
            prNumber: configuration.preview.prNumber, sourceCommit: configuration.preview.commit,
            webBaseURL: configuration.preview.web, workerBaseURL: configuration.preview.worker,
            operationID: configuration.operationID, backendJobID: backendJobID,
            requestsMade: await gates.transport.count(), responseBytes: await gates.transport.bytes(),
            createRequests: recorded.filter { $0.request.url.path == PreviewFixture.createPath }.count,
            resultRequests: recorded.filter { $0.request.url.path == PreviewFixture.resultPath }.count,
            checks: checks, code: code)
    }

    private func identity() async throws -> [JSONValue] {
        let web = try await gates.readiness(configuration.preview.web, role: "web")
        let worker = try await gates.readiness(configuration.preview.worker, role: "worker")
        let policy = try await gates.raw(configuration.preview.web, path: PreviewFixture.devicePolicyPath, method: "GET")
        try ResponseEvidence.devicePolicy(policy, prNumber: configuration.preview.prNumber, sourceCommit: configuration.preview.commit)
        let metadata = try await gates.raw(configuration.preview.web, path: PreviewFixture.metadataPath, method: "GET", authenticated: true)
        let value = try ResponseEvidence.json(metadata)
        try require(metadata.statusCode == 200 && value == gates.expectedMetadata, "RECOVERY_METADATA_CONTRACT_MISMATCH")
        return [web, worker, try ResponseEvidence.json(policy), value]
    }

    private func restored(_ tracker: OperationTracker, partition: OperationPartition, state: LocalOperationState) async throws -> TrackedOperation {
        let values = try await tracker.operations(for: partition)
        guard values.count == 1, values[0].id == configuration.operationID,
              values[0].kind == .remoteAI, values[0].idempotencyKey == configuration.idempotencyKey,
              values[0].localState == state, let jobID = values[0].backendJobID, UUID(uuidString: jobID) != nil else {
            throw ProofFailure("RECOVERY_STORED_STATE_MISMATCH")
        }
        return values[0]
    }

    private func verifyPartitionIsolation(_ tracker: OperationTracker, partition: OperationPartition) async throws {
        let before = try diskData()
        let count = await gates.transport.count()
        let alternate = configuration.deviceID.uuidString.lowercased() == "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let otherDevice = try OperationPartition(origin: configuration.preview.web, deviceID: alternate)
        let otherOrigin = try OperationPartition(origin: configuration.preview.worker, deviceID: partition.deviceID)
        try require(try await tracker.operations(for: otherDevice).isEmpty, "RECOVERY_FOREIGN_DEVICE_VISIBLE")
        try require(try await tracker.operations(for: otherOrigin).isEmpty, "RECOVERY_FOREIGN_ORIGIN_VISIBLE")
        try require(await gates.transport.count() == count, "RECOVERY_FOREIGN_LOOKUP_TRANSMITTED")
        try require(try diskData() == before, "RECOVERY_FOREIGN_LOOKUP_CHANGED_INDEX")
    }

    private func verifyJobExchanges() async throws {
        let exchanges = await gates.transport.recorded().filter {
            [PreviewFixture.createPath, PreviewFixture.resultPath].contains($0.request.url.path)
        }
        let expectedPaths: [String]
        switch configuration.phase {
        case .submit: expectedPaths = [PreviewFixture.createPath]
        case .recover: expectedPaths = [PreviewFixture.resultPath, PreviewFixture.resultPath]
        case .checkTerminal: expectedPaths = []
        }
        try require(exchanges.map { $0.request.url.path } == expectedPaths, "RECOVERY_JOB_REQUEST_COUNT_MISMATCH")
        for exchange in exchanges {
            try require(exchange.request.method == "POST" && exchange.request.url.host == configuration.preview.web.host,
                        "RECOVERY_JOB_REQUEST_ORIGIN_MISMATCH")
            if exchange.request.url.path == PreviewFixture.resultPath {
                guard let body = exchange.request.body else { throw ProofFailure("RECOVERY_RESULT_REQUEST_BODY_MISSING") }
                try require(try JSONDecoder().decode(JobResultRequest.self, from: body).jobId == backendJobID,
                            "RECOVERY_RESULT_REQUEST_HANDLE_MISMATCH")
            }
        }
    }

    private func diskData() throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: configuration.fileURL.path)
        try require(((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 65_536, "RECOVERY_INDEX_TOO_LARGE")
        return try Data(contentsOf: configuration.fileURL)
    }

    private func diskRecords() throws -> [TrackedOperation] {
        try JSONDecoder().decode([TrackedOperation].self, from: diskData())
    }
}
