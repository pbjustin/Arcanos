import AppIntents
import Foundation

struct AskArcanos: AppIntent {
    static let title: LocalizedStringResource = "Ask Arcanos"
    static let description = IntentDescription("Ask ARCANOS using local intelligence or the ARCANOS Gateway.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Command", requestValueDialog: "What do you need?")
    var command: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Ask ARCANOS \(.$command)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let request: String
        if let command, !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request = command
        } else {
            request = try await $command.requestValue("What do you need?")
        }

        let runtime = AppRuntime.shared
        var presentation = await runtime.ask(request)
        if let approvalID = presentation.approvalID {
            // Freeze the opaque approval ID before suspension. Approval never reparses
            // the utterance or reconstructs its payload; ArcanosKit holds the request.
            do {
                try await requestConfirmation(
                    dialog: IntentDialog("\(presentation.text) Do you approve this exact request?")
                )
            } catch {
                _ = await runtime.cancel(approvalID)
                throw error
            }
            presentation = await runtime.approve(approvalID)
        }
        return .result(
            dialog: IntentDialog("\(presentation.text)"),
            view: VoiceSnippet(presentation: presentation)
        )
    }
}

struct ApproveArcanos: AppIntent {
    static let title: LocalizedStringResource = "Approve Pending Arcanos Request"
    static let description = IntentDescription("Review and explicitly approve the exact request waiting in this app session.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let runtime = AppRuntime.shared
        guard let pending = runtime.pendingApproval else {
            let presentation = VoicePresentation(text: "There is no pending approval in this app session. Ask ARCANOS again if the app restarted.", status: "No pending approval")
            return .result(dialog: IntentDialog("\(presentation.text)"), view: VoiceSnippet(presentation: presentation))
        }
        do {
            try await requestConfirmation(
                dialog: IntentDialog("\(pending.summary) Do you approve this exact request?")
            )
        } catch {
            _ = await runtime.cancel(pending.id)
            throw error
        }
        let presentation = await runtime.approve(pending.id)
        return .result(dialog: IntentDialog("\(presentation.text)"), view: VoiceSnippet(presentation: presentation))
    }
}

struct CancelArcanos: AppIntent {
    static let title: LocalizedStringResource = "Cancel Pending Arcanos Request"
    static let description = IntentDescription("Discard a pending approval. This does not cancel a job already accepted by the backend.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let runtime = AppRuntime.shared
        let presentation: VoicePresentation
        if let pending = runtime.pendingApproval {
            presentation = await runtime.cancel(pending.id)
        } else {
            presentation = VoicePresentation(text: "There is no pending approval to cancel. An already submitted backend job has not been cancelled.", status: "No pending approval")
        }
        return .result(dialog: IntentDialog("\(presentation.text)"), view: VoiceSnippet(presentation: presentation))
    }
}

struct CheckArcanosJob: AppIntent {
    static let title: LocalizedStringResource = "Check Latest Arcanos Job"
    static let description = IntentDescription("Read the latest backend job result in this app session without resubmitting it.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let presentation = await AppRuntime.shared.checkLatestJob()
        return .result(dialog: IntentDialog("\(presentation.text)"), view: VoiceSnippet(presentation: presentation))
    }
}

struct CaptureArcanosNote: AppIntent {
    static let title: LocalizedStringResource = "Capture Arcanos Note"
    static let description = IntentDescription("Keep a note in this app session for local recall or summarization. It is cleared when the app process ends.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Note", requestValueDialog: "What would you like to capture?")
    var note: String

    static var parameterSummary: some ParameterSummary {
        Summary("Capture \(.$note) with ARCANOS")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let presentation = await AppRuntime.shared.capture(note)
        return .result(dialog: IntentDialog("\(presentation.text)"), view: VoiceSnippet(presentation: presentation))
    }
}
