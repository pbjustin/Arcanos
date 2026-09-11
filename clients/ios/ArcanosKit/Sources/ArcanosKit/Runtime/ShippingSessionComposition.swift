import Foundation

/// The app and App Intents enter here. No host-app launch, task lifetime, or in-memory
/// latest-job pointer is needed to reopen the same authenticated recovery index.
public actor ShippingSessionComposition {
    private let origin: URL?
    private let credentials: KeychainCredentialStore
    private let tracker: OperationTracker
    private let local: any ArcanosAI
    private let transport: any GatewayTransport
    private let now: @Sendable () -> Date
    private let testProfile: String
    private var active: (partition: OperationPartition, session: ArcanosSession, recovery: DurableSessionRecovery)?

    public init(origin: URL?, credentials: KeychainCredentialStore, persistence: any OperationPersistence,
                local: any ArcanosAI = LocalAI(), transport: any GatewayTransport = URLSessionGatewayTransport(),
                testProfile: String = "typescript-unit", now: @escaping @Sendable () -> Date = { Date() }) {
        self.origin = origin
        self.credentials = credentials
        self.tracker = OperationTracker(persistence: persistence, now: now)
        self.local = local
        self.transport = transport
        self.testProfile = testProfile
        self.now = now
    }

    public func ask(_ command: String, localContext: String? = nil) async -> SessionResult {
        if ["check latest arcanos job", "check my arcanos job", "check that job", "read the result",
            "read arcanos result"].contains(RoutingPolicy.normalize(command)) {
            return await checkLatest()
        }
        do { return await (try await open()).session.ask(command, localContext: localContext) }
        catch {
            // Unavailable secure storage must never turn a local-capable request into a
            // pairing operation, credential deletion, or remote call.
            let session = ArcanosSession(router: AIRouter(local: local, remote: CredentialUnavailableAI(error: error)))
            if ["run tests", "run my tests", "check my repository", "check my repo", "git status",
                "apply that patch", "apply the patch"].contains(RoutingPolicy.normalize(command)) { return .failure(error) }
            return await session.ask(command, localContext: localContext)
        }
    }

    /// Startup and foreground perform bounded observations. They never submit or approve.
    public func startup() async -> [SessionResult] { await recover() }
    public func foreground() async -> [SessionResult] { await recover() }

    public func checkLatest(operationID: UUID? = nil) async -> SessionResult {
        do { return await (try await open()).session.checkLatest(operationID: operationID) }
        catch { return .failure(error) }
    }

    public func checkJob(_ jobID: String) async -> SessionResult {
        do { return await (try await open()).session.checkJob(jobID) }
        catch { return .failure(error) }
    }

    public func approve(_ approvalID: UUID) async -> SessionResult {
        do { return await (try await open()).session.approve(approvalID) }
        catch { return .failure(error) }
    }

    public func cancel(_ approvalID: UUID) async -> SessionResult {
        do { return await (try await open()).session.cancel(approvalID) }
        catch { return .failure(error) }
    }

    public func previewPatch(_ patch: String) async -> SessionResult {
        do { return await (try await open()).session.previewPatch(patch) }
        catch { return .failure(error) }
    }

    private func recover() async -> [SessionResult] {
        do { return await (try await open()).recovery.restore() }
        catch { return [.failure(error)] }
    }

    private func open() async throws -> (session: ArcanosSession, recovery: DurableSessionRecovery) {
        do {
            guard let origin else { throw GatewayError.unpaired }
            guard let context = try await credentials.authenticatedContext(for: origin) else { throw GatewayError.unpaired }
            let partition = try OperationPartition(origin: context.credential.origin, deviceID: context.deviceID)
            if let active, active.partition == partition { return (active.session, active.recovery) }
            let bound = PartitionCredentialProvider(store: credentials, partition: partition)
            let gateway = try GatewayClient(baseURL: context.credential.origin, credentials: bound, transport: transport, now: now)
            let jobs = JobClient(gateway: gateway)
            let recovery = DurableSessionRecovery(tracker: tracker, partition: partition, credentials: bound, jobs: jobs, now: now)
            let session = ArcanosSession(router: AIRouter(local: local, remote: DurableRemoteAI(recovery: recovery)),
                capabilities: CapabilityClient(gateway: gateway), jobs: jobs, testProfile: testProfile, recovery: recovery, now: now)
            active = (partition, session, recovery)
            return (session, recovery)
        } catch {
            // A locked Keychain is not unpairing. Discard only volatile approval context;
            // leave credentials, installation identity, and recovery files untouched.
            active = nil
            throw error
        }
    }
}

private struct CredentialUnavailableAI: ArcanosAI {
    let error: any Error
    func availability() async -> AIAvailability { .unavailable }
    func respond(to request: AIRequest) async throws -> AIResponse { throw error }
}

/// Captures the security partition, not the bearer. Each transport call gets a fresh
/// credential only if Keychain still identifies the original server-issued device.
struct PartitionCredentialProvider: GatewayCredentialProvider {
    let store: KeychainCredentialStore
    let partition: OperationPartition

    func credential(for origin: URL) async throws -> GatewayCredential? {
        guard let context = try await store.authenticatedContext(for: origin) else { throw GatewayError.unpaired }
        guard try OperationPartition(origin: context.credential.origin, deviceID: context.deviceID) == partition else {
            throw GatewayError.authenticationFailure
        }
        return context.credential
    }

    func validate() async throws {
        guard let origin = URL(string: partition.origin) else { throw GatewayError.invalidConfiguration }
        _ = try await credential(for: origin)
    }

    func rejectedCredential(_ token: String, for origin: URL, error: GatewayError) async {
        await store.rejectedCredential(token, for: origin, error: error)
    }
}

private struct DurableRemoteAI: ArcanosAI {
    let recovery: DurableSessionRecovery
    func availability() async -> AIAvailability { .available }
    func respond(to request: AIRequest) async throws -> AIResponse {
        try await recovery.submitAI(request)
    }
}

/// Product orchestration over the existing tracker and authenticated clients. This
/// coordinator stores no second index, request payload, result content, or approval secret.
public actor DurableSessionRecovery {
    private let tracker: OperationTracker
    let partition: OperationPartition
    private let credentials: PartitionCredentialProvider
    private let jobs: JobClient
    private let now: @Sendable () -> Date
    private var verifiedPreviewHashes: [String: String] = [:]

    init(tracker: OperationTracker, partition: OperationPartition, credentials: PartitionCredentialProvider,
         jobs: JobClient, now: @escaping @Sendable () -> Date) {
        self.tracker = tracker
        self.partition = partition
        self.credentials = credentials
        self.jobs = jobs
        self.now = now
    }

    func prepare(kind: TrackedOperationKind, action: String? = nil, summary: String, key: String) async throws -> UUID {
        try await credentials.validate()
        let operation = try TrackedOperation(partition: partition, kind: kind, displaySummary: summary,
            createdAt: now(), idempotencyKey: key, capabilityAction: action)
        try await tracker.prepare(operation)
        return operation.id
    }

    func accept(_ operationID: UUID, jobID: String, status: String) async throws {
        // Save a delivered receipt even if cancellation or credential rotation occurred
        // while awaiting HTTP. Validation below controls presentation, never this write.
        try await tracker.accept(operationID, jobID: jobID, backendStatus: status)
    }

    func uncertain(_ operationID: UUID) async throws { try await tracker.markSubmissionUncertain(operationID) }
    func takePreviewHash(jobID: String) -> String? { verifiedPreviewHashes.removeValue(forKey: jobID) }

    func submitAI(_ request: AIRequest) async throws -> AIResponse {
        let key = UUID().uuidString
        let operationID = try await prepare(kind: .remoteAI, summary: "Remote ARCANOS request", key: key)
        var acceptedJobID: String?
        do {
            let receipt = try await jobs.create(CreateAIJobRequest(gptId: "arcanos-core", task: request.command,
                context: request.localContext, maxOutputTokens: 1_024, idempotencyKey: key))
            try await accept(operationID, jobID: receipt.jobId, status: receipt.status)
            acceptedJobID = receipt.jobId
            try await credentials.validate()
            // End the initial voice interaction after durable acceptance. There is no
            // detached task and no claim that observation continues while suspended.
            return AIResponse(text: "ARCANOS accepted the request. Completion is not yet verified. Ask Check Latest Arcanos Job later.",
                execution: .remote, jobID: receipt.jobId)
        } catch {
            do { try await uncertain(operationID) }
            catch { throw RecoverySubmissionFailure(result: .failure(error)) }
            let result = SessionResult.failure(error)
            let text = acceptedJobID == nil ? result.text : "ARCANOS accepted the request and saved its receipt. Completion is unverified. \(result.text)"
            throw RecoverySubmissionFailure(result: SessionResult(text: text, kind: acceptedJobID == nil ? result.kind : .unavailable,
                jobID: acceptedJobID, operationID: operationID, partition: partition))
        }
    }

    func identify(_ result: SessionResult, operationID: UUID? = nil) async throws -> SessionResult {
        try await credentials.validate()
        let operations = try await tracker.operations(for: partition)
        let matches = operations.filter {
            if let operationID { return $0.id == operationID }
            return result.jobID != nil && $0.backendJobID == result.jobID
        }
        guard matches.count <= 1 else { throw OperationTrackingError.ambiguousReference }
        guard let record = matches.first else { throw OperationTrackingError.notFound }
        return SessionResult(text: result.text, kind: result.kind, approvalID: result.approvalID,
            jobID: record.backendJobID, operationID: record.id, partition: partition)
    }

    func checkLatest(operationID: UUID? = nil) async -> SessionResult {
        do {
            try await credentials.validate()
            let operation: TrackedOperation?
            if let operationID {
                operation = try await tracker.operations(for: partition).first { $0.id == operationID }
            } else {
                operation = try await tracker.resolveRecent(for: partition)
            }
            guard let operation else { throw OperationTrackingError.notFound }
            return await check(operation)
        } catch { return .failure(error) }
    }

    func checkJob(_ jobID: String) async -> SessionResult {
        do {
            try await credentials.validate()
            let matches = try await tracker.operations(for: partition).filter { $0.backendJobID == jobID }
            guard matches.count == 1, let operation = matches.first else { throw OperationTrackingError.notFound }
            return await check(operation)
        } catch { return .failure(error) }
    }

    func restore() async -> [SessionResult] {
        do {
            try await credentials.validate()
            // Four bounded, sequential reads per app lifecycle activation; status intents
            // select one operation. Older references remain available by their explicit ID.
            let operations = try await tracker.operations(for: partition).filter { $0.localState != .dismissed }.prefix(4)
            var results: [SessionResult] = []
            for operation in operations {
                try Task.checkCancellation()
                results.append(await check(operation))
            }
            return results
        } catch { return [.failure(error)] }
    }

    private func check(_ operation: TrackedOperation) async -> SessionResult {
        func result(_ text: String, _ kind: SessionResult.Kind) -> SessionResult {
            SessionResult(text: text, kind: kind, jobID: operation.backendJobID,
                operationID: operation.id, partition: partition)
        }
        guard let jobID = operation.backendJobID else {
            if [.confirmation, .patchApply].contains(operation.kind) || operation.capabilityAction == "tests.run" {
                return result("This action has no verified receipt. Restoration cannot approve or repeat it. A fresh user-initiated approval flow is required; first verify whether the original action ran.", .unavailable)
            }
            return result("Submission is uncertain and no accepted job receipt is available. ARCANOS cannot verify completion or safely repeat this operation.", .unavailable)
        }
        do {
            // Reading status never creates work, replays a lost request, or consumes an approval.
            let response = try await jobs.result(jobID: jobID)
            try await credentials.validate()
            guard response.jobId == jobID, response.ok else { throw GatewayError.invalidResponse }
            if let jobStatus = response.jobStatus {
                let lifecycle = jobStatus == "pending" ? "queued" : jobStatus
                guard lifecycle == response.lifecycleStatus || (jobStatus == "pending" && response.lifecycleStatus == "pending") else {
                    throw GatewayError.invalidResponse
                }
            }
            guard operation.localState != .terminal || response.status != "pending" else { throw GatewayError.invalidResponse }
            let text: String
            let kind: SessionResult.Kind
            switch response.status {
            case "pending":
                guard response.error == nil,
                      ["queued", "pending", "running"].contains(response.lifecycleStatus) else { throw GatewayError.invalidResponse }
                text = response.lifecycleStatus == "running"
                    ? "ARCANOS verified that the job is still running. Check again later."
                    : "ARCANOS verified that the accepted job is still pending. Check again later."
                kind = .pending
            case "completed":
                guard response.error == nil, response.lifecycleStatus == "completed" else { throw GatewayError.invalidResponse }
                text = try verifiedText(response.result, operation: operation)
                kind = .answer
            case "failed":
                guard ["failed", "cancelled"].contains(response.lifecycleStatus) else { throw GatewayError.invalidResponse }
                text = response.lifecycleStatus == "cancelled" ? "ARCANOS verified that the backend job was cancelled."
                    : "ARCANOS verified that the backend job failed."
                kind = .failure
            case "expired", "not_found":
                guard response.lifecycleStatus == response.status else { throw GatewayError.invalidResponse }
                text = "The Gateway cannot provide this job's result. Its completion is not verified."
                kind = .unavailable
            default: throw GatewayError.invalidResponse
            }
            // Corrupt or unrecognized completion is rejected before it enters the index.
            try await tracker.observe(operation.id, jobID: jobID, backendStatus: response.status, terminal: response.status != "pending")
            // A different app/intent read may have won while HTTP was suspended. The
            // tracker intentionally preserves terminal evidence; do not present a delayed
            // response that disagrees with that newer durable observation.
            guard let current = try await tracker.operations(for: partition).first(where: { $0.id == operation.id }) else {
                throw OperationTrackingError.notFound
            }
            let canonicalCancellation = current.backendStatus == "cancelled" && response.status == "failed" && response.lifecycleStatus == "cancelled"
            guard current.backendStatus == response.status || canonicalCancellation else {
                return result("Another observation updated this operation. Check it again to verify its current result.", .unavailable)
            }
            return result(text, kind)
        } catch {
            let failure = SessionResult.failure(error)
            return result(failure.text, failure.kind == .cancelled ? .cancelled : .unavailable)
        }
    }

    private func verifiedText(_ value: JSONValue, operation: TrackedOperation) throws -> String {
        if operation.kind == .remoteAI {
            guard let answer = ResultProjection.aiText(value) else { throw GatewayError.invalidResponse }
            return answer
        }
        guard let output = ResultProjection.localAgentOutput(value) else { throw GatewayError.invalidResponse }
        switch operation.capabilityAction {
        case "git.status":
            guard output["gitAvailable"]?.boolValue == true, let clean = output["clean"]?.boolValue else { throw GatewayError.invalidResponse }
            return clean ? "The Local Agent reports a clean repository." : "The Local Agent reports uncommitted repository changes."
        case "tests.run":
            switch output["status"]?.stringValue {
            case "passed": return "The Local Agent reports that the tests passed."
            case "failed": return "The Local Agent reports that the tests failed."
            case "timed_out": return "The Local Agent reports that the tests timed out."
            default: throw GatewayError.invalidResponse
            }
        case "patch.apply":
            guard output["applied"]?.boolValue == true else { throw GatewayError.invalidResponse }
            return "The Local Agent confirmed that the approved patch was applied."
        case "patch.preview":
            guard output["applicable"]?.boolValue == true,
                  let hash = output["patchSha256"]?.stringValue,
                  hash.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil else { throw GatewayError.invalidResponse }
            if let jobID = operation.backendJobID { verifiedPreviewHashes[jobID] = hash }
            return "The backend confirmed the patch preview. Restoring it does not authorize applying a patch; request a fresh preview and approval."
        default: throw GatewayError.invalidResponse
        }
    }
}

struct RecoverySubmissionFailure: Error {
    let result: SessionResult
}
