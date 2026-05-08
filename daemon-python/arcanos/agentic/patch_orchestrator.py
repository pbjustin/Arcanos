
from __future__ import annotations

import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from rich.console import Console
from rich.syntax import Syntax

from ..config import Config
from ..cli.cli_policy import validate_patch_text
from .history_db import HistoryDB
from .policy_guard import PolicyGuard


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


class PatchOrchestrator:
    def __init__(self, console: Console, history: HistoryDB, guard: PolicyGuard) -> None:
        self.console = console
        self.history = history
        self.guard = guard

    def apply_with_approval(self, session_id: str, patch_text: str, summary: str = "") -> ApplyResult:
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

        backup_root = Config.PATCH_BACKUP_DIR / rollback_id
        backup_root.mkdir(parents=True, exist_ok=True)

        backups: dict[str, str] = {}
        for f in files:
            src = repo_root / f
            if src.exists() and src.is_file():
                dst = backup_root / f
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                backups[f] = str(dst)

        proc = subprocess.run(
            ["git", "apply", "--whitespace=nowarn", "-"],
            input=patch_text,
            text=True,
            capture_output=True,
            cwd=str(repo_root),
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip() or f"git apply failed rc={proc.returncode}"
            self.history.log_patch(
                session_id,
                rollback_id,
                "failed",
                summary or "apply failed",
                files,
                backups,
                patch_text,
                patch_sha256=patch_decision.patch_hash,
                error=err,
            )
            self.guard.record_failure(session_id, "patch", {"error": err, "rollback_id": rollback_id})
            return ApplyResult(ok=False, rollback_id=rollback_id, files=files, backups=backups, error=err)

        self.history.log_patch(
            session_id,
            rollback_id,
            "applied",
            summary or "applied",
            files,
            backups,
            patch_text,
            patch_sha256=patch_decision.patch_hash,
        )
        self.guard.record_success()
        self.console.print(f"[green]Patch applied.[/green] rollback_id={rollback_id}")
        return ApplyResult(ok=True, rollback_id=rollback_id, files=files, backups=backups)

    def rollback(self, session_id: str, rollback_id: str) -> bool:
        record = self.history.get_patch(rollback_id)
        if not record:
            self.console.print("[red]No such rollback_id.[/red]")
            return False
        backups = record.get("backups", {})
        if not backups:
            self.console.print("[yellow]No backups recorded for this rollback id.[/yellow]")
            return False

        repo_root = _find_repo_root(Path.cwd())
        for rel, backup_path in backups.items():
            src = Path(backup_path)
            dst = repo_root / rel
            if src.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)

        self.history.log_policy_event(session_id, "rollback", {"rollback_id": rollback_id})
        self.console.print(f"[green]Rollback complete.[/green] rollback_id={rollback_id}")
        return True
