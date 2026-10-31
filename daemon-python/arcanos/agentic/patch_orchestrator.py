
from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from rich.console import Console
from rich.syntax import Syntax

from ..config import Config
from ..cli.cli_policy import validate_patch_text
from ..voice_boundary import sanitize_tool_output
from ..local_agent.patch_handler import (
    apply_authorized_patch,
    issue_patch_execution_authorization,
    read_patch_recovery,
    write_patch_recovery,
    _file_state,
    _require_allowed_patch,
)
from ..local_agent.secure_fs import has_link_or_reparse_component, path_identity
from .history_db import HistoryDB
from .policy_guard import PolicyGuard


def _dry_run_active(value: bool | Callable[[], bool]) -> bool:
    return bool(value() if callable(value) else value)


def _parse_files_from_patch(patch_text: str) -> list[str]:
    files: list[str] = []
    for line in patch_text.splitlines():
        line = line.strip()
        if line.startswith("+++ b/"):
            files.append(line.replace("+++ b/", "", 1).strip())
    if not files:
        for line in patch_text.splitlines():
            if line.startswith("+++ "):
                p = line[4:].strip()
                if p.startswith("b/"):
                    p = p[2:]
                files.append(p)
    out, seen = [], set()
    for f in files:
        if f and f not in seen:
            seen.add(f)
            out.append(f)
    return out


def _find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for _ in range(50):
        if (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            return start.resolve()
        cur = cur.parent
    return start.resolve()


@dataclass
class ApplyResult:
    ok: bool
    rollback_id: str
    files: list[str]
    backups: dict[str, str]
    error: Optional[str] = None
    status: str = ""
    approved: bool = False
    workspace_changed: bool | None = False
    exit_code: int | None = None

    def __post_init__(self) -> None:
        if not self.status:
            self.status = "applied" if self.ok else (
                "denied" if self.error in {
                    "denied", "patch_hash_mismatch", "non_interactive_confirmation_unavailable"
                } else "blocked"
            )


class PatchOrchestrator:
    def __init__(self, console: Console, history: HistoryDB, guard: PolicyGuard) -> None:
        self.console = console
        self.history = history
        self.guard = guard

    def apply_with_approval(self, session_id: str, patch_text: str, summary: str = "", *, dry_run: bool | Callable[[], bool] = False) -> ApplyResult:
        rollback_id = str(uuid.uuid4())
        repo_root = _find_repo_root(Path.cwd())
        patch_decision = validate_patch_text(patch_text, str(repo_root))
        files = patch_decision.files or _parse_files_from_patch(patch_text)

        if not patch_decision.allowed:
            self.console.print(f"[red]Patch blocked:[/red] {patch_decision.reason}")
            self.history.log_patch(
                session_id=session_id,
                rollback_id=rollback_id,
                status="blocked",
                summary=summary or "blocked",
                files=files,
                backups={},
                patch_text=patch_text,
                patch_sha256=patch_decision.patch_hash,
                error=patch_decision.reason,
            )
            self.guard.record_failure(session_id, "patch", {"reason": patch_decision.reason, "rollback_id": rollback_id})
            return ApplyResult(ok=False, rollback_id=rollback_id, files=files, backups={}, error=patch_decision.reason)

        if _dry_run_active(dry_run):
            self.history.log_patch(
                session_id, rollback_id, "proposed", summary or "dry-run proposal",
                files, {}, patch_text, patch_sha256=patch_decision.patch_hash,
                error="dry_run",
            )
            self.console.print("[yellow]Dry-run: patch proposed; no files changed.[/yellow]")
            return ApplyResult(False, rollback_id, files, {}, "dry_run", status="proposed")

        decision = self.guard.check_patch(session_id, patch_text)
        if not decision.allowed:
            self.console.print(f"[red]Patch blocked:[/red] {decision.reason}")
            self.history.log_patch(
                session_id=session_id,
                rollback_id=rollback_id,
                status="blocked",
                summary=summary or "blocked",
                files=[],
                backups={},
                patch_text=patch_text,
                patch_sha256=patch_decision.patch_hash,
                error=decision.reason,
            )
            self.guard.record_failure(session_id, "patch", {"reason": decision.reason, "rollback_id": rollback_id})
            return ApplyResult(ok=False, rollback_id=rollback_id, files=files, backups={}, error=decision.reason)

        self.console.print("\n[bold]=== ARCANOS PATCH PROPOSAL ===[/bold]")
        self.console.print(
            f"[dim]patch_sha256={patch_decision.patch_hash} files={len(files)} "
            f"added={patch_decision.added_lines} removed={patch_decision.removed_lines}[/dim]"
        )
        self.console.print("[dim]Safety: redacted preview, exact hash confirmation, rollback backup before apply.[/dim]")
        self.console.print(Syntax(patch_decision.redacted_preview, "diff", line_numbers=False))

        # //audit assumption: patch application requires explicit operator confirmation; failure risk: non-interactive sessions apply changes without review; expected invariant: patches are denied when confirmation input is unavailable; handling strategy: fail closed before prompts.
        if not sys.stdin or not sys.stdin.isatty():
            denial_reason = "non_interactive_confirmation_unavailable"
            self.console.print("[yellow]Non-interactive session: patch proposal auto-denied.[/yellow]")
            self.history.log_patch(
                session_id,
                rollback_id,
                "denied",
                summary or "non-interactive denied",
                files,
                {},
                patch_text,
                patch_sha256=patch_decision.patch_hash,
                error=denial_reason,
            )
            return ApplyResult(ok=False, rollback_id=rollback_id, files=files, backups={}, error=denial_reason)

        if decision.requires_extra_confirm:
            self.console.print("[yellow]Large patch detected — extra confirmation required.[/yellow]")
            extra = input(f"Type patch SHA-256 to continue ({patch_decision.patch_hash}): ").strip()
            if extra != patch_decision.patch_hash:
                self.history.log_patch(
                    session_id,
                    rollback_id,
                    "denied",
                    summary or "user denied",
                    files,
                    {},
                    patch_text,
                    patch_sha256=patch_decision.patch_hash,
                    error="patch_hash_mismatch",
                )
                return ApplyResult(ok=False, rollback_id=rollback_id, files=files, backups={}, error="patch_hash_mismatch")
        else:
            exact = input(f"Confirm patch SHA-256 ({patch_decision.patch_hash}): ").strip()
            if exact != patch_decision.patch_hash:
                self.history.log_patch(
                    session_id,
                    rollback_id,
                    "denied",
                    summary or "user denied",
                    files,
                    {},
                    patch_text,
                    patch_sha256=patch_decision.patch_hash,
                    error="patch_hash_mismatch",
                )
                return ApplyResult(ok=False, rollback_id=rollback_id, files=files, backups={}, error="patch_hash_mismatch")

        ans = input("\nApply patch? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            self.history.log_patch(
                session_id,
                rollback_id,
                "denied",
                summary or "user denied",
                files,
                {},
                patch_text,
                patch_sha256=patch_decision.patch_hash,
                error="denied",
            )
            return ApplyResult(ok=False, rollback_id=rollback_id, files=files, backups={}, error="denied")

        # Policy may have changed while the operator reviewed the proposal.
        if _dry_run_active(dry_run):
            self.history.log_patch(
                session_id, rollback_id, "proposed", summary or "dry-run proposal",
                files, {}, patch_text, patch_sha256=patch_decision.patch_hash,
                error="dry_run",
            )
            return ApplyResult(False, rollback_id, files, {}, "dry_run",
                               status="proposed", approved=True)
        if self.guard.is_safe_mode():
            reason = "safe mode is enabled (patching disabled)"
            self.history.log_patch(
                session_id, rollback_id, "blocked", summary or "blocked", files,
                {}, patch_text, patch_sha256=patch_decision.patch_hash, error=reason,
            )
            return ApplyResult(False, rollback_id, files, {}, reason, approved=True)

        patch_payload = {
            "patch": patch_text,
            "expectedPatchSha256": patch_decision.patch_hash,
        }
        patch_authorization = issue_patch_execution_authorization(
            patch_payload,
            authorization_id=(
                f"interactive:{session_id}:{rollback_id}:{patch_decision.patch_hash}"
            ),
        )
        backups = {}
        changed = None
        apply_result = None
        try:
            apply_result = apply_authorized_patch(
                patch_payload,
                workspace_root=repo_root,
                timeout_ms=120000,
                mutation_authorization=patch_authorization,
                backup_root=Config.PATCH_BACKUP_DIR,
                rollback_id=rollback_id,
                history_session_id=session_id,
                history=self.history,
                history_summary=summary or "local patch",
            )
            backups = apply_result.backups
            recovery = read_patch_recovery(Config.PATCH_BACKUP_DIR, rollback_id)
            changed = recovery["before"] != recovery["after"]
        except Exception as error:
            # Backups/recovery metadata can exist even when process execution or
            # post-apply validation raises. Keep the operation addressable.
            try:
                recovery = read_patch_recovery(Config.PATCH_BACKUP_DIR, rollback_id)
                backups = recovery.get("backups", {})
                if "after" in recovery:
                    changed = recovery["before"] != recovery["after"]
            except (OSError, ValueError, PermissionError):
                pass
            observed_exit = apply_result.process.exit_code if apply_result is not None else None
            preapply_history_failure = isinstance(error, sqlite3.Error) and apply_result is None
            if preapply_history_failure:
                reason = "patch_history_unavailable_before_execution"
                changed = False
            elif apply_result is not None and not apply_result.applied:
                reason = sanitize_tool_output(
                    apply_result.process.stderr or apply_result.process.stdout
                    or f"git apply failed rc={observed_exit}"
                )
            else:
                reason = sanitize_tool_output(str(error)) or type(error).__name__
            status = "blocked" if preapply_history_failure else "failed"
            try:
                self.history.log_patch(
                    session_id, rollback_id, status, summary or "apply failed",
                    files, backups, patch_text, patch_sha256=patch_decision.patch_hash,
                    error=reason,
                )
                self.guard.record_failure(session_id, "patch", {"error": reason, "rollback_id": rollback_id})
            except Exception:
                reason = self._history_warning(rollback_id, status, reason)
            return ApplyResult(False, rollback_id, files, backups, reason,
                               status=status, approved=True, workspace_changed=changed,
                               exit_code=observed_exit)
        status = "applied" if apply_result.applied else "failed"
        reason = None if apply_result.applied else sanitize_tool_output(
            apply_result.process.stderr or apply_result.process.stdout
            or f"git apply failed rc={apply_result.process.exit_code}"
        )
        history_recorded = apply_result.history_recorded
        try:
            if apply_result.applied:
                self.guard.record_success()
            else:
                if history_recorded:
                    self.history.update_patch_status(rollback_id, "failed", reason)
                self.guard.record_failure(session_id, "patch", {"error": reason, "rollback_id": rollback_id})
        except Exception:
            history_recorded = False
        if not history_recorded:
            reason = self._history_warning(rollback_id, status, reason)
        if apply_result.applied:
            self.console.print(f"[green]Patch applied.[/green] rollback_id={rollback_id}")
        return ApplyResult(
            ok=apply_result.applied, rollback_id=rollback_id, files=files,
            backups=backups, error=reason, status=status, approved=True,
            workspace_changed=changed, exit_code=apply_result.process.exit_code,
        )

    def _history_warning(self, rollback_id: str, status: str, reason: str | None) -> str:
        warning = f"patch_{status}_history_incomplete_manual_reconciliation_required"
        self.console.print(
            f"Patch {status}; history is incomplete. Retain rollback_id={rollback_id} "
            "for manual reconciliation; no rollback has been performed.",
            markup=False,
        )
        return f"{reason}; {warning}" if reason else warning

    def rollback(self, session_id: str, rollback_id: str, *, dry_run: bool | Callable[[], bool] = False) -> bool:
        record = self.history.get_patch(rollback_id)
        if not record or record.get("status") not in {"applying", "applied", "failed", "rollback_failed"}:
            self.console.print("[red]Rollback unavailable for this operation state.[/red]")
            return False
        if _dry_run_active(dry_run) or self.guard.is_safe_mode():
            self.console.print("[yellow]Rollback blocked by dry-run or safe mode.[/yellow]")
            return False

        restoration_started = False
        try:
            recovery = read_patch_recovery(Config.PATCH_BACKUP_DIR, rollback_id)
            if record.get("status") == "applying" and recovery.get("status") not in {"applied", "failed"}:
                raise PermissionError("Patch outcome requires manual reconciliation before rollback.")
            self._validate_recovery(record, recovery)
            if not sys.stdin or not sys.stdin.isatty():
                raise PermissionError("non_interactive_confirmation_unavailable")
            exact = input(f"Confirm rollback id ({rollback_id}): ").strip()
            if exact != rollback_id:
                raise PermissionError("rollback_confirmation_mismatch")
            if _dry_run_active(dry_run) or self.guard.is_safe_mode():
                raise PermissionError("Rollback blocked by dry-run or safe mode.")
            self._validate_recovery(record, recovery)
            recovery["status"] = "rolling_back"
            write_patch_recovery(Config.PATCH_BACKUP_DIR, rollback_id, recovery)
            restoration_started = True
            repo_root = Path(recovery["workspace"])
            for rel in recovery["files"]:
                # Recheck each path immediately before touching it; another file
                # failing must not erase the remaining recovery information.
                self._validate_recovery(record, recovery, only=rel)
                if _dry_run_active(dry_run) or self.guard.is_safe_mode():
                    raise PermissionError("Rollback blocked by dry-run or safe mode.")
                destination = repo_root / rel
                if _file_state(destination) != recovery["before"][rel]:
                    if recovery["before"][rel] is None:
                        destination.unlink()
                    else:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(Path(recovery["backups"][rel]), destination)
                    if _file_state(destination) != recovery["before"][rel]:
                        raise OSError("Rollback verification failed.")
                recovery.setdefault("restored", []).append(rel)
                write_patch_recovery(Config.PATCH_BACKUP_DIR, rollback_id, recovery)
            recovery["status"] = "rolled_back"
            write_patch_recovery(Config.PATCH_BACKUP_DIR, rollback_id, recovery)
        except (OSError, ValueError, KeyError, TypeError, EOFError) as error:
            reason = sanitize_tool_output(str(error)) or type(error).__name__
            if restoration_started:
                self.history.update_patch_status(rollback_id, "rollback_failed", reason)
            self.history.log_policy_event(session_id, "rollback_failed", {"rollback_id": rollback_id, "reason": reason})
            self.console.print(f"[red]Rollback failed:[/red] {reason}")
            return False

        self.history.update_patch_status(rollback_id, "rolled_back")
        self.history.log_policy_event(session_id, "rollback", {"rollback_id": rollback_id})
        self.console.print(f"[green]Rollback complete.[/green] rollback_id={rollback_id}")
        return True

    def _validate_recovery(self, record: dict, recovery: dict, *, only: str | None = None) -> None:
        repo_root = _find_repo_root(Path.cwd())
        files = recovery.get("files")
        if (
            recovery.get("workspace") != str(repo_root)
            or recovery.get("root_identity") != list(path_identity(repo_root))
            or recovery.get("git_identity") != list(path_identity(repo_root / ".git"))
            or recovery.get("patch_sha256") != record.get("patch_sha256")
            or files != record.get("files")
            or recovery.get("status") not in {"applied", "failed", "rolling_back"}
            or not isinstance(files, list) or not files or len(files) > 1000
            or set(recovery.get("before", {})) != set(files)
            or set(recovery.get("after", {})) != set(files)
        ):
            raise PermissionError("Rollback recovery metadata does not match the operation/workspace.")
        # Run the same target and secret/link policy as patch application.
        selected = [only] if only is not None else files
        headers = "\n".join(
            f"diff --git {json.dumps('a/' + rel)} {json.dumps('b/' + rel)}"
            for rel in selected
        )
        _require_allowed_patch(headers, repo_root)
        backup_directory = Path(Config.PATCH_BACKUP_DIR).absolute() / recovery["rollback_id"]
        for rel in selected:
            before = recovery["before"][rel]
            after = recovery["after"][rel]
            expected = before if rel in recovery.get("restored", []) else after
            current = _file_state(repo_root / rel)
            if current != expected:
                # A previously interrupted restore may have completed its copy
                # before recording it. Matching original bytes need no write.
                if recovery["status"] != "rolling_back" or current != before:
                    raise PermissionError("Rollback conflict: workspace file changed after the operation.")
            if before is not None:
                source = backup_directory / "files" / rel
                if (recovery.get("backups", {}).get(rel) != str(source)
                        or has_link_or_reparse_component(backup_directory, source)
                        or _file_state(source) != before):
                    raise PermissionError("Rollback backup is missing, changed, or unsafe.")
