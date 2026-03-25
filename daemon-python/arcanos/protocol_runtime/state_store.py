"""In-memory persistence primitives for scaffolded protocol runtime state."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


class InMemoryProtocolStateStore:
    """Store execution, snapshot, and artifact records for a single daemon process."""

    def __init__(self) -> None:
        """Initialize empty in-memory dictionaries for scaffolded runtime state."""

        self._executions: dict[str, dict[str, Any]] = {}
        self._snapshots: dict[str, dict[str, Any]] = {}
        self._artifacts: dict[str, dict[str, Any]] = {}

    def store_execution(self, execution_state: dict[str, Any]) -> dict[str, Any]:
        """Persist an execution state and return a defensive copy."""

        execution_id = str(execution_state["executionId"])
        self._executions[execution_id] = deepcopy(execution_state)
        return deepcopy(self._executions[execution_id])

    def get_execution(self, execution_id: str) -> dict[str, Any] | None:
        """Fetch an execution state by identifier."""

        state = self._executions.get(execution_id)
        return deepcopy(state) if state is not None else None

    def update_execution(self, execution_id: str, execution_state: dict[str, Any]) -> dict[str, Any]:
        """Update an existing execution state and return a defensive copy."""

        if execution_id not in self._executions:
            raise KeyError(f'Execution "{execution_id}" was not found.')
        self._executions[execution_id] = deepcopy(execution_state)
        return deepcopy(self._executions[execution_id])

    def store_snapshot(self, snapshot_id: str, execution_state: dict[str, Any]) -> dict[str, Any]:
        """Persist a snapshot of an execution state."""

        snapshot_payload = {
            "snapshotId": snapshot_id,
            "state": deepcopy(execution_state),
        }
        self._snapshots[snapshot_id] = snapshot_payload
        return deepcopy(snapshot_payload)

    def store_artifact(self, artifact: dict[str, Any]) -> dict[str, Any]:
        """Persist an artifact descriptor and return a defensive copy."""

        artifact_id = str(artifact["id"])
        self._artifacts[artifact_id] = deepcopy(artifact)
        return deepcopy(self._artifacts[artifact_id])
