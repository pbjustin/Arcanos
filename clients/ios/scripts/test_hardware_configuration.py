"""Offline negative tests; synthetic temp artifacts are retained, never deleted."""
import importlib.util
import plistlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("hardware_configuration", Path(__file__).with_name("validate-hardware-configuration.py"))
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class ConfigurationTests(unittest.TestCase):
    def test_actual_repository_configuration(self):
        self.assertEqual(VALIDATOR.validate_sources(Path(__file__).resolve().parents[1])["source_configuration"], "PASS")

    def test_nested_project_parser_resolves_objects_and_rejects_duplicates(self):
        value = VALIDATOR.parse_project('{ objects = { a = { name = "Debug"; files = (one, two,); }; }; }')
        self.assertEqual(value["objects"]["a"]["files"], ["one", "two"])
        with self.assertRaises(ValueError):
            VALIDATOR.parse_project('{ objects = {}; objects = {}; }')

    def test_nested_source_selection_excludes_live_paths(self):
        source = """#if ARCANOS_HARDWARE_VALIDATION
fixture()
#if !DEBUG
bad()
#endif
#else
live()
#if DEBUG
demo()
#endif
#endif
"""
        self.assertEqual(VALIDATOR.selected_swift(source, {"DEBUG", VALIDATOR.FLAG}).strip(), "fixture()")
        self.assertEqual(VALIDATOR.selected_swift(source, set()).strip(), "live()")
        self.assertEqual(VALIDATOR.selected_swift(source, {"DEBUG"}).splitlines(), ["live()", "demo()"])

    def test_simulator_driver_requires_both_build_and_platform_condition(self):
        source = "#if ARCANOS_HARDWARE_VALIDATION && targetEnvironment(simulator)\nrunFixture()\n#endif"
        self.assertEqual(VALIDATOR.selected_swift(source, {VALIDATOR.FLAG}, simulator=True), "runFixture()")
        self.assertEqual(VALIDATOR.selected_swift(source, {VALIDATOR.FLAG}), "")
        self.assertEqual(VALIDATOR.selected_swift(source, {"DEBUG"}, simulator=True), "")

    def test_unknown_and_unbalanced_macros_fail_closed(self):
        for source in ("#if UNKNOWN_MODE\nunsafe()\n#endif", "#if DEBUG\nunsafe()", "#endif"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                VALIDATOR.selected_swift(source, {"DEBUG"})

    def test_actual_project_mutations_fail_closed(self):
        ios = Path(__file__).resolve().parents[1]
        source = (ios / "ArcanosVoice/ArcanosVoice.xcodeproj/project.pbxproj").read_text(encoding="utf-8")
        cases = (("Release", "SWIFT_ACTIVE_COMPILATION_CONDITIONS", VALIDATOR.FLAG),
                 ("Debug", "EXCLUDED_SOURCE_FILE_NAMES", ""),
                 ("HardwareValidation", "PRODUCT_BUNDLE_IDENTIFIER", "org.arcanos.voice"),
                 ("HardwareValidation", "IPHONEOS_DEPLOYMENT_TARGET", "26.0"))
        for name, key, value in cases:
            project = VALIDATOR.parse_project(source)
            for obj in project["objects"].values():
                if obj.get("isa") == "XCBuildConfiguration" and obj["name"] == name:
                    obj["buildSettings"][key] = value
            with self.subTest(name=name, setting=key), patch.object(VALIDATOR, "parse_project", return_value=project):
                with self.assertRaises(ValueError):
                    VALIDATOR.validate_sources(ios)

    def test_source_macro_leak_fails_against_actual_selected_branch(self):
        ios = Path(__file__).resolve().parents[1]
        original_read = Path.read_text

        def mutated_read(path, *args, **kwargs):
            text = original_read(path, *args, **kwargs)
            if path.name == "AppRuntime.swift":
                text = text.replace("#if ARCANOS_HARDWARE_VALIDATION", "#if DEBUG")
            return text

        with patch.object(Path, "read_text", mutated_read), self.assertRaises(ValueError):
            VALIDATOR.validate_sources(ios)

    def test_comments_cannot_supply_a_missing_guard(self):
        self.assertNotIn("guardBundle", VALIDATOR.without_comments('// guardBundle()\n/* guardBundle() */'))
        self.assertIn('"https://fixture.invalid"', VALIDATOR.without_comments('let origin = "https://fixture.invalid" // explanation'))

    def app(self, hardware=False, marker=False, minimum="18.0", ats=None):
        app = Path(tempfile.mkdtemp(prefix="arcanos-phase3c-packaging-fixture-")) / "Synthetic.app"
        app.mkdir()
        info = {"CFBundleIdentifier": VALIDATOR.BUNDLE if hardware else "org.arcanos.voice",
                "CFBundleExecutable": "Synthetic", "MinimumOSVersion": minimum}
        if hardware:
            info["ArcanosValidationRevision"] = "0" * 40
            info["CFBundleDisplayName"] = "ARCANOS Fixtures"
            info["CFBundleIcons"] = {"CFBundlePrimaryIcon": {"CFBundleIconName": "ValidationAppIcon"}}
        if ats:
            info["NSAppTransportSecurity"] = ats
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        (app / "PrivacyInfo.xcprivacy").write_bytes(plistlib.dumps({"NSPrivacyTracking": False}))
        (app / "Synthetic").write_bytes(b"\xcf\xfa\xed\xfe" + (b" ".join(VALIDATOR.MARKERS) if marker else b"shipping fixture"))
        return app

    def test_artifact_mode_markers_and_bundle_must_agree(self):
        self.assertEqual(VALIDATOR.validate_app(self.app(), "Release")["built_artifact"], "PASS")
        self.assertEqual(VALIDATOR.validate_app(self.app(hardware=True, marker=True), "HardwareValidation")["built_artifact"], "PASS")
        for app, config in ((self.app(marker=True), "Release"), (self.app(hardware=True), "HardwareValidation"),
                            (self.app(hardware=True, marker=True), "Debug")):
            with self.subTest(configuration=config), self.assertRaises(ValueError):
                VALIDATOR.validate_app(app, config)

    def test_artifact_ats_and_deployment_regressions_fail(self):
        for app in (self.app(minimum="26.0"), self.app(ats={"NSAllowsArbitraryLoads": True})):
            with self.assertRaises(ValueError):
                VALIDATOR.validate_app(app, "Release")

    def test_debug_dylib_marker_leak_is_detected(self):
        app = self.app()
        (app / "Synthetic.debug.dylib").write_bytes(b" ".join(VALIDATOR.MARKERS))
        with self.assertRaises(ValueError):
            VALIDATOR.validate_app(app, "Debug")

    def test_hardware_artifact_requires_exact_revision_and_visible_identity(self):
        for key, value in (("ArcanosValidationRevision", "UNRECORDED"), ("CFBundleDisplayName", "ARCANOS"),
                           ("CFBundleIcons", {})):
            app = self.app(hardware=True, marker=True)
            info = plistlib.loads((app / "Info.plist").read_bytes())
            info[key] = value
            (app / "Info.plist").write_bytes(plistlib.dumps(info))
            with self.subTest(key=key), self.assertRaises(ValueError):
                VALIDATOR.validate_app(app, "HardwareValidation")


if __name__ == "__main__":
    unittest.main()
