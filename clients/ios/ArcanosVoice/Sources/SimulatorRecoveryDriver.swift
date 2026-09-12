#if ARCANOS_HARDWARE_VALIDATION && targetEnvironment(simulator)
import ArcanosKit
import Foundation

/// Explicit CI launch actions inside the installed application. Uses AppRuntime's
/// shipping session, routing, persistence and recovery. This is not an App Intent
/// invocation, voice proof, physical Keychain proof, or model substitution.
@MainActor
enum SimulatorRecoveryDriver {
    private static var consumedLaunch = false
    private enum Action: String { case submit, restore, complete, repeatedRestore }
    private enum ProofError: String, Error {
        case isolationMismatch, nonemptyInitialStore, syntheticKeychainProbeFailed
        case correlationMismatch, presentationMismatch, missingObservation
    }

    static func runIfRequested(runtime: AppRuntime) async {
        let arguments = ProcessInfo.processInfo.arguments
        guard !consumedLaunch,
              let actionIndex = arguments.firstIndex(of: "--phase3c-simulator-action"),
              let runIndex = arguments.firstIndex(of: "--phase3c-simulator-run-id"),
              arguments.indices.contains(actionIndex + 1), arguments.indices.contains(runIndex + 1),
              let action = Action(rawValue: arguments[actionIndex + 1]),
              let runID = UUID(uuidString: arguments[runIndex + 1]) else { return }
        consumedLaunch = true
        var report: [String: Any] = [
            "schema": "arcanos-phase3c-simulator-stage/v1", "runID": runID.uuidString,
            "action": action.rawValue, "status": "FAIL",
            "revision": Bundle.main.object(forInfoDictionaryKey: "ArcanosValidationRevision") as? String ?? "UNRECORDED",
            "configuration": "HardwareValidation", "bundleIdentifier": Bundle.main.bundleIdentifier ?? "unknown",
            "processID": ProcessInfo.processInfo.processIdentifier,
            "processName": ProcessInfo.processInfo.processName,
            "platform": "iOS Simulator", "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "entryPoint": "installed host app AppRuntime; shared shipping orchestration",
            "appIntentInvocation": "NOT RUN", "voice": "NOT RUN", "foundationModelsInference": "NOT RUN",
            "physicalDevice": "NOT RUN", "liveServices": "NOT RUN", "httpRequests": 0
        ]
        do {
            guard let hardware = runtime.hardwareValidation, !runtime.demonstration,
                  runtime.gatewayAddress == HardwareFixtureConfiguration.origin.absoluteString else {
                throw ProofError.isolationMismatch
            }
            let before = try await observation(hardware)
            if action == .submit {
                guard let operations = before["operations"] as? [[String: Any]], operations.isEmpty,
                      let fixture = before["fixture"] as? [String: Any],
                      let jobs = fixture["jobs"] as? [[String: Any]], jobs.isEmpty,
                      fixture["requestAttempts"] as? Int == 0 else { throw ProofError.nonemptyInitialStore }
                // This launch action is explicit authorization for fresh synthetic
                // Simulator credentials; normal startup never initializes identity.
                await hardware.initializeCredential()
                guard hardware.keychainFinding.hasPrefix("PASS") else { throw ProofError.syntheticKeychainProbeFailed }
                await hardware.setLocalOnly(false)
            } else {
                await hardware.probeCredential()
                guard hardware.keychainFinding.hasPrefix("PASS") else { throw ProofError.syntheticKeychainProbeFailed }
            }
            let result: VoicePresentation
            switch action {
            case .submit:
                result = await runtime.ask(HardwareFixtureConfiguration.remoteCommand)
            case .restore:
                result = await runtime.checkLatestJob()
            case .complete:
                await hardware.completeJobs()
                result = await runtime.checkLatestJob()
            case .repeatedRestore:
                await runtime.activate()
                await runtime.activate()
                _ = await runtime.checkLatestJob()
                result = await runtime.checkLatestJob()
            }
            let after = try await observation(hardware)
            guard let operations = after["operations"] as? [[String: Any]], operations.count == 1,
                  let operationID = operations[0]["operationID"] as? String,
                  result.operationID?.uuidString == operationID, result.approvalID == nil else {
                throw ProofError.correlationMismatch
            }
            let expectsCompletion = action == .complete || action == .repeatedRestore
            let authoritativeResult = result.text == "Hardware validation. \(HardwareFixtureConfiguration.resultText)"
            guard result.status == (expectsCompletion ? "Response" : "Pending — not completed"),
                  authoritativeResult == expectsCompletion else { throw ProofError.presentationMismatch }
            report["status"] = "PASS"
            report["fixtureOriginSelected"] = true
            report["productionPreferencesIgnored"] = UserDefaults.standard.string(forKey: "arcanos.gateway.origin")
                == "https://phase3c-forbidden-origin.invalid" && !runtime.demonstration
            report["systemKeychainProbe"] = "PASS — Simulator only; synthetic namespace"
            report["presentationStatus"] = result.status
            report["authoritativeFixtureResultMatched"] = authoritativeResult
            report["startupRestoredOperationIDs"] = runtime.recoveredResults.compactMap { $0.operationID?.uuidString }
            report["observation"] = after
        } catch {
            // No prompts, credentials, errors with payloads, or Keychain bytes.
            report["failure"] = "Installed-app fixture precondition or outcome was not satisfied. Inspect bounded stage metadata."
            report["failureCategory"] = (error as? ProofError)?.rawValue ?? "missingObservation"
        }
        do {
            guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                throw ProofError.missingObservation
            }
            let directory = support.appendingPathComponent("ArcanosHardwareValidation-v1", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("simulator-proof-\(runID.uuidString)-\(action.rawValue).json")
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: file, options: [.atomic, .completeFileProtection])
        } catch {
            // The controller times out without a fresh proof; a stale file cannot pass.
        }
    }

    private static func observation(_ hardware: HardwareValidationRuntime) async throws -> [String: Any] {
        await hardware.refreshEvidence()
        guard let value = try JSONSerialization.jsonObject(with: Data(hardware.evidence.utf8)) as? [String: Any] else {
            throw ProofError.missingObservation
        }
        return value
    }
}
#endif
