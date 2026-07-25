"""Shared patch preview and authorized-apply implementation."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
from typing import Any, Mapping
import uuid

from ..cli.cli_policy import PatchDecision, validate_patch_text
from .process_runner import ProcessResult, run_bounded_process
from .secure_fs import (
    ValidatedGitWorkspace,
    build_validated_git_argv,
    has_link_or_reparse_component,
    path_identity,
    validate_standalone_git_workspace,
)
from .workspace_registry import is_secret_workspace_path

_PATCH_AUTHORIZATION_SEAL = object()


class PatchExecutionAuthorization:
    """Opaque, exact-payload authorization issued by a trusted local adapter."""

    __slots__ = ("action", "authorization_id", "payload_fingerprint", "_seal")

    def __init__(
        self,
        *,
        action: str,
        authorization_id: str,
        payload_fingerprint: str,
        _seal: object,
    ) -> None:
        if _seal is not _PATCH_AUTHORIZATION_SEAL:
            raise TypeError(
                "PatchExecutionAuthorization must be issued by the trusted adapter."
            )
        self.action = action
        self.authorization_id = authorization_id
        self.payload_fingerprint = payload_fingerprint
        self._seal = _seal


class PatchApplyResult:
    """Internal apply result including rollback backups for current CLI behavior."""

    __slots__ = (
        "applied",
        "backups",
        "files",
        "patch_sha256",
        "process",
        "rollback_id",
    )

    def __init__(
        self,
        *,
        applied: bool,
        backups: Mapping[str, str],
        files: list[str],
        patch_sha256: str,
        process: ProcessResult,
        rollback_id: str,
    ) -> None:
        self.applied = applied
        self.backups = dict(backups)
        self.files = list(files)
        self.patch_sha256 = patch_sha256
        self.process = process
        self.rollback_id = rollback_id


def issue_patch_execution_authorization(
    payload: Mapping[str, Any],
    *,
    authorization_id: str,
) -> PatchExecutionAuthorization:
    """Issue a non-serializable authorization bound to the exact patch payload."""

    normalized_authorization_id = str(authorization_id or "").strip()
    if not normalized_authorization_id:
        raise ValueError("A trusted authorization id is required.")
    return PatchExecutionAuthorization(
        action="patch.apply",
        authorization_id=normalized_authorization_id,
        payload_fingerprint=_payload_fingerprint(payload),
        _seal=_PATCH_AUTHORIZATION_SEAL,
    )


def preview_patch(
    patch_text: str,
    *,
    workspace_root: Path,
    timeout_ms: int,
    cancellation_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Validate a patch and run `git apply --check` without modifying files."""

    validated_workspace = _resolve_git_workspace(
        workspace_root,
        timeout_ms=timeout_ms,
        cancellation_event=cancellation_event,
    )
    resolved_root = validated_workspace.root
    root_identity = path_identity(resolved_root)
    patch_decision = _require_allowed_patch(patch_text, resolved_root)
    process = run_bounded_process(
        build_validated_git_argv(
            validated_workspace,
            [
                "apply",
                "--check",
                "--whitespace=nowarn",
                "-",
            ],
        ),
        cwd=resolved_root,
        timeout_ms=timeout_ms,
        stdin_text=patch_text,
        cancellation_event=cancellation_event,
    )
    if (
        path_identity(resolved_root) != root_identity
        or path_identity(validated_workspace.git_dir)
        != validated_workspace.git_dir_identity
    ):
        raise PermissionError("Workspace identity changed during patch preview.")
    return {
        "patchSha256": patch_decision.patch_hash,
        "files": patch_decision.files,
        "applicable": process.exit_code == 0,
        "check": {
            "exitCode": process.exit_code,
            "stdout": process.stdout,
            "stderr": process.stderr,
            "truncated": process.truncated,
        },
    }


def apply_authorized_patch(
    payload: Mapping[str, Any],
    *,
    workspace_root: Path,
    timeout_ms: int,
    mutation_authorization: PatchExecutionAuthorization | None,
    backup_root: Path | None = None,
    rollback_id: str | None = None,
    cancellation_event: threading.Event | None = None,
) -> PatchApplyResult:
    """Apply an exact authorized patch; callers cannot authorize via payload fields."""

    if (
        mutation_authorization is None
        or not isinstance(mutation_authorization, PatchExecutionAuthorization)
        or mutation_authorization._seal is not _PATCH_AUTHORIZATION_SEAL
        or mutation_authorization.action != "patch.apply"
        or mutation_authorization.payload_fingerprint != _payload_fingerprint(payload)
    ):
        raise PermissionError("patch.apply requires exact trusted authorization.")

    patch_text = str(payload.get("patch") or "")
    validated_workspace = _resolve_git_workspace(
        workspace_root,
        timeout_ms=timeout_ms,
        cancellation_event=cancellation_event,
    )
    resolved_root = validated_workspace.root
    root_identity = path_identity(resolved_root)
    patch_decision = _require_allowed_patch(patch_text, resolved_root)
    expected_patch_hash = payload.get("expectedPatchSha256")
    if (
        expected_patch_hash is not None
        and str(expected_patch_hash).lower() != patch_decision.patch_hash
    ):
        raise ValueError("expectedPatchSha256 does not match the patch payload.")

    resolved_rollback_id = str(rollback_id or uuid.uuid4())
    backups = _create_patch_backups(
        patch_decision,
        workspace_root=resolved_root,
        backup_root=backup_root,
        rollback_id=resolved_rollback_id,
    )
    process = run_bounded_process(
        build_validated_git_argv(
            validated_workspace,
            [
                "apply",
                "--whitespace=nowarn",
                "-",
            ],
        ),
        cwd=resolved_root,
        timeout_ms=timeout_ms,
        stdin_text=patch_text,
        cancellation_event=cancellation_event,
    )
    if (
        path_identity(resolved_root) != root_identity
        or path_identity(validated_workspace.git_dir)
        != validated_workspace.git_dir_identity
    ):
        raise PermissionError("Workspace identity changed during patch application.")
    _validate_patch_targets(patch_decision, resolved_root)
    return PatchApplyResult(
        applied=process.exit_code == 0,
        backups=backups,
        files=patch_decision.files,
        patch_sha256=patch_decision.patch_hash,
        process=process,
        rollback_id=resolved_rollback_id,
    )


def _payload_fingerprint(payload: Mapping[str, Any]) -> str:
    canonical_payload = json.dumps(
        dict(payload),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical_payload.encode("utf-8")).hexdigest()


def _resolve_git_workspace(
    workspace_root: Path,
    *,
    timeout_ms: int,
    cancellation_event: threading.Event | None,
) -> ValidatedGitWorkspace:
    return validate_standalone_git_workspace(
        workspace_root,
        timeout_ms=timeout_ms,
        cancellation_event=cancellation_event,
    )


def _require_allowed_patch(patch_text: str, workspace_root: Path) -> PatchDecision:
    if not patch_text:
        raise ValueError("patch must be a non-empty unified diff.")
    patch_decision = validate_patch_text(patch_text, str(workspace_root))
    if not patch_decision.allowed:
        raise PermissionError(patch_decision.reason or "Patch denied by policy.")
    if len(patch_decision.files) > 1000:
        raise ValueError("Patch may target at most 1000 files.")
    if any(len(relative_path) > 1024 for relative_path in patch_decision.files):
        raise ValueError("Patch paths must be 1024 characters or fewer.")
    if re.search(
        r"^(?:(?:new file mode|deleted file mode|new mode|old mode) 160000|"
        r"index [0-9a-f]+\.\.[0-9a-f]+ 160000)$",
        patch_text,
        re.IGNORECASE | re.MULTILINE,
    ):
        raise PermissionError("Patches may not create or modify Git submodules.")
    if any(
        Path(relative_path).as_posix().casefold() == ".gitmodules"
        for relative_path in patch_decision.files
    ):
        raise PermissionError("Patches may not modify Git submodule metadata.")
    _validate_patch_targets(patch_decision, workspace_root)
    return patch_decision


def _validate_patch_targets(
    patch_decision: PatchDecision,
    workspace_root: Path,
) -> None:
    for relative_file in patch_decision.files:
        relative_path = Path(relative_file)
        if is_secret_workspace_path(relative_path):
            raise PermissionError("Patch target is denied by secret-file policy.")
        _reject_nested_git_workspace(workspace_root, relative_path)
        candidate = workspace_root / relative_path
        if has_link_or_reparse_component(workspace_root, candidate):
            raise PermissionError(
                "Patch targets may not contain symbolic links or reparse points."
            )
        resolved = candidate.resolve()
        try:
            resolved_relative = resolved.relative_to(workspace_root)
        except ValueError as error:
            raise PermissionError("Patch target escaped the workspace.") from error
        if is_secret_workspace_path(resolved_relative):
            raise PermissionError("Resolved patch target is denied by policy.")


def _reject_nested_git_workspace(
    workspace_root: Path,
    relative_path: Path,
) -> None:
    current = workspace_root
    for part in relative_path.parts:
        current = current / part
        nested_git = current / ".git"
        if os.path.lexists(nested_git):
            raise PermissionError(
                "Patch targets inside nested repositories or submodules are unsupported."
            )


def _create_patch_backups(
    patch_decision: PatchDecision,
    *,
    workspace_root: Path,
    backup_root: Path | None,
    rollback_id: str,
) -> dict[str, str]:
    if backup_root is None:
        return {}

    resolved_backup_directory = Path(backup_root).resolve() / rollback_id
    backups: dict[str, str] = {}
    for relative_file in patch_decision.files:
        source_path = (workspace_root / relative_file).resolve()
        try:
            source_path.relative_to(workspace_root)
        except ValueError as error:
            raise PermissionError("Patch backup path escaped the workspace.") from error
        if not source_path.exists() or not source_path.is_file():
            continue
        destination_path = resolved_backup_directory / relative_file
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination_path)
        backups[relative_file] = str(destination_path)
    return backups
