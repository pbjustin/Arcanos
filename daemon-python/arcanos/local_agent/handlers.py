"""Typed handler registry for backend-authorized local-agent actions."""

from __future__ import annotations

from datetime import datetime, timezone
from importlib.util import find_spec
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import sys
import threading
import time
from types import MappingProxyType
from typing import Any, Callable, Mapping

from ..protocol_runtime.tools import repository_tools
from .contracts import (
    load_local_agent_capability_catalog,
    validate_local_agent_input,
    validate_local_agent_output,
)
from .patch_handler import (
    PatchExecutionAuthorization,
    apply_authorized_patch,
    preview_patch,
)
from .process_runner import (
    ProcessResult,
    run_bounded_process,
)
from .test_sandbox import (
    resolve_test_execution_policy,
    run_sandboxed_test,
    safe_test_execution_status,
)

LOCAL_AGENT_ACTIONS = (
    "local_agent.status",
    "repo.search",
    "git.status",
    "git.diff",
    "tests.run",
    "patch.preview",
    "patch.apply",
)
TEST_PROFILES = (
    "python-unit",
    "typescript-unit",
    "typescript-integration",
    "backend-cli-contract",
)
_FORBIDDEN_PAYLOAD_FIELDS = frozenset(
    {
        "authorization",
        "authorizationDecision",
        "confirmation",
        "confirmationToken",
        "confirmed",
        "device",
        "deviceId",
        "principal",
        "principalId",
        "repositoryRoot",
        "root",
        "rootPath",
        "workspace",
        "workspaceId",
    }
)
_Handler = Callable[
    [
        Mapping[str, Any],
        Path,
        int,
        PatchExecutionAuthorization | None,
        threading.Event | None,
    ],
    dict[str, Any],
]


def build_local_agent_handler_registry() -> Mapping[str, _Handler]:
    """Return the fixed local-agent handler allowlist."""

    registry = MappingProxyType(
        {
            "local_agent.status": _handle_status,
            "repo.search": _handle_repo_search,
            "git.status": _handle_git_status,
            "git.diff": _handle_git_diff,
            "tests.run": _handle_tests_run,
            "patch.preview": _handle_patch_preview,
            "patch.apply": _handle_patch_apply,
        }
    )
    if tuple(load_local_agent_capability_catalog()) != tuple(registry):
        raise RuntimeError(
            "Python local-agent handlers do not match the generated catalog."
        )
    return registry


def execute_local_agent_action(
    action: str,
    payload: Mapping[str, Any],
    workspace_root: Path,
    timeout_ms: int,
    *,
    mutation_authorization: PatchExecutionAuthorization | None = None,
    cancellation_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Execute one fixed action against a trusted, locally resolved workspace root."""

    registry = build_local_agent_handler_registry()
    if action not in registry:
        raise PermissionError(f'Local-agent action "{action}" is not allowlisted.')
    if not isinstance(payload, Mapping):
        raise ValueError("Local-agent payload must be an object.")
    forbidden_fields = sorted(
        str(field_name)
        for field_name in payload
        if str(field_name) in _FORBIDDEN_PAYLOAD_FIELDS
    )
    if forbidden_fields:
        raise PermissionError(
            "Server-controlled fields are not accepted in action payloads: "
            + ", ".join(forbidden_fields)
        )
    validate_local_agent_input(action, payload)

    resolved_root = Path(workspace_root).resolve()
    if not resolved_root.exists() or not resolved_root.is_dir():
        raise FileNotFoundError(
            f'Registered workspace root "{resolved_root}" is not a directory.'
        )
    if action != "patch.apply" and mutation_authorization is not None:
        raise PermissionError("Mutation authorization is bound only to patch.apply.")
    result = registry[action](
        payload,
        resolved_root,
        max(int(timeout_ms), 1),
        mutation_authorization,
        cancellation_event,
    )
    validate_local_agent_output(action, result)
    return result


def _handle_status(
    _payload: Mapping[str, Any],
    workspace_root: Path,
    _timeout_ms: int,
    _authorization: PatchExecutionAuthorization | None,
    _cancellation_event: threading.Event | None,
) -> dict[str, Any]:
    try:
        daemon_version = version("arcanos")
    except PackageNotFoundError:
        daemon_version = "1.1.2"
    test_policy = safe_test_execution_status()
    daemon_status = (
        "degraded"
        if not test_policy.configuration_valid
        or (test_policy.mode == "sandboxed" and not test_policy.sandbox_available)
        else "ready"
    )
    return {
        "status": daemon_status,
        "daemonVersion": daemon_version,
        "capabilities": list(LOCAL_AGENT_ACTIONS),
        "workspaceRegistered": workspace_root.exists() and workspace_root.is_dir(),
        "testExecutionMode": test_policy.mode,
        "testSandboxAvailable": test_policy.sandbox_available,
        "testSandboxRuntime": test_policy.sandbox_runtime,
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }


def _handle_repo_search(
    payload: Mapping[str, Any],
    workspace_root: Path,
    timeout_ms: int,
    _authorization: PatchExecutionAuthorization | None,
    cancellation_event: threading.Event | None,
) -> dict[str, Any]:
    execution_options: dict[str, Any] = {
        "workspace_root": workspace_root,
        "timeout_ms": timeout_ms,
    }
    if cancellation_event is not None:
        execution_options["cancellation_event"] = cancellation_event
    result = repository_tools.search_repository(dict(payload), **execution_options)
    return _without_root_path(result)


def _handle_git_status(
    payload: Mapping[str, Any],
    workspace_root: Path,
    timeout_ms: int,
    _authorization: PatchExecutionAuthorization | None,
    cancellation_event: threading.Event | None,
) -> dict[str, Any]:
    execution_options: dict[str, Any] = {
        "workspace_root": workspace_root,
        "timeout_ms": timeout_ms,
    }
    if cancellation_event is not None:
        execution_options["cancellation_event"] = cancellation_event
    result = repository_tools.get_repository_status(
        dict(payload),
        **execution_options,
    )
    changes = result.get("changes")
    if isinstance(changes, list) and len(changes) > 1000:
        result["changes"] = changes[:1000]
        result["message"] = "Git status change list was limited to 1000 entries."
    return _without_root_path(result)


def _handle_git_diff(
    payload: Mapping[str, Any],
    workspace_root: Path,
    timeout_ms: int,
    _authorization: PatchExecutionAuthorization | None,
    cancellation_event: threading.Event | None,
) -> dict[str, Any]:
    bounded_payload = dict(payload)
    bounded_payload.setdefault("maxBytes", 32_768)
    execution_options: dict[str, Any] = {
        "workspace_root": workspace_root,
        "timeout_ms": timeout_ms,
    }
    if cancellation_event is not None:
        execution_options["cancellation_event"] = cancellation_event
    result = repository_tools.get_repository_diff(
        bounded_payload,
        **execution_options,
    )
    return _without_root_path(result)


def _handle_tests_run(
    payload: Mapping[str, Any],
    workspace_root: Path,
    timeout_ms: int,
    _authorization: PatchExecutionAuthorization | None,
    cancellation_event: threading.Event | None,
) -> dict[str, Any]:
    policy = resolve_test_execution_policy()
    if policy.mode == "disabled":
        raise PermissionError(
            "Local-agent test execution is disabled by operator policy."
        )
    profile = str(payload.get("profile") or "")
    if profile not in TEST_PROFILES:
        raise ValueError("profile must be one of: " + ", ".join(TEST_PROFILES))

    started_at = time.perf_counter()
    results: list[ProcessResult] = []
    try:
        if policy.mode == "sandboxed":
            results.append(
                run_sandboxed_test(
                    profile,
                    workspace_root,
                    timeout_ms=timeout_ms,
                    cancellation_event=cancellation_event,
                )
            )
        elif policy.mode == "unsandboxed-development-only":
            deadline = started_at + timeout_ms / 1000
            for argv, cwd, environment_overrides in _test_profile_commands(
                profile,
                workspace_root,
            ):
                remaining_ms = max(1, int((deadline - time.perf_counter()) * 1000))
                process_options: dict[str, Any] = {
                    "cwd": cwd,
                    "timeout_ms": remaining_ms,
                    "extra_environment": environment_overrides,
                }
                if cancellation_event is not None:
                    process_options["cancellation_event"] = cancellation_event
                results.append(run_bounded_process(argv, **process_options))
                if results[-1].exit_code != 0:
                    break
        else:
            raise PermissionError(
                "Local-agent test execution policy is not executable."
            )
    except TimeoutError:
        return {
            "profile": profile,
            "status": "timed_out",
            "exitCode": None,
            "stdout": _merge_test_output(results, "stdout")[0],
            "stderr": _merge_test_output(results, "stderr")[0],
            "durationMs": _bounded_test_duration(started_at, timeout_ms),
            "truncated": any(result.truncated for result in results),
        }

    stdout, stdout_truncated = _merge_test_output(results, "stdout")
    stderr, stderr_truncated = _merge_test_output(results, "stderr")
    final_exit_code = results[-1].exit_code if results else 1
    return {
        "profile": profile,
        "status": "passed" if final_exit_code == 0 else "failed",
        "exitCode": final_exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "durationMs": _bounded_test_duration(started_at, timeout_ms),
        "truncated": (
            stdout_truncated
            or stderr_truncated
            or any(result.truncated for result in results)
        ),
    }


def _handle_patch_preview(
    payload: Mapping[str, Any],
    workspace_root: Path,
    timeout_ms: int,
    _authorization: PatchExecutionAuthorization | None,
    cancellation_event: threading.Event | None,
) -> dict[str, Any]:
    patch_text = str(payload.get("patch") or "")
    return preview_patch(
        patch_text,
        workspace_root=workspace_root,
        timeout_ms=timeout_ms,
        cancellation_event=cancellation_event,
    )


def _handle_patch_apply(
    payload: Mapping[str, Any],
    workspace_root: Path,
    timeout_ms: int,
    mutation_authorization: PatchExecutionAuthorization | None,
    cancellation_event: threading.Event | None,
) -> dict[str, Any]:
    if not payload.get("expectedPatchSha256"):
        raise ValueError("expectedPatchSha256 is required for patch.apply.")
    result = apply_authorized_patch(
        payload,
        workspace_root=workspace_root,
        timeout_ms=timeout_ms,
        mutation_authorization=mutation_authorization,
        cancellation_event=cancellation_event,
    )
    if not result.applied:
        error_message = (
            result.process.stderr or result.process.stdout or "git apply failed"
        )
        raise ValueError(error_message)
    return {
        "patchSha256": result.patch_sha256,
        "files": result.files,
        "applied": True,
    }


def _test_profile_commands(
    profile: str,
    workspace_root: Path,
) -> tuple[tuple[tuple[str, ...], Path, Mapping[str, str] | None], ...]:
    unresolved_daemon_root = workspace_root / "daemon-python"
    if unresolved_daemon_root.is_symlink():
        raise PermissionError("The daemon-python test root cannot be a symbolic link.")
    daemon_root = unresolved_daemon_root.resolve()
    try:
        daemon_root.relative_to(workspace_root)
    except ValueError as error:
        raise PermissionError(
            "The daemon-python test root must remain inside the workspace."
        ) from error
    npm_executable = "npm.cmd" if sys.platform == "win32" else "npm"
    if profile == "python-unit":
        if not daemon_root.is_dir():
            raise FileNotFoundError(
                'The "python-unit" profile requires daemon-python in the workspace.'
            )
        return (
            (
                (sys.executable, "-m", "pytest", "tests/"),
                daemon_root,
                _pytest_environment_overrides(),
            ),
        )
    if profile == "typescript-unit":
        return (((npm_executable, "run", "test:unit"), workspace_root, None),)
    if profile == "typescript-integration":
        return (((npm_executable, "run", "test:integration"), workspace_root, None),)
    return (
        ((npm_executable, "run", "build:packages"), workspace_root, None),
        (
            (npm_executable, "run", "validate:backend-cli:contract"),
            workspace_root,
            None,
        ),
    )


def _pytest_environment_overrides() -> Mapping[str, str]:
    pytest_spec = find_spec("pytest")
    if pytest_spec is None or pytest_spec.origin is None:
        return {}
    pytest_site_root = Path(pytest_spec.origin).resolve().parents[1]
    return {
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": str(pytest_site_root),
    }


def _without_root_path(result: Mapping[str, Any]) -> dict[str, Any]:
    return {
        str(key): value
        for key, value in result.items()
        if key != "rootPath" and value is not None
    }


def _merge_test_output(
    results: list[ProcessResult],
    attribute: str,
    *,
    max_characters: int = 12000,
) -> tuple[str, bool]:
    combined = "\n".join(
        value for result in results if (value := str(getattr(result, attribute) or ""))
    )
    if len(combined) <= max_characters:
        return combined, False
    return f"{combined[:max_characters]}\n[truncated]", True


def _bounded_test_duration(started_at: float, timeout_ms: int) -> int:
    elapsed_ms = max(0, int((time.perf_counter() - started_at) * 1000))
    return min(elapsed_ms, timeout_ms, 900000)
