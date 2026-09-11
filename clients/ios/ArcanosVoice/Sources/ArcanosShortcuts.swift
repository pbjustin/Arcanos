import AppIntents

struct ArcanosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskArcanos(),
            phrases: ["Ask \(.applicationName)", "Talk to \(.applicationName)"],
            shortTitle: "Ask Arcanos",
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: CaptureArcanosNote(),
            phrases: ["Capture a note with \(.applicationName)"],
            shortTitle: "Capture Note",
            systemImageName: "note.text"
        )
        AppShortcut(
            intent: ApproveArcanos(),
            phrases: ["Approve pending request with \(.applicationName)"],
            shortTitle: "Review Approval",
            systemImageName: "checkmark.shield"
        )
        AppShortcut(
            intent: CancelArcanos(),
            phrases: ["Cancel pending request with \(.applicationName)"],
            shortTitle: "Cancel Approval",
            systemImageName: "xmark.shield"
        )
        AppShortcut(
            intent: CheckArcanosJob(),
            phrases: ["Check my latest job with \(.applicationName)"],
            shortTitle: "Check Latest Job",
            systemImageName: "clock.arrow.circlepath"
        )
    }
}
