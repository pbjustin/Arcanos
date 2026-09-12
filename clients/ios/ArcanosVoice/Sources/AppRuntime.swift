import ArcanosKit
import Foundation
import Observation

/// All app/UI state is main-actor isolated. Transport, inference and confirmation
/// ownership remain in ArcanosKit actors; no prompt, credential or job ID is logged.
@MainActor
@Observable
final class AppRuntime {
    static let shared = AppRuntime()

    struct PendingApproval {
        let id: UUID
        let summary: String
    }

    private(set) var pendingApproval: PendingApproval?
    private(set) var localModelStatus = "Checking local intelligence…"
    private(set) var capturedNoteCount = 0
    private(set) var diagnosticMessage = "Ready for Ask Arcanos."
    private(set) var demonstration = false
    private(set) var deviceState: DeviceCredentialState = .unpaired
    private(set) var gatewayAddress = ""
    private(set) var changingPairing = false
    private(set) var secureStorageUnavailable = false
    private(set) var recoveredResults: [VoicePresentation] = []

    @ObservationIgnored private var session = ArcanosSession(router: AIRouter())
    @ObservationIgnored private let localContext = LocalContextStore()
    @ObservationIgnored private var demoLatestJobID: String?
    @ObservationIgnored private var shipping: ShippingSessionComposition?
    @ObservationIgnored private var hasActivated = false
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private let credentialStore = KeychainCredentialStore()
    @ObservationIgnored private var pairing: DevicePairingClient?

    private init() {
        do { shipping = try makeShippingComposition(nil) }
        catch { diagnosticMessage = "Recovery storage is currently unavailable. Local intelligence remains available." }
        restoreGateway()
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "arcanos.demo.enabled") {
            setDemonstration(true)
        }
        #endif
    }

    /// Called by the active scene task. Suspension cancels observation; critical
    /// submission writes have already happened inside the shared session adapter.
    func activate() async {
        guard !demonstration, let shipping else { return }
        let activeGeneration = generation
        let firstActivation = !hasActivated
        hasActivated = true
        let results = firstActivation ? await shipping.startup() : await shipping.foreground()
        guard activeGeneration == generation, !Task.isCancelled else { return }
        recoveredResults = results.map { VoicePresentation($0, demonstration: false) }
        await refreshDeviceState()
    }

    func refreshDiagnostics() async {
        switch await LocalAI().availability() {
        case .available:
            localModelStatus = "Foundation Models is available on this device."
        case .unavailable:
            localModelStatus = "Local model unavailable. Requires iOS 26, a supported Apple Intelligence device, and a ready model."
        }
        await refreshDeviceState()
    }

    func pair(address: String, pairingToken: String) async {
        guard !changingPairing else { return }
        changingPairing = true
        defer { changingPairing = false }
        do {
            guard let origin = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                throw GatewayError.invalidConfiguration
            }
            let broker = try DevicePairingClient(origin: origin, store: credentialStore)
            try await broker.pair(pairingToken: pairingToken.trimmingCharacters(in: .whitespacesAndNewlines))
            let canonical = await broker.origin
            UserDefaults.standard.set(canonical.absoluteString, forKey: "arcanos.gateway.origin")
            demonstration = false
            #if DEBUG
            UserDefaults.standard.set(false, forKey: "arcanos.demo.enabled")
            #endif
            try installGateway(canonical)
            diagnosticMessage = "Device pairing completed. Remote requests now use this device credential."
        } catch { diagnosticMessage = SessionResult.failure(error).text }
        await refreshDeviceState()
    }

    func renewCredential() async {
        guard !changingPairing, let pairing else { return }
        changingPairing = true
        defer { changingPairing = false }
        do {
            try await pairing.renew()
            diagnosticMessage = "The device credential was renewed and replaced in Keychain."
        } catch { diagnosticMessage = SessionResult.failure(error).text }
        await refreshDeviceState()
    }

    func inspectDeviceSession() async {
        guard !changingPairing, let pairing else { return }
        do {
            _ = try await pairing.inspect()
            diagnosticMessage = "The Gateway accepted this device session."
        } catch { diagnosticMessage = SessionResult.failure(error).text }
        await refreshDeviceState()
    }

    func revokeDevice() async {
        guard !changingPairing, let pairing else { return }
        changingPairing = true
        defer { changingPairing = false }
        do {
            try await pairing.revoke()
            pendingApproval = nil
            demoLatestJobID = nil
            recoveredResults = []
            generation = UUID()
            diagnosticMessage = "The Gateway revoked this device. Local intelligence remains available."
        } catch { diagnosticMessage = SessionResult.failure(error).text }
        await refreshDeviceState()
    }

    func forgetCredential() async {
        guard !changingPairing, !demonstration, !gatewayAddress.isEmpty,
              let origin = URL(string: gatewayAddress) else { return }
        changingPairing = true
        defer { changingPairing = false }
        do {
            try await credentialStore.removeCredential(for: origin)
            try installGateway(origin)
            diagnosticMessage = "Local credential removed. This does not confirm server revocation; use the trusted operator context if needed."
        } catch { diagnosticMessage = SessionResult.failure(error).text }
        await refreshDeviceState()
    }

    func ask(_ command: String) async -> VoicePresentation {
        let activeGeneration = generation
        let context = await localContext.capturedNote()
        let result: SessionResult
        if !demonstration, let shipping { result = await shipping.ask(command, localContext: context) }
        else { result = await session.ask(command, localContext: context) }
        await refreshDeviceState()
        return consume(result, generation: activeGeneration)
    }

    func approve(_ approvalID: UUID) async -> VoicePresentation {
        let activeGeneration = generation
        let result: SessionResult
        if !demonstration, let shipping { result = await shipping.approve(approvalID) }
        else { result = await session.approve(approvalID) }
        await refreshDeviceState()
        if pendingApproval?.id == approvalID { pendingApproval = nil }
        return consume(result, generation: activeGeneration)
    }

    func cancel(_ approvalID: UUID) async -> VoicePresentation {
        let activeGeneration = generation
        let result: SessionResult
        if !demonstration, let shipping { result = await shipping.cancel(approvalID) }
        else { result = await session.cancel(approvalID) }
        if pendingApproval?.id == approvalID { pendingApproval = nil }
        return consume(result, generation: activeGeneration)
    }

    func checkLatestJob(reference: String? = nil) async -> VoicePresentation {
        let operationID: UUID?
        if let reference, !reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let parsed = UUID(uuidString: reference.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                return VoicePresentation(text: "Provide the operation reference shown with the ARCANOS result.", status: "Operation reference needed")
            }
            operationID = parsed
        } else { operationID = nil }
        let activeGeneration = generation
        let result: SessionResult
        if !demonstration, let shipping { result = await shipping.checkLatest(operationID: operationID) }
        else if demonstration, let demoLatestJobID { result = await session.checkJob(demoLatestJobID) }
        else { result = .failure(OperationTrackingError.notFound) }
        await refreshDeviceState()
        return consume(result, generation: activeGeneration)
    }

    func capture(_ note: String) async -> VoicePresentation {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await localContext.capture(trimmed)
        } catch {
            return VoicePresentation(text: "Capture a nonempty note of up to 8 KB.", status: "Note not captured")
        }
        capturedNoteCount = trimmed.count
        diagnosticMessage = "A note is available in this app session."
        return VoicePresentation(text: "Captured in this app session. You can ask what you just captured or ask me to summarize the note.", status: "Local note captured")
    }

    func clearNote() async {
        await localContext.clear()
        capturedNoteCount = 0
        diagnosticMessage = "Local note cleared."
    }

    #if DEBUG
    func setDemonstration(_ enabled: Bool) {
        guard !changingPairing else { return }
        do {
            let replacement: ArcanosSession
            if enabled {
                replacement = try DemoGateway.makeSession()
            } else {
                if !gatewayAddress.isEmpty, let origin = URL(string: gatewayAddress) {
                    shipping = try makeShippingComposition(origin)
                    replacement = ArcanosSession(router: AIRouter())
                } else { replacement = ArcanosSession(router: AIRouter()) }
            }
            session = replacement
            demonstration = enabled
            generation = UUID()
            pendingApproval = nil
            demoLatestJobID = nil
            recoveredResults = []
            UserDefaults.standard.set(enabled, forKey: "arcanos.demo.enabled")
            diagnosticMessage = enabled ? "Simulation enabled. No network request or real capability action will run." : "Live device mode enabled. Remote operations require a valid paired session."
        } catch {
            // Never display a raw error, which might contain request metadata.
            diagnosticMessage = "The demonstration could not start."
        }
    }
    #endif

    private func restoreGateway() {
        guard let address = UserDefaults.standard.string(forKey: "arcanos.gateway.origin"),
              let origin = URL(string: address) else { return }
        do { try installGateway(origin) }
        catch { diagnosticMessage = "The saved Gateway origin is invalid. Pair again in the app." }
    }

    private func makeShippingComposition(_ origin: URL?) throws -> ShippingSessionComposition {
        // Intents are compiled in this application target and use its sandbox and
        // Keychain service. No extension or additional shared-container entitlement.
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw OperationTrackingError.storageUnavailable
        }
        let persistence = FileOperationPersistence(fileURL: support
            .appendingPathComponent("Arcanos", isDirectory: true).appendingPathComponent("operations.json"))
        return ShippingSessionComposition(origin: origin, credentials: credentialStore, persistence: persistence)
    }

    private func installGateway(_ origin: URL) throws {
        shipping = try makeShippingComposition(origin)
        pairing = try DevicePairingClient(origin: origin, store: credentialStore)
        gatewayAddress = origin.absoluteString
        generation = UUID()
        pendingApproval = nil
        demoLatestJobID = nil
        recoveredResults = []
    }

    private func refreshDeviceState() async {
        guard !gatewayAddress.isEmpty, let origin = URL(string: gatewayAddress) else { deviceState = .unpaired; return }
        do {
            deviceState = try await credentialStore.state(for: origin)
            secureStorageUnavailable = false
        } catch CredentialStoreError.lockedOrUnavailable {
            secureStorageUnavailable = true
            pendingApproval = nil
            recoveredResults = []
        } catch {
            secureStorageUnavailable = false
            deviceState = .authenticationFailure
        }
    }

    private func consume(_ result: SessionResult, generation activeGeneration: UUID) -> VoicePresentation {
        guard activeGeneration == generation else {
            return VoicePresentation(text: "The client mode changed while the request was running. This result is no longer active.", status: "Session changed")
        }
        let presentation = VoicePresentation(result, demonstration: demonstration)
        if let approvalID = result.approvalID {
            pendingApproval = PendingApproval(id: approvalID, summary: presentation.text)
        }
        if demonstration, let jobID = result.jobID { demoLatestJobID = jobID }
        diagnosticMessage = presentation.status
        return presentation
    }
}
