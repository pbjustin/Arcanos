import ArcanosKit
import Foundation
import SwiftUI

struct SettingsView: View {
    @State private var runtime = AppRuntime.shared
    @State private var note = ""
    @State private var gatewayAddress = ""
    @State private var pairingToken = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Voice") {
                    Label("Ask Arcanos", systemImage: "waveform")
                    Text("Use Siri or the Ask Arcanos action in Shortcuts. Leave Command empty to hear ‘What do you need?’")
                    Text("For ‘Hey Arcanos’, configure Settings → Accessibility → Vocal Shortcuts using a shortcut containing Ask Arcanos.")
                        .foregroundStyle(.secondary)
                }
                Section("Local intelligence") {
                    Text(runtime.localModelStatus)
                    Button("Refresh availability") {
                        Task { await runtime.refreshDiagnostics() }
                    }
                }
                #if ARCANOS_HARDWARE_VALIDATION
                if let validation = runtime.hardwareValidation {
                    HardwareValidationView(validation: validation)
                } else {
                    Section("Hardware validation unavailable") {
                        Text("Gateway networking is disabled. Check the validation build configuration.")
                    }
                }
                #else
                Section("Pairing") {
                    Label(runtime.secureStorageUnavailable
                        ? "Secure storage is temporarily unavailable. Unlock this iPhone and try again. Pairing has not been removed."
                        : runtime.deviceState.message, systemImage: "lock.shield")
                    TextField("Gateway HTTPS origin", text: $gatewayAddress)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("One-use pairing token", text: $pairingToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .privacySensitive()
                    Button("Pair this iPhone") {
                        let submittedPairingToken = pairingToken
                        let address = gatewayAddress
                        pairingToken = ""
                        Task { await runtime.pair(address: address, pairingToken: submittedPairingToken) }
                    }
                    .disabled(runtime.changingPairing || gatewayAddress.isEmpty || !pairingToken.hasPrefix("agp1."))
                    Text("Create a short-lived pairing token in your trusted ARCANOS operator context and verify its Gateway origin. Only the one-use agp1 pairing token belongs here. Device secrets are stored in this iPhone's Keychain.")
                        .foregroundStyle(.secondary)
                    Button("Check device session") { Task { await runtime.inspectDeviceSession() } }
                        .disabled(runtime.changingPairing || runtime.gatewayAddress.isEmpty || runtime.demonstration)
                    Button("Renew device credential") { Task { await runtime.renewCredential() } }
                        .disabled(runtime.changingPairing || ![.paired, .renewalRequired].contains(runtime.deviceState) || runtime.demonstration)
                    Button("Revoke this device", role: .destructive) { Task { await runtime.revokeDevice() } }
                        .disabled(runtime.changingPairing || ![.paired, .renewalRequired].contains(runtime.deviceState) || runtime.demonstration)
                    Button("Forget local credential", role: .destructive) { Task { await runtime.forgetCredential() } }
                        .disabled(runtime.changingPairing || runtime.gatewayAddress.isEmpty || runtime.demonstration)
                }
                #endif
                #if DEBUG && !ARCANOS_HARDWARE_VALIDATION
                Section("Developer demonstration") {
                    Toggle("Simulate the Gateway", isOn: Binding(
                        get: { runtime.demonstration },
                        set: { runtime.setDemonstration($0) }
                    ))
                    .disabled(runtime.changingPairing)
                    Text("Simulation uses in-memory API fixtures. It makes no network requests and never runs tests or changes a repository. Responses say ‘Simulation’. Switching modes discards pending approvals; paired-device recovery records remain saved.")
                        .foregroundStyle(.secondary)
                }
                #endif
                Section("Temporary local note") {
                    TextField("A short note for local summarization", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                    Button("Capture in this session") {
                        let capturedText = note
                        note = ""
                        Task { _ = await runtime.capture(capturedText) }
                    }
                    .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || note.utf8.count > 8_000)
                    Text("\(runtime.capturedNoteCount) characters captured. Notes remain in memory and are lost when the app process ends. Eligible local operations use this note; any remote fallback includes that context in the request.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Clear note", role: .destructive) {
                        note = ""
                        Task { await runtime.clearNote() }
                    }
                }
                Section("Diagnostics") {
                    Text(runtime.diagnosticMessage)
                    Text("Siri and Vocal Shortcuts manage audio. Accepted operations remain available after restart. Check Latest Arcanos Job retrieves their status. Observation stops when the app is suspended; approvals require a fresh user interaction after restart.")
                        .foregroundStyle(.secondary)
                }
                if !runtime.recoveredResults.isEmpty {
                    Section("Recovered operations") {
                        ForEach(runtime.recoveredResults.indices, id: \.self) { index in
                            VoiceSnippet(presentation: runtime.recoveredResults[index])
                        }
                    }
                }
            }
            .navigationTitle("ARCANOS")
            .task {
                gatewayAddress = runtime.gatewayAddress
                await runtime.refreshDiagnostics()
            }
        }
    }
}
