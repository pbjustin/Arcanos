from typing import Any, Mapping, Optional, Sequence, TYPE_CHECKING

from ..config import Config

from ..backend_client_models import BackendChatResult, BackendRequestError, BackendResponse

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def _build_backend_ask_payload(gpt_id: Optional[str] = None, **fields: Any) -> dict[str, Any]:
    """
    Purpose: Seed `/ask` payloads with request-scoped or daemon GPT identity and caller-provided fields.
    Inputs/Outputs: optional gpt id plus arbitrary payload fields; returns payload dict with canonical gptId.
    Edge cases: blank overrides fall back to Config.BACKEND_GPT_ID.
    """
    resolved_gpt_id = (gpt_id or "").strip() or Config.BACKEND_GPT_ID
    return {"gptId": resolved_gpt_id, **fields}


def _resolve_backend_chat_path(gpt_id: Optional[str] = None) -> str:
    """
    Purpose: Choose the canonical backend endpoint for chat-style requests.
    Inputs/Outputs: optional explicit GPT id; returns `/gpt/<id>` for module-bound traffic or `/ask` for generic daemon chat.
    Edge cases: blank overrides keep legacy `/ask` behavior so daemon/system traffic does not depend on GPT registry entries.
    """
    explicit_gpt_id = (gpt_id or "").strip()
    if explicit_gpt_id:
        return f"/gpt/{explicit_gpt_id}"
    return "/ask"


def request_ask_with_domain(
    client: "BackendApiClient",
    message: str,
    domain: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    gpt_id: Optional[str] = None,
) -> BackendResponse[BackendChatResult]:
    """
    Purpose: Call backend /ask with domain hint for natural language routing.
    Inputs/Outputs: message, optional domain, optional metadata; returns BackendChatResult.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    payload = _build_backend_ask_payload(gpt_id=gpt_id, prompt=message)
    if domain:
        # //audit assumption: domain optional; risk: missing routing context; invariant: include when provided; strategy: conditional field.
        payload["domain"] = domain
    normalized_metadata = client._normalize_metadata(metadata)
    if normalized_metadata is not None:
        # //audit assumption: metadata optional; risk: missing context; invariant: include when provided; strategy: conditional field.
        payload["metadata"] = normalized_metadata

    # Prefer top-level sessionId/context if provided in metadata.
    if isinstance(normalized_metadata, dict):
        if "instanceId" in normalized_metadata and "sessionId" not in payload:
            payload["sessionId"] = str(normalized_metadata.get("instanceId"))
        if "repoIndex" in normalized_metadata:
            payload["context"] = {"repoIndex": normalized_metadata.get("repoIndex")}


    response = client._request_json("post", _resolve_backend_chat_path(gpt_id), payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    return client._parse_chat_response(response.value)


def request_chat_completion(
    client: "BackendApiClient",
    messages: Sequence[Mapping[str, str]],
    temperature: Optional[float] = None,
    model: Optional[str] = None,
    stream: bool = False,
    metadata: Optional[Mapping[str, Any]] = None,
    gpt_id: Optional[str] = None,
) -> BackendResponse[BackendChatResult]:
    """
    Purpose: Call backend /ask with conversation messages.
    Inputs/Outputs: messages, optional temperature/model, stream flag; returns BackendChatResult.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    # Extract last user message as the primary 'message' field for backend validation.
    # The backend /api/ask requires one of: message, prompt, userInput, content, text, query.
    msgs_list = list(messages)
    last_user_msg = ""
    for msg in reversed(msgs_list):
        if msg.get("role") == "user":
            last_user_msg = msg.get("content", "")
            break
    payload = _build_backend_ask_payload(
        gpt_id=gpt_id,
        prompt=last_user_msg,
        messages=msgs_list,
        stream=stream,
    )
    if temperature is not None:
        # //audit assumption: temperature optional; risk: missing value; invariant: include when provided; strategy: conditional field.
        payload["temperature"] = temperature
    if model:
        # //audit assumption: model override optional; risk: invalid model; invariant: include when provided; strategy: conditional field.
        payload["model"] = model
    normalized_metadata = client._normalize_metadata(metadata)
    if normalized_metadata is not None:
        # //audit assumption: metadata optional; risk: missing context; invariant: include when provided; strategy: conditional field.
        payload["metadata"] = normalized_metadata

    # Prefer top-level sessionId/context if provided in metadata.
    if isinstance(normalized_metadata, dict):
        if "instanceId" in normalized_metadata and "sessionId" not in payload:
            payload["sessionId"] = str(normalized_metadata.get("instanceId"))
        if "repoIndex" in normalized_metadata:
            payload["context"] = {"repoIndex": normalized_metadata.get("repoIndex")}


    response = client._request_json("post", _resolve_backend_chat_path(gpt_id), payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    return client._parse_chat_response(response.value)


def request_system_state(
    client: "BackendApiClient",
    metadata: Optional[Mapping[str, Any]] = None,
    expected_version: Optional[int] = None,
    patch: Optional[Mapping[str, Any]] = None,
    gpt_id: Optional[str] = None,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Request governed backend system state from /ask mode=system_state.
    Inputs/Outputs: optional metadata and optimistic-lock update payload; returns raw state JSON.
    Edge cases: update writes require both expected_version and patch fields together.
    """
    payload = _build_backend_ask_payload(gpt_id=gpt_id, mode="system_state")

    normalized_metadata = client._normalize_metadata(metadata)
    if normalized_metadata is not None:
        # //audit assumption: metadata optional; risk: missing tracing context; invariant: include when provided; strategy: conditional attach.
        payload["metadata"] = normalized_metadata

    # Prefer top-level sessionId/context if provided in metadata.
    if isinstance(normalized_metadata, dict):
        if "instanceId" in normalized_metadata and "sessionId" not in payload:
            payload["sessionId"] = str(normalized_metadata.get("instanceId"))
        if "repoIndex" in normalized_metadata:
            payload["context"] = {"repoIndex": normalized_metadata.get("repoIndex")}


    # //audit assumption: optimistic lock updates require both fields; risk: partial contract write; invariant: both fields must appear together; strategy: reject malformed client payload.
    if (expected_version is None) != (patch is None):
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="validation",
                message="system_state updates require expected_version and patch together",
            ),
        )

    if expected_version is not None and patch is not None:
        payload["expectedVersion"] = expected_version
        payload["patch"] = dict(patch)

    response = client._request_json("post", "/ask", payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return structured error.
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)
