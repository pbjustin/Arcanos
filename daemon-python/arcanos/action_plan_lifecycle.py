"""Pure ActionPlan lifecycle and CLEAR consistency evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

ACTION_PLAN_STATUSES = frozenset(
    {
        "planned",
        "awaiting_confirmation",
        "approved",
        "in_progress",
        "completed",
        "failed",
        "expired",
        "blocked",
    }
)

_OPERATIONS = frozenset({"approve", "block", "execute", "expire", "read"})
_POLICY_KINDS = frozenset({"allow", "confirm", "block", "not_evaluated"})
_POLICY_PROVENANCES = frozenset(
    {"stored_creation", "current_recheck", "daemon_wire", "operator"}
)
_EXPIRY_STATES = frozenset({"active", "elapsed", "invalid"})
_HARD_TERMINAL_STATUSES = frozenset({"completed", "failed"})
_BLOCKABLE_STATUSES = frozenset(
    {"planned", "awaiting_confirmation", "approved", "in_progress"}
)
_EXPIRABLE_STATUSES = frozenset({"planned", "awaiting_confirmation", "approved"})


@dataclass(frozen=True)
class ActionPlanLifecycleResult:
    """Dependency-free lifecycle evaluation result."""

    classification: str
    reason_code: str
    operation_allowed: bool
    policy_recheck_allowed: bool
    status_transition_allowed: bool
    target_status: Optional[str]


def _result(
    classification: str,
    reason_code: str,
    *,
    operation_allowed: bool = False,
    policy_recheck_allowed: bool = False,
    status_transition_allowed: bool = False,
    target_status: Optional[str] = None,
) -> ActionPlanLifecycleResult:
    return ActionPlanLifecycleResult(
        classification=classification,
        reason_code=reason_code,
        operation_allowed=operation_allowed,
        policy_recheck_allowed=policy_recheck_allowed,
        status_transition_allowed=status_transition_allowed,
        target_status=target_status,
    )


def evaluate_action_plan_lifecycle(
    *,
    operation: Any,
    status_present: bool,
    status: Any,
    policy_kind: Any,
    policy_provenance: Any,
    expiry: Any,
) -> ActionPlanLifecycleResult:
    """Evaluate lifecycle facts without I/O, logging, or mutation."""
    if not status_present:
        return _result("unavailable", "state_missing")
    if not isinstance(status, str):
        return _result("invalid", "state_invalid")
    if status not in ACTION_PLAN_STATUSES:
        return _result("invalid", "state_unknown")
    if not isinstance(operation, str) or operation not in _OPERATIONS:
        return _result("invalid", "operation_unknown")

    if operation == "read":
        return _result(
            "allowed",
            "read_allowed",
            operation_allowed=True,
        )

    if not isinstance(policy_kind, str) or policy_kind not in _POLICY_KINDS:
        return _result("invalid", "policy_invalid")
    if (
        not isinstance(policy_provenance, str)
        or policy_provenance not in _POLICY_PROVENANCES
    ):
        return _result("invalid", "policy_invalid")
    if not isinstance(expiry, str) or expiry not in _EXPIRY_STATES:
        return _result("invalid", "expiry_invalid")

    if status == "expired":
        if operation == "expire":
            if policy_kind != "not_evaluated" or policy_provenance != "operator":
                return _result("invalid", "policy_operation_conflict")
            return _result(
                "allowed",
                "already_expired",
                operation_allowed=True,
                target_status="expired",
            )
        return _result("terminal", "terminal_state")

    if status == "blocked":
        if (
            operation == "block"
            and policy_kind == "block"
            and policy_provenance
            in {
                "stored_creation",
                "current_recheck",
                "daemon_wire",
            }
        ):
            return _result(
                "policy_blocked",
                "already_blocked",
                operation_allowed=True,
                target_status="blocked",
            )
        if (
            operation == "block"
            and policy_kind == "not_evaluated"
            and policy_provenance == "operator"
        ):
            return _result(
                "allowed",
                "already_blocked",
                operation_allowed=True,
                target_status="blocked",
            )
        if (
            operation == "execute"
            and policy_kind in {"allow", "confirm"}
            and policy_provenance in {"current_recheck", "daemon_wire"}
        ):
            return _result("invalid", "blocked_current_policy_conflict")
        if operation == "block":
            return _result("invalid", "policy_operation_conflict")
        return _result(
            "forbidden",
            "lifecycle_blocked"
            if operation == "execute"
            else "blocked_transition_forbidden",
        )

    if status in _HARD_TERMINAL_STATUSES:
        return _result("terminal", "terminal_state")

    if expiry == "invalid":
        return _result("invalid", "expiry_invalid")
    if expiry == "elapsed" and operation in {"approve", "execute"}:
        return _result("terminal", "expiry_elapsed")

    if operation == "approve":
        if policy_provenance != "stored_creation":
            return _result("invalid", "policy_provenance_invalid")
        if policy_kind == "block":
            return _result("policy_blocked", "creation_policy_block")
        if status in {"planned", "awaiting_confirmation"}:
            return _result(
                "allowed",
                "approval_allowed",
                operation_allowed=True,
                status_transition_allowed=True,
                target_status="approved",
            )
        return _result("forbidden", "approval_forbidden")

    if operation == "block":
        if status not in _BLOCKABLE_STATUSES:
            return _result("forbidden", "block_forbidden")
        if policy_kind == "not_evaluated" and policy_provenance == "operator":
            return _result(
                "allowed",
                "operator_block_allowed",
                operation_allowed=True,
                status_transition_allowed=True,
                target_status="blocked",
            )
        if policy_kind == "block" and policy_provenance in {
            "current_recheck",
            "daemon_wire",
        }:
            return _result(
                "policy_blocked",
                "current_policy_block",
                operation_allowed=True,
                status_transition_allowed=True,
                target_status="blocked",
            )
        return _result("invalid", "policy_operation_conflict")

    if operation == "expire":
        if policy_kind != "not_evaluated" or policy_provenance != "operator":
            return _result("invalid", "policy_invalid")
        if status in _EXPIRABLE_STATUSES:
            return _result(
                "allowed",
                "expiry_allowed",
                operation_allowed=True,
                status_transition_allowed=True,
                target_status="expired",
            )
        return _result("forbidden", "expiry_forbidden")

    if status == "planned":
        return _result("forbidden", "approval_required")
    if status == "awaiting_confirmation":
        return _result("confirmation_required", "durable_approval_required")
    if status == "in_progress":
        return _result("forbidden", "execution_in_progress")

    if status == "approved":
        if policy_provenance == "stored_creation":
            if policy_kind == "block":
                return _result("invalid", "stored_policy_conflict")
            return _result(
                "recheck_required",
                "fresh_recheck_required",
                policy_recheck_allowed=True,
            )
        if policy_kind in {"allow", "confirm"} and policy_provenance in {
            "current_recheck",
            "daemon_wire",
        }:
            return _result(
                "allowed",
                "execution_allowed",
                operation_allowed=True,
            )
        return _result("invalid", "policy_operation_conflict")

    return _result("invalid", "state_invalid")
