"""
Local daemon HTTP bridge for web-to-daemon command handoff.
"""

from __future__ import annotations

import json
import hashlib
import hmac
import os
import queue
import subprocess
import threading
import time
import uuid
import argparse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from arcanos.debug import log_audit_event
from .cli_policy import (
    command_to_argv,
    evaluate_command_policy,
    redact_output,
    validate_patch_text,
)


DEFAULT_BRIDGE_HOST = "127.0.0.1"
DEFAULT_BRIDGE_PORT = 8765
DEFAULT_TIMEOUT_SECONDS = 30
MAX_OUTPUT_CHARS = 16000
MAX_REQUEST_BYTES = 1024 * 1024
MAX_PENDING_JOBS = 8
REQUEST_READ_TIMEOUT_SECONDS = 5
REQUEST_TOO_LARGE = object()
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
BRIDGE_TOKEN_ENV = "ARCANOS_CLI_BRIDGE_TOKEN"
BRIDGE_TOKEN_HEADER = "x-arcanos-cli-bridge-token"


@dataclass
class BridgeJob:
    audit_id: str
    command: str
    proposal_id: str
    timeout: int
    cwd: str | None
    done: threading.Event
    result: dict[str, Any] | None = None


@dataclass
class BridgePatchJob:
    audit_id: str
    patch: str
    proposal_id: str
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
        if self.host not in LOOPBACK_HOSTS:
            raise ValueError("Local bridge host must be loopback")
        self.port = int(port)
        self.bridge_token = os.environ.get(BRIDGE_TOKEN_ENV, "").strip()
        if os.environ.get("ARCANOS_CLI_BRIDGE_ENABLED") == "true" and not self.bridge_token:
            raise ValueError("ARCANOS_CLI_BRIDGE_TOKEN is required when the local bridge is enabled")
        self.jobs: queue.Queue[BridgeJob | BridgePatchJob | None] = queue.Queue(maxsize=MAX_PENDING_JOBS)
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="local-bridge-worker")

    def serve_forever(self) -> None:
        self._worker.start()
        server = self._build_server()
        log_audit_event(
            "daemon.started",
            host=self.host,
            port=self.port,
            token_required=True,
            queue_max_size=MAX_PENDING_JOBS,
            request_max_bytes=MAX_REQUEST_BYTES,
        )
        try:
            server.serve_forever()
        finally:
            try:
                self.jobs.put_nowait(None)
            except queue.Full:
                pass
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
                log_audit_event("daemon.health.checked", status="ready")

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
                if not bridge._is_authorized(self.headers.get(BRIDGE_TOKEN_HEADER)):
                    self._send_json(
                        403,
                        _empty_response(
                            ok=False,
                            status="forbidden",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="Bridge token is required",
                        ),
                    )
                    return
                content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                if content_type != "application/json":
                    self._send_json(
                        415,
                        _empty_response(
                            ok=False,
                            status="unsupported_media_type",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="Content-Type must be application/json",
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
                proposal_id = payload.get("proposalId")
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
                if not isinstance(proposal_id, str) or not proposal_id.strip():
                    self._send_json(
                        400,
                        _empty_response(
                            ok=False,
                            status="proposal_required",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="proposalId is required",
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
                try:
                    resolved_cwd = _resolve_sandboxed_cwd(cwd)
                except ValueError as exc:
                    self._send_json(
                        400,
                        _empty_response(
                            ok=False,
                            status="invalid_request",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr=str(exc),
                        ),
                    )
                    return
                job: BridgeJob | BridgePatchJob
                if is_patch_apply:
                    patch_decision = validate_patch_text(patch, resolved_cwd)
                    expected_proposal_id = _hash_proposal({"kind": "patch", "patch": patch, "cwd": resolved_cwd})
                    if proposal_id.strip() != expected_proposal_id:
                        self._send_json(
                            400,
                            _empty_response(
                                ok=False,
                                status="proposal_mismatch",
                                exit_code=1,
                                duration_ms=_elapsed_ms(start),
                                audit_id=audit_id,
                                stderr="proposalId does not match patch and cwd",
                            ),
                        )
                        return
                    if not patch_decision.allowed:
                        log_audit_event(
                            "daemon.patch.denied",
                            audit_id=audit_id,
                            proposal_id=proposal_id.strip(),
                            patch_hash=patch_decision.patch_hash,
                            reason=patch_decision.reason,
                            file_count=len(patch_decision.files),
                        )
                        self._send_json(
                            400,
                            _empty_response(
                                ok=False,
                                status="denied",
                                exit_code=1,
                                duration_ms=_elapsed_ms(start),
                                audit_id=audit_id,
                                stderr=patch_decision.reason or "Patch denied by policy",
                            ),
                        )
                        return
                    log_audit_event(
                        "daemon.patch.proposed",
                        audit_id=audit_id,
                        proposal_id=proposal_id.strip(),
                        patch_hash=patch_decision.patch_hash,
                        file_count=len(patch_decision.files),
                    )
                    job = BridgePatchJob(
                        audit_id=audit_id,
                        patch=patch,
                        proposal_id=proposal_id.strip(),
                        timeout=timeout,
                        cwd=resolved_cwd,
                        done=threading.Event(),
                    )
                else:
                    command_decision = evaluate_command_policy(command.strip(), resolved_cwd, timeout * 1000)
                    expected_proposal_id = _hash_proposal({"kind": "command", "command": command.strip(), "cwd": command_decision.cwd})
                    if proposal_id.strip() != expected_proposal_id:
                        self._send_json(
                            400,
                            _empty_response(
                                ok=False,
                                status="proposal_mismatch",
                                exit_code=1,
                                duration_ms=_elapsed_ms(start),
                                audit_id=audit_id,
                                stderr="proposalId does not match command and cwd",
                            ),
                        )
                        return
                    if not command_decision.allowed:
                        log_audit_event(
                            "daemon.command.denied",
                            audit_id=audit_id,
                            proposal_id=proposal_id.strip(),
                            command_hash=hashlib.sha256(command.strip().encode("utf-8")).hexdigest(),
                            reason=command_decision.reason,
                        )
                        self._send_json(
                            400,
                            _empty_response(
                                ok=False,
                                status="denied",
                                exit_code=1,
                                duration_ms=_elapsed_ms(start),
                                audit_id=audit_id,
                                stderr=command_decision.reason or "Command denied by policy",
                            ),
                        )
                        return
                    log_audit_event(
                        "daemon.command.proposed",
                        audit_id=audit_id,
                        proposal_id=proposal_id.strip(),
                        command_hash=hashlib.sha256(command.strip().encode("utf-8")).hexdigest(),
                    )
                    log_audit_event(
                        "daemon.command.confirmation_required",
                        audit_id=audit_id,
                        proposal_id=proposal_id.strip(),
                        command_hash=hashlib.sha256(command.strip().encode("utf-8")).hexdigest(),
                    )
                    job = BridgeJob(
                        audit_id=audit_id,
                        command=command.strip(),
                        proposal_id=proposal_id.strip(),
                        timeout=timeout,
                        cwd=command_decision.cwd,
                        done=threading.Event(),
                    )
                try:
                    bridge.jobs.put_nowait(job)
                except queue.Full:
                    self._send_json(
                        503,
                        _empty_response(
                            ok=False,
                            status="queue_full",
                            exit_code=1,
                            duration_ms=_elapsed_ms(start),
                            audit_id=audit_id,
                            stderr="Local bridge queue is full",
                        ),
                    )
                    return
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
                if content_length <= 0:
                    return None
                if content_length > MAX_REQUEST_BYTES:
                    return REQUEST_TOO_LARGE
                self.connection.settimeout(REQUEST_READ_TIMEOUT_SECONDS)
                try:
                    raw = self.rfile.read(content_length)
                except OSError:
                    return None
                if len(raw) != content_length:
                    return None
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

    def _is_authorized(self, provided_token: str | None) -> bool:
        return bool(self.bridge_token and provided_token and hmac.compare_digest(provided_token, self.bridge_token))

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
                failed_event = "daemon.patch.failed" if isinstance(job, BridgePatchJob) else "daemon.command.failed"
                log_audit_event(
                    failed_event,
                    audit_id=job.audit_id,
                    error_type=type(exc).__name__,
                )
                job.result = _empty_response(
                    ok=False,
                    status="error",
                    exit_code=1,
                    duration_ms=_elapsed_ms(start),
                    audit_id=job.audit_id,
                    stderr="Bridge execution failed",
                )
            finally:
                job.done.set()

    def _run_command(self, job: BridgeJob) -> tuple[str | None, str | None, int]:
        return self._execute_bounded(job.command, _resolve_sandboxed_cwd(job.cwd), job.timeout)

    def _apply_patch(self, job: BridgePatchJob) -> tuple[str | None, str | None, int]:
        cwd = _resolve_sandboxed_cwd(job.cwd)
        patch_decision = validate_patch_text(job.patch, cwd)
        if not patch_decision.allowed:
            raise ValueError(patch_decision.reason or "Patch denied by policy")
        log_audit_event(
            "daemon.patch.confirmation_required",
            audit_id=job.audit_id,
            proposal_id=job.proposal_id,
            patch_hash=patch_decision.patch_hash,
        )
        start = time.perf_counter()
        process = subprocess.run(
            ["git", "apply", "--whitespace=nowarn", "-"],
            input=job.patch,
            text=True,
            capture_output=True,
            cwd=cwd,
            timeout=job.timeout,
            encoding="utf-8",
            errors="replace",
        )
        stdout = redact_output((process.stdout or "").strip())
        stderr = redact_output((process.stderr or "").strip())
        event = "daemon.patch.applied" if process.returncode == 0 else "daemon.patch.failed"
        log_audit_event(
            event,
            audit_id=job.audit_id,
            proposal_id=job.proposal_id,
            patch_hash=patch_decision.patch_hash,
            duration_ms=_elapsed_ms(start),
            return_code=process.returncode,
        )
        return stdout, stderr, process.returncode

    def _execute_bounded(self, command: str, cwd: str, timeout: int) -> tuple[str | None, str | None, int]:
        command_hash = hashlib.sha256(command.encode("utf-8")).hexdigest()
        decision = evaluate_command_policy(command, cwd, timeout * 1000)
        if not decision.allowed:
            log_audit_event(
                "daemon.command.denied",
                command_hash=command_hash,
                command_length=len(command),
                reason=decision.reason,
                source="local_bridge",
                outcome="blocked",
            )
            raise ValueError(decision.reason or "Command denied by policy")

        log_audit_event(
            "daemon.command.started",
            command_hash=command_hash,
            command_length=len(command),
            cwd=decision.cwd,
            source="local_bridge",
            outcome="attempting",
        )
        try:
            process = subprocess.Popen(
                command_to_argv(command),
                cwd=decision.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except Exception as exc:
            log_audit_event(
                "daemon.command.failed",
                command_hash=command_hash,
                command_length=len(command),
                source="local_bridge",
                outcome="error",
                error_type=type(exc).__name__,
            )
            raise
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        stdout_truncated = False
        stderr_truncated = False

        def reader(stream: Any, chunks: list[str], truncated_flag: str) -> None:
            nonlocal stdout_truncated, stderr_truncated
            stored = 0
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                remaining = MAX_OUTPUT_CHARS - stored
                if remaining > 0:
                    chunks.append(chunk[:remaining])
                    stored += min(len(chunk), remaining)
                if len(chunk) > remaining:
                    if truncated_flag == "stdout":
                        stdout_truncated = True
                    else:
                        stderr_truncated = True

        stdout_thread = threading.Thread(target=reader, args=(process.stdout, stdout_chunks, "stdout"), daemon=True)
        stderr_thread = threading.Thread(target=reader, args=(process.stderr, stderr_chunks, "stderr"), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        try:
            return_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            log_audit_event(
                "daemon.command.timeout",
                command_hash=command_hash,
                command_length=len(command),
                source="local_bridge",
                outcome="timeout",
                return_code=None,
            )
            raise TimeoutError(f"Command timed out after {timeout} seconds")
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        stdout = redact_output("".join(stdout_chunks).strip())
        stderr = redact_output("".join(stderr_chunks).strip())
        if stdout_truncated:
            stdout = f"{stdout}\n[truncated]"
        if stderr_truncated:
            stderr = f"{stderr}\n[truncated]"
        log_audit_event(
            "daemon.command.completed",
            command_hash=command_hash,
            command_length=len(command),
            source="local_bridge",
            outcome="completed",
            return_code=return_code,
        )
        return stdout, stderr, return_code


def _coerce_timeout(raw_timeout: Any) -> int:
    if isinstance(raw_timeout, int) and raw_timeout > 0:
        return max(1, int(evaluate_command_policy("git status", timeout_ms=raw_timeout * 1000).timeout_ms / 1000))
    return max(1, int(evaluate_command_policy("git status").timeout_ms / 1000))


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def _resolve_sandboxed_cwd(cwd: str | None) -> str:
    decision = evaluate_command_policy("git status", cwd=cwd)
    if not decision.allowed and decision.reason == "cwd_outside_workspace":
        raise ValueError("cwd outside ARCANOS CLI sandbox")
    return decision.cwd


def _hash_proposal(value: dict[str, Any]) -> str:
    body = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return f"cli-{hashlib.sha256(body.encode('utf-8')).hexdigest()[:16]}"


def run_local_bridge(host: str = DEFAULT_BRIDGE_HOST, port: int = DEFAULT_BRIDGE_PORT) -> None:
    LocalBridge(host=host, port=port).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="ARCANOS local loopback CLI bridge")
    parser.add_argument("--host", default=os.environ.get("ARCANOS_CLI_BRIDGE_HOST", DEFAULT_BRIDGE_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ARCANOS_CLI_BRIDGE_PORT", DEFAULT_BRIDGE_PORT)))
    args = parser.parse_args()
    run_local_bridge(host=args.host, port=args.port)


if __name__ == "__main__":
    main()


__all__ = [
    "DEFAULT_BRIDGE_HOST",
    "DEFAULT_BRIDGE_PORT",
    "run_local_bridge",
]
