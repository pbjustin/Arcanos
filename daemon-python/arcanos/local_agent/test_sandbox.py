"""Fail-closed container isolation for the fixed ``tests.run`` profiles."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile
import threading
from typing import Optional

from .process_runner import ProcessResult, run_bounded_process
from .secure_fs import stage_sanitized_workspace_snapshot

TEST_EXECUTION_MODE_ENV = "ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE"
UNSANDBOXED_TESTS_ENV = "ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS"
SANDBOX_RUNTIME_ENV = "ARCANOS_LOCAL_AGENT_SANDBOX_RUNTIME"
SANDBOX_IMAGE_ENV = "ARCANOS_LOCAL_AGENT_SANDBOX_IMAGE"
TEST_EXECUTION_MODES = frozenset(
    {"disabled", "sandboxed", "unsandboxed-development-only"}
)
SANDBOX_RUNTIMES = frozenset({"docker", "podman"})
DEFAULT_TEST_EXECUTION_MODE = "disabled"
_IMAGE_DIGEST_RE = re.compile(
    r"(?:[A-Za-z0-9][A-Za-z0-9._/:@-]{0,500}@)?sha256:[a-fA-F0-9]{64}"
)
_TRUE_VALUES = frozenset({"1", "true", "yes"})
_CONTAINER_MEMORY_BYTES = 1024 * 1024 * 1024
_CONTAINER_WORKSPACE_BYTES = 512 * 1024 * 1024
_CONTAINER_TMP_BYTES = 128 * 1024 * 1024
_CONTAINER_PIDS = 128
_CONTAINER_CPUS = "1.0"
_CONTAINER_FILE_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True)
class TestExecutionPolicy:
    mode: str
    sandbox_available: bool
    sandbox_runtime: Optional[str]
    configuration_valid: bool = True


def resolve_test_execution_policy(*, probe_runtime: bool = True) -> TestExecutionPolicy:
    """Resolve the operator-only mode without falling back to host execution."""

    raw_mode = os.environ.get(TEST_EXECUTION_MODE_ENV, DEFAULT_TEST_EXECUTION_MODE)
    mode = raw_mode.strip().lower()
    if mode not in TEST_EXECUTION_MODES:
        raise ValueError(f"{TEST_EXECUTION_MODE_ENV} contains an unsupported mode.")
    if mode == "disabled":
        return TestExecutionPolicy(mode, False, None)
    if mode == "unsandboxed-development-only":
        if _is_production_environment():
            raise PermissionError(
                "Unsandboxed local-agent tests are forbidden in production or Railway."
            )
        if not _environment_true(UNSANDBOXED_TESTS_ENV):
            raise PermissionError(
                f"{UNSANDBOXED_TESTS_ENV}=true is also required for development-only "
                "host test execution."
            )
        return TestExecutionPolicy(mode, False, None)

    runtime, image = _sandbox_configuration()
    available = _probe_container_runtime(runtime, image) if probe_runtime else True
    return TestExecutionPolicy(mode, available, runtime)


def safe_test_execution_status() -> TestExecutionPolicy:
    """Return bounded status metadata even when operator configuration is invalid."""

    try:
        return resolve_test_execution_policy()
    except (OSError, PermissionError, ValueError):
        return TestExecutionPolicy(
            DEFAULT_TEST_EXECUTION_MODE,
            False,
            None,
            configuration_valid=False,
        )


def run_sandboxed_test(
    profile: str,
    workspace_root: Path,
    *,
    timeout_ms: int,
    cancellation_event: threading.Event | None = None,
) -> ProcessResult:
    """Execute one fixed profile in an immutable, resource-bounded container."""

    policy = resolve_test_execution_policy()
    if policy.mode != "sandboxed":
        raise PermissionError("Sandboxed test execution mode is not enabled.")
    if not policy.sandbox_available or policy.sandbox_runtime is None:
        raise PermissionError("The configured local-agent test sandbox is unavailable.")
    runtime, image = _sandbox_configuration()
    if runtime != policy.sandbox_runtime:
        raise PermissionError("Sandbox runtime configuration changed during execution.")

    with tempfile.TemporaryDirectory(prefix="arcanos-local-agent-snapshot-") as temp:
        snapshot = Path(temp) / "input"
        snapshot.mkdir(mode=0o700)
        stage_sanitized_workspace_snapshot(workspace_root, snapshot)
        snapshot_text = str(snapshot.resolve())
        if "," in snapshot_text or "\r" in snapshot_text or "\n" in snapshot_text:
            raise PermissionError("Sandbox snapshot path cannot be represented safely.")

        container_name = f"arcanos-local-agent-{secrets.token_hex(12)}"
        command = _container_run_argv(
            runtime,
            image,
            container_name=container_name,
            snapshot=snapshot_text,
            profile=profile,
        )

        def cleanup_container(_reason: str) -> None:
            try:
                run_bounded_process(
                    (runtime, "rm", "--force", container_name),
                    cwd=Path(workspace_root),
                    timeout_ms=10_000,
                    max_output_chars=1_000,
                )
            except Exception:
                pass

        return run_bounded_process(
            command,
            cwd=Path(workspace_root),
            timeout_ms=timeout_ms,
            max_output_chars=12_000,
            cancellation_event=cancellation_event,
            termination_callback=cleanup_container,
        )


def _container_run_argv(
    runtime: str,
    image: str,
    *,
    container_name: str,
    snapshot: str,
    profile: str,
) -> tuple[str, ...]:
    return (
        *_container_security_argv(
            runtime,
            container_name=container_name,
            snapshot=snapshot,
        ),
        image,
        "python3",
        "/opt/arcanos-sandbox/sandbox_entrypoint.py",
        "--profile",
        profile,
    )


def _container_probe_argv(
    runtime: str,
    image: str,
    *,
    container_name: str,
    snapshot: str,
) -> tuple[str, ...]:
    return (
        *_container_security_argv(
            runtime,
            container_name=container_name,
            snapshot=snapshot,
        ),
        image,
        "python3",
        "/opt/arcanos-sandbox/sandbox_entrypoint.py",
        "--self-test",
    )


def _container_security_argv(
    runtime: str,
    *,
    container_name: str,
    snapshot: str,
) -> tuple[str, ...]:
    return (
        runtime,
        "run",
        "--rm",
        "--pull=never",
        "--name",
        container_name,
        "--network=none",
        "--ipc=none",
        "--read-only",
        "--user=65532:65532",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges=true",
        f"--pids-limit={_CONTAINER_PIDS}",
        f"--memory={_CONTAINER_MEMORY_BYTES}",
        f"--memory-swap={_CONTAINER_MEMORY_BYTES}",
        f"--cpus={_CONTAINER_CPUS}",
        f"--ulimit=fsize={_CONTAINER_FILE_BYTES}:{_CONTAINER_FILE_BYTES}",
        "--stop-timeout=2",
        (
            "--tmpfs=/workspace:"
            f"rw,nosuid,nodev,size={_CONTAINER_WORKSPACE_BYTES},mode=1777"
        ),
        (
            "--tmpfs=/tmp:"
            f"rw,nosuid,nodev,noexec,size={_CONTAINER_TMP_BYTES},mode=1777"
        ),
        f"--mount=type=bind,source={snapshot},target=/input,readonly",
        "--workdir=/workspace",
        "--env=CI=1",
        "--env=HOME=/tmp/home",
        "--env=NO_COLOR=1",
        "--env=PYTHONNOUSERSITE=1",
        "--env=PYTHONDONTWRITEBYTECODE=1",
        "--env=GIT_CONFIG_GLOBAL=/dev/null",
        "--env=GIT_CONFIG_NOSYSTEM=1",
        "--env=GIT_TERMINAL_PROMPT=0",
        "--env=NPM_CONFIG_AUDIT=false",
        "--env=NPM_CONFIG_FUND=false",
        "--env=NPM_CONFIG_IGNORE_SCRIPTS=true",
    )


def _sandbox_configuration() -> tuple[str, str]:
    runtime = os.environ.get(SANDBOX_RUNTIME_ENV, "").strip().lower()
    image = os.environ.get(SANDBOX_IMAGE_ENV, "").strip()
    if runtime not in SANDBOX_RUNTIMES:
        raise ValueError(
            f"{SANDBOX_RUNTIME_ENV} must be one of: "
            + ", ".join(sorted(SANDBOX_RUNTIMES))
        )
    if not _IMAGE_DIGEST_RE.fullmatch(image):
        raise ValueError(
            f"{SANDBOX_IMAGE_ENV} must be an immutable sha256 image reference."
        )
    executable = shutil.which(runtime, path=os.environ.get("PATH", ""))
    if not executable:
        raise FileNotFoundError(
            f'Configured sandbox runtime "{runtime}" was not found.'
        )
    return runtime, image


def _probe_container_runtime(runtime: str, image: str) -> bool:
    with tempfile.TemporaryDirectory(prefix="arcanos-sandbox-probe-") as temp:
        probe_root = Path(temp)
        snapshot = probe_root / "input"
        snapshot.mkdir(mode=0o700)
        container_name = f"arcanos-local-agent-probe-{secrets.token_hex(12)}"

        def cleanup_container(_reason: str) -> None:
            try:
                run_bounded_process(
                    (runtime, "rm", "--force", container_name),
                    cwd=probe_root,
                    timeout_ms=10_000,
                    max_output_chars=1_000,
                )
            except Exception:
                pass

        try:
            result = run_bounded_process(
                _container_probe_argv(
                    runtime,
                    image,
                    container_name=container_name,
                    snapshot=str(snapshot.resolve()),
                ),
                cwd=probe_root,
                timeout_ms=15_000,
                max_output_chars=2_000,
                termination_callback=cleanup_container,
            )
            evidence = json.loads(result.stdout)
        except (Exception, json.JSONDecodeError):
            return False
        return (
            result.exit_code == 0
            and isinstance(evidence, dict)
            and evidence.get("ok") is True
            and evidence.get("version") == 1
        )


def _is_production_environment() -> bool:
    if os.environ.get("NODE_ENV", "").strip().lower() == "production":
        return True
    return any(
        os.environ.get(name, "").strip()
        for name in (
            "RAILWAY_ENVIRONMENT",
            "RAILWAY_ENVIRONMENT_ID",
            "RAILWAY_PROJECT_ID",
            "RAILWAY_SERVICE_ID",
        )
    )


def _environment_true(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUE_VALUES


__all__ = [
    "DEFAULT_TEST_EXECUTION_MODE",
    "SANDBOX_IMAGE_ENV",
    "SANDBOX_RUNTIME_ENV",
    "TEST_EXECUTION_MODE_ENV",
    "TEST_EXECUTION_MODES",
    "TestExecutionPolicy",
    "resolve_test_execution_policy",
    "run_sandboxed_test",
    "safe_test_execution_status",
]
