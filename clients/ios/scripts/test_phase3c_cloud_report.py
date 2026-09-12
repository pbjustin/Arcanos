import unittest
from phase3c_cloud_report import matrix


class CloudReportTests(unittest.TestCase):
    revision = "0" * 40

    def apple(self):
        names = ["apple-swift-package-tests", "project-inventory", "local-package-resolution"]
        names += [f"{s}-{c}" for s in ("build", "packaging") for c in ("Debug", "Release", "HardwareValidation")]
        return {"sourceSha": self.revision, "sourceUnchangedDuringCheck": True, "evidenceLevels": {"A": {"status": "PASS"}},
                "checks": [{"name": n, "status": "PASS", "exitCode": 0} for n in names]}

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
