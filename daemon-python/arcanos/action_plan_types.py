"""ActionPlan types for ARCANOS CLI daemon with CLEAR 2.0 governance."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence


@dataclass
class ClearScore:
    """CLEAR 2.0 score for an ActionPlan."""
    clarity: float
    leverage: float
    efficiency: float
    alignment: float
    resilience: float
    overall: float
    decision: str  # allow | confirm | block
    notes: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ClearScore:
        return cls(
            clarity=float(data.get("clarity", 0)),
            leverage=float(data.get("leverage", 0)),
            efficiency=float(data.get("efficiency", 0)),
            alignment=float(data.get("alignment", 0)),
            resilience=float(data.get("resilience", 0)),
            overall=float(data.get("overall", 0)),
            decision=str(data.get("decision", "block")),
            notes=data.get("notes"),
        )


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
    status: str  # planned | awaiting_confirmation | approved | in_progress | completed | failed | expired | blocked
    confidence: float = 0.0
    requires_confirmation: bool = True
    idempotency_key: str = ""
    expires_at: Optional[str] = None
    actions: Sequence[ActionDef] = field(default_factory=list)
    clear_score: Optional[ClearScore] = None
    clear_decision: Optional[str] = None  # allow | confirm | block

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ActionPlan:
        actions_raw = data.get("actions", [])
        actions = [ActionDef.from_dict(a) for a in actions_raw] if actions_raw else []

        metadata = data.get("metadata", {})
        clear_score_raw = metadata.get("clear_score") or data.get("clearScore")
        clear_score = ClearScore.from_dict(clear_score_raw) if clear_score_raw else None
        clear_decision = metadata.get("clear_decision") or (clear_score.decision if clear_score else None)

        return cls(
            plan_id=str(data.get("plan_id", data.get("id", ""))),
            created_by=str(data.get("created_by", data.get("createdBy", ""))),
            origin=str(data.get("origin", "")),
            status=str(data.get("status", "planned")),
            confidence=float(data.get("confidence", 0)),
            requires_confirmation=bool(data.get("requires_confirmation", data.get("requiresConfirmation", True))),
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
