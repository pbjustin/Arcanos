#!/usr/bin/env python3
"""Inspect or build the actual iOS target locally. Never launches an app or contacts services."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys


def source_manifest(repository):
    suffixes = {".swift", ".pbxproj", ".xcscheme", ".xcprivacy", ".plist", ".entitlements", ".py", ".json", ".png"}
    manifest = {str(path.relative_to(repository)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((repository / "clients/ios").rglob("*"))
            if path.is_file() and path.suffix in suffixes and ".build" not in path.parts}
    for name in ("ios-phase3c.yml", "ios-hardware-distribution.yml"):
        path = repository / ".github/workflows" / name
        if path.is_file():
            manifest[str(path.relative_to(repository)).replace("\\", "/")] = hashlib.sha256(path.read_bytes()).hexdigest()
    return manifest


def verify_toolchain(xcode_output, sdk_output, expected_xcode=None, expected_sdk=None):
    """Fail instead of silently compiling out Foundation Models with an older SDK."""
    match = re.search(r"^Xcode ([0-9.]+)$", xcode_output, re.M)
    if not match or (expected_xcode and match[1] != expected_xcode):
        raise ValueError("Selected Xcode does not match the required version")
    if expected_sdk:
        for family in ("iphoneos", "iphonesimulator"):
            if not re.search(r"-sdk " + family + re.escape(expected_sdk) + r"(?:\s|$)", sdk_output):
                raise ValueError("Required iOS and Simulator SDK versions are unavailable")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="New local evidence directory; logs and DerivedData are retained, never cleaned automatically")
    parser.add_argument("--build", action="store_true",
                        help="Build unsigned Debug, Release and HardwareValidation for generic iOS Simulator; no app execution")
    parser.add_argument("--require-xcode-version", help="Exact Xcode version; cloud workflow deliberately pins this")
    parser.add_argument("--require-ios-sdk", help="Exact iOS/Simulator SDK version; never substitutes an older SDK")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    # Avoid inheriting provider/Gateway credentials or application startup settings.
    environment = {key: os.environ[key] for key in
                   ("PATH", "HOME", "TMPDIR", "DEVELOPER_DIR", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP")
                   if key in os.environ}
    environment.update({"LC_ALL": "C", "LANG": "C", "PYTHONDONTWRITEBYTECODE": "1"})
    report = {"schema": "arcanos-phase3c-apple-validation/v1",
              "capturedAt": datetime.now(timezone.utc).isoformat(),
              "platform": {"system": platform.system(), "version": platform.version(), "machine": platform.machine()},
              "buildRequested": args.build, "checks": [], "sourceFilesSHA256": source_manifest(repository),
              "boundaries": {"backendRequests": 0, "appLaunched": False,
                             "physicalIdentifiersCollected": False, "remoteWorkflowsTriggered": False}}

    def execute(name, command, timeout=30):
        started = datetime.now(timezone.utc)
        try:
            result = subprocess.run(command, cwd=repository, env=environment,
                                    capture_output=True, text=True, timeout=timeout)
            log = result.stdout + result.stderr
            code = result.returncode
        except subprocess.TimeoutExpired:
            log, code = "Bounded observation timed out; result not established.\n", 124
        except OSError:
            log, code = "Required local executable unavailable.\n", 127
        # Swift Testing prints parameter values, including deliberately synthetic
        # tokens. Retain outcomes without publishing even those credential values.
        log, redactions = re.subn(r"\b(?:agd1|agp1)\.[A-Za-z0-9_-]+", "[REDACTED_SYNTHETIC_CREDENTIAL]", log)
        log, bearer_redactions = re.subn(r"Bearer\s+[A-Za-z0-9_.-]+", "Bearer [REDACTED]", log)
        log, challenge_redactions = re.subn(r'(confirmation_token[\"\s:]+)[\"]([^\"]*)[\"]', r'\1"[REDACTED]"', log)
        (output / (name + ".log")).write_text(log, encoding="utf-8")
        report["checks"].append({"name": name, "command": command,
                                 "status": "PASS" if code == 0 else "FAIL",
                                 "exitCode": code, "startedAt": started.isoformat(),
                                 "redactions": redactions + bearer_redactions + challenge_redactions,
                                 "log": name + ".log"})
        return code, log

    def save():
        report["finalSourceFilesSHA256"] = source_manifest(repository)
        report["sourceUnchangedDuringCheck"] = report["sourceFilesSHA256"] == report["finalSourceFilesSHA256"]
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"report": str(output / "report.json"), "evidenceLevels": report["evidenceLevels"]}, indent=2))

    code, revision = execute("revision", ["git", "rev-parse", "HEAD"])
    report["sourceSha"] = revision.strip() if code == 0 else "UNRECORDED"
    _, status = execute("working-tree", ["git", "status", "--short"])
    report["uncommittedChanges"] = status.splitlines()
    report["evidenceLevels"] = {
        "A": {"status": "NOT RUN", "dependency": "Invoke --build on a Mac with Xcode selected"},
        "B": {"status": "NOT RUN", "dependency": "Manual isolated Simulator execution and runtime observations"},
        "C": {"status": "BLOCKED", "dependency": "Authorized physical iPhone, signing and actual system Keychain observations"},
        "D": {"status": "BLOCKED", "dependency": "Supported iPhone with ready Foundation Models and actual inference observations"},
        "E": {"status": "BLOCKED", "dependency": "Actual physical activation/dictation/intent/confirmation/speech observations"},
        "F": {"status": "BLOCKED", "dependency": "Real installed app and physical process lifecycle using isolated fixtures"},
        "G": {"status": "NOT RUN", "dependency": "Live-service validation requires separate authorization"}}
    checker = repository / "clients/ios/scripts/validate-hardware-configuration.py"
    static_code, _ = execute("hardware-configuration", [sys.executable, "-B", str(checker)])
    if static_code != 0:
        report["evidenceLevels"]["A"] = {"status": "BLOCKED", "dependency": "Hardware configuration preflight failed"}
        save()
        return 1
    if platform.system() != "Darwin" or not shutil.which("xcodebuild") or not shutil.which("xcrun"):
        report["appleToolchain"] = {"swift": "Not an Apple SDK compiler on this host", "xcode": "Unavailable",
                                   "iOSSDKs": [], "simulatorRuntimes": []}
        report["evidenceLevels"]["A"] = {"status": "BLOCKED", "dependency": "No local Mac/Xcode/iOS SDK"}
        report["evidenceLevels"]["B"] = {"status": "BLOCKED", "dependency": "No local Apple Simulator runtime"}
        save()
        return 2 if args.build else 0

    inspection = [("xcode-version", ["xcodebuild", "-version"]),
                  ("swift-version", ["xcrun", "swift", "--version"]),
                  ("ios-sdks", ["xcodebuild", "-showsdks"]),
                  ("simulator-runtimes", ["xcrun", "simctl", "list", "runtimes", "--json"])]
    for name, command in inspection:
        code, log = execute(name, command)
        if code != 0:
            report["evidenceLevels"]["A"] = {"status": "BLOCKED", "dependency": "Apple toolchain inspection failed: " + name}
            save()
            return 1
        if name == "simulator-runtimes":
            report["simulatorRuntimes"] = [{key: runtime.get(key) for key in ("name", "version", "buildversion", "isAvailable")}
                                          for runtime in json.loads(log).get("runtimes", [])]
        else:
            report[name] = log.strip()
    try:
        verify_toolchain(report["xcode-version"], report["ios-sdks"], args.require_xcode_version, args.require_ios_sdk)
    except ValueError as error:
        report["evidenceLevels"]["A"] = {"status": "BLOCKED", "dependency": str(error)}
        save()
        return 2
    if not args.build:
        save()
        return 0

    code, _ = execute("apple-swift-package-tests", ["xcrun", "swift", "test", "--package-path", "clients/ios/ArcanosKit",
                       "--scratch-path", str(output / "SwiftPackageBuild")], timeout=600)
    if code != 0:
        report["evidenceLevels"]["A"] = {"status": "FAIL", "dependency": "Apple Swift package tests failed before app builds"}
        save()
        return 1

    project = "clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj"
    for name, command in (
        ("project-inventory", ["xcodebuild", "-list", "-json", "-project", project]),
        ("local-package-resolution", ["xcodebuild", "-resolvePackageDependencies", "-project", project,
                                      "-scheme", "ArcanosVoice-HardwareValidation", "-skipPackageUpdates",
                                      "-disableAutomaticPackageResolution"]),
    ):
        code, _ = execute(name, command, timeout=120)
        if code != 0:
            report["evidenceLevels"]["A"] = {"status": "FAIL", "dependency": "Xcode project/package check failed: " + name}
            save()
            return 1
    # Only local package dependencies exist; disable automatic package updates.
    for configuration in ("Debug", "Release", "HardwareValidation"):
        scheme = "ArcanosVoice-HardwareValidation" if configuration == "HardwareValidation" else "ArcanosVoice"
        derived = output / ("DerivedData-" + configuration)
        command = ["xcodebuild", "-project", project, "-scheme", scheme, "-configuration", configuration,
                   "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
                   "-derivedDataPath", str(derived), "-skipPackageUpdates", "-disableAutomaticPackageResolution",
                   "CODE_SIGNING_ALLOWED=NO", "ARCANOS_VALIDATION_REVISION=" + report["sourceSha"], "build"]
        code, _ = execute("build-" + configuration, command, timeout=900)
        if code != 0:
            report["evidenceLevels"]["A"] = {"status": "FAIL", "dependency": "Build failed or timed out: " + configuration}
            save()
            return 1
        app = derived / "Build/Products" / (configuration + "-iphonesimulator") / "ArcanosVoice.app"
        code, _ = execute("packaging-" + configuration,
                          [sys.executable, "-B", str(checker), "--built-app", str(app), "--configuration", configuration])
        if code != 0:
            report["evidenceLevels"]["A"] = {"status": "FAIL", "dependency": "Built-app isolation check failed: " + configuration}
            save()
            return 1
    if source_manifest(repository) != report["sourceFilesSHA256"]:
        report["evidenceLevels"]["A"] = {"status": "FAIL", "dependency": "Source changed during builds"}
        save()
        return 1
    report["evidenceLevels"]["A"] = {"status": "PASS", "scope": "Unsigned Simulator SDK builds and packaging for Debug/Release/HardwareValidation only"}
    save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
