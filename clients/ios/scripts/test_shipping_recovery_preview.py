"""Offline admission, evidence corruption, and file-scope checks for the HTTPS parent."""

import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from uuid import UUID

spec = importlib.util.spec_from_file_location("shipping_preview", Path(__file__).with_name("run-shipping-recovery-preview.py"))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class ShippingPreviewEvidenceTests(unittest.TestCase):
    arguments = SimpleNamespace(commit_sha="a" * 40, pr_number=1499,
                                web_base_url="https://web-pr-1499.up.railway.app",
                                worker_base_url="https://worker-pr-1499.up.railway.app")
    device = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    job = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    operation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

    def report(self, phase="ai-restore", dry=False, negative=False):
        values = (0, 0, 0, 0) if dry else proof.COUNTS[phase]
        checks = list(proof.BASE_CHECKS)
        if not dry:
            checks += ["initial_roles_device_policy_and_metadata_verified"] + proof.CHECKS[phase]
            if not negative:
                checks += ["phase_gateway_request_counts_and_identities_verified", "final_roles_device_policy_metadata_and_git_unchanged"]
        value = dict(kind="ios_shipping_recovery_https_proof", proofVersion=proof.VERSION, scope=proof.CHILD_SCOPE,
                     credentialStorage="in-memory-fixture", credentialAdapter=proof.ADAPTER,
                     status="FAIL" if negative else "PASS", phase=phase, executed=not dry, networkAttempted=not dry,
                     prNumber=self.arguments.pr_number, sourceCommit=self.arguments.commit_sha,
                     webBaseURL=self.arguments.web_base_url, workerBaseURL=self.arguments.worker_base_url,
                     processID=12345, responseBytes=0 if dry else 512, checks=checks,
                     **dict(zip(["requestsMade", "createRequests", "capabilityRequests", "resultRequests"], values)),
                     **{key: False for key in proof.FLAGS})
        if not dry and phase != "foreign":
            value.update(operationID=self.operation, backendJobID=self.job)
        if negative:
            value["code"] = "SHIPPING_UNKNOWN_HANDLE_REJECTED"
        return value

    def validate(self, value, phase="ai-restore", **kwargs):
        proof.validate_report(value, self.arguments, phase, 12345, **kwargs)

    def test_every_phase_requires_exact_counts_and_assertions(self):
        for phase in proof.COUNTS:
            negative = phase == "unknown-handle"
            report = self.report(phase, negative=negative)
            self.validate(report, phase, negative=negative)
            for field in ["requestsMade", "createRequests", "capabilityRequests", "resultRequests"]:
                with self.subTest(phase=phase, field=field):
                    invalid = dict(report, **{field: report[field] + 1})
                    with self.assertRaisesRegex(proof.ProofFailure, "CHILD_REQUEST_ACCOUNTING_INVALID"):
                        self.validate(invalid, phase, negative=negative)
            for index in range(len(report["checks"])):
                with self.subTest(phase=phase, missing_assertion=index):
                    invalid = copy.deepcopy(report)
                    invalid["checks"].pop(index)
                    with self.assertRaisesRegex(proof.ProofFailure, "CHILD_ASSERTIONS_INCOMPLETE"):
                        self.validate(invalid, phase, negative=negative)

    def test_dry_run_cannot_claim_network_or_files(self):
        report = self.report("dismiss-submit", dry=True)
        self.validate(report, "dismiss-submit", dry=True)
        for field, value in [("executed", True), ("networkAttempted", True), ("operationID", self.operation),
                             ("backendJobID", self.job), ("responseBytes", 1), ("requestsMade", 1)]:
            with self.subTest(field=field), self.assertRaises(proof.ProofFailure):
                self.validate(dict(report, **{field: value}), "dismiss-submit", dry=True)

    def test_stale_identity_wrong_host_and_wrong_process_are_rejected(self):
        for field, value in [("sourceCommit", "b" * 40), ("prNumber", 1498), ("processID", 12346),
                             ("webBaseURL", self.arguments.worker_base_url), ("proofVersion", "ios-shipping-recovery-https/v2")]:
            with self.subTest(field=field), self.assertRaisesRegex(proof.ProofFailure, "CHILD_IDENTITY_INVALID"):
                self.validate(dict(self.report(), **{field: value}))

    def test_scope_cannot_claim_real_auth_provider_or_lifecycle(self):
        for field in proof.FLAGS:
            with self.subTest(field=field), self.assertRaisesRegex(proof.ProofFailure, "CHILD_SCOPE_INVALID"):
                self.validate(dict(self.report(), **{field: True}))
        for field in ["credentialStorage", "credentialAdapter"]:
            with self.subTest(field=field), self.assertRaisesRegex(proof.ProofFailure, "CHILD_SCOPE_INVALID"):
                self.validate(dict(self.report(), **{field: "production"}))

    def test_unknown_cache_negative_requires_specific_rejection(self):
        report = self.report("unknown-handle", negative=True)
        for field, value in [("status", "PASS"), ("code", "SHIPPING_TOTAL_TIMEOUT"), ("code", "UNAUTHORIZED")]:
            with self.subTest(field=field, value=value), self.assertRaisesRegex(proof.ProofFailure, "CHILD_OUTCOME_INVALID"):
                self.validate(dict(report, **{field: value}), "unknown-handle", negative=True)

    def test_fields_and_counter_types_are_closed(self):
        for field, value in [("unexpected", True), ("requestsMade", True), ("responseBytes", True),
                             ("responseBytes", 2_097_153), ("scope", "Authorization: private")]:
            with self.subTest(field=field), self.assertRaises(proof.ProofFailure):
                self.validate(dict(self.report(), **{field: value}))
        report = self.report()
        report.pop("resultRequests")
        with self.assertRaisesRegex(proof.ProofFailure, "CHILD_FIELDS_INVALID"):
            self.validate(report)

    def test_output_streams_are_bounded_and_fail_without_echoing_contents(self):
        self.assertEqual(proof.read_child_output(io.BytesIO(b"{}"), io.BytesIO()), (b"{}", b""))
        for stdout, stderr in [(b"secret" * 12000, b""), (b"", b"secret" * 12000)]:
            with self.assertRaisesRegex(proof.ProofFailure, "^CHILD_OUTPUT_LIMIT$"):
                proof.read_child_output(io.BytesIO(stdout), io.BytesIO(stderr))

    def store_record(self):
        return dict(id=self.operation, partition={"deviceID": str(self.device), "origin": self.arguments.web_base_url},
                    kind="remoteAI", displaySummary="Remote ARCANOS request", createdAt=100, updatedAt=100,
                    idempotencyKey="fixture-key", backendJobID=self.job, backendStatus="queued", localState="accepted")

    def inspect(self, path, count=1):
        return proof.inspect_store(path, self.device, self.arguments.web_base_url, count, "accepted", "remoteAI")

    def test_parent_independently_rejects_phantom_partition_and_secret_records(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.json"
            record = self.store_record()
            path.write_text(json.dumps([record]))
            self.assertEqual(self.inspect(path)[0], record)
            mutations = [dict(record, localState="submissionUncertain"), dict(record, kind="confirmation"),
                         dict(record, backendStatus="completed"), dict(record, credential="secret"),
                         dict(record, displaySummary="agd1.private"), dict(record, partition={"deviceID": str(UUID(int=0)), "origin": self.arguments.web_base_url})]
            for value in mutations:
                with self.subTest(value=value), self.assertRaises(proof.ProofFailure):
                    path.write_text(json.dumps([value]))
                    self.inspect(path)
            path.write_text(json.dumps([record, record]))
            with self.assertRaisesRegex(proof.ProofFailure, "STORE_DUPLICATE_OPERATION"):
                self.inspect(path, count=2)

    def test_dismissed_approval_cannot_hide_receipt_or_uncertainty(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "index.json"
            dismissed = dict(id="dddddddd-dddd-4ddd-8ddd-dddddddddddd", partition=self.store_record()["partition"],
                             kind="confirmation", capabilityAction="tests.run", displaySummary="ARCANOS tests.run request",
                             createdAt=90, updatedAt=95, idempotencyKey="approval-key", localState="dismissed")
            path.write_text(json.dumps([self.store_record(), dismissed]))
            self.inspect(path, count=2)
            for value in [dict(dismissed, backendJobID=self.job), dict(dismissed, backendStatus="pending"),
                          dict(dismissed, localState="prepared")]:
                with self.subTest(value=value), self.assertRaises(proof.ProofFailure):
                    path.write_text(json.dumps([self.store_record(), value]))
                    self.inspect(path, count=2)

    def test_total_plan_is_finite_and_never_replays_jobs(self):
        self.assertEqual(tuple(sum(count[index] for count in proof.COUNTS.values()) for index in range(4)), (65, 1, 5, 7))


if __name__ == "__main__":
    unittest.main()
