from datetime import datetime
from typing import Any, Mapping, TYPE_CHECKING

from ..backend_client_models import BackendRequestError, BackendResponse

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def is_valid_registry_payload(payload: Any) -> bool:
    """Validate the existing v1 shape owned by the Express daemon registry.

    A successful JSON response alone is not registry evidence. Empty module
    catalogs remain valid, but the static endpoints, tools, and core must exist.
    """
    if (
        not isinstance(payload, Mapping)
        or type(payload.get("version")) is not int
        or payload["version"] != 1
    ):
        return False
    updated_at = payload.get("updatedAt")
    if not isinstance(updated_at, str):
        return False
    try:
        if datetime.fromisoformat(updated_at.replace("Z", "+00:00")).tzinfo is None:
            return False
    except ValueError:
        return False

    required_text = {
        "endpoints": ("method", "path", "description"),
        "modules": ("id",),
        "daemonTools": ("name", "description"),
        "core": ("id", "description"),
    }
    for field, text_fields in required_text.items():
        entries = payload.get(field)
        if not isinstance(entries, list) or (field != "modules" and not entries):
            return False
        for entry in entries:
            if not isinstance(entry, Mapping) or any(
                not isinstance(entry.get(key), str) or not entry[key].strip()
                for key in text_fields
            ):
                return False
            if field == "daemonTools" and type(entry.get("sensitive")) is not bool:
                return False
            if field == "modules":
                for nullable_text in ("description", "route"):
                    if entry.get(nullable_text) is not None and not isinstance(entry[nullable_text], str):
                        return False
            sequence_key = "actions" if field == "modules" else "modes" if field == "core" else None
            if sequence_key is not None and (field == "modules" or sequence_key in entry):
                values = entry.get(sequence_key)
                if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                    return False
    return True


def request_registry(client: "BackendApiClient") -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch backend daemon registry for prompt construction.
    Inputs/Outputs: None; returns registry JSON.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    response = client._request_json("get", "/api/daemon/registry", None)
    if not response.ok:
        # //audit assumption: response must be ok; risk: backend failure; invariant: error returned; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    if not is_valid_registry_payload(response.value):
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="parse", message="Backend daemon registry is malformed or unsupported",
            ),
        )

    return BackendResponse(ok=True, value=response.value)
