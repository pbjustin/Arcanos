import os
from typing import Any, Callable, Dict, Optional

from memory import Memory  # custom memory interface


class ArcanosEnforcer:
    """Central enforcement and auditing layer for Arcanos workers."""

    def __init__(self, memory: Optional[Memory] = None, *, logic_version: Optional[str] = None) -> None:
        """Initialize the enforcer with a memory backend and logic version.

        Args:
            memory: Optional custom memory interface. Defaults to ``Memory()``.
            logic_version: Override for the logic version. Defaults to the
                ``ARCANOS_LOGIC_VERSION`` environment variable or ``"v1.2.3"``.
        """
        self.memory = memory or Memory()
        self.logic_version = logic_version or os.getenv("ARCANOS_LOGIC_VERSION", "v1.2.3")

    def audit_worker(self, worker_id: str) -> Dict[str, Any]:
        """Return audit information for a worker."""
        state = self.memory.get(f"worker_state_{worker_id}") or {}
        logic_version = state.get("logic_version")
        return {
            "worker_id": worker_id,
            "status": state.get("status", "unknown"),
            "last_action": state.get("last_action"),
            "compliant": logic_version == self.logic_version,
            "logic_version": logic_version,
        }

    def enforce_action(self, agent_name: str, action_payload: Dict[str, Any]) -> Dict[str, Any]:
        """Persist a dispatch action for an agent.

        Only ``dispatch`` action types are supported.
        """
        if action_payload.get("type") != "dispatch":
            return {"enforced": False, "reason": "Unsupported action type"}

        result = self.memory.set(
            f"worker_state_{agent_name}",
            {
                "status": "processed",
                "last_action": action_payload.get("task"),
                "logic_version": self.logic_version,
            },
        )
        return {"enforced": True, "details": result}

    def hook_into_agent(self, agent_callable: Callable[..., Any]) -> Callable[..., Dict[str, Any]]:
        """Wrap an agent callable to capture pre and post execution audit data."""

        def wrapped(*args: Any, **kwargs: Any) -> Dict[str, Any]:
            audit_pre = {"event": "pre-execution", "args": args, "kwargs": kwargs}
            result = agent_callable(*args, **kwargs)
            audit_post = {"event": "post-execution", "result": result}
            return {
                "audit_pre": audit_pre,
                "audit_post": audit_post,
                "result": result,
            }

        return wrapped
