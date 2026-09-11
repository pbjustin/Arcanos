import ArcanosKit
import Foundation

struct ProofReport: Encodable, Sendable {
    let schemaVersion = 1
    let kind = "ios_gateway_client_https_proof"
    let proofVersion = PreviewFixture.version
    let devicePolicyProofVersion = PreviewFixture.devicePolicyVersion
    let scope = "actual Swift HTTPS client and served device policy checks against sealed synthetic peer; passive worker; no live provider, database, queue, device pairing, Siri, or Foundation Models proof"
    let status = "PASS"
    let executed: Bool
    let networkAttempted: Bool
    let prNumber: Int
    let sourceCommit: String
    let webBaseURL: URL
    let workerBaseURL: URL
    let controlPlaneProvenanceAsserted = false
    let maxRequests = 40
    let totalTimeoutSeconds = 120
    let maxAggregateResponseBytes = 2_097_152
    let requestsMade: Int
    let responseBytes: Int
    let checks: [String]
}

struct ProofRunner: Sendable {
    let configuration: ProofConfiguration
    let transport: ObservedTransport

    init(configuration: ProofConfiguration) {
        self.configuration = configuration
        transport = ObservedTransport(web: configuration.web, worker: configuration.worker)
    }

    func run() async throws -> ProofReport {
        var checks = ["clean_exact_git_head_and_canonical_origin", "pr_scoped_https_origins", "network_opt_in_gate_validated"]
        guard configuration.execute else { return await report(checks: checks) }
        let initialWeb = try await readiness(configuration.web, role: "web")
        let initialWorker = try await readiness(configuration.worker, role: "worker")
        checks.append("both_roles_exact_identity_and_sealed_readiness")
        let devicePolicy = try await raw(configuration.web, path: PreviewFixture.devicePolicyPath, method: "GET")
        try ResponseEvidence.devicePolicy(devicePolicy, prNumber: configuration.prNumber, sourceCommit: configuration.commit)
        checks.append("served_device_policy_semantics_exact_identity_and_contract")
        let metadata = try await raw(configuration.web, path: PreviewFixture.metadataPath, method: "GET", authenticated: true)
        try require(metadata.statusCode == 200, "METADATA_HTTP_STATUS")
        try require(try json(metadata) == expectedMetadata, "METADATA_CONTRACT_MISMATCH")
        checks.append("fixed_synthetic_contract_metadata_correspondence")
        await transport.admit()

        let gateway = try GatewayClient(baseURL: configuration.web, credentials: PreviewCredentials(permittedOrigin: configuration.web), transport: transport)
        let capabilities = CapabilityClient(gateway: gateway)
        let jobs = JobClient(gateway: gateway)
        let session = ArcanosSession(router: AIRouter(remote: RemoteAI(jobs: jobs)), capabilities: capabilities, jobs: jobs)
        let listed = try await capabilities.list()
        try require(listed.capabilities.count == 1 && listed.capabilities.first?.id == "ARCANOS:LOCAL_AGENT", "CAPABILITY_LIST_MISMATCH")
        let detail = try await capabilities.detail(id: "ARCANOS:LOCAL_AGENT")
        try require(detail.exists && detail.capability?.actionMetadata?["tests.run"]?.requiresConfirmation == true
                    && detail.capability?.actionMetadata?["patch.preview"]?.requiresConfirmation == false, "CAPABILITY_DETAIL_MISMATCH")
        checks.append("generated_capability_list_and_detail_decoding")

        let aiStart = await transport.count()
        let ai = await session.ask(PreviewFixture.aiTask)
        try require(ai.kind == .answer && ai.text == PreviewFixture.aiAnswer && ai.jobID == nil, "AI_ANSWER_MISMATCH")
        let aiCalls = Array(await transport.recorded().dropFirst(aiStart))
        try ResponseEvidence.aiSequence(aiCalls, terminalStatus: "completed")
        checks.append("actual_create_pending_poll_completed_answer")

        let failedStart = await transport.count()
        let failed = await session.ask(PreviewFixture.failedTask)
        try ResponseEvidence.aiSequence(Array(await transport.recorded().dropFirst(failedStart)), terminalStatus: "failed")
        try require(failed.kind == .failure && failed.jobID == nil
                    && failed.text == SessionResult.failure(AIError.jobFailed).text, "FAILED_JOB_FALSE_SUCCESS")
        let unavailableStart = await transport.count()
        let unavailable = await session.ask(PreviewFixture.unavailableTask)
        try ResponseEvidence.unavailable(Array(await transport.recorded().dropFirst(unavailableStart)))
        try require(unavailable.kind == .failure && !unavailable.text.contains("SYNTHETIC_IOS_PREVIEW_PRIVATE_ERROR_MARKER"), "HTTP_ERROR_NOT_REDACTED")
        try require(await transport.count() == unavailableStart + 1, "HTTP_ERROR_RETRIED")
        checks.append("failed_job_and_redacted_unavailable_error_no_retry")

        let approvalStart = await transport.count()
        let approval = try approvalID(await session.ask("Run tests"))
        let accepted = await session.approve(approval)
        let testJob = try jobID(accepted)
        try require(await session.approve(approval).kind == .failure, "APPROVAL_REPLAY_ACCEPTED")
        try await exactRetry(since: approvalStart)
        let completedTests = await session.checkJob(testJob)
        try require(completedTests.kind == .answer && completedTests.text == "The Local Agent reports that the tests passed.", "CAPABILITY_RESULT_MISMATCH")
        checks.append("explicit_synthetic_approval_exact_bytes_one_retry_and_completed_tests")

        let cancelledApproval = try approvalID(await session.ask("Run tests"))
        let cancelStart = await transport.count()
        try require(await session.cancel(cancelledApproval).kind == .cancelled, "APPROVAL_CANCEL_FAILED")
        let cancelledRetry = await session.approve(cancelledApproval)
        try require(cancelledRetry.kind == .failure, "CANCELLED_APPROVAL_RETRIED")
        try require(await transport.count() == cancelStart, "CANCELLED_APPROVAL_TRANSMITTED")
        checks.append("cancelled_approval_sends_no_retry")

        await transport.cancelAfterReceipt(path: PreviewFixture.createPath, status: 202)
        let cancelledAIStart = await transport.count()
        let cancelledAI = await Task { await session.ask(PreviewFixture.aiTask) }.value
        let cancelledAIJob = try jobID(cancelledAI)
        try require(await transport.count() == cancelledAIStart + 1, "CANCELLED_AI_AUTO_POLL_OR_RETRY")
        try require(await session.checkJob(cancelledAIJob).kind == .pending, "CANCELLED_AI_PENDING_HANDLE_LOST")
        let recovered = await session.checkJob(cancelledAIJob)
        try require(recovered.kind == .answer && recovered.text == PreviewFixture.aiAnswer, "CANCELLED_AI_RECOVERY_FAILED")
        checks.append("cancel_after_real_ai_receipt_retains_handle_without_auto_poll")

        let cancellationApprovalStart = await transport.count()
        let cancellationApproval = try approvalID(await session.ask("Run tests"))
        await transport.cancelAfterReceipt(path: PreviewFixture.runPath, status: 200)
        let cancelledCapability = await Task { await session.approve(cancellationApproval) }.value
        let cancelledCapabilityJob = try jobID(cancelledCapability)
        try require(await session.approve(cancellationApproval).kind == .failure, "CANCELLED_CAPABILITY_APPROVAL_REPLAY")
        try await exactRetry(since: cancellationApprovalStart)
        try require(await session.checkJob(cancelledCapabilityJob).kind == .answer, "CANCELLED_CAPABILITY_HANDLE_LOST")
        checks.append("cancel_after_real_approved_receipt_retains_handle_without_retry")

        let previewJob = try jobID(await session.previewPatch(PreviewFixture.patch))
        await transport.holdResultPair(jobID: previewJob)
        let previewReadStart = await transport.count()
        async let firstPreview = session.checkJob(previewJob)
        async let secondPreview = session.checkJob(previewJob)
        let pair = await (firstPreview, secondPreview)
        try ResponseEvidence.overlappingPatchResults(Array(await transport.recorded().dropFirst(previewReadStart)), jobID: previewJob)
        try require([pair.0.kind, pair.1.kind].filter { $0 == .answer }.count == 1
                    && [pair.0.kind, pair.1.kind].filter { $0 == .failure }.count == 1, "DUPLICATE_PREVIEW_RESULT_REARMED")
        let patchApproval = try approvalID(await session.ask("Apply that patch"))
        try require(await session.cancel(patchApproval).kind == .cancelled, "PATCH_APPROVAL_CANCEL_FAILED")
        let consumedPreviewCount = await transport.count()
        try require(await session.ask("Apply that patch").kind == .failure, "CONSUMED_PREVIEW_REARMED")
        try require(await transport.count() == consumedPreviewCount, "CONSUMED_PREVIEW_TRANSMITTED")
        checks.append("overlapping_real_patch_results_consumed_once_no_preview_rearm")

        let unauthenticated = try await raw(configuration.web, path: PreviewFixture.listPath, method: "GET")
        try require(unauthenticated.statusCode == 401, "UNAUTHENTICATED_FIXTURE_NOT_DENIED")
        let malformed = try await raw(configuration.web, path: PreviewFixture.createPath, method: "POST", body: Data("{".utf8), authenticated: true)
        try require(malformed.statusCode == 400, "MALFORMED_JSON_NOT_DENIED")
        let workerGateway = try GatewayClient(baseURL: configuration.worker, credentials: PreviewCredentials(permittedOrigin: configuration.worker), transport: transport)
        do {
            _ = try await workerGateway.createJob(CreateAIJobRequest(gptId: "arcanos-core", task: PreviewFixture.aiTask, maxOutputTokens: 1024, idempotencyKey: UUID().uuidString))
            throw ProofFailure("PASSIVE_WORKER_ACCEPTED_CREATE")
        } catch GatewayError.http(let status, _) { try require(status == 404, "PASSIVE_WORKER_DENIAL_STATUS") }
        checks.append("unauthenticated_malformed_and_passive_worker_denials")
        let workerDevicePolicy = try await raw(configuration.worker, path: PreviewFixture.devicePolicyPath, method: "GET")
        try require(workerDevicePolicy.statusCode == 404, "PASSIVE_WORKER_DEVICE_POLICY_NOT_DENIED")
        checks.append("passive_worker_device_policy_denied")

        try require(try await readiness(configuration.web, role: "web") == initialWeb, "WEB_IDENTITY_DRIFT")
        try require(try await readiness(configuration.worker, role: "worker") == initialWorker, "WORKER_IDENTITY_DRIFT")
        let finalDevicePolicy = try await raw(configuration.web, path: PreviewFixture.devicePolicyPath, method: "GET")
        try ResponseEvidence.devicePolicy(finalDevicePolicy, prNumber: configuration.prNumber, sourceCommit: configuration.commit)
        checks.append("final_served_device_policy_contract_unchanged")
        try configuration.verifyGit()
        checks.append("final_role_identities_unchanged")
        return await report(checks: checks)
    }

    private func report(checks: [String]) async -> ProofReport {
        ProofReport(executed: configuration.execute, networkAttempted: await transport.count() > 0,
                    prNumber: configuration.prNumber, sourceCommit: configuration.commit,
                    webBaseURL: configuration.web, workerBaseURL: configuration.worker,
                    requestsMade: await transport.count(), responseBytes: await transport.bytes(), checks: checks)
    }

    private func raw(_ origin: URL, path: String, method: String, body: Data? = nil, authenticated: Bool = false) async throws -> GatewayResponse {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL else { throw ProofFailure("FIXTURE_URL_INVALID") }
        var headers = ["Accept": "application/json"]
        if authenticated { headers["Authorization"] = "Bearer \(PreviewFixture.token)" }
        if body != nil { headers["Content-Type"] = "application/json" }
        return try await transport.send(GatewayRequest(url: url, method: method, headers: headers, body: body))
    }

    private func json(_ response: GatewayResponse) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: response.data) }

    private func readiness(_ origin: URL, role: String) async throws -> JSONValue {
        let response = try await raw(origin, path: "/readyz", method: "GET")
        try require(response.statusCode == 200, "READINESS_HTTP_STATUS")
        let value = try json(response)
        try require(value["ready"] == .bool(true) && value["prNumber"] == .integer(Int64(configuration.prNumber))
                    && value["sourceCommit"] == .string(configuration.commit) && value["processKind"] == .string(role), "READINESS_IDENTITY_MISMATCH")
        if role == "web" {
            try require(value["mode"] == .string("native-pr-application-e2e-v1") && value["applicationImported"] == .bool(true)
                        && value["fixturesSealed"] == .bool(true) && value["protectedEffectsEnabled"] == .bool(false), "WEB_NOT_SEALED")
        } else { try require(value["mode"] == .string("passive-pr-preview"), "WORKER_NOT_PASSIVE") }
        return value
    }

    private func approvalID(_ value: SessionResult) throws -> UUID {
        guard value.kind == .confirmationRequired, let id = value.approvalID, value.jobID == nil else { throw ProofFailure("EXPECTED_APPROVAL_MISSING") }
        return id
    }

    private func jobID(_ value: SessionResult) throws -> String {
        guard value.kind == .pending, let id = value.jobID, UUID(uuidString: id) != nil else { throw ProofFailure("ACCEPTED_JOB_HANDLE_MISSING") }
        return id
    }

    private func exactRetry(since count: Int) async throws {
        let exchanges = Array(await transport.recorded().dropFirst(count))
        try require(exchanges.count == 2, "APPROVAL_REQUEST_COUNT")
        let original = exchanges[0], retry = exchanges[1]
        try require(original.response.statusCode == 403 && retry.response.statusCode == 200, "APPROVAL_HTTP_SEQUENCE")
        try require(original.request.url == retry.request.url && original.request.method == retry.request.method
                    && original.request.headers == retry.request.headers, "APPROVAL_REQUEST_BINDING")
        guard let originalBody = original.request.body, let retryBody = retry.request.body,
              let token = try json(original.response)["confirmationChallenge"]?["id"]?.stringValue else { throw ProofFailure("APPROVAL_RESPONSE_INVALID") }
        var expected = Data(originalBody.dropLast())
        expected.append(Data(",\"confirmation_token\":".utf8))
        expected.append(try JSONEncoder().encode(token))
        expected.append(125)
        try require(retryBody == expected && original.request.headers["Idempotency-Key"] != nil, "APPROVAL_BYTES_CHANGED")
    }

    private var expectedMetadata: JSONValue {
        .object(["schemaVersion": .integer(1), "proofVersion": .string(PreviewFixture.version), "synthetic": .bool(true),
                 "prNumber": .integer(Int64(configuration.prNumber)), "sourceCommit": .string(configuration.commit),
                 "contractSource": .string("src/services/gptAccessGateway.ts#buildGptAccessOpenApiDocument"),
                 "protectedEffectsEnabled": .bool(false), "fixtures": .object([
                    "aiTask": .string(PreviewFixture.aiTask), "aiAnswer": .string(PreviewFixture.aiAnswer),
                    "failedTask": .string(PreviewFixture.failedTask), "unavailableTask": .string(PreviewFixture.unavailableTask),
                    "unavailableMessage": .string("SYNTHETIC_IOS_PREVIEW_PRIVATE_ERROR_MARKER"), "patch": .string(PreviewFixture.patch),
                    "patchSha256": .string(PreviewFixture.patchHash), "testProfile": .string("typescript-unit")])])
    }
}
