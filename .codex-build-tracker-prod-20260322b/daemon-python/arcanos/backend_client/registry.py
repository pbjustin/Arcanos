from typing import Any, TYPE_CHECKING

from ..backend_client_models import BackendResponse

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def request_registry(client: "BackendApiClient") -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch backend daemon registry for prompt construction.
    Inputs/Outputs: None; returns registry JSON.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    response = client._request_json("get", "/api/daemon/registry", None)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: error returned; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)
