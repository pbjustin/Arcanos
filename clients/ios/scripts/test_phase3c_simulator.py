"""Offline proof-validator regressions; these are not Simulator runtime evidence."""
import copy
import importlib.util
import json
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
SCENARIOS = ("acceptedReceipt", "lostReceipt", "cancelledApproval", "localOnly")
FIXTURES = Path(__file__).with_name("fixtures") / "phase3c-simulator"


def fixture(scenario="acceptedReceipt"):
    return json.loads((FIXTURES / (scenario + ".json")).read_text(encoding="utf-8"))


def stage(action, pid=100, scenario="acceptedReceipt"):
    raw = next(item for item in fixture(scenario)["stages"] if item["action"] == action)
    original_pid = raw["processID"]
    raw["processID"] = pid
    raw["observation"]["processID"] = pid
    for event in raw["observation"]["fixture"]["events"]:
        if event["processID"] == original_pid:
            event["processID"] = pid
    return raw


def validated(action, pid=100, raw=None, scenario="acceptedReceipt"):
    return SIMULATOR.validate_stage(raw if raw is not None else stage(action, pid, scenario), action=action,
                                    run_id=RUN, revision=REVISION, expected_pid=pid, scenario=scenario)


def complete_report(scenario="acceptedReceipt", revision=REVISION):
    """Compose a report from independently stored synthetic raw stage fixtures."""
    source = fixture(scenario)
    stages = []
    for raw in source["stages"]:
        raw["revision"] = revision
        raw["observation"]["revision"] = revision
        stages.append(SIMULATOR.validate_stage(raw, action=raw["action"], run_id=RUN, revision=revision,
                                                expected_pid=raw["processID"], scenario=scenario))
    terminations = source["terminations"]
    actions = [item["action"] for item in source["stages"]]
    commands = ["list-runtimes", "create-owned-simulator", "boot-owned-simulator", "boot-readiness",
                "install-hardware-validation-app", "locate-isolated-app-container"]
    commands += ["launch-" + action for action in actions]
    commands += ["terminate-" + action for action in actions[:-1]]
    commands += ["shutdown-owned-simulator"]
    return {"schema": "arcanos-phase3c-simulator-proof/v1", "scenario": scenario, "revision": revision, "status": "PASS",
            "physicalDevice": "NOT RUN", "appIntentInvocation": "NOT RUN", "liveServices": "NOT RUN",
            "checks": [{"name": name, "status": "PASS", "exitCode": 0} for name in commands]
                      + [{"name": "source-and-built-app-isolation", "status": "PASS"},
                         {"name": "seed-synthetic-stale-preferences", "status": "PASS"}],
            "stages": stages, "terminations": terminations,
            "proof": SIMULATOR.validate_sequence(stages, terminations, scenario=scenario)}


class SimulatorProofTests(unittest.TestCase):
    def test_fixed_scenarios_pass_only_their_named_proof(self):
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario):
                report = complete_report(scenario)
                result = SIMULATOR.validate_report(report, REVISION, scenario)
                self.assertEqual(result["scenario"], scenario)
                self.assertEqual(result["interceptedSubmissionAttempts"], 1)
                self.assertEqual(result["httpRequests"], 0)
                self.assertEqual(result["authoritativeFixtureResultRetrieved"], scenario == "acceptedReceipt")
                self.assertEqual(result["semanticFixtureExecutions"], int(scenario in ("acceptedReceipt", "lostReceipt")))

    def test_event_job_host_sequence_and_read_observations_are_required(self):
        def event(raw, kind):
            return next(item for item in raw["observation"]["fixture"]["events"] if item["kind"] == kind)

        changes = {
            "wrong accepted job": lambda raw: event(raw, "accepted").update(jobID=KEY),
            "wrong completed job": lambda raw: event(raw, "completed").update(jobID=KEY),
            "wrong read job": lambda raw: event(raw, "resultRead").update(jobID=KEY),
            "foreign process": lambda raw: event(raw, "resultRead").update(processName="ArcanosRecoveryProof"),
            "missing sequence": lambda raw: event(raw, "resultRead").pop("sequence"),
            "duplicate sequence": lambda raw: event(raw, "resultRead").update(sequence=1),
            "missing read events": lambda raw: raw["observation"]["fixture"].update(events=[
                item for item in raw["observation"]["fixture"]["events"] if item["kind"] != "resultRead"]),
            "counter without read": lambda raw: raw["observation"]["fixture"].update(resultAttempts=100, requestAttempts=101),
            "no current process read": lambda raw: [item.update(processID=99) for item in raw["observation"]["fixture"]["events"]
                                                     if item["kind"] == "resultRead"],
        }
        for name, change in changes.items():
            raw = stage("complete", pid=102)
            change(raw)
            with self.subTest(mutation=name), self.assertRaises(SIMULATOR.ValidationFailure):
                validated("complete", pid=102, raw=raw)

    def test_lost_receipt_cannot_invent_receipt_read_or_safe_replay(self):
        changes = {
            "invented receipt": lambda raw: raw["observation"]["operations"][0].update(jobID=JOB),
            "invented completion presentation": lambda raw: raw.update(authoritativeFixtureResultMatched=True, presentationStatus="Response"),
            "resubmission": lambda raw: raw["observation"]["fixture"].update(submissionAttempts=2, requestAttempts=2),
            "automatic result read": lambda raw: raw["observation"]["fixture"].update(resultAttempts=1, requestAttempts=2),
            "unrelated accepted job": lambda raw: raw["observation"]["fixture"]["jobs"][0].update(idempotencyKey=RUN),
            "missing lost receipt": lambda raw: raw["observation"]["fixture"].update(events=[
                item for item in raw["observation"]["fixture"]["events"] if item["kind"] != "lostReceipt"]),
        }
        for name, change in changes.items():
            raw = stage("complete", pid=102, scenario="lostReceipt")
            change(raw)
            with self.subTest(mutation=name), self.assertRaises(SIMULATOR.ValidationFailure):
                validated("complete", pid=102, raw=raw, scenario="lostReceipt")

    def test_cancelled_approval_requires_dismissal_and_rejected_reapproval(self):
        changes = {
            "pending approval": lambda raw: raw.update(pendingApprovalAbsent=False),
            "replayed approval": lambda raw: raw.update(cancelledApprovalNotReplayed=False),
            "retry accepted": lambda raw: raw.update(approvalRetryRejected=False),
            "undismissed operation": lambda raw: raw["observation"]["operations"][0].update(state="awaitingConfirmation"),
            "accepted job": lambda raw: raw["observation"]["fixture"].update(jobs=[{"jobID": JOB}]),
            "extra submission": lambda raw: raw["observation"]["fixture"].update(submissionAttempts=2, requestAttempts=2),
        }
        for name, change in changes.items():
            raw = stage("submit", scenario="cancelledApproval")
            change(raw)
            with self.subTest(mutation=name), self.assertRaises(SIMULATOR.ValidationFailure):
                validated("submit", raw=raw, scenario="cancelledApproval")

    def test_local_only_requires_rejection_without_job_or_completion(self):
        changes = {
            "live fallback mode": lambda raw: raw["observation"]["fixture"]["configuration"].update(mode="fixtures"),
            "rejection missing": lambda raw: raw["observation"]["fixture"].update(rejectedAttempts=0),
            "accepted job": lambda raw: raw["observation"]["fixture"].update(jobs=[{"jobID": JOB}]),
            "completion claim": lambda raw: raw.update(authoritativeFixtureResultMatched=True),
            "automatic retry": lambda raw: raw["observation"]["fixture"].update(submissionAttempts=2, requestAttempts=2, rejectedAttempts=2),
        }
        for name, change in changes.items():
            raw = stage("restore", pid=101, scenario="localOnly")
            change(raw)
            with self.subTest(mutation=name), self.assertRaises(SIMULATOR.ValidationFailure):
                validated("restore", pid=101, raw=raw, scenario="localOnly")

    def test_retained_report_rechecks_controller_lifecycle_and_summary(self):
        changes = {
            "summary flag only": lambda report: report.update(stages=[], terminations=[], proof={"status": "PASS"}),
            "missing installed stage": lambda report: report["stages"].pop(),
            "missing process exit": lambda report: report["terminations"].pop(),
            "wrong termination action": lambda report: report["terminations"][0].update(action="restore"),
            "failed projected stage": lambda report: report["stages"][1].update(status="FAIL"),
            "different run": lambda report: report["stages"][1].update(runID=JOB),
            "different revision": lambda report: report["stages"][1].update(revision="b" * 40),
            "different scenario": lambda report: report["stages"][1].update(scenario="lostReceipt"),
            "reused process": lambda report: report["stages"][-1].update(processID=100),
            "unobserved host": lambda report: report["stages"][-1].update(eventProcessIDs=[100, 101, 102, 999]),
            "cached ledger": lambda report: report["stages"][-1].update(lastEventSequence=report["stages"][-2]["lastEventSequence"]),
            "changed event totals": lambda report: report["stages"][-1]["eventCounts"].update(accepted=2),
            "changed summary": lambda report: report["proof"].update(interceptedSubmissionAttempts=2),
            "failed controller": lambda report: report["checks"][0].update(status="FAIL"),
            "nonzero controller": lambda report: report["checks"][0].update(exitCode=1),
            "missing command exit": lambda report: report["checks"][0].pop("exitCode"),
            "boolean command exit": lambda report: report["checks"][0].update(exitCode=False),
            "missing installation": lambda report: report.update(checks=[item for item in report["checks"]
                                                                         if item["name"] != "install-hardware-validation-app"]),
            "physical claim": lambda report: report.update(physicalDevice="PASS"),
        }
        for name, change in changes.items():
            report = complete_report()
            change(report)
            with self.subTest(mutation=name), self.assertRaises(SIMULATOR.ValidationFailure):
                SIMULATOR.validate_report(report, REVISION, "acceptedReceipt")

    def test_four_stage_accepted_receipt_recovery_proof(self):
        stages = [validated(action, 100 + index) for index, action in enumerate(SIMULATOR.ACTIONS)]
        terminations = fixture()["terminations"]
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
        correct = fixture()["terminations"]
        cases = [[], correct[:2], [{"status": "NOT RUN", "processID": 100}] + correct[1:],
                 [{"status": "PASS", "processID": 999}] + correct[1:]]
        for termination in cases:
            with self.subTest(termination=termination), self.assertRaises(SIMULATOR.ValidationFailure):
                SIMULATOR.validate_sequence(stages, termination)

    def test_relaunch_cannot_replace_operation_or_return_cached_result_only(self):
        stages = [validated(action, 100 + index) for index, action in enumerate(SIMULATOR.ACTIONS)]
        termination = fixture()["terminations"]
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
