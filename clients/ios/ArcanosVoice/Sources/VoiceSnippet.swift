import ArcanosKit
import Foundation
import SwiftUI

struct VoicePresentation: Sendable {
    let text: String
    let status: String
    let approvalID: UUID?
    let operationID: UUID?

    init(_ result: SessionResult, demonstration: Bool) {
        #if ARCANOS_HARDWARE_VALIDATION
        let spokenText = "Hardware validation. \(result.text)"
        #else
        let spokenText = demonstration ? "Simulation. \(result.text)" : result.text
        #endif
        text = String(spokenText.prefix(4_000))
        approvalID = result.approvalID
        operationID = result.operationID
        switch result.kind {
        case .answer: status = demonstration ? "Simulated result" : "Response"
        case .pending: status = "Pending — not completed"
        case .confirmationRequired: status = "Approval required"
        case .failure: status = "Unavailable or failed"
        case .unavailable: status = "Status unavailable"
        case .clarificationRequired: status = "Choose an operation"
        case .cancelled: status = "Interaction stopped"
        }
    }

    init(text: String, status: String) {
        #if ARCANOS_HARDWARE_VALIDATION
        self.text = String("Hardware validation. \(text)".prefix(4_000))
        #else
        self.text = String(text.prefix(4_000))
        #endif
        self.status = status
        approvalID = nil
        operationID = nil
    }
}

/// A system result surface, with no chat history or independent approval state.
struct VoiceSnippet: View {
    let presentation: VoicePresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            #if ARCANOS_HARDWARE_VALIDATION
            Label("ARCANOS · Fixture Gateway", systemImage: "testtube.2")
                .font(.headline)
            #else
            Label("ARCANOS", systemImage: "waveform")
                .font(.headline)
            #endif
            Text(presentation.status)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(presentation.text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            if let reference = presentation.operationID {
                Text("Operation reference: \(reference.uuidString)")
                    .font(.caption2)
                    .textSelection(.enabled)
            }
        }
        .padding()
        .accessibilityElement(children: .combine)
    }
}
