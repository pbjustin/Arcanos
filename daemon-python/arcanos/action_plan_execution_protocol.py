"""Narrow authenticated client and wire parsing for ActionPlan execution v1."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional

import requests  # type: ignore[import-untyped]

from .backend_auth_client import normalize_backend_url
from .backend_client_models import BackendRequestError, BackendResponse
from .config import Config

PROTOCOL_VERSION = "action-plan-execution-v1"
SNAPSHOT_VERSION = "action-execution-snapshot-v1"
EXECUTOR_KIND = "python-daemon"
MIN_EXECUTOR_TOKEN_LENGTH = 32
MAX_EXECUTOR_TOKEN_LENGTH = 4096
MAX_IDEMPOTENCY_KEY_LENGTH = 256
MAX_RESPONSE_BYTES = 64 * 1024
MAX_ASSIGNMENT_BYTES = 32 * 1024
MAX_JSON_DEPTH = 8

_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_STABLE_CODE_RE = re.compile(r"[A-Z][A-Z0-9_]{2,127}")
_ALLOWED_CAPABILITY_OPERATIONS = {
    "claim-next",
    "claim",
    "start",
    "submit-result",
    "read-status",
    "read-result",
}


@dataclass(frozen=True)
class ExecutionProtocolCapability:
    execution_realm: str
    permitted_operations: tuple[str, ...]
    executor_principal_id: str
    executor_instance_id: str
    assigned_agent_id: str
    protocol_version: str = PROTOCOL_VERSION
    role: str = "executor"


@dataclass(frozen=True)
class ActionPlanExecutionAssignment:
    execution_realm: str
    command_id: str
    plan_id: str
    run_id: str
    action_id: str
    snapshot_id: str
    snapshot_version: str
    capability: str
    action_snapshot: dict[str, Any]
    lifecycle: dict[str, Any]
    policy: dict[str, Any]
    execution_generation: int
    disposition: str
    timeout_ms: Optional[int] = None


@dataclass(frozen=True)
class ActionPlanExecutionStart:
    execution_realm: str
    plan_id: str
    run_id: str
    action_id: str
    state: str
    disposition: str


@dataclass(frozen=True)
class ActionPlanExecutionAcceptance:
    plan_id: str
    run_id: str
    action_id: str
    snapshot_id: str
    state: str
    disposition: str
    acceptance_receipt: str


@dataclass(frozen=True)
class ActionPlanExecutionStatus:
    plan_id: str
    run_id: str
    action_id: str
    snapshot_id: str
    state: str
    execution_realm: str
    acceptance_receipt: Optional[str]


@dataclass(frozen=True)
class ActionPlanExecutionResultRead:
    plan_id: str
    run_id: str
    action_id: str
    snapshot_id: str
    state: str
    execution_realm: str
    acceptance_receipt: str
    result: dict[str, Any]


class ActionPlanExecutionProtocolClient:
    """Purpose-bound HTTP client that can call only Phase 2E executor routes."""

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

    def get_capability(self) -> BackendResponse[dict[str, Any]]:
        return self._request("GET", "/action-plan-executions/protocol", None)

    def claim_next(
        self,
        idempotency_key: str,
    ) -> BackendResponse[Optional[dict[str, Any]]]:
        return self._request(
            "POST",
            "/action-plan-executions/claim-next",
            {},
            idempotency_key=idempotency_key,
            allow_no_content=True,
        )

    def claim(
        self,
        plan_id: str,
        run_id: str,
        idempotency_key: str,
    ) -> BackendResponse[dict[str, Any]]:
        path = _execution_path(plan_id, run_id, "claim")
        if path is None:
            return _validation_error("Execution identity is invalid")
        return self._request(
            "POST",
            path,
            {},
            idempotency_key=idempotency_key,
        )

    def start(
        self,
        plan_id: str,
        run_id: str,
        idempotency_key: str,
    ) -> BackendResponse[dict[str, Any]]:
        path = _execution_path(plan_id, run_id, "start")
        if path is None:
            return _validation_error("Execution identity is invalid")
        return self._request(
            "POST",
            path,
            {},
            idempotency_key=idempotency_key,
        )

    def submit_result(
        self,
        plan_id: str,
        run_id: str,
        result: Mapping[str, Any],
        idempotency_key: str,
    ) -> BackendResponse[dict[str, Any]]:
        path = _execution_path(plan_id, run_id, "result")
        if path is None:
            return _validation_error("Execution identity is invalid")
        try:
            validate_result_request(result)
        except ValueError:
            return _validation_error("Execution result is invalid")
        return self._request(
            "POST",
            path,
            result,
            idempotency_key=idempotency_key,
        )

    def get_status(
        self,
        plan_id: str,
        run_id: str,
    ) -> BackendResponse[dict[str, Any]]:
        path = _execution_path(plan_id, run_id)
        if path is None:
            return _validation_error("Execution identity is invalid")
        return self._request("GET", path, None)

    def get_result(
        self,
        plan_id: str,
        run_id: str,
    ) -> BackendResponse[dict[str, Any]]:
        path = _execution_path(plan_id, run_id, "result")
        if path is None:
            return _validation_error("Execution identity is invalid")
        return self._request("GET", path, None)

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Mapping[str, Any]],
        *,
        idempotency_key: Optional[str] = None,
        allow_no_content: bool = False,
    ) -> BackendResponse[Any]:
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
                    kind="ACTION_PLAN_EXECUTION_AUTH_REQUIRED",
                    message="ActionPlan executor authentication is required",
                ),
            )
        if idempotency_key is not None and not _valid_idempotency_key(idempotency_key):
            return _validation_error("Idempotency key is invalid")

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {credential}",
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
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
            return _transport_error("timeout", "ActionPlan execution request timed out")
        except requests.RequestException:
            return _transport_error("network", "ActionPlan execution request failed")
        except Exception:
            return _transport_error("transport", "ActionPlan execution request failed")

        status_code = getattr(response, "status_code", 0)
        if status_code == 204 and allow_no_content:
            return BackendResponse(ok=True, value=None)
        if status_code < 200 or status_code >= 300:
            code = _safe_error_code(response)
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind=code,
                    message="ActionPlan execution request was rejected",
                    status_code=status_code if isinstance(status_code, int) else None,
                ),
            )

        body = _bounded_response_json(response)
        if body is None:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE",
                    message="ActionPlan execution response is invalid",
                    status_code=status_code,
                ),
            )
        return BackendResponse(ok=True, value=body)


def parse_protocol_capability(
    payload: Mapping[str, Any],
) -> ExecutionProtocolCapability:
    body = _success_body(payload, "ACTION_PLAN_EXECUTION_PROTOCOL_AVAILABLE")
    realm = _required_realm(body, "execution_realm")
    version = _required_string(body, "protocol_version", max_length=64)
    role = _required_string(body, "role", max_length=32)
    operations = body.get("operations")
    if (
        version != PROTOCOL_VERSION
        or role != "executor"
        or not isinstance(operations, list)
        or not operations
        or any(
            not isinstance(item, str) or item not in _ALLOWED_CAPABILITY_OPERATIONS
            for item in operations
        )
        or len(set(operations)) != len(operations)
        or "read-status" not in operations
    ):
        raise ValueError("protocol capability is incompatible")
    return ExecutionProtocolCapability(
        execution_realm=realm,
        permitted_operations=tuple(operations),
        executor_principal_id=_required_identifier(body, "executor_principal_id"),
        executor_instance_id=_required_identifier(body, "executor_instance_id"),
        assigned_agent_id=_required_identifier(body, "assigned_agent_id"),
        protocol_version=version,
        role=role,
    )


def parse_assignment(
    payload: Mapping[str, Any],
    *,
    expected_realm: str,
    now: Optional[datetime] = None,
) -> ActionPlanExecutionAssignment:
    body = _success_body(payload, "ACTION_PLAN_EXECUTION_CLAIMED")
    realm = _required_realm(body, "execution_realm")
    if realm != expected_realm:
        raise ValueError("execution realm mismatch")
    if _required_string(body, "protocol_version", max_length=64) != PROTOCOL_VERSION:
        raise ValueError("protocol version mismatch")
    executor_kind = body.get("executor_kind")
    if executor_kind is not None and executor_kind != EXECUTOR_KIND:
        raise ValueError("executor kind mismatch")

    snapshot = body.get("assignment")
    if not isinstance(snapshot, dict):
        raise ValueError("assignment snapshot is invalid")
    _validate_json_value(snapshot, max_encoded_bytes=MAX_ASSIGNMENT_BYTES)
    capability = _required_string(snapshot, "capability", max_length=128)
    if not isinstance(snapshot.get("params"), dict):
        raise ValueError("assignment parameters are invalid")

    lifecycle = body.get("lifecycle")
    policy = body.get("policy")
    if not isinstance(lifecycle, dict) or not isinstance(policy, dict):
        raise ValueError("assignment authority evidence is invalid")
    _validate_json_value(lifecycle, max_encoded_bytes=4 * 1024)
    _validate_json_value(policy, max_encoded_bytes=4 * 1024)
    if lifecycle.get("status") not in {"approved", "in_progress"}:
        raise ValueError("assignment lifecycle is not executable")
    expires_at = lifecycle.get("expires_at")
    if expires_at is not None:
        expires_at_value = _parse_timestamp(expires_at, "assignment expiry")
        current_time = now or datetime.now(timezone.utc)
        if current_time.tzinfo is None:
            raise ValueError("assignment clock is invalid")
        if expires_at_value <= current_time.astimezone(timezone.utc):
            raise ValueError("assignment is expired")
    if policy.get("category") not in {"ALLOW", "CONFIRM"}:
        raise ValueError("assignment policy is not executable")
    _required_identifier(policy, "evidence_id")
    _parse_timestamp(policy.get("evaluated_at"), "policy evaluation timestamp")

    generation = body.get("plan_execution_generation")
    if (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
    ):
        raise ValueError("execution generation is invalid")
    timeout_ms = snapshot.get("timeout_ms")
    if timeout_ms is not None and (
        isinstance(timeout_ms, bool)
        or not isinstance(timeout_ms, int)
        or timeout_ms < 1
        or timeout_ms > 86_400_000
    ):
        raise ValueError("execution timeout is invalid")
    disposition = _required_string(body, "disposition", max_length=64)
    if disposition not in {"CLAIMED", "CLAIM_REPLAY_NOT_STARTED"}:
        raise ValueError("claim disposition is not executable")
    if body.get("state") != "CLAIMED":
        raise ValueError("claimed assignment state is invalid")

    assignment = ActionPlanExecutionAssignment(
        execution_realm=realm,
        command_id=_required_identifier(body, "command_id"),
        plan_id=_required_identifier(body, "plan_id"),
        run_id=_required_identifier(body, "run_id"),
        action_id=_required_identifier(body, "action_id"),
        snapshot_id=_required_identifier(body, "snapshot_id"),
        snapshot_version=_required_snapshot_version(body),
        capability=capability,
        action_snapshot=dict(snapshot),
        lifecycle=dict(lifecycle),
        policy=dict(policy),
        execution_generation=generation,
        disposition=disposition,
        timeout_ms=timeout_ms,
    )
    return assignment


def parse_start(
    payload: Mapping[str, Any],
    *,
    plan_id: str,
    run_id: str,
    action_id: str,
    expected_realm: str,
) -> ActionPlanExecutionStart:
    body = _success_body(payload, "ACTION_PLAN_EXECUTION_STARTED")
    _require_protocol_version(body)
    realm = _required_realm(body, "execution_realm")
    parsed_plan_id = _required_identifier(body, "plan_id")
    parsed_run_id = _required_identifier(body, "run_id")
    parsed_action_id = _required_identifier(body, "action_id")
    state = _required_string(body, "state", max_length=32)
    disposition = _required_string(body, "disposition", max_length=64)
    if (
        realm != expected_realm
        or parsed_plan_id != plan_id
        or parsed_run_id != run_id
        or parsed_action_id != action_id
        or state != "RUNNING"
        or disposition not in {"STARTED", "START_REPLAY"}
    ):
        raise ValueError("start response is not executable")
    return ActionPlanExecutionStart(
        realm,
        parsed_plan_id,
        parsed_run_id,
        parsed_action_id,
        state,
        disposition,
    )


def parse_acceptance(
    payload: Mapping[str, Any],
    *,
    plan_id: str,
    run_id: str,
    action_id: str,
    snapshot_id: str,
    expected_outcome: str,
    expected_realm: str,
) -> ActionPlanExecutionAcceptance:
    body = _success_body(payload, "ACTION_PLAN_EXECUTION_RESULT_ACCEPTED")
    _require_protocol_version(body)
    parsed_plan_id = _required_identifier(body, "plan_id")
    parsed_run_id = _required_identifier(body, "run_id")
    parsed_action_id = _required_identifier(body, "action_id")
    parsed_snapshot_id = _required_identifier(body, "snapshot_id")
    realm = _required_realm(body, "execution_realm")
    state = _required_string(body, "state", max_length=32)
    disposition = _required_string(body, "disposition", max_length=64)
    receipt = _required_string(body, "acceptance_receipt", max_length=256)
    expected_state = "SUCCEEDED" if expected_outcome == "succeeded" else "FAILED"
    terminal_category = body.get("terminal_category")
    if (
        parsed_plan_id != plan_id
        or parsed_run_id != run_id
        or parsed_action_id != action_id
        or parsed_snapshot_id != snapshot_id
        or realm != expected_realm
        or state != expected_state
        or terminal_category != expected_outcome
        or disposition not in {"RESULT_ACCEPTED", "RESULT_REPLAY"}
    ):
        raise ValueError("result was not durably accepted")
    return ActionPlanExecutionAcceptance(
        parsed_plan_id,
        parsed_run_id,
        parsed_action_id,
        parsed_snapshot_id,
        state,
        disposition,
        receipt,
    )


def parse_status(
    payload: Mapping[str, Any],
    *,
    plan_id: str,
    run_id: str,
    action_id: str,
    snapshot_id: str,
    expected_realm: str,
) -> ActionPlanExecutionStatus:
    body = _success_body(payload, "ACTION_PLAN_EXECUTION_STATUS")
    _require_protocol_version(body)
    parsed_plan_id = _required_identifier(body, "plan_id")
    parsed_run_id = _required_identifier(body, "run_id")
    parsed_action_id = _required_identifier(body, "action_id")
    parsed_snapshot_id = _required_identifier(body, "snapshot_id")
    realm = _required_realm(body, "execution_realm")
    state = _required_string(body, "state", max_length=32)
    receipt = body.get("acceptance_receipt")
    if receipt is not None and (not isinstance(receipt, str) or len(receipt) > 256):
        raise ValueError("status receipt is invalid")
    if (
        parsed_plan_id != plan_id
        or parsed_run_id != run_id
        or parsed_action_id != action_id
        or parsed_snapshot_id != snapshot_id
        or realm != expected_realm
    ):
        raise ValueError("execution status identity mismatch")
    if state not in {
        "REQUESTED",
        "CLAIMED",
        "RUNNING",
        "SUCCEEDED",
        "FAILED",
        "CANCELLED",
        "EXPIRED",
        "SUPERSEDED",
    }:
        raise ValueError("execution status is invalid")
    return ActionPlanExecutionStatus(
        parsed_plan_id,
        parsed_run_id,
        parsed_action_id,
        parsed_snapshot_id,
        state,
        realm,
        receipt,
    )


def parse_result_read(
    payload: Mapping[str, Any],
    *,
    plan_id: str,
    run_id: str,
    action_id: str,
    snapshot_id: str,
    expected_realm: str,
) -> ActionPlanExecutionResultRead:
    body = _success_body(payload, "ACTION_PLAN_EXECUTION_RESULT")
    _require_protocol_version(body)
    parsed_plan_id = _required_identifier(body, "plan_id")
    parsed_run_id = _required_identifier(body, "run_id")
    parsed_action_id = _required_identifier(body, "action_id")
    parsed_snapshot_id = _required_identifier(body, "snapshot_id")
    realm = _required_realm(body, "execution_realm")
    state = _required_string(body, "state", max_length=32)
    outcome = _required_string(body, "outcome", max_length=32)
    receipt = _required_string(body, "acceptance_receipt", max_length=256)
    terminal_category = body.get("terminal_category")
    if (
        parsed_plan_id != plan_id
        or parsed_run_id != run_id
        or parsed_action_id != action_id
        or parsed_snapshot_id != snapshot_id
        or realm != expected_realm
        or (state, outcome, terminal_category)
        not in {
            ("SUCCEEDED", "succeeded", "succeeded"),
            ("FAILED", "failed", "failed"),
        }
    ):
        raise ValueError("result evidence identity is invalid")
    result: dict[str, Any] = {
        "action_id": parsed_action_id,
        "snapshot_id": parsed_snapshot_id,
        "outcome": outcome,
    }
    if "output" in body:
        result["output"] = body["output"]
    if "error" in body:
        result["error"] = body["error"]
    validate_result_request(result)
    return ActionPlanExecutionResultRead(
        parsed_plan_id,
        parsed_run_id,
        parsed_action_id,
        parsed_snapshot_id,
        state,
        realm,
        receipt,
        result,
    )


def validate_result_request(payload: Mapping[str, Any]) -> None:
    if not isinstance(payload, Mapping):
        raise ValueError("result is invalid")
    keys = set(payload)
    if not {"action_id", "snapshot_id", "outcome"}.issubset(keys) or not keys.issubset(
        {"action_id", "snapshot_id", "outcome", "output", "error"}
    ):
        raise ValueError("result fields are invalid")
    _required_identifier(payload, "action_id")
    _required_identifier(payload, "snapshot_id")
    outcome = payload.get("outcome")
    if outcome not in {"succeeded", "failed"}:
        raise ValueError("result outcome is invalid")
    if outcome == "succeeded" and "error" in payload:
        raise ValueError("successful result cannot contain error evidence")
    if outcome == "failed" and "output" in payload:
        raise ValueError("failed result cannot contain success output")
    if "output" in payload:
        _validate_json_value(payload["output"], max_encoded_bytes=32 * 1024)
    if "error" in payload:
        error = payload["error"]
        if not isinstance(error, Mapping) or not set(error).issubset(
            {"code", "category"}
        ):
            raise ValueError("result error is invalid")
        for key in ("code", "category"):
            value = error.get(key)
            if value is not None and (
                not isinstance(value, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}", value)
            ):
                raise ValueError("result error field is invalid")
        _validate_json_value(error, max_encoded_bytes=4 * 1024)
    _validate_json_value(payload, max_encoded_bytes=64 * 1024)


def _success_body(payload: Mapping[str, Any], expected_code: str) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping) or payload.get("ok") is not True:
        raise ValueError("protocol response is not successful")
    code = payload.get("code")
    if code != expected_code:
        raise ValueError("protocol response code is invalid")
    nested = payload.get("result")
    if nested is None:
        return payload
    if not isinstance(nested, Mapping):
        raise ValueError("protocol response result is invalid")
    merged = dict(nested)
    merged["ok"] = True
    merged["code"] = code
    if "protocol_version" in payload:
        merged["protocol_version"] = payload["protocol_version"]
    return merged


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
            return "ACTION_PLAN_EXECUTION_REQUEST_FAILED"
    except (TypeError, ValueError):
        return "ACTION_PLAN_EXECUTION_REQUEST_FAILED"
    raw_content = getattr(response, "content", None)
    if (
        isinstance(raw_content, (bytes, bytearray))
        and len(raw_content) > MAX_RESPONSE_BYTES
    ):
        return "ACTION_PLAN_EXECUTION_REQUEST_FAILED"
    try:
        parsed = response.json()
    except (TypeError, ValueError):
        return "ACTION_PLAN_EXECUTION_REQUEST_FAILED"
    if isinstance(parsed, Mapping):
        code = parsed.get("code")
        if isinstance(code, str) and _STABLE_CODE_RE.fullmatch(code):
            return code
        error = parsed.get("error")
        if isinstance(error, Mapping):
            nested_code = error.get("code")
            if isinstance(nested_code, str) and _STABLE_CODE_RE.fullmatch(nested_code):
                return nested_code
    return "ACTION_PLAN_EXECUTION_REQUEST_FAILED"


def _required_snapshot_version(payload: Mapping[str, Any]) -> str:
    value = _required_string(payload, "snapshot_version", max_length=64)
    if value != SNAPSHOT_VERSION:
        raise ValueError("assignment snapshot version is incompatible")
    return value


def _parse_timestamp(value: Any, field_name: str) -> datetime:
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError(f"{field_name} is invalid")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"{field_name} is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field_name} is invalid")
    return parsed.astimezone(timezone.utc)


def _validate_json_value(
    value: Any,
    *,
    max_encoded_bytes: int,
    depth: int = 0,
) -> int:
    if depth > MAX_JSON_DEPTH:
        raise ValueError("JSON nesting is too deep")
    if value is None or isinstance(value, (str, bool)):
        size = len(str(value).encode("utf-8"))
    elif isinstance(value, int):
        size = len(str(value))
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("JSON number is non-finite")
        size = len(repr(value))
    elif isinstance(value, list):
        size = 2 + sum(
            _validate_json_value(
                item,
                max_encoded_bytes=max_encoded_bytes,
                depth=depth + 1,
            )
            + 1
            for item in value
        )
    elif isinstance(value, Mapping):
        size = 2
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("JSON object key is invalid")
            size += len(key.encode("utf-8")) + 3
            size += _validate_json_value(
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


def _required_realm(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value
    ):
        raise ValueError(f"{key} is invalid")
    return value


def _require_protocol_version(payload: Mapping[str, Any]) -> None:
    if _required_string(payload, "protocol_version", max_length=64) != PROTOCOL_VERSION:
        raise ValueError("protocol version mismatch")


def _execution_path(
    plan_id: str,
    run_id: str,
    suffix: Optional[str] = None,
) -> Optional[str]:
    if not _IDENTIFIER_RE.fullmatch(plan_id) or not _IDENTIFIER_RE.fullmatch(run_id):
        return None
    path = f"/plans/{plan_id}/executions/{run_id}"
    return f"{path}/{suffix}" if suffix else path


def _valid_idempotency_key(value: Any) -> bool:
    return bool(
        isinstance(value, str)
        and value
        and value == value.strip()
        and len(value) <= MAX_IDEMPOTENCY_KEY_LENGTH
        and all(0x21 <= ord(character) <= 0x7E for character in value)
    )


def _validation_error(message: str) -> BackendResponse[Any]:
    return BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="ACTION_PLAN_EXECUTION_REQUEST_INVALID",
            message=message,
        ),
    )


def _transport_error(kind: str, message: str) -> BackendResponse[Any]:
    return BackendResponse(
        ok=False,
        error=BackendRequestError(kind=kind, message=message),
    )


__all__ = [
    "ActionPlanExecutionAcceptance",
    "ActionPlanExecutionAssignment",
    "ActionPlanExecutionProtocolClient",
    "ActionPlanExecutionStart",
    "ActionPlanExecutionStatus",
    "ExecutionProtocolCapability",
    "EXECUTOR_KIND",
    "PROTOCOL_VERSION",
    "parse_acceptance",
    "parse_assignment",
    "parse_protocol_capability",
    "parse_start",
    "parse_status",
    "validate_result_request",
]
