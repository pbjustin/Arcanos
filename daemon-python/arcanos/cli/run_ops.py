"""
Terminal command execution operations for the CLI.
"""

from __future__ import annotations

from typing import Optional, TYPE_CHECKING

from cli.audit import record as audit_record
from cli.execute import execute as governed_execute
from cli.governance import GovernanceError
from cli.idempotency import command_fingerprint

from ..config import Config
from . import state

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def handle_run(cli: "ArcanosCLI", command: str, return_result: bool = False) -> Optional[dict]:
    """
    Purpose: Execute a terminal command through governance and idempotency guards.
    Inputs/Outputs: command string and return_result flag; prints output or returns structured result.
    Edge cases: Rejects empty commands and duplicate fingerprints.
    """
    cli._append_activity("run", command)
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

            stdout, stderr, return_code = cli.terminal.execute(command, elevated=Config.RUN_ELEVATED)
            cli.memory.increment_stat("terminal_commands")
            return stdout, stderr, return_code

        stdout, stderr, return_code = governed_execute(
            "run",
            _do_run,
            trust_state=cli._trust_state,
            requires_confirmation=True,
            payload={"command": command},
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


__all__ = ["handle_run"]
