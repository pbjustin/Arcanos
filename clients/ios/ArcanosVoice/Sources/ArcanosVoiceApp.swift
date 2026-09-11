import AppIntents
import SwiftUI

@main
struct ArcanosVoiceApp: App {
    var body: some Scene {
        WindowGroup {
            SettingsView()
                .task { ArcanosShortcuts.updateAppShortcutParameters() }
        }
    }
}
