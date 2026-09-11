import Foundation
import SwiftUI

struct SettingsView: View {
    @State private var runtime = AppRuntime.shared
    @State private var note = ""

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
                Section("Pairing") {
                    Label("Device pairing is not available yet", systemImage: "lock.shield")
                    Text("Remote access needs a scoped, revocable device credential issued by ARCANOS. Phase 1 does not provide credential entry. Local intelligence remains usable when available.")
                        .foregroundStyle(.secondary)
                }
                #if DEBUG
                Section("Developer demonstration") {
                    Toggle("Simulate the Gateway", isOn: Binding(
                        get: { runtime.demonstration },
                        set: { runtime.setDemonstration($0) }
                    ))
                    Text("Simulation uses in-memory API fixtures. It makes no network requests and never runs tests or changes a repository. Responses say ‘Simulation’. Switching modes discards pending approvals and tracked jobs.")
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
                    Text("Siri and Vocal Shortcuts manage audio. ARCANOS does not run a background microphone. Approvals and job tracking remain in this app process; ask again after a restart.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("ARCANOS")
            .task { await runtime.refreshDiagnostics() }
        }
    }
}
