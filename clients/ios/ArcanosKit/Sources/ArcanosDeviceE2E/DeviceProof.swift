import ArcanosKit
import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// Only this fixture uses in-memory item storage. Apple Keychain access is neither
/// replaced in the app nor represented as proven by a portable cross-process test.
final class FixtureCredentialItems: CredentialItemStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    func read(account: String) throws -> Data? { lock.withLock { items[account] } }
    func replace(account: String, data: Data) throws { lock.withLock { items[account] = data } }
    func remove(account: String) throws { lock.withLock { _ = items.removeValue(forKey: account) } }
}

struct FixtureLocalAI: ArcanosAI {
    func availability() async -> AIAvailability { .available }
    func respond(to request: AIRequest) async throws -> AIResponse {
        AIResponse(text: "Synthetic local fixture answer.", execution: .local)
    }
}

private struct OldFixtureCredential: GatewayCredentialProvider {
    let value: GatewayCredential
    func credential(for origin: URL) async throws -> GatewayCredential? { origin == value.origin ? value : nil }
}

private struct DeviceProofReport: Encodable {
    let version = "ios-device-e2e/v1"
    let ok: Bool
    let runId: String?
    let sourceSha: String?
    let transport = "urlsession-loopback-http-test-adapter"
    let credentialStorage = "in-memory-fixture"
    let liveProvider = false
    let physicalDevice = false
    let assertions: [String]
    let requestsMade: Int
    let responseBytes: Int
    let failure: String?
}

@main
enum ArcanosDeviceE2E {
    static func main() async {
        if CommandLine.arguments.dropFirst().contains("--shipping-recovery") {
            await ShippingDeviceProof.main()
            return
        }
        var configuration: DeviceProofConfiguration?
        var transport: LoopbackTransport?
        var assertions: [String] = []
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            try deviceRequire(arguments == ["--execute", "--allow-loopback"], "EXPLICIT_LOOPBACK_OPT_IN_REQUIRED")
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 16_385 - input.count), !chunk.isEmpty {
                input.append(chunk)
                try deviceRequire(input.count <= 16_384, "CONFIGURATION_TOO_LARGE")
            }
            let parsed = try DeviceProofConfiguration.read(input, arguments: arguments)
            configuration = parsed
            let actual = try LoopbackTransport(configuration: parsed)
            transport = actual
            try await run(parsed, transport: actual, assertions: &assertions)
            let counts = await actual.counts()
            emit(DeviceProofReport(ok: true, runId: parsed.runId, sourceSha: parsed.sourceSha,
                                   assertions: assertions, requestsMade: counts.requests,
                                   responseBytes: counts.bytes, failure: nil))
        } catch {
            let counts = await transport?.counts()
            // Never print arbitrary error descriptions: they can include URLs, tokens,
            // response bodies, user content, or internal backend diagnostics.
            let code = (error as? DeviceProofFailure)?.code ?? "DEVICE_E2E_OPERATION_FAILED"
            emit(DeviceProofReport(ok: false, runId: configuration?.runId, sourceSha: configuration?.sourceSha,
                                   assertions: assertions, requestsMade: counts?.requests ?? 0,
                                   responseBytes: counts?.bytes ?? 0, failure: code))
            exit(1)
        }
    }

    private static func emit(_ value: DeviceProofReport) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value) else { exit(1) }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    private static func terminal(_ initial: SessionResult, session: ArcanosSession, code: String) async throws -> SessionResult {
        var value = initial
        for _ in 0..<40 {
            if value.kind == .answer { return value }
            guard value.kind == .pending, let jobID = value.jobID else { throw DeviceProofFailure(code) }
            try await Task.sleep(for: .milliseconds(250))
            value = await session.checkJob(jobID)
        }
        throw DeviceProofFailure("JOB_OBSERVATION_BUDGET_EXHAUSTED")
    }

    private static func run(_ config: DeviceProofConfiguration, transport: LoopbackTransport,
                            assertions: inout [String]) async throws {
        let storeA = KeychainCredentialStore(storage: FixtureCredentialItems())
        let storeB = KeychainCredentialStore(storage: FixtureCredentialItems())
        let gatewayA = try GatewayClient(baseURL: config.origin, credentials: storeA, transport: transport)
        let gatewayB = try GatewayClient(baseURL: config.origin, credentials: storeB, transport: transport)
        let jobs = JobClient(gateway: gatewayA)
        let session = ArcanosSession(router: AIRouter(local: FixtureLocalAI(), remote: RemoteAI(jobs: jobs)),
                                     capabilities: CapabilityClient(gateway: gatewayA), jobs: jobs)

        let local = await session.ask("Hello")
        let afterLocal = await transport.counts()
        try deviceRequire(local.kind == .answer && local.text == "Synthetic local fixture answer."
                          && afterLocal.requests == 0, "UNPAIRED_LOCAL_FAILED")
        assertions.append("unpaired_local_without_network")
        let unpaired = await session.ask("Explain a deterministic cross-process fixture result")
        let afterUnpaired = await transport.counts()
        try deviceRequire(unpaired.kind == .failure && afterUnpaired.requests == 0,
                          "UNPAIRED_REMOTE_TRANSMITTED")
        assertions.append("unpaired_remote_blocked")

        let pairingA = try DevicePairingClient(origin: config.origin, store: storeA, transport: transport)
        let pairingB = try DevicePairingClient(origin: config.origin, store: storeB, transport: transport)
        try await pairingA.pair(pairingToken: config.pairingTokenA)
        try await pairingB.pair(pairingToken: config.pairingTokenB)
        let inspectedA = try await pairingA.inspect()
        let inspectedB = try await pairingB.inspect()
        let stateA = try await storeA.state(for: config.origin)
        let stateB = try await storeB.state(for: config.origin)
        try deviceRequire(inspectedA.deviceId != inspectedB.deviceId
                          && stateA == .paired && stateB == .paired, "PAIRING_INSPECTION_FAILED")
        assertions.append("distinct_devices_paired_and_inspected")

        let replayStore = KeychainCredentialStore(storage: FixtureCredentialItems())
        let replay = try DevicePairingClient(origin: config.origin, store: replayStore, transport: transport)
        do {
            try await replay.pair(pairingToken: config.pairingTokenA)
            throw DeviceProofFailure("PAIRING_REPLAY_ACCEPTED")
        } catch GatewayError.http(_, let code) where code == "PAIRING_USED" {}
        try deviceRequire(try await replayStore.state(for: config.origin) == .unpaired, "PAIRING_REPLAY_PERSISTED")
        assertions.append("one_use_pairing_replay_denied")

        let answer = try await terminal(await session.ask("Explain a deterministic cross-process fixture result"),
                                        session: session, code: "AI_JOB_RESULT_FAILED")
        try deviceRequire(answer.text.contains(config.expectedAIAnswer), "AI_ANSWER_MISMATCH")
        guard let jobID = await transport.observedAIJobID() else { throw DeviceProofFailure("AI_RECEIPT_NOT_OBSERVED") }
        let owned = try await gatewayA.jobResult(JobResultRequest(jobId: jobID))
        try deviceRequire(owned.status == "completed", "OWNED_JOB_NOT_COMPLETED")
        assertions.append("device_ai_job_completed_and_owned_result_read")
        let foreign = try await gatewayB.jobResult(JobResultRequest(jobId: jobID))
        try deviceRequire(foreign.status == "not_found" && foreign.result == .null
                          && foreign.createdAt == nil && foreign.completedAt == nil,
                          "FOREIGN_JOB_READ_ACCEPTED")
        assertions.append("other_device_job_read_denied")

        let pending = await session.ask("Run tests")
        guard pending.kind == .confirmationRequired, let declinedID = pending.approvalID else {
            throw DeviceProofFailure("EXPLICIT_CONFIRMATION_NOT_REQUIRED")
        }
        let beforeCancel = await transport.counts()
        let cancelled = await session.cancel(declinedID)
        let afterCancel = await transport.counts()
        try deviceRequire(cancelled.kind == .cancelled && afterCancel.requests == beforeCancel.requests,
                          "CANCELLED_APPROVAL_TRANSMITTED")
        assertions.append("declined_confirmation_sends_no_retry")
        let approval = await session.ask("Run tests")
        guard approval.kind == .confirmationRequired, let approvalID = approval.approvalID else {
            throw DeviceProofFailure("SECOND_CONFIRMATION_NOT_REQUIRED")
        }
        let accepted = await session.approve(approvalID)
        try deviceRequire(accepted.kind == .pending && accepted.jobID != nil, "APPROVED_CAPABILITY_NOT_ACCEPTED")
        let beforeReplay = await transport.counts()
        let duplicate = await session.approve(approvalID)
        let afterReplay = await transport.counts()
        try deviceRequire(duplicate.kind == .failure && afterReplay.requests == beforeReplay.requests,
                          "APPROVAL_REPLAY_TRANSMITTED")
        try deviceRequire(await transport.confirmedRetryIsExact(), "APPROVED_RETRY_CHANGED_REQUEST")
        assertions.append("explicit_approval_retries_once")
        let completed = try await terminal(accepted, session: session, code: "CAPABILITY_JOB_RESULT_FAILED")
        try deviceRequire(completed.text == "The Local Agent reports that the tests passed.", "CAPABILITY_RESULT_MISMATCH")
        assertions.append("approved_tests_job_completed")

        guard let previous = try await storeA.credential(for: config.origin) else { throw DeviceProofFailure("RENEWAL_CREDENTIAL_MISSING") }
        try await pairingA.renew()
        let renewed = try await pairingA.inspect()
        let replacement = try await storeA.credential(for: config.origin)
        try deviceRequire(renewed.deviceId == inspectedA.deviceId
                          && replacement?.token != previous.token,
                          "RENEWAL_DID_NOT_ROTATE")
        let old = try GatewayClient(baseURL: config.origin, credentials: OldFixtureCredential(value: previous), transport: transport)
        do {
            _ = try await old.listCapabilities()
            throw DeviceProofFailure("OLD_CREDENTIAL_STILL_ACCEPTED")
        } catch GatewayError.authenticationFailure {}
        try deviceRequire(try await storeA.state(for: config.origin) == .paired, "OLD_REJECTION_POISONED_NEW_SESSION")
        assertions.append("renewal_rotates_and_old_credential_is_denied")

        try await pairingA.revoke()
        try deviceRequire(try await storeA.state(for: config.origin) == .revoked, "REVOCATION_NOT_RECORDED")
        let beforeRevokedRead = await transport.counts()
        do {
            _ = try await gatewayA.jobResult(JobResultRequest(jobId: jobID))
            throw DeviceProofFailure("REVOKED_CLIENT_READ_ACCEPTED")
        } catch GatewayError.credentialRevoked {}
        try deviceRequire((await transport.counts()).requests == beforeRevokedRead.requests, "REVOKED_CLIENT_TRANSMITTED")
        assertions.append("revocation_blocks_subsequent_client_requests")
    }
}
