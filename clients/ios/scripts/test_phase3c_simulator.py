"""Offline proof-validator regressions; these are not Simulator runtime evidence."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("phase3c_simulator", Path(__file__).with_name("run-phase3c-simulator.py"))
SIMULATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SIMULATOR)

REVISION = "a" * 40
RUN = "11111111-1111-4111-8111-111111111111"
OPERATION = "22222222-2222-4222-8222-222222222222"
JOB = "33333333-3333-4333-8333-333333333333"
KEY = "44444444-4444-4444-8444-444444444444"


def stage(action, pid=100):
    completed = action in ("complete", "repeatedRestore")
    reads = SIMULATOR.ACTIONS.index(action) * 3
    return {
        "schema": "arcanos-phase3c-simulator-stage/v1", "runID": RUN, "action": action, "status": "PASS",
        "revision": REVISION, "configuration": "HardwareValidation", "bundleIdentifier": SIMULATOR.BUNDLE,
        "processID": pid, "processName": "ArcanosVoice", "platform": "iOS Simulator",
        "appIntentInvocation": "NOT RUN", "voice": "NOT RUN", "foundationModelsInference": "NOT RUN",
        "physicalDevice": "NOT RUN", "liveServices": "NOT RUN", "httpRequests": 0,
        "fixtureOriginSelected": True, "productionPreferencesIgnored": True,
        "systemKeychainProbe": "PASS — Simulator only; synthetic namespace",
        "authoritativeFixtureResultMatched": completed,
        "presentationStatus": "Response" if completed else "Pending — not completed",
        "startupRestoredOperationIDs": [] if action == "submit" else [OPERATION],
        "observation": {
            "revision": REVISION, "configuration": "HardwareValidation", "processID": pid,
            "operations": [{"operationID": OPERATION, "jobID": JOB, "idempotencyKey": KEY,
                            "state": "terminal" if completed else "accepted" if action == "submit" else "observing",
                            "backendStatus": "completed" if completed else "queued" if action == "submit" else "pending"}],
            "fixture": {
                "configuration": {"mode": "fixtures", "nextReceipt": "accepted", "authentication": "accepted", "approvedRetry": "accepted"},
                "requestAttempts": 1 + reads, "submissionAttempts": 1, "resultAttempts": reads,
                "semanticExecutionCount": int(completed), "rejectedAttempts": 0,
                "jobs": [{"jobID": JOB, "idempotencyKey": KEY, "action": "ai", "completed": completed}],
                "events": [{"kind": "startup", "processID": pid}, {"kind": "accepted", "processID": 100}]
                          + ([{"kind": "completed", "processID": pid}] if completed else [])}}}


def validated(action, pid=100, raw=None):
    return SIMULATOR.validate_stage(raw if raw is not None else stage(action, pid), action=action,
                                    run_id=RUN, revision=REVISION, expected_pid=pid)


class SimulatorProofTests(unittest.TestCase):
    def test_four_stage_accepted_receipt_recovery_proof(self):
        stages = [validated(action, 100 + index) for index, action in enumerate(SIMULATOR.ACTIONS)]
        terminations = [{"status": "PASS", "processID": 100 + index} for index in range(3)]
        result = SIMULATOR.validate_sequence(stages, terminations)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["interceptedSubmissionAttempts"], 1)
        self.assertEqual(result["semanticFixtureExecutions"], 1)
        self.assertEqual(result["httpRequests"], 0)

    def test_stale_wrong_build_wrong_process_and_excess_claims_rejected(self):
        cases = {"runID": "55555555-5555-4555-8555-555555555555", "revision": "b" * 40,
                 "configuration": "Release", "bundleIdentifier": "org.arcanos.voice", "processID": 101,
                 "processName": "ArcanosRecoveryProof", "platform": "physical iPhone", "status": "FAIL",
                 "fixtureOriginSelected": False, "productionPreferencesIgnored": False, "httpRequests": 1,
                 "appIntentInvocation": "PASS", "voice": "PASS", "foundationModelsInference": "PASS",
                 "physicalDevice": "PASS", "liveServices": "PASS"}
        for key, value in cases.items():
            with self.subTest(key=key), self.assertRaises(SIMULATOR.ValidationFailure):
                raw = stage("submit")
                raw[key] = value
                validated("submit", raw=raw)

    def test_duplicate_submission_execution_and_acceptance_rejected(self):
        for key in ("submissionAttempts", "semanticExecutionCount", "rejectedAttempts"):
            raw = stage("complete")
            raw["observation"]["fixture"][key] += 1
            with self.subTest(counter=key), self.assertRaises(SIMULATOR.ValidationFailure):
                validated("complete", raw=raw)
        raw = stage("complete")
        raw["observation"]["fixture"]["events"].append({"kind": "accepted"})
        with self.assertRaises(SIMULATOR.ValidationFailure):
            validated("complete", raw=raw)

    def test_state_identity_result_and_startup_inconsistency_rejected(self):
        changes = [lambda value: value["observation"]["operations"][0].update(state="submissionUncertain"),
                   lambda value: value["observation"]["fixture"]["jobs"][0].update(jobID=KEY),
                   lambda value: value.update(authoritativeFixtureResultMatched=False),
                   lambda value: value.update(startupRestoredOperationIDs=[]),
                   lambda value: value["observation"]["fixture"]["configuration"].update(mode="localOnly"),
                   lambda value: value["observation"]["fixture"].update(resultAttempts=True)]
        for change in changes:
            raw = stage("complete")
            change(raw)
            with self.assertRaises(SIMULATOR.ValidationFailure):
                validated("complete", raw=raw)

    def test_artifact_projection_drops_unknown_raw_fields(self):
        raw = stage("submit")
        raw["privateUnexpectedValue"] = "DO_NOT_EXPORT"
        raw["observation"]["privateUnexpectedValue"] = "DO_NOT_EXPORT"
        result = validated("submit", raw=raw)
        self.assertNotIn("DO_NOT_EXPORT", str(result))

    def test_missing_or_wrong_termination_is_not_process_death(self):
        stages = [validated(action, 100 + index) for index, action in enumerate(SIMULATOR.ACTIONS)]
        correct = [{"status": "PASS", "processID": 100 + index} for index in range(3)]
        cases = [[], correct[:2], [{"status": "NOT RUN", "processID": 100}] + correct[1:],
                 [{"status": "PASS", "processID": 999}] + correct[1:]]
        for termination in cases:
            with self.subTest(termination=termination), self.assertRaises(SIMULATOR.ValidationFailure):
                SIMULATOR.validate_sequence(stages, termination)

    def test_relaunch_cannot_replace_operation_or_return_cached_result_only(self):
        stages = [validated(action, 100 + index) for index, action in enumerate(SIMULATOR.ACTIONS)]
        termination = [{"status": "PASS", "processID": 100 + index} for index in range(3)]
        for key in ("operationID", "jobID", "idempotencyKey"):
            changed = copy.deepcopy(stages)
            changed[1]["operation"][key] = RUN
            with self.subTest(key=key), self.assertRaises(SIMULATOR.ValidationFailure):
                SIMULATOR.validate_sequence(changed, termination)
        changed = copy.deepcopy(stages)
        changed[-1]["counts"]["resultAttempts"] = changed[-2]["counts"]["resultAttempts"]
        with self.assertRaises(SIMULATOR.ValidationFailure):
            SIMULATOR.validate_sequence(changed, termination)

    def test_runtime_selection_rejects_missing_unavailable_and_duplicate(self):
        runtime = {"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-2", "version": "26.2", "isAvailable": True}
        self.assertEqual(SIMULATOR.select_runtime({"runtimes": [runtime]}, "26.2"), runtime)
        for runtimes in ([], [runtime, runtime], [dict(runtime, isAvailable=False)]):
            with self.assertRaises(SIMULATOR.ValidationFailure):
                SIMULATOR.select_runtime({"runtimes": runtimes}, "26.2")

    def test_wait_observes_condition_and_timeout_does_not_mean_success(self):
        with patch.object(SIMULATOR.time, "sleep") as sleep:
            self.assertTrue(SIMULATOR.wait_until(lambda: True, 1))
            sleep.assert_not_called()
        with patch.object(SIMULATOR.time, "monotonic", side_effect=[0, 2]), self.assertRaises(SIMULATOR.ValidationFailure):
            SIMULATOR.wait_until(lambda: False, 1)

    def test_driver_is_simulator_only_and_uses_shipping_entry_points(self):
        ios = Path(__file__).resolve().parents[1]
        source = (ios / "ArcanosVoice/Sources/SimulatorRecoveryDriver.swift").read_text(encoding="utf-8")
        self.assertTrue(source.startswith("#if ARCANOS_HARDWARE_VALIDATION && targetEnvironment(simulator)"))
        for call in ("runtime.ask(", "runtime.checkLatestJob()", "runtime.activate()"):
            self.assertIn(call, source)
        for forbidden in ("URLSession", "AIRouter(", "ArcanosSession(", "ShippingSessionComposition("):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
