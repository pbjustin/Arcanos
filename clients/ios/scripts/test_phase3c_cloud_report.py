import unittest
from phase3c_cloud_report import matrix


class CloudReportTests(unittest.TestCase):
    revision = "0" * 40

    def apple(self):
        names = ["revision", "working-tree", "apple-swift-package-tests", "project-inventory", "local-package-resolution"]
        names += [f"{s}-{c}" for s in ("build", "packaging") for c in ("Debug", "Release", "HardwareValidation")]
        return {"sourceSha": self.revision, "uncommittedChanges": [], "sourceUnchangedDuringCheck": True,
                "evidenceLevels": {"A": {"status": "PASS"}},
                "checks": [{"name": n, "status": "PASS", "exitCode": 0} for n in names]}

    def test_dirty_or_unobserved_source_cannot_pass_exact_revision_evidence(self):
        sim = {"status": "PASS", "revision": self.revision, "proof": {"status": "PASS"}}
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
        sim = {"status": "PASS", "revision": self.revision, "proof": {"status": "PASS"}}
        levels = matrix(self.revision, self.apple(), sim)["evidenceLevels"]
        self.assertEqual(levels["C"]["status"], "PASS")
        self.assertTrue(all(levels[k]["status"] == "BLOCKED" for k in "FGHIJ"))

    def test_mismatched_or_incomplete_success_reports_fail(self):
        apple = self.apple()
        apple["checks"].pop()
        self.assertEqual(matrix(self.revision, apple)["evidenceLevels"]["A"]["status"], "FAIL")
        sim = {"status": "PASS", "revision": "1" * 40, "proof": {"status": "PASS"}}
        self.assertEqual(matrix(self.revision, self.apple(), sim)["evidenceLevels"]["C"]["status"], "FAIL")
        sign = {"sourceSha": self.revision, "signing": {"status": "NOT RUN"}, "testFlightUpload": {"status": "PASS"}}
        self.assertEqual(matrix(self.revision, signing=sign)["evidenceLevels"]["E"]["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
