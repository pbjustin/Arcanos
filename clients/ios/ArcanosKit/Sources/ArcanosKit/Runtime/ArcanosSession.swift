import Foundation

/// Edge orchestration only. Repository operations are always existing Local Agent capabilities.
public actor ArcanosSession {
    private enum JobKind: Sendable { case ai, capability(String), patchPreview(String) }
    private let router: AIRouter
    private let capabilities: CapabilityClient?
    private let jobs: JobClient?
    private let confirmations: ConfirmationCoordinator?
    private let testProfile: String
    private var knownJobs: [String: JobKind] = [:]
    private var approvalActions: [UUID: JobKind] = [:]
    private var previewedPatch: (patch: String, hash: String)?

    public init(router: AIRouter, capabilities: CapabilityClient? = nil, jobs: JobClient? = nil,
                testProfile: String = "typescript-unit") {
        self.router = router
        self.capabilities = capabilities
        self.jobs = jobs
        self.confirmations = capabilities.map { ConfirmationCoordinator(capabilities: $0) }
        self.testProfile = testProfile
    }

    public func ask(_ command: String, localContext: String? = nil) async -> SessionResult {
        let normalized = RoutingPolicy.normalize(command)
        switch normalized {
        case "run tests", "run my tests":
            guard ["python-unit", "typescript-unit", "typescript-integration", "backend-cli-contract"].contains(testProfile) else {
                return .failure(GatewayError.invalidRequest)
            }
            return await invoke(action: "tests.run", payload: .object(["profile": .string(testProfile)]),
                                summary: "Approve tests.run using the \(testProfile) profile in your paired workspace?",
                                kind: .capability("tests.run"))
        case "check my repository", "check my repo", "git status":
            return await invoke(action: "git.status", payload: .object([:]), summary: "Approve git.status in your paired workspace?",
                                kind: .capability("git.status"))
        case "apply that patch", "apply the patch":
            guard let prepared = previewedPatch else {
                return SessionResult(text: "ARCANOS needs a successful backend patch preview in this session before applying a patch.", kind: .failure)
            }
            // Consume the preview before attempting execution; never automatically repeat an uncertain mutation.
            previewedPatch = nil
            return await invoke(action: "patch.apply", payload: .object([
                "patch": .string(prepared.patch), "expectedPatchSha256": .string(prepared.hash)
            ]), summary: "Approve patch.apply for the exact patch you previewed in your paired workspace?",
            kind: .capability("patch.apply"))
        default:
            do {
                // Context is attached only when the command explicitly refers to the captured note.
                // An unrelated repository question must not silently upload the note.
                let task = RoutingPolicy.localTask(for: AIRequest(command: command))
                let needsNote = task == .summarize || task == .transform || task == .recall
                let request = AIRequest(command: command, localContext: needsNote ? localContext : nil)
                let response = try await router.respond(to: request)
                if let id = response.jobID {
                    knownJobs[id] = .ai
                    return SessionResult(text: response.text, kind: .pending, jobID: id)
                }
                return SessionResult(text: response.text, kind: .answer)
            } catch { return .failure(error) }
        }
    }

    /// A controlled integration point for a future file/share action. No patch is invented locally.
    public func previewPatch(_ patch: String) async -> SessionResult {
        guard !patch.isEmpty, patch.utf8.count <= 200_000 else { return .failure(GatewayError.invalidRequest) }
        previewedPatch = nil
        return await invoke(action: "patch.preview", payload: .object(["patch": .string(patch)]),
                            summary: "Approve checking this patch in your paired workspace?", kind: .patchPreview(patch))
    }

    public func approve(_ approvalID: UUID) async -> SessionResult {
        guard let confirmations, let kind = approvalActions.removeValue(forKey: approvalID) else {
            return .failure(ConfirmationError.notPending)
        }
        do { return try accepted(try await confirmations.approve(approvalID), kind: kind) }
        catch { return .failure(error) }
    }

    public func cancel(_ approvalID: UUID) async -> SessionResult {
        approvalActions.removeValue(forKey: approvalID)
        guard let confirmations, await confirmations.cancel(approvalID) else { return .failure(ConfirmationError.notPending) }
        return SessionResult(text: "Approval cancelled. ARCANOS will not retry that action.", kind: .cancelled)
    }

    public func checkJob(_ jobID: String) async -> SessionResult {
        guard let jobs, let kind = knownJobs[jobID] else { return .failure(GatewayError.invalidRequest) }
        do {
            let result = try await jobs.result(jobID: jobID)
            guard result.jobId == jobID else { throw GatewayError.invalidResponse }
            if result.status == "pending" {
                return SessionResult(text: "The ARCANOS job is still pending. Completion has not been confirmed.", kind: .pending, jobID: jobID)
            }
            guard result.ok, result.status == "completed", result.error == nil else {
                knownJobs.removeValue(forKey: jobID)
                throw AIError.jobFailed
            }
            let text: String
            switch kind {
            case .ai:
                guard let answer = ResultProjection.aiText(result.result) else { throw GatewayError.invalidResponse }
                text = answer
            case .capability(let action):
                guard let output = ResultProjection.localAgentOutput(result.result) else { throw GatewayError.invalidResponse }
                text = try capabilityText(action, output: output)
            case .patchPreview(let patch):
                guard let output = ResultProjection.localAgentOutput(result.result),
                      output["applicable"]?.boolValue == true,
                      let hash = output["patchSha256"]?.stringValue,
                      hash.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil else {
                    throw GatewayError.invalidResponse
                }
                previewedPatch = (patch, hash)
                text = "The backend confirmed the patch preview is applicable. Say Apply that patch to request approval."
            }
            knownJobs.removeValue(forKey: jobID)
            return SessionResult(text: text, kind: .answer)
        } catch { return .failure(error) }
    }

    private func invoke(action: String, payload: JSONValue, summary: String, kind: JobKind) async -> SessionResult {
        guard let capabilities, let confirmations else { return .failure(GatewayError.unpaired) }
        do {
            let request = try capabilities.prepare(id: "ARCANOS:LOCAL_AGENT", action: action, payload: payload)
            switch try await confirmations.submit(request, summary: summary) {
            case .approval(let approval):
                approvalActions[approval.id] = kind
                return SessionResult(text: approval.summary, kind: .confirmationRequired, approvalID: approval.id)
            case .response(let response): return try accepted(response, kind: kind)
            }
        } catch { return .failure(error) }
    }

    private func accepted(_ response: CapabilityRunResponse, kind: JobKind) throws -> SessionResult {
        let result = response.result
        // The outer HTTP envelope can be successful even when Local Agent enqueueing failed.
        guard response.ok, result["ok"]?.boolValue == true,
              result["accepted"]?.boolValue == true, result["persisted"]?.boolValue == true,
              let jobID = result["jobId"]?.stringValue, UUID(uuidString: jobID) != nil else {
            throw GatewayError.invalidResponse
        }
        knownJobs[jobID] = kind
        return SessionResult(text: "The backend accepted the action as a durable job. It is pending; completion is not yet confirmed.",
                             kind: .pending, jobID: jobID)
    }

    private func capabilityText(_ action: String, output: JSONValue) throws -> String {
        switch action {
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
        case "git.status":
            guard output["gitAvailable"]?.boolValue == true, let clean = output["clean"]?.boolValue else {
                throw GatewayError.invalidResponse
            }
            return clean ? "The Local Agent reports a clean repository." : "The Local Agent reports uncommitted repository changes."
        default: throw GatewayError.invalidResponse
        }
    }
}
