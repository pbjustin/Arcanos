import Foundation
import ArcanosKit

/// Synthetic inputs only. This target has no networking implementation and is not a
/// dependency of the shipping library. Xcode includes it only in HardwareValidation.
public enum HardwareFixtureConfiguration {
    public static let origin = URL(string: "https://arcanos-hardware-fixture.invalid")!
    public static let deviceID = "33333333-cccc-4333-8333-333333333333"
    public static let credentialService = "org.arcanos.voice.hardware-validation.credentials.v1"
    public static let remoteCommand = "Run the hardware fixture operation"
    public static let syntheticPatch = "--- a/hardware-fixture.txt\n+++ b/hardware-fixture.txt\n@@ -1 +1 @@\n-fixture\n+synthetic fixture\n"
    public static let resultText = "Synthetic hardware fixture completed. No provider or Local Agent ran."
    public static let patchHash = String(repeating: "c", count: 64)

    /// Call only from an explicit fixture-credential initialization/replacement action.
    /// Merely constructing this value does not read or mutate secure storage.
    public static func credentialSession(now: Date = Date(), replacement: Bool = false,
                                         deviceID: String = deviceID) -> DeviceCredentialResponse {
        let format = ISO8601DateFormatter()
        return DeviceCredentialResponse(ok: true, deviceId: deviceID, credential: token(replacement: replacement),
            tokenType: "Bearer", audience: "gpt-access-device-v1", origin: origin.absoluteString,
            issuedAt: format.string(from: now.addingTimeInterval(-1)), expiresAt: format.string(from: now.addingTimeInterval(3_599)),
            renewalExpiresAt: format.string(from: now.addingTimeInterval(86_400)),
            scopes: ["jobs.create", "jobs.result", "capabilities.read", "capabilities.run"],
            capabilityActions: ["git.status", "tests.run", "patch.preview", "patch.apply"], gptIds: ["arcanos-core"])
    }

    fileprivate static func token(replacement: Bool) -> String {
        "agd1." + String(repeating: replacement ? "R" : "H", count: 43)
    }
}

public struct HardwareFixtureControls: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, CaseIterable, Sendable { case localOnly, fixtures }
    public enum Receipt: String, Codable, CaseIterable, Sendable { case accepted, lostAfterAcceptance }
    public enum Authentication: String, Codable, CaseIterable, Sendable { case accepted, expired, revoked, invalid, unavailable }
    public enum ApprovedRetry: String, Codable, CaseIterable, Sendable { case accepted, challengeAgain, unavailable }
    public var mode: Mode = .localOnly
    public var nextReceipt: Receipt = .accepted
    public var authentication: Authentication = .accepted
    public var approvedRetry: ApprovedRetry = .accepted
}

/// No URL, request body, prompt, credential, or confirmation challenge enters evidence.
public struct HardwareFixtureEvent: Codable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case startup, foreground, ask, checkLatest, checkJob, approve, cancel, captureNote
        case credentialInitialized, credentialReplaced, credentialDeleted, credentialProbe
        case intentAsk, intentCheck, intentApprove, intentCancel, intentCapture, hostInitialized
        case keychainUnavailable, keychainProbePassed, keychainProbeFailed
        case localInferenceStarted, localInferenceSucceeded, localInferenceFailed
        case controlsChanged, transportAttempt, rejected, challenge, accepted, lostReceipt, resultRead, completed
    }
    public let sequence: Int
    public let kind: Kind
    public let processName: String
    public let processID: Int32
    public let jobID: String?
}

public struct HardwareFixtureJob: Codable, Sendable {
    public let jobID: String
    public let idempotencyKey: String
    public let action: String
    public var completed: Bool
}

public struct HardwareFixtureSnapshot: Codable, Sendable {
    public let configuration: HardwareFixtureControls
    public let requestAttempts: Int
    public let submissionAttempts: Int
    public let resultAttempts: Int
    public let semanticExecutionCount: Int
    public let rejectedAttempts: Int
    public let jobs: [HardwareFixtureJob]
    public let events: [HardwareFixtureEvent]
}

/// A durable synthetic server ledger, not another client recovery engine. The actual
/// app/session/recovery/intent orchestration injects this at GatewayTransport only.
/// All requests, including unexpected URLs and local-only fallback attempts, stop here.
public actor HardwareFixtureTransport: GatewayTransport {
    private struct Ledger: Codable {
        var version = 1
        var configuration = HardwareFixtureControls()
        var requestAttempts = 0
        var submissionAttempts = 0
        var resultAttempts = 0
        var semanticExecutionCount = 0
        var rejectedAttempts = 0
        var eventSequence = 0
        var jobs: [HardwareFixtureJob] = []
        var events: [HardwareFixtureEvent] = []
    }
    private struct PendingChallenge {
        let id: String
        let originalBody: Data
        let action: String
    }
    private enum Outcome {
        case response(GatewayResponse)
        case failure(GatewayError)
    }
    private let persistence: FileOperationPersistence
    // Raw challenge and frozen payload exist only for this transport's lifetime.
    private var challenges: [String: PendingChallenge] = [:]

    public init(fileURL: URL) { persistence = FileOperationPersistence(fileURL: fileURL) }

    public func configure(mode: HardwareFixtureControls.Mode? = nil,
                          nextReceipt: HardwareFixtureControls.Receipt? = nil,
                          authentication: HardwareFixtureControls.Authentication? = nil,
                          approvedRetry: HardwareFixtureControls.ApprovedRetry? = nil) throws {
        try transaction { owner, ledger in
            if let mode { ledger.configuration.mode = mode }
            if let nextReceipt { ledger.configuration.nextReceipt = nextReceipt }
            if let authentication { ledger.configuration.authentication = authentication }
            if let approvedRetry { ledger.configuration.approvedRetry = approvedRetry }
            owner.append(.controlsChanged, to: &ledger)
        }
        // Control changes cannot preserve a partly approved operation.
        challenges.removeAll()
    }

    public func recordEvent(_ kind: HardwareFixtureEvent.Kind) throws {
        try transaction { owner, ledger in owner.append(kind, to: &ledger) }
    }

    public func snapshot() throws -> HardwareFixtureSnapshot {
        try transaction { _, value in
            HardwareFixtureSnapshot(configuration: value.configuration, requestAttempts: value.requestAttempts,
                submissionAttempts: value.submissionAttempts, resultAttempts: value.resultAttempts,
                semanticExecutionCount: value.semanticExecutionCount, rejectedAttempts: value.rejectedAttempts,
                jobs: value.jobs, events: value.events)
        }
    }

    /// A deliberate operator control. Reads never complete jobs and acceptance never
    /// implies execution. Repeating completion preserves the semantic execution count.
    public func completePendingJobs() throws {
        try transaction { owner, ledger in
            for index in ledger.jobs.indices where !ledger.jobs[index].completed {
                ledger.jobs[index].completed = true
                ledger.semanticExecutionCount += 1
                owner.append(.completed, jobID: ledger.jobs[index].jobID, to: &ledger)
            }
        }
    }

    public func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        try Task.checkCancellation()
        let outcome: Outcome = try transaction { owner, ledger in
            ledger.requestAttempts += 1
            owner.append(.transportAttempt, to: &ledger)
            let path = request.url.path
            if path == "/gpt-access/jobs/create" || path == "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run" {
                ledger.submissionAttempts += 1
            } else if path == "/gpt-access/jobs/result" { ledger.resultAttempts += 1 }
            guard ledger.configuration.mode == .fixtures, owner.validOrigin(request), request.method == "POST",
                  let body = request.body, body.count <= 16_384 else { return owner.reject(&ledger) }
            guard [false, true].contains(where: {
                request.headers["Authorization"] == "Bearer \(HardwareFixtureConfiguration.token(replacement: $0))"
            }) else { return owner.reject(&ledger, error: .authenticationFailure) }
            if let failure = try owner.authenticationFailure(ledger.configuration.authentication) { return .response(failure) }
            guard let value = try? JSONDecoder().decode(JSONValue.self, from: body), case .object(let object) = value else {
                return owner.reject(&ledger)
            }
            switch path {
            case "/gpt-access/jobs/create":
                guard Set(object.keys).isSubset(of: ["gptId", "task", "maxOutputTokens", "idempotencyKey"]),
                      value["gptId"] == .string("arcanos-core"),
                      value["task"]?.stringValue.map(RoutingPolicy.normalize) == RoutingPolicy.normalize(HardwareFixtureConfiguration.remoteCommand),
                      value["maxOutputTokens"] == .integer(1_024),
                      let key = value["idempotencyKey"]?.stringValue, UUID(uuidString: key) != nil else { return owner.reject(&ledger) }
                return try owner.accept(key: key, action: "ai", ledger: &ledger)
            case "/gpt-access/jobs/result":
                guard Set(object.keys) == ["jobId"], let id = value["jobId"]?.stringValue,
                      let job = ledger.jobs.first(where: { $0.jobID == id }) else { return owner.reject(&ledger) }
                owner.append(.resultRead, jobID: id, to: &ledger)
                return .response(try owner.wire(JobResultResponse(ok: true, jobId: id,
                    status: job.completed ? "completed" : "pending", jobStatus: job.completed ? "completed" : "pending",
                    lifecycleStatus: job.completed ? "completed" : "queued", poll: "", stream: "",
                    resultEndpoint: "/gpt-access/jobs/result", result: job.completed ? owner.result(for: job.action) : .null)))
            case "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run":
                return try owner.capability(request, body: body, value: value, object: object, ledger: &ledger)
            default: return owner.reject(&ledger)
            }
        }
        switch outcome {
        case .response(let response): return response
        case .failure(let error): throw error
        }
    }

    private func capability(_ request: GatewayRequest, body: Data, value: JSONValue,
                            object: [String: JSONValue], ledger: inout Ledger) throws -> Outcome {
        guard let key = request.headers["Idempotency-Key"], UUID(uuidString: key) != nil else { return reject(&ledger) }
        // Any subsequent attempt consumes the pending challenge, including malformed retries.
        let pendingChallenge = challenges.removeValue(forKey: key)
        guard let action = value["action"]?.stringValue,
              let payload = value["payload"], validPayload(action: action, payload: payload),
              Set(object.keys).isSubset(of: ["action", "payload", "confirmation_token"]) else { return reject(&ledger) }
        if ["tests.run", "patch.apply"].contains(action) {
            if value["confirmation_token"] == nil {
                // A repeated original request cannot create a replacement challenge.
                guard pendingChallenge == nil, !ledger.jobs.contains(where: { $0.idempotencyKey == key }) else { return reject(&ledger) }
                let challenge = PendingChallenge(id: "hardware-fixture-\(UUID().uuidString)", originalBody: body, action: action)
                challenges[key] = challenge
                append(.challenge, to: &ledger)
                return .response(try challengeResponse(challenge.id))
            }
            guard let challenge = pendingChallenge, challenge.action == action,
                  value["confirmation_token"] == .string(challenge.id) else { return reject(&ledger) }
            var expected = Data(challenge.originalBody.dropLast())
            expected.append(Data(",\"confirmation_token\":".utf8))
            expected.append(try JSONEncoder().encode(challenge.id))
            expected.append(125)
            guard body == expected else { return reject(&ledger) }
            switch ledger.configuration.approvedRetry {
            case .challengeAgain: return .response(try challengeResponse("hardware-fixture-second-challenge"))
            case .unavailable: return .failure(.unavailable)
            case .accepted: break
            }
        } else if value["confirmation_token"] != nil { return reject(&ledger) }
        return try accept(key: key, action: action, ledger: &ledger)
    }

    private func accept(key: String, action: String, ledger: inout Ledger) throws -> Outcome {
        let existing = ledger.jobs.first { $0.idempotencyKey == key }
        guard existing == nil || existing?.action == action, ledger.jobs.count < 200 || existing != nil else { return reject(&ledger) }
        let job = existing ?? HardwareFixtureJob(jobID: UUID().uuidString.lowercased(), idempotencyKey: key, action: action, completed: false)
        if existing == nil { ledger.jobs.append(job) }
        append(.accepted, jobID: job.jobID, to: &ledger)
        if ledger.configuration.nextReceipt == .lostAfterAcceptance {
            ledger.configuration.nextReceipt = .accepted
            append(.lostReceipt, jobID: job.jobID, to: &ledger)
            return .failure(.unavailable)
        }
        if action == "ai" {
            return .response(try wire(CreateAIJobResponse(ok: true, jobId: job.jobID, traceId: "hardware-fixture",
                status: job.completed ? "completed" : "queued", deduped: existing != nil, resultEndpoint: "/gpt-access/jobs/result"), status: 202))
        }
        return .response(try wire(CapabilityRunResponse(ok: true, result: .object([
            "ok": .bool(true), "accepted": .bool(true), "persisted": .bool(true),
            "jobId": .string(job.jobID), "status": .string(job.completed ? "completed" : "queued")
        ]))))
    }

    private func validOrigin(_ request: GatewayRequest) -> Bool {
        guard let parts = URLComponents(url: request.url, resolvingAgainstBaseURL: false) else { return false }
        return parts.scheme == "https" && parts.host == HardwareFixtureConfiguration.origin.host && parts.port == nil
            && parts.user == nil && parts.password == nil && parts.query == nil && parts.fragment == nil
            && request.headers["X-Arcanos-Device-Origin"] == HardwareFixtureConfiguration.origin.absoluteString
    }

    private func validPayload(action: String, payload: JSONValue) -> Bool {
        switch action {
        case "git.status": return payload == .object([:])
        case "tests.run": return payload == .object(["profile": .string("typescript-unit")])
        case "patch.preview": return payload == .object(["patch": .string(HardwareFixtureConfiguration.syntheticPatch)])
        case "patch.apply": return payload == .object(["patch": .string(HardwareFixtureConfiguration.syntheticPatch),
            "expectedPatchSha256": .string(HardwareFixtureConfiguration.patchHash)])
        default: return false
        }
    }

    private func result(for action: String) -> JSONValue {
        if action == "ai" { return .string(HardwareFixtureConfiguration.resultText) }
        let output: JSONValue
        switch action {
        case "git.status": output = .object(["gitAvailable": .bool(true), "clean": .bool(true)])
        case "tests.run": output = .object(["status": .string("passed")])
        case "patch.preview": output = .object(["applicable": .bool(true), "patchSha256": .string(HardwareFixtureConfiguration.patchHash)])
        case "patch.apply": output = .object(["applied": .bool(true)])
        default: return .null
        }
        return .object(["outcome": .string("succeeded"), "output": output])
    }

    private func authenticationFailure(_ value: HardwareFixtureControls.Authentication) throws -> GatewayResponse? {
        let code: String
        switch value {
        case .accepted: return nil
        case .expired: code = "DEVICE_CREDENTIAL_EXPIRED"
        case .revoked: code = "DEVICE_REVOKED"
        case .invalid: code = "DEVICE_AUTH_INVALID"
        case .unavailable: code = "DEVICE_AUTH_UNAVAILABLE"
        }
        return try wire(ErrorResponse(ok: false, error: ErrorResponseError(code: code, message: "Synthetic authentication fixture")),
            status: value == .unavailable ? 503 : 401)
    }

    private func challengeResponse(_ id: String) throws -> GatewayResponse {
        try wire(ConfirmationRequiredResponse(code: "CONFIRMATION_REQUIRED",
            endpoint: "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run", method: "POST", confirmationRequired: true,
            confirmationChallenge: ConfirmationChallenge(id: id)), status: 403)
    }

    private func reject(_ ledger: inout Ledger, error: GatewayError = .invalidRequest) -> Outcome {
        ledger.rejectedAttempts += 1
        append(.rejected, to: &ledger)
        return .failure(error)
    }

    private func append(_ kind: HardwareFixtureEvent.Kind, jobID: String? = nil, to ledger: inout Ledger) {
        ledger.eventSequence += 1
        ledger.events.append(HardwareFixtureEvent(sequence: ledger.eventSequence, kind: kind,
            processName: String(ProcessInfo.processInfo.processName.prefix(100)),
            processID: ProcessInfo.processInfo.processIdentifier, jobID: jobID))
        if ledger.events.count > 500 { ledger.events.removeFirst(ledger.events.count - 500) }
    }

    private func wire<T: Encodable>(_ body: T, status: Int = 200) throws -> GatewayResponse {
        GatewayResponse(statusCode: status, data: try JSONEncoder().encode(body))
    }

    private func transaction<T>(_ body: @Sendable (isolated HardwareFixtureTransport, inout Ledger) throws -> T) throws -> T {
        try locked {
            let bytes = try persistence.load()
            guard bytes == nil || bytes!.count <= 1_048_576 else { throw OperationTrackingError.corruptStore }
            var ledger: Ledger
            if let bytes {
                guard let decoded = try? JSONDecoder().decode(Ledger.self, from: bytes), decoded.version == 1,
                      decoded.jobs.count <= 200, decoded.events.count <= 500 else { throw OperationTrackingError.corruptStore }
                ledger = decoded
            } else { ledger = Ledger() }
            let result = try body(self, &ledger)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try persistence.replace(with: encoder.encode(ledger))
            return result
        }
    }

    private func locked<T>(_ body: () throws -> T) throws -> T {
        try persistence.withExclusiveAccess(isolation: self, body)
    }
}
