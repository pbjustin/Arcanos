from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence, TYPE_CHECKING
from urllib.parse import quote

from ..backend_client_models import (
    BackendChatResult,
    BackendGptAsyncBridgeResult,
    BackendRequestError,
    BackendResponse,
)
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


def _copy_backend_context_fields(
    client: "BackendApiClient",
    payload: dict[str, Any],
    metadata: Optional[Mapping[str, Any]],
) -> None:
    """
    Purpose: Attach normalized metadata/session/context fields to one backend payload.
    Inputs/Outputs: mutable payload dict plus optional metadata; mutates payload in place.
    Edge cases: Keeps `sessionId` and `context.repoIndex` in their canonical top-level fields when present.
    """
    normalized_metadata = client._normalize_metadata(metadata)
    if normalized_metadata is not None:
        payload["metadata"] = normalized_metadata

    if isinstance(normalized_metadata, dict):
        if "instanceId" in normalized_metadata and "sessionId" not in payload:
            payload["sessionId"] = str(normalized_metadata.get("instanceId"))
        if "repoIndex" in normalized_metadata:
            payload["context"] = {"repoIndex": normalized_metadata.get("repoIndex")}


def _is_mapping(value: Any) -> bool:
    return isinstance(value, Mapping)


def _read_string(value: Any) -> Optional[str]:
    if isinstance(value, str):
        normalized = value.strip()
        if normalized:
            return normalized
    return None


def _read_nullable_string(value: Any) -> Optional[str]:
    if value is None:
        return None
    return _read_string(value)


def _normalize_gpt_async_bridge_payload(
    payload: Mapping[str, Any],
    action: str,
) -> BackendGptAsyncBridgeResult:
    """
    Purpose: Normalize GPT async bridge responses from `/gpt/:gptId` and `/jobs/*`.
    Inputs/Outputs: raw backend JSON mapping plus canonical action; returns typed bridge result.
    Edge cases: `get_result` preserves backend compatibility envelopes under `raw` while exposing the final result under `result`.
    """
    if action == "get_status":
        raw_status = payload.get("result") if _is_mapping(payload.get("result")) else payload
        assert isinstance(raw_status, Mapping)
        return BackendGptAsyncBridgeResult(
            action=action,
            job_id=_read_string(payload.get("jobId")) or _read_string(raw_status.get("id")),
            status=_read_string(payload.get("status")) or _read_string(raw_status.get("status")),
            lifecycle_status=_read_string(payload.get("lifecycleStatus")) or _read_string(raw_status.get("lifecycle_status")),
            result=dict(raw_status),
            error=payload.get("error") if _is_mapping(payload.get("error")) else None,
            raw=dict(payload),
        )

    if action == "get_result":
        raw_lookup = payload.get("result") if _is_mapping(payload.get("result")) else payload
        assert isinstance(raw_lookup, Mapping)
        error_payload = payload.get("error") if _is_mapping(payload.get("error")) else raw_lookup.get("error")
        return BackendGptAsyncBridgeResult(
            action=action,
            job_id=_read_string(payload.get("jobId")) or _read_string(raw_lookup.get("jobId")),
            status=_read_string(payload.get("status")) or _read_string(raw_lookup.get("status")),
            lifecycle_status=_read_string(payload.get("lifecycleStatus")) or _read_string(raw_lookup.get("lifecycleStatus")),
            job_status=_read_nullable_string(payload.get("jobStatus")) or _read_nullable_string(raw_lookup.get("jobStatus")),
            poll=_read_string(payload.get("poll")) or _read_string(raw_lookup.get("poll")),
            stream=_read_string(payload.get("stream")) or _read_string(raw_lookup.get("stream")),
            result=payload.get("output") if "output" in payload else raw_lookup.get("result"),
            error=dict(error_payload) if _is_mapping(error_payload) else None,
            raw=dict(payload),
        )

    return BackendGptAsyncBridgeResult(
        action=_read_string(payload.get("action")) or action,
        job_id=_read_string(payload.get("jobId")),
        status=_read_string(payload.get("status")),
        lifecycle_status=_read_string(payload.get("lifecycleStatus")),
        job_status=_read_nullable_string(payload.get("jobStatus")),
        poll=_read_string(payload.get("poll")),
        stream=_read_string(payload.get("stream")),
        result=payload.get("result"),
        error=dict(payload.get("error")) if _is_mapping(payload.get("error")) else None,
        raw=dict(payload),
    )


def _request_gpt_async_bridge(
    client: "BackendApiClient",
    *,
    action: str,
    route: BackendChatRoute,
    payload: Mapping[str, Any],
) -> BackendResponse[BackendGptAsyncBridgeResult]:
    """
    Purpose: Execute one canonical GPT async bridge request and normalize the backend envelope.
    Inputs/Outputs: resolved route plus payload mapping; returns a typed async bridge result.
    Edge cases: backend JSON errors are returned verbatim through BackendResponse without fallback to chat parsing.
    """
    response = client._request_json("post", route.endpoint, payload)
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(
        ok=True,
        value=_normalize_gpt_async_bridge_payload(response.value, action),
    )


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


def request_query(
    client: "BackendApiClient",
    prompt: str,
    metadata: Optional[Mapping[str, Any]] = None,
    gpt_id: Optional[str] = None,
) -> BackendResponse[BackendGptAsyncBridgeResult]:
    """
    Purpose: Create one async GPT writing job through the canonical `query` bridge action.
    Inputs/Outputs: prompt, optional metadata, and optional gpt_id; returns typed async bridge metadata.
    Edge cases: blank prompts fail locally so callers never fall back to ambiguous route inference.
    """
    normalized_prompt = prompt.strip()
    if not normalized_prompt:
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="validation",
                message="prompt is required for query",
            ),
        )

    route = resolve_backend_chat_route(gpt_id)
    payload = _build_backend_payload(action="query", prompt=normalized_prompt)
    _copy_backend_context_fields(client, payload, metadata)
    return _request_gpt_async_bridge(
        client,
        action="query",
        route=route,
        payload=payload,
    )


def request_query_and_wait(
    client: "BackendApiClient",
    prompt: str,
    timeout_ms: Optional[int] = None,
    poll_interval_ms: Optional[int] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    gpt_id: Optional[str] = None,
) -> BackendResponse[BackendGptAsyncBridgeResult]:
    """
    Purpose: Create one async GPT writing job and wait briefly through the canonical `query_and_wait` bridge action.
    Inputs/Outputs: prompt, optional timeout/poll controls, optional metadata, and optional gpt_id; returns typed async bridge result metadata.
    Edge cases: blank prompts fail locally and timeout controls stay structured instead of being encoded into free-form text.
    """
    normalized_prompt = prompt.strip()
    if not normalized_prompt:
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="validation",
                message="prompt is required for query_and_wait",
            ),
        )

    route = resolve_backend_chat_route(gpt_id)
    payload = _build_backend_payload(
        action="query_and_wait",
        prompt=normalized_prompt,
        timeoutMs=timeout_ms,
        pollIntervalMs=poll_interval_ms,
    )
    _copy_backend_context_fields(client, payload, metadata)
    return _request_gpt_async_bridge(
        client,
        action="query_and_wait",
        route=route,
        payload=payload,
    )


def request_gpt_job_status(
    client: "BackendApiClient",
    job_id: str,
    gpt_id: Optional[str] = None,
) -> BackendResponse[BackendGptAsyncBridgeResult]:
    """
    Purpose: Read async job status through the GPT compatibility bridge without enqueueing new work.
    Inputs/Outputs: required job_id and optional gpt_id; returns typed async bridge status metadata.
    Edge cases: blank job ids fail locally so control reads never degrade into prompt-based lookups.
    """
    normalized_job_id = job_id.strip()
    if not normalized_job_id:
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="validation",
                message="job_id is required for get_status",
            ),
        )

    route = resolve_backend_chat_route(gpt_id)
    payload = _build_backend_payload(
        action="get_status",
        payload={"jobId": normalized_job_id},
    )
    return _request_gpt_async_bridge(
        client,
        action="get_status",
        route=route,
        payload=payload,
    )


def request_gpt_job_result(
    client: "BackendApiClient",
    job_id: str,
    gpt_id: Optional[str] = None,
) -> BackendResponse[BackendGptAsyncBridgeResult]:
    """
    Purpose: Read async job results through the GPT compatibility bridge without enqueueing new work.
    Inputs/Outputs: required job_id and optional gpt_id; returns typed async bridge result metadata.
    Edge cases: blank job ids fail locally so control reads never degrade into prompt-based lookups.
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
    return _request_gpt_async_bridge(
        client,
        action="get_result",
        route=route,
        payload=payload,
    )


def request_job_result(
    client: "BackendApiClient",
    job_id: str,
    gpt_id: Optional[str] = None,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch a stored async GPT job result through the canonical jobs API.
    Inputs/Outputs: required job_id; returns raw job-result JSON from `GET /jobs/:id/result`.
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

    # Keep the deprecated gpt_id parameter in the signature for compatibility, but do not
    # use it for routing. Job lookups are path-bound to `/jobs/:id/...` only.
    _ = gpt_id

    response = client._request_json(
        "get",
        f"/jobs/{quote(normalized_job_id, safe='')}/result",
        None,
    )
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)


def request_job_status(
    client: "BackendApiClient",
    job_id: str,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch async GPT job status through the canonical jobs API.
    Inputs/Outputs: required job_id; returns raw job-status JSON from `GET /jobs/:id`.
    Edge cases: blank job ids fail locally so status polling never degrades into a prompt query.
    """
    normalized_job_id = job_id.strip()
    if not normalized_job_id:
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="validation",
                message="job_id is required for job status",
            ),
        )

    response = client._request_json(
        "get",
        f"/jobs/{quote(normalized_job_id, safe='')}",
        None,
    )
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)
