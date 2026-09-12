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


def validate_stage(raw, *, action, run_id, revision, expected_pid):
    """Reject stale, substituted or inconsistent proof; return only allowed artifact fields."""
    require(isinstance(raw, dict), "Stage proof is not an object")
    require(raw.get("schema") == "arcanos-phase3c-simulator-stage/v1", "Unrecognized stage schema")
    if raw.get("status") != "PASS":
        category = raw.get("failureCategory")
        allowed_failures = {"isolationMismatch", "nonemptyInitialStore", "syntheticKeychainProbeFailed",
                            "correlationMismatch", "presentationMismatch", "missingObservation"}
        raise ValidationFailure("Installed app reported a failed stage: " +
                                (category if isinstance(category, str) and category in allowed_failures else "unrecognized failure"))
    require(raw.get("action") == action and action in ACTIONS, "Stage action mismatch")
    require(raw.get("runID") == run_id, "Stage belongs to a different run")
    require(raw.get("revision") == revision and re.fullmatch(r"[0-9a-f]{40}", revision), "Build revision mismatch")
    require(raw.get("configuration") == "HardwareValidation" and raw.get("bundleIdentifier") == BUNDLE,
            "Build isolation metadata mismatch")
    require(raw.get("platform") == "iOS Simulator" and raw.get("processName") == "ArcanosVoice", "Not the installed Simulator app")
    require(type(expected_pid) is int and expected_pid > 0 and raw.get("processID") == expected_pid, "Process evidence mismatch")
    require(raw.get("fixtureOriginSelected") is True and raw.get("productionPreferencesIgnored") is True,
            "Startup fixture isolation not established")
    require(type(raw.get("httpRequests")) is int and raw["httpRequests"] == 0, "Fixture transport boundary mismatch")
    for key in ("appIntentInvocation", "voice", "foundationModelsInference", "physicalDevice", "liveServices"):
        require(raw.get(key) == "NOT RUN", "Unsupported evidence claim")
    require(raw.get("systemKeychainProbe") == "PASS — Simulator only; synthetic namespace", "Synthetic Simulator Keychain probe failed")
    observation = raw.get("observation", {})
    require(isinstance(observation, dict), "Missing structured app observation")
    require(observation.get("revision") == revision and observation.get("processID") == expected_pid,
            "App observation revision/process mismatch")
    require(observation.get("configuration") == "HardwareValidation", "App observation configuration mismatch")
    operations = observation.get("operations")
    require(isinstance(operations, list) and len(operations) == 1, "Expected exactly one durable operation")
    operation = operations[0]
    require(isinstance(operation, dict), "Invalid operation record")
    for key in ("operationID", "jobID", "idempotencyKey"):
        require(valid_uuid(operation.get(key)), "Invalid synthetic correlation identifier")
    fixture = observation.get("fixture", {})
    require(isinstance(fixture, dict), "Missing structured fixture observation")
    require(fixture.get("configuration") == {"mode": "fixtures", "nextReceipt": "accepted", "authentication": "accepted",
                                           "approvedRetry": "accepted"}, "Unexpected fixture controls")
    counts = {key: fixture.get(key) for key in ("requestAttempts", "submissionAttempts", "resultAttempts",
                                              "semanticExecutionCount", "rejectedAttempts")}
    require(all(nonnegative_integer(value) for value in counts.values()), "Invalid fixture counters")
    require(counts["submissionAttempts"] == 1 and counts["rejectedAttempts"] == 0, "Duplicate or rejected submission")
    require(counts["requestAttempts"] == counts["submissionAttempts"] + counts["resultAttempts"], "Transport counts disagree")
    completed = action in ("complete", "repeatedRestore")
    require(counts["semanticExecutionCount"] == int(completed), "Unexpected semantic execution count")
    jobs = fixture.get("jobs")
    require(isinstance(jobs, list) and len(jobs) == 1, "Expected exactly one fixture job")
    job = jobs[0]
    require(isinstance(job, dict), "Invalid fixture job")
    require(job.get("jobID") == operation["jobID"] and job.get("idempotencyKey") == operation["idempotencyKey"]
            and job.get("action") == "ai" and job.get("completed") is completed, "Operation/job identity mismatch")
    require(operation.get("state") == ("terminal" if completed else "accepted" if action == "submit" else "observing"),
            "Durable operation state mismatch")
    require(operation.get("backendStatus") == ("completed" if completed else "queued" if action == "submit" else "pending"),
            "Backend state mismatch")
    require(raw.get("authoritativeFixtureResultMatched") is completed, "Authoritative result was not retrieved")
    require(raw.get("presentationStatus") == ("Response" if completed else "Pending — not completed"), "Untruthful presentation")
    restored = raw.get("startupRestoredOperationIDs")
    require(restored == ([] if action == "submit" else [operation["operationID"]]), "Startup did not restore the accepted operation")
    events = fixture.get("events")
    require(isinstance(events, list) and all(isinstance(event, dict) and isinstance(event.get("kind"), str)
                                           for event in events), "Missing fixture events")
    require(sum(event.get("kind") == "accepted" for event in events) == 1, "Duplicate acceptance event")
    require(sum(event.get("kind") == "completed" for event in events) == int(completed), "Duplicate completion event")
    require(any(event.get("kind") == "startup" and event.get("processID") == expected_pid for event in events),
            "Missing host startup event")
    require(not any(event.get("kind", "").startswith("intent") for event in events), "Unexpected intent invocation evidence")
    # Allowlist projection avoids copying arbitrary app JSON or private values into artifacts.
    return {"action": action, "status": "PASS", "revision": revision, "processID": expected_pid,
            "configuration": "HardwareValidation", "platform": "iOS Simulator",
            "operation": {key: operation[key] for key in ("operationID", "jobID", "idempotencyKey", "state", "backendStatus")},
            "counts": counts, "acceptedEvents": 1, "completedEvents": int(completed),
            "authoritativeFixtureResultMatched": completed, "startupRestoredOperationIDs": restored,
            "fixtureOriginSelected": True, "productionPreferencesIgnored": True,
            "systemKeychainProbe": "PASS — Simulator only; synthetic namespace"}


def validate_sequence(stages, terminations):
    require([stage["action"] for stage in stages] == list(ACTIONS), "Incomplete lifecycle sequence")
    require(len(terminations) == len(ACTIONS) - 1 and all(item.get("status") == "PASS" for item in terminations),
            "App process termination not observed between stages")
    first = stages[0]["operation"]
    for index, stage in enumerate(stages):
        require(all(stage["operation"][key] == first[key] for key in ("operationID", "jobID", "idempotencyKey")),
                "Relaunch replaced the original operation/job/idempotency context")
        if index:
            require(stage["processID"] != stages[index - 1]["processID"], "Relaunch reused the previous process evidence")
            require(terminations[index - 1].get("processID") == stages[index - 1]["processID"], "Wrong process was terminated")
            require(stage["counts"]["resultAttempts"] > stages[index - 1]["counts"]["resultAttempts"],
                    "Relaunch did not retrieve authoritative fixture status")
    return {"status": "PASS", "scope": SCOPE, "operationID": first["operationID"], "jobID": first["jobID"],
            "interceptedSubmissionAttempts": 1, "semanticFixtureExecutions": 1, "httpRequests": 0,
            "sameOperationRestored": True, "sameJobRestored": True, "authoritativeFixtureResultRetrieved": True,
            "lifecycle": "simctl termination of verified host-app PID, observed exit, new host PID; repeated foreground restoration"}


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
    parser.add_argument("--runtime-version", default="26.2")
    parser.add_argument("--device-type", default="com.apple.CoreSimulator.SimDeviceType.iPhone-16")
    args = parser.parse_args()
    require(bool(re.fullmatch(r"[0-9a-f]{40}", args.revision)), "A full lowercase Git SHA is required")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "arcanos-phase3c-simulator-proof/v1", "capturedAt": datetime.now(timezone.utc).isoformat(),
              "revision": args.revision, "status": "NOT RUN", "scope": SCOPE, "checks": [], "stages": [],
              "terminations": [], "runtimeRequested": args.runtime_version, "deviceType": args.device_type,
              "physicalDevice": "NOT RUN", "appIntentInvocation": "NOT RUN", "liveServices": "NOT RUN"}
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "DEVELOPER_DIR") if key in os.environ}
    environment.update({"LC_ALL": "C", "LANG": "C", "PYTHONDONTWRITEBYTECODE": "1"})
    simulator = None

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
        for action in ACTIONS:
            launched = execute("launch-" + action, ["xcrun", "simctl", "launch", simulator, BUNDLE,
                               "--phase3c-simulator-action", action, "--phase3c-simulator-run-id", run_id])
            match = re.fullmatch(re.escape(BUNDLE) + r": (\d+)\s*", launched)
            require(match is not None, "Cannot identify installed host-app process")
            pid = int(match.group(1))
            proof_path = container / "Library/Application Support/ArcanosHardwareValidation-v1" / ("simulator-proof-" + run_id + "-" + action + ".json")
            wait_until(lambda: proof_path.is_file(), 90)
            require(proof_path.stat().st_size < 262_144, "Stage proof exceeds the bounded artifact limit")
            stage = validate_stage(json.loads(proof_path.read_text(encoding="utf-8")), action=action, run_id=run_id,
                                   revision=args.revision, expected_pid=pid)
            report["stages"].append(stage)
            if action != ACTIONS[-1]:
                execute("terminate-" + action, ["xcrun", "simctl", "terminate", simulator, BUNDLE])
                wait_until(lambda: process_exited(pid), 30)
                report["terminations"].append({"status": "PASS", "processID": pid, "action": action,
                                               "observation": "simctl terminate succeeded; host PID no longer exists"})
        report["proof"] = validate_sequence(report["stages"], report["terminations"])
        report["status"] = "PASS"
        return 0
    except ValidationFailure as error:
        report.update(status="FAIL", failure=str(error))
        return 1
    except (ValueError, OSError, KeyError, TypeError):
        report.update(status="FAIL", failure="Simulator preflight, execution or proof validation failed; no success inferred")
        return 1
    finally:
        if simulator and valid_uuid(simulator):
            try:
                execute("shutdown-owned-simulator", ["xcrun", "simctl", "shutdown", simulator])
            except ValidationFailure:
                report["shutdown"] = "FAIL — owned Simulator retained for operator inspection"
        report["cleanup"] = "No Simulator deletion, erasure or artifact removal. Dedicated Simulator and app data retained on persistent hosts."
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "report": str(output / "report.json"), "scope": SCOPE}, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
