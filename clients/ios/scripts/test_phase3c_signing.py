"""Portable security gates only; no Apple signing or service execution."""
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import phase3c_signing as signing

SHA = "a" * 40
TEAM = "SYNTHETIC1"


def profile():
    return {"TeamIdentifier": [TEAM], "ApplicationIdentifierPrefix": [TEAM],
            "UUID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "ExpirationDate": datetime.now(timezone.utc) + timedelta(days=30),
            "DeveloperCertificates": [b"synthetic-public-certificate"],
            "Entitlements": {"application-identifier": TEAM + "." + signing.BUNDLE,
                             "com.apple.developer.team-identifier": TEAM,
                             "get-task-allow": False, "beta-reports-active": True}}


def dispatch():
    return {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main", "GITHUB_REF_PROTECTED": "true",
            "RUNNER_ENVIRONMENT": "github-hosted", "ARCANOS_EPHEMERAL_SIGNING_RUNNER": "1"}


class SigningBoundaryTests(unittest.TestCase):
    def test_exact_clean_revision_required(self):
        signing.validate_revision(SHA, SHA, False)
        for expected, actual, dirty in (("main", SHA, False), (SHA, "b" * 40, False), (SHA, SHA, True)):
            with self.subTest(expected=expected, dirty=dirty), self.assertRaises(signing.GateError):
                signing.validate_revision(expected, actual, dirty)

    def test_dispatch_ref_and_disposable_runner_boundaries(self):
        signing.validate_dispatch("archive", False, dispatch())
        for key, value in (("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF", "refs/heads/untrusted"),
                           ("GITHUB_REF_PROTECTED", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"),
                           ("ARCANOS_EPHEMERAL_SIGNING_RUNNER", "0")):
            with self.subTest(key=key), self.assertRaises(signing.GateError):
                signing.validate_dispatch("archive", False, {**dispatch(), key: value})

    def test_upload_requires_separate_explicit_authorization(self):
        with self.assertRaises(signing.GateError):
            signing.validate_dispatch("upload", False, dispatch())
        signing.validate_dispatch("upload", True, dispatch())

    def test_provider_neutral_still_requires_disposable_guarantee(self):
        signing.validate_dispatch("archive", False, {"ARCANOS_EPHEMERAL_SIGNING_RUNNER": "1"})
        with self.assertRaises(signing.GateError):
            signing.validate_dispatch("archive", False, {})

    def test_child_environment_omits_all_credentials_and_app_configuration(self):
        environment = signing.clean_environment({"HOME": "/synthetic", "PATH": "/usr/bin", "GATEWAY_URL": "invalid",
                                                "OPENAI_API_KEY": "synthetic", "IOS_SIGNING_P12_PASSWORD": "synthetic",
                                                "ASC_PRIVATE_KEY_BASE64": "synthetic", "ARCANOS_GATEWAY_ORIGIN": "invalid"})
        self.assertEqual(set(environment), {"HOME", "PATH", "LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE"})

    def test_exact_distribution_profile_is_accepted(self):
        self.assertEqual(signing.validate_profile(profile(), TEAM), profile()["UUID"])

    def test_wrong_team_origin_wildcard_or_development_profile_rejected(self):
        variants = []
        for key, value in (("TeamIdentifier", ["OTHERTEAM1"]), ("ProvisionedDevices", ["synthetic-device"]),
                           ("ProvisionsAllDevices", True), ("ExpirationDate", datetime.now(timezone.utc) - timedelta(days=1))):
            variants.append({**profile(), key: value})
        for key, value in (("application-identifier", TEAM + ".org.arcanos.voice"),
                           ("application-identifier", TEAM + ".*"), ("get-task-allow", True),
                           ("beta-reports-active", False), ("aps-environment", "production")):
            candidate = profile()
            candidate["Entitlements"][key] = value
            variants.append(candidate)
        for candidate in variants:
            with self.subTest(keys=list(candidate)), self.assertRaises(signing.GateError):
                signing.validate_profile(candidate, TEAM)

    def test_identity_must_match_profile_public_certificate(self):
        fingerprint = hashlib.sha1(profile()["DeveloperCertificates"][0]).hexdigest().upper()
        identities = f' 1) {fingerprint} "Apple Distribution: Synthetic"'
        self.assertEqual(signing.matching_identity(identities, profile()), fingerprint)
        with self.assertRaises(signing.GateError):
            signing.matching_identity('1) ' + "0" * 40 + ' "Apple Distribution: Other"', profile())
        with self.assertRaises(signing.GateError):
            signing.matching_identity(identities.replace("Apple Distribution", "Apple Development"), profile())

    def test_export_cannot_upload_automatically_or_change_build_number(self):
        options = signing.export_options(TEAM, profile()["UUID"], "A" * 40)
        self.assertEqual(options["destination"], "export")
        self.assertEqual(options["method"], "app-store-connect")
        self.assertEqual(options["provisioningProfiles"], {signing.BUNDLE: profile()["UUID"]})
        self.assertFalse(options["manageAppVersionAndBuildNumber"])
        self.assertFalse(options["uploadSymbols"])
        self.assertTrue(options["testFlightInternalTestingOnly"])

    def test_export_cannot_silently_replace_embedded_profile(self):
        original = profile()
        signing.validate_embedded_profile(deepcopy(original), original, TEAM)
        for key, value in (("UUID", "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"),
                           ("DeveloperCertificates", [b"different-synthetic-certificate"]),
                           ("Entitlements", {**original["Entitlements"], "keychain-access-groups": [TEAM + ".*"]})):
            with self.subTest(key=key), self.assertRaises(signing.GateError):
                signing.validate_embedded_profile({**original, key: value}, original, TEAM)

    def test_entitlements_cannot_share_shipping_keychain_or_add_capabilities(self):
        allowed = deepcopy(profile()["Entitlements"])
        signing.validate_entitlements(allowed, profile())
        for key, value in (("keychain-access-groups", [TEAM + ".org.arcanos.voice"]),
                           ("get-task-allow", True), ("aps-environment", "production"),
                           ("application-identifier", TEAM + ".org.arcanos.voice")):
            with self.subTest(key=key), self.assertRaises(signing.GateError):
                signing.validate_entitlements({**allowed, key: value}, profile())

    def test_signed_bundle_revision_build_and_upload_resources(self):
        info = {"CFBundleIdentifier": signing.BUNDLE, "ArcanosValidationRevision": SHA,
                "CFBundleVersion": "12", "MinimumOSVersion": "18.0"}
        signing.validate_info(info, SHA, "12")
        with self.assertRaises(signing.GateError):
            signing.validate_info(info, SHA, "12", True)
        ready = {**info, "CFBundleIcons": {"CFBundlePrimaryIcon": {"CFBundleIconName": "ValidationIcon"}},
                 "ITSAppUsesNonExemptEncryption": False}
        signing.validate_info(ready, SHA, "12", True)
        for key, value in (("CFBundleIdentifier", "org.arcanos.voice"), ("ArcanosValidationRevision", "b" * 40),
                           ("CFBundleVersion", "13"), ("MinimumOSVersion", "26.0")):
            with self.subTest(key=key), self.assertRaises(signing.GateError):
                signing.validate_info({**ready, key: value}, SHA, "12", True)

    def test_archive_extraction_rejects_escape_symlinks_and_private_keys(self):
        with tempfile.TemporaryDirectory(prefix="arcanos-signing-test-") as temporary:
            root = Path(temporary)
            cases = ["../escape", "/absolute", "C:/escape", "Payload/App.app/private.p8", "Payload\\escape"]
            for index, name in enumerate(cases):
                path = root / f"{index}.ipa"
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(name, "synthetic")
                with self.subTest(name=name), self.assertRaises(signing.GateError):
                    signing.extract_ipa(path, root / str(index))
            symlink = root / "symlink.ipa"
            with zipfile.ZipFile(symlink, "w") as archive:
                entry = zipfile.ZipInfo("Payload/App.app/link")
                entry.external_attr = 0o120777 << 16
                archive.writestr(entry, "/outside")
            with self.assertRaises(signing.GateError):
                signing.extract_ipa(symlink, root / "symlink")

    def test_private_material_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory(prefix="arcanos-signing-test-") as temporary:
            path = Path(temporary) / "synthetic"
            signing.private_file(path, b"first")
            with self.assertRaises(FileExistsError):
                signing.private_file(path, b"replacement")
            self.assertEqual(path.read_bytes(), b"first")

    def test_export_inspection_keeps_app_product_inside_private_directory(self):
        with tempfile.TemporaryDirectory(prefix="arcanos-signing-test-") as temporary:
            root = Path(temporary)
            ipa = root / "synthetic.ipa"
            with zipfile.ZipFile(ipa, "w") as archive:
                entry = zipfile.ZipInfo("Payload/ArcanosVoice.app/ArcanosVoice")
                entry.external_attr = 0o100755 << 16
                archive.writestr(entry, b"synthetic-executable")
                archive.writestr("Payload/ArcanosVoice.app/embedded.mobileprovision", b"synthetic-profile")
            app = signing.extract_ipa(ipa, root / "private-inspection")
            self.assertEqual(app, root / "private-inspection/Payload/ArcanosVoice.app")
            self.assertTrue((app / "ArcanosVoice").is_file())
            self.assertEqual(signing.PUBLIC_ARTIFACTS, ("report.json",))

    def test_bad_base64_fails_with_fixed_sanitized_category(self):
        self.assertEqual(signing.decode_secret(base64.b64encode(b"synthetic").decode()), b"synthetic")
        with self.assertRaisesRegex(signing.GateError, "invalid-base64-signing-material"):
            signing.decode_secret("private non-base64 value")

    def test_missing_signing_material_reports_not_run_without_subprocesses(self):
        with tempfile.TemporaryDirectory(prefix="arcanos-signing-test-") as temporary:
            output = Path(temporary) / "report"
            with patch.dict(signing.os.environ, {}, clear=True), patch.object(signing.subprocess, "run") as run:
                code = signing.main(["--expected-sha", SHA, "--build-number", "1", "--output-dir", str(output)])
            run.assert_not_called()
            report = json.loads((output / "report.json").read_text())
            self.assertEqual(code, 0)
            self.assertEqual(report["signing"]["label"], "SIGNING NOT RUN")
            self.assertEqual(report["signing"]["status"], "NOT RUN")
            self.assertEqual(report["testFlightUpload"]["status"], "NOT RUN")
            self.assertEqual(list(output.iterdir()), [output / "report.json"])
            self.assertEqual(report["publishableArtifacts"], ["report.json"])

    def test_unauthorized_upload_stops_before_secret_or_tool_access(self):
        with tempfile.TemporaryDirectory(prefix="arcanos-signing-test-") as temporary:
            output = Path(temporary) / "report"
            with patch.object(signing.subprocess, "run") as run:
                code = signing.main(["--mode", "upload", "--expected-sha", SHA, "--build-number", "1", "--output-dir", str(output)])
            run.assert_not_called()
            self.assertEqual(code, 1)
            report = json.loads((output / "report.json").read_text())
            self.assertEqual(report["failureCategory"], "upload-not-explicitly-authorized")

    def test_workflow_gates_trusted_same_revision_and_metadata_only(self):
        workflow = Path(__file__).resolve().parents[3] / ".github/workflows/ios-hardware-distribution.yml"
        text = workflow.read_text()
        self.assertNotIn("pull_request:", text)
        self.assertNotIn("push:", text)
        self.assertIn('test "$EXPECTED_SHA" = "$ACTUAL_SHA"', text)
        self.assertIn("uses: ./.github/workflows/ios-phase3c.yml", text)
        self.assertIn("needs: [admission, validation]", text)
        self.assertIn("ref: ${{ github.sha }}", text)
        self.assertIn("ios-hardware-testflight' || 'ios-hardware-signing", text)
        self.assertIn("arcanos-distribution-report/report.json", text)
        self.assertNotIn("secrets: inherit", text)
        self.assertNotIn("download-artifact", text)
        self.assertNotIn("-allowProvisioningUpdates", text)
        self.assertEqual(text.count("uses: actions/upload-artifact"), 1)


if __name__ == "__main__":
    unittest.main()
