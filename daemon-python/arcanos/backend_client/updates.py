from typing import Any, Mapping, Optional, TYPE_CHECKING

from ..backend_client_models import BackendRequestError, BackendResponse

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def submit_update_event(
    client: "BackendApiClient",
    update_type: str,
    data: Mapping[str, Any],
    metadata: Optional[Mapping[str, Any]] = None
) -> BackendResponse[bool]:
    """
    Purpose: Call backend /api/update to record a structured update event.
    Inputs/Outputs: update_type string and data mapping; returns bool success.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    payload: dict[str, Any] = {
        "updateType": update_type,
        "data": dict(data)
    }
    normalized_metadata = client._normalize_metadata(metadata)
    if normalized_metadata is not None:
        # //audit assumption: metadata optional; risk: missing context; invariant: include when provided; strategy: conditional field.
        payload["metadata"] = normalized_metadata

    response = client._request_json("post", "/api/update", payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    success_value = response.value.get("success")
    if isinstance(success_value, bool):
        # //audit assumption: success is boolean; risk: wrong type; invariant: bool value; strategy: return parsed value.
        return BackendResponse(ok=True, value=success_value)

    # //audit assumption: success should be boolean; risk: parse failure; invariant: bool; strategy: return error.
    return BackendResponse(
        ok=False,
        error=BackendRequestError(kind="parse", message="update response missing success flag")
    )
