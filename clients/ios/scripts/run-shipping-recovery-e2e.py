#!/usr/bin/env python3
"""Exercise the shipping session/composition adapters across disposable processes.

No developer configuration is loaded. A parent-owned loopback fixture and injected
Keychain/local-model doubles supply all remote and Apple-only dependencies. The
real app and App Intents call these shared adapters; this is not actual Siri,
Simulator runtime, Keychain, TLS, provider or live Gateway evidence.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import select
import signal
import subprocess
import tempfile
import threading
from http.server import ThreadingHTTPServer
from uuid import uuid4

# Reuse the established HTTP containment, socket cleanup and failure reporting.
_spec = importlib.util.spec_from_file_location("core_recovery_fixture", Path(__file__).with_name("run-operation-recovery-e2e.py"))
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)
require, ProofFailure, Handler = core.require, core.ProofFailure, core.Handler

VERSION = "ios-shipping-recovery-e2e/v1"
ORIGIN, DEVICE, JOB = core.ORIGIN, core.DEVICE, core.JOB
PROMPT, RESULT = "SHIPPING_RECOVERY_PROMPT_SENTINEL", "SHIPPING_RECOVERY_RESULT_SENTINEL"
ASSERTIONS = {
    "submit-held": ["shipping_ask_returned_pending_with_durable_receipt"],
    "submit-uncertain": ["shipping_submission_uncertainty_persisted"],
    "startup": ["shipping_startup_restored_accepted_operation", "repeated_startup_foreground_read_only"],
    "recover-uncertain": ["shipping_restart_does_not_replay_uncertain_submission"],
    "status": ["shipping_intent_adapter_verified_same_operation_result"],
    "terminal-status": ["shipping_intent_adapter_verified_same_operation_result"],
    "race-pending": ["late_process_observation_preserves_verified_completion"],
}
for _mode in ["mismatch", "corrupt", "network", "denied", "unpaired", "expired", "revoked", "locked", "wrong-device", "wrong-origin"]:
    ASSERTIONS[_mode] = ["shipping_unavailable_or_foreign_result_rejected", "local_request_independent_of_credentials"]
COUNTS = {"submit-held": 1, "submit-uncertain": 1, "submit-crash": 1, "startup": 3,
          "status": 1, "terminal-status": 1, "race-pending": 1, "mismatch": 1, "corrupt": 1, "network": 1, "denied": 1}


class Fixture:
    def __init__(self, directory, source_sha, fault):
        self.directory, self.source_sha, self.fault = directory, source_sha, fault
        self.run_id = str(uuid4())
        self.token = "agd1." + secrets.token_urlsafe(32)  # Synthetic, independently injected per child.
        self.mode, self.operation_id, self.store = None, None, None
        self.requests, self.errors, self.creates, self.semantic_executions = [], [], {}, {}
        self.accepted, self.release = threading.Event(), threading.Event()
        self.pending_read, self.release_pending = threading.Event(), threading.Event()
        self.concurrent_barrier = None
        self.server = None
        self.lock = threading.Lock()

    def inspect_store(self):
        data = self.store.read_bytes()
        require(len(data) < 16_384, "INDEX_SIZE_INVALID")
        for sentinel in [self.token, PROMPT, RESULT, "Bearer ", "confirmation_token"]:
            require(sentinel.encode() not in data, "SENSITIVE_CONTENT_PERSISTED")
        records = json.loads(data)
        require(isinstance(records, list) and len(records) == 1, "INDEX_RECORD_COUNT_INVALID")
        record = records[0]
        if self.operation_id is None:
            self.operation_id = record["id"].lower()
        require(record["id"].lower() == self.operation_id, "INDEX_OPERATION_CHANGED")
        require(record["partition"] == {"origin": ORIGIN, "deviceID": DEVICE}, "INDEX_PARTITION_INVALID")
        require(record["idempotencyKey"] and len(record["idempotencyKey"]) <= 240, "IDEMPOTENCY_INVALID")
        return record

    def config(self):
        return {"version": VERSION, "mode": self.mode, "runId": self.run_id, "sourceSha": self.source_sha,
                "baseURL": "http://127.0.0.1:" + str(self.server.server_port), "origin": ORIGIN,
                "storePath": str(self.store), "deviceID": DEVICE, "token": self.token,
                "operationID": self.operation_id, "disableRecovery": self.fault == "wiring-disabled"}

    def handle(self, request):
        mode = self.mode
        require(request.command == "POST", "METHOD_INVALID")
        require(request.headers.get("Authorization") == "Bearer " + self.token, "AUTH_HEADER_INVALID")
        require(request.headers.get("X-Arcanos-Device-Origin") == ORIGIN, "ORIGIN_HEADER_INVALID")
        require(request.headers.get("X-Arcanos-Fixture-Run-Id") == self.run_id, "RUN_HEADER_INVALID")
        require(request.headers.get("Content-Type") == "application/json", "CONTENT_TYPE_INVALID")
        length = int(request.headers.get("Content-Length", "0"))
        require(0 < length <= 16_384, "REQUEST_LENGTH_INVALID")
        body = json.loads(request.rfile.read(length))
        with self.lock:
            self.requests.append({"mode": mode, "path": request.path, "operationID": self.operation_id})
            require(len(self.requests) <= 32, "REQUEST_BUDGET_EXCEEDED")
        if request.path == "/gpt-access/jobs/create":
            require(mode in ["submit-held", "submit-uncertain", "submit-crash"], "RESTORATION_SUBMITTED_WORK")
            record = self.inspect_store()  # Checked before the fixture admits submission.
            require(record["localState"] == "prepared" and record.get("backendJobID") is None,
                    "INTENT_NOT_DURABLE_BEFORE_SUBMISSION")
            require(body["task"] == PROMPT and body["gptId"] == "arcanos-core", "SUBMISSION_BODY_INVALID")
            require(body["idempotencyKey"] == record["idempotencyKey"], "IDEMPOTENCY_CONTEXT_CHANGED")
            require("confirmation_token" not in body, "RESTORATION_APPROVED_EXECUTION")
            self.creates[self.operation_id] = self.creates.get(self.operation_id, 0) + 1
            semantic_key = (ORIGIN, DEVICE, body["idempotencyKey"])
            self.semantic_executions.setdefault(semantic_key, self.operation_id)
            require(self.creates[self.operation_id] == 1, "DUPLICATE_HTTP_SUBMISSION")
            if mode == "submit-crash":
                self.accepted.set()
                require(self.release.wait(15), "CRASH_FIXTURE_NOT_RELEASED")
                return None
            if mode == "submit-uncertain":
                return None
            return 202, {"ok": True, "jobId": JOB, "traceId": self.run_id, "status": "queued",
                         "deduped": False, "resultEndpoint": "/gpt-access/jobs/result"}
        require(request.path == "/gpt-access/jobs/result", "UNEXPECTED_ROUTE")
        require(body == {"jobId": JOB}, "RECOVERED_JOB_ID_INVALID")
        require(mode in ["startup", "status", "terminal-status", "race-pending", "mismatch", "corrupt", "network", "denied"], "UNEXPECTED_READ")
        if mode == "startup" and self.concurrent_barrier is not None:
            self.concurrent_barrier.wait(timeout=10)
        if mode == "race-pending":
            self.pending_read.set()
            require(self.release_pending.wait(10), "LATE_OBSERVATION_NOT_RELEASED")
        if mode == "network":
            return None
        if mode == "denied":
            return 401, {"ok": False, "error": {"code": "DEVICE_SESSION_REJECTED", "message": "Fixture denial"}}
        completed = mode not in ["startup", "race-pending"]
        result = {"unexpected": True} if mode == "corrupt" else RESULT
        return 200, {"ok": True, "traceId": self.run_id,
                     "jobId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" if mode == "mismatch" else JOB,
                     "status": "completed" if completed else "pending", "jobStatus": "completed" if completed else "running",
                     "lifecycleStatus": "completed" if completed else "running", "createdAt": None, "updatedAt": None,
                     "completedAt": None, "retentionUntil": None, "idempotencyUntil": None, "expiresAt": None,
                     "poll": "/gpt-access/jobs/result", "stream": "", "resultEndpoint": "/gpt-access/jobs/result",
                     "result": result if completed else None, "error": None}


def start_child(binary, fixture):
    environment = {key: os.environ[key] for key in ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR",
                   "LD_LIBRARY_PATH", "DEVELOPER_DIR", "SDKROOT"] if key in os.environ}
    process = subprocess.Popen([str(binary), "--execute", "--allow-loopback"], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    process.stdin.write(json.dumps(fixture.config()).encode())
    process.stdin.close()
    process.stdin = None
    return process


def finish_child(process, fixture, mode, reports):
    try:
        if mode == "submit-held":
            ready, _, _ = select.select([process.stdout], [], [], 15)
            require(bool(ready), "PENDING_INTERACTION_DID_NOT_END")
            output = process.stdout.readline(16_385)
            require(output.endswith(b"\n"), "PENDING_REPORT_INVALID")
            report = json.loads(output)
            require(report.get("ok") is True, report.get("failure", "SHIPPING_SUBMISSION_FAILED"))
            require(fixture.inspect_store()["localState"] == "accepted", "RECEIPT_NOT_PERSISTED_BEFORE_KILL")
            require(process.poll() is None, "PROCESS_EXITED_BEFORE_KILL")
            process.kill()
            trailing, stderr = process.communicate(timeout=5)
            require(process.returncode == -signal.SIGKILL and not trailing, "FORCED_TERMINATION_FAILED")
            report["expectedTermination"] = "SIGKILL-after-interaction-ended-and-receipt-persisted"
        elif mode == "submit-crash":
            require(fixture.accepted.wait(10), "SERVER_DID_NOT_ACCEPT_BEFORE_KILL")
            require(process.poll() is None, "PROCESS_EXITED_BEFORE_KILL")
            process.kill()
            output, stderr = process.communicate(timeout=5)
            require(process.returncode == -signal.SIGKILL and not output, "PROCESS_NOT_KILLED_BEFORE_RECEIPT")
            report = {"mode": mode, "pid": process.pid, "operationID": fixture.operation_id, "requestsMade": 1,
                      "expectedTermination": "SIGKILL-before-receipt", "assertions": ["shipping_intent_durable_before_lost_receipt"]}
            fixture.release.set()
        else:
            output, stderr = process.communicate(timeout=25)
            require(len(output) <= 16_384, "CHILD_OUTPUT_BUDGET_EXCEEDED")
            report = json.loads(output)
            if fixture.fault == "wiring-disabled" and mode == "startup":
                require(process.returncode == 1 and report.get("ok") is False
                        and report.get("failure") == "SHIPPING_RECOVERY_WIRING_BYPASSED"
                        and report.get("requestsMade") == 0 and not fixture.errors,
                        "NEGATIVE_CONTROL_FAILED_UNEXPECTEDLY")
                raise ProofFailure("SHIPPING_RECOVERY_WIRING_BYPASSED")
            require(process.returncode == 0, report.get("failure", "CHILD_FAILED_" + mode.upper()))
        require(len(stderr) <= 16_384, "CHILD_ERROR_BUDGET_EXCEEDED")
        if mode != "submit-crash":
            require(report.get("version") == VERSION and report.get("ok") is True, "CHILD_PROOF_INVALID")
            require(report.get("mode") == mode and report.get("runId") == fixture.run_id
                    and report.get("sourceSha") == fixture.source_sha and report.get("pid") == process.pid, "CHILD_IDENTITY_INVALID")
            require(report.get("assertions") == ASSERTIONS[mode], "CHILD_ASSERTIONS_INCOMPLETE")
        require(report.get("requestsMade") == COUNTS.get(mode, 0), "CHILD_REQUEST_COUNT_INVALID")
        require(report.get("operationID", "").lower() == fixture.operation_id, "CROSS_PROCESS_OPERATION_CHANGED")
        require(process.pid not in [item["pid"] for item in reports], "PROCESS_ID_REUSED")
        require(not fixture.errors, fixture.errors[0] if fixture.errors else "FIXTURE_FAILED")
        reports.append(report)
    finally:
        if process.poll() is None:
            process.kill(); process.communicate(timeout=5)


def run_child(binary, fixture, mode, reports):
    fixture.mode = mode
    before = len(fixture.requests)
    finish_child(start_child(binary, fixture), fixture, mode, reports)
    require(len(fixture.requests) - before == COUNTS.get(mode, 0), "SERVER_REQUEST_COUNT_INVALID")


def execute(binary, source_sha, fault=None):
    reports = []
    with tempfile.TemporaryDirectory(prefix="arcanos-shipping-recovery-") as directory:
        fixture = Fixture(Path(directory), source_sha, fault)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = False
        fixture.server = server; server.fixture = fixture
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            fixture.store = Path(directory) / "accepted" / "operations.json"
            run_child(binary, fixture, "submit-held", reports)
            accepted_id = fixture.operation_id
            for mode in ["wrong-device", "wrong-origin", "unpaired", "expired", "revoked", "locked", "mismatch", "corrupt", "network", "denied"]:
                if fault is None:
                    run_child(binary, fixture, mode, reports)
            run_child(binary, fixture, "startup", reports)
            # Two real processes read/update the same file at overlapping await
            # boundaries. The barrier is deterministic and bounded, not a retry.
            fixture.mode = "startup"
            fixture.concurrent_barrier = threading.Barrier(2)
            before = len(fixture.requests)
            concurrent = [start_child(binary, fixture), start_child(binary, fixture)]
            try:
                for child in concurrent:
                    finish_child(child, fixture, "startup", reports)
            finally:
                fixture.concurrent_barrier = None
                for child in concurrent:
                    if child.poll() is None:
                        child.kill(); child.communicate(timeout=5)
            require(len(fixture.requests) - before == 6, "CONCURRENT_READ_COUNT_INVALID")
            fixture.mode = "race-pending"
            delayed = start_child(binary, fixture)
            try:
                require(fixture.pending_read.wait(10), "OVERLAPPING_PENDING_READ_NOT_STARTED")
                run_child(binary, fixture, "status", reports)
                require(fixture.inspect_store()["localState"] == "terminal", "OVERLAPPING_COMPLETION_NOT_DURABLE")
                fixture.release_pending.set()
                finish_child(delayed, fixture, "race-pending", reports)
            finally:
                fixture.release_pending.set()
                if delayed.poll() is None:
                    delayed.kill(); delayed.communicate(timeout=5)
            run_child(binary, fixture, "terminal-status", reports)
            require(fixture.inspect_store()["localState"] == "terminal", "COMPLETION_NOT_DURABLE")
            require(fixture.creates[accepted_id] == 1, "ACCEPTED_OPERATION_RESUBMITTED")
            accepted_requests = len(fixture.requests)

            for submit in ["submit-uncertain", "submit-crash"]:
                fixture.operation_id = None
                fixture.store = Path(directory) / submit / "operations.json"
                fixture.accepted.clear(); fixture.release.clear()
                run_child(binary, fixture, submit, reports)
                expected = "prepared" if submit == "submit-crash" else "submissionUncertain"
                require(fixture.inspect_store()["localState"] == expected, "UNCERTAIN_STATE_NOT_DURABLE")
                run_child(binary, fixture, "recover-uncertain", reports)
                require(fixture.creates[fixture.operation_id] == 1, "UNCERTAIN_OPERATION_RESUBMITTED")
            require(sum(item["requestsMade"] for item in reports) == len(fixture.requests), "FINAL_REQUEST_ACCOUNTING_INVALID")
            require(len(fixture.creates) == 3 and len(fixture.semantic_executions) == 3, "SEMANTIC_EXECUTION_COUNT_INVALID")
            report = {"phases": reports, "processCount": len(reports), "requestsMade": len(fixture.requests),
                      "httpSubmissionAttempts": sum(fixture.creates.values()), "semanticExecutions": len(fixture.semantic_executions),
                      "acceptedReceiptScenario": {"operationID": accepted_id, "jobID": JOB, "requestsMade": accepted_requests,
                                                  "httpSubmissionAttempts": 1, "semanticExecutions": 1},
                      "independentChecks": ["product_intent_persisted_before_wire_submission", "accepted_receipt_before_forced_termination",
                          "distinct_process_memory_and_same_operation_job_partition", "wire_auth_origin_and_idempotency_context",
                          "no_secret_prompt_result_or_confirmation_in_operation_index", "overlapping_app_intent_process_recovery",
                          "late_process_pending_observation_cannot_replace_verified_completion",
                          "lost_receipt_and_killed_process_never_replay", "read_failures_preserve_operation_index",
                          "local_model_independent_of_remote_credentials"]}
        finally:
            fixture.release.set(); fixture.release_pending.set(); server.shutdown(); server.server_close(); thread.join(timeout=5)
            require(not thread.is_alive(), "FIXTURE_CLEANUP_FAILED")
        require(not fixture.errors, fixture.errors[0] if fixture.errors else "FIXTURE_FAILED")
    require(not Path(directory).exists(), "DISPOSABLE_STORE_NOT_REMOVED")
    report["cleanupConfirmed"] = True
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swift-binary", type=Path, required=True)
    parser.add_argument("--inject-fault", choices=["wiring-disabled"])
    args = parser.parse_args()
    report = {"version": VERSION, "ok": False, "scope": "shipping-shared-entry-adapter-process-file-loopback",
              "actualAppIntentExecution": False, "simulatorRuntime": False, "physicalDevice": False,
              "liveBackend": False, "tls": False, "secureStorage": "injected-memory-double"}
    try:
        require(os.name == "posix", "POSIX_PROCESS_PROOF_REQUIRED")
        binary = args.swift_binary.resolve(strict=True)
        require(binary.is_file() and os.access(binary, os.X_OK), "SWIFT_BINARY_UNAVAILABLE")
        repository = Path(__file__).resolve().parents[3]
        source_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
        report.update(sourceSha=source_sha, sourceDirty=bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=repository)),
                      binarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest())
        report.update(execute(binary, source_sha, args.inject_fault))
        require(args.inject_fault is None, "DISABLED_WIRING_WAS_ACCEPTED")
        try:
            execute(binary, source_sha, "wiring-disabled")
        except ProofFailure as error:
            require(str(error) == "SHIPPING_RECOVERY_WIRING_BYPASSED", "NEGATIVE_CONTROL_FAILED_UNEXPECTEDLY")
            report["negativeControl"] = {"fault": "wiring-disabled", "rejected": True,
                "childFailure": "SHIPPING_RECOVERY_WIRING_BYPASSED", "processCount": 2, "requestsMade": 1,
                "httpSubmissionAttempts": 1, "semanticExecutions": 1, "recoveryRequests": 0}
        else:
            raise ProofFailure("DISABLED_WIRING_WAS_ACCEPTED")
        report["includingNegativeControl"] = {
            "processCount": report["processCount"] + 2, "requestsMade": report["requestsMade"] + 1,
            "httpSubmissionAttempts": report["httpSubmissionAttempts"] + 1,
            "semanticExecutions": report["semanticExecutions"] + 1}
        report["ok"] = True
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, ProofFailure) else "SHIPPING_PROOF_FAILED"
    print(json.dumps(report, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
