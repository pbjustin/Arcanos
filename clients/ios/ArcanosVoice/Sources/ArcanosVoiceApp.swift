import AppIntents
import SwiftUI

@main
struct ArcanosVoiceApp: App {
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            SettingsView()
                .task { ArcanosShortcuts.updateAppShortcutParameters() }
                .task(id: scenePhase) {
                    if scenePhase == .active {
                        await AppRuntime.shared.activate()
                        #if ARCANOS_HARDWARE_VALIDATION && targetEnvironment(simulator)
                        await SimulatorRecoveryDriver.runIfRequested(runtime: AppRuntime.shared)
                        #endif
                    }
                }
        }
    }
}
