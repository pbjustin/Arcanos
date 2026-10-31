"""Real loopback protocol clients, durable journals, and disposable native jobs."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import uuid

from .common import clean_env, pid_alive, read_jsonl, run_child, standalone_repo, write_json

_FIXTURE_CREDENTIAL = "example-assignment-executor-credential-000000000000"


class LocalTransport:
    def __init__(self, spec: dict):
        self.spec = spec
        self.requests: list[dict] = []
        self.results: list[dict] = []
        self.heartbeat_count = 0
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                authorized = self.headers.get("Authorization") == f"Bearer {_FIXTURE_CREDENTIAL}"
                fixture.requests.append({"method": "POST", "path": self.path, "authorized": authorized})
                status, payload = fixture.respond(self.path, body, authorized)
                encoded = json.dumps(payload).encode() if payload is not None else b""
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def respond(self, path: str, body: dict, authorized: bool):
        if not authorized:
            return 401, {"ok": False, "code": "LOCAL_AGENT_UNAUTHORIZED"}
        if path == "/gpt-access/local-agent/heartbeat":
            return 204, None
        if path == "/gpt-access/local-agent/jobs/claim":
            action = "tests.run"
            stamp = datetime.now(timezone.utc)
            expiry = stamp + timedelta(seconds=2 if self.spec["case"] == "timeout" else 120)
            return 200, {"ok": True, "code": "LOCAL_AGENT_JOB_CLAIMED", "result": {
                "protocolVersion": "local-agent-job-v1", "disposition": "CLAIMED", "state": "RUNNING",
                "jobId": self.spec["job_id"], "action": action, "payload": {"profile": "python-unit"},
                "principal": "requesting-principal", "workspace": "personal", "deviceId": "device-1",
                "traceId": "trace-1", "requestId": "request-1", "idempotencyKey": "acceptance-turn-1",
                "authorization": {"decision": "allow" if self.spec["case"] == "unauthorized" else "confirmed",
                                  "evidenceId": "acceptance-policy-evidence", "evaluatedAt": stamp.isoformat()},
                "expiresAt": expiry.isoformat(), "timeoutMs": 900000,
                "requiredDeviceScopes": ["tests.run"], "readOnly": False, "mayModifyFiles": True,
            }}
        if path.endswith("/heartbeat"):
            self.heartbeat_count += 1
            if self.spec["case"] == "authority_lost" and self.heartbeat_count > 1:
                return 403, {"ok": False, "code": "LOCAL_AGENT_AUTHORITY_LOST"}
            return 204, None
        if path.endswith("/result"):
            self.results.append(body)
            if self.spec["case"] == "pending_replay" and len(self.results) == 1:
                return 503, {"ok": False, "code": "LOCAL_AGENT_RESULT_PERSISTENCE_FAILED"}
            outcome = body["outcome"]
            return 200, {"ok": True, "code": "LOCAL_AGENT_JOB_RESULT_ACCEPTED", "protocolVersion": "local-agent-job-v1",
                         "result": {"jobId": self.spec["job_id"], "state": "COMPLETED" if outcome == "succeeded" else "FAILED",
                                    "disposition": "RESULT_ACCEPTED", "acceptanceReceipt": "acceptance-local-receipt"}}
        return 404, {"ok": False, "code": "NOT_FOUND"}


def local_child(spec_path: Path) -> None:
    # Imports occur only after clean_env's profile and socket guard are active.
    from arcanos.agentic.history_db import HistoryDB
    from arcanos.agentic.policy_guard import PolicyGuard
    from arcanos.local_agent.runner import build_local_agent_execution_runner

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if spec["case"] == "safe_mode":
        PolicyGuard(HistoryDB()).enable_safe_mode("acceptance", "synthetic operator policy")
    runner = build_local_agent_execution_runner(dry_run=lambda: spec["case"] == "dry_run")
    dispositions = [runner.run_once().disposition]
    if spec["case"] == "pending_replay":
        dispositions.append(runner.run_once().disposition)
    run = runner.journal.load_run(spec["job_id"])
    print("ASSIGNMENT_RECEIPT=" + json.dumps({"pid": __import__("os").getpid(), "dispositions": dispositions,
          "journal_state": run.state if run else None, "pending_result": run.pending_result if run else None}))


def run(case_root: Path, source_root: Path) -> dict:
    cases = []
    for name in ("success", "private_output", "failed_profile", "bad_credential", "unauthorized", "dry_run", "safe_mode", "pending_replay", "authority_lost", "timeout"):
        root = case_root / name
        spec = {"case": name, "job_id": str(uuid.uuid4())}
        with LocalTransport(spec) as transport:
            extra = {
                "ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN": _FIXTURE_CREDENTIAL if name != "bad_credential" else "example-wrong-executor-credential-000000000000",
                "ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID": "executor-principal",
                "ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID": "instance-1", "ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID": "device-1",
                "ARCANOS_LOCAL_AGENT_HEARTBEAT_SECONDS": "1",
                "ARCANOS_LOCAL_AGENT_ACTIONS": "tests.run", "ARCANOS_LOCAL_AGENT_DEVICE_SCOPES": "tests.run",
                "ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE": "unsandboxed-development-only",
                "ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS": "true", "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            }
            env = clean_env(root, source_root, transport.url, extra)
            repo = standalone_repo(root / "workspace", env)
            env["ARCANOS_LOCAL_AGENT_WORKSPACES_JSON"] = json.dumps({"personal": str(repo)})
            tests = repo / "daemon-python/tests"
            tests.mkdir(parents=True)
            (tests.parent / "pytest.ini").write_text("[pytest]\naddopts = -s --disable-plugin-autoload\n", encoding="utf-8")
            # Production intentionally isolates PYTHONPATH for pytest. Install the
            # same network observer in this disposable test configuration only.
            guard = source_root / "daemon-python/scripts"
            (tests / "conftest.py").write_text(
                "import sys,os\nsys.path.insert(0," + repr(str(guard)) + ")\n"
                + "os.environ['ACCEPTANCE_NETWORK_LOG']=" + repr(env["ACCEPTANCE_NETWORK_LOG"]) + "\n"
                + "os.environ['ACCEPTANCE_ALLOWED_PORTS']=" + repr(env["ACCEPTANCE_ALLOWED_PORTS"]) + "\n"
                + "from local_action_acceptance.guard import install\ninstall()\n", encoding="utf-8")
            counter = repo / "executions.log"
            completion = repo / "completed-marker"
            test_source = (
                "from pathlib import Path\nimport os,time\ndef test_selected_local_fixture():\n"
                f"    p=Path({str(counter)!r})\n    p.open('a',encoding='utf-8').write(str(os.getpid())+'\\n')\n"
                "    print('safe approved line one\\nsafe approved line two')\n"
                "    print('Authorization: Token example-local-agent-credential')\n"
                + ("    print('audit_trace: example-local-agent-private-record')\n" if name == "private_output" else "")
                + ("    time.sleep(6)\n" if name in {"authority_lost", "timeout"} else "")
                + (f"    Path({str(completion)!r}).write_text('completed')\n" if name in {"authority_lost", "timeout"} else "")
                + ("    assert False, 'intentional harmless test failure'\n" if name == "failed_profile" else "    assert True\n")
            )
            (tests / "test_selected.py").write_text(test_source, encoding="utf-8")
            spec_path = root / "spec.json"
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            result = run_child([sys.executable, "-m", "local_action_acceptance.assignments", "--local-child", str(spec_path)], cwd=repo, env=env, timeout=35)
            receipt_line = next((line for line in result["stdout"].splitlines() if line.startswith("ASSIGNMENT_RECEIPT=")), None)
            if result["exit_code"] != 0 or receipt_line is None:
                raise AssertionError(f"Assigned acceptance child {name} failed; exit={result['exit_code']}; diagnostic={result['stderr'][-1500:]}")
            child = json.loads(receipt_line.split("=", 1)[1])
            executions = counter.read_text().splitlines() if counter.exists() else []
            submitted = transport.results
            write_json(root / "observed.json", {"child": child, "submitted": submitted,
                                                "execution_count": len(executions), "requests": transport.requests})
            blocked = name in {"bad_credential", "unauthorized", "dry_run", "safe_mode"}
            assert len(executions) == (0 if blocked else 1), (name, executions, child)
            if name in {"success", "pending_replay", "private_output"}:
                assert submitted[-1]["outcome"] == "succeeded", (name, submitted)
            elif name not in {"bad_credential", "timeout"}:
                assert submitted and submitted[-1]["outcome"] == "failed", (name, submitted, child)
            else:
                assert all(item["outcome"] != "succeeded" for item in submitted)
            if name == "failed_profile":
                assert "exit code 1" in submitted[-1]["error"]["message"]
            if name == "pending_replay":
                assert len(submitted) == 2 and submitted[0] == submitted[1]
            if name == "success":
                assert "safe approved line one\nsafe approved line two" in submitted[-1]["output"]["stdout"]
            if name == "private_output":
                assert submitted[-1]["output"]["stdout"] == "[Tool output withheld]"
            if name in {"authority_lost", "timeout"}:
                assert not completion.exists(), "Cancelled assignment reached its late completion marker"
            assert not any(pid_alive(int(pid)) for pid in executions), "Selected native test process did not exit"
            public = json.dumps(submitted)
            assert "example-local-agent-credential" not in public and "example-local-agent-private-record" not in public
            cases.append({"name": name, "status": "PASS", "evidence_type": "REAL_LOOPBACK_NATIVE_ASSIGNMENT",
                          "controller_child_pid": result["pid"], "runner": child, "native_test_pids": executions,
                          "http_requests": transport.requests, "submission_count": len(submitted),
                          "execution_count": len(executions), "acknowledgment_is_not_execution_success": True,
                          "late_completion_marker_absent": not completion.exists(),
                          "socket_events": read_jsonl(root / "logs/network.jsonl")})
    receipt = {"cases": cases, "http_request_count": sum(len(item["http_requests"]) for item in cases),
               "gates": {"LOCAL_AGENT_ASSIGNMENT": "PASS", "DUPLICATE_EXECUTION_PROTECTION": "PASS"},
               "classifications": [{"area": "Local Agent real HTTP and native test profile", "classification": "MISSING_ACCEPTANCE_COVERAGE"}],
               "cleanup": {"servers_stopped": True, "selected_children_exited": True}}
    receipt["network_observer_scope"] = "Python socket audit hook; native workloads are fixed local fixture code, not an OS network sandbox"
    receipt["pytest_observer_timing"] = "Installed from disposable conftest after core startup; plugin autoload disabled"
    write_json(case_root / "receipt.json", receipt)
    return receipt


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--local-child":
        local_child(Path(sys.argv[2]))
    else:
        raise SystemExit("Use the Windows acceptance receipt runner")
