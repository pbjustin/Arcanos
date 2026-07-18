"""
Terminal command execution operations for the CLI.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, TYPE_CHECKING

from .audit import record as audit_record
from .execute import execute as governed_execute
from .governance import GovernanceError
from .idempotency import command_fingerprint

from ..config import Config
from . import state

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def handle_run(
    cli: "ArcanosCLI",
    command: str,
    return_result: bool = False,
    *,
    activity_detail: Optional[str] = None,
    audit_payload: Optional[Mapping[str, Any]] = None,
    timeout_seconds: Optional[int] = None,
) -> Optional[dict]:
    """
    Purpose: Execute a terminal command through governance and idempotency guards.
    Inputs/Outputs: command string and return_result flag; prints output or returns structured result.
    Edge cases: Rejects empty commands and duplicate fingerprints.
    """
    cli._append_activity("run", activity_detail if activity_detail is not None else command)
    if not command:
        if not return_result:
            cli.console.print("[red]⚠️  No command specified[/red]")
        return {"ok": False, "error": "No command specified"} if return_result else None

    fp = command_fingerprint("run", {"command": command})
    audit_record("retry_check", command="run", fingerprint=fp)
    if not cli._idempotency_guard.check_and_record(fp):
        # //audit assumption: duplicate command fingerprints represent retries; risk: repeated side effects; invariant: duplicates rejected inside dedup window; strategy: deny execution.
        audit_record("retry_duplicate_rejected", command="run", fingerprint=fp)
        cli.console.print("[yellow]Duplicate command rejected (idempotency).[/yellow]")
        return {"ok": False, "error": "Duplicate command rejected"} if return_result else None

    state.recompute_trust_state(cli)

    try:
        def _do_run():
            if not return_result:
                cli.console.print(f"[cyan]▶️  Running:[/cyan] {command}")

            execute_kwargs: dict[str, Any] = {"elevated": Config.RUN_ELEVATED}
            if timeout_seconds is not None:
                execute_kwargs["timeout"] = timeout_seconds
            stdout, stderr, return_code = cli.terminal.execute(
                command,
                **execute_kwargs,
            )
            cli.memory.increment_stat("terminal_commands")
            return stdout, stderr, return_code

        stdout, stderr, return_code = governed_execute(
            "run",
            _do_run,
            trust_state=cli._trust_state,
            requires_confirmation=True,
            payload=dict(audit_payload) if audit_payload is not None else {"command": command},
        )
    except GovernanceError as exc:
        # //audit assumption: governance denials must be explicit; risk: silent policy failures; invariant: denial is audited and surfaced; strategy: audit+print.
        audit_record("governance_denial", command="run", reason=str(exc), trust=cli._trust_state.name)
        cli.console.print(f"[red]{exc}[/red]")
        return {"ok": False, "error": str(exc)} if return_result else None

    if return_result:
        return {
            "ok": True,
            "stdout": stdout,
            "stderr": stderr,
            "return_code": return_code,
        }

    if stdout:
        cli.console.print(f"\n[green]{stdout}[/green]\n")
    if stderr:
        cli.console.print(f"\n[red]{stderr}[/red]\n")

    if return_code == 0:
        cli.console.print(f"[dim]? Exit code: {return_code}[/dim]")
    else:
        cli.console.print(f"[dim red]? Exit code: {return_code}[/dim red]")

    return None


def handle_action_plan_run(
    cli: "ArcanosCLI",
    command: str,
    *,
    execution_identity: str,
    timeout_seconds: Optional[int] = None,
) -> dict[str, Any]:
    """Run one assigned action while keeping commands and dependency errors out of diagnostics."""
    activity_detail = f"action-plan-execution:{execution_identity}"
    safe_payload = {
        "source": "action-plan-execution-v1",
        "run_id": execution_identity,
    }
    cli._append_activity("run", activity_detail)
    fingerprint = command_fingerprint(
        "action-plan-execution",
        {"run_id": execution_identity},
    )
    audit_record(
        "retry_check",
        command="action-plan-execution",
        fingerprint=fingerprint,
    )
    if not cli._idempotency_guard.check_and_record(fingerprint):
        audit_record(
            "retry_duplicate_rejected",
            command="action-plan-execution",
            fingerprint=fingerprint,
        )
        return {"ok": False, "return_code": None, "error_category": "duplicate"}

    state.recompute_trust_state(cli)
    try:
        stdout, stderr, return_code = governed_execute(
            "run",
            lambda: cli.terminal.execute_action_plan_command(
                command,
                timeout=timeout_seconds or 30,
                elevated=Config.RUN_ELEVATED,
            ),
            trust_state=cli._trust_state,
            requires_confirmation=True,
            payload=safe_payload,
        )
        del stdout, stderr
        return {"ok": return_code == 0, "return_code": return_code}
    except GovernanceError:
        category = "governance"
    except TimeoutError:
        category = "timeout"
    except PermissionError:
        category = "permission"
    except (TypeError, ValueError):
        category = "validation"
    except Exception:
        category = "execution"
    audit_record(
        "action_plan_execution_failed",
        command="action-plan-execution",
        run_id=execution_identity,
        error_category=category,
    )
    return {"ok": False, "return_code": None, "error_category": category}


__all__ = ["handle_action_plan_run", "handle_run"]
