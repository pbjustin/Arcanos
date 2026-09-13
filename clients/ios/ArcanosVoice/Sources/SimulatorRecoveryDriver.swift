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
    private enum Scenario: String { case acceptedReceipt, lostReceipt, cancelledApproval, localOnly }
    private enum ProofError: String, Error {
        case isolationMismatch, nonemptyInitialStore, syntheticKeychainProbeFailed
        case correlationMismatch, presentationMismatch, missingObservation, scenarioMismatch
    }

    static func runIfRequested(runtime: AppRuntime) async {
        let arguments = ProcessInfo.processInfo.arguments
        guard !consumedLaunch,
              let actionIndex = arguments.firstIndex(of: "--phase3c-simulator-action"),
              let runIndex = arguments.firstIndex(of: "--phase3c-simulator-run-id"),
              arguments.indices.contains(actionIndex + 1), arguments.indices.contains(runIndex + 1),
              let action = Action(rawValue: arguments[actionIndex + 1]),
              let runID = UUID(uuidString: arguments[runIndex + 1]) else { return }
        let scenario: Scenario
        if let index = arguments.firstIndex(of: "--phase3c-simulator-scenario") {
            guard arguments.indices.contains(index + 1), let value = Scenario(rawValue: arguments[index + 1]) else { return }
            scenario = value
        } else { scenario = .acceptedReceipt }
        consumedLaunch = true
        var report: [String: Any] = [
            "schema": "arcanos-phase3c-simulator-stage/v1", "runID": runID.uuidString,
            "action": action.rawValue, "scenario": scenario.rawValue, "status": "FAIL",
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
            guard ![Scenario.cancelledApproval, .localOnly].contains(scenario)
                    || [Action.submit, .restore].contains(action) else { throw ProofError.scenarioMismatch }
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
                await hardware.setLocalOnly(scenario == .localOnly)
                if scenario == .lostReceipt { await hardware.loseNextReceipt() }
            } else {
                await hardware.probeCredential()
                guard hardware.keychainFinding.hasPrefix("PASS") else { throw ProofError.syntheticKeychainProbeFailed }
            }
            let result: VoicePresentation
            if scenario == .cancelledApproval {
                let operationReference: String
                if action == .submit {
                    let approval = await runtime.ask("Run tests")
                    guard approval.status == "Approval required", let approvalID = approval.approvalID,
                          let operationID = approval.operationID else { throw ProofError.presentationMismatch }
                    operationReference = operationID.uuidString
                    let cancelled = await runtime.cancel(approvalID)
                    let replay = await runtime.approve(approvalID)
                    guard cancelled.status == "Interaction stopped", replay.status == "Unavailable or failed",
                          replay.approvalID == nil else { throw ProofError.presentationMismatch }
                    report["approvalRetryRejected"] = true
                } else {
                    guard let operations = before["operations"] as? [[String: Any]], operations.count == 1,
                          let reference = operations[0]["operationID"] as? String else { throw ProofError.missingObservation }
                    operationReference = reference
                }
                guard runtime.pendingApproval == nil, runtime.recoveredResults.compactMap(\.operationID).isEmpty else {
                    throw ProofError.scenarioMismatch
                }
                result = await runtime.checkLatestJob(reference: operationReference)
            } else {
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
            }
            let after = try await observation(hardware)
            guard let operations = after["operations"] as? [[String: Any]], operations.count == 1,
                  let operationID = operations[0]["operationID"] as? String,
                  result.operationID?.uuidString == operationID, result.approvalID == nil else {
                throw ProofError.correlationMismatch
            }
            let completedStage = action == .complete || action == .repeatedRestore
            let expectsCompletion = scenario == .acceptedReceipt && completedStage
            let authoritativeResult = result.text == "Hardware validation. \(HardwareFixtureConfiguration.resultText)"
            let fixture = try await hardware.transport.snapshot()
            guard fixture.submissionAttempts == 1, runtime.pendingApproval == nil else { throw ProofError.scenarioMismatch }
            let expectedStatus: String
            switch scenario {
            case .acceptedReceipt:
                expectedStatus = expectsCompletion ? "Response" : "Pending — not completed"
            case .lostReceipt:
                expectedStatus = "Status unavailable"
                guard fixture.configuration.mode == .fixtures, fixture.jobs.count == 1,
                      fixture.jobs[0].completed == completedStage,
                      fixture.semanticExecutionCount == (completedStage ? 1 : 0),
                      fixture.requestAttempts == 1, fixture.resultAttempts == 0, fixture.rejectedAttempts == 0,
                      operations[0]["state"] as? String == "submissionUncertain",
                      operations[0]["jobID"] as? String == "none", operations[0]["backendStatus"] as? String == "none" else {
                    throw ProofError.scenarioMismatch
                }
            case .cancelledApproval:
                expectedStatus = "Interaction stopped"
                guard fixture.configuration.mode == .fixtures, fixture.jobs.isEmpty, fixture.semanticExecutionCount == 0,
                      fixture.requestAttempts == 1, fixture.resultAttempts == 0, fixture.rejectedAttempts == 0,
                      operations[0]["state"] as? String == "dismissed",
                      operations[0]["jobID"] as? String == "none", operations[0]["backendStatus"] as? String == "none" else {
                    throw ProofError.scenarioMismatch
                }
                report["cancelledApprovalNotReplayed"] = true
            case .localOnly:
                expectedStatus = action == .submit ? "Unavailable or failed" : "Status unavailable"
                guard fixture.configuration.mode == .localOnly, fixture.jobs.isEmpty, fixture.semanticExecutionCount == 0,
                      fixture.requestAttempts == 1, fixture.resultAttempts == 0, fixture.rejectedAttempts == 1,
                      operations[0]["state"] as? String == "submissionUncertain",
                      operations[0]["jobID"] as? String == "none", operations[0]["backendStatus"] as? String == "none" else {
                    throw ProofError.scenarioMismatch
                }
            }
            guard result.status == expectedStatus, authoritativeResult == expectsCompletion else { throw ProofError.presentationMismatch }
            report["status"] = "PASS"
            report["fixtureOriginSelected"] = true
            report["productionPreferencesIgnored"] = UserDefaults.standard.string(forKey: "arcanos.gateway.origin")
                == "https://phase3c-forbidden-origin.invalid" && !runtime.demonstration
            report["systemKeychainProbe"] = "PASS — Simulator only; synthetic namespace"
            report["presentationStatus"] = result.status
            report["authoritativeFixtureResultMatched"] = authoritativeResult
            report["pendingApprovalAbsent"] = runtime.pendingApproval == nil
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
