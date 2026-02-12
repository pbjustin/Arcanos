"""
Confirmation and governance gate handling for backend-required actions.
"""

from __future__ import annotations

import sys
from typing import Mapping, Optional, TYPE_CHECKING

from ..backend_client import BackendRequestError
from ..config import Config
from ..error_handler import logger as error_logger
from .context import ConversationResult

if TYPE_CHECKING:
    from .cli import ArcanosCLI


def handle_confirmation_required(
    cli: "ArcanosCLI",
    error: BackendRequestError,
    from_debug: bool = False,
) -> Optional[ConversationResult]:
    """
    Purpose: Prompt the user (or auto-reject) for sensitive backend actions.
    Inputs/Outputs: confirmation-bearing BackendRequestError and debug flag; returns ConversationResult or None.
    Edge cases: Rejects when payload is malformed or stdin is non-interactive.
    """
    confirmation_id = error.confirmation_challenge_id
    pending_actions = error.pending_actions

    if not confirmation_id or not isinstance(pending_actions, list):
        # //audit assumption: confirmation payload must include id + action list; risk: invalid approval flow; invariant: abort malformed payloads; strategy: warn and return None.
        error_logger.warning("Invalid confirmation payload received from backend.")
        return None

    if from_debug:
        # //audit assumption: debug transport should never auto-confirm privileged operations; risk: unintended execution from tooling; invariant: reject debug confirmations; strategy: explicit denial.
        error_logger.info("[DEBUG] Confirmation auto-rejected because request is from debug server.")
        return None

    if Config.CONFIRM_SENSITIVE_ACTIONS:
        # //audit assumption: confirmation prompt requires TTY interaction; risk: blocked/non-deterministic input in non-tty contexts; invariant: deny when no TTY; strategy: fail closed.
        if not sys.stdin.isatty():
            cli.console.print("[red]Action rejected.[/red]")
            return None

        cli.console.print("[yellow]ARCANOS: The following action needs your confirmation:[/yellow]")
        for action in pending_actions:
            summary = None
            if isinstance(action, Mapping):
                # //audit assumption: backend action entries are mappings with optional summary; risk: missing summary field; invariant: printable fallback; strategy: extract safely.
                summary = action.get("summary")
            if not isinstance(summary, str) or not summary:
                summary = str(action)
            cli.console.print(f"  [dim]{summary}[/dim]")

        response = cli.console.input("Confirm? [y/N]: ").strip().lower()
        if response not in ("y", "yes"):
            # //audit assumption: non-affirmative responses are denials; risk: ambiguous approvals; invariant: deny by default; strategy: allowlist yes-values.
            cli.console.print("[red]Action rejected.[/red]")
            return None

    from .backend_ops import confirm_pending_actions

    return confirm_pending_actions(cli, confirmation_id)


__all__ = ["handle_confirmation_required"]
