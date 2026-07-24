"""Authenticated outbound protocol for durable local-agent jobs.

The Python daemon is a purpose-bound executor. It never accepts inbound GPT
traffic and never selects its own principal, workspace, device, authorization,
or repository root.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional, Union

import requests  # type: ignore[import-untyped]

from ..backend_auth_client import normalize_backend_url
from ..backend_client_models import BackendRequestError, BackendResponse
from ..config import Config

PROTOCOL_VERSION = "local-agent-job-v1"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ASSIGNMENT_BYTES = 1536 * 1024
MAX_RESULT_BYTES = 48 * 1024
MAX_JSON_DEPTH = 10
MIN_EXECUTOR_TOKEN_LENGTH = 32
MAX_EXECUTOR_TOKEN_LENGTH = 4096
MAX_IDEMPOTENCY_KEY_LENGTH = 240

_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}")
_STABLE_CODE_RE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_SCOPE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_RESERVED_PAYLOAD_KEYS = {
    "actor",
    "authorization",
    "authorizationdecision",
    "confirmation",
    "confirmationstate",
    "confirmationtoken",
    "device",
    "deviceid",
    "principal",
    "principalid",
    "repositoryroot",
    "root",
    "workspace",
    "workspaceid",
}
_EXECUTABLE_DISPOSITIONS = {"CLAIMED", "CLAIM_REPLAY"}
_TERMINAL_STATES = {"COMPLETED", "FAILED", "EXPIRED", "CANCELLED"}
_AUTHORIZATION_DECISIONS = {"allow", "confirmed"}


@dataclass(frozen=True)
class LocalAgentAuthorization:
    decision: str
    evidence_id: str
    evaluated_at: datetime


@dataclass(frozen=True)
class LocalAgentJobAssignment:
    job_id: str
    action: str
    payload: dict[str, Any]
    principal: str
    workspace: str
    device_id: str
    trace_id: str
    request_id: str
    idempotency_key: str
    authorization_context: LocalAgentAuthorization
    expires_at: datetime
    timeout_ms: int
    required_device_scopes: tuple[str, ...]
    read_only: bool
    may_modify_files: bool
    disposition: str
    state: str = "RUNNING"
    protocol_version: str = PROTOCOL_VERSION

    def is_expired(self, now: Optional[datetime] = None) -> bool:
        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None or current.utcoffset() is None:
            raise ValueError("assignment clock must be timezone-aware")
        return self.expires_at <= current.astimezone(timezone.utc)


@dataclass(frozen=True)
class LocalAgentTerminalReplay:
    job_id: str
    state: str
    disposition: str = "TERMINAL_REPLAY"
    protocol_version: str = PROTOCOL_VERSION


@dataclass(frozen=True)
class LocalAgentResultAcceptance:
    job_id: str
    state: str
    disposition: str
    acceptance_receipt: str


LocalAgentClaim = Union[LocalAgentJobAssignment, LocalAgentTerminalReplay]


class LocalAgentProtocolClient:
    """Purpose-bound client for the backend's local-agent executor routes."""

    def __init__(
        self,
        base_url: str,
        token_provider: Callable[[], Optional[str]],
        *,
        timeout_seconds: int = 15,
        request_sender: Callable[..., requests.Response] = requests.request,
    ) -> None:
        self._base_url = normalize_backend_url(
            base_url,
            allow_http_dev=Config.BACKEND_ALLOW_HTTP,
        )
        self._token_provider = token_provider
        self._timeout_seconds = timeout_seconds
        self._request_sender = request_sender

    def heartbeat(self) -> BackendResponse[Optional[dict[str, Any]]]:
        return self._request(
            "POST",
            "/gpt-access/local-agent/heartbeat",
            {},
            allow_no_content=True,
        )

    def claim(
        self,
        claim_key: str,
    ) -> BackendResponse[Optional[dict[str, Any]]]:
        if not valid_idempotency_key(claim_key):
            return _validation_error("Claim key is invalid")
        return self._request(
            "POST",
            "/gpt-access/local-agent/jobs/claim",
            {"claimKey": claim_key},
            idempotency_key=claim_key,
            allow_no_content=True,
        )

    def job_heartbeat(
        self,
        job_id: str,
    ) -> BackendResponse[Optional[dict[str, Any]]]:
        path = _job_path(job_id, "heartbeat")
        if path is None:
            return _validation_error("Job identity is invalid")
        return self._request("POST", path, {}, allow_no_content=True)

    def submit_result(
        self,
        job_id: str,
        result: Mapping[str, Any],
        result_key: str,
    ) -> BackendResponse[Optional[dict[str, Any]]]:
        path = _job_path(job_id, "result")
        if path is None:
            return _validation_error("Job identity is invalid")
        if not valid_idempotency_key(result_key):
            return _validation_error("Result key is invalid")
        try:
            validate_result_request(result, expected_result_key=result_key)
        except ValueError:
            return _validation_error("Local-agent result is invalid")
        return self._request(
            "POST",
            path,
            result,
            idempotency_key=result_key,
            allow_no_content=False,
        )

    def _request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any],
        *,
        idempotency_key: Optional[str] = None,
        allow_no_content: bool = False,
    ) -> BackendResponse[Optional[dict[str, Any]]]:
        credential = self._token_provider()
        if (
            not isinstance(credential, str)
            or credential != credential.strip()
            or len(credential) < MIN_EXECUTOR_TOKEN_LENGTH
            or len(credential) > MAX_EXECUTOR_TOKEN_LENGTH
        ):
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="LOCAL_AGENT_AUTH_REQUIRED",
                    message="Local-agent executor authentication is required",
                ),
            )
        if idempotency_key is not None and not valid_idempotency_key(idempotency_key):
            return _validation_error("Idempotency key is invalid")

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {credential}",
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
            "X-ARCANOS-Protocol": PROTOCOL_VERSION,
        }
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key

        try:
            response = self._request_sender(
                method,
                f"{self._base_url}{path}",
                headers=headers,
                json=payload,
                timeout=self._timeout_seconds,
                allow_redirects=False,
            )
        except requests.Timeout:
            return _transport_error("timeout", "Local-agent request timed out")
        except requests.RequestException:
            return _transport_error("network", "Local-agent request failed")
        except Exception:
            return _transport_error("transport", "Local-agent request failed")

        status_code = getattr(response, "status_code", 0)
        if status_code == 204 and allow_no_content:
            return BackendResponse(ok=True, value=None)
        if not isinstance(status_code, int) or status_code < 200 or status_code >= 300:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind=_safe_error_code(response),
                    message="Local-agent request was rejected",
                    status_code=status_code if isinstance(status_code, int) else None,
                ),
            )
        body = _bounded_response_json(response)
        if body is None:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="LOCAL_AGENT_PROTOCOL_INCOMPATIBLE",
                    message="Local-agent response is invalid",
                    status_code=status_code,
                ),
            )
        return BackendResponse(ok=True, value=body)


def parse_claim_response(
    payload: Mapping[str, Any],
) -> LocalAgentClaim:
    body = _success_body(payload, "LOCAL_AGENT_JOB_CLAIMED")
    if _required_string(body, "protocolVersion", max_length=64) != PROTOCOL_VERSION:
        raise ValueError("protocol version mismatch")
    disposition = _required_string(body, "disposition", max_length=32)
    job_id = _required_uuid(body, "jobId")
    state = _required_string(body, "state", max_length=32)

    if disposition == "TERMINAL_REPLAY":
        if state not in _TERMINAL_STATES:
            raise ValueError("terminal replay state is invalid")
        return LocalAgentTerminalReplay(job_id=job_id, state=state)
    if disposition not in _EXECUTABLE_DISPOSITIONS or state != "RUNNING":
        raise ValueError("claim disposition is not executable")

    raw_payload = body.get("payload")
    if not isinstance(raw_payload, Mapping):
        raise ValueError("assignment payload is invalid")
    _validate_json_value(raw_payload, max_encoded_bytes=MAX_ASSIGNMENT_BYTES)
    if _contains_reserved_payload_key(raw_payload):
        raise ValueError("assignment payload contains server-controlled fields")

    authorization_value = body.get("authorization")
    if not isinstance(authorization_value, Mapping):
        raise ValueError("assignment authorization is invalid")
    decision_value = authorization_value.get("decision")
    if decision_value not in _AUTHORIZATION_DECISIONS:
        raise ValueError("assignment authorization decision is invalid")
    authorization_context = LocalAgentAuthorization(
        decision=decision_value,
        evidence_id=_required_identifier(authorization_value, "evidenceId"),
        evaluated_at=_parse_timestamp(
            authorization_value.get("evaluatedAt"),
            "authorization evaluation",
        ),
    )

    required_scopes_value = body.get("requiredDeviceScopes")
    if (
        not isinstance(required_scopes_value, list)
        or len(required_scopes_value) > 32
        or any(
            not isinstance(scope, str) or not _SCOPE_RE.fullmatch(scope)
            for scope in required_scopes_value
        )
        or len(set(required_scopes_value)) != len(required_scopes_value)
    ):
        raise ValueError("required device scopes are invalid")
    timeout_ms = body.get("timeoutMs")
    if (
        isinstance(timeout_ms, bool)
        or not isinstance(timeout_ms, int)
        or timeout_ms < 100
        or timeout_ms > 3_600_000
    ):
        raise ValueError("assignment timeout is invalid")
    read_only = body.get("readOnly")
    may_modify_files = body.get("mayModifyFiles")
    if not isinstance(read_only, bool) or not isinstance(may_modify_files, bool):
        raise ValueError("assignment effect metadata is invalid")
    if read_only and may_modify_files:
        raise ValueError("read-only assignment cannot modify files")

    idempotency_key = body.get("idempotencyKey")
    if not isinstance(idempotency_key, str) or not valid_idempotency_key(
        idempotency_key
    ):
        raise ValueError("assignment idempotency key is invalid")

    return LocalAgentJobAssignment(
        job_id=job_id,
        action=_required_string(body, "action", max_length=128),
        payload=dict(raw_payload),
        principal=_required_identifier(body, "principal"),
        workspace=_required_identifier(body, "workspace"),
        device_id=_required_identifier(body, "deviceId"),
        trace_id=_required_identifier(body, "traceId"),
        request_id=_required_identifier(body, "requestId"),
        idempotency_key=idempotency_key,
        authorization_context=authorization_context,
        expires_at=_parse_timestamp(body.get("expiresAt"), "assignment expiry"),
        timeout_ms=timeout_ms,
        required_device_scopes=tuple(required_scopes_value),
        read_only=read_only,
        may_modify_files=may_modify_files,
        disposition=disposition,
    )


def parse_result_acceptance(
    payload: Mapping[str, Any],
    *,
    job_id: str,
    outcome: str,
) -> LocalAgentResultAcceptance:
    body = _success_body(payload, "LOCAL_AGENT_JOB_RESULT_ACCEPTED")
    if _required_string(body, "protocolVersion", max_length=64) != PROTOCOL_VERSION:
        raise ValueError("protocol version mismatch")
    parsed_job_id = _required_uuid(body, "jobId")
    state = _required_string(body, "state", max_length=32)
    disposition = _required_string(body, "disposition", max_length=32)
    receipt = _required_string(body, "acceptanceReceipt", max_length=256)
    expected_state = "COMPLETED" if outcome == "succeeded" else "FAILED"
    if (
        parsed_job_id != job_id
        or state != expected_state
        or disposition not in {"RESULT_ACCEPTED", "RESULT_REPLAY"}
    ):
        raise ValueError("result acceptance is invalid")
    return LocalAgentResultAcceptance(
        job_id=parsed_job_id,
        state=state,
        disposition=disposition,
        acceptance_receipt=receipt,
    )


def validate_result_request(
    payload: Mapping[str, Any],
    *,
    expected_result_key: Optional[str] = None,
) -> None:
    allowed_keys = {
        "protocolVersion",
        "resultKey",
        "outcome",
        "output",
        "error",
        "metrics",
        "correlation",
    }
    if not isinstance(payload, Mapping) or not set(payload).issubset(allowed_keys):
        raise ValueError("result fields are invalid")
    if payload.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("result protocol version is invalid")
    result_key = payload.get("resultKey")
    if not valid_idempotency_key(result_key):
        raise ValueError("result key is invalid")
    if expected_result_key is not None and result_key != expected_result_key:
        raise ValueError("result key mismatch")
    outcome = payload.get("outcome")
    if outcome not in {"succeeded", "failed"}:
        raise ValueError("result outcome is invalid")
    if outcome == "succeeded":
        if "output" not in payload or "error" in payload:
            raise ValueError("successful result evidence is invalid")
        _validate_json_value(payload["output"], max_encoded_bytes=32 * 1024)
    else:
        if "error" not in payload or "output" in payload:
            raise ValueError("failed result evidence is invalid")
        error = payload["error"]
        if not isinstance(error, Mapping):
            raise ValueError("result error is invalid")
        if not set(error).issubset({"code", "classification", "message", "retryable"}):
            raise ValueError("result error fields are invalid")
        code = error.get("code")
        classification = error.get("classification")
        message = error.get("message")
        retryable = error.get("retryable")
        if not isinstance(code, str) or not _STABLE_CODE_RE.fullmatch(code):
            raise ValueError("result error code is invalid")
        if not isinstance(classification, str) or not re.fullmatch(
            r"[a-z][a-z0-9_-]{0,63}", classification
        ):
            raise ValueError("result error classification is invalid")
        if not isinstance(message, str) or len(message) > 512:
            raise ValueError("result error message is invalid")
        if not isinstance(retryable, bool):
            raise ValueError("result retryability is invalid")
        _validate_json_value(error, max_encoded_bytes=4 * 1024)

    metrics = payload.get("metrics")
    if not isinstance(metrics, Mapping) or set(metrics) != {
        "durationMs",
        "outputTruncated",
    }:
        raise ValueError("result metrics are invalid")
    duration_ms = metrics.get("durationMs")
    if (
        isinstance(duration_ms, bool)
        or not isinstance(duration_ms, int)
        or duration_ms < 0
        or duration_ms > 3_600_000
        or not isinstance(metrics.get("outputTruncated"), bool)
    ):
        raise ValueError("result metrics are invalid")

    correlation = payload.get("correlation")
    if not isinstance(correlation, Mapping) or set(correlation) != {
        "traceId",
        "requestId",
        "deviceId",
    }:
        raise ValueError("result correlation is invalid")
    for key in ("traceId", "requestId", "deviceId"):
        _required_identifier(correlation, key)
    _validate_json_value(payload, max_encoded_bytes=MAX_RESULT_BYTES)


def valid_idempotency_key(value: Any) -> bool:
    return bool(
        isinstance(value, str)
        and value
        and value == value.strip()
        and len(value) <= MAX_IDEMPOTENCY_KEY_LENGTH
        and all(0x21 <= ord(character) <= 0x7E for character in value)
    )


def _success_body(payload: Mapping[str, Any], expected_code: str) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping) or payload.get("ok") is not True:
        raise ValueError("protocol response is not successful")
    if payload.get("code") != expected_code:
        raise ValueError("protocol response code is invalid")
    nested = payload.get("result")
    if nested is None:
        return payload
    if not isinstance(nested, Mapping):
        raise ValueError("protocol response result is invalid")
    merged = dict(nested)
    if "protocolVersion" in payload and "protocolVersion" not in merged:
        merged["protocolVersion"] = payload["protocolVersion"]
    return merged


def _job_path(job_id: str, suffix: str) -> Optional[str]:
    if not _is_uuid(job_id):
        return None
    return f"/gpt-access/local-agent/jobs/{job_id}/{suffix}"


def _bounded_response_json(response: Any) -> Optional[dict[str, Any]]:
    headers = getattr(response, "headers", {})
    content_type = headers.get("Content-Type")
    if (
        not isinstance(content_type, str)
        or content_type.split(";", 1)[0].strip().lower() != "application/json"
    ):
        return None
    content_length = headers.get("Content-Length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_RESPONSE_BYTES:
                return None
        except (TypeError, ValueError):
            return None
    raw_content = getattr(response, "content", None)
    if (
        isinstance(raw_content, (bytes, bytearray))
        and len(raw_content) > MAX_RESPONSE_BYTES
    ):
        return None
    try:
        parsed = response.json()
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    try:
        _validate_json_value(parsed, max_encoded_bytes=MAX_RESPONSE_BYTES)
    except ValueError:
        return None
    return parsed


def _safe_error_code(response: Any) -> str:
    content_length = getattr(response, "headers", {}).get("Content-Length")
    try:
        if content_length is not None and int(content_length) > MAX_RESPONSE_BYTES:
            return "LOCAL_AGENT_REQUEST_FAILED"
    except (TypeError, ValueError):
        return "LOCAL_AGENT_REQUEST_FAILED"
    raw_content = getattr(response, "content", None)
    if (
        isinstance(raw_content, (bytes, bytearray))
        and len(raw_content) > MAX_RESPONSE_BYTES
    ):
        return "LOCAL_AGENT_REQUEST_FAILED"
    try:
        parsed = response.json()
    except (TypeError, ValueError):
        return "LOCAL_AGENT_REQUEST_FAILED"
    if isinstance(parsed, Mapping):
        code = parsed.get("code")
        if isinstance(code, str) and _STABLE_CODE_RE.fullmatch(code):
            return code
        error = parsed.get("error")
        if isinstance(error, Mapping):
            nested = error.get("code")
            if isinstance(nested, str) and _STABLE_CODE_RE.fullmatch(nested):
                return nested
    return "LOCAL_AGENT_REQUEST_FAILED"


def _parse_timestamp(value: Any, field_name: str) -> datetime:
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError(f"{field_name} is invalid")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{field_name} is invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field_name} is invalid")
    return parsed.astimezone(timezone.utc)


def _required_string(
    payload: Mapping[str, Any],
    key: str,
    *,
    max_length: int,
) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise ValueError(f"{key} is invalid")
    return value


def _required_identifier(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not _IDENTIFIER_RE.fullmatch(value):
        raise ValueError(f"{key} is invalid")
    return value


def _required_uuid(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not _is_uuid(value):
        raise ValueError(f"{key} is invalid")
    return value


def _is_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def _contains_reserved_payload_key(
    value: Any,
    *,
    depth: int = 0,
) -> bool:
    if depth > MAX_JSON_DEPTH:
        return True
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", key.lower())
            if normalized in _RESERVED_PAYLOAD_KEYS:
                return True
            if _contains_reserved_payload_key(item, depth=depth + 1):
                return True
    elif isinstance(value, list):
        return any(
            _contains_reserved_payload_key(item, depth=depth + 1) for item in value
        )
    return False


def _validate_json_value(
    value: Any,
    *,
    max_encoded_bytes: int,
    depth: int = 0,
) -> int:
    if depth > MAX_JSON_DEPTH:
        raise ValueError("JSON nesting is too deep")
    if value is None or isinstance(value, (str, bool, int)):
        pass
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON number is non-finite")
    elif isinstance(value, list):
        for item in value:
            _validate_json_value(
                item,
                max_encoded_bytes=max_encoded_bytes,
                depth=depth + 1,
            )
    elif isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 256:
                raise ValueError("JSON object key is invalid")
            _validate_json_value(
                item,
                max_encoded_bytes=max_encoded_bytes,
                depth=depth + 1,
            )
    else:
        raise ValueError("value is not JSON compatible")
    if depth == 0:
        try:
            size = len(
                json.dumps(
                    value,
                    allow_nan=False,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("value is not JSON compatible") from exc
        if size > max_encoded_bytes:
            raise ValueError("JSON value is too large")
        return size
    return 0


def _validation_error(message: str) -> BackendResponse[Any]:
    return BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="LOCAL_AGENT_REQUEST_INVALID",
            message=message,
        ),
    )


def _transport_error(kind: str, message: str) -> BackendResponse[Any]:
    return BackendResponse(
        ok=False,
        error=BackendRequestError(kind=kind, message=message),
    )


__all__ = [
    "LocalAgentAuthorization",
    "LocalAgentClaim",
    "LocalAgentJobAssignment",
    "LocalAgentProtocolClient",
    "LocalAgentResultAcceptance",
    "LocalAgentTerminalReplay",
    "PROTOCOL_VERSION",
    "parse_claim_response",
    "parse_result_acceptance",
    "validate_result_request",
    "valid_idempotency_key",
]
