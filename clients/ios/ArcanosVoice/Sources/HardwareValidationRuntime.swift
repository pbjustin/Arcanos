#if ARCANOS_HARDWARE_VALIDATION
#if !DEBUG
#error("Hardware validation requires its explicit developer configuration")
#endif
import ArcanosKit
#if canImport(CryptoKit)
import CryptoKit
#endif
import Foundation
import Observation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Developer instrumentation for the real app composition. This file and the
/// fixture transport are excluded from both ordinary Debug and Release builds.
@MainActor
@Observable
final class HardwareValidationRuntime {
    static let keychainService = "org.arcanos.voice.hardware-validation.credentials.v1"
    static let note = "The garden meeting is Tuesday at 10 AM. Bring the blue notebook. Maya will bring seeds."
    static var runtimePlatform: String {
        #if targetEnvironment(simulator)
        return "iOS Simulator — system Keychain here is not physical-device evidence"
        #elseif os(iOS)
        return "Physical iOS runtime — record device model manually, without identifiers"
        #else
        return "Non-iOS runtime — physical-device evidence is not established"
        #endif
    }
    private(set) var evidence = "No observation recorded."
    private(set) var keychainFinding = "NOT RUN — initialize synthetic credentials explicitly."
    private(set) var localFinding = "NOT RUN — no real model invocation in this process."
    private(set) var controlFinding = "Local-only transport guard is the default."
    let transport: HardwareFixtureTransport
    @ObservationIgnored private let credentials: KeychainCredentialStore
    @ObservationIgnored private let persistence: FileOperationPersistence
    @ObservationIgnored private let keychainReceipt: FileOperationPersistence
    @ObservationIgnored private let observedLocal: HardwareObservedLocalAI
    @ObservationIgnored private let storage = AppleKeychainItemStorage(service: keychainService)

    init(credentials: KeychainCredentialStore) throws {
        // Do not allow an accidentally enabled flag to open the shipping sandbox.
        guard Bundle.main.bundleIdentifier == "org.arcanos.voice.hardware-validation",
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw GatewayError.invalidConfiguration
        }
        self.credentials = credentials
        let directory = support.appendingPathComponent("ArcanosHardwareValidation-v1", isDirectory: true)
        persistence = FileOperationPersistence(fileURL: directory.appendingPathComponent("operations.json"))
        keychainReceipt = FileOperationPersistence(fileURL: directory.appendingPathComponent("keychain-expectation.json"))
        transport = HardwareFixtureTransport(fileURL: directory.appendingPathComponent("fixture-ledger.json"))
        observedLocal = HardwareObservedLocalAI()
    }

    func makeComposition() -> ShippingSessionComposition {
        ShippingSessionComposition(origin: HardwareFixtureConfiguration.origin, credentials: credentials,
            persistence: persistence, local: observedLocal, transport: transport)
    }

    static var modelAvailability: String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available: return "Real Foundation Models: available."
            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible: return "Real Foundation Models: unavailable — device not eligible."
                case .appleIntelligenceNotEnabled: return "Real Foundation Models: unavailable — Apple Intelligence not enabled."
                case .modelNotReady: return "Real Foundation Models: unavailable — model not ready."
                @unknown default: return "Real Foundation Models: unavailable — unrecognized system reason."
                }
            @unknown default: return "Real Foundation Models: unrecognized availability state."
            }
        }
        #endif
        return "Real Foundation Models: unavailable — requires a Foundation Models SDK and iOS 26 runtime."
    }

    func record(_ event: HardwareFixtureEvent.Kind) async {
        do { try await transport.recordEvent(event) }
        catch { controlFinding = "FAIL — fixture evidence storage unavailable; no live fallback exists." }
    }

    /// This explicit operation never runs on startup, relaunch, or secure-storage failure.
    func initializeCredential() async {
        do {
            let origin = HardwareFixtureConfiguration.origin
            guard try await credentials.pairedDeviceID(for: origin) == nil else {
                keychainFinding = "NOT RUN — test credential already exists. Use Probe or explicit Replace."
                return
            }
            _ = try await credentials.localIdentity(for: origin)
            try await credentials.storePairedSession(HardwareFixtureConfiguration.credentialSession(), for: origin)
            try saveKeychainExpectation()
            await record(.credentialInitialized)
            await probeCredential()
        } catch { await keychainFailure(error) }
    }

    func replaceCredential() async {
        do {
            let origin = HardwareFixtureConfiguration.origin
            // Replacement is explicit, including renewal after a long reboot test.
            let identityBefore = try storage.read(account: "identity:\(origin.absoluteString)")
            guard identityBefore != nil, try await credentials.pairedDeviceID(for: origin) != nil else {
                keychainFinding = "NOT RUN — initialize the isolated credential first."
                return
            }
            let replacement = HardwareFixtureConfiguration.credentialSession(replacement: true)
            try await credentials.storePairedSession(replacement, for: origin)
            let fresh = KeychainCredentialStore(service: Self.keychainService)
            let context = try await fresh.authenticatedContext(for: origin)
            guard context?.credential.token == replacement.credential,
                  try storage.read(account: "identity:\(origin.absoluteString)") == identityBefore else {
                throw CredentialStoreError.invalidRecord
            }
            try saveKeychainExpectation()
            keychainFinding = "PASS — synthetic credential replaced and read through a fresh store; installation identity unchanged."
            await record(.credentialReplaced)
        } catch { await keychainFailure(error) }
        await refreshEvidence()
    }

    /// Read-only across launches/reboots. Never refreshes dates or recreates identity.
    func probeCredential() async {
        do {
            let origin = HardwareFixtureConfiguration.origin
            let fresh = KeychainCredentialStore(service: Self.keychainService)
            let identity = try storage.read(account: "identity:\(origin.absoluteString)")
            guard let identity, let text = String(data: identity, encoding: .utf8), UUID(uuidString: text) != nil,
                  try await fresh.pairedDeviceID(for: origin) == HardwareFixtureConfiguration.deviceID else {
                throw CredentialStoreError.invalidRecord
            }
            guard try keychainDigests() == keychainReceipt.withExclusiveAccess({ try keychainReceipt.load() }) else {
                throw CredentialStoreError.invalidRecord
            }
            let state = try await fresh.state(for: origin)
            if state == .paired || state == .renewalRequired {
                let context = try await fresh.authenticatedContext(for: origin)
                let allowed = [HardwareFixtureConfiguration.credentialSession().credential,
                               HardwareFixtureConfiguration.credentialSession(replacement: true).credential]
                guard let context, allowed.contains(context.credential.token) else { throw CredentialStoreError.invalidRecord }
            }
            keychainFinding = "PASS — isolated identity/session bytes match the saved initialization or replacement expectation through a fresh system store. Credential state: \(state.rawValue). Storage evidence only."
            await record(.credentialProbe)
        } catch { await keychainFailure(error) }
        await refreshEvidence()
    }

    func deleteTestCredential() async {
        do {
            let origin = HardwareFixtureConfiguration.origin
            try await credentials.removeCredential(for: origin)
            guard try await KeychainCredentialStore(service: Self.keychainService).pairedDeviceID(for: origin) == nil else {
                throw CredentialStoreError.invalidRecord
            }
            keychainFinding = "PASS — isolated test credential deleted. Installation identity and recovery evidence retained; no server revocation claimed."
            await record(.credentialDeleted)
        } catch { await keychainFailure(error) }
        await refreshEvidence()
    }

    func probePartitions() async {
        do {
            let origin = HardwareFixtureConfiguration.origin
            let before = try keychainDigests()
            let canonicalAlias = URL(string: "https://ARCANOS-HARDWARE-FIXTURE.invalid:443/")!
            let otherOrigin = URL(string: "https://other-arcanos-hardware-fixture.invalid")!
            let fresh = KeychainCredentialStore(service: Self.keychainService)
            guard try await fresh.pairedDeviceID(for: canonicalAlias) == HardwareFixtureConfiguration.deviceID,
                  try await fresh.pairedDeviceID(for: otherOrigin) == nil,
                  try storage.read(account: "session:\(otherOrigin.absoluteString)") == nil,
                  try storage.read(account: "phase3c-unused-account") == nil else {
                throw CredentialStoreError.invalidRecord
            }
            let tracker = OperationTracker(persistence: persistence)
            let foreign = try OperationPartition(origin: origin, deviceID: "44444444-dddd-4444-8444-444444444444")
            guard try await tracker.operations(for: foreign).isEmpty, try keychainDigests() == before else {
                throw CredentialStoreError.invalidRecord
            }
            keychainFinding = "PASS — canonical origin reads the same synthetic device; foreign origin and account are absent; recovery query for a foreign synthetic device is empty. Primary Keychain bytes unchanged. Server account authorization NOT RUN."
            await record(.credentialProbe)
        } catch { await keychainFailure(error) }
        await refreshEvidence()
    }

    private func keychainFailure(_ error: any Error) async {
        switch error {
        case CredentialStoreError.lockedOrUnavailable:
            keychainFinding = "BLOCKED — system Keychain temporarily unavailable. No credential/identity repair or deletion attempted."
            await record(.keychainUnavailable)
        case CredentialStoreError.unsupportedPlatform:
            keychainFinding = "BLOCKED — system Keychain API unavailable on this platform."
        default:
            keychainFinding = "FAIL — isolated test credential missing or did not match expected synthetic state."
        }
    }

    private func keychainDigests() throws -> Data {
        #if canImport(CryptoKit)
        let origin = HardwareFixtureConfiguration.origin.absoluteString
        guard let identity = try storage.read(account: "identity:\(origin)"),
              let session = try storage.read(account: "session:\(origin)") else { throw CredentialStoreError.invalidRecord }
        // Persist only digests of these known synthetic test items; never the bytes.
        return try JSONEncoder().encode([Array(SHA256.hash(data: identity)), Array(SHA256.hash(data: session))])
        #else
        throw CredentialStoreError.unsupportedPlatform
        #endif
    }

    private func saveKeychainExpectation() throws {
        let bytes = try keychainDigests()
        try keychainReceipt.withExclusiveAccess { try keychainReceipt.replace(with: bytes) }
    }

    func setLocalOnly(_ localOnly: Bool) async {
        do {
            try await transport.configure(mode: localOnly ? .localOnly : .fixtures)
            controlFinding = localOnly ? "Local-only: every attempted Gateway request is rejected and counted."
                : "Fixture Gateway enabled. No sockets, TLS connection, provider, or executor."
        } catch { controlFinding = "FAIL — could not change fixture mode." }
        await refreshEvidence()
    }

    func loseNextReceipt() async {
        do { try await transport.configure(nextReceipt: .lostAfterAcceptance) }
        catch { controlFinding = "FAIL — could not arm lost receipt." }
        await refreshEvidence()
    }

    func completeJobs() async {
        do { try await transport.completePendingJobs() }
        catch { controlFinding = "FAIL — could not complete synthetic jobs." }
        await refreshEvidence()
    }

    func setAuthentication(_ value: HardwareFixtureControls.Authentication) async {
        do { try await transport.configure(authentication: value) }
        catch { controlFinding = "FAIL — could not change synthetic authentication response." }
        await refreshEvidence()
    }

    func setApprovedRetry(_ value: HardwareFixtureControls.ApprovedRetry) async {
        do { try await transport.configure(approvedRetry: value) }
        catch { controlFinding = "FAIL — could not change synthetic approval response." }
        await refreshEvidence()
    }

    func refreshEvidence() async {
        localFinding = await observedLocal.finding()
        do {
            let snapshot = try await transport.snapshot()
            controlFinding = snapshot.configuration.mode == .localOnly
                ? "Local-only: every attempted Gateway request is rejected and counted."
                : "Fixture Gateway enabled. No sockets, TLS connection, provider, or executor."
            let encoded = try JSONEncoder().encode(snapshot)
            let fixture = try JSONSerialization.jsonObject(with: encoded)
            let records: [TrackedOperation] = try persistence.withExclusiveAccess {
                guard let bytes = try persistence.load() else { return [] }
                return try JSONDecoder().decode([TrackedOperation].self, from: bytes)
            }
            let operations: [[String: String]] = records.map {
                ["operationID": $0.id.uuidString, "jobID": $0.backendJobID ?? "none",
                 "idempotencyKey": $0.idempotencyKey, "state": $0.localState.rawValue,
                 "backendStatus": $0.backendStatus ?? "none"]
            }
            let report: [String: Any] = [
                "schema": "arcanos-phase3c-app-observation/v1", "configuration": "HardwareValidation",
                "revision": Bundle.main.object(forInfoDictionaryKey: "ArcanosValidationRevision") as? String ?? "UNRECORDED",
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
                "runtimePlatform": Self.runtimePlatform,
                "processID": ProcessInfo.processInfo.processIdentifier,
                "fixture": fixture, "operations": operations, "systemKeychain": keychainFinding,
                "realLocalProvider": localFinding, "modelAvailability": Self.modelAvailability,
                "scope": "Application observations only. HTTP requests: zero by construction. Lifecycle events require operator corroboration. Live services NOT RUN."
            ]
            evidence = String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)
        } catch { evidence = "FAIL — evidence is unavailable. Do not infer success from a previous snapshot." }
    }
}

/// Observes the existing provider; never substitutes generation or availability.
private actor HardwareObservedLocalAI: ArcanosAI {
    private let provider = LocalAI()
    private var attempts = 0
    private var successes = 0
    private var failure = "none"
    func availability() async -> AIAvailability { await provider.availability() }
    func respond(to request: AIRequest) async throws -> AIResponse {
        attempts += 1
        do {
            let response = try await provider.respond(to: request)
            guard response.execution == .local else { throw AIError.localGenerationFailed }
            successes += 1
            failure = "none"
            return response
        } catch {
            switch error {
            case is CancellationError: failure = "cancelled"
            case AIError.localUnavailable: failure = "localUnavailable"
            case AIError.unsupportedLocalRequest: failure = "unsupportedLocalRequest"
            default: failure = "localGenerationFailed"
            }
            throw error
        }
    }
    func finding() -> String {
        "Real LocalAI since process start: attempts=\(attempts), successes=\(successes), lastError=\(failure). No generated text logged."
    }
}
#endif
