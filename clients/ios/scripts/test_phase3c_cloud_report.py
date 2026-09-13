import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from phase3c_cloud_report import matrix, SIMULATOR_SCENARIOS
from test_phase3c_simulator import complete_report


class CloudReportTests(unittest.TestCase):
    revision = "0" * 40

    def apple(self):
        names = ["revision", "working-tree", "apple-swift-package-tests", "project-inventory", "local-package-resolution"]
        names += [f"{s}-{c}" for s in ("build", "packaging") for c in ("Debug", "Release", "HardwareValidation")]
        return {"sourceSha": self.revision, "uncommittedChanges": [], "sourceUnchangedDuringCheck": True,
                "evidenceLevels": {"A": {"status": "PASS"}},
                "checks": [{"name": n, "status": "PASS", "exitCode": 0} for n in names]}

    def simulator(self):
        return {scenario: complete_report(scenario, self.revision) for scenario in SIMULATOR_SCENARIOS}

    def test_dirty_or_unobserved_source_cannot_pass_exact_revision_evidence(self):
        sim = self.simulator()
        for changes in ([" M clients/ios/ArcanosVoice/Sources/AppRuntime.swift"],
                        ["?? clients/ios/ArcanosVoice/HardwareValidation-Info.plist"], None, ""):
            apple = self.apple()
            if changes is None:
                del apple["uncommittedChanges"]
            else:
                apple["uncommittedChanges"] = changes
            with self.subTest(changes=changes):
                levels = matrix(self.revision, apple, sim)["evidenceLevels"]
                self.assertEqual([levels[key]["status"] for key in "ABC"], ["FAIL"] * 3)

    def test_git_preflight_must_succeed_before_exact_revision_can_pass(self):
        for name in ("revision", "working-tree"):
            for outcome in ("missing", "failed", "nonzeroExit"):
                apple = self.apple()
                check = next(item for item in apple["checks"] if item["name"] == name)
                if outcome == "missing":
                    apple["checks"].remove(check)
                elif outcome == "failed":
                    check["status"] = "FAIL"
                else:
                    check["exitCode"] = 1
                with self.subTest(check=name, outcome=outcome):
                    levels = matrix(self.revision, apple)["evidenceLevels"]
                    self.assertEqual([levels[key]["status"] for key in "AB"], ["FAIL", "FAIL"])

    def test_pipeline_preparation_never_passes_runtime_or_device(self):
        levels = matrix(self.revision)["evidenceLevels"]
        self.assertFalse(any(row["status"] == "PASS" for row in levels.values()))
        self.assertEqual(levels["K"]["status"], "NOT RUN")

    def test_successful_build_does_not_pass_runtime_or_hardware(self):
        levels = matrix(self.revision, self.apple())["evidenceLevels"]
        self.assertEqual([levels[k]["status"] for k in "AB"], ["PASS", "PASS"])
        self.assertEqual(levels["C"]["status"], "BLOCKED")
        sim = self.simulator()
        levels = matrix(self.revision, self.apple(), sim)["evidenceLevels"]
        self.assertEqual(levels["C"]["status"], "PASS")
        self.assertTrue(all(levels[k]["status"] == "BLOCKED" for k in "FGHIJ"))

    def test_mismatched_or_incomplete_success_reports_fail(self):
        apple = self.apple()
        apple["checks"].pop()
        self.assertEqual(matrix(self.revision, apple)["evidenceLevels"]["A"]["status"], "FAIL")
        sim = self.simulator()
        sim["acceptedReceipt"]["revision"] = "1" * 40
        self.assertEqual(matrix(self.revision, self.apple(), sim)["evidenceLevels"]["C"]["status"], "FAIL")
        sign = {"sourceSha": self.revision, "signing": {"status": "NOT RUN"}, "testFlightUpload": {"status": "PASS"}}
        self.assertEqual(matrix(self.revision, signing=sign)["evidenceLevels"]["E"]["status"], "FAIL")

    def test_summary_flags_and_partial_or_substituted_suites_never_pass(self):
        complete = self.simulator()
        cases = [complete["acceptedReceipt"],
                 {name: {"status": "PASS", "revision": self.revision, "proof": {"status": "PASS"}}
                  for name in SIMULATOR_SCENARIOS},
                 {name: report for name, report in complete.items() if name != "localOnly"},
                 {**complete, "localOnly": complete["acceptedReceipt"]},
                 {**complete, "extraScenario": complete["acceptedReceipt"]}]
        for report in cases:
            with self.subTest(keys=list(report)):
                self.assertEqual(matrix(self.revision, self.apple(), report)["evidenceLevels"]["C"]["status"], "FAIL")

    def test_retained_stage_controller_and_proof_changes_fail_cloud_acceptance(self):
        changes = [lambda report: report["stages"].pop(),
                   lambda report: report.update(terminations=[]),
                   lambda report: report["stages"][0]["counts"].update(submissionAttempts=2),
                   lambda report: report["proof"].update(httpRequests=1),
                   lambda report: report["checks"][0].update(status="FAIL"),
                   lambda report: report.update(liveServices="PASS")]
        for change in changes:
            reports = self.simulator()
            change(reports["lostReceipt"])
            self.assertEqual(matrix(self.revision, self.apple(), reports)["evidenceLevels"]["C"]["status"], "FAIL")

    def test_blocked_and_not_run_scenarios_keep_independent_status(self):
        for status in ("BLOCKED", "NOT RUN", "FAIL"):
            reports = self.simulator()
            reports["localOnly"] = {"status": status}
            with self.subTest(status=status):
                self.assertEqual(matrix(self.revision, self.apple(), reports)["evidenceLevels"]["C"]["status"], status)

    def test_cli_success_gate_writes_report_before_failing_invalid_evidence(self):
        cases = ("valid", "missingScenario", "summaryOnly", "tamperedStage", "malformedJSON", "malformedApple")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix="arcanos-cloud-report-fixture-") as temporary:
                root = Path(temporary)
                apple = root / "apple.json"
                apple.write_text(json.dumps(self.apple()), encoding="utf-8")
                simulator = root / "simulator"
                for scenario, report in self.simulator().items():
                    if case == "missingScenario" and scenario == "localOnly":
                        continue
                    if case == "summaryOnly":
                        report = {"status": "PASS", "revision": self.revision, "proof": {"status": "PASS"}}
                    if case == "tamperedStage" and scenario == "lostReceipt":
                        report["stages"].pop()
                    path = simulator / scenario / "report.json"
                    path.parent.mkdir(parents=True)
                    path.write_text(json.dumps(report), encoding="utf-8")
                if case == "malformedJSON":
                    (simulator / "localOnly/report.json").write_text('{"privateRawValue":"DO_NOT_EXPORT"', encoding="utf-8")
                elif case == "malformedApple":
                    apple.write_text('["DO_NOT_EXPORT"]', encoding="utf-8")
                output = root / "summary.json"
                result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("phase3c_cloud_report.py")),
                                         "--revision", self.revision, "--apple", str(apple), "--simulator", str(simulator),
                                         "--output", str(output), "--require-simulator-success"],
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0 if case == "valid" else 1)
                self.assertTrue(output.is_file())
                written = output.read_text(encoding="utf-8")
                self.assertNotIn("DO_NOT_EXPORT", written + result.stdout + result.stderr)
                self.assertEqual(json.loads(written)["evidenceLevels"]["C"]["status"], "PASS" if case == "valid" else "FAIL")

    def test_report_only_cli_keeps_missing_evidence_visible_without_execution_failure(self):
        with tempfile.TemporaryDirectory(prefix="arcanos-cloud-report-fixture-") as temporary:
            output = Path(temporary) / "summary.json"
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("phase3c_cloud_report.py")),
                                     "--revision", self.revision, "--output", str(output)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(json.loads(output.read_text())["evidenceLevels"]["C"]["status"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
