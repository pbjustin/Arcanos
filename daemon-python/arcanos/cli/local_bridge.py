"""
Local daemon HTTP bridge for web-to-daemon command handoff.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import tempfile
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from ..terminal import TerminalController


DEFAULT_BRIDGE_HOST = "127.0.0.1"
DEFAULT_BRIDGE_PORT = 8765
DEFAULT_TIMEOUT_SECONDS = 30
MAX_OUTPUT_CHARS = 16000
MAX_REQUEST_BYTES = 1024 * 1024
REQUEST_TOO_LARGE = object()


@dataclass
class BridgeJob:
    audit_id: str
    command: str
    timeout: int
    cwd: str | None
    done: threading.Event
    result: dict[str, Any] | None = None


@dataclass
class BridgePatchJob:
    audit_id: str
    patch: str
    timeout: int
    cwd: str | None
    done: threading.Event
    result: dict[str, Any] | None = None


def _empty_response(
    *,
    ok: bool,
    status: str,
    exit_code: int | None,
    duration_ms: int,
    audit_id: str,
    stdout: str = "",
    stderr: str = "",
    truncated: bool = False,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "status": status,
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": exit_code,
        "durationMs": duration_ms,
        "truncated": truncated,
        "auditId": audit_id,
    }


def _truncate_output(stdout: str, stderr: str) -> tuple[str, str, bool]:
    truncated = False
    if len(stdout) > MAX_OUTPUT_CHARS:
        stdout = stdout[:MAX_OUTPUT_CHARS]
        truncated = True
    if len(stderr) > MAX_OUTPUT_CHARS:
        stderr = stderr[:MAX_OUTPUT_CHARS]
        truncated = True
    return stdout, stderr, truncated


class LocalBridge:
    """
    Purpose: Serve localhost HTTP requests and execute queued daemon-side commands.
    Inputs/Outputs: host/port plus JSON command requests; returns deterministic JSON envelopes.
    Edge cases: Command execution is non-elevated and uses TerminalController safety checks.
    """

    def __init__(self, host: str = DEFAULT_BRIDGE_HOST, port: int = DEFAULT_BRIDGE_PORT):
        self.host = host or DEFAULT_BRIDGE_HOST
        self.port = int(port)
        self.jobs: queue.Queue[BridgeJob | BridgePatchJob | None] = queue.Queue()
        self.terminal = TerminalController()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="local-bridge-worker")

    def serve_forever(self) -> None:
        self._worker.start()
        server = self._build_server()
        try:
            server.serve_forever()
        finally:
            self.jobs.put(None)
            server.server_close()

    def _build_server(self) -> ThreadingHTTPServer:
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path != "/health":
                    self._send_json(
                        404,
                        _empty_response(
                            ok=False,
                            status="not_found",
                            exit_code=1,
                            duration_ms=0,
                            audit_id=f"bridge-{uuid.uuid4().hex[:12]}",
                            stderr="Endpoint not found",
                        ),
                    )
                    return
                self._send_json(
                    200,
                    _empty_response(
                        ok=True,
                        status="ready",
                        exit_code=0,
                        duration_ms=0,
                        audit_id=f"bridge-{uuid.uuid4().hex[:12]}",
                    ),
                )

            def do_POST(self) -> None:
                start = time.perf_counter()
                audit_id = f"bridge-{uuid.uuid4().hex[:12]}"
                if self.path not in {"/commands/run", "/patches/apply"}:
                    self._send_json(
                        404,
                        _empty_response(
                            ok=False,
                            status="not_found",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="Endpoint not found",
                        ),
                    )
                    return

                payload = self._read_payload()
                if payload is REQUEST_TOO_LARGE:
                    self._send_json(
                        413,
                        _empty_response(
                            ok=False,
                            status="payload_too_large",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr=f"Request body must be {MAX_REQUEST_BYTES} bytes or fewer",
                        ),
                    )
                    return

                if not isinstance(payload, dict):
                    self._send_json(
                        400,
                        _empty_response(
                            ok=False,
                            status="invalid_request",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="Request body must be a JSON object",
                        ),
                    )
                    return

                command = payload.get("command")
                patch = payload.get("patch")
                is_patch_apply = self.path == "/patches/apply"
                if not is_patch_apply and (not isinstance(command, str) or not command.strip()):
                    self._send_json(
                        400,
                        _empty_response(
                            ok=False,
                            status="invalid_request",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="Missing command",
                        ),
                    )
                    return
                if is_patch_apply and (not isinstance(patch, str) or not patch.strip()):
                    self._send_json(
                        400,
                        _empty_response(
                            ok=False,
                            status="invalid_request",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="Missing patch",
                        ),
                    )
                    return

                timeout = _coerce_timeout(payload.get("timeoutSeconds"))
                cwd = payload.get("cwd")
                if cwd is not None and not isinstance(cwd, str):
                    self._send_json(
                        400,
                        _empty_response(
                            ok=False,
                            status="invalid_request",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="cwd must be a string",
                        ),
                    )
                    return
                job: BridgeJob | BridgePatchJob
                if is_patch_apply:
                    job = BridgePatchJob(
                        audit_id=audit_id,
                        patch=patch,
                        timeout=timeout,
                        cwd=cwd,
                        done=threading.Event(),
                    )
                else:
                    job = BridgeJob(
                        audit_id=audit_id,
                        command=command.strip(),
                        timeout=timeout,
                        cwd=cwd,
                        done=threading.Event(),
                    )
                bridge.jobs.put(job)
                job.done.wait(timeout + 1)

                if job.result is None:
                    self._send_json(
                        504,
                        _empty_response(
                            ok=False,
                            status="timeout",
                            exit_code=None,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr=f"Command timed out after {timeout} seconds",
                        ),
                    )
                    return

                self._send_json(200, job.result)

            def log_message(self, format: str, *args: Any) -> None:
                return

            def _read_payload(self) -> Any:
                try:
                    content_length = int(self.headers.get("Content-Length") or "0")
                except ValueError:
                    return None
                if content_length > MAX_REQUEST_BYTES:
                    return REQUEST_TOO_LARGE
                raw = self.rfile.read(content_length)
                try:
                    return json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return None

            def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload, sort_keys=True).encode("utf-8")
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return ThreadingHTTPServer((self.host, self.port), Handler)

    def _worker_loop(self) -> None:
        while True:
            job = self.jobs.get()
            if job is None:
                return
            start = time.perf_counter()
            try:
                if isinstance(job, BridgePatchJob):
                    stdout, stderr, exit_code = self._apply_patch(job)
                else:
                    stdout, stderr, exit_code = self._run_command(job)
                normalized_stdout, normalized_stderr, truncated = _truncate_output(stdout or "", stderr or "")
                job.result = _empty_response(
                    ok=exit_code == 0,
                    status="completed" if exit_code == 0 else "failed",
                    stdout=normalized_stdout,
                    stderr=normalized_stderr,
                    exit_code=exit_code,
                    duration_ms=_elapsed_ms(start),
                    truncated=truncated,
                    audit_id=job.audit_id,
                )
            except Exception as exc:
                job.result = _empty_response(
                    ok=False,
                    status="error",
                    exit_code=1,
                    duration_ms=_elapsed_ms(start),
                    audit_id=job.audit_id,
                    stderr=str(exc),
                )
            finally:
                job.done.set()

    def _run_command(self, job: BridgeJob) -> tuple[str | None, str | None, int]:
        with _temporary_cwd(_resolve_sandboxed_cwd(job.cwd)):
            return self.terminal.execute(
                job.command,
                timeout=job.timeout,
                check_safety=True,
                elevated=False,
            )

    def _apply_patch(self, job: BridgePatchJob) -> tuple[str | None, str | None, int]:
        cwd = _resolve_sandboxed_cwd(job.cwd)
        fd, patch_path = tempfile.mkstemp(suffix=".patch", prefix="arcanos_bridge_")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", errors="replace") as handle:
                handle.write(job.patch)
            safe_patch_path = patch_path.replace('"', "")
            with _temporary_cwd(cwd):
                return self.terminal.execute(
                    f'git apply --whitespace=nowarn "{safe_patch_path}"',
                    timeout=job.timeout,
                    check_safety=True,
                    elevated=False,
                )
        finally:
            try:
                os.unlink(patch_path)
            except OSError:
                pass


def _coerce_timeout(raw_timeout: Any) -> int:
    if isinstance(raw_timeout, int) and raw_timeout > 0:
        return min(raw_timeout, DEFAULT_TIMEOUT_SECONDS)
    return DEFAULT_TIMEOUT_SECONDS


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def _resolve_sandboxed_cwd(cwd: str | None) -> str:
    sandbox_root = os.path.abspath(
        os.environ.get("ARCANOS_CLI_SANDBOX_ROOT")
        or os.environ.get("ARCANOS_WORKSPACE_ROOT")
        or os.getcwd()
    )
    requested = os.path.abspath(cwd or sandbox_root)
    try:
        common = os.path.commonpath([sandbox_root, requested])
    except ValueError:
        common = ""
    if common != sandbox_root:
        raise ValueError("cwd outside ARCANOS CLI sandbox")
    return requested


class _temporary_cwd:
    def __init__(self, cwd: str):
        self.cwd = cwd
        self.previous = os.getcwd()

    def __enter__(self) -> None:
        os.chdir(self.cwd)

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        os.chdir(self.previous)


def run_local_bridge(host: str = DEFAULT_BRIDGE_HOST, port: int = DEFAULT_BRIDGE_PORT) -> None:
    LocalBridge(host=host, port=port).serve_forever()


__all__ = [
    "DEFAULT_BRIDGE_HOST",
    "DEFAULT_BRIDGE_PORT",
    "run_local_bridge",
]
