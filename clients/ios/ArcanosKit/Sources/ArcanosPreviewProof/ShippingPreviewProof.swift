import ArcanosKit
import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

struct ShippingPreviewConfiguration: Sendable {
    enum Phase: String, Sendable {
        case dismissSubmit = "dismiss-submit", aiRestore = "ai-restore"
        case concurrentSubmit = "concurrent-submit", capabilityRestore = "capability-restore"
        case foreign, terminal, unknownHandle = "unknown-handle"
    }
    let phase: Phase
    let fileURL: URL
    let deviceID: UUID
    let preview: ProofConfiguration

    init(arguments: [String]) throws {
        try require(arguments.count >= 6 && arguments[0] == "--shipping-recovery-phase"
            && arguments[2] == "--store-path" && arguments[4] == "--device-id", "SHIPPING_ARGUMENTS_INVALID")
        guard let phase = Phase(rawValue: arguments[1]), let deviceID = UUID(uuidString: arguments[5]),
              arguments[3].hasPrefix("/"), arguments[3].utf8.count <= 4096,
              !arguments[3].contains("\0"), !arguments[3].contains("\n"), !arguments[3].contains("\r") else {
            throw ProofFailure("SHIPPING_IDENTITY_OR_PATH_INVALID")
        }
        self.phase = phase
        self.deviceID = deviceID
        // Foundation may leave a symlink unresolved when the final file does not
        // exist. Resolve the nearest existing ancestor before appending new parts.
        var ancestor = URL(fileURLWithPath: arguments[3]).standardizedFileURL
        var missing: [String] = []
        while !FileManager.default.fileExists(atPath: ancestor.path) && ancestor.path != "/" {
            missing.append(ancestor.lastPathComponent)
            ancestor.deleteLastPathComponent()
        }
        fileURL = missing.reversed().reduce(ancestor.resolvingSymlinksInPath()) { $0.appendingPathComponent($1) }
        preview = try ProofConfiguration(arguments: Array(arguments.dropFirst(6)))
        let root = preview.repositoryRoot.resolvingSymlinksInPath().path
        try require(fileURL.path != root && !fileURL.path.hasPrefix(root + "/"), "SHIPPING_STORE_INSIDE_CHECKOUT")
    }
}

/// Validated synthetic device session in memory; no Apple Keychain access or disk credentials.
final class ShippingPreviewCredentials: CredentialItemStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    func read(account: String) throws -> Data? { lock.withLock { items[account] } }
    func replace(account: String, data: Data) throws { lock.withLock { items[account] = data } }
    func remove(account: String) throws { _ = lock.withLock { items.removeValue(forKey: account) } }
}

final class ShippingPreviewClock: @unchecked Sendable {
    private let lock = NSLock()
    private var offset: TimeInterval = 0
    func now() -> Date { lock.withLock { Date().addingTimeInterval(offset) } }
    func expireChallenges() { lock.withLock { offset = 300 } }
}

struct ShippingPreviewLocalAI: ArcanosAI {
    func availability() async -> AIAvailability { .unavailable }
    func respond(to request: AIRequest) async throws -> AIResponse { throw ProofFailure("UNEXPECTED_LOCAL_AI") }
}

/// The only fixture adaptation is a fixed synthetic device bearer to the existing
/// public preview bearer. URL, body, idempotency, and all response bytes are unchanged.
/// Holds happen after real HTTPS responses arrive, before the shipping client sees them.
actor ShippingPreviewTransport: GatewayTransport {
    static let deviceToken = "agd1." + String(repeating: "A", count: 43)
    let actual: ObservedTransport
    let origin: URL
    private var holdStatus: Int?
    private var held: CheckedContinuation<GatewayResponse, any Error>?
    private var heldResponse: GatewayResponse?

    init(actual: ObservedTransport, origin: URL) { self.actual = actual; self.origin = origin }

    static func fixtureRequest(_ request: GatewayRequest, origin: URL) throws -> GatewayRequest {
        let paths = [PreviewFixture.createPath, PreviewFixture.resultPath, PreviewFixture.runPath]
        guard let parts = URLComponents(url: request.url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == origin.host, parts.port == nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              paths.contains(parts.path), request.method == "POST",
              request.headers["Authorization"] == "Bearer " + deviceToken,
              request.headers["X-Arcanos-Device-Origin"] == origin.absoluteString,
              request.headers["Accept"] == "application/json", request.headers["Cache-Control"] == "no-store",
              request.headers["Content-Type"] == "application/json", request.body != nil,
              Set(request.headers.keys).isSubset(of: ["Authorization", "X-Arcanos-Device-Origin", "Accept",
                  "Cache-Control", "Content-Type", "Idempotency-Key"]) else {
            throw ProofFailure("SHIPPING_CREDENTIAL_ADAPTER_DENIED")
        }
        var headers = request.headers
        headers["Authorization"] = "Bearer " + PreviewFixture.token
        return GatewayRequest(url: request.url, method: request.method, headers: headers, body: request.body)
    }

    func holdNext(status: Int) throws {
        try require(holdStatus == nil && held == nil && [200, 403].contains(status), "SHIPPING_HOLD_INVALID")
        holdStatus = status
    }
    func waitUntilHeld() async throws {
        let deadline = Date().addingTimeInterval(20)
        while held == nil {
            try require(Date() < deadline, "SHIPPING_HOLD_TIMEOUT")
            try await Task.sleep(for: .milliseconds(10))
        }
    }
    func release() {
        let continuation = held, response = heldResponse
        held = nil; heldResponse = nil; holdStatus = nil
        if let response { continuation?.resume(returning: response) }
        else { continuation?.resume(throwing: CancellationError()) }
    }
    private func cancelHold() {
        let continuation = held
        held = nil; heldResponse = nil; holdStatus = nil
        continuation?.resume(throwing: CancellationError())
    }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        let outgoing = try Self.fixtureRequest(request, origin: origin)
        let response = try await actual.send(outgoing)
        if request.url.path == PreviewFixture.runPath && holdStatus == response.statusCode {
            return try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await withCheckedThrowingContinuation { held = $0; heldResponse = response }
            } onCancel: { Task { await self.cancelHold() } }
        }
        return response
    }
}

struct ShippingPreviewReport: Encodable {
    let kind = "ios_shipping_recovery_https_proof"
    let proofVersion = "ios-shipping-recovery-https/v1"
    let scope = "ShippingSessionComposition and durable files across fresh CLI processes over actual HTTPS against a sealed synthetic peer"
    let credentialStorage = "in-memory-fixture"
    let credentialAdapter = "fixed-synthetic-device-bearer-to-public-preview-bearer"
    let shippingAppLifecycle = false, physicalDevice = false, liveProvider = false
    let database = false, activeWorker = false, controlPlaneProvenanceAsserted = false
    let status: String
    let phase: String
    let executed: Bool
    let networkAttempted: Bool
    let prNumber: Int
    let sourceCommit: String
    let webBaseURL: URL
    let workerBaseURL: URL
    let processID = ProcessInfo.processInfo.processIdentifier
    let operationID: UUID?
    let backendJobID: String?
    let requestsMade: Int
    let createRequests: Int
    let capabilityRequests: Int
    let resultRequests: Int
    let responseBytes: Int
    let checks: [String]
    let code: String?
}

enum ShippingPreviewProof {
    static func main(arguments: [String]) async {
        var runner: ShippingPreviewRunner?
        do {
            let configuration = try ShippingPreviewConfiguration(arguments: arguments)
            try configuration.preview.verifyGit()
            let active = ShippingPreviewRunner(configuration: configuration)
            runner = active
            let report = try await withThrowingTaskGroup(of: ShippingPreviewReport.self) { group in
                group.addTask { try await active.run() }
                group.addTask { try await Task.sleep(for: .seconds(120)); throw ProofFailure("SHIPPING_TOTAL_TIMEOUT") }
                defer { group.cancelAll() }
                guard let report = try await group.next() else { throw ProofFailure("SHIPPING_RESULT_MISSING") }
                return report
            }
            emit(report)
        } catch {
            let code = (error as? ProofFailure)?.code ?? "SHIPPING_HTTPS_PROOF_FAILED"
            if let runner { emit(await runner.report(status: "FAIL", code: code), toError: true) }
            else { emit(["status": "FAIL", "code": code], toError: true) }
            exit(1)
        }
    }
    private static func emit<T: Encodable>(_ value: T, toError: Bool = false) {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value) else { exit(1) }
        (toError ? FileHandle.standardError : FileHandle.standardOutput).write(data + Data([10]))
    }
}

actor ShippingPreviewRunner {
    let configuration: ShippingPreviewConfiguration
    let gates: ProofRunner
    private var operationID: UUID?
    private var jobID: String?
    private var checks = ["clean_exact_git_head_and_canonical_origin", "pr_scoped_https_origins", "network_opt_in_gate_validated"]
    init(configuration: ShippingPreviewConfiguration) {
        self.configuration = configuration
        gates = ProofRunner(configuration: configuration.preview)
    }
    func run() async throws -> ShippingPreviewReport {
        guard configuration.preview.execute else { return await report(status: "PASS") }
        let initial = try await identity()
        checks.append("initial_roles_device_policy_and_metadata_verified")
        await gates.transport.admit()
        let clock = ShippingPreviewClock()
        let credentials = KeychainCredentialStore(storage: ShippingPreviewCredentials(), now: { clock.now() })
        let now = clock.now(), formatter = ISO8601DateFormatter()
        try await credentials.storePairedSession(DeviceCredentialResponse(ok: true,
            deviceId: configuration.deviceID.uuidString, credential: ShippingPreviewTransport.deviceToken,
            tokenType: "Bearer", audience: "gpt-access-device-v1", origin: configuration.preview.web.absoluteString,
            issuedAt: formatter.string(from: now.addingTimeInterval(-10)),
            expiresAt: formatter.string(from: now.addingTimeInterval(1800)),
            renewalExpiresAt: formatter.string(from: now.addingTimeInterval(3600)),
            scopes: ["jobs.create", "jobs.result", "capabilities.run"], capabilityActions: ["tests.run"],
            gptIds: ["arcanos-core"]), for: configuration.preview.web)
        let transport = ShippingPreviewTransport(actual: gates.transport, origin: configuration.preview.web)
        let persistence = FileOperationPersistence(fileURL: configuration.fileURL)
        let shipping = ShippingSessionComposition(origin: configuration.preview.web, credentials: credentials,
            persistence: persistence, local: ShippingPreviewLocalAI(), transport: transport, now: { clock.now() })
        switch configuration.phase {
        case .dismissSubmit:
            try require(!FileManager.default.fileExists(atPath: configuration.fileURL.path), "SHIPPING_SUBMISSION_STORE_EXISTS")
            let cancelled = try approval(await shipping.ask("Run tests"))
            let beforeCancel = await gates.transport.count()
            try require(await shipping.cancel(cancelled).kind == .cancelled, "SHIPPING_CANCEL_FAILED")
            try require(await shipping.approve(cancelled).kind == .failure, "SHIPPING_CANCEL_REPLAY_ACCEPTED")
            try require(await gates.transport.count() == beforeCancel, "SHIPPING_CANCEL_TRANSMITTED")
            try dismissed(count: 1)
            checks.append("cancelled_approval_durably_dismissed_without_retry")
            let expired = try approval(await shipping.ask("Run tests"))
            clock.expireChallenges()
            let beforeExpiry = await gates.transport.count()
            try require(await shipping.approve(expired).text == SessionResult.failure(ConfirmationError.expired).text,
                "SHIPPING_APPROVAL_DID_NOT_EXPIRE")
            try require(await gates.transport.count() == beforeExpiry, "SHIPPING_EXPIRED_APPROVAL_TRANSMITTED")
            try dismissed(count: 2)
            checks.append("expired_approval_durably_dismissed_without_retry")
            try require(await shipping.ask("Run tests").text == SessionResult.failure(ConfirmationError.expired).text,
                "SHIPPING_OLD_CHALLENGE_ACCEPTED")
            try dismissed(count: 3)
            checks.append("already_expired_challenge_durably_dismissed")
            let accepted = await shipping.ask(PreviewFixture.aiTask)
            try accept(accepted, expectedRecords: 4)
            checks.append("shipping_ai_receipt_durable_before_process_exit")

        case .concurrentSubmit:
            try require(!FileManager.default.fileExists(atPath: configuration.fileURL.path), "SHIPPING_SUBMISSION_STORE_EXISTS")
            try await transport.holdNext(status: 403)
            let initialTask = Task { await shipping.ask("Run tests") }
            do {
                try await transport.waitUntilHeld()
                try await blocked(shipping, approvalID: nil)
                await transport.release()
                let approvalID = try approval(await initialTask.value)
                try await blocked(shipping, approvalID: nil)
                checks.append("inflight_and_pending_approval_block_overlap_without_phantom_record")
                try await transport.holdNext(status: 200)
                let approvedTask = Task { await shipping.approve(approvalID) }
                do {
                    try await transport.waitUntilHeld()
                    try await blocked(shipping, approvalID: approvalID)
                    await transport.release()
                    try accept(await approvedTask.value, expectedRecords: 1)
                } catch { approvedTask.cancel(); await transport.release(); _ = await approvedTask.value; throw error }
                let beforeReplay = await gates.transport.count()
                let replay = await shipping.approve(approvalID)
                let replayCount = await gates.transport.count()
                try require(replay.kind == .failure && replayCount == beforeReplay, "SHIPPING_APPROVAL_REPLAYED")
                checks.append("held_approved_retry_blocks_overlap_and_replay_without_phantom_record")
                try await exactRetry()
                checks.append("approved_retry_exact_bytes_and_idempotency_once")
            } catch { initialTask.cancel(); await transport.release(); _ = await initialTask.value; throw error }

        case .aiRestore, .capabilityRestore, .terminal:
            let record = try selected()
            operationID = record.id; jobID = record.backendJobID
            let restored = await shipping.startup()
            try require(restored.count == 1, "SHIPPING_STARTUP_CARDINALITY_MISMATCH")
            let ai = record.kind == .remoteAI
            let text = ai ? PreviewFixture.aiAnswer : "The Local Agent reports that the tests passed."
            try bound(restored[0], to: record, kind: configuration.phase == .aiRestore ? .pending : .answer,
                text: configuration.phase == .aiRestore ? nil : text)
            if configuration.phase != .terminal {
                try bound(await shipping.ask("Check Latest Arcanos Job"), to: record, kind: .answer, text: text)
                if configuration.phase == .aiRestore {
                    let foreground = await shipping.foreground()
                    try require(foreground.count == 1, "SHIPPING_FOREGROUND_CARDINALITY_MISMATCH")
                    try bound(foreground[0], to: record, kind: .answer, text: text)
                }
            }
            let terminal = try selected()
            try require(terminal.localState == .terminal && terminal.backendStatus == "completed"
                && terminal.backendJobID == record.backendJobID && terminal.id == record.id, "SHIPPING_TERMINAL_NOT_DURABLE")
            checks.append("shipping_startup_and_result_recovery_bound_to_saved_operation")

        case .foreign:
            let before = try diskData()
            try require(await shipping.startup().isEmpty, "SHIPPING_FOREIGN_PARTITION_RESTORED")
            try require(await shipping.ask("Check Latest Arcanos Job").kind == .unavailable, "SHIPPING_FOREIGN_LATEST_VISIBLE")
            try require(try diskData() == before, "SHIPPING_FOREIGN_INDEX_MUTATED")
            checks.append("foreign_credential_partition_no_gateway_requests_or_file_mutation")

        case .unknownHandle:
            let before = try diskData(), record = try selected()
            operationID = record.id; jobID = record.backendJobID
            let restored = await shipping.startup()
            try require(restored.count == 1 && restored[0].kind == .unavailable
                && restored[0].jobID == record.backendJobID && restored[0].operationID == record.id,
                "SHIPPING_UNKNOWN_HANDLE_FALSE_SUCCESS")
            let exchanges = await gates.transport.recorded().filter { $0.request.url.path == PreviewFixture.resultPath }
            try require(exchanges.count == 1 && exchanges[0].response.statusCode == 200
                && (try ResponseEvidence.json(exchanges[0].response))["status"] == .string("not_found")
                && (try ResponseEvidence.json(exchanges[0].response))["jobId"] == .string(record.backendJobID!)
                && (try JSONDecoder().decode(JobResultRequest.self, from: exchanges[0].request.body!)).jobId == record.backendJobID
                && diskData() == before, "SHIPPING_UNKNOWN_HANDLE_MUTATED_OR_NOT_REJECTED")
            checks.append("unknown_handle_denies_cached_completion_without_mutation_or_replay")
            throw ProofFailure("SHIPPING_UNKNOWN_HANDLE_REJECTED")
        }
        try await verifyExchanges()
        checks.append("phase_gateway_request_counts_and_identities_verified")
        try require(try await identity() == initial, "SHIPPING_PREVIEW_IDENTITY_DRIFT")
        try configuration.preview.verifyGit()
        checks.append("final_roles_device_policy_metadata_and_git_unchanged")
        return await report(status: "PASS")
    }

    private func identity() async throws -> [JSONValue] {
        let web = try await gates.readiness(configuration.preview.web, role: "web")
        let worker = try await gates.readiness(configuration.preview.worker, role: "worker")
        let policy = try await gates.raw(configuration.preview.web, path: PreviewFixture.devicePolicyPath, method: "GET")
        try ResponseEvidence.devicePolicy(policy, prNumber: configuration.preview.prNumber, sourceCommit: configuration.preview.commit)
        let metadata = try await gates.raw(configuration.preview.web, path: PreviewFixture.metadataPath, method: "GET", authenticated: true)
        let value = try ResponseEvidence.json(metadata)
        try require(metadata.statusCode == 200 && value == gates.expectedMetadata, "SHIPPING_METADATA_MISMATCH")
        return [web, worker, try ResponseEvidence.json(policy), value]
    }
    private func diskData() throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: configuration.fileURL.path)
        try require(((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 65_536, "SHIPPING_INDEX_TOO_LARGE")
        return try Data(contentsOf: configuration.fileURL)
    }
    private func records() throws -> [TrackedOperation] { try JSONDecoder().decode([TrackedOperation].self, from: diskData()) }
    private func selected() throws -> TrackedOperation {
        let records = try records().filter { $0.localState != .dismissed }
        try require(records.count == 1 && records[0].backendJobID != nil, "SHIPPING_OPERATION_AMBIGUOUS")
        return records[0]
    }
    private func approval(_ result: SessionResult) throws -> UUID {
        guard result.kind == .confirmationRequired, let id = result.approvalID else { throw ProofFailure("SHIPPING_APPROVAL_MISSING") }
        return id
    }
    private func dismissed(count: Int) throws {
        let records = try records()
        try require(records.count == count && records.allSatisfy { $0.localState == .dismissed && $0.backendJobID == nil
            && $0.backendStatus == nil && $0.kind == .confirmation }, "SHIPPING_DISMISSAL_NOT_DURABLE")
    }
    private func accept(_ result: SessionResult, expectedRecords: Int) throws {
        let record = try selected()
        try require(result.kind == .pending && result.jobID == record.backendJobID && result.operationID == record.id
            && result.partition == record.partition && record.localState == .accepted
            && records().count == expectedRecords, "SHIPPING_ACCEPTANCE_NOT_DURABLE")
        operationID = record.id; jobID = record.backendJobID
    }
    private func bound(_ result: SessionResult, to record: TrackedOperation, kind: SessionResult.Kind, text: String?) throws {
        try require(result.kind == kind && result.jobID == record.backendJobID && result.operationID == record.id
            && result.partition == record.partition && (text == nil || result.text == text), "SHIPPING_RECOVERED_RESULT_MISMATCH")
    }
    private func blocked(_ shipping: ShippingSessionComposition, approvalID: UUID?) async throws {
        let before = try diskData(), count = await gates.transport.count()
        let result = await shipping.ask("Run tests")
        try require(result.text == SessionResult.failure(ConfirmationError.busy).text, "SHIPPING_OVERLAP_NOT_BLOCKED")
        if let approvalID {
            try require(await shipping.approve(approvalID).text == SessionResult.failure(ConfirmationError.busy).text, "SHIPPING_OVERLAP_APPROVE_NOT_BLOCKED")
            try require(await shipping.cancel(approvalID).text == SessionResult.failure(ConfirmationError.busy).text, "SHIPPING_OVERLAP_CANCEL_NOT_BLOCKED")
        }
        let afterCount = await gates.transport.count()
        try require(try diskData() == before && afterCount == count, "SHIPPING_OVERLAP_MUTATED_OR_TRANSMITTED")
    }
    private func exactRetry() async throws {
        let exchanges = await gates.transport.recorded().filter { $0.request.url.path == PreviewFixture.runPath }
        try require(exchanges.count == 2 && exchanges[0].response.statusCode == 403 && exchanges[1].response.statusCode == 200,
            "SHIPPING_RETRY_COUNT_INVALID")
        let first = exchanges[0], retry = exchanges[1]
        guard let original = first.request.body, let retried = retry.request.body,
              let token = try ResponseEvidence.json(first.response)["confirmationChallenge"]?["id"]?.stringValue else {
            throw ProofFailure("SHIPPING_RETRY_CHALLENGE_MISSING")
        }
        var expected = Data(original.dropLast()); expected.append(Data(",\"confirmation_token\":".utf8))
        expected.append(try JSONEncoder().encode(token)); expected.append(125)
        try require(retried == expected && first.request.headers == retry.request.headers
            && first.request.url == retry.request.url && first.request.headers["Idempotency-Key"] != nil, "SHIPPING_RETRY_NOT_EXACT")
    }
    private func verifyExchanges() async throws {
        let exchanges = await gates.transport.recorded().filter { $0.request.method == "POST" }
        let expected: [String]
        switch configuration.phase {
        case .dismissSubmit: expected = Array(repeating: PreviewFixture.runPath, count: 3) + [PreviewFixture.createPath]
        case .concurrentSubmit: expected = Array(repeating: PreviewFixture.runPath, count: 2)
        case .aiRestore: expected = Array(repeating: PreviewFixture.resultPath, count: 3)
        case .capabilityRestore: expected = Array(repeating: PreviewFixture.resultPath, count: 2)
        case .terminal: expected = [PreviewFixture.resultPath]
        case .foreign: expected = []
        case .unknownHandle: throw ProofFailure("SHIPPING_NEGATIVE_CONTROL_DID_NOT_FAIL")
        }
        try require(exchanges.map { $0.request.url.path } == expected, "SHIPPING_REQUEST_COUNT_MISMATCH")
        for exchange in exchanges {
            try require(exchange.request.url.host == configuration.preview.web.host
                && exchange.request.headers["Authorization"] == "Bearer " + PreviewFixture.token, "SHIPPING_REQUEST_IDENTITY_MISMATCH")
            if exchange.request.url.path == PreviewFixture.resultPath {
                try require(try JSONDecoder().decode(JobResultRequest.self, from: exchange.request.body!).jobId == jobID,
                    "SHIPPING_RESULT_REQUEST_HANDLE_MISMATCH")
            }
        }
    }
    func report(status: String, code: String? = nil) async -> ShippingPreviewReport {
        let exchanges = await gates.transport.recorded()
        return ShippingPreviewReport(status: status, phase: configuration.phase.rawValue, executed: configuration.preview.execute,
            networkAttempted: await gates.transport.count() > 0, prNumber: configuration.preview.prNumber,
            sourceCommit: configuration.preview.commit, webBaseURL: configuration.preview.web, workerBaseURL: configuration.preview.worker,
            operationID: operationID, backendJobID: jobID, requestsMade: await gates.transport.count(),
            createRequests: exchanges.filter { $0.request.url.path == PreviewFixture.createPath }.count,
            capabilityRequests: exchanges.filter { $0.request.url.path == PreviewFixture.runPath }.count,
            resultRequests: exchanges.filter { $0.request.url.path == PreviewFixture.resultPath }.count,
            responseBytes: await gates.transport.bytes(), checks: checks, code: code)
    }
}
