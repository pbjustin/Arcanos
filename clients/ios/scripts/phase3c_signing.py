#!/usr/bin/env python3
"""Provider-neutral, isolated Phase 3C archive/export and explicitly gated upload.

Only report.json is publishable. Products, profiles, keys and raw tool output are
private to a disposable macOS runner. No application or backend is launched.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import uuid
import zipfile

BUNDLE = "org.arcanos.voice.hardware-validation"
SCHEME = "ArcanosVoice-HardwareValidation"
CONFIGURATION = "HardwareValidation"
SIGNING_SECRETS = ("IOS_SIGNING_P12_BASE64", "IOS_SIGNING_P12_PASSWORD",
                   "IOS_PROVISIONING_PROFILE_BASE64", "IOS_TEAM_ID")
UPLOAD_SECRETS = ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY_BASE64")
PUBLIC_ARTIFACTS = ("report.json",)


class GateError(Exception):
    """A fixed, sanitized failure category, never raw command output."""


def require(condition, category):
    if not condition:
        raise GateError(category)


def clean_environment(source):
    environment = {key: source[key] for key in
                   ("PATH", "HOME", "TMPDIR", "DEVELOPER_DIR", "SystemRoot", "TEMP", "TMP") if key in source}
    environment.update({"LANG": "C", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"})
    return environment


def validate_revision(expected, actual, dirty):
    require(bool(re.fullmatch(r"[0-9a-f]{40}", expected)), "invalid-expected-revision")
    require(actual == expected, "checkout-revision-mismatch")
    require(not dirty, "uncommitted-source-cannot-be-signed")


def validate_dispatch(mode, authorized, environment):
    require(mode != "upload" or authorized, "upload-not-explicitly-authorized")
    # Provider-neutral callers supply their own reviewed approval controls. GitHub
    # callers must additionally satisfy the trusted workflow event/ref boundary.
    if environment.get("GITHUB_ACTIONS") == "true":
        require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
                and environment.get("GITHUB_REF") == "refs/heads/main"
                and environment.get("GITHUB_REF_PROTECTED") == "true",
                "signing-requires-protected-main-dispatch")
        require(environment.get("RUNNER_ENVIRONMENT") == "github-hosted", "disposable-github-runner-required")
    require(environment.get("ARCANOS_EPHEMERAL_SIGNING_RUNNER") == "1", "disposable-runner-guarantee-required")


def validate_profile(profile, team, now=None):
    now = now or datetime.now(timezone.utc)
    require(bool(re.fullmatch(r"[A-Z0-9]{10}", team)), "invalid-team-configuration")
    require(profile.get("TeamIdentifier") == [team], "profile-team-mismatch")
    prefix = profile.get("ApplicationIdentifierPrefix", [])
    require(len(prefix) == 1 and bool(re.fullmatch(r"[A-Z0-9]{10}", prefix[0])), "invalid-profile-app-prefix")
    entitlements = profile.get("Entitlements", {})
    require(entitlements.get("application-identifier") == prefix[0] + "." + BUNDLE,
            "profile-is-not-exact-hardware-app")
    require(entitlements.get("com.apple.developer.team-identifier") == team, "profile-entitlement-team-mismatch")
    require(entitlements.get("get-task-allow") is False and not profile.get("ProvisionedDevices")
            and not profile.get("ProvisionsAllDevices"), "app-store-distribution-profile-required")
    require(entitlements.get("beta-reports-active") is True, "testflight-profile-required")
    require(not any(key in entitlements for key in
                    ("aps-environment", "com.apple.security.application-groups", "com.apple.developer.associated-domains")),
            "unexpected-profile-capability")
    expiry = profile.get("ExpirationDate")
    require(isinstance(expiry, datetime), "missing-profile-expiry")
    require(expiry.replace(tzinfo=timezone.utc) > now, "expired-profile")
    identifier = profile.get("UUID", "")
    require(bool(re.fullmatch(r"[A-Fa-f0-9-]{36}", identifier)) and str(uuid.UUID(identifier)).lower() == identifier.lower(),
            "invalid-profile-identifier")
    require(bool(profile.get("DeveloperCertificates")), "profile-certificate-missing")
    return identifier


def matching_identity(identities, profile):
    candidates = set(re.findall(r'\b([A-Fa-f0-9]{40})\s+"Apple Distribution[^"\n]*"', identities))
    profile_hashes = {hashlib.sha1(value).hexdigest().upper() for value in profile["DeveloperCertificates"]}
    matches = {value.upper() for value in candidates} & profile_hashes
    require(len(matches) == 1, "matching-distribution-identity-required")
    return next(iter(matches))


def validate_embedded_profile(embedded, original, team):
    require(validate_profile(embedded, team) == original["UUID"], "embedded-profile-identifier-mismatch")
    require(embedded["DeveloperCertificates"] == original["DeveloperCertificates"], "embedded-profile-certificate-mismatch")
    require(embedded["Entitlements"] == original["Entitlements"], "embedded-profile-entitlements-mismatch")


def export_options(team, profile_id, identity):
    return {"method": "app-store-connect", "destination": "export", "signingStyle": "manual",
            "teamID": team, "signingCertificate": identity, "provisioningProfiles": {BUNDLE: profile_id},
            "manageAppVersionAndBuildNumber": False, "uploadSymbols": False,
            "stripSwiftSymbols": True, "testFlightInternalTestingOnly": True}


def validate_info(info, sha, build_number, for_upload=False):
    require(info.get("CFBundleIdentifier") == BUNDLE, "signed-bundle-mismatch")
    require(info.get("ArcanosValidationRevision") == sha, "signed-revision-mismatch")
    require(info.get("CFBundleVersion") == build_number, "signed-build-number-mismatch")
    require(info.get("MinimumOSVersion") == "18.0", "signed-deployment-target-mismatch")
    if for_upload:
        icons = info.get("CFBundleIcons", {}).get("CFBundlePrimaryIcon", {})
        require(bool(icons.get("CFBundleIconName")), "testflight-app-icon-setup-required")
        require(isinstance(info.get("ITSAppUsesNonExemptEncryption"), bool), "reviewed-export-compliance-setting-required")


def validate_entitlements(entitlements, profile):
    permitted = {"application-identifier", "com.apple.developer.team-identifier", "keychain-access-groups",
                 "get-task-allow", "beta-reports-active"}
    require(set(entitlements) <= permitted, "unexpected-signed-entitlement")
    require(entitlements.get("get-task-allow", False) is False, "debug-entitlement-in-distribution")
    for key in ("application-identifier", "com.apple.developer.team-identifier"):
        require(entitlements.get(key) == profile["Entitlements"][key], "signed-entitlement-partition-mismatch")
    groups = entitlements.get("keychain-access-groups", [])
    require(not groups or groups == [profile["Entitlements"]["application-identifier"]], "unexpected-keychain-sharing")


def extract_ipa(ipa, target):
    target.mkdir(exist_ok=False)
    with zipfile.ZipFile(ipa) as archive:
        for member in archive.infolist():
            relative = Path(member.filename)
            require(not member.filename.startswith("/") and not relative.is_absolute()
                    and ".." not in relative.parts and "\\" not in member.filename
                    and ":" not in member.filename,
                    "unsafe-exported-archive-path")
            require((member.external_attr >> 16) & 0o170000 != 0o120000, "exported-symlink-not-supported")
            require(relative.suffix.lower() not in {".p8", ".p12", ".key", ".keychain", ".keychain-db"},
                    "private-key-in-exported-product")
        archive.extractall(target)
        # zipfile does not preserve executable bits. Restore only ordinary
        # permission bits for signature inspection, never setuid/setgid/sticky.
        for member in archive.infolist():
            mode = (member.external_attr >> 16) & 0o777
            if mode:
                (target / member.filename).chmod(mode)
    apps = list((target / "Payload").glob("*.app"))
    require(len(apps) == 1, "single-exported-app-required")
    return apps[0]


def private_file(path, contents):
    # Exclusive creation never overwrites a provider's or operator's existing file.
    with path.open("xb") as stream:
        stream.write(contents)
    path.chmod(0o600)


def decode_secret(value):
    try:
        result = base64.b64decode(value, validate=True)
        require(bool(result), "empty-signing-material")
        return result
    except (ValueError, TypeError):
        raise GateError("invalid-base64-signing-material") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("archive", "upload"), default="archive")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--build-number", required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="New sanitized metadata directory")
    parser.add_argument("--authorize-upload", action="store_true", help="Separate publication authorization is required")
    args = parser.parse_args(argv)
    repository = Path(__file__).resolve().parents[3]
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    environment = clean_environment(os.environ)
    report = {"schema": "arcanos-phase3c-signing/v1", "capturedAt": datetime.now(timezone.utc).isoformat(),
              "sourceSha": args.expected_sha if re.fullmatch(r"[0-9a-f]{40}", args.expected_sha) else None,
              "scheme": SCHEME, "configuration": CONFIGURATION, "bundleIdentifier": BUNDLE,
              "mode": args.mode, "signing": {"status": "NOT RUN", "label": "SIGNING NOT RUN"},
              "testFlightUpload": {"status": "NOT RUN"}, "physicalDevice": "NOT RUN", "liveArcanos": "NOT RUN",
              "checks": [], "publishableArtifacts": list(PUBLIC_ARTIFACTS),
              "secretCleanup": "Disposable VM destruction required; no persistent/self-hosted signing supported",
              "boundaries": {"appLaunched": False, "arcanosTransport": "fixture-only",
                             "rawToolOutputPublished": False, "signedProductsPublishedAsArtifacts": False}}

    def run(name, command, timeout=180, cwd=repository):
        # Do not serialize commands or output: security and Apple tools may expose
        # subject names, profile IDs, account data or key material even on failure.
        try:
            result = subprocess.run(command, cwd=cwd, env=environment, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            report["checks"].append({"name": name, "status": "FAIL", "category": "timeout"})
            raise GateError(name + "-timeout") from None
        report["checks"].append({"name": name, "status": "PASS" if result.returncode == 0 else "FAIL",
                                 "exitCode": result.returncode})
        require(result.returncode == 0, name + "-failed")
        return result.stdout, result.stderr

    exit_code = 0
    signing_started = False
    try:
        require(bool(re.fullmatch(r"[1-9][0-9]{0,3}(?:\.[0-9]{1,2}){0,2}", args.build_number)), "invalid-build-number")
        require(args.mode != "upload" or args.authorize_upload, "upload-not-explicitly-authorized")
        missing = [key for key in SIGNING_SECRETS if not os.environ.get(key)]
        if missing:
            report["signing"]["dependency"] = "Protected CI signing secrets are not configured"
            report["signing"]["missingSecretNames"] = missing
            return 0
        require(platform.system() == "Darwin" and shutil.which("xcodebuild") and shutil.which("xcrun"),
                "macos-xcode-required")
        validate_dispatch(args.mode, args.authorize_upload, os.environ)
        revision, _ = run("revision", ["git", "rev-parse", "HEAD"])
        status, _ = run("working-tree", ["git", "status", "--porcelain", "--untracked-files=all"])
        validate_revision(args.expected_sha, revision.decode().strip(), bool(status.strip()))
        run("hardware-isolation", [sys.executable, "-B", "clients/ios/scripts/validate-hardware-configuration.py"])
        if args.mode == "upload":
            require(all(os.environ.get(key) for key in UPLOAD_SECRETS), "protected-upload-secrets-required")
            require(bool(re.fullmatch(r"[A-Z0-9]{10}", os.environ["ASC_KEY_ID"])), "invalid-api-key-configuration")
            require(bool(re.fullmatch(r"[a-fA-F0-9-]{36}", os.environ["ASC_ISSUER_ID"])), "invalid-api-issuer-configuration")
            require(os.environ.get("IOS_USES_NON_EXEMPT_ENCRYPTION") in {"true", "false"},
                    "reviewed-export-compliance-setting-required")
        toolchain, _ = run("xcode-version", ["xcodebuild", "-version"])
        require(re.fullmatch(rb"Xcode [0-9.]+\s+Build version [A-Za-z0-9]+\s*", toolchain) is not None,
                "unexpected-xcode-version-output")
        report["xcode"] = toolchain.decode().strip()
        run("ios-sdk", ["xcodebuild", "-showsdks"])
        private = Path(os.environ.get("RUNNER_TEMP", os.environ.get("TMPDIR", "/tmp"))) / ("arcanos-signing-" + uuid.uuid4().hex)
        private.mkdir(mode=0o700, exist_ok=False)
        report["privateMaterialLocation"] = "Disposable runner temporary directory and its provisioning-profile store"
        certificate = private / "distribution.p12"
        profile_file = private / "distribution.mobileprovision"
        private_file(certificate, decode_secret(os.environ["IOS_SIGNING_P12_BASE64"]))
        profile_data = decode_secret(os.environ["IOS_PROVISIONING_PROFILE_BASE64"])
        private_file(profile_file, profile_data)
        decoded, _ = run("profile-decode", ["security", "cms", "-D", "-i", str(profile_file)])
        profile = plistlib.loads(decoded)
        profile_id = validate_profile(profile, os.environ["IOS_TEAM_ID"])
        # Current Xcode profile store, documented by Apple DTS (thread/812538).
        # Older ~/Library/MobileDevice storage is intentionally not used.
        profiles = Path(environment["HOME"]) / "Library/Developer/Xcode/UserData/Provisioning Profiles"
        profiles.mkdir(parents=True, exist_ok=True)
        private_file(profiles / (profile_id + ".mobileprovision"), profile_data)
        keychain = private / "distribution.keychain-db"
        password = secrets.token_urlsafe(32)
        run("keychain-create", ["security", "create-keychain", "-p", password, str(keychain)])
        run("keychain-unlock", ["security", "unlock-keychain", "-p", password, str(keychain)])
        run("certificate-import", ["security", "import", str(certificate), "-P", os.environ["IOS_SIGNING_P12_PASSWORD"],
                                   "-T", "/usr/bin/codesign", "-T", "/usr/bin/security", "-k", str(keychain)])
        run("keychain-partition", ["security", "set-key-partition-list", "-S", "apple-tool:,apple:",
                                   "-k", password, str(keychain)])
        identities, _ = run("identity-match", ["security", "find-identity", "-v", "-p", "codesigning", str(keychain)])
        identity = matching_identity(identities.decode(), profile)
        # Xcode export discovers manual signing identities through the search
        # list. This is changed only on a runner already guaranteed disposable.
        previous, _ = run("keychain-search-list", ["security", "list-keychains", "-d", "user"])
        existing_keychains = shlex.split(previous.decode())
        require(all(Path(value).is_absolute() for value in existing_keychains), "invalid-keychain-search-list")
        run("keychain-search-install", ["security", "list-keychains", "-d", "user", "-s", str(keychain)] + existing_keychains)
        project = "clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj"
        common = ["xcodebuild", "-project", project, "-scheme", SCHEME, "-configuration", CONFIGURATION,
                  "-destination", "generic/platform=iOS", "-derivedDataPath", str(private / "DerivedData"),
                  "-skipPackageUpdates", "-disableAutomaticPackageResolution"]
        run("package-resolution", common + ["-resolvePackageDependencies"], timeout=600)
        archive = private / "ArcanosHardware.xcarchive"
        compliance = os.environ.get("IOS_USES_NON_EXEMPT_ENCRYPTION")
        compliance_setting = (["INFOPLIST_KEY_ITSAppUsesNonExemptEncryption=" + ("YES" if compliance == "true" else "NO")]
                              if compliance in {"true", "false"} else [])
        signing_started = True
        run("archive", common + ["-archivePath", str(archive), "CODE_SIGN_STYLE=Manual",
                                 "DEVELOPMENT_TEAM=" + os.environ["IOS_TEAM_ID"], "CODE_SIGN_IDENTITY=" + identity,
                                 "PROVISIONING_PROFILE_SPECIFIER=" + profile_id,
                                 "OTHER_CODE_SIGN_FLAGS=--keychain " + str(keychain),
                                 "CURRENT_PROJECT_VERSION=" + args.build_number,
                                 "ARCANOS_VALIDATION_REVISION=" + args.expected_sha] + compliance_setting + ["archive"], timeout=1200)
        checker_path = repository / "clients/ios/scripts/validate-hardware-configuration.py"
        spec = importlib.util.spec_from_file_location("hardware_configuration", checker_path)
        checker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(checker)

        def inspect_app(app, name):
            checker.validate_app(app, CONFIGURATION)
            info = plistlib.loads((app / "Info.plist").read_bytes())
            validate_info(info, args.expected_sha, args.build_number, for_upload=args.mode == "upload")
            run(name + "-signature", ["codesign", "--verify", "--deep", "--strict", str(app)])
            stdout, stderr = run(name + "-entitlements", ["codesign", "-d", "--entitlements", ":-", str(app)])
            raw = stdout if b"<?xml" in stdout else stderr
            require(b"<?xml" in raw and b"</plist>" in raw, "signed-entitlements-missing")
            raw = raw[raw.index(b"<?xml"):raw.index(b"</plist>") + len(b"</plist>")]
            validate_entitlements(plistlib.loads(raw), profile)
            embedded, _ = run(name + "-profile", ["security", "cms", "-D", "-i", str(app / "embedded.mobileprovision")])
            validate_embedded_profile(plistlib.loads(embedded), profile, os.environ["IOS_TEAM_ID"])
            return info

        inspect_app(archive / "Products/Applications/ArcanosVoice.app", "archive")
        options = private / "ExportOptions.plist"
        private_file(options, plistlib.dumps(export_options(os.environ["IOS_TEAM_ID"], profile_id, identity)))
        exported = private / "export"
        run("export", ["xcodebuild", "-exportArchive", "-archivePath", str(archive),
                       "-exportOptionsPlist", str(options), "-exportPath", str(exported)], timeout=900)
        ipas = list(exported.glob("*.ipa"))
        require(len(ipas) == 1, "single-exported-ipa-required")
        app = extract_ipa(ipas[0], private / "export-inspection")
        info = inspect_app(app, "export")
        final_status, _ = run("final-working-tree", ["git", "status", "--porcelain", "--untracked-files=all"])
        require(not final_status.strip(), "source-changed-during-signing")
        report["signing"] = {"status": "PASS", "scope": "Local distribution signature, exact revision, isolated bundle and exported IPA checked",
                             "ipaSHA256": hashlib.sha256(ipas[0].read_bytes()).hexdigest(),
                             "buildNumber": args.build_number, "version": info.get("CFBundleShortVersionString")}
        if args.mode == "upload":
            key_dir = private / "private_keys"
            key_dir.mkdir(mode=0o700)
            private_file(key_dir / ("AuthKey_" + os.environ["ASC_KEY_ID"] + ".p8"), decode_secret(os.environ["ASC_PRIVATE_KEY_BASE64"]))
            report["testFlightUpload"] = {"status": "FAIL", "scope": "Upload requested; outcome is not established"}
            run("testflight-upload", ["xcrun", "iTMSTransporter", "-m", "upload", "-assetFile", str(ipas[0]),
                                      "-apiKey", os.environ["ASC_KEY_ID"], "-apiIssuer", os.environ["ASC_ISSUER_ID"],
                                      "-v", "off"], timeout=1200, cwd=private)
            report["testFlightUpload"] = {"status": "PASS", "scope": "Transporter accepted upload; processing, tester availability and physical behavior remain unverified"}
    except GateError as error:
        report["failureCategory"] = str(error)
        if report["signing"]["status"] != "PASS":
            report["signing"] = {"status": "FAIL" if signing_started else "BLOCKED", "label": "SIGNING NOT RUN" if not signing_started else "SIGNING FAILED"}
        exit_code = 1
    except (OSError, ValueError, KeyError, TypeError, AttributeError, plistlib.InvalidFileException, zipfile.BadZipFile):
        report["failureCategory"] = "private-tool-or-artifact-validation-failed"
        report["signing"]["status"] = "FAIL" if signing_started else "BLOCKED"
        exit_code = 1
    finally:
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"signing": report["signing"]["status"], "testFlightUpload": report["testFlightUpload"]["status"],
                          "report": "report.json"}))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
