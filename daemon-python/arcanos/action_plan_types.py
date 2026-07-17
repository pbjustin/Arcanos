"""ActionPlan types for ARCANOS CLI daemon with CLEAR 2.0 governance."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from numbers import Real
from typing import Any, Mapping, Optional, Sequence


_CLEAR_DECISIONS = frozenset({"allow", "confirm", "block"})
CLEAR_CONFIRM_MINIMUM = 0.4
CLEAR_ALLOW_MINIMUM = 0.7
_MISSING = object()


@dataclass(frozen=True)
class ClearOutcome:
    """Pure interpretation of the authoritative CLEAR decision fields."""
    kind: str
    decision: Optional[str] = None
    overall: Optional[float] = None
    reason: Optional[str] = None


def interpret_clear_outcome(evaluation: Any) -> ClearOutcome:
    """Interpret CLEAR decision evidence without I/O, mutation, or coercion."""
    if evaluation is None:
        return ClearOutcome(kind="indeterminate", reason="missing_result")
    if not isinstance(evaluation, Mapping):
        return ClearOutcome(kind="invalid", reason="malformed_result")

    decision = evaluation.get("decision")
    if decision is None:
        return ClearOutcome(kind="indeterminate", reason="missing_decision")
    if not isinstance(decision, str) or decision not in _CLEAR_DECISIONS:
        return ClearOutcome(kind="invalid", reason="invalid_decision")

    overall = evaluation.get("overall")
    if overall is None:
        return ClearOutcome(kind=decision, decision=decision, overall=None)
    if isinstance(overall, bool) or not isinstance(overall, Real):
        return ClearOutcome(kind="invalid", reason="invalid_score")
    try:
        if not math.isfinite(overall) or overall < 0 or overall > 1:
            return ClearOutcome(kind="invalid", reason="invalid_score")
    except (OverflowError, TypeError, ValueError):
        return ClearOutcome(kind="invalid", reason="invalid_score")

    overall_value = float(overall)
    expected_decision = (
        "allow"
        if overall_value >= CLEAR_ALLOW_MINIMUM
        else "confirm"
        if overall_value >= CLEAR_CONFIRM_MINIMUM
        else "block"
    )
    if decision != expected_decision:
        return ClearOutcome(kind="invalid", reason="contradictory_result")

    return ClearOutcome(
        kind=decision,
        decision=decision,
        overall=overall_value,
    )


def _json_values_equal(left: Any, right: Any) -> bool:
    """Compare JSON-compatible values without conflating booleans and numbers."""
    if left is None or right is None:
        return left is right
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left is right
    if isinstance(left, Real) or isinstance(right, Real):
        return (
            isinstance(left, Real)
            and not isinstance(left, bool)
            and isinstance(right, Real)
            and not isinstance(right, bool)
            and left == right
        )
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    if isinstance(left, Mapping) or isinstance(right, Mapping):
        if not isinstance(left, Mapping) or not isinstance(right, Mapping):
            return False
        if any(not isinstance(key, str) for key in left):
            return False
        if any(not isinstance(key, str) for key in right):
            return False
        if set(left) != set(right):
            return False
        return all(_json_values_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(
                _json_values_equal(left_item, right_item)
                for left_item, right_item in zip(left, right)
            )
        )
    return False


@dataclass
class ClearScore:
    """CLEAR 2.0 score for an ActionPlan."""
    clarity: float
    leverage: float
    efficiency: float
    alignment: float
    resilience: float
    overall: Optional[float]
    decision: str  # allow | confirm | block
    notes: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ClearScore:
        outcome = interpret_clear_outcome(data)
        if outcome.decision is None:
            raise ValueError("CLEAR outcome is not authoritative")

        try:
            return cls(
                clarity=float(data.get("clarity", 0)),
                leverage=float(data.get("leverage", 0)),
                efficiency=float(data.get("efficiency", 0)),
                alignment=float(data.get("alignment", 0)),
                resilience=float(data.get("resilience", 0)),
                overall=outcome.overall,
                decision=outcome.decision,
                notes=data.get("notes"),
            )
        except (AttributeError, TypeError, ValueError):
            raise ValueError("CLEAR score metadata is malformed") from None


@dataclass
class ActionDef:
    """Atomic execution unit within an ActionPlan."""
    action_id: str
    agent_id: str
    capability: str
    params: Mapping[str, Any] = field(default_factory=dict)
    timeout_ms: int = 30000
    rollback_action: Optional[Mapping[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ActionDef:
        return cls(
            action_id=str(data.get("action_id", data.get("id", ""))),
            agent_id=str(data.get("agent_id", data.get("agentId", ""))),
            capability=str(data.get("capability", "")),
            params=data.get("params", {}),
            timeout_ms=int(data.get("timeout_ms", data.get("timeoutMs", 30000))),
            rollback_action=data.get("rollback_action", data.get("rollbackAction")),
        )


@dataclass
class ActionPlan:
    """Immutable, durable plan emitted by the backend."""
    plan_id: str
    created_by: str  # user | policy | system | recovery
    origin: str
    status: Any  # exact wire value; validated by the lifecycle evaluator
    confidence: float = 0.0
    requires_confirmation: bool = True
    idempotency_key: str = ""
    expires_at: Optional[str] = None
    actions: Sequence[ActionDef] = field(default_factory=list)
    clear_score: Optional[ClearScore] = None
    clear_decision: Optional[str] = None  # allow | confirm | block
    status_present: bool = True

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ActionPlan:
        plan_id_raw = data.get("plan_id", _MISSING)
        id_raw = data.get("id", _MISSING)
        if (
            plan_id_raw is not _MISSING
            and id_raw is not _MISSING
            and not _json_values_equal(plan_id_raw, id_raw)
        ):
            raise ValueError("Conflicting ActionPlan identifiers")
        selected_plan_id = plan_id_raw if plan_id_raw is not _MISSING else id_raw
        plan_id = selected_plan_id if isinstance(selected_plan_id, str) else ""

        requires_confirmation_raw = data.get("requires_confirmation", _MISSING)
        requires_confirmation_alias = data.get("requiresConfirmation", _MISSING)
        if (
            requires_confirmation_raw is not _MISSING
            and requires_confirmation_alias is not _MISSING
            and not _json_values_equal(
                requires_confirmation_raw,
                requires_confirmation_alias,
            )
        ):
            raise ValueError("Conflicting ActionPlan confirmation requirements")
        selected_confirmation = (
            requires_confirmation_raw
            if requires_confirmation_raw is not _MISSING
            else requires_confirmation_alias
        )
        if selected_confirmation is _MISSING:
            requires_confirmation = True
        elif isinstance(selected_confirmation, bool):
            requires_confirmation = selected_confirmation
        else:
            raise ValueError("ActionPlan confirmation requirement is malformed")

        status_present = "status" in data
        status = data.get("status") if status_present else None
        actions_raw = data.get("actions", [])
        actions = [ActionDef.from_dict(a) for a in actions_raw] if actions_raw else []

        metadata_raw = data.get("metadata", _MISSING)
        if metadata_raw is _MISSING:
            metadata: Mapping[str, Any] = {}
        elif not isinstance(metadata_raw, Mapping):
            raise ValueError("ActionPlan metadata is malformed")
        else:
            metadata = metadata_raw

        metadata_score_raw = metadata.get("clear_score", _MISSING)
        top_level_score_raw = data.get("clearScore", _MISSING)
        if (
            metadata_score_raw is not _MISSING
            and metadata_score_raw is not None
            and top_level_score_raw is not _MISSING
            and top_level_score_raw is not None
        ):
            if (
                not isinstance(metadata_score_raw, Mapping)
                or not isinstance(top_level_score_raw, Mapping)
                or not _json_values_equal(metadata_score_raw, top_level_score_raw)
            ):
                raise ValueError("Conflicting CLEAR score aliases")

        if metadata_score_raw is not _MISSING and metadata_score_raw is not None:
            clear_score_raw = metadata_score_raw
        elif top_level_score_raw is not _MISSING and top_level_score_raw is not None:
            clear_score_raw = top_level_score_raw
        else:
            clear_score_raw = _MISSING

        clear_score = (
            ClearScore.from_dict(clear_score_raw)
            if clear_score_raw is not _MISSING
            else None
        )

        clear_decision: Optional[str]
        metadata_decision_raw = metadata.get("clear_decision", _MISSING)
        if metadata_decision_raw is not _MISSING and metadata_decision_raw is not None:
            if (
                not isinstance(metadata_decision_raw, str)
                or metadata_decision_raw not in _CLEAR_DECISIONS
            ):
                raise ValueError("CLEAR metadata decision is invalid")
            if clear_score and metadata_decision_raw != clear_score.decision:
                raise ValueError("Conflicting CLEAR decisions")
            clear_decision = metadata_decision_raw
        else:
            clear_decision = clear_score.decision if clear_score else None

        return cls(
            plan_id=plan_id,
            created_by=str(data.get("created_by", data.get("createdBy", ""))),
            origin=str(data.get("origin", "")),
            status=status,
            status_present=status_present,
            confidence=float(data.get("confidence", 0)),
            requires_confirmation=requires_confirmation,
            idempotency_key=str(data.get("idempotency_key", data.get("idempotencyKey", ""))),
            expires_at=data.get("expires_at", data.get("expiresAt")),
            actions=actions,
            clear_score=clear_score,
            clear_decision=clear_decision,
        )


@dataclass
class ExecutionResult:
    """Signed, append-only result of executing an action."""
    execution_id: str
    plan_id: str
    action_id: str
    agent_id: str
    status: str  # success | failure | replayed | rejected
    output: Optional[Any] = None
    error: Optional[Any] = None
    signature: Optional[str] = None
    timestamp: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "execution_id": self.execution_id,
            "plan_id": self.plan_id,
            "action_id": self.action_id,
            "agent_id": self.agent_id,
            "status": self.status,
        }
        if self.output is not None:
            result["output"] = self.output
        if self.error is not None:
            result["error"] = self.error
        if self.signature:
            result["signature"] = self.signature
        if self.timestamp:
            result["timestamp"] = self.timestamp
        return result
