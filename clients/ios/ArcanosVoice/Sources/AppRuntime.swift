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

    @ObservationIgnored private var session = ArcanosSession(router: AIRouter())
    @ObservationIgnored private let localContext = LocalContextStore()
    @ObservationIgnored private var latestJobID: String?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private let credentialStore = KeychainCredentialStore()
    @ObservationIgnored private var pairing: DevicePairingClient?

    private init() {
        restoreGateway()
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "arcanos.demo.enabled") {
            setDemonstration(true)
        }
        #endif
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
            let canonical = broker.origin
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
            latestJobID = nil
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
        let result = await session.ask(command, localContext: context)
        await refreshDeviceState()
        return consume(result, generation: activeGeneration)
    }

    func approve(_ approvalID: UUID) async -> VoicePresentation {
        let activeGeneration = generation
        let result = await session.approve(approvalID)
        await refreshDeviceState()
        if pendingApproval?.id == approvalID { pendingApproval = nil }
        return consume(result, generation: activeGeneration)
    }

    func cancel(_ approvalID: UUID) async -> VoicePresentation {
        let activeGeneration = generation
        let result = await session.cancel(approvalID)
        if pendingApproval?.id == approvalID { pendingApproval = nil }
        return consume(result, generation: activeGeneration)
    }

    func checkLatestJob() async -> VoicePresentation {
        guard let latestJobID else {
            return VoicePresentation(text: "There is no tracked backend job in this app session. Job tracking is cleared when the app restarts.", status: "No tracked job")
        }
        let activeGeneration = generation
        let result = await session.checkJob(latestJobID)
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
                    replacement = try makeGatewaySession(origin)
                } else { replacement = ArcanosSession(router: AIRouter()) }
            }
            session = replacement
            demonstration = enabled
            generation = UUID()
            pendingApproval = nil
            latestJobID = nil
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

    private func makeGatewaySession(_ origin: URL) throws -> ArcanosSession {
        let gateway = try GatewayClient(baseURL: origin, credentials: credentialStore)
        let jobs = JobClient(gateway: gateway)
        return ArcanosSession(router: AIRouter(remote: RemoteAI(jobs: jobs)),
                              capabilities: CapabilityClient(gateway: gateway), jobs: jobs)
    }

    private func installGateway(_ origin: URL) throws {
        session = try makeGatewaySession(origin)
        pairing = try DevicePairingClient(origin: origin, store: credentialStore)
        gatewayAddress = origin.absoluteString
        generation = UUID()
        pendingApproval = nil
        latestJobID = nil
    }

    private func refreshDeviceState() async {
        guard !gatewayAddress.isEmpty, let origin = URL(string: gatewayAddress) else { deviceState = .unpaired; return }
        do { deviceState = try await credentialStore.state(for: origin) }
        catch { deviceState = .authenticationFailure }
    }

    private func consume(_ result: SessionResult, generation activeGeneration: UUID) -> VoicePresentation {
        guard activeGeneration == generation else {
            return VoicePresentation(text: "The client mode changed while the request was running. This result is no longer active.", status: "Session changed")
        }
        let presentation = VoicePresentation(result, demonstration: demonstration)
        if let approvalID = result.approvalID {
            pendingApproval = PendingApproval(id: approvalID, summary: presentation.text)
        }
        if let jobID = result.jobID { latestJobID = jobID }
        diagnosticMessage = presentation.status
        return presentation
    }
}
