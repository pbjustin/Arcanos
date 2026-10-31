"""ActionPlan component integration: real HTTP, TTY approval, commands and SQLite.

The child composes existing production objects; it is explicitly not evidence
that the public CLI automatically polls ActionPlans in its normal background loop.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import sys
import time

from .cli import SyntheticBackend
from .common import clean_env, read_jsonl, sha256, standalone_repo, write_json
from .conpty import ConsoleProcess


_INSTANCE = "acceptance-ap-instance"
_PRINCIPAL = "acceptance-ap-principal"
_AGENT = "acceptance-ap-agent"
_REALM = "local:acceptance-ap"
_CREDENTIAL = "acceptance-ap-disclosure-canary"
_PRIVATE = "acceptance-ap-private-canary"


def _base(code: str) -> dict:
    return {"ok": True, "code": code, "protocol_version": "action-plan-execution-v1", "execution_realm": _REALM}


class _Routes:
    """Synthetic server authority and transport, using existing route shapes."""

    def __init__(self):
        self.current = None
        self.mode = "normal"
        self.results: dict[str, list[dict]] = {}
        self.claims = []
        self.starts = []
        self.commands = []

    def assign(self, name: str, command: str, *, mode="normal", timeout_ms=5000):
        self.mode = mode
        self.commands.append({"case": name, "command": command, "timeout_ms": timeout_ms})
        self.current = {
            **_base("ACTION_PLAN_EXECUTION_CLAIMED"),
            "command_id": "command-" + name, "plan_id": "plan-" + name,
            "run_id": "run-" + name, "action_id": "action-" + name,
            "snapshot_id": "snapshot-" + name,
            "snapshot_version": "action-execution-snapshot-v1",
            "plan_execution_generation": 1,
            "lifecycle": {"status": "approved", "expires_at": None},
            "policy": {"category": "DENY" if mode == "unauthorized" else "ALLOW",
                       "evidence_id": "policy-" + name,
                       "evaluated_at": datetime.now(timezone.utc).isoformat()},
            "state": "CLAIMED", "disposition": "CLAIMED",
            "assignment": {"agent_id": _AGENT, "capability": "terminal.run",
                           "params": {"command": command}, "timeout_ms": timeout_ms},
        }

    def __call__(self, method, path, body):
        if path == "/action-plan-executions/protocol":
            return 200, {**_base("ACTION_PLAN_EXECUTION_PROTOCOL_AVAILABLE"),
                         "role": "executor", "executor_principal_id": _PRINCIPAL,
                         "executor_instance_id": _INSTANCE, "assigned_agent_id": _AGENT,
                         "operations": ["claim-next", "claim", "start", "submit-result", "read-status", "read-result"]}
        if path == "/action-plan-executions/claim-next" or path.endswith("/claim"):
            self.claims.append(path)
            if self.current is None:
                return 204, {}
            return 200, self.current
        if not path.startswith("/plans/") or self.current is None:
            return None
        assignment = self.current
        identity = {key: assignment[key] for key in ("plan_id", "run_id", "action_id", "snapshot_id")}
        if path.endswith("/start"):
            self.starts.append(path)
            if self.mode == "revoked_start":
                return 403, {"code": "ACTION_PLAN_EXECUTION_AUTH_REVOKED"}
            if self.mode == "changed_start":
                identity["action_id"] = "different-action"
            return 200, {**_base("ACTION_PLAN_EXECUTION_STARTED"), **identity,
                         "state": "RUNNING", "disposition": "STARTED"}
        if path.endswith("/result") and method == "POST":
            rows = self.results.setdefault(assignment["run_id"], [])
            rows.append(dict(body))
            if self.mode == "retry_result" and len(rows) == 1:
                return 503, {"code": "ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED"}
            outcome = body["outcome"]
            state = "SUCCEEDED" if outcome == "succeeded" else "FAILED"
            return 200, {**_base("ACTION_PLAN_EXECUTION_RESULT_ACCEPTED"), **identity,
                         "state": state, "terminal_category": outcome,
                         "disposition": "RESULT_REPLAY" if len(rows) > 1 else "RESULT_ACCEPTED",
                         "acceptance_receipt": "receipt-" + assignment["run_id"]}
        if path.endswith("/result") and method == "GET":
            return 404, {"code": "ACTION_PLAN_EXECUTION_RESULT_UNAVAILABLE"}
        return 200, {**_base("ACTION_PLAN_EXECUTION_STATUS"), **identity,
                     "state": "RUNNING", "terminal_category": None,
                     "disposition": "STATUS_CURRENT", "acceptance_receipt": None}


class _Child:
    def __init__(self, root: Path, source: Path, backend: SyntheticBackend):
        self.root = root
        self.source = source
        self.backend = backend
        self.root.mkdir(parents=True, exist_ok=True)
        self.executor_token = "acpt-ap-" + secrets.token_urlsafe(32)
        backend.purpose_bound_tokens["/action-plan-executions"] = self.executor_token
        backend.purpose_bound_tokens["/plans/"] = self.executor_token
        self.env = clean_env(root, source, backend_url=backend.url, extra={
            **backend.env,
            "ACTION_PLAN_EXECUTOR_TOKEN": self.executor_token,
            "ACTION_PLAN_EXECUTOR_PRINCIPAL_ID": _PRINCIPAL,
            "ACTION_PLAN_EXECUTOR_INSTANCE_ID": _INSTANCE,
            "ACTION_PLAN_EXECUTOR_AGENT_ID": _AGENT,
            "ACTION_PLAN_EXECUTOR_EXPECTED_REALM": _REALM,
            "SHOW_WELCOME": "false", "REPO_INDEX_ENABLED": "false",
            "AGENTIC_ENABLED": "false", "ARCANOS_SHELL": "powershell",
            "POLICY_MAX_CONSECUTIVE_FAILURES": "100",
            "POLICY_RATE_LIMIT_COMMANDS_PER_MINUTE": "100",
            "DAEMON_COMMAND_POLL_INTERVAL_SECONDS": "1",
            "DAEMON_HEARTBEAT_INTERVAL_SECONDS": "1",
        })
        (root / "profile/pyreadlineconfig.ini").write_text("disable_readline(True)\n", encoding="utf-8")
        self.workspace = root / "repository"
        if not self.workspace.exists():
            standalone_repo(self.workspace, self.env)
        fixture = self.workspace / "ap_native_fixture.py"
        fixture.write_text(
            "import json, os, pathlib, sys, time\n"
            "root=pathlib.Path(__file__).parent\n"
            "mode, name=sys.argv[1:3]\n"
            "with (root/'native-executions.jsonl').open('a') as stream:\n"
            "    stream.write(json.dumps({'name':name,'pid':os.getpid(),'parent_pid':os.getppid(),'mode':mode})+'\\n')\n"
            f"print('Authorization: Token {_CREDENTIAL}')\n"
            f"print('boot_snapshot: {_PRIVATE}')\n"
            "raise SystemExit(7 if mode=='failure' else 0)\n", encoding="utf-8",
        )
        self.process = None
        self.sessions = []

    def start(self):
        ready_path = self.root / "child-ready.json"
        ready_path.unlink(missing_ok=True)
        self.process = ConsoleProcess(
            [sys.executable, "-u", "-m", "local_action_acceptance.actionplans", "--child"],
            cwd=self.workspace, env=self.env,
        )
        deadline = time.monotonic() + 40
        while not ready_path.exists() and time.monotonic() < deadline:
            if self.process.returncode is not None:
                raise RuntimeError("actionplan_child_startup_failed")
            time.sleep(0.05)
        if not ready_path.exists():
            raise TimeoutError("actionplan_child_startup_timeout")
        return json.loads(ready_path.read_text())

    def _wait_record(self, path, previous_count, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                rows = read_jsonl(path)
            except ValueError:
                rows = []
            if len(rows) > previous_count:
                return rows[-1]
            if self.process.returncode is not None:
                raise RuntimeError("actionplan_child_exited_before_receipt")
            time.sleep(0.05)
        raise TimeoutError("actionplan_component_receipt_timeout")

    def control(self, command):
        path = self.root / "control-events.jsonl"
        previous = len(read_jsonl(path))
        self.process.send_line(command)
        self._wait_record(path, previous, timeout=10)

    def cycle(self, *, approve=True, expect_prompt=True):
        path = self.root / "cycles.jsonl"
        previous = len(read_jsonl(path))
        routes = self.backend.extra_routes
        claims_before = len(routes.claims)
        self.process.send_line("cycle")
        if expect_prompt:
            # Console output can be redrawn by ConPTY. Wait for the real HTTP
            # claim before sending native keyboard input; production confirmation
            # still consumes the actual y/n line on its unchanged TTY stream.
            deadline = time.monotonic() + 15
            while len(routes.claims) <= claims_before and time.monotonic() < deadline:
                time.sleep(0.05)
            if len(routes.claims) <= claims_before:
                raise TimeoutError("actionplan_claim_not_received")
            self.process.send_line("y" if approve else "n")
        return self._wait_record(path, previous)

    def begin_confirmation(self):
        before = len(self.backend.extra_routes.claims)
        self.process.send_line("cycle")
        path = self.root / "data/action_plan_execution/journal.sqlite3"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if len(self.backend.extra_routes.claims) > before:
                with sqlite3.connect(path) as connection:
                    row = connection.execute("SELECT state FROM execution_run ORDER BY run_id DESC LIMIT 1").fetchone()
                if row and row[0] == "CLAIMED":
                    return
            time.sleep(0.05)
        raise TimeoutError("actionplan_claim_not_durable")

    def stop(self, *, interrupted=False):
        if self.process is None:
            return
        process = self.process
        exit_code = None
        forced_cleanup = interrupted
        try:
            if not interrupted:
                process.send_line("exit")
                exit_code = process.wait(timeout=10)
            else:
                exit_code = process.returncode
        except (OSError, TimeoutError):
            forced_cleanup = True
        finally:
            transcript = process.transcript
            process.close()
            path = self.root / ("console-" + str(len(self.sessions)) + ".txt")
            path.write_text(transcript, encoding="utf-8")
            self.sessions.append({"pid": process.pid, "exit_code": exit_code,
                                  "command": process.argv,
                                  "job_closed": True, "interrupted_at_confirmation": interrupted,
                                  "forced_cleanup": forced_cleanup,
                                  "transcript_sha256": sha256(path)})
            self.process = None

    def native(self):
        return read_jsonl(self.workspace / "native-executions.jsonl")

    def command(self, mode: str, name: str):
        return f"python ap_native_fixture.py {mode} {name}; exit $LASTEXITCODE"


def _child() -> None:
    from arcanos.credential_bootstrap import bootstrap_credentials
    from arcanos.schema import Memory
    from arcanos.cli.cli import ArcanosCLI
    from arcanos.action_plan_execution_runner import build_action_plan_execution_runner

    root = Path(os.environ["ACCEPTANCE_CASE_ROOT"])
    bootstrap_credentials()
    Memory().set_setting("instance_id", _INSTANCE)
    cli = ArcanosCLI()
    cli._stop_daemon_service()
    runner = build_action_plan_execution_runner(cli)
    write_json(root / "child-ready.json", {"pid": os.getpid(), "tty": sys.stdin.isatty(),
                                          "trust": cli._trust_state.name,
                                          "instance_id": cli.instance_id})
    print("AP_READY", flush=True)
    cycle_count = 0
    try:
        while True:
            command = input("AP_DRIVER> ").strip()
            if command == "exit":
                return
            if command == "cycle":
                result = runner.run_once()
                row = runner.journal.load_run(result.run_id) if result.run_id else None
                evidence = {"disposition": result.disposition, "run_id": result.run_id,
                            "journal_state": row.state if row else None,
                            "reason_code": row.reason_code if row else None}
                with (root / "cycles.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(evidence) + "\n")
                cycle_count += 1
                print(f"AP_RESULT {cycle_count} {result.disposition}", flush=True)
            elif command in {"dry_on", "dry_off"}:
                cli.handle_dryrun("on" if command == "dry_on" else "off")
                with (root / "control-events.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"command": command, "dry_run": cli.dry_run}) + "\n")
                print("AP_CONTROL_DONE", flush=True)
            elif command in {"safe_on", "safe_off"}:
                cli.handle_safemode("on" if command == "safe_on" else "off")
                with (root / "control-events.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"command": command}) + "\n")
                print("AP_CONTROL_DONE", flush=True)
    finally:
        cli._stop_daemon_service()


def _assert(condition, label):
    if not condition:
        raise AssertionError(label)


def run(case_root: Path, source_root: Path) -> dict:
    case_root = case_root.resolve()
    case_root.mkdir(parents=True, exist_ok=True)
    receipt = {"component": "actionplans", "classification": "COMPONENT_INTEGRATION",
               "status": "PASS", "cases": [], "sessions": [], "errors": [],
               "public_cli_background_polling_proven": False}
    routes = _Routes()
    children = []
    with SyntheticBackend(extra_routes=routes) as backend:
        try:
            child = _Child(case_root / "matrix", source_root, backend)
            children.append(child)
            ready = child.start()
            _assert(ready["tty"] and ready["trust"] == "FULL" and ready["instance_id"] == _INSTANCE, "actual_tty_backend_authority")
            receipt["cases"].append({"case": "real_tty_backend_authority", "status": "PASS", **ready})
            for name, mode, approve in (("success", "success", True), ("nonzero", "failure", True), ("denied", "success", False)):
                routes.assign(name, child.command(mode, name))
                result = child.cycle(approve=approve)
                expected_disposition = "ACCEPTED" if approve else "QUARANTINED_REJECTION"
                _assert(result["disposition"] == expected_disposition, name + "_disposition")
                native = [row for row in child.native() if row["name"] == name]
                _assert(len(native) == (1 if approve else 0), name + "_execution_count")
                results = routes.results.get("run-" + name, [])
                if approve:
                    expected = "succeeded" if mode == "success" else "failed"
                    _assert(len(results) == 1 and results[0]["outcome"] == expected, name + "_outcome")
                    if mode == "failure":
                        _assert(results[0]["error"]["category"] == "exit_7" and "output" not in results[0], "failed_ack_not_success")
                    else:
                        _assert(results[0]["output"] == {"return_code": 0, "status": "executed"}, "confirmed_success_metadata")
                receipt["cases"].append({"case": name, "status": "PASS", "cycle": result, "native_execution_count": len(native), "remote_outcome": results[-1]["outcome"] if results else None})
            for control, name, category in (("safe", "safe_mode", "policy"), ("dry", "dry_run", "dry_run")):
                child.control(control + "_on")
                routes.assign(name, child.command("success", name))
                result = child.cycle()
                child.control(control + "_off")
                payload = routes.results["run-" + name][-1]
                _assert(result["disposition"] == "ACCEPTED" and payload["outcome"] == "failed", name + "_failed_result")
                _assert(payload["error"]["category"] == category, name + "_reason")
                _assert(not any(row["name"] == name for row in child.native()), name + "_no_execution")
                receipt["cases"].append({"case": name, "status": "PASS", "cycle": result, "error_category": category, "native_execution_count": 0})
            timeout_command = "Add-Content -Path timeout-started.txt -Value $PID; Start-Sleep -Seconds 4; Add-Content -Path timeout-late.txt -Value unexpected"
            routes.assign("timeout", timeout_command, timeout_ms=1000)
            result = child.cycle()
            payload = routes.results["run-timeout"][-1]
            _assert(result["disposition"] == "ACCEPTED" and payload["outcome"] == "failed" and payload["error"]["category"] == "timeout", "native_timeout_no_fabricated_success")
            time.sleep(4.2)
            _assert((child.workspace / "timeout-started.txt").exists() and not (child.workspace / "timeout-late.txt").exists(), "timeout_started_no_late_mutation")
            receipt["cases"].append({"case": "native_timeout", "status": "PASS", "cycle": result, "native_pid": int((child.workspace / "timeout-started.txt").read_text().strip()), "late_mutation": False})
            routes.assign("replay", child.command("success", "replay"), mode="retry_result")
            first = child.cycle()
            _assert(first["disposition"] == "RETRY_RESULT" and first["journal_state"] == "RESULT_PENDING", "pending_result_durable")
            child.stop()
            child.start()
            second = child.cycle(expect_prompt=False)
            replay_results = routes.results["run-replay"]
            _assert(second["disposition"] == "CONFIRMED_REPLAY" and second["journal_state"] == "ACCEPTED", "durable_replay_accepted")
            _assert(len(replay_results) == 2 and replay_results[0] == replay_results[1], "replayed_same_result")
            deliveries = [row for row in backend.requests if row["method"] == "POST" and row["path"] == "/plans/plan-replay/executions/run-replay/result"]
            _assert(len(deliveries) == 2 and deliveries[0]["body_sha256"] == deliveries[1]["body_sha256"], "replayed_same_wire_body")
            _assert(deliveries[0].get("idempotency_sha256") is not None and deliveries[0]["idempotency_sha256"] == deliveries[1].get("idempotency_sha256"), "replayed_same_idempotency_key")
            _assert(sum(row["name"] == "replay" for row in child.native()) == 1, "replay_no_second_execution")
            receipt["cases"].append({"case": "pending_result_replay_after_new_process", "status": "PASS", "first": first, "second": second, "deliveries": 2, "native_execution_count": 1, "same_wire_body": True, "same_idempotency_key": True})
            child.stop()
            for name, mode, expected in (("unauthorized", "unauthorized", "PROTOCOL_INCOMPATIBLE"), ("changed_authorization", "changed_start", "RECOVERY_REQUIRED"), ("revoked_authority", "revoked_start", "RECOVERY_REQUIRED")):
                isolated = _Child(case_root / name, source_root, backend)
                children.append(isolated)
                isolated.start()
                routes.assign(name, isolated.command("success", name), mode=mode)
                result = isolated.cycle(expect_prompt=mode != "unauthorized")
                _assert(result["disposition"] == expected, name + "_refused")
                _assert(not isolated.native() and not routes.results.get("run-" + name), name + "_no_execution_or_completion")
                receipt["cases"].append({"case": name, "status": "PASS", "cycle": result, "native_execution_count": 0, "completion_submissions": 0})
                isolated.stop()
            changed = _Child(case_root / "changed_claim", source_root, backend)
            children.append(changed)
            changed.start()
            routes.assign("changed_claim", changed.command("success", "old_action"))
            changed.begin_confirmation()
            changed.stop(interrupted=True)
            routes.current["assignment"]["params"]["command"] = changed.command("success", "modified_action")
            changed.start()
            result = changed.cycle(expect_prompt=False)
            _assert(result["disposition"] == "QUARANTINED_REJECTION" and result["reason_code"] == "LOCAL_ASSIGNMENT_CONFLICT", "changed_claim_rejected")
            _assert(not changed.native(), "changed_claim_no_execution")
            receipt["cases"].append({"case": "changed_claim_after_restart", "status": "PASS", "cycle": result, "native_execution_count": 0})
            changed.stop()
            sensitive = (_CREDENTIAL, _PRIVATE, backend.token, backend.daemon_token)
            for instance in children:
                evidence = json.dumps(routes.results)
                for path in instance.root.glob("console-*.txt"):
                    evidence += path.read_text(encoding="utf-8")
                journal = instance.root / "data/action_plan_execution/journal.sqlite3"
                if journal.exists():
                    evidence += journal.read_bytes().decode("latin1")
                _assert(not any(marker in evidence for marker in (*sensitive, instance.executor_token)), "private_outputs_credentials_not_in_feedback_console_journal")
            receipt["cases"].append({"case": "private_output_credentials_withheld", "status": "PASS"})
        except Exception as error:
            receipt["status"] = "FAIL"
            receipt["errors"].append({"type": type(error).__name__, "case": str(error) if isinstance(error, AssertionError) else "actionplan_component_exception"})
        finally:
            for instance in children:
                try:
                    instance.stop()
                except Exception:
                    receipt["status"] = "FAIL"
                    receipt["errors"].append({"type": "cleanup", "case": "console_cleanup_failed"})
                receipt["sessions"].extend(instance.sessions)
            receipt["http_requests"] = backend.requests
            receipt["http_request_count"] = len(backend.requests)
            receipt["backend_url"] = backend.url
            receipt["assigned_commands"] = routes.commands
            receipt["result_deliveries"] = {run: {"count": len(rows), "outcomes": [row["outcome"] for row in rows]} for run, rows in routes.results.items()}
            receipt["native_processes"] = [row for instance in children for row in instance.native()]
            receipt["journal_sha256"] = {instance.root.name: sha256(instance.root / "data/action_plan_execution/journal.sqlite3") for instance in children}
            receipt["network"] = []
            for instance in children:
                observations = read_jsonl(instance.root / "logs/network.jsonl")
                denied = [row for row in observations if row.get("allowed") is False]
                unexpected = [row for row in denied if not (row.get("event") == "socket.bind" and row.get("host") == "::1" and row.get("port") == 0)]
                receipt["network"].append({"case": instance.root.name,
                                           "guard_installed": any(row["event"] == "guard_installed" for row in observations),
                                           "unexpected_denied_attempts": len(unexpected),
                                           "blocked_import_ipv6_probes": len(denied) - len(unexpected),
                                           "network_log_sha256": sha256(instance.root / "logs/network.jsonl")})
    try:
        connection = socket.create_connection(("127.0.0.1", backend.server.server_port), timeout=0.2)
        connection.close()
        port_closed = False
    except OSError:
        port_closed = True
    receipt["cleanup"] = {"console_jobs_closed": all(row["job_closed"] for row in receipt["sessions"]), "backend_thread_stopped": not backend.thread.is_alive(), "backend_port_closed": port_closed}
    receipt["http_authentication_passed"] = all(row["authenticated"] for row in receipt["http_requests"])
    receipt["network_containment"] = all(row["guard_installed"] and row["unexpected_denied_attempts"] == 0 for row in receipt["network"])
    if not all(receipt["cleanup"].values()) or not receipt["http_authentication_passed"] or not receipt["network_containment"]:
        receipt["status"] = "FAIL"
    return receipt


if __name__ == "__main__" and "--child" in sys.argv:
    _child()
