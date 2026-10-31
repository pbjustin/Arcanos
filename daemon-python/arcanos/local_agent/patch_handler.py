"""Shared patch preview and authorized-apply implementation."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import threading
from typing import Any, Mapping
import uuid

from ..config import Config
from ..agentic.history_db import HistoryDB
from ..debug import log_audit_event
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
        "history_recorded",
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
        history_recorded: bool = True,
    ) -> None:
        self.applied = applied
        self.backups = dict(backups)
        self.files = list(files)
        self.patch_sha256 = patch_sha256
        self.process = process
        self.rollback_id = rollback_id
        self.history_recorded = history_recorded


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
    history_session_id: str | None = None,
    history: HistoryDB | None = None,
    history_summary: str = "local patch",
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

    backup_root = Config.PATCH_BACKUP_DIR if backup_root is None else backup_root
    resolved_rollback_id = str(rollback_id or uuid.uuid4())
    backups = _create_patch_backups(
        patch_decision,
        workspace_root=resolved_root,
        backup_root=backup_root,
        rollback_id=resolved_rollback_id,
    )
    recovery = None
    if backup_root is not None:
        recovery = {
            "rollback_id": resolved_rollback_id,
            "workspace": str(resolved_root),
            "root_identity": list(root_identity),
            "git_identity": list(validated_workspace.git_dir_identity),
            "patch_sha256": patch_decision.patch_hash,
            "files": patch_decision.files,
            "backups": backups,
            "before": {
                rel: _file_state(Path(backups[rel])) if rel in backups else None
                for rel in patch_decision.files
            },
            "status": "applying",
        }
        write_patch_recovery(backup_root, resolved_rollback_id, recovery)
        if recovery["before"] != {
            rel: _file_state(resolved_root / rel) for rel in patch_decision.files
        }:
            raise PermissionError("Patch target changed while its backup was prepared.")
    history = history if history_session_id is not None else None
    if history_session_id is not None:
        history = history if history is not None else HistoryDB()
        history.log_patch(
            history_session_id, resolved_rollback_id, "applying", history_summary,
            patch_decision.files, backups, patch_text,
            patch_sha256=patch_decision.patch_hash,
        )
        log_audit_event(
            "daemon.patch.recovery_registered", rollback_id=resolved_rollback_id,
            patch_hash=patch_decision.patch_hash, file_count=len(patch_decision.files),
        )
    applied = False
    process = None
    recovery_recorded = False
    history_recorded = True
    primary_failed = False
    try:
        process = run_bounded_process(
            build_validated_git_argv(
                validated_workspace,
                ["apply", "--whitespace=nowarn", "-"],
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
        applied = process.exit_code == 0
    except BaseException:
        primary_failed = True
        raise
    finally:
        # A failed/terminated process may already have changed files. Preserve
        # the observed state without masking its primary exception/exit code.
        primary_failed = primary_failed or (
            process is not None and process.exit_code != 0
        )
        bookkeeping_error = None
        history_error = None
        try:
            if recovery is not None:
                _validate_patch_targets(patch_decision, resolved_root)
                recovery["after"] = {
                    rel: _file_state(resolved_root / rel)
                    for rel in patch_decision.files
                }
                recovery["status"] = "applied" if applied else "failed"
                write_patch_recovery(backup_root, resolved_rollback_id, recovery)
                recovery_recorded = True
        except Exception as error:
            bookkeeping_error = error
        try:
            if history is not None:
                status = "applied" if applied and recovery_recorded else "failed"
                history.update_patch_status(
                    resolved_rollback_id, status,
                    None if status == "applied" else "patch_application_failed",
                )
        except Exception as error:
            history_recorded = False
            history_error = error
        if bookkeeping_error is not None and not primary_failed:
            raise bookkeeping_error
        diagnostic = bookkeeping_error or history_error
        if diagnostic is not None:
            try:
                log_audit_event(
                    "daemon.patch.recovery_failed", rollback_id=resolved_rollback_id,
                    error_type=type(diagnostic).__name__,
                    outcome="applied" if applied else "failed",
                    history_recorded=history_recorded,
                )
            except Exception:
                pass
    return PatchApplyResult(
        applied=process.exit_code == 0,
        backups=backups,
        files=patch_decision.files,
        patch_sha256=patch_decision.patch_hash,
        process=process,
        rollback_id=resolved_rollback_id,
        history_recorded=history_recorded,
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

    resolved_backup_directory = _recovery_directory(backup_root, rollback_id)
    resolved_backup_directory.mkdir(parents=True, exist_ok=False)
    backups: dict[str, str] = {}
    for relative_file in patch_decision.files:
        source_path = (workspace_root / relative_file).resolve()
        try:
            source_path.relative_to(workspace_root)
        except ValueError as error:
            raise PermissionError("Patch backup path escaped the workspace.") from error
        if not source_path.exists():
            continue
        if not source_path.is_file():
            raise PermissionError("Patch targets must be regular files.")
        destination_path = resolved_backup_directory / "files" / relative_file
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination_path)
        backups[relative_file] = str(destination_path)
    return backups


def _file_state(path: Path) -> dict[str, Any] | None:
    if path.is_symlink():
        raise PermissionError("Patch recovery paths may not be symbolic links.")
    if not path.exists():
        return None
    if not path.is_file():
        raise PermissionError("Patch recovery requires regular files.")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "mode": stat.S_IMODE(path.stat().st_mode)}


def _recovery_directory(backup_root: Path, rollback_id: str) -> Path:
    if str(uuid.UUID(rollback_id)) != rollback_id:
        raise ValueError("Invalid rollback id.")
    root = Path(backup_root).absolute()
    if root.exists():
        path_identity(root)
    directory = root / rollback_id
    if has_link_or_reparse_component(root, directory):
        raise PermissionError("Patch recovery paths may not contain links.")
    return directory


def write_patch_recovery(backup_root: Path, rollback_id: str, record: dict[str, Any]) -> None:
    directory = _recovery_directory(backup_root, rollback_id)
    destination = directory / "manifest.json"
    if has_link_or_reparse_component(directory, destination):
        raise PermissionError("Patch recovery manifest may not be a link.")
    # Atomic metadata replacement avoids accepting a truncated manifest.
    temporary = directory / "manifest.tmp"
    if os.path.lexists(temporary):
        raise PermissionError("Unexpected patch recovery temporary file.")
    temporary_identity = None
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            metadata = os.fstat(handle.fileno())
            temporary_identity = (int(metadata.st_dev), int(metadata.st_ino))
            json.dump(record, handle, ensure_ascii=False, sort_keys=True)
        os.replace(temporary, destination)
    except BaseException:
        # Remove only the unchanged file this call created. Unexpected or
        # replaced paths belong to somebody else; cleanup cannot mask failure.
        try:
            if (temporary_identity is not None
                    and not has_link_or_reparse_component(directory, temporary)
                    and path_identity(temporary) == temporary_identity):
                temporary.unlink()
        except OSError:
            pass
        raise


def read_patch_recovery(backup_root: Path, rollback_id: str) -> dict[str, Any]:
    directory = _recovery_directory(backup_root, rollback_id)
    manifest = directory / "manifest.json"
    if has_link_or_reparse_component(directory, manifest):
        raise PermissionError("Patch recovery manifest may not be a link.")
    if manifest.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("Patch recovery metadata is too large.")
    record = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("rollback_id") != rollback_id:
        raise ValueError("Patch recovery metadata does not match the operation.")
    return record
