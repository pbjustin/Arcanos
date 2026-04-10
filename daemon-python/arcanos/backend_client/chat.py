from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence, TYPE_CHECKING

from ..backend_client_models import BackendChatResult, BackendRequestError, BackendResponse
from ..config import Config

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


def _build_backend_payload(**fields: Any) -> dict[str, Any]:
    """
    Purpose: Build a backend payload without transport-level routing fields.
    Inputs/Outputs: arbitrary payload fields; returns compact request payload dict.
    Edge cases: preserves falsey values like `stream=False` while dropping explicit `None` fields.
    """
    return {key: value for key, value in fields.items() if value is not None}


@dataclass(frozen=True)
class BackendChatRoute:
    """
    Purpose: Carry the resolved backend endpoint for one chat-style request.
    Inputs/Outputs: normalized gpt_id input; returns canonical endpoint plus normalized GPT identifier.
    Edge cases: blank GPT ids fall back to the configured daemon GPT so `/gpt/:gptId` remains the only execution path.
    """

    endpoint: str
    gpt_id: Optional[str]


def resolve_backend_chat_route(gpt_id: Optional[str] = None) -> BackendChatRoute:
    """
    Purpose: Choose the canonical backend endpoint for chat-style requests.
    Inputs/Outputs: optional explicit GPT id; returns `/gpt/<id>` using the explicit id or configured daemon GPT id.
    Edge cases: blank overrides fall back to `Config.BACKEND_GPT_ID` so deprecated compatibility routes are never used.
    """
    explicit_gpt_id = (gpt_id or "").strip()
    backend_gpt_id = (getattr(Config, "BACKEND_GPT_ID", None) or "").strip()
    resolved_gpt_id = explicit_gpt_id or backend_gpt_id or "arcanos-daemon"
    return BackendChatRoute(endpoint=f"/gpt/{resolved_gpt_id}", gpt_id=resolved_gpt_id)


def request_ask_with_domain(
    client: "BackendApiClient",
    message: str,
    domain: Optional[str] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    gpt_id: Optional[str] = None,
) -> BackendResponse[BackendChatResult]:
    """
    Purpose: Call backend chat routing with a domain hint through the canonical `/gpt/:gptId` route.
    Inputs/Outputs: message, optional domain, optional metadata; returns BackendChatResult.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    payload = _build_backend_payload(prompt=message)
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


    route = resolve_backend_chat_route(gpt_id)
    response = client._request_json("post", route.endpoint, payload)
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
    Purpose: Call backend chat routing with conversation messages through the canonical `/gpt/:gptId` route.
    Inputs/Outputs: messages, optional temperature/model, stream flag; returns BackendChatResult.
    Edge cases: Returns structured error on auth, network, or parsing failures.
    """
    # Extract last user message as the primary prompt so query-capable GPT modules can validate the request.
    msgs_list = list(messages)
    last_user_msg = ""
    for msg in reversed(msgs_list):
        if msg.get("role") == "user":
            last_user_msg = msg.get("content", "")
            break
    payload = _build_backend_payload(
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


    route = resolve_backend_chat_route(gpt_id)
    response = client._request_json("post", route.endpoint, payload)
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
    Purpose: Request governed backend system state from the canonical daemon GPT route.
    Inputs/Outputs: optional metadata and optimistic-lock update payload; returns raw state JSON.
    Edge cases: update writes require both expected_version and patch fields together; blank GPT ids fall back to the configured daemon GPT.
    """
    route = resolve_backend_chat_route(gpt_id)
    payload = _build_backend_payload(action="system_state")

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

    response = client._request_json("post", route.endpoint, payload)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return structured error.
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)


def request_job_result(
    client: "BackendApiClient",
    job_id: str,
    gpt_id: Optional[str] = None,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch a stored async GPT job result through the canonical GPT route.
    Inputs/Outputs: required job_id plus optional gpt_id override; returns raw job-result JSON.
    Edge cases: blank job ids fail locally so retrieval never degrades into a prompt query.
    """
    normalized_job_id = job_id.strip()
    if not normalized_job_id:
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="validation",
                message="job_id is required for get_result",
            ),
        )

    route = resolve_backend_chat_route(gpt_id)
    payload = _build_backend_payload(
        action="get_result",
        payload={"jobId": normalized_job_id},
    )
    response = client._request_json("post", route.endpoint, payload)
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)
