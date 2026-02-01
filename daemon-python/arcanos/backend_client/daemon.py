from typing import Any, TYPE_CHECKING

from ..backend_client_models import BackendResponse

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def request_confirm_daemon_actions(
    client: "BackendApiClient",
    confirmation_token: str,
    instance_id: str
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Confirm and queue sensitive daemon actions via backend.
    Inputs/Outputs: confirmation_token and instance_id; returns backend payload.
    Edge cases: Returns structured error on auth, network, or invalid confirmation token.
    """
    payload: dict[str, Any] = {
        "confirmation_token": confirmation_token,
        "instanceId": instance_id
    }

    response = client._request_json("post", "/api/daemon/confirm-actions", payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: error returned; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)
