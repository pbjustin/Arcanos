"""Offline signing-controller E2E fixtures; Apple commands never execute.

The real controller, artifact checks, IPA extraction and sanitized report writer
run against synthetic products. Passing these tests is not signing or upload proof.
"""
import base64
from contextlib import redirect_stdout
from datetime import datetime
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import phase3c_signing as signing


REVISION = "a" * 40
TEAM = "SYNTHETIC1"
BUILD_NUMBER = "12"
RAW_OUTPUT = b"synthetic-private-tool-diagnostic-never-publish"
SPEC = importlib.util.spec_from_file_location(
    "signing_e2e_hardware_configuration", Path(__file__).with_name("validate-hardware-configuration.py"))
HARDWARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARDWARE)


class SyntheticAppleTools:
    """A closed command dispatcher with real temporary plist/IPA products."""

    def __init__(self, root, failure=None):
        self.root = root
        self.failure = failure
        self.commands = []
        self.git_status_calls = 0
        self.archive = None
        self.profile = {
            "TeamIdentifier": [TEAM], "ApplicationIdentifierPrefix": [TEAM],
            "UUID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "ExpirationDate": datetime(2099, 1, 1),
            "DeveloperCertificates": [b"synthetic-public-certificate"],
            "Entitlements": {"application-identifier": TEAM + "." + signing.BUNDLE,
                             "com.apple.developer.team-identifier": TEAM,
                             "get-task-allow": False, "beta-reports-active": True}}
        self.identity = hashlib.sha1(self.profile["DeveloperCertificates"][0]).hexdigest().upper()
        self.environment = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(root / "home"),
            "RUNNER_TEMP": str(root / "private"),
            "GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main", "GITHUB_REF_PROTECTED": "true",
            "RUNNER_ENVIRONMENT": "github-hosted", "ARCANOS_EPHEMERAL_SIGNING_RUNNER": "1",
            "IOS_SIGNING_P12_BASE64": base64.b64encode(b"synthetic-p12").decode(),
            "IOS_SIGNING_P12_PASSWORD": "synthetic-p12-password",
            "IOS_PROVISIONING_PROFILE_BASE64": base64.b64encode(b"synthetic-profile").decode(),
            "IOS_TEAM_ID": TEAM, "ASC_KEY_ID": "SYNTHETIC2",
            "ASC_ISSUER_ID": "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
            "ASC_PRIVATE_KEY_BASE64": base64.b64encode(b"synthetic-upload-private-key").decode(),
            "IOS_USES_NON_EXEMPT_ENCRYPTION": "false",
            "OPENAI_API_KEY": "synthetic-provider-value", "ARCANOS_GATEWAY_ORIGIN": "https://unused.invalid"}
        (root / "home").mkdir()
        (root / "private").mkdir()

    def write_app(self, app):
        app.mkdir(parents=True)
        info = {"CFBundleIdentifier": signing.BUNDLE, "CFBundleExecutable": "ArcanosVoice",
                "CFBundleDisplayName": "ARCANOS Fixtures", "MinimumOSVersion": "18.0",
                "ArcanosValidationRevision": REVISION, "CFBundleVersion": BUILD_NUMBER,
                "CFBundleShortVersionString": "1.0", "ITSAppUsesNonExemptEncryption": False,
                "CFBundleIcons": {"CFBundlePrimaryIcon": {"CFBundleIconName": "ValidationAppIcon"}}}
        if self.failure == "archive-isolation":
            info["CFBundleIdentifier"] = "org.arcanos.voice"
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        (app / "PrivacyInfo.xcprivacy").write_bytes(plistlib.dumps({"NSPrivacyTracking": False}))
        (app / "ArcanosVoice").write_bytes(b"\xcf\xfa\xed\xfe" + b"\n".join(HARDWARE.MARKERS))
        (app / "embedded.mobileprovision").write_bytes(b"synthetic-embedded-profile")

    def run(self, command, *, cwd, env, capture_output, timeout):
        self.commands.append(command)
        assert capture_output is True and timeout > 0
        assert not (set(signing.SIGNING_SECRETS + signing.UPLOAD_SECRETS)
                    | {"OPENAI_API_KEY", "ARCANOS_GATEWAY_ORIGIN"}) & set(env)
        stdout = b""
        if command[:2] == ["git", "rev-parse"]:
            stdout = REVISION.encode()
        elif command[:2] == ["git", "status"]:
            self.git_status_calls += 1
            if self.failure == "source-drift" and self.git_status_calls == 2:
                stdout = b" M clients/ios/ArcanosVoice/Sources/AppRuntime.swift\n"
        elif "clients/ios/scripts/validate-hardware-configuration.py" in command:
            pass
        elif command == ["xcodebuild", "-version"]:
            stdout = b"Xcode 26.3\nBuild version 17C529\n"
        elif command == ["xcodebuild", "-showsdks"]:
            stdout = b"iOS 26.2 -sdk iphoneos26.2\n"
        elif command[:2] == ["security", "cms"]:
            profile = self.profile
            if self.failure == "export-profile" and "export-inspection" in command[-1]:
                profile = {**profile, "UUID": "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee"}
            stdout = plistlib.dumps(profile)
        elif command[:2] == ["security", "find-identity"]:
            stdout = f'1) {self.identity} "Apple Distribution: Synthetic"'.encode()
        elif command[:2] == ["security", "list-keychains"]:
            if "-s" not in command:
                stdout = json.dumps((self.root / "home/login.keychain-db").as_posix()).encode()
        elif command[0] == "security" and command[1] in {
                "create-keychain", "unlock-keychain", "import", "set-key-partition-list"}:
            pass
        elif command[0] == "xcodebuild" and "-resolvePackageDependencies" in command:
            assert "-disableAutomaticPackageResolution" in command
        elif command[0] == "xcodebuild" and command[-1] == "archive":
            assert "-allowProvisioningUpdates" not in command
            assert "ARCANOS_VALIDATION_REVISION=" + REVISION in command
            assert "CURRENT_PROJECT_VERSION=" + BUILD_NUMBER in command
            if self.failure == "archive-command":
                return subprocess.CompletedProcess(command, 1, RAW_OUTPUT, RAW_OUTPUT)
            self.archive = Path(command[command.index("-archivePath") + 1])
            self.write_app(self.archive / "Products/Applications/ArcanosVoice.app")
        elif command[:2] == ["codesign", "--verify"]:
            if self.failure == "export-signature" and "export-inspection" in command[-1]:
                return subprocess.CompletedProcess(command, 1, RAW_OUTPUT, RAW_OUTPUT)
        elif command[:2] == ["codesign", "-d"]:
            stdout = plistlib.dumps(self.profile["Entitlements"])
        elif command[:2] == ["xcodebuild", "-exportArchive"]:
            options = plistlib.loads(Path(command[command.index("-exportOptionsPlist") + 1]).read_bytes())
            assert options["destination"] == "export" and options["testFlightInternalTestingOnly"] is True
            exported = Path(command[command.index("-exportPath") + 1])
            exported.mkdir()
            ipa = exported / "ArcanosVoice.ipa"
            if self.failure == "invalid-ipa":
                ipa.write_bytes(RAW_OUTPUT)
            else:
                app = self.archive / "Products/Applications/ArcanosVoice.app"
                with zipfile.ZipFile(ipa, "w") as archive:
                    for source in app.iterdir():
                        archive.write(source, "Payload/ArcanosVoice.app/" + source.name)
        elif command[:2] == ["xcrun", "iTMSTransporter"]:
            private = Path(cwd)
            assert private.is_relative_to(self.root / "private")
            assert (private / "private_keys/AuthKey_SYNTHETIC2.p8").read_bytes() == b"synthetic-upload-private-key"
            assert Path(command[command.index("-assetFile") + 1]).is_file()
            if self.failure == "upload-oserror":
                raise OSError(RAW_OUTPUT.decode())
            if self.failure == "upload-timeout":
                raise subprocess.TimeoutExpired(command, timeout, output=RAW_OUTPUT, stderr=RAW_OUTPUT)
            if self.failure == "upload-command":
                return subprocess.CompletedProcess(command, 1, RAW_OUTPUT, RAW_OUTPUT)
        else:
            raise AssertionError("Unexpected tool request; no real command can execute")
        return subprocess.CompletedProcess(command, 0, stdout, RAW_OUTPUT)


class SigningControllerEndToEndTests(unittest.TestCase):
    def execute(self, mode="archive", failure=None):
        temporary = tempfile.TemporaryDirectory(prefix="arcanos-signing-e2e-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        fixture = SyntheticAppleTools(root, failure)
        output = root / "public-report"
        args = ["--mode", mode, "--expected-sha", REVISION, "--build-number", BUILD_NUMBER,
                "--output-dir", str(output)]
        if mode == "upload":
            args.append("--authorize-upload")
        captured = io.StringIO()
        with patch.dict(signing.os.environ, fixture.environment, clear=True), \
                patch.object(signing.platform, "system", return_value="Darwin"), \
                patch.object(signing.shutil, "which", return_value="synthetic-apple-tool"), \
                patch.object(signing.subprocess, "run", side_effect=fixture.run), redirect_stdout(captured):
            code = signing.main(args)
        report_text = (output / "report.json").read_text()
        report = json.loads(report_text)
        self.assertEqual(list(output.iterdir()), [output / "report.json"])
        self.assertEqual(report["publishableArtifacts"], ["report.json"])
        self.assertEqual(report["physicalDevice"], "NOT RUN")
        self.assertEqual(report["liveArcanos"], "NOT RUN")
        self.assertFalse(report["boundaries"]["appLaunched"])
        for private_value in (RAW_OUTPUT.decode(), "synthetic-p12-password", "synthetic-upload-private-key",
                              fixture.environment["IOS_SIGNING_P12_BASE64"],
                              fixture.environment["ASC_PRIVATE_KEY_BASE64"], fixture.profile["UUID"]):
            self.assertNotIn(private_value, report_text + captured.getvalue())
        return code, report, fixture

    def test_archive_runs_controller_and_inspects_both_products_without_upload(self):
        code, report, fixture = self.execute()
        self.assertEqual(code, 0)
        self.assertEqual(report["signing"]["status"], "PASS")
        self.assertEqual(report["testFlightUpload"]["status"], "NOT RUN")
        self.assertEqual(report["signing"]["buildNumber"], BUILD_NUMBER)
        names = [check["name"] for check in report["checks"]]
        for name in ("archive", "archive-signature", "archive-entitlements", "archive-profile",
                     "export", "export-signature", "export-entitlements", "export-profile", "final-working-tree"):
            self.assertIn(name, names)
        self.assertFalse(any(command[0] == "xcrun" for command in fixture.commands))
        self.assertFalse(list(fixture.root.rglob("*.p8")))
        ipa = next(fixture.root.rglob("*.ipa"))
        self.assertEqual(report["signing"]["ipaSHA256"], hashlib.sha256(ipa.read_bytes()).hexdigest())

    def test_authorized_upload_runs_only_after_both_products_and_source_are_checked(self):
        code, report, fixture = self.execute("upload")
        self.assertEqual(code, 0)
        self.assertEqual(report["signing"]["status"], "PASS")
        self.assertEqual(report["testFlightUpload"]["status"], "PASS")
        self.assertEqual([check["name"] for check in report["checks"]][-2:],
                         ["final-working-tree", "testflight-upload"])
        self.assertEqual(fixture.commands[-1][:2], ["xcrun", "iTMSTransporter"])

    def test_invalid_products_and_source_drift_block_upload_with_sanitized_reports(self):
        for failure in ("archive-command", "archive-isolation", "export-signature",
                        "export-profile", "invalid-ipa", "source-drift"):
            with self.subTest(failure=failure):
                code, report, fixture = self.execute("upload", failure)
                self.assertEqual(code, 1)
                self.assertEqual(report["signing"]["status"], "FAIL")
                self.assertEqual(report["testFlightUpload"]["status"], "NOT RUN")
                self.assertIn("failureCategory", report)
                self.assertFalse(any(command[0] == "xcrun" for command in fixture.commands))

    def test_upload_failures_preserve_completed_signing_as_independent_evidence(self):
        for failure in ("upload-command", "upload-timeout", "upload-oserror"):
            with self.subTest(failure=failure):
                code, report, _ = self.execute("upload", failure)
                self.assertEqual(code, 1)
                self.assertEqual(report["signing"]["status"], "PASS")
                self.assertEqual(report["testFlightUpload"]["status"], "FAIL")
                self.assertIn("failureCategory", report)


if __name__ == "__main__":
    unittest.main()
