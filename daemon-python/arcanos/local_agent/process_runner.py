"""Bounded subprocess execution for fixed local-agent operations."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from ..cli.cli_policy import redact_output

DEFAULT_MAX_OUTPUT_CHARS = 12000
DEFAULT_TIMEOUT_MS = 30000
MAX_TIMEOUT_MS = 900000
_SAFE_ENVIRONMENT_NAMES = (
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
)
_SAFE_EXTRA_ENVIRONMENT_NAMES = frozenset(
    {
        "PYTHONNOUSERSITE",
        "PYTHONPATH",
    }
)


@dataclass(frozen=True)
class ProcessResult:
    """Sanitized result from one fixed-argument subprocess."""

    argv: tuple[str, ...]
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    truncated: bool


class ProcessCancelledError(RuntimeError):
    """Raised after a bounded child is terminated due to lease/shutdown loss."""


def sanitized_subprocess_environment(
    extra: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build a minimal environment without inherited credentials or runtime secrets."""

    environment = {
        name: value
        for name in _SAFE_ENVIRONMENT_NAMES
        if (value := os.environ.get(name))
    }
    environment.update(
        {
            "CI": "1",
            "GCM_INTERACTIVE": "Never",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_PAGER": "cat",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ATTR_NOSYSTEM": "1",
            "LANG": environment.get("LANG", "C"),
            "LC_ALL": environment.get("LC_ALL", "C"),
            "NO_COLOR": "1",
            "NoDefaultCurrentDirectoryInExePath": "1",
        }
    )
    if extra:
        unexpected_names = sorted(
            str(key) for key in extra if str(key) not in _SAFE_EXTRA_ENVIRONMENT_NAMES
        )
        if unexpected_names:
            raise ValueError(
                "Unsupported subprocess environment overrides: "
                + ", ".join(unexpected_names)
            )
        environment.update({str(key): str(value) for key, value in extra.items()})
    return environment


def run_bounded_process(
    argv: Sequence[str],
    *,
    cwd: Path,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    stdin_text: str | None = None,
    max_output_chars: int = DEFAULT_MAX_OUTPUT_CHARS,
    extra_environment: Mapping[str, str] | None = None,
    cancellation_event: threading.Event | None = None,
    termination_callback: Callable[[str], None] | None = None,
    preserve_nul: bool = False,
) -> ProcessResult:
    """Run a fixed argv without a shell, enforcing time and captured-output bounds."""

    normalized_argv = tuple(str(argument) for argument in argv)
    if not normalized_argv or not normalized_argv[0]:
        raise ValueError("A fixed executable argv is required.")
    resolved_cwd = Path(cwd).resolve()
    if not resolved_cwd.exists() or not resolved_cwd.is_dir():
        raise FileNotFoundError(f'Process cwd "{resolved_cwd}" is not a directory.')

    resolved_timeout_ms = min(max(int(timeout_ms), 1), MAX_TIMEOUT_MS)
    resolved_output_limit = max(int(max_output_chars), 0)
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    truncated = {"stdout": False, "stderr": False}
    process_environment = sanitized_subprocess_environment(extra_environment)
    process_environment.setdefault("HOME", str(resolved_cwd))
    process_environment.setdefault("USERPROFILE", str(resolved_cwd))
    executable = _resolve_trusted_executable(
        normalized_argv[0],
        cwd=resolved_cwd,
        environment=process_environment,
    )
    normalized_argv = (str(executable), *normalized_argv[1:])

    popen_options: dict[str, Any] = {}
    if os.name == "nt":
        popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_options["start_new_session"] = True

    started_at = time.perf_counter()
    process = subprocess.Popen(
        normalized_argv,
        cwd=str(resolved_cwd),
        env=process_environment,
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        **popen_options,
    )

    def read_stream(stream: object, chunks: list[str], stream_name: str) -> None:
        stored_characters = 0
        while True:
            chunk = stream.read(4096)  # type: ignore[attr-defined]
            if not chunk:
                return
            remaining = resolved_output_limit - stored_characters
            if remaining > 0:
                chunks.append(chunk[:remaining])
                stored_characters += min(len(chunk), remaining)
            if len(chunk) > max(remaining, 0):
                truncated[stream_name] = True

    stdout_thread = threading.Thread(
        target=read_stream,
        args=(process.stdout, stdout_chunks, "stdout"),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=read_stream,
        args=(process.stderr, stderr_chunks, "stderr"),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()

    if stdin_text is not None and process.stdin is not None:
        try:
            process.stdin.reconfigure(newline="")
            process.stdin.write(stdin_text)
            process.stdin.close()
        except BrokenPipeError:
            pass

    deadline = time.monotonic() + resolved_timeout_ms / 1000
    while True:
        if cancellation_event is not None and cancellation_event.is_set():
            _terminate_process_tree(process)
            _invoke_termination_callback(termination_callback, "cancelled")
            stdout_thread.join(timeout=1)
            stderr_thread.join(timeout=1)
            raise ProcessCancelledError("Process execution was cancelled.")
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            _terminate_process_tree(process)
            _invoke_termination_callback(termination_callback, "timeout")
            stdout_thread.join(timeout=1)
            stderr_thread.join(timeout=1)
            raise TimeoutError(
                f"Process timed out after {resolved_timeout_ms} milliseconds."
            )
        try:
            exit_code = process.wait(timeout=min(0.1, remaining_seconds))
            break
        except subprocess.TimeoutExpired:
            continue

    stdout_thread.join(timeout=1)
    stderr_thread.join(timeout=1)
    output_was_truncated = truncated["stdout"] or truncated["stderr"]
    stdout = redact_output(
        "".join(stdout_chunks).strip(),
        apply_truncation=False,
        preserve_record_separators=preserve_nul,
    )
    stderr = redact_output(
        "".join(stderr_chunks).strip(),
        apply_truncation=False,
        preserve_record_separators=preserve_nul,
    )
    if truncated["stdout"] and not stdout.endswith("[truncated]"):
        stdout = f"{stdout}\n[truncated]".lstrip()
    if truncated["stderr"] and not stderr.endswith("[truncated]"):
        stderr = f"{stderr}\n[truncated]".lstrip()

    return ProcessResult(
        argv=normalized_argv,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_ms=max(0, int((time.perf_counter() - started_at) * 1000)),
        truncated=output_was_truncated,
    )


def _resolve_trusted_executable(
    executable: str,
    *,
    cwd: Path,
    environment: Mapping[str, str],
) -> Path:
    candidate = Path(executable)
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        if candidate.parent != Path("."):
            raise PermissionError("Relative executable paths are not allowed.")
        discovered = shutil.which(executable, path=environment.get("PATH", ""))
        if not discovered:
            raise FileNotFoundError(
                f'Allowlisted executable "{executable}" was not found.'
            )
        resolved = Path(discovered).resolve()
    if not resolved.exists() or not resolved.is_file():
        raise FileNotFoundError(f'Allowlisted executable "{executable}" was not found.')
    try:
        resolved.relative_to(cwd)
    except ValueError:
        return resolved
    raise PermissionError(
        "Executables inside the registered workspace are not trusted."
    )


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
            taskkill = Path(system_root) / "System32" / "taskkill.exe"
            subprocess.run(
                (str(taskkill), "/PID", str(process.pid), "/T", "/F"),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
                shell=False,
                env=sanitized_subprocess_environment(),
            )
            if process.poll() is None:
                process.kill()
        else:
            kill_process_group = getattr(os, "killpg")
            kill_process_group(process.pid, getattr(signal, "SIGKILL"))
    except (OSError, ProcessLookupError, subprocess.TimeoutExpired):
        process.kill()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


def _invoke_termination_callback(
    callback: Callable[[str], None] | None,
    reason: str,
) -> None:
    if callback is None:
        return
    try:
        callback(reason)
    except Exception:
        pass


__all__ = [
    "ProcessCancelledError",
    "ProcessResult",
    "run_bounded_process",
    "sanitized_subprocess_environment",
]
