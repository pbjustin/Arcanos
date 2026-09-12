"""Offline regressions for deliberately pinned, secretless Apple validation."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("apple_validation", Path(__file__).with_name("run-phase3c-apple-validation.py"))
APPLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APPLE)


class CloudConfigurationTests(unittest.TestCase):
    def test_exact_sdk_and_xcode_are_required(self):
        sdks = "iOS -sdk iphoneos26.2\nSimulator -sdk iphonesimulator26.2\n"
        APPLE.verify_toolchain("Xcode 26.3\nBuild version 17C529", sdks, "26.3", "26.2")
        for xcode, available in (("Xcode 16.4", sdks), ("Xcode 26.3", "-sdk iphoneos26.2"),
                                  ("Xcode 26.3", sdks.replace("26.2", "26.20")), ("Xcode 26.3 Beta", sdks)):
            with self.subTest(xcode=xcode, sdks=available), self.assertRaises(ValueError):
                APPLE.verify_toolchain(xcode, available, "26.3", "26.2")

    def test_secretless_workflow_cannot_publish_or_target_live_services(self):
        source = (ROOT / ".github/workflows/ios-phase3c.yml").read_text()
        for forbidden in ("secrets.", "secrets: inherit", "pull_request_target:", "workflow_run:",
                          "environment:", "phase3c_signing.py", "railway.app", "--allow-network"):
            self.assertNotIn(forbidden, source)
        self.assertIn("runs-on: macos-15", source)
        self.assertIn("DEVELOPER_DIR: /Applications/Xcode_26.3.app/Contents/Developer", source)
        self.assertIn("--require-xcode-version 26.3 --require-ios-sdk 26.2", source)
        self.assertIn("--runtime-version 26.2", source)
        self.assertIn("persist-credentials: false", source)
        self.assertIn("retention-days: 7", source)
        self.assertNotIn("cloud-apple/**", source)
        self.assertNotIn("cloud-simulator/**", source)

    def test_manifest_covers_distribution_and_app_resources(self):
        manifest = APPLE.source_manifest(ROOT)
        self.assertIn(".github/workflows/ios-phase3c.yml", manifest)
        self.assertIn("clients/ios/ArcanosVoice/Resources/ValidationAssets.xcassets/ValidationAppIcon.appiconset/ValidationAppIcon.png", manifest)


if __name__ == "__main__":
    unittest.main()
