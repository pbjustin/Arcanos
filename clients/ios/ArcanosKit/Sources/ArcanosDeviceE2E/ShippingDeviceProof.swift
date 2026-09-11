import ArcanosKit
import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// Credentials cross stdin into memory again after every process exit. Only the
/// shipping non-secret operation index crosses the filesystem boundary.
struct ShippingDeviceConfiguration: Decodable, Sendable {
    let fixture: DeviceProofConfiguration
    let phase: String
    let session: DeviceCredentialResponse
    let stateDirectory: URL

    static let phases = ["ai-submit", "ai-restore", "capability-submit", "capability-restore", "foreign-restore", "revoked-restore"]

    static func read(_ data: Data, arguments: [String]) throws -> Self {
        try deviceRequire(arguments == ["--execute", "--allow-loopback", "--shipping-recovery"], "EXPLICIT_LOOPBACK_OPT_IN_REQUIRED")
        try deviceRequire(data.count <= 16_384, "CONFIGURATION_TOO_LARGE")
        guard let config = try? JSONDecoder().decode(Self.self, from: data) else { throw DeviceProofFailure("CONFIGURATION_INVALID") }
        try config.fixture.validate()
        try deviceRequire(phases.contains(config.phase), "SHIPPING_PHASE_INVALID")
        let directory = config.stateDirectory
        try deviceRequire(directory.isFileURL && directory.host == nil && directory.query == nil && directory.fragment == nil
            && directory.path == directory.standardizedFileURL.path
            && directory.lastPathComponent == "arcanos-ios-shipping-" + config.fixture.runId.lowercased(), "STATE_DIRECTORY_INVALID")
        try deviceRequire(FileManager.default.fileExists(atPath: directory.path), "STATE_DIRECTORY_MISSING")
        return config
    }
}

private struct ShippingDeviceReport: Encodable {
    let version = "ios-shipping-device-e2e/v1"
    let ok: Bool
    let runId: String?
    let sourceSha: String?
    let phase: String?
    let transport = "urlsession-loopback-http-test-adapter"
    let credentialStorage = "in-memory-fixture"
    let liveProvider = false
    let physicalDevice = false
    let creates: Int
    let capabilities: Int
    let results: Int
    let requestsMade: Int
    let responseBytes: Int
    let failure: String?
}

enum ShippingDeviceProof {
    static func main() async {
        var configuration: ShippingDeviceConfiguration?
        var transport: LoopbackTransport?
        do {
            var input = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 16_385 - input.count), !chunk.isEmpty {
                input.append(chunk)
                try deviceRequire(input.count <= 16_384, "CONFIGURATION_TOO_LARGE")
            }
            let config = try ShippingDeviceConfiguration.read(input, arguments: Array(CommandLine.arguments.dropFirst()))
            configuration = config
            let actual = try LoopbackTransport(configuration: config.fixture)
            transport = actual
            try await run(config, transport: actual)
            await emit(ok: true, config: config, transport: actual, failure: nil)
        } catch {
            await emit(ok: false, config: configuration, transport: transport,
                failure: (error as? DeviceProofFailure)?.code ?? "SHIPPING_DEVICE_E2E_FAILED")
            exit(1)
        }
    }

    private static func emit(ok: Bool, config: ShippingDeviceConfiguration?, transport: LoopbackTransport?, failure: String?) async {
        let counts = await transport?.counts()
        let shipping = await transport?.shippingCounts()
        let report = ShippingDeviceReport(ok: ok, runId: config?.fixture.runId, sourceSha: config?.fixture.sourceSha,
            phase: config?.phase, creates: shipping?.creates ?? 0, capabilities: shipping?.capabilities ?? 0,
            results: shipping?.results ?? 0, requestsMade: counts?.requests ?? 0, responseBytes: counts?.bytes ?? 0, failure: failure)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(report) else { exit(1) }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    private static func run(_ config: ShippingDeviceConfiguration, transport: LoopbackTransport) async throws {
        let store = KeychainCredentialStore(storage: FixtureCredentialItems())
        try await store.storePairedSession(config.session, for: config.fixture.origin)
        let isCapability = config.phase.hasPrefix("capability")
        let persistence = FileOperationPersistence(fileURL: config.stateDirectory.appendingPathComponent(isCapability ? "capability.json" : "ai.json"))
        let shipping = ShippingSessionComposition(origin: config.fixture.origin, credentials: store,
            persistence: persistence, local: FixtureLocalAI(), transport: transport)
        let partition = try OperationPartition(origin: config.fixture.origin, deviceID: config.session.deviceId)
        let tracker = OperationTracker(persistence: persistence)
        switch config.phase {
        case "ai-submit":
            try deviceRequire(try persistence.load() == nil, "STATE_ALREADY_EXISTS")
            let result = await shipping.ask("Explain a deterministic cross-process fixture result")
            let records = try await tracker.operations(for: partition)
            try deviceRequire(result.kind == .pending && result.jobID != nil && result.operationID != nil
                && records.count == 1 && records[0].backendJobID == result.jobID && records[0].localState == .accepted,
                "SHIPPING_AI_RECEIPT_NOT_DURABLE")
            let counts = await transport.shippingCounts()
            try deviceRequire(counts.creates == 1 && counts.capabilities == 0 && counts.results == 0, "SUBMISSION_DID_MORE_THAN_ACCEPT")
        case "capability-submit":
            try deviceRequire(try persistence.load() == nil, "STATE_ALREADY_EXISTS")
            let declined = await shipping.ask("Run tests")
            guard declined.kind == .confirmationRequired, let declinedID = declined.approvalID else { throw DeviceProofFailure("CONFIRMATION_NOT_REQUIRED") }
            let beforeCancel = await transport.counts()
            let cancelled = await shipping.cancel(declinedID)
            let afterCancel = await transport.counts()
            try deviceRequire(cancelled.kind == .cancelled && afterCancel.requests == beforeCancel.requests, "CANCELLATION_TRANSMITTED")
            let approval = await shipping.ask("Run tests")
            guard approval.kind == .confirmationRequired, let approvalID = approval.approvalID else { throw DeviceProofFailure("SECOND_CONFIRMATION_NOT_REQUIRED") }
            let result = await shipping.approve(approvalID)
            let beforeReplay = await transport.counts()
            let duplicate = await shipping.approve(approvalID)
            let afterReplay = await transport.counts()
            try deviceRequire(duplicate.kind == .failure && afterReplay.requests == beforeReplay.requests, "APPROVAL_REPLAY_TRANSMITTED")
            let records = try await tracker.operations(for: partition)
            let accepted = records.filter { $0.localState == .accepted }
            try deviceRequire(result.kind == .pending && result.jobID != nil && records.count == 2
                && records.filter { $0.localState == .dismissed }.count == 1
                && accepted.count == 1 && accepted[0].backendJobID == result.jobID, "SHIPPING_CAPABILITY_RECEIPT_NOT_DURABLE")
            try deviceRequire(await transport.confirmedRetryIsExact(), "APPROVED_RETRY_CHANGED_REQUEST")
            let counts = await transport.shippingCounts()
            try deviceRequire(counts.creates == 0 && counts.capabilities == 3 && counts.results == 0, "CAPABILITY_SUBMISSION_COUNT_INVALID")
        case "ai-restore", "capability-restore":
            let before = try await tracker.operations(for: partition)
            let accepted = before.filter { $0.localState == .accepted }
            try deviceRequire(accepted.count == 1, "ACCEPTED_RECEIPT_NOT_REOPENED")
            let restored = await shipping.startup()
            let expected = isCapability ? "The Local Agent reports that the tests passed." : config.fixture.expectedAIAnswer
            try deviceRequire(restored.count == 1 && restored[0].kind == .answer && restored[0].text == expected
                && restored[0].jobID == accepted[0].backendJobID && restored[0].operationID == accepted[0].id
                && restored[0].partition == partition, "STARTUP_DID_NOT_RECOVER_AUTHORITATIVE_RESULT")
            let latest = await shipping.ask("Check Latest Arcanos Job")
            try deviceRequire(latest.kind == .answer && latest.text == expected
                && latest.jobID == accepted[0].backendJobID && latest.operationID == accepted[0].id
                && latest.partition == partition, "INTENT_DID_NOT_RECOVER_AUTHORITATIVE_RESULT")
            let counts = await transport.shippingCounts()
            try deviceRequire(counts.creates == 0 && counts.capabilities == 0 && counts.results == 2, "RESTORATION_REPLAYED_WORK")
        case "foreign-restore":
            try deviceRequire(try persistence.load() != nil, "RECOVERY_INDEX_MISSING")
            try deviceRequire(await shipping.startup().isEmpty, "FOREIGN_PARTITION_RESTORED")
            let latest = await shipping.checkLatest()
            let counts = await transport.counts()
            try deviceRequire(latest.kind != .answer && counts.requests == 0, "FOREIGN_PARTITION_TRANSMITTED")
        case "revoked-restore":
            let before = try persistence.load()
            let result = await shipping.checkLatest()
            let counts = await transport.shippingCounts()
            try deviceRequire(result.kind == .unavailable && counts.results == 1 && counts.creates == 0 && counts.capabilities == 0,
                "REVOKED_DEVICE_RECOVERED_RESULT")
            try deviceRequire(try persistence.load() == before, "REJECTED_READ_CHANGED_RECOVERY_INDEX")
        default: throw DeviceProofFailure("SHIPPING_PHASE_INVALID")
        }
        if let data = try persistence.load(), let text = String(data: data, encoding: .utf8) {
            try deviceRequire(!text.contains(config.session.credential) && !text.contains(config.fixture.pairingTokenA)
                && !text.contains(config.fixture.pairingTokenB) && !text.contains(config.fixture.expectedAIAnswer)
                && !text.contains("Explain a deterministic") && !text.contains("confirmation_token"), "SECRET_OR_CONTENT_PERSISTED")
        }
    }
}
