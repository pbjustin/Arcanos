"""Backend client methods for ActionPlan API."""

from __future__ import annotations

from typing import Any, TYPE_CHECKING

from ..backend_client_models import BackendResponse

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def fetch_plan(
    client: "BackendApiClient",
    plan_id: str,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch an ActionPlan by ID from the backend.
    Inputs/Outputs: plan_id; returns plan data or error.
    Edge cases: Returns error on 404 or network failure.
    """
    return client._request_json("GET", f"/plans/{plan_id}", None)


def approve_plan(
    client: "BackendApiClient",
    plan_id: str,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Approve an ActionPlan via the backend.
    Inputs/Outputs: plan_id; returns updated plan or error.
    Edge cases: Returns 403 if CLEAR blocked, 409 if wrong status.
    """
    return client._request_json("POST", f"/plans/{plan_id}/approve", {})


def submit_execution_result(
    client: "BackendApiClient",
    plan_id: str,
    result_data: dict[str, Any],
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Submit an ExecutionResult for a plan action.
    Inputs/Outputs: plan_id and result data; returns confirmation or error.
    Edge cases: Returns 409 on replay (duplicate action_id).
    """
    return client._request_json("POST", f"/plans/{plan_id}/execute", result_data)


def block_plan(
    client: "BackendApiClient",
    plan_id: str,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Block an ActionPlan via the backend.
    Inputs/Outputs: plan_id; returns updated plan or error.
    """
    return client._request_json("POST", f"/plans/{plan_id}/block", {})
