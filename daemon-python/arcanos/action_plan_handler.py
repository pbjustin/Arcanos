"""
ActionPlan handler for ARCANOS CLI daemon.

Handles action_plan commands from the backend:
- Rejects blocked plans
- Displays CLEAR summary for confirmation
- Executes approved plans
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional, TYPE_CHECKING

from .action_plan_types import ActionPlan, ExecutionResult
from .error_handler import logger as error_logger

if TYPE_CHECKING:
    from rich.console import Console
    from .backend_client import BackendApiClient


def handle_action_plan(
    plan_data: dict[str, Any],
    console: "Console",
    backend_client: Optional["BackendApiClient"],
    instance_id: str,
    run_handler: Callable[[str], None],
    confirm_prompt: Callable[[str], bool],
) -> None:
    """
    Purpose: Process an ActionPlan received from the backend.
    Inputs: plan data dict, Rich console, backend client, instance ID, run handler, confirm callback.
    Edge cases: Rejects blocked plans, requires confirmation for mid-range CLEAR.
    """
    try:
        plan = ActionPlan.from_dict(plan_data)
    except Exception as exc:
        error_logger.error("[ACTION_PLAN] Failed to parse plan: %s", exc)
        console.print("[red]Failed to parse ActionPlan[/red]")
        return

    # Guard: blocked plans never execute
    if plan.clear_decision == "block":
        _reject_plan(plan, console, backend_client, instance_id)
        return

    # Guard: expired plans
    if plan.expires_at:
        try:
            expires = datetime.fromisoformat(plan.expires_at.replace("Z", "+00:00"))
            if expires < datetime.now(timezone.utc):
                console.print(f"[yellow]ActionPlan {plan.plan_id} has expired[/yellow]")
                return
        except ValueError:
            pass

    # Show CLEAR summary
    if plan.clear_score:
        _show_clear_summary(plan, console)

    # Require confirmation for mid-range CLEAR or explicit flag
    if plan.requires_confirmation or plan.clear_decision == "confirm":
        approved = confirm_prompt(
            f"Execute ActionPlan {plan.plan_id}? ({len(plan.actions)} action(s))"
        )
        if not approved:
            console.print(f"[yellow]ActionPlan {plan.plan_id} rejected by user[/yellow]")
            return

    # Execute plan
    _execute_plan(plan, console, backend_client, instance_id, run_handler)


def _reject_plan(
    plan: ActionPlan,
    console: "Console",
    backend_client: Optional["BackendApiClient"],
    instance_id: str,
) -> None:
    """Reject a blocked plan and notify backend."""
    console.print(
        f"[red]ActionPlan {plan.plan_id} BLOCKED by CLEAR 2.0[/red]"
    )
    if plan.clear_score:
        console.print(f"  Overall: {plan.clear_score.overall:.3f} → BLOCK")
        if plan.clear_score.notes:
            console.print(f"  Notes: {plan.clear_score.notes}")

    # Submit rejection result to backend
    if backend_client:
        try:
            result = ExecutionResult(
                execution_id=str(uuid.uuid4()),
                plan_id=plan.plan_id,
                action_id="*",
                agent_id=instance_id,
                status="rejected",
                error={"reason": "CLEAR 2.0 blocked"},
                timestamp=datetime.now(timezone.utc).isoformat(),
            )
            backend_client._request_json(
                "POST",
                f"/plans/{plan.plan_id}/block",
                {},
            )
        except Exception as exc:
            error_logger.error("[ACTION_PLAN] Failed to notify backend of rejection: %s", exc)


def _show_clear_summary(plan: ActionPlan, console: "Console") -> None:
    """Display CLEAR 2.0 score summary using Rich."""
    from rich.table import Table

    score = plan.clear_score
    if not score:
        return

    table = Table(title=f"CLEAR 2.0 — Plan {plan.plan_id[:8]}...", show_header=True)
    table.add_column("Dimension", style="cyan")
    table.add_column("Score", justify="right")

    dimensions = [
        ("C – Clarity", score.clarity),
        ("L – Leverage", score.leverage),
        ("E – Efficiency", score.efficiency),
        ("A – Alignment", score.alignment),
        ("R – Resilience", score.resilience),
    ]

    for name, value in dimensions:
        color = "green" if value >= 0.7 else "yellow" if value >= 0.4 else "red"
        table.add_row(name, f"[{color}]{value:.2f}[/{color}]")

    # Overall + decision
    decision = score.decision.upper()
    decision_color = "green" if decision == "ALLOW" else "yellow" if decision == "CONFIRM" else "red"
    table.add_row(
        "[bold]Overall[/bold]",
        f"[bold {decision_color}]{score.overall:.3f} → {decision}[/bold {decision_color}]",
    )

    console.print(table)


def _execute_plan(
    plan: ActionPlan,
    console: "Console",
    backend_client: Optional["BackendApiClient"],
    instance_id: str,
    run_handler: Callable[[str], None],
) -> None:
    """Execute each action in the plan sequentially."""
    console.print(
        f"[green]Executing ActionPlan {plan.plan_id} ({len(plan.actions)} actions)[/green]"
    )

    for action in plan.actions:
        console.print(
            f"  → Action {action.action_id[:8]}... "
            f"[dim]({action.capability})[/dim]"
        )

        result_status = "success"
        result_output: Any = None
        result_error: Any = None

        try:
            if action.capability == "terminal.run":
                command = action.params.get("command", "")
                if isinstance(command, str) and command.strip():
                    run_handler(command.strip())
                    result_output = {"command": command}
                else:
                    result_status = "failure"
                    result_error = {"reason": "Missing or empty command param"}
            else:
                console.print(
                    f"    [yellow]Unsupported capability: {action.capability}[/yellow]"
                )
                result_status = "failure"
                result_error = {"reason": f"Unsupported capability: {action.capability}"}
        except Exception as exc:
            result_status = "failure"
            result_error = {"reason": str(exc)}
            error_logger.error("[ACTION_PLAN] Action %s failed: %s", action.action_id, exc)

        # Submit execution result
        if backend_client:
            try:
                result = ExecutionResult(
                    execution_id=str(uuid.uuid4()),
                    plan_id=plan.plan_id,
                    action_id=action.action_id,
                    agent_id=instance_id,
                    status=result_status,
                    output=result_output,
                    error=result_error,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                )
                backend_client._request_json(
                    "POST",
                    f"/plans/{plan.plan_id}/execute",
                    result.to_dict(),
                )
            except Exception as exc:
                error_logger.error(
                    "[ACTION_PLAN] Failed to submit result for action %s: %s",
                    action.action_id, exc,
                )

        status_color = "green" if result_status == "success" else "red"
        console.print(f"    [{status_color}]{result_status}[/{status_color}]")

    console.print(f"[green]ActionPlan {plan.plan_id} completed[/green]")
