#if ARCANOS_HARDWARE_VALIDATION
import ArcanosKit
import SwiftUI

/// A developer test panel inside the shipping app, not another session or router.
struct HardwareValidationView: View {
    let validation: HardwareValidationRuntime
    @State private var result: VoicePresentation?
    @State private var operationReference = ""

    var body: some View {
        Section("Hardware validation · Fixture Gateway") {
            Text(HardwareValidationRuntime.runtimePlatform).font(.caption)
            Text("Live Gateway access is disabled in this build. System Keychain and LocalAI are real. Gateway, provider, and executor responses are synthetic. No pairing is performed.")
            Text(validation.controlFinding)
            Button("Initialize synthetic Keychain credential") { Task { await validation.initializeCredential() } }
            Button("Probe existing Keychain credential") { Task { await validation.probeCredential() } }
            Button("Probe synthetic origin and account partitions") { Task { await validation.probePartitions() } }
            Button("Replace synthetic Keychain credential") { Task { await validation.replaceCredential() } }
            Button("Delete synthetic Keychain credential", role: .destructive) { Task { await validation.deleteTestCredential() } }
            Text(validation.keychainFinding).font(.caption)
            Text("Accessibility remains WhenUnlockedThisDeviceOnly. Probe after relaunch or reboot before replacement. A blocked probe never repairs credentials.")
                .font(.caption)
        }
        Section("Real local model") {
            Button("Enable local-only transport guard") { Task { await validation.setLocalOnly(true) } }
            Text(HardwareValidationRuntime.note)
            Button("Summarize known note using real LocalAI") {
                Task {
                    await validation.setLocalOnly(true)
                    _ = await AppRuntime.shared.capture(HardwareValidationRuntime.note)
                    result = await AppRuntime.shared.ask("Summarize this note")
                    await validation.refreshEvidence()
                }
            }
            Text(validation.localFinding).font(.caption)
            Text("For no-fallback evidence, compare requestAttempts before and after. It must be unchanged, and real LocalAI successes must increase. A blocked fallback is not successful local inference.")
                .font(.caption)
        }
        Section("Shipping recovery with fixtures") {
            Button("Enable fixture Gateway") { Task { await validation.setLocalOnly(false) } }
            Text("Siri command for this fixture: \(HardwareFixtureConfiguration.remoteCommand)")
            Button("Submit one synthetic operation through app") {
                Task {
                    result = await AppRuntime.shared.ask(HardwareFixtureConfiguration.remoteCommand)
                    await validation.refreshEvidence()
                }
            }
            Button("Complete pending synthetic jobs") { Task { await validation.completeJobs() } }
            TextField("Optional operation reference", text: $operationReference)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Check operation through app") {
                Task {
                    result = await AppRuntime.shared.checkLatestJob(reference: operationReference)
                    await validation.refreshEvidence()
                }
            }
            Button("Lose next receipt after synthetic acceptance") { Task { await validation.loseNextReceipt() } }
            Text("The app buttons exercise the same composition. They do not prove Siri activation, dictation, or a spoken confirmation. Use the installed Ask Arcanos and status actions for those checks.")
                .font(.caption)
        }
        Section("Synthetic authentication and confirmation responses") {
            Menu("Fixture authentication response") {
                ForEach(HardwareFixtureControls.Authentication.allCases, id: \.rawValue) { value in
                    Button(value.rawValue) { Task { await validation.setAuthentication(value) } }
                }
            }
            Menu("Fixture approved-retry response") {
                ForEach(HardwareFixtureControls.ApprovedRetry.allCases, id: \.rawValue) { value in
                    Button(value.rawValue) { Task { await validation.setApprovedRetry(value) } }
                }
            }
            Text("Use Ask Arcanos ‘Run tests’ for the real system confirmation interaction. Fixtures never run tests or apply patches. Expiry/revocation responses are simulated; replacing credentials is always explicit.")
                .font(.caption)
        }
        if let result {
            Section("Last app test result") { VoiceSnippet(presentation: result) }
        }
        Section("Sanitized application evidence") {
            Button("Refresh validation evidence") { Task { await validation.refreshEvidence() } }
            Text(validation.evidence).font(.caption2.monospaced()).textSelection(.enabled)
            ShareLink("Export validation evidence", item: validation.evidence)
            Text("Match this observation to the build manifest and manually recorded lifecycle event. Process IDs identify only the process that wrote each event, not every process Siri used. No cleanup is automatic.")
                .font(.caption)
        }
    }
}
#endif
