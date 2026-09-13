#!/usr/bin/env python3
"""Run installed-app fixture recovery on a new, isolated iOS Simulator. No live services."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import time
import uuid

BUNDLE = "org.arcanos.voice.hardware-validation"
ACTIONS = ("submit", "restore", "complete", "repeatedRestore")
SCENARIOS = ("acceptedReceipt", "lostReceipt", "cancelledApproval", "localOnly")


def actions_for(scenario):
    require(scenario in SCENARIOS, "Unsupported fixture scenario")
    return ACTIONS if scenario in ("acceptedReceipt", "lostReceipt") else ACTIONS[:2]
SCOPE = ("Installed Simulator host app, real shipping AppRuntime/session/recovery and Simulator Keychain; "
         "injected durable Gateway fixture, no HTTP. Actual App Intent invocation, voice, Foundation Models inference, "
         "physical-device behavior and live services NOT RUN.")


class ValidationFailure(Exception):
    """A bounded check failed without exposing raw app/process output."""


def require(condition, message):
    if not condition:
        raise ValidationFailure(message)


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)).lower() == value.lower()
    except (ValueError, AttributeError):
        return False


def nonnegative_integer(value):
    return type(value) is int and value >= 0


def expected_stage(scenario, action):
    require(action in actions_for(scenario), "Stage action mismatch")
    completed = action in ("complete", "repeatedRestore")
    if scenario == "acceptedReceipt":
        return ("terminal" if completed else "accepted" if action == "submit" else "observing",
                "completed" if completed else "queued" if action == "submit" else "pending",
                "Response" if completed else "Pending — not completed", completed)
    if scenario == "cancelledApproval":
        return "dismissed", "none", "Interaction stopped", False
    return ("submissionUncertain", "none",
            "Unavailable or failed" if scenario == "localOnly" and action == "submit" else "Status unavailable", False)


def validate_stage(raw, *, action, run_id, revision, expected_pid, scenario="acceptedReceipt"):
    """Check actual app observations before projecting bounded, content-free proof."""
    require(isinstance(raw, dict), "Stage proof is not an object")
    require(raw.get("schema") == "arcanos-phase3c-simulator-stage/v1", "Unrecognized stage schema")
    require(raw.get("status") == "PASS", "Installed app reported a failed stage")
    require(raw.get("scenario") == scenario and raw.get("action") == action, "Stage scenario/action mismatch")
    state, backend, presentation, authoritative = expected_stage(scenario, action)
    require(raw.get("runID") == run_id and valid_uuid(run_id), "Stage belongs to a different run")
    require(raw.get("revision") == revision and re.fullmatch(r"[0-9a-f]{40}", revision), "Build revision mismatch")
    require(raw.get("configuration") == "HardwareValidation" and raw.get("bundleIdentifier") == BUNDLE,
            "Build isolation metadata mismatch")
    require(raw.get("platform") == "iOS Simulator" and raw.get("processName") == "ArcanosVoice", "Not the installed Simulator app")
    require(type(expected_pid) is int and expected_pid > 0 and type(raw.get("processID")) is int
            and raw["processID"] == expected_pid, "Process evidence mismatch")
    require(raw.get("fixtureOriginSelected") is True and raw.get("productionPreferencesIgnored") is True,
            "Startup fixture isolation not established")
    require(type(raw.get("httpRequests")) is int and raw["httpRequests"] == 0, "Fixture transport boundary mismatch")
    for key in ("appIntentInvocation", "voice", "foundationModelsInference", "physicalDevice", "liveServices"):
        require(raw.get(key) == "NOT RUN", "Unsupported evidence claim")
    require(raw.get("systemKeychainProbe") == "PASS — Simulator only; synthetic namespace", "Synthetic Simulator Keychain probe failed")
    require(raw.get("pendingApprovalAbsent") is True, "Unexpected pending approval")
    if scenario == "cancelledApproval":
        require(raw.get("cancelledApprovalNotReplayed") is True, "Cancelled approval was replayed")
        if action == "submit":
            require(raw.get("approvalRetryRejected") is True, "Cancelled approval retry was not rejected")
    observation = raw.get("observation")
    require(isinstance(observation, dict), "Missing structured app observation")
    require(observation.get("revision") == revision and observation.get("processID") == expected_pid,
            "App observation revision/process mismatch")
    require(observation.get("configuration") == "HardwareValidation", "App observation configuration mismatch")
    operations = observation.get("operations")
    require(isinstance(operations, list) and len(operations) == 1 and isinstance(operations[0], dict), "Expected exactly one durable operation")
    operation = operations[0]
    require(all(valid_uuid(operation.get(key)) for key in ("operationID", "idempotencyKey")), "Invalid synthetic correlation identifier")
    require(valid_uuid(operation.get("jobID")) if scenario == "acceptedReceipt" else operation.get("jobID") == "none",
            "Unexpected accepted receipt")
    require(operation.get("state") == state and operation.get("backendStatus") == backend, "Durable operation state mismatch")
    require(raw.get("presentationStatus") == presentation and raw.get("authoritativeFixtureResultMatched") is authoritative,
            "Untruthful presentation or authoritative result")
    restored = [] if action == "submit" or scenario == "cancelledApproval" else [operation["operationID"]]
    require(raw.get("startupRestoredOperationIDs") == restored, "Startup did not restore the expected operation")
    fixture = observation.get("fixture")
    require(isinstance(fixture, dict), "Missing structured fixture observation")
    require(fixture.get("configuration") == {"mode": "localOnly" if scenario == "localOnly" else "fixtures",
            "nextReceipt": "accepted", "authentication": "accepted", "approvedRetry": "accepted"}, "Unexpected fixture controls")
    counts = {key: fixture.get(key) for key in ("requestAttempts", "submissionAttempts", "resultAttempts", "semanticExecutionCount", "rejectedAttempts")}
    require(all(nonnegative_integer(value) for value in counts.values()), "Invalid fixture counters")
    require(counts["submissionAttempts"] == 1 and counts["rejectedAttempts"] == int(scenario == "localOnly"), "Duplicate or unexpected submission")
    require(counts["requestAttempts"] == 1 + counts["resultAttempts"], "Transport counts disagree")
    require(counts["resultAttempts"] == 0 if scenario != "acceptedReceipt" or action == "submit" else counts["resultAttempts"] > 0,
            "Missing status read or unexpected automatic replay")
    executions = int(action in ("complete", "repeatedRestore"))
    require(counts["semanticExecutionCount"] == executions, "Unexpected semantic execution count")
    jobs = fixture.get("jobs")
    has_job = scenario in ("acceptedReceipt", "lostReceipt")
    require(isinstance(jobs, list) and len(jobs) == int(has_job), "Unexpected fixture job count")
    fixture_job = None
    if has_job:
        job = jobs[0]
        require(isinstance(job, dict) and valid_uuid(job.get("jobID")), "Invalid fixture job")
        fixture_job = job["jobID"]
        require(job.get("idempotencyKey") == operation["idempotencyKey"] and job.get("action") == "ai"
                and job.get("completed") is bool(executions), "Operation/job identity mismatch")
        if scenario == "acceptedReceipt":
            require(fixture_job == operation["jobID"], "Accepted job was replaced")
    events = fixture.get("events")
    require(isinstance(events, list) and 0 < len(events) <= 500, "Missing fixture events")
    last_sequence = 0
    for event in events:
        require(isinstance(event, dict) and isinstance(event.get("kind"), str), "Invalid fixture event")
        sequence = event.get("sequence")
        require(type(sequence) is int and sequence > last_sequence, "Invalid fixture event sequence")
        last_sequence = sequence
        require(event.get("processName") == "ArcanosVoice" and type(event.get("processID")) is int and event["processID"] > 0,
                "Fixture event did not come from the installed host")
        require(not event["kind"].startswith("intent"), "Unexpected intent invocation evidence")
        if event["kind"] in ("accepted", "completed", "resultRead", "lostReceipt"):
            require(has_job and event.get("jobID") == fixture_job, "Fixture event references another job")
    totals = {kind: sum(event["kind"] == kind for event in events)
              for kind in ("accepted", "completed", "resultRead", "lostReceipt", "challenge", "rejected", "transportAttempt")}
    require(totals == {"accepted": int(has_job), "completed": executions, "resultRead": counts["resultAttempts"],
                      "lostReceipt": int(scenario == "lostReceipt"), "challenge": int(scenario == "cancelledApproval"),
                      "rejected": int(scenario == "localOnly"), "transportAttempt": counts["requestAttempts"]},
            "Fixture event counts disagree with transport observations")
    require(any(event["kind"] == "startup" and event["processID"] == expected_pid for event in events), "Missing host startup event")
    if scenario == "acceptedReceipt" and action != "submit":
        require(any(event["kind"] == "resultRead" and event["processID"] == expected_pid for event in events), "No authoritative read in current host process")
    return {"action": action, "scenario": scenario, "status": "PASS", "revision": revision, "runID": run_id,
            "processID": expected_pid, "configuration": "HardwareValidation", "platform": "iOS Simulator",
            "operation": {key: operation[key] for key in ("operationID", "jobID", "idempotencyKey", "state", "backendStatus")},
            "fixtureJobID": fixture_job, "counts": counts, "acceptedEvents": int(has_job), "completedEvents": executions,
            "eventCounts": totals, "lastEventSequence": last_sequence,
            "eventProcessIDs": sorted({event["processID"] for event in events}),
            "authoritativeFixtureResultMatched": authoritative, "startupRestoredOperationIDs": restored,
            "fixtureOriginSelected": True, "productionPreferencesIgnored": True, "pendingApprovalAbsent": True,
            "cancelledApprovalNotReplayed": scenario == "cancelledApproval",
            "systemKeychainProbe": "PASS — Simulator only; synthetic namespace"}


def validate_sequence(stages, terminations, scenario="acceptedReceipt"):
    actions = actions_for(scenario)
    require(isinstance(stages, list) and len(stages) == len(actions), "Incomplete lifecycle sequence")
    require(isinstance(terminations, list) and len(terminations) == len(actions) - 1, "App process termination not observed between stages")
    first = stages[0].get("operation", {}) if isinstance(stages[0], dict) else {}
    for index, (stage, action) in enumerate(zip(stages, actions)):
        require(isinstance(stage, dict) and stage.get("status") == "PASS" and stage.get("action") == action
                and stage.get("scenario") == scenario, "Incomplete or substituted lifecycle stage")
        state, backend, _, authoritative = expected_stage(scenario, action)
        require(stage.get("configuration") == "HardwareValidation" and stage.get("platform") == "iOS Simulator",
                "Projected stage isolation mismatch")
        require(type(stage.get("processID")) is int and stage["processID"] > 0, "Invalid host process")
        require(valid_uuid(stage.get("runID")) and stage["runID"] == stages[0]["runID"]
                and isinstance(stage.get("revision"), str) and re.fullmatch(r"[0-9a-f]{40}", stage["revision"])
                and stage["revision"] == stages[0]["revision"], "Mixed run or revision evidence")
        operation = stage.get("operation")
        require(isinstance(operation, dict) and all(valid_uuid(operation.get(key)) for key in ("operationID", "idempotencyKey")), "Invalid projected operation")
        require(all(operation.get(key) == first.get(key) for key in ("operationID", "jobID", "idempotencyKey")),
                "Relaunch replaced the original operation/job/idempotency context")
        require(operation.get("state") == state and operation.get("backendStatus") == backend, "Projected operation state mismatch")
        has_job = scenario in ("acceptedReceipt", "lostReceipt")
        require(valid_uuid(stage.get("fixtureJobID")) if has_job else stage.get("fixtureJobID") is None, "Projected fixture job mismatch")
        require(stage.get("fixtureJobID") == stages[0].get("fixtureJobID"), "Fixture job changed across processes")
        require(operation.get("jobID") == stage["fixtureJobID"] if scenario == "acceptedReceipt" else operation.get("jobID") == "none",
                "Projected accepted receipt mismatch")
        counts = stage.get("counts")
        require(isinstance(counts, dict) and set(counts) == {"requestAttempts", "submissionAttempts", "resultAttempts", "semanticExecutionCount", "rejectedAttempts"}
                and all(nonnegative_integer(value) for value in counts.values()), "Invalid projected counters")
        executions = int(action in ("complete", "repeatedRestore"))
        require(counts["submissionAttempts"] == 1 and counts["rejectedAttempts"] == int(scenario == "localOnly")
                and counts["semanticExecutionCount"] == executions and counts["requestAttempts"] == 1 + counts["resultAttempts"],
                "Projected duplicate submission/execution or inconsistent counts")
        require(counts["resultAttempts"] == 0 if scenario != "acceptedReceipt" or action == "submit" else counts["resultAttempts"] > 0,
                "Missing result reads or replay of uncertain operation")
        require(stage.get("acceptedEvents") == int(has_job) and stage.get("completedEvents") == executions
                and stage.get("eventCounts") == {"accepted": int(has_job), "completed": executions,
                    "resultRead": counts["resultAttempts"], "lostReceipt": int(scenario == "lostReceipt"),
                    "challenge": int(scenario == "cancelledApproval"), "rejected": int(scenario == "localOnly"),
                    "transportAttempt": counts["requestAttempts"]}, "Projected event counters disagree")
        require(type(stage.get("lastEventSequence")) is int and stage["lastEventSequence"] > 0, "Missing event sequence")
        require(stage.get("eventProcessIDs") == sorted({item["processID"] for item in stages[:index + 1]}),
                "Fixture events include an unobserved host process")
        require(stage.get("authoritativeFixtureResultMatched") is authoritative and stage.get("startupRestoredOperationIDs") ==
                ([] if action == "submit" or scenario == "cancelledApproval" else [operation["operationID"]]), "Projected result/restoration mismatch")
        require(stage.get("fixtureOriginSelected") is True and stage.get("productionPreferencesIgnored") is True
                and stage.get("pendingApprovalAbsent") is True
                and stage.get("cancelledApprovalNotReplayed") is (scenario == "cancelledApproval")
                and stage.get("systemKeychainProbe") == "PASS — Simulator only; synthetic namespace", "Projected isolation or approval mismatch")
        if index:
            previous = stages[index - 1]
            termination = terminations[index - 1]
            require(isinstance(termination, dict) and termination.get("status") == "PASS"
                    and termination.get("processID") == previous["processID"] and termination.get("action") == actions[index - 1],
                    "Wrong action/process was terminated")
            require(stage["processID"] not in [item["processID"] for item in stages[:index]], "Relaunch reused previous process evidence")
            require(stage["lastEventSequence"] > previous["lastEventSequence"], "Relaunch reused stale event evidence")
            if scenario == "acceptedReceipt":
                require(counts["resultAttempts"] > previous["counts"]["resultAttempts"], "Relaunch did not retrieve authoritative fixture status")
    return {"status": "PASS", "scenario": scenario, "scope": SCOPE,
            "operationID": first["operationID"], "jobID": first["jobID"],
            "interceptedSubmissionAttempts": stages[-1]["counts"]["submissionAttempts"],
            "semanticFixtureExecutions": stages[-1]["counts"]["semanticExecutionCount"], "httpRequests": 0,
            "sameOperationPreserved": True, "sameOperationRestored": scenario != "cancelledApproval",
            "sameJobRestored": scenario == "acceptedReceipt",
            "authoritativeFixtureResultRetrieved": scenario == "acceptedReceipt",
            "uncertainSubmissionNotReplayed": scenario in ("lostReceipt", "localOnly"),
            "cancelledApprovalNotReplayed": scenario == "cancelledApproval",
            "lifecycle": "simctl termination of verified host-app PID, observed exit, new host PID"}


def validate_report(report, revision, scenario):
    """Recheck retained complete evidence before a cloud matrix can claim success."""
    require(isinstance(report, dict) and report.get("schema") == "arcanos-phase3c-simulator-proof/v1"
            and report.get("status") == "PASS" and report.get("scenario") == scenario
            and report.get("revision") == revision, "Incomplete or mismatched Simulator report")
    for field in ("physicalDevice", "appIntentInvocation", "liveServices"):
        require(report.get(field) == "NOT RUN", "Unsupported Simulator evidence claim")
    required = {"source-and-built-app-isolation", "list-runtimes", "create-owned-simulator", "boot-owned-simulator",
                "boot-readiness", "install-hardware-validation-app", "locate-isolated-app-container",
                "seed-synthetic-stale-preferences", "shutdown-owned-simulator"}
    required |= {"launch-" + action for action in actions_for(scenario)}
    required |= {"terminate-" + action for action in actions_for(scenario)[:-1]}
    checks = report.get("checks")
    require(isinstance(checks, list) and all(isinstance(check, dict) and check.get("status") == "PASS"
            and check.get("exitCode", 0) == 0 for check in checks), "Failed Simulator controller check")
    require(required <= {check.get("name") for check in checks}, "Missing Simulator controller checks")
    stages = report.get("stages")
    proof = validate_sequence(stages, report.get("terminations"), scenario)
    require(all(stage["revision"] == revision for stage in stages) and report.get("proof") == proof,
            "Simulator summary does not match its evidence")
    return proof


def select_runtime(runtimes, version):
    matches = [item for item in runtimes.get("runtimes", []) if item.get("isAvailable") is True
               and item.get("version") == version and item.get("identifier", "").startswith("com.apple.CoreSimulator.SimRuntime.iOS-")]
    require(len(matches) == 1, "Required available iOS Simulator runtime not uniquely installed: " + version)
    return matches[0]


def wait_until(probe, timeout, interval=0.1):
    """Wait for an observable condition, never assume an arbitrary sleep implies readiness."""
    deadline = time.monotonic() + timeout
    while True:
        value = probe()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise ValidationFailure("Bounded observation timed out; outcome not established")
        time.sleep(min(interval, max(0, deadline - time.monotonic())))


def process_exited(pid):
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        raise ValidationFailure("Cannot observe the installed app process exit") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True, help="Built HardwareValidation Simulator .app")
    parser.add_argument("--output-dir", type=Path, required=True, help="New evidence directory; no artifacts/devices are deleted")
    parser.add_argument("--revision", required=True, help="Full Git SHA embedded in the app build")
    parser.add_argument("--scenario", choices=SCENARIOS, default="acceptedReceipt")
    parser.add_argument("--runtime-version", default="26.2")
    parser.add_argument("--device-type", default="com.apple.CoreSimulator.SimDeviceType.iPhone-16")
    args = parser.parse_args()
    require(bool(re.fullmatch(r"[0-9a-f]{40}", args.revision)), "A full lowercase Git SHA is required")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "arcanos-phase3c-simulator-proof/v1", "capturedAt": datetime.now(timezone.utc).isoformat(),
              "revision": args.revision, "scenario": args.scenario, "status": "NOT RUN", "scope": SCOPE, "checks": [], "stages": [],
              "terminations": [], "runtimeRequested": args.runtime_version, "deviceType": args.device_type,
              "physicalDevice": "NOT RUN", "appIntentInvocation": "NOT RUN", "liveServices": "NOT RUN"}
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "DEVELOPER_DIR") if key in os.environ}
    environment.update({"LC_ALL": "C", "LANG": "C", "PYTHONDONTWRITEBYTECODE": "1"})
    simulator = None
    simulator_shutdown = False

    def execute(label, arguments, timeout=120):
        try:
            result = subprocess.run(arguments, env=environment, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            report["checks"].append({"name": label, "status": "FAIL", "reason": "Executable unavailable or bounded command timed out"})
            raise ValidationFailure(label + " could not complete") from None
        report["checks"].append({"name": label, "status": "PASS" if result.returncode == 0 else "FAIL", "exitCode": result.returncode})
        require(result.returncode == 0, label + " failed; raw output is not exported")
        return result.stdout

    try:
        if platform.system() != "Darwin" or not shutil.which("xcrun"):
            report.update(status="BLOCKED", dependency="macOS with selected Xcode and the requested iOS Simulator runtime")
            return 2
        checker_path = Path(__file__).with_name("validate-hardware-configuration.py")
        spec = importlib.util.spec_from_file_location("hardware_configuration", checker_path)
        checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(checker)
        checker.validate_sources(Path(__file__).resolve().parents[1])
        checker.validate_app(args.app.resolve(), "HardwareValidation")
        info = plistlib.loads((args.app.resolve() / "Info.plist").read_bytes())
        require(info.get("ArcanosValidationRevision") == args.revision, "App revision does not match requested source")
        require(info.get("CFBundleSupportedPlatforms") == ["iPhoneSimulator"], "Refusing non-Simulator artifact")
        report["checks"].append({"name": "source-and-built-app-isolation", "status": "PASS"})
        runtime = select_runtime(json.loads(execute("list-runtimes", ["xcrun", "simctl", "list", "runtimes", "--json"])), args.runtime_version)
        report["runtime"] = {key: runtime.get(key) for key in ("name", "version", "buildversion")}
        run_id = str(uuid.uuid4()).upper()
        report["ownedSimulatorName"] = "ARCANOS Phase3C " + run_id
        simulator = execute("create-owned-simulator", ["xcrun", "simctl", "create", "ARCANOS Phase3C " + run_id,
                            args.device_type, runtime["identifier"]]).strip()
        require(valid_uuid(simulator), "Unexpected Simulator creation result")
        execute("boot-owned-simulator", ["xcrun", "simctl", "boot", simulator])
        execute("boot-readiness", ["xcrun", "simctl", "bootstatus", simulator, "-b"], timeout=300)
        execute("install-hardware-validation-app", ["xcrun", "simctl", "install", simulator, str(args.app.resolve())])
        container = Path(execute("locate-isolated-app-container", ["xcrun", "simctl", "get_app_container", simulator, BUNDLE, "data"]).strip()).resolve()
        require(container.is_dir(), "Installed app container unavailable")
        preferences = container / "Library/Preferences" / (BUNDLE + ".plist")
        require(not preferences.exists(), "New Simulator unexpectedly contains prior application preferences")
        preferences.parent.mkdir(parents=True, exist_ok=True)
        # Synthetic stale production preference, not a real endpoint or credential.
        preferences.write_bytes(plistlib.dumps({"arcanos.gateway.origin": "https://phase3c-forbidden-origin.invalid", "arcanos.demo.enabled": True}))
        report["checks"].append({"name": "seed-synthetic-stale-preferences", "status": "PASS"})
        for action in actions_for(args.scenario):
            launched = execute("launch-" + action, ["xcrun", "simctl", "launch", simulator, BUNDLE,
                               "--phase3c-simulator-action", action, "--phase3c-simulator-run-id", run_id,
                               "--phase3c-simulator-scenario", args.scenario])
            match = re.fullmatch(re.escape(BUNDLE) + r": (\d+)\s*", launched)
            require(match is not None, "Cannot identify installed host-app process")
            pid = int(match.group(1))
            proof_path = container / "Library/Application Support/ArcanosHardwareValidation-v1" / ("simulator-proof-" + run_id + "-" + action + ".json")
            wait_until(lambda: proof_path.is_file(), 90)
            require(proof_path.stat().st_size < 262_144, "Stage proof exceeds the bounded artifact limit")
            stage = validate_stage(json.loads(proof_path.read_text(encoding="utf-8")), action=action, run_id=run_id,
                                   revision=args.revision, expected_pid=pid, scenario=args.scenario)
            report["stages"].append(stage)
            if action != actions_for(args.scenario)[-1]:
                execute("terminate-" + action, ["xcrun", "simctl", "terminate", simulator, BUNDLE])
                wait_until(lambda: process_exited(pid), 30)
                report["terminations"].append({"status": "PASS", "processID": pid, "action": action,
                                               "observation": "simctl terminate succeeded; host PID no longer exists"})
        report["proof"] = validate_sequence(report["stages"], report["terminations"], args.scenario)
        execute("shutdown-owned-simulator", ["xcrun", "simctl", "shutdown", simulator])
        simulator_shutdown = True
        report["status"] = "PASS"
        validate_report(report, args.revision, args.scenario)
        return 0
    except ValidationFailure as error:
        report.update(status="FAIL", failure=str(error))
        return 1
    except (ValueError, OSError, KeyError, TypeError):
        report.update(status="FAIL", failure="Simulator preflight, execution or proof validation failed; no success inferred")
        return 1
    finally:
        if simulator and valid_uuid(simulator) and not simulator_shutdown:
            try:
                execute("shutdown-owned-simulator", ["xcrun", "simctl", "shutdown", simulator])
            except ValidationFailure:
                report["shutdown"] = "FAIL — owned Simulator retained for operator inspection"
        report["cleanup"] = "No Simulator deletion, erasure or artifact removal. Dedicated Simulator and app data retained on persistent hosts."
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "report": str(output / "report.json"), "scope": SCOPE}, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
