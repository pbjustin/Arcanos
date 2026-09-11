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

    @ObservationIgnored private var session = ArcanosSession(router: AIRouter())
    @ObservationIgnored private let localContext = LocalContextStore()
    @ObservationIgnored private var latestJobID: String?
    @ObservationIgnored private var generation = UUID()

    private init() {
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
    }

    func ask(_ command: String) async -> VoicePresentation {
        let activeGeneration = generation
        let context = await localContext.capturedNote()
        let result = await session.ask(command, localContext: context)
        return consume(result, generation: activeGeneration)
    }

    func approve(_ approvalID: UUID) async -> VoicePresentation {
        let activeGeneration = generation
        let result = await session.approve(approvalID)
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
        do {
            let replacement: ArcanosSession
            if enabled {
                replacement = try DemoGateway.makeSession()
            } else {
                replacement = ArcanosSession(router: AIRouter())
            }
            session = replacement
            demonstration = enabled
            generation = UUID()
            pendingApproval = nil
            latestJobID = nil
            UserDefaults.standard.set(enabled, forKey: "arcanos.demo.enabled")
            diagnosticMessage = enabled ? "Simulation enabled. No network request or real capability action will run." : "Local mode enabled. Remote pairing is not available in Phase 1."
        } catch {
            // Never display a raw error, which might contain request metadata.
            diagnosticMessage = "The demonstration could not start."
        }
    }
    #endif

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
