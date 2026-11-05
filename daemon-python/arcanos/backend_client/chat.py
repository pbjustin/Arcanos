from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Optional, Sequence, TYPE_CHECKING
from urllib.parse import quote, urlencode
from uuid import UUID

from ..backend_client_models import (
    BackendChatResult,
    BackendChatContinuation,
    BackendGptAsyncBridgeResult,
    BackendRequestError,
    BackendResponse,
)
from ..config import Config

if TYPE_CHECKING:
    from ..backend_client import BackendApiClient


JOB_READ_TOKEN_ENV_NAME = "ARCANOS_JOB_READ_TOKEN"
JOB_READ_TOKEN_HEADER_NAME = "x-arcanos-job-read-token"
_JOB_READ_TOKEN_PATTERN = re.compile(r"^v1\.[A-Za-z0-9_-]{43}$")


def read_chat_continuation(payload: Any) -> Optional[BackendChatContinuation]:
    """Retain only validated same-job coordinates from an accepted chat response.

    Server URLs and arbitrary response fields are never retained or followed.
    A syntactically valid capability still requires verification by the jobs API.
    """
    if not isinstance(payload, Mapping) or payload.get("ok") is not True:
        return None
    if payload.get("status") not in ("queued", "running", "pending", "timeout"):
        return None
    job_id = payload.get("jobId")
    try:
        if not isinstance(job_id, str) or str(UUID(job_id)) != job_id:
            return None
    except ValueError:
        return None
    token = payload.get("jobReadToken")
    if not isinstance(token, str) or _JOB_READ_TOKEN_PATTERN.fullmatch(token) is None:
        return None
    if payload.get("jobReadTokenHeader", JOB_READ_TOKEN_HEADER_NAME) != JOB_READ_TOKEN_HEADER_NAME:
        return None
    if payload.get("poll", f"/jobs/{job_id}/result") != f"/jobs/{job_id}/result":
        return None
    return BackendChatContinuation(job_id=job_id, job_read_token=token)


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


def _is_gpt_async_bridge_envelope(payload: Mapping[str, Any], action: str) -> bool:
    return (
        isinstance(payload.get("ok"), bool)
        and _read_string(payload.get("action")) == action
        and _is_mapping(payload.get("result"))
    )


def _read_job_read_capability(
    payload: Mapping[str, Any],
) -> tuple[Optional[str], Optional[str]]:
    """
    Purpose: Retain a valid job-read capability from one async response.
    Inputs/Outputs: raw backend payload; returns validated token plus its fixed header name.
    Edge cases: malformed tokens are left only in `raw` and never promoted into transport metadata.
    """
    token = payload.get("jobReadToken")
    if not isinstance(token, str) or _JOB_READ_TOKEN_PATTERN.fullmatch(token) is None:
        return None, None
    return token, JOB_READ_TOKEN_HEADER_NAME


def _resolve_job_read_token(
    job_read_token: Optional[str],
) -> tuple[Optional[str], Optional[BackendRequestError]]:
    """
    Purpose: Resolve and validate the bearer capability for one generic job read.
    Inputs/Outputs: explicit token or configured fallback; returns token and optional validation error.
    Edge cases: an explicitly supplied invalid token never falls back to environment configuration.
    """
    candidate = (
        job_read_token
        if job_read_token is not None
        else getattr(Config, "ARCANOS_JOB_READ_TOKEN", None)
    )
    if candidate is None or candidate == "":
        return None, BackendRequestError(
            kind="validation",
            message=(
                f"{JOB_READ_TOKEN_ENV_NAME} or an explicit job_read_token "
                "is required for generic job reads"
            ),
        )
    if (
        not isinstance(candidate, str)
        or _JOB_READ_TOKEN_PATTERN.fullmatch(candidate) is None
    ):
        return None, BackendRequestError(
            kind="validation",
            message="job_read_token must be a valid v1 job-read capability",
        )
    return candidate, None


def _request_job_read_json(
    client: "BackendApiClient",
    path: str,
    job_read_token: Optional[str],
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Send one generic job read with its capability in the fixed request header.
    Inputs/Outputs: client, canonical route, and optional explicit token; returns raw backend JSON.
    Edge cases: missing or malformed capabilities fail locally before any transport call.
    """
    resolved_token, token_error = _resolve_job_read_token(job_read_token)
    if token_error is not None or resolved_token is None:
        return BackendResponse(ok=False, error=token_error)
    return client._request_json(
        "get",
        path,
        None,
        job_read_token=resolved_token,
    )


def _normalize_gpt_async_bridge_payload(
    payload: Mapping[str, Any],
    action: str,
) -> BackendGptAsyncBridgeResult:
    """
    Purpose: Normalize GPT async bridge responses from `/gpt/:gptId` and `/jobs/*`.
    Inputs/Outputs: raw backend JSON mapping plus canonical action; returns typed bridge result.
    Edge cases: `get_result` preserves backend compatibility envelopes under `raw` while exposing the final result under `result`.
    """
    job_read_token, job_read_token_header = _read_job_read_capability(payload)

    if action == "get_status":
        raw_status = (
            payload.get("result")
            if _is_gpt_async_bridge_envelope(payload, action)
            else payload
        )
        assert isinstance(raw_status, Mapping)
        return BackendGptAsyncBridgeResult(
            action=action,
            job_id=_read_string(payload.get("jobId")) or _read_string(raw_status.get("id")),
            status=_read_string(payload.get("status")) or _read_string(raw_status.get("status")),
            lifecycle_status=_read_string(payload.get("lifecycleStatus")) or _read_string(raw_status.get("lifecycle_status")),
            result=dict(raw_status),
            error=payload.get("error") if _is_mapping(payload.get("error")) else None,
            raw=dict(payload),
            job_read_token=job_read_token,
            job_read_token_header=job_read_token_header,
        )

    if action == "get_result":
        raw_lookup = (
            payload.get("result")
            if _is_gpt_async_bridge_envelope(payload, action)
            else payload
        )
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
            result=(
                payload.get("output")
                if "output" in payload
                else payload.get("result")
                if raw_lookup is payload
                else raw_lookup.get("result")
            ),
            error=dict(error_payload) if _is_mapping(error_payload) else None,
            raw=dict(payload),
            job_read_token=job_read_token,
            job_read_token_header=job_read_token_header,
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
        job_read_token=job_read_token,
        job_read_token_header=job_read_token_header,
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
    response = client._request_json("post", route.endpoint, payload, require_completed_chat=True)
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
    response = client._request_json("post", route.endpoint, payload, require_completed_chat=True)
    if not response.ok or not response.value:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
        return BackendResponse(ok=False, error=response.error)

    return client._parse_chat_response(response.value)


def _is_system_state_timestamp(value: Any) -> bool:
    """Accept a timezone-aware server timestamp or an explicitly unknown value."""
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def _is_system_state_confidence(value: Any) -> bool:
    """Accept a finite normalized measurement or an explicitly unknown value."""
    return value is None or (
        type(value) in (int, float) and 0 <= value <= 1
    )


def is_valid_system_state_payload(payload: Any) -> bool:
    """Validate essential fields of the existing TypeScript-owned status envelope.

    Unknown measurements may be null; optional and transient fields need not be
    present. Extra server fields do not become diagnostic evidence or authority.
    """
    if not isinstance(payload, Mapping) or payload.get("mode") != "system_state":
        return False
    if any(
        not isinstance(payload.get(key), Mapping)
        for key in ("intent", "routing", "backend", "stateFreshness")
    ):
        return False
    intent, routing = payload["intent"], payload["routing"]
    backend, freshness = payload["backend"], payload["stateFreshness"]
    if "intentId" not in intent or (
        intent["intentId"] is not None and not isinstance(intent["intentId"], str)
    ):
        return False
    if "preferred" not in routing or routing["preferred"] not in ("local", "backend", None):
        return False
    if any(
        key not in backend or (backend[key] is not None and type(backend[key]) is not bool)
        for key in ("connected", "registryAvailable")
    ):
        return False
    if any(
        key not in freshness or freshness[key] not in ("fresh", "stale", "unknown", None)
        for key in ("intent", "backend")
    ):
        return False
    if "generatedAt" not in payload or not _is_system_state_timestamp(payload["generatedAt"]):
        return False
    if intent.get("label") is not None and not isinstance(intent["label"], str):
        return False
    if intent.get("status") not in ("active", "paused", "completed", None):
        return False
    if intent.get("phase") not in ("exploration", "execution", None):
        return False
    if not _is_system_state_confidence(intent.get("confidence")):
        return False
    version = intent.get("version")
    if version is not None and (type(version) is not int or version < 1):
        return False
    if not _is_system_state_timestamp(intent.get("lastTouchedAt")):
        return False
    if routing.get("lastUsed") not in ("local", "backend", None):
        return False
    if not _is_system_state_confidence(routing.get("confidenceGate")):
        return False
    if not _is_system_state_timestamp(backend.get("lastHeartbeatAt")) or not _is_system_state_timestamp(
        freshness.get("lastValidatedAt")
    ):
        return False
    limits = payload.get("limits")
    if limits is not None:
        if not isinstance(limits, Mapping) or (
            limits.get("rateLimited") is not None and type(limits["rateLimited"]) is not bool
        ):
            return False
        remaining = limits.get("remainingRequests")
        if remaining is not None and (type(remaining) is not int or remaining < 0):
            return False
    return _is_system_state_confidence(payload.get("confidence"))


def request_system_state(
    client: "BackendApiClient",
    metadata: Optional[Mapping[str, Any]] = None,
    expected_version: Optional[int] = None,
    patch: Optional[Mapping[str, Any]] = None,
    gpt_id: Optional[str] = None,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Request governed backend system state from the direct `/system-state` endpoint.
    Inputs/Outputs: optional metadata and optimistic-lock update payload; returns raw state JSON.
    Edge cases: GET responses require a valid status envelope; updates require both
    expected_version and patch. gpt_id does not affect direct control-plane routing.
    """
    payload = _build_backend_payload()

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

    if expected_version is None:
        query = urlencode({"sessionId": payload["sessionId"]}) if "sessionId" in payload else ""
        path = f"/system-state?{query}" if query else "/system-state"
        response = client._request_json("get", path, None)
    else:
        response = client._request_json("post", "/system-state", payload)
    if not response.ok:
        # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return structured error.
        return BackendResponse(ok=False, error=response.error)

    if expected_version is None and not is_valid_system_state_payload(response.value):
        return BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="parse", message="Backend system-state envelope is malformed or unsupported",
            ),
        )
    if not response.value:
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
    job_read_token: Optional[str] = None,
) -> BackendResponse[BackendGptAsyncBridgeResult]:
    """
    Purpose: Read async job status through the canonical jobs API without enqueueing new work.
    Inputs/Outputs: required job_id, optional gpt_id, and job-read capability; returns typed async bridge status metadata.
    Edge cases: blank ids or invalid capabilities fail locally and the deprecated gpt_id parameter is ignored so control reads never use `/gpt`.
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

    _ = gpt_id
    response = _request_job_read_json(
        client,
        f"/jobs/{quote(normalized_job_id, safe='')}",
        job_read_token,
    )
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(
        ok=True,
        value=_normalize_gpt_async_bridge_payload(response.value, "get_status"),
    )


def request_gpt_job_result(
    client: "BackendApiClient",
    job_id: str,
    gpt_id: Optional[str] = None,
    job_read_token: Optional[str] = None,
) -> BackendResponse[BackendGptAsyncBridgeResult]:
    """
    Purpose: Read async job results through the canonical jobs API without enqueueing new work.
    Inputs/Outputs: required job_id, optional gpt_id, and job-read capability; returns typed async bridge result metadata.
    Edge cases: blank ids or invalid capabilities fail locally and the deprecated gpt_id parameter is ignored so control reads never use `/gpt`.
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

    _ = gpt_id
    response = _request_job_read_json(
        client,
        f"/jobs/{quote(normalized_job_id, safe='')}/result",
        job_read_token,
    )
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(
        ok=True,
        value=_normalize_gpt_async_bridge_payload(response.value, "get_result"),
    )


def request_job_result(
    client: "BackendApiClient",
    job_id: str,
    gpt_id: Optional[str] = None,
    job_read_token: Optional[str] = None,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch a stored async GPT job result through the canonical jobs API.
    Inputs/Outputs: required job_id and job-read capability; returns raw job-result JSON from `GET /jobs/:id/result`.
    Edge cases: blank ids or invalid capabilities fail locally so retrieval never degrades into a prompt query.
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

    response = _request_job_read_json(
        client,
        f"/jobs/{quote(normalized_job_id, safe='')}/result",
        job_read_token,
    )
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)


def request_chat_job_result(
    client: "BackendApiClient",
    continuation: BackendChatContinuation,
) -> BackendResponse[BackendChatResult]:
    """Read an accepted conversation once through the existing authenticated jobs API.

    Pending and terminal failures remain nonanswers. This operation cannot enqueue,
    refresh credentials, wait, retry, or follow response-supplied URLs.
    """
    if not isinstance(continuation, BackendChatContinuation) or read_chat_continuation({
        "ok": True, "status": "queued", "jobId": continuation.job_id,
        "jobReadToken": continuation.job_read_token,
    }) is None:
        return BackendResponse(ok=False, error=BackendRequestError(
            kind="validation", message="A valid accepted chat continuation is required.",
        ))
    response = client.request_job_result(
        continuation.job_id, job_read_token=continuation.job_read_token,
    )
    if not response.ok:
        error = response.error
        return BackendResponse(ok=False, error=BackendRequestError(
            kind=error.kind if error else "unavailable",
            message="The stored conversation answer could not be retrieved.",
            status_code=error.status_code if error else None,
        ))
    payload = response.value
    if not isinstance(payload, Mapping) or payload.get("jobId") != continuation.job_id:
        return BackendResponse(ok=False, error=BackendRequestError(
            kind="parse", message="The job result did not match this conversation request.",
        ))
    status = payload.get("status")
    if status != "completed":
        job_status = payload.get("jobStatus")
        if status == "pending":
            kind, message = "pending", "The original conversation job is still pending."
        elif status == "expired":
            kind, message = "expired", "The original conversation job has expired."
        elif status == "failed" and job_status == "cancelled":
            kind, message = "cancelled", "The original conversation job was cancelled."
        elif status == "failed":
            kind, message = "failed", "The original conversation job failed."
        elif status == "not_found":
            kind, message = "unavailable", "The original conversation job is unavailable or inaccessible."
        else:
            kind, message = "parse", "The conversation job returned an unsupported result state."
        return BackendResponse(ok=False, error=BackendRequestError(
            kind=kind, message=message,
            continuation=continuation if kind == "pending" else None,
        ))

    envelope = payload.get("result")
    if (
        payload.get("jobStatus", "completed") != "completed"
        or payload.get("lifecycleStatus", "completed") != "completed"
        or payload.get("error")
        or not _is_completed_chat_job_output(envelope)
    ):
        return BackendResponse(ok=False, error=BackendRequestError(
            kind="parse", message="The completed conversation job has no valid complete answer.",
        ))
    assert isinstance(envelope, Mapping)
    # Durable output retains the dispatcher envelope, whose usage/model fields
    # may live inside result. Promote only these existing authoritative fields;
    # nested module content cannot assert producer presentation provenance.
    chat_payload = dict(envelope)
    result = envelope.get("result")
    if isinstance(result, Mapping):
        for key in ("tokens", "cost", "meta", "model", "activeModel"):
            if key not in chat_payload and key in result:
                chat_payload[key] = result[key]
    return client._parse_chat_response(chat_payload)


def _is_completed_chat_job_output(envelope: Any) -> bool:
    """Reject empty or explicitly incomplete durable outputs before chat parsing."""
    if not isinstance(envelope, Mapping) or envelope.get("ok") is not True:
        return False
    if not isinstance(envelope.get("_route"), Mapping):
        return False
    answer = envelope.get("result")
    if isinstance(answer, str):
        has_text = bool(answer.strip())
    elif isinstance(answer, Mapping):
        # Match direct chat's structured-answer support while keeping the
        # existing empty nested result wrapper classified as no answer.
        has_text = bool(answer) and answer != {"result": {}}
    else:
        has_text = False
    if not has_text:
        return False
    records = [envelope]
    if isinstance(answer, Mapping):
        records.append(answer)
    # Inspect only contract metadata, within a fixed depth; never interpret
    # ordinary answer prose or arbitrary nested user data as completion state.
    for record in list(records):
        for key in ("meta", "provider_metadata"):
            if isinstance(record.get(key), Mapping):
                records.append(record[key])
    for record in records:
        if record.get("ok") is False or record.get("error"):
            return False
        if record.get("status") in ("pending", "queued", "running", "incomplete", "failed", "cancelled", "expired", "timeout"):
            return False
        if any(record.get(key) is True for key in (
            "incomplete", "truncated", "length_truncated", "lengthTruncated", "content_filtered", "contentFiltered",
        )):
            return False
        if record.get("finish_reason", record.get("finishReason")) in ("length", "content_filter"):
            return False
        if record.get("response_status", record.get("responseStatus")) == "incomplete":
            return False
    return True


def request_job_status(
    client: "BackendApiClient",
    job_id: str,
    job_read_token: Optional[str] = None,
) -> BackendResponse[dict[str, Any]]:
    """
    Purpose: Fetch async GPT job status through the canonical jobs API.
    Inputs/Outputs: required job_id and job-read capability; returns raw job-status JSON from `GET /jobs/:id`.
    Edge cases: blank ids or invalid capabilities fail locally so status polling never degrades into a prompt query.
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

    response = _request_job_read_json(
        client,
        f"/jobs/{quote(normalized_job_id, safe='')}",
        job_read_token,
    )
    if not response.ok or not response.value:
        return BackendResponse(ok=False, error=response.error)

    return BackendResponse(ok=True, value=response.value)
