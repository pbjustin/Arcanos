#!/usr/bin/env python3
"""Exercise the recovery core across real processes, files, and loopback HTTP.

The server and credential are synthetic. This does not run the app lifecycle,
Keychain, TLS, production authentication, a worker, or a provider.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4


VERSION = "ios-operation-recovery-e2e/v1"
ORIGIN = "https://recovery.example.invalid"
DEVICE = "11111111-1111-4111-8111-111111111111"
JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROMPT = "RECOVERY_PROMPT_SENTINEL"
RESULT = "RECOVERY_RESULT_SENTINEL"
ASSERTIONS = {
    "submit": ["intent_persisted_before_create", "accepted_handle_persisted"],
    "submit-uncertain": ["intent_persisted_before_create", "transport_loss_recorded_uncertain"],
    "recover-uncertain": ["unresolved_intent_restored", "duplicate_prepare_rejected", "no_automatic_replay"],
    "recover": ["accepted_handle_restored", "pending_observed", "completed_result_observed",
                "terminal_state_durable", "late_callbacks_preserve_terminal"],
    "mismatch": ["accepted_handle_restored", "mismatched_result_rejected", "durable_index_unchanged"],
    "denied": ["accepted_handle_restored", "authentication_denial_preserves_index"],
    "wrong-device": ["foreign_partition_hidden", "no_network"],
    "wrong-origin": ["foreign_partition_hidden", "no_network"],
    "check-terminal": ["terminal_state_restored", "no_network"],
}
REQUEST_COUNTS = {"submit": 1, "submit-uncertain": 1, "recover": 2, "mismatch": 1, "denied": 1}
PHASES = ["submit", "wrong-device", "wrong-origin", "mismatch", "denied", "recover", "check-terminal",
          "submit-uncertain", "recover-uncertain", "submit-crash", "recover-uncertain"]


class ProofFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ProofFailure(code)


class Fixture:
    def __init__(self, directory, source_sha, fault):
        self.directory = directory
        self.source_sha = source_sha
        self.fault = fault
        self.run_id = str(uuid4())
        # These values are generated test credentials, never an application secret.
        self.token = "fixture-only-test-" + str(uuid4())
        self.mode = None
        self.operation_id = None
        self.store = None
        self.requests = []
        self.creates = {}
        self.result_reads = 0
        self.errors = []
        self.accepted = threading.Event()
        self.release = threading.Event()
        self.server = None

    def inspect_store(self):
        data = self.store.read_bytes()
        require(len(data) < 16_384, "INDEX_SIZE_INVALID")
        for sentinel in [self.token, PROMPT, RESULT, "Bearer ", "confirmation_token"]:
            require(sentinel.encode() not in data, "SENSITIVE_CONTENT_PERSISTED")
        records = json.loads(data)
        require(isinstance(records, list) and len(records) == 1, "INDEX_RECORD_COUNT_INVALID")
        record = records[0]
        require(record["id"].lower() == self.operation_id, "INDEX_OPERATION_ID_INVALID")
        require(record["partition"] == {"origin": ORIGIN, "deviceID": DEVICE}, "INDEX_PARTITION_INVALID")
        return record

    def config(self):
        return {"version": VERSION, "mode": self.mode, "runId": self.run_id,
                "sourceSha": self.source_sha, "baseURL": "http://127.0.0.1:" + str(self.server.server_port),
                "storePath": str(self.store), "operationID": self.operation_id,
                "deviceID": DEVICE, "origin": ORIGIN, "token": self.token}

    def handle(self, request):
        require(request.command == "POST", "HTTP_METHOD_INVALID")
        require(request.headers.get("Authorization") == "Bearer " + self.token, "AUTH_HEADER_INVALID")
        require(request.headers.get("X-Arcanos-Device-Origin") == ORIGIN, "ORIGIN_HEADER_INVALID")
        require(request.headers.get("X-Arcanos-Fixture-Run-Id") == self.run_id, "RUN_HEADER_INVALID")
        require(request.headers.get("Content-Type") == "application/json", "CONTENT_TYPE_INVALID")
        length = int(request.headers.get("Content-Length", "0"))
        require(0 < length <= 16_384, "REQUEST_LENGTH_INVALID")
        body = json.loads(request.rfile.read(length))
        self.requests.append({"mode": self.mode, "path": request.path})
        require(len(self.requests) <= 12, "REQUEST_BUDGET_EXCEEDED")
        if request.path == "/gpt-access/jobs/create":
            require(self.mode in ["submit", "submit-uncertain", "submit-crash"], "UNEXPECTED_CREATE")
            record = self.inspect_store()
            require(record["localState"] == "prepared" and record.get("backendJobID") is None,
                    "INTENT_NOT_DURABLE_BEFORE_CREATE")
            require(body["task"] == PROMPT, "CREATE_PROMPT_INVALID")
            require(body["idempotencyKey"] == record["idempotencyKey"], "CREATE_IDEMPOTENCY_MISMATCH")
            require(body["idempotencyKey"].lower() == "fixture-operation-" + self.operation_id,
                    "CREATE_IDEMPOTENCY_INVALID")
            count = self.creates.get(self.operation_id, 0) + 1
            self.creates[self.operation_id] = count
            require(count == 1, "DUPLICATE_SUBMISSION")
            if self.mode == "submit-crash":
                self.accepted.set()
                require(self.release.wait(15), "CRASH_FIXTURE_NOT_RELEASED")
                return None
            if self.mode == "submit-uncertain":
                return None
            return 202, {"ok": True, "jobId": JOB, "traceId": self.run_id,
                         "status": "queued", "deduped": False, "resultEndpoint": "/gpt-access/jobs/result"}
        require(request.path == "/gpt-access/jobs/result", "HTTP_ROUTE_INVALID")
        require(body["jobId"] == JOB, "RECOVERED_JOB_ID_MISMATCH")
        require(self.mode in ["recover", "mismatch", "denied"], "UNEXPECTED_RESULT_READ")
        if self.mode == "denied":
            return 401, {"ok": False, "error": {"code": "DEVICE_SESSION_REJECTED", "message": "Fixture denial"}}
        self.result_reads += 1
        completed = self.mode == "mismatch" or self.result_reads == 2
        status = "completed" if completed else "pending"
        job_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" if self.mode == "mismatch" else JOB
        result = RESULT if self.fault != "corrupt-completion" else "WRONG_FIXTURE_RESULT"
        return 200, {"ok": True, "traceId": self.run_id, "jobId": job_id, "status": status,
                     "jobStatus": "completed" if completed else "running",
                     "lifecycleStatus": "completed" if completed else "running",
                     "createdAt": None, "updatedAt": None, "completedAt": None,
                     "retentionUntil": None, "idempotencyUntil": None, "expiresAt": None,
                     "poll": "/gpt-access/jobs/result", "stream": "", "resultEndpoint": "/gpt-access/jobs/result",
                     "result": result if completed else None, "error": None}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        pass

    def do_POST(self):
        self.connection.settimeout(10)
        try:
            response = self.server.fixture.handle(self)
            if response is None:
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass  # The crash phase intentionally kills the peer first.
                self.connection.close()
                return
            status, body = response
        except Exception as error:
            self.server.fixture.errors.append(str(error) if isinstance(error, ProofFailure) else "HTTP_FIXTURE_FAILED")
            status, body = 500, {"ok": False}
        payload = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            self.server.fixture.errors.append("UNEXPECTED_SOCKET_CLOSE")


def run_child(binary, fixture, mode, reports, kill_after_accept=False):
    fixture.mode = mode
    fixture.result_reads = 0
    before = len(fixture.requests)
    environment = {key: os.environ[key] for key in [
        "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR",
        "LD_LIBRARY_PATH", "DEVELOPER_DIR", "SDKROOT"
    ] if key in os.environ}
    process = subprocess.Popen([str(binary), "--execute", "--allow-loopback"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=environment)
    try:
        input_data = json.dumps(fixture.config()).encode()
        if kill_after_accept:
            process.stdin.write(input_data)
            process.stdin.close()
            process.stdin = None
            require(fixture.accepted.wait(10), "CREATE_NOT_OBSERVED_BEFORE_CRASH")
            require(process.poll() is None, "CHILD_EXITED_BEFORE_FORCED_TERMINATION")
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
            require(process.returncode == -signal.SIGKILL and not stdout, "PROCESS_NOT_TERMINATED_BEFORE_RECEIPT")
            report = {"mode": mode, "pid": process.pid, "expectedTermination": True,
                      "assertions": ["process_terminated_after_server_accept_before_receipt"]}
        else:
            stdout, stderr = process.communicate(input_data, timeout=20)
            require(len(stdout) <= 16_384 and len(stderr) <= 16_384, "CHILD_OUTPUT_BUDGET_EXCEEDED")
            report = json.loads(stdout)
            require(report.get("mode") == mode and report.get("runId") == fixture.run_id
                    and report.get("sourceSha") == fixture.source_sha and report.get("pid") == process.pid,
                    "CHILD_IDENTITY_INVALID")
            if process.returncode != 0 and mode == "recover" and fixture.fault == "corrupt-completion" \
                    and fixture.result_reads == 2 and report.get("ok") is False \
                    and report.get("version") == VERSION and not fixture.errors \
                    and report.get("assertions") == ASSERTIONS["recover"][:2] \
                    and report.get("requestsMade") == 2 and len(fixture.requests) - before == 2 \
                    and report.get("failure") == "COMPLETED_RESULT_MISMATCH":
                raise ProofFailure("CORRUPTED_COMPLETION_REJECTED")
            require(process.returncode == 0, "CHILD_FAILED_" + mode.upper().replace("-", "_"))
            require(report.get("version") == VERSION and report.get("ok") is True, "CHILD_PROOF_INVALID")
            require(report.get("assertions") == ASSERTIONS[mode], "CHILD_ASSERTIONS_INCOMPLETE")
            require(report.get("requestsMade") == REQUEST_COUNTS.get(mode, 0), "CHILD_REQUEST_COUNT_INVALID")
        require(not fixture.errors, fixture.errors[0] if fixture.errors else "HTTP_FIXTURE_FAILED")
        expected = 1 if kill_after_accept else REQUEST_COUNTS.get(mode, 0)
        require(len(fixture.requests) - before == expected, "SERVER_REQUEST_COUNT_INVALID")
        require(process.pid not in [item["pid"] for item in reports], "PROCESS_ID_REUSED")
        reports.append(report)
    finally:
        fixture.release.set()
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


def execute(binary, source_sha, fault):
    reports = []
    with tempfile.TemporaryDirectory(prefix="arcanos-recovery-e2e-") as directory:
        fixture = Fixture(Path(directory), source_sha, fault)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = False
        fixture.server = server
        server.fixture = fixture
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            fixture.operation_id = str(uuid4())
            fixture.store = Path(directory) / "accepted" / "operations.json"
            run_child(binary, fixture, "submit", reports)
            require(fixture.inspect_store()["localState"] == "accepted", "ACCEPTANCE_NOT_DURABLE")
            original = fixture.store.read_bytes()
            for mode in ["wrong-device", "wrong-origin", "mismatch", "denied"]:
                run_child(binary, fixture, mode, reports)
                require(fixture.store.read_bytes() == original, "FAILED_READ_CHANGED_DURABLE_STATE")
            run_child(binary, fixture, "recover", reports)
            require(fixture.inspect_store()["localState"] == "terminal", "COMPLETION_NOT_DURABLE")
            run_child(binary, fixture, "check-terminal", reports)
            require(fixture.creates[fixture.operation_id] == 1, "ACCEPTED_OPERATION_REPLAYED")

            fixture.operation_id = str(uuid4())
            fixture.store = Path(directory) / "lost-receipt" / "operations.json"
            run_child(binary, fixture, "submit-uncertain", reports)
            require(fixture.inspect_store()["localState"] == "submissionUncertain", "UNCERTAINTY_NOT_DURABLE")
            run_child(binary, fixture, "recover-uncertain", reports)
            require(fixture.creates[fixture.operation_id] == 1, "UNCERTAIN_OPERATION_REPLAYED")

            fixture.operation_id = str(uuid4())
            fixture.store = Path(directory) / "killed-process" / "operations.json"
            fixture.release.clear()
            run_child(binary, fixture, "submit-crash", reports, kill_after_accept=True)
            require(fixture.inspect_store()["localState"] == "prepared", "CRASH_INTENT_NOT_PRESERVED")
            run_child(binary, fixture, "recover-uncertain", reports)
            require(fixture.creates[fixture.operation_id] == 1, "CRASHED_OPERATION_REPLAYED")
            require(len(fixture.creates) == 3 and len(fixture.requests) == 7, "FINAL_REQUEST_ACCOUNTING_INVALID")
            require([report["mode"] for report in reports] == PHASES, "PHASE_SEQUENCE_INCOMPLETE")
            result = {"phases": reports, "processCount": len(reports), "requestsMade": len(fixture.requests),
                      "createRequests": sum(fixture.creates.values()), "independentChecks": [
                          "intent_on_disk_before_each_create", "distinct_processes_and_exact_phase_assertions",
                          "wire_auth_origin_and_job_identity", "no_credentials_prompts_or_results_in_index",
                          "one_create_per_operation_across_restarts", "failed_reads_leave_index_unchanged",
                          "lost_receipt_and_killed_process_do_not_replay"]}
        finally:
            fixture.release.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            require(not thread.is_alive(), "FIXTURE_SERVER_CLEANUP_FAILED")
        require(not fixture.errors, fixture.errors[0] if fixture.errors else "HTTP_FIXTURE_FAILED")
    require(not Path(directory).exists(), "FIXTURE_STORE_CLEANUP_FAILED")
    result["cleanupConfirmed"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swift-binary", required=True, type=Path)
    parser.add_argument("--inject-fault", choices=["corrupt-completion"])
    arguments = parser.parse_args()
    report = {"version": VERSION, "ok": False, "scope": "recovery-core-process-file-loopback",
              "shippingAppLifecycle": False, "physicalDevice": False, "liveBackend": False, "tls": False}
    try:
        require(os.name == "posix", "POSIX_PROCESS_TERMINATION_REQUIRED")
        binary = arguments.swift_binary.resolve(strict=True)
        require(binary.is_file() and os.access(binary, os.X_OK), "SWIFT_BINARY_UNAVAILABLE")
        repository = Path(__file__).resolve().parents[3]
        source_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=repository))
        report.update(sourceSha=source_sha, sourceDirty=dirty,
                      binarySHA256=hashlib.sha256(binary.read_bytes()).hexdigest())
        report.update(execute(binary, source_sha, arguments.inject_fault))
        require(arguments.inject_fault is None, "CORRUPTED_COMPLETION_WAS_ACCEPTED")
        if arguments.inject_fault is None:
            try:
                execute(binary, source_sha, "corrupt-completion")
            except ProofFailure as error:
                require(str(error) == "CORRUPTED_COMPLETION_REJECTED", "NEGATIVE_CONTROL_FAILED_UNEXPECTEDLY")
                report["negativeControl"] = {"fault": "corrupt-completion", "rejected": True,
                                             "childFailure": "COMPLETED_RESULT_MISMATCH"}
            else:
                raise ProofFailure("CORRUPTED_COMPLETION_WAS_ACCEPTED")
        report["ok"] = True
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, ProofFailure) else "RECOVERY_PROOF_FAILED"
    print(json.dumps(report, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
