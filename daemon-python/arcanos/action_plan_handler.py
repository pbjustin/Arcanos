"""
ActionPlan handler for ARCANOS CLI daemon.

Handles action_plan commands from the backend:
- Rejects blocked plans
- Displays CLEAR summary for confirmation
- Executes approved plans
"""

from __future__ import annotations

import uuid
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Callable, Optional, TYPE_CHECKING

from .action_plan_lifecycle import (
    ACTION_PLAN_STATUSES,
    ActionPlanLifecycleResult,
    evaluate_action_plan_lifecycle,
)
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
    except Exception:
        error_logger.error("[ACTION_PLAN] Failed to parse plan")
        console.print("[red]Failed to parse ActionPlan[/red]")
        return

    # Missing or invalid CLEAR evidence is not an implicit allow or block.
    if plan.clear_decision is None:
        error_logger.error(
            "[ACTION_PLAN] CLEAR decision unavailable; execution suppressed"
        )
        console.print("[red]ActionPlan has no authoritative CLEAR decision[/red]")
        return

    operation = "block" if plan.clear_decision == "block" else "execute"
    lifecycle_result = evaluate_action_plan_lifecycle(
        operation=operation,
        status_present=plan.status_present,
        status=plan.status,
        policy_kind=plan.clear_decision,
        policy_provenance="daemon_wire",
        expiry=_classify_expiry(plan.expires_at),
    )

    if not _is_valid_plan_id(plan.plan_id):
        _report_lifecycle_denial(
            ActionPlanLifecycleResult(
                classification="unavailable",
                reason_code="identity_missing",
                operation_allowed=False,
                policy_recheck_allowed=False,
                status_transition_allowed=False,
                target_status=None,
            ),
            plan,
            operation,
            console,
            instance_id,
        )
        return

    if not lifecycle_result.operation_allowed:
        _report_lifecycle_denial(
            lifecycle_result,
            plan,
            operation,
            console,
            instance_id,
        )
        return

    _log_lifecycle_decision(
        lifecycle_result,
        plan,
        operation,
        instance_id,
        denied=False,
    )

    if lifecycle_result.classification == "policy_blocked":
        if not lifecycle_result.status_transition_allowed:
            console.print("[red]ActionPlan is already blocked[/red]")
            return
        _reject_plan(plan, console, backend_client, instance_id)
        return

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
    _execute_plan(plan, console, backend_client, instance_id, run_handler, confirm_prompt)


def _classify_expiry(expires_at: Any) -> str:
    """Normalize the wire expiry value for deterministic lifecycle evaluation."""
    if expires_at is None:
        return "active"
    if not isinstance(expires_at, str) or not expires_at:
        return "invalid"

    normalized = (
        f"{expires_at[:-1]}+00:00" if expires_at.endswith("Z") else expires_at
    )
    try:
        expires = datetime.fromisoformat(normalized)
    except (TypeError, ValueError):
        return "invalid"
    if expires.tzinfo is None:
        return "invalid"

    return "elapsed" if expires <= datetime.now(timezone.utc) else "active"


def _is_valid_plan_id(plan_id: Any) -> bool:
    """Accept the backend's opaque identifier without URI-path metacharacters."""
    return bool(
        isinstance(plan_id, str)
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", plan_id)
    )


def _safe_exception_class(error: BaseException) -> str:
    if isinstance(error, TimeoutError):
        return "TimeoutError"
    if isinstance(error, ValueError):
        return "ValueError"
    if isinstance(error, TypeError):
        return "TypeError"
    return "Exception"


def _log_lifecycle_decision(
    result: ActionPlanLifecycleResult,
    plan: ActionPlan,
    operation: str,
    instance_id: str,
    *,
    denied: bool,
) -> None:
    """Emit allowlisted lifecycle facts without raw wire values or payloads."""
    plan_id = plan.plan_id if _is_valid_plan_id(plan.plan_id) else "unavailable"
    previous_state = (
        plan.status
        if isinstance(plan.status, str) and plan.status in ACTION_PLAN_STATUSES
        else "unavailable"
    )
    actor_category = "daemon" if instance_id else "daemon-unidentified"
    try:
        log_method = error_logger.error if denied else error_logger.info
        log_method(
            "[ACTION_PLAN] Lifecycle decision "
            "plan_id=%s previous_state=%s operation=%s target_state=%s "
            "outcome=%s reason=%s policy_provenance=daemon_wire "
            "actor_category=%s version_support=unavailable trace_support=unavailable",
            plan_id,
            previous_state,
            operation,
            result.target_status or "none",
            result.classification,
            result.reason_code,
            actor_category,
        )
    except Exception:
        pass


def _report_lifecycle_denial(
    result: ActionPlanLifecycleResult,
    plan: ActionPlan,
    operation: str,
    console: "Console",
    instance_id: str,
) -> None:
    """Report a stable lifecycle denial without including untrusted wire values."""
    public_category = {
        "confirmation_required": "ACTION_PLAN_CONFIRMATION_REQUIRED",
        "forbidden": "ACTION_PLAN_TRANSITION_FORBIDDEN",
        "invalid": "ACTION_PLAN_STATE_INVALID",
        "policy_blocked": "ACTION_PLAN_POLICY_BLOCKED",
        "recheck_required": "ACTION_PLAN_STATE_UNAVAILABLE",
        "terminal": "ACTION_PLAN_TERMINAL",
        "unavailable": "ACTION_PLAN_STATE_UNAVAILABLE",
    }.get(result.classification, "ACTION_PLAN_STATE_INVALID")
    _log_lifecycle_decision(
        result,
        plan,
        operation,
        instance_id,
        denied=True,
    )
    console.print(f"[red]ActionPlan operation refused ({public_category})[/red]")


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
        if plan.clear_score.overall is None:
            console.print("  Overall: unavailable → BLOCK")
        else:
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
            try:
                error_logger.error(
                    "[ACTION_PLAN] Block notification failed "
                    "error_code=ACTION_PLAN_BLOCK_CALLBACK_FAILED error_class=%s",
                    _safe_exception_class(exc),
                )
            except Exception:
                pass


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
    overall = "unavailable" if score.overall is None else f"{score.overall:.3f}"
    table.add_row(
        "[bold]Overall[/bold]",
        f"[bold {decision_color}]{overall} → {decision}[/bold {decision_color}]",
    )

    console.print(table)


def _execute_plan(
    plan: ActionPlan,
    console: "Console",
    backend_client: Optional["BackendApiClient"],
    instance_id: str,
    run_handler: Callable[[str], None],
    confirm_prompt: Callable[[str], bool],
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
                    cwd = os.path.realpath(os.getcwd())
                    normalized_command = command.strip()
                    proposal_id = _hash_action_proposal(plan.plan_id, action.action_id, normalized_command, cwd)
                    approved = confirm_prompt(
                        "Run terminal command? "
                        f"proposal_id={proposal_id} "
                        f"command_sha256={hashlib.sha256(normalized_command.encode('utf-8')).hexdigest()} "
                        f"cwd={cwd}"
                    )
                    if not approved:
                        result_status = "failure"
                        result_error = {"reason": "terminal.run confirmation denied", "proposal_id": proposal_id}
                        console.print("    [yellow]terminal.run rejected by user[/yellow]")
                    else:
                        run_handler(normalized_command)
                        result_output = {"command_sha256": hashlib.sha256(normalized_command.encode("utf-8")).hexdigest(), "proposal_id": proposal_id}
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


def _hash_action_proposal(plan_id: str, action_id: str, command: str, cwd: str) -> str:
    payload = json.dumps(
        {"plan_id": plan_id, "action_id": action_id, "command": command, "cwd": cwd},
        separators=(",", ":"),
        sort_keys=True,
    )
    return f"action-{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]}"
