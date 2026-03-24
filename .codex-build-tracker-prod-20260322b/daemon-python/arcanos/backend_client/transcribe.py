from typing import Any, Mapping, Optional, TYPE_CHECKING

from ..backend_client_models import BackendResponse, BackendTranscriptionResult

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def request_transcription(
    client: "BackendApiClient",
    audio_base64: str,
    filename: Optional[str] = None,
    model: Optional[str] = None,
    language: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None
) -> BackendResponse[BackendTranscriptionResult]:
    """
    Purpose: Call backend /api/transcribe to transcribe audio.
    Inputs/Outputs: base64 audio, optional filename/model/language; returns BackendTranscriptionResult.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    payload: dict[str, Any] = {
        "audioBase64": audio_base64
    }
    if filename:
        # //audit assumption: filename optional; risk: missing filename; invariant: include when provided; strategy: conditional field.
        payload["filename"] = filename
    if model:
        # //audit assumption: model override optional; risk: invalid model; invariant: include when provided; strategy: conditional field.
        payload["model"] = model
    if language:
        # //audit assumption: language optional; risk: invalid value; invariant: include when provided; strategy: conditional field.
        payload["language"] = language
    normalized_metadata = client._normalize_metadata(metadata)
    if normalized_metadata is not None:
        # //audit assumption: metadata optional; risk: missing context; invariant: include when provided; strategy: conditional field.
        payload["metadata"] = normalized_metadata

    response = client._request_json("post", "/api/transcribe", payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    return client._parse_transcription_response(response.value)
