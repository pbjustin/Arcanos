from typing import Any, Mapping, Optional, TYPE_CHECKING

from ..backend_client_models import BackendResponse, BackendVisionResult

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def request_vision_analysis(
    client: "BackendApiClient",
    image_base64: str,
    prompt: Optional[str] = None,
    temperature: Optional[float] = None,
    model: Optional[str] = None,
    max_tokens: Optional[int] = None,
    metadata: Optional[Mapping[str, Any]] = None
) -> BackendResponse[BackendVisionResult]:
    """
    Purpose: Call backend /api/vision to analyze an image.
    Inputs/Outputs: base64 image, optional prompt/temperature/model/max_tokens; returns BackendVisionResult.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    payload: dict[str, Any] = {
        "imageBase64": image_base64
    }
    if prompt:
        # //audit assumption: prompt optional; risk: empty prompt; invariant: include when provided; strategy: conditional field.
        payload["prompt"] = prompt
    if temperature is not None:
        # //audit assumption: temperature optional; risk: missing value; invariant: include when provided; strategy: conditional field.
        payload["temperature"] = temperature
    if model:
        # //audit assumption: model override optional; risk: invalid model; invariant: include when provided; strategy: conditional field.
        payload["model"] = model
    if max_tokens is not None:
        # //audit assumption: max tokens optional; risk: invalid value; invariant: include when provided; strategy: conditional field.
        payload["maxTokens"] = max_tokens
    normalized_metadata = client._normalize_metadata(metadata)
    if normalized_metadata is not None:
        # //audit assumption: metadata optional; risk: missing context; invariant: include when provided; strategy: conditional field.
        payload["metadata"] = normalized_metadata

    response = client._request_json("post", "/api/vision", payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    return client._parse_vision_response(response.value)
