"""Windows loopback acceptance through the documented bridge module entrypoint.

Normal cases use an unmodified daemon child and real HTTP. The separately
labelled post-apply case installs one test-only validation fault at child startup.
"""

from __future__ import annotations

import ctypes
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any

from .common import clean_env


_DEFAULT_TOKEN = object()
_TOKEN = "acceptance-bridge-purpose-bound-value"
_CREDENTIAL = "acceptance-bridge-disclosure-canary"
_PRIVATE = "acceptance-bridge-private-canary"
_WIRE_KEYS = {"ok", "status", "stdout", "stderr", "exitCode", "durationMs", "truncated", "auditId"}


def _sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _proposal(kind: str, value: str, cwd: Path) -> str:
    payload = {"kind": kind, kind if kind == "patch" else "command": value, "cwd": str(cwd.resolve())}
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return "cli-" + hashlib.sha256(encoded).hexdigest()[:16]


def _alive(pid: int) -> bool:
    if os.name == "nt":
        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class BridgeProcess:
    """A real bridge child with bounded HTTP and unconditional cleanup."""

    def __init__(self, case_root: Path, source_root: Path, workspace: Path, *, fault: Path | None = None):
        self.case_root = case_root.resolve()
        self.source_root = source_root.resolve()
        self.workspace = workspace.resolve()
        self.case_root.mkdir(parents=True, exist_ok=True)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        extra = {
            "ACCEPTANCE_ALLOWED_PORTS": str(self.port),
            "ARCANOS_CLI_BRIDGE_ENABLED": "true",
            "ARCANOS_CLI_BRIDGE_TOKEN": _TOKEN,
            "ARCANOS_CLI_SANDBOX_ROOT": str(self.workspace),
            "HISTORY_DB_PATH": str(self.case_root / "state" / "history.db"),
            "PATCH_BACKUP_DIR": str(self.case_root / "state" / "backups"),
            "LOG_DIR": str(self.case_root / "logs"),
            "OPENAI_API_KEY": "mock-api-key",
            "RUN_ELEVATED": "false",
        }
        if fault is not None:
            extra["ACCEPTANCE_FAULT_BOOTSTRAP"] = str(fault.resolve())
        self.env = clean_env(self.case_root, self.source_root, extra=extra)
        self.command = [sys.executable, "-m", "arcanos.cli", "bridge", "--bridge-host", "127.0.0.1", "--bridge-port", str(self.port)]
        self.requests: list[dict[str, Any]] = []
        self.receipt: dict[str, Any] = {
            "classification": "INJECTED" if fault else "E2E",
            "command": self.command,
            "port": self.port,
            "requests": self.requests,
            "connection_attempts": 0,
            "fixture_processes": [],
        }
        self.process = None
        self._files = []

    def __enter__(self):
        stdout_path = self.case_root / "bridge.stdout.log"
        stderr_path = self.case_root / "bridge.stderr.log"
        self._files = [stdout_path.open("wb"), stderr_path.open("wb")]
        self.process = subprocess.Popen(
            self.command, cwd=self.workspace, env=self.env,
            stdin=subprocess.DEVNULL, stdout=self._files[0], stderr=self._files[1],
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.receipt["pid"] = self.process.pid
        self.receipt["started_unix"] = time.time()
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("bridge_startup_failed")
                try:
                    status, body = self.request("GET", "/health", label="startup_health")
                    if status == 200 and body.get("status") == "ready":
                        return self
                except (OSError, http.client.HTTPException):
                    time.sleep(0.1)
            raise TimeoutError("bridge_startup_timeout")
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def request(self, method: str, path: str, payload=None, *, token=_DEFAULT_TOKEN, headers=None, raw=None, label=None):
        selected_token = _TOKEN if token is _DEFAULT_TOKEN else token
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if selected_token is not None:
            request_headers["x-arcanos-cli-bridge-token"] = selected_token
        body = raw if raw is not None else (json.dumps(payload).encode("utf-8") if payload is not None else None)
        self.receipt["connection_attempts"] += 1
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        started = time.monotonic()
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            response_bytes = response.read()
            result = json.loads(response_bytes.decode("utf-8"))
            entry = {
                "case": label, "method": method, "path": path,
                "http_status": response.status, "status": result.get("status"),
                "ok": result.get("ok"), "exit_code": result.get("exitCode"),
                "audit_id": result.get("auditId"), "truncated": result.get("truncated"),
                "stdout_chars": len(result.get("stdout", "")),
                "stderr_chars": len(result.get("stderr", "")),
                "response_sha256": hashlib.sha256(response_bytes).hexdigest(),
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
            if isinstance(payload, dict) and isinstance(payload.get("command"), str):
                entry["command"] = payload["command"]
            if isinstance(payload, dict) and isinstance(payload.get("patch"), str):
                entry["patch_sha256"] = hashlib.sha256(payload["patch"].encode()).hexdigest()
            self.requests.append(entry)
            if _TOKEN in response_bytes.decode("utf-8") or _CREDENTIAL in response_bytes.decode("utf-8") or _PRIVATE in response_bytes.decode("utf-8"):
                raise AssertionError("bridge_response_disclosure")
            if set(result) != _WIRE_KEYS:
                raise AssertionError("bridge_wire_keys_changed")
            return response.status, result
        finally:
            connection.close()

    def command_request(self, command: str, *, timeout=3, label=None, cwd=None, proposal=None):
        selected_cwd = Path(cwd) if cwd is not None else self.workspace
        return self.request("POST", "/commands/run", {
            "command": command, "cwd": str(selected_cwd),
            "proposalId": proposal or _proposal("command", command, selected_cwd),
            "timeoutSeconds": timeout,
        }, label=label)

    def patch(self, patch_text: str, *, timeout=5, label=None):
        return self.request("POST", "/patches/apply", {
            "patch": patch_text, "cwd": str(self.workspace),
            "proposalId": _proposal("patch", patch_text, self.workspace),
            "timeoutSeconds": timeout,
        }, label=label)

    def audit(self):
        path = self.case_root / "logs" / "debug_server.log"
        if not path.exists():
            return []
        text = path.read_text(encoding="utf-8")
        if any(marker in text for marker in (_TOKEN, _CREDENTIAL, _PRIVATE)):
            raise AssertionError("bridge_audit_disclosure")
        rows = []
        for line in text.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("event_type"):
                rows.append(row)
        return rows

    def __exit__(self, *_args):
        if self.process is not None and self.process.poll() is None:
            self.receipt["termination_requested"] = "after_acceptance_cleanup"
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        for handle in self._files:
            handle.close()
        self.receipt["exit_code"] = self.process.poll() if self.process is not None else None
        self.receipt["stopped"] = self.process is None or self.process.poll() is not None
        for pid_path in self.workspace.glob("pid-*.json"):
            try:
                item = json.loads(pid_path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            if self.process is None or item.get("parent_pid") != self.process.pid:
                continue
            deadline = time.monotonic() + 6
            while _alive(item["pid"]) and time.monotonic() < deadline:
                time.sleep(0.05)
            # Fixture scripts finish within four seconds; command timeout owns
            # their process handle. Never terminate a possibly recycled PID.
            item["stopped"] = not _alive(item["pid"])
            self.receipt["fixture_processes"].append(item)
        try:
            connection = socket.create_connection(("127.0.0.1", self.port), timeout=0.2)
            connection.close()
            self.receipt["port_closed"] = False
        except OSError:
            self.receipt["port_closed"] = True
        self.receipt["http_request_count"] = len(self.requests)
        try:
            rows = self.audit()
        except (AssertionError, OSError, ValueError):
            self.receipt["evidence_error"] = "audit_not_safe_or_readable"
            rows = []
        self.receipt["audit"] = [
            {key: row[key] for key in ("event_type", "audit_id", "outcome", "return_code", "error_type", "rollback_id", "history_recorded") if key in row}
            for row in rows
        ]
        self.receipt["audit_sha256"] = _sha(self.case_root / "logs" / "debug_server.log")
        self.receipt["network_log"] = str(self.case_root / "logs" / "network.jsonl")
        network_path = Path(self.receipt["network_log"])
        try:
            network = [json.loads(line) for line in network_path.read_text(encoding="utf-8").splitlines()] if network_path.exists() else []
        except (OSError, ValueError):
            self.receipt["evidence_error"] = "network_evidence_unreadable"
            network = []
        denied = [row for row in network if row.get("allowed") is False]
        # urllib3.util.connection probes IPv6 support at import by binding ::1:0.
        # The guard blocks that probe; it grants no extra network permission.
        expected_probes = [row for row in denied if row.get("event") == "socket.bind" and row.get("host") == "::1" and row.get("port") == 0]
        unexpected = [row for row in denied if row not in expected_probes]
        self.receipt["containment"] = {
            "guard_installed": any(row["event"] == "guard_installed" for row in network),
            "outbound_connect_attempts": sum(row["event"] == "socket.connect" for row in network),
            "unexpected_denied_attempts": len(unexpected),
            "blocked_import_ipv6_probes": len(expected_probes),
            "subprocess_launch_observations": sum(row["event"] == "subprocess.Popen" for row in network),
        }


def _initialize_workspace(case_root: Path, source_root: Path, processes: list) -> Path:
    root = case_root / "workspace"
    root.mkdir(parents=True)
    env = clean_env(case_root / "setup", source_root)
    command = ["git", "init", "--quiet", "--template=", str(root)]
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=5)
    processes.append({"role": "disposable_git_init", "command": command, "pid": process.pid, "exit_code": process.returncode, "stopped": process.poll() is not None})
    if process.returncode != 0:
        raise RuntimeError("disposable_git_init_failed")
    (root / "sample.txt").write_bytes(b"old\n")
    (root / "validate_backend_cli_offline.py").write_text(
        "import json, os, pathlib, sys, time\n"
        "root = pathlib.Path(__file__).parent\n"
        "mode = sys.argv[1]\n"
        "(root / ('pid-' + mode + '.json')).write_text(json.dumps({'pid': os.getpid(), 'parent_pid': os.getppid(), 'mode': mode}))\n"
        "if mode == 'credential':\n"
        f"    print('Authorization: Token {_CREDENTIAL}')\n"
        "    print('The operation did not complete.')\n"
        "elif mode == 'private':\n"
        f"    print('boot_snapshot: {_PRIVATE}')\n"
        "elif mode == 'bounds':\n"
        "    print('x' * 20000)\n"
        "elif mode == 'timeout':\n"
        "    (root / 'timeout-started').write_text('started')\n"
        "    time.sleep(4)\n"
        "    (root / 'timeout-late-mutation').write_text('unexpected')\n"
        "elif mode == 'hold':\n"
        "    (root / 'hold-started').write_text('started')\n"
        "    time.sleep(4)\n"
        "elif mode == 'queued':\n"
        "    (root / 'queued-late-mutation').write_text('unexpected')\n",
        encoding="utf-8",
    )
    return root


def _patch(before="old", after="new"):
    return f"diff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-{before}\n+{after}\n"


def _require(actual, expected, label):
    if actual != expected:
        raise AssertionError(label)


def run(case_root: Path, source_root: Path) -> dict:
    case_root = case_root.resolve()
    case_root.mkdir(parents=True, exist_ok=True)
    receipt: dict[str, Any] = {"component": "bridge", "status": "PASS", "cases": [], "processes": [], "errors": []}
    normal = None
    injected = None
    try:
        normal_root = case_root / "normal"
        workspace = _initialize_workspace(normal_root, source_root, receipt["processes"])
        normal = BridgeProcess(normal_root, source_root, workspace)
        with normal:
            def expect(label, actual, expected, classification="E2E", **evidence):
                _require(actual, expected, label)
                receipt["cases"].append({"case": label, "status": "PASS", "classification": classification, **evidence})

            for label, token in (("missing_token", None), ("wrong_token", "wrong-purpose-bound-value")):
                status, body = normal.request("POST", "/commands/run", {}, token=token, label=label)
                expect(label, (status, body["status"]), (403, "forbidden"))
            status, body = normal.request("POST", "/commands/run", {}, headers={"Content-Type": "text/plain"}, label="content_type")
            expect("content_type", (status, body["status"]), (415, "unsupported_media_type"))
            # The server rejects the declared length before consuming a body.
            # Send headers first so its intended early close cannot race a large
            # client send and hide the actual HTTP 413 response.
            declared_length = 1024 * 1024 + 1
            status, body = normal.request("POST", "/commands/run", raw=b"", headers={"Content-Length": str(declared_length)}, label="oversize")
            expect("oversize", (status, body["status"]), (413, "payload_too_large"), declared_bytes=declared_length, body_sent_bytes=0)
            status, body = normal.request("POST", "/commands/run", raw=b"{not-json", label="malformed")
            expect("malformed", (status, body["status"]), (400, "invalid_request"))
            status, body = normal.command_request("git status --short", proposal="wrong-proposal", label="proposal_mismatch")
            expect("proposal_binding", (status, body["status"]), (400, "proposal_mismatch"))
            status, body = normal.command_request("git status --short", proposal=_proposal("command", "git status", workspace), label="changed_command")
            expect("changed_command_approval", (status, body["status"]), (400, "proposal_mismatch"))
            subdirectory = workspace / "subdirectory"
            subdirectory.mkdir()
            status, body = normal.command_request("git status", cwd=subdirectory, proposal=_proposal("command", "git status", workspace), label="changed_cwd")
            expect("changed_cwd_approval", (status, body["status"]), (400, "proposal_mismatch"))
            status, body = normal.request("POST", "/patches/apply", {
                "patch": _patch(after="changed"), "cwd": str(workspace),
                "proposalId": _proposal("patch", _patch(), workspace),
            }, label="changed_patch")
            expect("changed_patch_approval", (status, body["status"]), (400, "proposal_mismatch"))
            status, body = normal.command_request("git status --short", label="valid_command")
            expect("valid_command", (status, body["status"], body["exitCode"]), (200, "completed", 0))
            status, body = normal.command_request("git show --no-patch acceptance-ref-does-not-exist", label="nonzero_command")
            expect("nonzero_command", (status, body["status"], body["exitCode"]), (200, "failed", 128))
            outside = normal_root / "outside"
            outside.mkdir()
            status, body = normal.command_request("git status", cwd=outside, label="outside_sandbox")
            expect("sandbox", (status, body["status"]), (400, "invalid_request"))
            for mode in ("credential", "private", "bounds"):
                status, body = normal.command_request("python validate_backend_cli_offline.py " + mode, label=mode)
                expect(mode, (status, body["status"], body["exitCode"]), (200, "completed", 0))
                if mode == "credential":
                    expect("failure_text_preserved", "The operation did not complete." in body["stdout"], True)
                elif mode == "private":
                    expect("private_withheld", body["stdout"], "[Tool output withheld]")
                else:
                    expect("bounded_output", len(body["stdout"]) <= 16000 and body["truncated"] is True, True, stdout_chars=len(body["stdout"]))
            before = _sha(workspace / "sample.txt")
            history_path = normal_root / "state" / "history.db"
            with sqlite3.connect(history_path) as connection:
                connection.execute("INSERT OR REPLACE INTO kv_state(key,value_json,ts_ms) VALUES('policy.safe_mode','true',0)")
            for kind in ("command", "patch"):
                status, body = normal.command_request("git status", label="safe_mode_command") if kind == "command" else normal.patch(_patch(), label="safe_mode_patch")
                expect("safe_mode_" + kind, (status, body["status"], body["exitCode"]), (200, "blocked", None))
                matching = [row for row in normal.audit() if row.get("audit_id") == body["auditId"] and row.get("event_type") == "daemon." + kind + ".denied"]
                expect("safe_mode_" + kind + "_audit_once", len(matching), 1)
            expect("safe_mode_no_mutation", _sha(workspace / "sample.txt"), before)
            with sqlite3.connect(history_path) as connection:
                connection.execute("UPDATE kv_state SET value_json='false' WHERE key='policy.safe_mode'")
            status, body = normal.patch(_patch(), label="patch_apply")
            expect("patch_apply", (status, body["status"], body["exitCode"]), (200, "completed", 0))
            expect("patch_bytes", (workspace / "sample.txt").read_bytes() == b"new\n", True, before_sha256=before, after_sha256=_sha(workspace / "sample.txt"))
            with sqlite3.connect(history_path) as connection:
                patch_rows = connection.execute("SELECT rollback_id,status FROM patches").fetchall()
            expect("patch_recovery_history", len(patch_rows) == 1 and patch_rows[0][1] == "applied", True, rollback_id=patch_rows[0][0] if patch_rows else None)
            status, body = normal.command_request("python validate_backend_cli_offline.py timeout", timeout=1, label="running_timeout")
            expect("running_timeout", (status, body["status"], body["exitCode"]), (200, "timeout", None))
            expect("timeout_operation_started", (workspace / "timeout-started").exists(), True)
            time.sleep(4.2)
            expect("timeout_no_late_mutation", (workspace / "timeout-late-mutation").exists(), False)
            holder = []
            thread = threading.Thread(target=lambda: holder.append(normal.command_request("python validate_backend_cli_offline.py hold", timeout=6, label="queue_holder")))
            thread.start()
            try:
                deadline = time.monotonic() + 5
                while not (workspace / "hold-started").exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                expect("holder_started", (workspace / "hold-started").exists(), True)
                status, body = normal.command_request("python validate_backend_cli_offline.py queued", timeout=1, label="queued_cancellation")
                expect("queued_cancellation", (status, body["status"], body["exitCode"]), (504, "timeout", None))
            finally:
                thread.join(timeout=12)
            expect("holder_completed", (bool(holder), thread.is_alive()), (True, False))
            time.sleep(0.3)
            expect("queue_no_late_mutation", (workspace / "queued-late-mutation").exists(), False)
            expect("queued_script_never_started", (workspace / "pid-queued.json").exists(), False)
    except Exception as error:
        receipt["status"] = "FAIL"
        receipt["errors"].append({"phase": "normal", "error_type": type(error).__name__, "case": str(error) if isinstance(error, AssertionError) else "bridge_normal_exception"})
    finally:
        if normal is not None:
            receipt["processes"].append(normal.receipt)
    try:
        injected_root = case_root / "postapply_fault"
        workspace = _initialize_workspace(injected_root, source_root, receipt["processes"])
        fault = injected_root / "postapply_fault.py"
        fault.write_text(
            "from pathlib import Path\n"
            "import arcanos.local_agent.patch_handler as patch\n"
            "original_run = patch.run_bounded_process\n"
            "original_validate = patch._validate_patch_targets\n"
            "state = {'applied': False, 'fired': False}\n"
            "def observed_run(argv, **kwargs):\n"
            "    result = original_run(argv, **kwargs)\n"
            "    if 'apply' in argv and result.exit_code == 0: state['applied'] = True\n"
            "    return result\n"
            "def postapply_validate(*args, **kwargs):\n"
            "    if state['applied'] and not state['fired']:\n"
            "        state['fired'] = True\n"
            f"        Path({str(injected_root / 'fault-fired')!r}).write_text('postapply validation fault')\n"
            "        raise PermissionError('injected postapply validation failure')\n"
            "    return original_validate(*args, **kwargs)\n"
            "patch.run_bounded_process = observed_run\n"
            "patch._validate_patch_targets = postapply_validate\n",
            encoding="utf-8",
        )
        injected = BridgeProcess(injected_root, source_root, workspace, fault=fault)
        with injected:
            status, body = injected.patch(_patch(), label="postapply_permission_error")
            _require((status, body["status"], body["exitCode"]), (200, "error", None), "postapply_permission_error")
            _require((workspace / "sample.txt").read_bytes(), b"new\n", "postapply_actual_mutation")
            _require((injected_root / "fault-fired").exists(), True, "postapply_fault_fired")
            events = [row["event_type"] for row in injected.audit()]
            _require(events.count("daemon.patch.recovery_registered"), 1, "recovery_registered_once")
            _require(events.count("daemon.patch.failed"), 1, "postapply_failure_audit_once")
            _require(events.count("daemon.patch.denied"), 0, "postapply_no_denial")
            receipt["cases"].append({"case": "postapply_permission_error", "status": "PASS", "classification": "INJECTED_AFTER_ACTUAL_GIT_APPLY", "after_sha256": _sha(workspace / "sample.txt"), "failure_audit_count": 1, "registration_count": 1})
    except Exception as error:
        receipt["status"] = "FAIL"
        receipt["errors"].append({"phase": "injected", "error_type": type(error).__name__, "case": str(error) if isinstance(error, AssertionError) else "bridge_injected_exception"})
    finally:
        if injected is not None:
            receipt["processes"].append(injected.receipt)
    bridges = [item for item in receipt["processes"] if "requests" in item]
    receipt["http_request_count"] = sum(item["http_request_count"] for item in bridges)
    receipt["cleanup"] = {
        "all_processes_stopped": all(item.get("stopped") for item in receipt["processes"]) and all(proc["stopped"] for item in bridges for proc in item["fixture_processes"]),
        "all_ports_closed": all(item["port_closed"] for item in bridges),
    }
    if not all(receipt["cleanup"].values()):
        receipt["status"] = "FAIL"
    receipt["network_containment"] = all(
        item["containment"]["guard_installed"]
        and item["containment"]["outbound_connect_attempts"] == 0
        and item["containment"]["unexpected_denied_attempts"] == 0
        for item in bridges
    )
    if not receipt["network_containment"]:
        receipt["status"] = "FAIL"
    if any(item.get("evidence_error") for item in bridges):
        receipt["status"] = "FAIL"
    return receipt
