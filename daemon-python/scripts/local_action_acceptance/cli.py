"""Actual Windows CLI acceptance against an authenticated synthetic loopback backend."""

from __future__ import annotations

import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
import sys
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from .common import clean_env, read_jsonl, sha256, standalone_repo, write_json
from .conpty import ConsoleProcess


def _jwt() -> str:
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()
    unsigned = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({
        "sub": "local-acceptance", "exp": int(time.time()) + 3600,
    })
    signature = hmac.new(b"local-acceptance-signing-fixture", unsigned.encode(), hashlib.sha256).digest()
    return unsigned + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()


class SyntheticBackend:
    """Authenticated fixture transport; no model/provider implementation exists."""

    def __init__(self, *, extra_routes: Callable | None = None):
        self.token = _jwt()
        self.daemon_token = "acpt-daemon-" + secrets.token_urlsafe(30)
        self.requests: list[dict] = []
        self.received_bodies: list[dict] = []
        self.answer = "Acceptance backend ready."
        self.registry_available = True
        self.available = True
        self.extra_routes = extra_routes
        self.purpose_bound_tokens: dict[str, str] = {}
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.handle_request("GET")

            def do_POST(self):
                self.handle_request("POST")

            def handle_request(self, method):
                path = urlsplit(self.path).path
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw) if raw else {}
                daemon = path == "/api/daemon" or path.startswith("/api/daemon/")
                expected = backend.daemon_token if daemon else f"Bearer {backend.token}"
                auth_kind = "daemon-capability" if daemon else "bearer"
                for prefix, token in backend.purpose_bound_tokens.items():
                    if path == prefix.rstrip("/") or path.startswith(prefix.rstrip("/") + "/"):
                        expected = f"Bearer {token}"
                        auth_kind = "purpose-bound-bearer"
                        break
                provided = self.headers.get("x-arcanos-daemon-token" if daemon else "Authorization", "")
                # The production transport's dedicated header is checked
                # below without allowing a generic bearer to substitute.
                if daemon:
                    provided = self.headers.get("x-arcanos-daemon-token", "")
                authenticated = hmac.compare_digest(provided, expected)
                backend.requests.append({
                    "method": method, "path": path, "authenticated": authenticated,
                    "auth_kind": auth_kind,
                    "body_sha256": hashlib.sha256(raw).hexdigest(),
                    "idempotency_sha256": hashlib.sha256(self.headers.get("Idempotency-Key", "").encode()).hexdigest(),
                })
                backend.received_bodies.append({"method": method, "path": path, "body": body})
                if not authenticated:
                    return self.respond(401, {"error": "fixture authentication rejected"})
                if not backend.available:
                    return self.respond(503, {"error": "fixture backend unavailable"})
                custom = backend.extra_routes(method, path, body) if backend.extra_routes else None
                if custom is not None:
                    return self.respond(*custom)
                if path == "/api/daemon/registry":
                    if not backend.registry_available:
                        return self.respond(503, {"error": "fixture registry unavailable"})
                    return self.respond(200, {
                        "version": "local-acceptance", "endpoints": [],
                        "modules": [], "daemonTools": [], "core": [],
                    })
                if path == "/system-state":
                    return self.respond(200, {"version": 1, "routing": {"preferred": "backend"}})
                if path.startswith("/gpt/"):
                    answer = "DONE" if str(body.get("prompt", "")).startswith("Tool results:") else backend.answer
                    return self.respond(200, {
                        "ok": True, "result": answer, "tokens": 0,
                        "cost": 0, "model": "synthetic-loopback", "presentation": "public-answer-v1",
                    })
                if path == "/api/daemon/commands":
                    return self.respond(200, {"commands": []})
                if path.startswith("/api/daemon/"):
                    return self.respond(200, {"ok": True})
                return self.respond(404, {"error": "No fixture route"})

            def respond(self, status, payload):
                content = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def env(self):
        return {"BACKEND_TOKEN": self.token, "ARCANOS_DAEMON_ACCESS_TOKEN": self.daemon_token}

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class DaemonFixture:
    """Launch the actual public Python module; backend registry owns trust."""

    def __init__(self, case_root: Path, source_root: Path, *, extra_env: dict | None = None,
                 backend: SyntheticBackend | None = None, backend_enabled: bool = True):
        self.case_root = Path(case_root).resolve()
        self.source_root = Path(source_root).resolve()
        self.backend = backend or SyntheticBackend()
        self._owns_backend = backend is None
        settings = {
            **self.backend.env, "SHOW_WELCOME": "false", "REPO_INDEX_ENABLED": "false",
            "AGENT_MAX_STEPS": "2", "AGENTIC_ENABLED": "true",
            "DAEMON_HEARTBEAT_INTERVAL_SECONDS": "1", "DAEMON_COMMAND_POLL_INTERVAL_SECONDS": "1",
            "POLICY_RATE_LIMIT_COMMANDS_PER_MINUTE": "100", "POLICY_MAX_CONSECUTIVE_FAILURES": "100",
            "ARCANOS_SHELL": "powershell", **(extra_env or {}),
        }
        self.env = clean_env(self.case_root, self.source_root,
                             backend_url=self.backend.url if backend_enabled else None, extra=settings)
        # Disable optional third-party line editing through its supported
        # profile setting. Python's actual console input/TTY check is intact.
        (self.case_root / "profile/pyreadlineconfig.ini").write_text(
            "disable_readline(True)\n", encoding="utf-8",
        )
        self.repository = standalone_repo(self.case_root / "repository", self.env)
        self.console: ConsoleProcess | None = None
        self.cleanup = {}

    def start(self):
        self.console = ConsoleProcess([sys.executable, "-u", "-m", "arcanos.cli"],
                                      cwd=self.repository, env=self.env)
        self.wait_input(1, timeout=35)
        return self

    def input_count(self):
        return sum(item.get("event") == "builtins.input"
                   for item in read_jsonl(self.case_root / "logs/network.jsonl"))

    def wait_input(self, count, timeout=20):
        return _wait(lambda: self.input_count() >= count, timeout=timeout)

    def control(self, command):
        count = self.input_count()
        self.send_line(command)
        self.wait_input(count + 1)

    def send_line(self, text):
        self.console.send_line(text)

    def expect(self, pattern, timeout=20):
        return self.console.expect(pattern, timeout)

    def close(self):
        if self.console:
            try:
                if self.console.returncode is None:
                    self.console.send_line("/exit")
                    self.console.wait(timeout=8)
            except (OSError, TimeoutError):
                pass
            finally:
                self.cleanup = {"wrapper_exit_code": self.console.returncode,
                                "forced_termination": self.console.returncode is None}
                self.console.close()
                transcript = self.console.transcript
                for marker in ("acceptance-secret-value", "acceptance-private-record"):
                    transcript = transcript.replace(marker, "[SYNTHETIC_MARKER_REDACTED]")
                (self.case_root / "console.txt").write_text(transcript, encoding="utf-8")
                self.cleanup["job_closed"] = True
        if self._owns_backend:
            self.backend.close()
            self.cleanup["backend_thread_stopped"] = not self.backend.thread.is_alive()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_args):
        self.close()


def _history(case_root: Path) -> list[dict]:
    path = case_root / "data/history.db"
    if not path.exists():
        return []
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='commands'").fetchone():
            return []
        return [dict(row) for row in connection.execute("SELECT * FROM commands ORDER BY ts_ms")]


def _wait(test, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = test()
        if result:
            return result
        time.sleep(0.05)
    raise TimeoutError("Acceptance observation deadline elapsed")


def _command(fixture: DaemonFixture, command: str, *, approval="y", preflight="y",
             action_prompt=True, history_expected=True, before_approval=None):
    count = len(_history(fixture.case_root))
    inputs = fixture.input_count()
    fixture.send_line("/run " + command)
    fixture.wait_input(inputs + 1)
    fixture.send_line(preflight)
    if preflight.lower() not in ("y", "yes"):
        return None
    if action_prompt:
        fixture.wait_input(inputs + 2)
        if before_approval:
            before_approval()
        fixture.send_line(approval)
    fixture.wait_input(inputs + (3 if action_prompt else 2))
    if history_expected:
        rows = _wait(lambda: _history(fixture.case_root)[count:])
        return rows[-1]
    return None


def _receipt(fixture: DaemonFixture):
    trace = read_jsonl(fixture.case_root / "logs/network.jsonl")
    return {
        "classification": "REAL_WINDOWS_CLI_NATIVE_SUBPROCESS",
        "entrypoint": ["python", "-m", "arcanos.cli"],
        "trust_source": "actual registry availability and freshness through authenticated client; no state override",
        "optional_line_editor": "disabled through supported isolated pyreadline profile setting",
        "wrapper_pid": fixture.console.pid if fixture.console else None,
        "python_pids": sorted({item["pid"] for item in trace if item.get("event") == "guard_installed"}),
        "real_tty": bool([item for item in trace if item.get("event") == "guard_installed"]) and all(item.get("stdin_isatty") is True for item in trace if item.get("event") == "guard_installed"),
        "input_observation": "metadata-only builtins.input audit events; actual stdin/input unchanged",
        "http_requests": fixture.backend.requests,
        "native_process_count": sum(item.get("event") == "subprocess.Popen" for item in trace),
        "cleanup": fixture.cleanup,
    }


def _fault_bootstrap(root: Path, kind: str) -> Path:
    path = root / "bootstrap.py"
    root.mkdir(parents=True, exist_ok=True)
    common = '''import json, os, sqlite3
from pathlib import Path
from arcanos.cli import execute, run_ops
from arcanos.cli.cli import ArcanosCLI
from arcanos.schema import Memory
from arcanos.agentic.policy_guard import PolicyGuard
root = Path(os.environ['ACCEPTANCE_CASE_ROOT'])
def observe(event, **fields):
    with (root/'audit_observations.jsonl').open('a',encoding='utf-8') as stream:
        stream.write(json.dumps({'event':event,'return_code':fields.get('return_code'),'error_type':fields.get('error_type')})+chr(10))
    return original_audit(event,**fields)
original_audit=execute.record
execute.record=observe
run_ops.audit_record=observe
'''
    additions = {
        "statistics": '''original_stat=Memory.increment_stat
def failed_stat(self,name,amount=1):
    if name=='terminal_commands': raise OSError('synthetic statistics bookkeeping fault')
    return original_stat(self,name,amount)
Memory.increment_stat=failed_stat
''',
        "policy_history": '''def failed_policy(self):
    raise sqlite3.OperationalError('synthetic policy bookkeeping fault')
PolicyGuard.record_success=failed_policy
''',
        "audit": '''def failed_audit(event,**fields):
    if event in ('execute_success','execute_failed'):
        observe(event,**fields)
        raise OSError('synthetic post-execution audit fault')
    return observe(event,**fields)
execute.record=failed_audit
''',
        "timeout_audit": '''from arcanos.terminal import TerminalController
original_execute=TerminalController.execute
def timed_execute(self,*args,**kwargs):
    kwargs['timeout']=3
    return original_execute(self,*args,**kwargs)
TerminalController.execute=timed_execute
def failed_timeout_audit(event,**fields):
    observe(event,**fields)
    if event=='command_failed': raise OSError('synthetic secondary audit failure')
run_ops.audit_record=failed_timeout_audit
''',
        "history_audit": '''from arcanos.agentic.history_db import HistoryDB
from rich.console import Console
def probe(data):
    with (root/'history_outcome.jsonl').open('a',encoding='utf-8') as stream:
        stream.write(json.dumps(data)+chr(10))
def failed_history(self,instance_id,command,status,return_code,stdout,stderr):
    probe({'event':'history_attempt','status':status,'exit_code':return_code})
    raise sqlite3.OperationalError('synthetic history failure')
HistoryDB.log_command=failed_history
def failed_history_audit(event,**fields):
    observe(event,**fields)
    if event=='command_history_failed': raise OSError('synthetic secondary audit failure')
run_ops.audit_record=failed_history_audit
original_print=Console.print
def observed_print(self,*args,**kwargs):
    if len(args)==1 and isinstance(args[0],str) and args[0].startswith('Command ') and '; exit code: ' in args[0]:
        status,code=args[0][8:].split('; exit code: ')
        probe({'event':'display_outcome','status':status,'exit_code':int(code)})
    return original_print(self,*args,**kwargs)
Console.print=observed_print
original_run=run_ops.handle_run
def observed_run(*args,**kwargs):
    try: result=original_run(*args,**kwargs)
    except Exception as error:
        probe({'event':'handler_raised','error_type':type(error).__name__})
        raise
    probe({'event':'handler_returned'})
    return result
run_ops.handle_run=observed_run
''',
        "invalid_completion": '''from arcanos.terminal import TerminalController
original_execute=TerminalController.execute
def invalid_result(self,*args,**kwargs):
    original_execute(self,*args,**kwargs)
    return None,None,None
TerminalController.execute=invalid_result
''',
        "cwd": '''original_confirm=ArcanosCLI._confirm_action
def change_cwd(self,message):
    approved=original_confirm(self,message)
    if approved:
        destination=root/'other-workspace'
        destination.mkdir(exist_ok=True)
        os.chdir(destination)
    return approved
ArcanosCLI._confirm_action=change_cwd
''',
        "last_response_observer": '''original_ask=ArcanosCLI.handle_ask
def observed_ask(self,*args,**kwargs):
    result=original_ask(self,*args,**kwargs)
    value=str(self._last_response or '')
    with (root/'last_response_observations.jsonl').open('a',encoding='utf-8') as stream:
        stream.write(json.dumps({'contains_secret':'acceptance-secret-value' in value,'contains_private':'acceptance-private-record' in value})+chr(10))
    return result
ArcanosCLI.handle_ask=observed_ask
''',
    }
    path.write_text(common + additions[kind], encoding="utf-8")
    return path


def run(case_root: Path, source_root: Path) -> dict:
    """Run actual CLI controls; explicit injected cases remain separately labeled."""
    case_root = Path(case_root).resolve()
    source_root = Path(source_root).resolve()
    cases = {}

    def perform(name, operation, *, extra=None, backend_enabled=True):
        root = case_root / name
        fixture = DaemonFixture(root, source_root, extra_env=extra, backend_enabled=backend_enabled)
        result = {}
        try:
            with fixture:
                result = operation(fixture)
            result = {**_receipt(fixture), **result}
        except Exception as error:
            fixture.close()
            result = {"status": "NOT_RUN", "classification": "FIXTURE_FAILURE",
                      "reason": type(error).__name__, "cleanup": fixture.cleanup}
            (root / "fixture_error.txt").write_text(str(error), encoding="utf-8")
        cases[name] = result
        write_json(root / "receipt.json", result)

    def succeeded(f):
        row = _command(f, "Set-Content -LiteralPath success.txt -Value native-success")
        ok = row["status"] == "succeeded" and row["return_code"] == 0 and (f.repository / "success.txt").exists()
        return {"status": "PASS" if ok else "FAIL", "execution_status": row["status"], "exit_code": row["return_code"], "marker_sha256": sha256(f.repository / "success.txt")}
    perform("approved_success", succeeded)

    def failed(f):
        row = _command(f, "exit 7")
        return {"status": "PASS" if row["status"] == "failed" and row["return_code"] == 7 else "FAIL",
                "execution_status": row["status"], "exit_code": row["return_code"]}
    perform("approved_nonzero", failed)

    def denied(f):
        row = _command(f, "Set-Content denied.txt native-denied", approval="n")
        return {"status": "PASS" if row["status"] == "blocked" and not (f.repository / "denied.txt").exists() else "FAIL", "execution_status": row["status"], "exit_code": row["return_code"]}
    perform("action_denied", denied)

    def dry_run(f):
        f.control("/dryrun on")
        _command(f, "Set-Content dryrun.txt native-dryrun", action_prompt=False, history_expected=False)
        return {"status": "PASS" if not (f.repository / "dryrun.txt").exists() and not _history(f.case_root) else "FAIL", "execution_status": "proposed"}
    perform("dry_run", dry_run)

    def safe(f):
        f.control("/safemode on")
        _wait(lambda: (f.case_root / "data/history.db").exists())
        row = _command(f, "Set-Content safe.txt native-safe", action_prompt=False)
        return {"status": "PASS" if row["status"] == "blocked" and not (f.repository / "safe.txt").exists() else "FAIL", "execution_status": row["status"]}
    perform("safe_mode", safe)

    def policy_changed(f):
        def change():
            with sqlite3.connect(f.case_root / "data/history.db") as connection:
                connection.execute("INSERT OR REPLACE INTO kv_state(key,value_json) VALUES(?,?)", ("policy.safe_mode", "true"))
        row = _command(f, "Set-Content changed.txt native-policy", before_approval=change)
        return {"status": "PASS" if row["status"] == "blocked" and not (f.repository / "changed.txt").exists() else "FAIL", "execution_status": row["status"], "policy_change": "actual persisted SQLite state changed during real approval"}
    perform("policy_changed_during_approval", policy_changed)

    def duplicate(f):
        started = time.monotonic()
        first = _command(f, "Add-Content duplicate.txt one")
        second = _command(f, "Add-Content duplicate.txt one")
        contents = (f.repository / "duplicate.txt").read_text(encoding="utf-8-sig").splitlines()
        return {"status": "PASS" if first["status"] == "succeeded" and second["status"] == "blocked" and contents == ["one"] else "FAIL", "execution_statuses": [first["status"], second["status"]], "total_seconds": time.monotonic() - started, "marker_lines": len(contents)}
    perform("duplicate_delivery", duplicate)

    def missing(f):
        _command(f, "Set-Content missing.txt native-missing", action_prompt=False, history_expected=False)
        return {"status": "PASS" if not (f.repository / "missing.txt").exists() and not _history(f.case_root) else "FAIL", "trust": "backend absent; real registry missing", "execution_status": "blocked"}
    perform("missing_backend_trust", missing, backend_enabled=False)

    for kind in ("cwd", "invalid_completion", "statistics", "policy_history", "audit", "audit_nonzero"):
        root = case_root / ("injected_" + kind)
        bootstrap = _fault_bootstrap(root, "audit" if kind == "audit_nonzero" else kind)
        def injected(f, kind=kind):
            command = "Set-Content injected.txt native-injected"
            if kind == "audit_nonzero":
                command += "; exit 7"
            row = _command(f, command)
            marker = (f.repository / "injected.txt").exists()
            events = read_jsonl(f.case_root / "audit_observations.jsonl")
            names = [event["event"] for event in events]
            if kind == "cwd":
                ok = row["status"] == "blocked" and not marker and not (f.case_root / "other-workspace/injected.txt").exists()
            elif kind == "invalid_completion":
                ok = marker and row["status"] == "failed" and row["return_code"] is None
            elif kind == "audit_nonzero":
                ok = marker and row["status"] == "failed" and row["return_code"] == 7 and "command_failed" not in names
            else:
                ok = marker and row["status"] == "succeeded" and row["return_code"] == 0 and "command_failed" not in names
            return {"status": "PASS" if ok else "FAIL", "classification": "INJECTED_APPROVAL_CONTEXT_CHANGE" if kind == "cwd" else "INJECTED_AFTER_REAL_NATIVE_OPERATION",
                    "injection": kind, "marker_created": marker, "execution_status": row["status"], "exit_code": row["return_code"], "audit_events": events}
        perform("injected_" + kind, injected, extra={"ACCEPTANCE_FAULT_BOOTSTRAP": str(bootstrap)})

    for code in (0, 7):
        name = f"injected_history_audit_{code}"
        bootstrap = _fault_bootstrap(case_root / name, "history_audit")
        def combined(f, code=code):
            command = "Set-Content history-audit.txt native-history-audit"
            _command(f, command + ("; exit 7" if code else ""), history_expected=False)
            observations = read_jsonl(f.case_root / "history_outcome.jsonl")
            expected = "succeeded" if code == 0 else "failed"
            marker = (f.repository / "history-audit.txt").exists()
            accurate = {"event": "display_outcome", "status": expected, "exit_code": code} in observations
            returned = any(item["event"] == "handler_returned" for item in observations)
            return {"status": "PASS" if marker and accurate and returned else "FAIL",
                    "classification": "INJECTED_AFTER_REAL_NATIVE_OPERATION",
                    "exit_code": code, "execution_status": expected, "marker_created": marker,
                    "observations": observations, "observer": "read-only Console.print/handler receipt; no altered output or return arguments"}
        perform(name, combined, extra={"ACCEPTANCE_FAULT_BOOTSTRAP": str(bootstrap)})

    def timeout_audit(f):
        row = _command(f, "Set-Content timeout-started.txt native-started; Start-Sleep -Seconds 10; Set-Content timeout-late.txt unexpected")
        events = read_jsonl(f.case_root / "audit_observations.jsonl")
        actual_timeout = any(item["event"] == "execute_failed" and item["error_type"] == "TimeoutError" for item in events)
        started = (f.repository / "timeout-started.txt").exists()
        late = (f.repository / "timeout-late.txt").exists()
        ok = started and not late and actual_timeout and row["status"] == "failed" and row["return_code"] is None
        return {"status": "PASS" if ok else "FAIL", "classification": "INJECTED_TIMEOUT_LIMIT_AND_SECONDARY_AUDIT_FAILURE",
                "injection": "real TerminalController timeout=3 argument; secondary command_failed audit raises",
                "execution_status": row["status"], "exit_code": row["return_code"], "actual_timeout_observed": actual_timeout,
                "native_started_marker": started, "late_marker_created": late, "audit_events": events}
    timeout_root = case_root / "injected_timeout_audit"
    timeout_bootstrap = _fault_bootstrap(timeout_root, "timeout_audit")
    perform("injected_timeout_audit", timeout_audit, extra={"ACCEPTANCE_FAULT_BOOTSTRAP": str(timeout_bootstrap)})

    def feedback(f):
        (f.repository / "tool-output.txt").write_text("Authorization: Token acceptance-secret-value\naudit_trace:\nacceptance-private-record\n", encoding="utf-8")
        f.backend.answer = "Command:\nGet-Content tool-output.txt"
        inputs = f.input_count()
        f.send_line("/backend perform the proposed local fixture action")
        f.wait_input(inputs + 1)
        f.send_line("y")
        f.wait_input(inputs + 2)
        row = _wait(lambda: _history(f.case_root))[-1]
        followup = _wait(lambda: [item for item in f.backend.received_bodies if str(item["body"].get("prompt", "")).startswith("Tool results:")])[-1]
        prompt = followup["body"]["prompt"]
        observed = _wait(lambda: read_jsonl(f.case_root / "last_response_observations.jsonl"))
        visible = f.console.raw_transcript
        no_leak = all(marker not in prompt + row["stdout"] + visible
                      for marker in ("acceptance-secret-value", "acceptance-private-record"))
        accurate = '"return_code": 0' in prompt and '"approval_status": "approved"' in prompt and '"status": "succeeded"' in prompt
        export_path = f.case_root / "audit-export.json"
        f.control("/audit export ../audit-export.json")
        exported_text = export_path.read_text(encoding="utf-8")
        exported = json.loads(exported_text)
        export_safe = all(marker not in exported_text
                          for marker in ("acceptance-secret-value", "acceptance-private-record"))
        export_accurate = any(item[-2:] == ["succeeded", 0] for item in exported["commands"])
        return {"status": "PASS" if no_leak and accurate and export_safe and export_accurate and all(not item["contains_secret"] and not item["contains_private"] for item in observed) else "FAIL",
                "native_exit": row["return_code"], "sanitized_feedback": no_leak, "accurate_feedback": accurate,
                "display_history_feedback_safe": no_leak,
                "audit_export": {"exists": export_path.is_file(), "sha256": sha256(export_path),
                                 "safe": export_safe, "accurate_command_outcome": export_accurate,
                                 "row_counts": {key: len(value) for key, value in exported.items() if isinstance(value, list)}},
                "last_response_safe": all(not item["contains_secret"] and not item["contains_private"] for item in observed),
                "observer": "read-only after-ask receipt; no authorization/input/output alteration"}
    feedback_root = case_root / "agentic_feedback"
    observer = _fault_bootstrap(feedback_root, "last_response_observer")
    perform("agentic_feedback", feedback, extra={"ACCEPTANCE_FAULT_BOOTSTRAP": str(observer)})

    def stale(f):
        f.backend.registry_available = False
        started = time.monotonic()
        for _ in range(2):
            time.sleep(31)
        _command(f, "Set-Content stale.txt native-stale", action_prompt=False, history_expected=False)
        return {"status": "PASS" if not (f.repository / "stale.txt").exists() and not _history(f.case_root) else "FAIL",
                "execution_status": "blocked", "real_elapsed_seconds": time.monotonic() - started,
                "trust": "real registry cached for more than minimum one-minute TTL; no timestamp manipulation"}
    perform("stale_backend_trust", stale, extra={"REGISTRY_CACHE_TTL_MINUTES": "1"})

    gates = {name: result["status"] for name, result in cases.items()}
    return {"classification": "REAL_WINDOWS_CLI_WITH_LABELED_INJECTED_FAULTS", "cases": cases, "gates": gates,
            "real_provider_calls": 0, "elevation": False}
