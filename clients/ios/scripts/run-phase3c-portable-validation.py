#!/usr/bin/env python3
"""Record portable Phase 3C Swift evidence without inheriting service credentials.

This runner builds the Swift package and runs injected/loopback fixtures only.
It does not build an iOS target, invoke Siri, or exercise physical hardware.
Prefer a native Linux/macOS checkout. A Windows worktree mounted in WSL is
supported with --host-git pointing to the Windows git.exe for accurate LFS status.
Output and build scratch directories are new per label and are never deleted.
"""
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
import time

parser = argparse.ArgumentParser()
parser.add_argument("--label", required=True)
parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[3])
parser.add_argument("--swift", type=Path, help="Path to swift; defaults to the executable on PATH")
parser.add_argument("--swift-library-path", type=Path, help="Optional isolated Linux toolchain dependency directory")
parser.add_argument("--scratch-root", type=Path, default=Path.home() / ".cache/arcanos-phase3c")
parser.add_argument("--output", type=Path, help="Evidence parent directory; the label becomes its new child")
parser.add_argument("--host-git", type=Path, help="Optional Windows git.exe path for a WSL-mounted Windows worktree")
parser.add_argument("--skip-existing-proofs", action="store_true",
                    help="Use only after unchanged existing recovery sources have passing baseline evidence")
args = parser.parse_args()
if not args.label.replace("-", "").isalnum():
    raise SystemExit("Invalid evidence label")
repository = args.repository.resolve(strict=True)
# Swift dispatches by argv[0]; resolving its symlink changes the name to
# swift-driver, which rejects an otherwise valid `swift --version` invocation.
swift = (args.swift or Path(shutil.which("swift") or "swift")).expanduser().absolute()
if not swift.is_file() or not (repository / "clients/ios/ArcanosKit/Package.swift").is_file():
    raise SystemExit("Swift executable or repository package unavailable")
swiftbin = swift.parent
date = datetime.now(timezone.utc).date().isoformat()
output_parent = (args.output or repository / "docs/audits/ios-phase3c" / date).resolve()
output_parent.mkdir(parents=True, exist_ok=True)
output = output_parent / args.label
output.mkdir(exist_ok=False)
scratch_root = args.scratch_root.resolve()
scratch_root.mkdir(parents=True, exist_ok=True)
scratch = scratch_root / args.label
scratch.mkdir(exist_ok=False)
environment = {
    "HOME": str(Path.home()), "PATH": os.pathsep.join([str(swiftbin), os.defpath]),
    "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
    "PYTHONDONTWRITEBYTECODE": "1", "GIT_OPTIONAL_LOCKS": "0",
}
if args.swift_library_path:
    environment["LD_LIBRARY_PATH"] = str(args.swift_library_path.resolve(strict=True))

def mapped_git_path(value, relative_to):
    # Git markers written by Windows refer to drive-qualified paths. Mapping is
    # process-local; repository configuration and the .git marker stay unchanged.
    if os.name == "posix" and re.match(r"^[A-Za-z]:[/\\]", value):
        return Path("/mnt") / value[0].lower() / value[3:].replace("\\", "/")
    path = Path(value)
    return path if path.is_absolute() else relative_to / path

marker = repository / ".git"
if marker.is_file():
    text = marker.read_text().strip()
    if not text.startswith("gitdir: "):
        raise SystemExit("Unrecognized worktree Git marker")
    git_dir = mapped_git_path(text[len("gitdir: "):], repository).resolve(strict=True)
    environment["GIT_DIR"] = str(git_dir)
    environment["GIT_WORK_TREE"] = str(repository)
    common_marker = git_dir / "commondir"
    if common_marker.exists():
        environment["GIT_COMMON_DIR"] = str(mapped_git_path(common_marker.read_text().strip(), git_dir).resolve(strict=True))
    if os.name == "posix" and re.match(r"^gitdir: [A-Za-z]:[/\\]", text):
        environment.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.autocrlf", GIT_CONFIG_VALUE_0="true")

def capture(command):
    return subprocess.check_output(command, cwd=repository, env=environment, text=True).strip()

def working_tree():
    if not args.host_git:
        return capture(["git", "status", "--short"])
    host_environment = {key: value for key, value in environment.items() if not key.startswith("GIT_")}
    host_git = args.host_git.resolve(strict=True)
    host_environment["PATH"] = os.pathsep.join([str(host_git.parent), os.defpath])
    repo_text = str(repository)
    match = re.match(r"^/mnt/([a-z])/(.*)$", repo_text)
    host_repository = f"{match[1].upper()}:/{match[2]}" if match else repo_text
    return subprocess.check_output([
        str(host_git), "-C", host_repository, "status", "--short"
    ], cwd=repository, env=host_environment, text=True, timeout=30).strip()

def hashes():
    return {str(p.relative_to(repository)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((repository / "clients/ios").rglob("*"))
            if p.is_file() and p.suffix in [".swift", ".py", ".yml", ".plist", ".entitlements", ".pbxproj", ".xcscheme", ".xcconfig", ".xcprivacy"]
            and not any(part in [".build", "validation"] for part in p.parts)}

summary = {"version": "phase3c-portable-evidence/v1", "label": args.label,
    "sourceSha": capture(["git", "rev-parse", "HEAD"]),
    "initialWorkingTree": working_tree(), "workingTreeSource": "explicit host Git" if args.host_git else "native Git",
    "platform": f"{platform.system()} {platform.release()} {platform.machine()}", "configuration": ["debug", "release"],
    "scope": "Swift package, injected transports, file persistence, controlled loopback process proofs",
    "credentialEnvironment": "explicit allowlist; no developer credential environment",
    "sourceFilesSHA256": hashes(), "scratchPath": str(scratch), "checks": [],
    "realComponents": ["shipping session and recovery composition", "Swift package", "local filesystem", "loopback HTTP"],
    "fixtureComponents": ["credential storage", "model responses", "Gateway responses", "capability execution"],
    "appleSDKBuild": "NOT RUN: this runner builds only the Swift package, not the iOS target",
    "simulatorRuntime": "NOT RUN: no app or Simulator launch by this runner",
    "physicalKeychain": "NOT RUN: no physical device interaction by this runner",
    "physicalFoundationModels": "NOT RUN: no physical device interaction by this runner",
    "physicalAppIntents": "NOT RUN: no physical device interaction by this runner",
    "physicalRecovery": "NOT RUN: no physical device interaction by this runner",
    "liveServices": "NOT RUN: explicitly unauthorized"}

def persist():
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

def run(name, command, expected=0):
    print(f"START {name}", flush=True)
    before = hashes()
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=repository, env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
        log_text = result.stdout.decode(errors="replace")
    except subprocess.TimeoutExpired as error:
        log_text = (error.output or b"").decode(errors="replace") + "\nObservation timed out; outcome unverified.\n"
        result = subprocess.CompletedProcess(command, 124)
    log_path = output / f"{name}.log"
    # Existing Swift Testing parameter descriptions include deliberately synthetic
    # malformed credentials. Keep even those values out of shared audit artifacts.
    log_text, redactions = re.subn(r"\b(?:agd1|agp1)\.[A-Za-z0-9_-]+", "[REDACTED_SYNTHETIC_CREDENTIAL]", log_text)
    log_text, bearer_redactions = re.subn(r"Bearer\s+[A-Za-z0-9_.-]+", "Bearer [REDACTED]", log_text)
    log_text, challenge_redactions = re.subn(r'(confirmation_token[\"\s:]+)[\"]([^\"]*)[\"]', r'\1"[REDACTED]"', log_text)
    log_path.write_text(log_text)
    after = hashes()
    changed = [name for name in set(before) | set(after) if before.get(name) != after.get(name)]
    summary["checks"].append({"name": name, "command": command, "exitCode": result.returncode,
        "expectedExitCode": expected, "seconds": round(time.monotonic() - started, 2),
        "status": "PASS" if result.returncode == expected else "FAIL",
        "syntheticCredentialValuesRedacted": redactions + bearer_redactions + challenge_redactions,
        "sourceChangesDuringCheck": sorted(changed)})
    persist()
    print(f"END {name}: exit {result.returncode}; expected {expected}", flush=True)
    if result.returncode != expected:
        raise SystemExit(f"Validation stopped: {name}")

persist()
base = ["--package-path", "clients/ios/ArcanosKit", "--scratch-path", str(scratch)]
run("swift-version", [str(swift), "--version"])
run("python-version", [sys.executable, "--version"])
run("swift-debug-build", ["swift", "build", *base])
run("swift-tests", ["swift", "test", *base])
run("swift-release-build", ["swift", "build", "-c", "release", *base])
binpath = capture(["swift", "build", "-c", "release", *base, "--show-bin-path"])
summary["releaseBinaryDirectory"] = binpath
shipping = [sys.executable, "clients/ios/scripts/run-shipping-recovery-e2e.py", "--swift-binary", f"{binpath}/ArcanosShippingRecoveryProof"]
core = [sys.executable, "clients/ios/scripts/run-operation-recovery-e2e.py", "--swift-binary", f"{binpath}/ArcanosRecoveryProof"]
if args.skip_existing_proofs:
    summary["existingRecoveryProofReplay"] = "NOT RUN: reuse baseline proof evidence only when those implementation/script sources remain unchanged"
else:
    run("shipping-proof", shipping)
    run("core-proof", core)
app_sources = [str(p) for p in sorted((repository / "clients/ios/ArcanosVoice/Sources").glob("*.swift"))]
run("app-syntax-parse", ["swiftc", "-frontend", "-parse", *app_sources])
run("hardware-app-syntax-parse", ["swiftc", "-frontend", "-parse", "-D", "DEBUG", "-D", "ARCANOS_HARDWARE_VALIDATION", *app_sources])
hardware_runtime = repository / "clients/ios/ArcanosVoice/Sources/HardwareValidationRuntime.swift"
hardware_transport = repository / "clients/ios/ArcanosKit/Sources/ArcanosHardwareValidation/HardwareFixtureTransport.swift"
if platform.system() == "Linux" and hardware_runtime.exists() and hardware_transport.exists():
    debugbin = capture(["swift", "build", *base, "--show-bin-path"])
    # Extract the actual value type ahead of the SwiftUI view; no model behavior
    # is invented. This permits checking the real composition on a non-Apple host.
    voice_source = (repository / "clients/ios/ArcanosVoice/Sources/VoiceSnippet.swift").read_text()
    boundary = "/// A system result surface"
    if voice_source.count(boundary) != 1 or "struct VoicePresentation: Sendable" not in voice_source:
        raise SystemExit("VoicePresentation extraction boundary changed")
    presentation = scratch / "VoicePresentationWithoutSwiftUI.swift"
    presentation.write_text(voice_source.split(boundary)[0].replace("import SwiftUI\n", ""))
    app_runtime = repository / "clients/ios/ArcanosVoice/Sources/AppRuntime.swift"
    run("app-runtime-linux-typecheck", ["swiftc", "-typecheck", "-swift-version", "6",
        "-D", "DEBUG", "-I", f"{debugbin}/Modules", str(presentation), str(app_runtime)])
    run("hardware-runtime-linux-typecheck", ["swiftc", "-typecheck", "-swift-version", "6",
        "-D", "DEBUG", "-D", "ARCANOS_HARDWARE_VALIDATION", "-I", f"{debugbin}/Modules",
        str(hardware_transport), str(hardware_runtime), str(presentation), str(app_runtime)])
    summary["hardwareRuntimeTypecheckScope"] = "Linux Swift6 typecheck of real AppRuntime/HardwareValidationRuntime against real ArcanosKit and VoicePresentation value type extracted verbatim before its SwiftUI view. Apple FoundationModels, Security and CryptoKit conditional bodies unavailable. No SwiftUI/AppIntents resolution. Not an iOS SDK build or runtime test."
summary["finalSourceSha"] = capture(["git", "rev-parse", "HEAD"])
summary["finalWorkingTree"] = working_tree()
summary["finalSourceFilesSHA256"] = hashes()
summary["scratchCleanup"] = "NOT RUN: retained outside repository; no artifact deletion attempted"
persist()
print("PORTABLE CHECKS COMPLETE; APPLE/HARDWARE/LIVE EVIDENCE NOT ESTABLISHED", flush=True)
