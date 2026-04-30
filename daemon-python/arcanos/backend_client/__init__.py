"""
Backend API client for ARCANOS daemon.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Sequence

import requests

from ..backend_auth_client import normalize_backend_url
from .chat import request_ask_with_domain as _request_ask_with_domain
from .chat import request_chat_completion as _request_chat_completion
from .chat import request_gpt_job_result as _request_gpt_job_result
from .chat import request_gpt_job_status as _request_gpt_job_status
from .chat import request_job_result as _request_job_result
from .chat import request_job_status as _request_job_status
from .chat import request_query as _request_query
from .chat import request_query_and_wait as _request_query_and_wait
from .chat import request_system_state as _request_system_state
from .daemon import request_confirm_daemon_actions as _request_confirm_daemon_actions
from .plans import fetch_plan as _fetch_plan
from .plans import approve_plan as _approve_plan
from .plans import submit_execution_result as _submit_execution_result
from .plans import block_plan as _block_plan
from .registry import request_registry as _request_registry
from .transcribe import request_transcription as _request_transcription
from .updates import submit_update_event as _submit_update_event
from .vision import request_vision_analysis as _request_vision_analysis
from ..backend_client_models import (
    BackendChatResult,
    BackendGptAsyncBridgeResult,
    BackendRequestError,
    BackendResponse,
    BackendTranscriptionResult,
    BackendVisionResult,
)
from ..config import Config
from arcanos.debug import log_audit_event


@dataclass(frozen=True)
class BackendRequestContext:
    """
    Purpose: Carry resolved outbound request data plus auth diagnostics.
    Inputs/Outputs: stores the normalized URL, headers, payload, and auth state for one request.
    Edge cases: cookie auth stays false because the daemon transport is header-based only.
    """

    original_path: str
    resolved_path: str
    url: str
    headers: dict[str, str]
    payload: Optional[Mapping[str, Any]]
    request_gpt_id: Optional[str]
    effective_gpt_id: Optional[str]
    has_authorization: bool
    has_x_gpt_id: bool
    has_cookie: bool = False

    @property
    def auth_mode(self) -> str:
        if self.has_authorization:
            return "bearer"
        if self.has_x_gpt_id:
            return "gpt-id"
        return "anonymous"


class BackendApiClient:
    """
    Purpose: Provide typed access to ARCANOS backend endpoints.
    Inputs/Outputs: Uses token provider and request sender to call backend APIs.
    Edge cases: Missing base URL or token returns structured auth/config errors.
    """

    def __init__(
        self,
        base_url: str,
        token_provider: Callable[[], Optional[str]],
        timeout_seconds: int = 15,
        request_sender: Callable[..., requests.Response] = requests.request
    ) -> None:
        """
        Purpose: Initialize backend API client.
        Inputs/Outputs: base_url, token_provider, timeout_seconds, request_sender; stores config.
        Edge cases: Empty base_url disables requests and returns config errors.
        """
        self._base_url = normalize_backend_url(base_url, allow_http_dev=Config.BACKEND_ALLOW_HTTP)
        self._token_provider = token_provider
        self._timeout_seconds = timeout_seconds
        self._request_sender = request_sender

    @staticmethod
    def _normalize_metadata(metadata: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
        """
        Purpose: Normalize optional metadata mapping into a dict.
        Inputs/Outputs: metadata mapping or None; returns dict or None.
        Edge cases: returns None when metadata is falsy.
        """
        if not metadata:
            return None
        return dict(metadata)

    @staticmethod
    def _extract_tokens_used(response_json: Mapping[str, Any]) -> int:
        """
        Purpose: Extract token usage count from backend response payload.
        Inputs/Outputs: response JSON mapping; returns token count integer.
        Edge cases: defaults to zero when tokens cannot be determined.
        """
        tokens = response_json.get("tokens")
        if isinstance(tokens, int):
            return tokens

        meta = response_json.get("meta", {})
        if isinstance(meta, dict):
            tokens_obj = meta.get("tokens", {})
            if isinstance(tokens_obj, dict):
                tokens = tokens_obj.get("total_tokens", 0)

        if not isinstance(tokens, int):
            return 0

        return tokens

    @staticmethod
    def _normalize_request_path(path: str) -> str:
        """
        Purpose: Normalize caller-provided request paths into canonical absolute route strings.
        Inputs/Outputs: raw path string; returns leading-slash path.
        Edge cases: blank paths remain blank so downstream validation can fail deterministically.
        """
        normalized_path = path.strip()
        if normalized_path and not normalized_path.startswith("/"):
            return f"/{normalized_path}"
        return normalized_path

    @classmethod
    def _extract_request_gpt_id(
        cls,
        path: str,
        payload: Optional[Mapping[str, Any]],
    ) -> Optional[str]:
        """
        Purpose: Resolve the GPT identity implied by a backend request path or payload.
        Inputs/Outputs: HTTP path plus optional JSON payload; returns normalized GPT id or None.
        Edge cases: ignores blank ids and prefers `/gpt/:gptId` path binding over payload metadata to avoid route/header drift.
        """
        normalized_path = cls._normalize_request_path(path)
        gpt_path_prefix = "/gpt/"
        if normalized_path.startswith(gpt_path_prefix):
            route_gpt_id = normalized_path[len(gpt_path_prefix):].strip().strip("/")
            if route_gpt_id:
                return route_gpt_id

        payload_gpt_id = payload.get("gptId") if isinstance(payload, Mapping) else None
        if isinstance(payload_gpt_id, str):
            normalized_gpt_id = payload_gpt_id.strip()
            if normalized_gpt_id:
                return normalized_gpt_id

        return None

    @classmethod
    def _resolve_outbound_path(
        cls,
        path: str,
    ) -> str:
        """
        Purpose: Resolve the final outbound path for chat-style backend requests.
        Inputs/Outputs: caller path; returns normalized outbound path.
        Edge cases: callers must already provide canonical routes when targeting GPT endpoints.
        """
        return cls._normalize_request_path(path)

    @classmethod
    def _prepare_outbound_payload(
        cls,
        resolved_path: str,
        payload: Optional[Mapping[str, Any]],
    ) -> Optional[Mapping[str, Any]]:
        """
        Purpose: Remove transport-only routing fields from payloads before send.
        Inputs/Outputs: resolved path and original payload; returns payload mapping safe for outbound transport.
        Edge cases: GPT-routed requests drop body `gptId` to keep path-based routing authoritative.
        """
        if payload is None:
            return None
        if not isinstance(payload, Mapping):
            return payload

        if resolved_path.startswith("/gpt/") and "gptId" in payload:
            sanitized_payload = dict(payload)
            sanitized_payload.pop("gptId", None)
            return sanitized_payload
        return payload

    @staticmethod
    def _extract_response_module(response_json: Any) -> Optional[str]:
        """
        Purpose: Extract the backend module identifier from a response envelope for routing diagnostics.
        Inputs/Outputs: parsed backend response payload; returns module/model name when available.
        Edge cases: falls back across `_route.module`, `model`, and nested result metadata to support both legacy and canonical response envelopes.
        """
        if not isinstance(response_json, Mapping):
            return None

        route_meta = response_json.get("_route")
        if isinstance(route_meta, Mapping):
            route_module = route_meta.get("module")
            if isinstance(route_module, str) and route_module.strip():
                return route_module.strip()

        for field_name in ("model", "activeModel", "module"):
            value = response_json.get(field_name)
            if isinstance(value, str) and value.strip():
                return value.strip()

        result_payload = response_json.get("result")
        if isinstance(result_payload, Mapping):
            result_module = result_payload.get("module")
            if isinstance(result_module, str) and result_module.strip():
                return result_module.strip()

        return None

    def _build_request_context(
        self,
        method: str,
        path: str,
        payload: Optional[Mapping[str, Any]],
    ) -> BackendRequestContext:
        """
        Purpose: Resolve routing, auth headers, and diagnostics for one backend request.
        Inputs/Outputs: method/path/payload -> immutable request context used by raw and JSON helpers.
        Edge cases: GPT-id auth is allowed when configured and either the request or daemon config provides the GPT identity.
        """
        if not self._base_url:
            raise BackendRequestError(kind="configuration", message="Backend URL is not configured")

        normalized_path = self._normalize_request_path(path)
        request_gpt_id = self._extract_request_gpt_id(normalized_path, payload)
        auth_value = self._token_provider()
        backend_gpt_id = (getattr(Config, "BACKEND_GPT_ID", "") or "").strip() or None
        allow_gpt_id_auth = bool(getattr(Config, "BACKEND_ALLOW_GPT_ID_AUTH", False))
        effective_gpt_id = request_gpt_id or backend_gpt_id

        if not auth_value and not (allow_gpt_id_auth and effective_gpt_id):
            log_audit_event(
                "auth_failure",
                source="backend_client",
                reason="token_missing",
                path=normalized_path,
                method=method,
                gpt_id=request_gpt_id,
                effective_gpt_id=effective_gpt_id,
                gpt_id_auth_enabled=allow_gpt_id_auth,
                has_backend_gpt_id=bool(backend_gpt_id),
            )
            raise BackendRequestError(kind="auth", message="Backend token is missing")

        resolved_path = self._resolve_outbound_path(normalized_path)
        outbound_payload = self._prepare_outbound_payload(resolved_path, payload)
        headers = {"Content-Type": "application/json"}

        if auth_value:
            headers["Authorization"] = f"Bearer {auth_value}"
        if allow_gpt_id_auth and effective_gpt_id:
            headers["x-gpt-id"] = effective_gpt_id

        return BackendRequestContext(
            original_path=normalized_path,
            resolved_path=resolved_path,
            url=f"{self._base_url}{resolved_path}",
            headers=headers,
            payload=outbound_payload,
            request_gpt_id=request_gpt_id,
            effective_gpt_id=effective_gpt_id,
            has_authorization=bool(auth_value),
            has_x_gpt_id="x-gpt-id" in headers,
        )

    def _log_backend_route_request(
        self,
        *,
        method: str,
        url: str,
        resolved_endpoint: str,
        gpt_id: Optional[str],
    ) -> None:
        """
        Purpose: Emit deterministic routing telemetry before a backend request is sent.
        Inputs/Outputs: request method, full URL, resolved endpoint, and normalized GPT id; writes audit logs only.
        Edge cases: `gpt_id` may be None when callers omitted routing hints and the configured daemon GPT id was used.
        """
        log_audit_event(
            "backend_route_request",
            method=method,
            full_request_url=url,
            resolved_endpoint=resolved_endpoint,
            gpt_id=gpt_id,
        )

    def _log_backend_route_response(
        self,
        *,
        method: str,
        url: str,
        resolved_endpoint: str,
        gpt_id: Optional[str],
        status_code: int,
        response_json: Optional[Mapping[str, Any]] = None,
        error_kind: Optional[str] = None,
    ) -> None:
        """
        Purpose: Emit deterministic routing telemetry after a backend response is received or classified.
        Inputs/Outputs: request metadata plus status/result details; writes audit logs only.
        Edge cases: non-JSON responses log a null response module so callers can still correlate failures with the request path.
        """
        log_audit_event(
            "backend_route_response",
            method=method,
            full_request_url=url,
            resolved_endpoint=resolved_endpoint,
            gpt_id=gpt_id,
            status_code=status_code,
            response_module=self._extract_response_module(response_json),
            error_kind=error_kind,
        )

    def _log_outbound_request(self, method: str, context: BackendRequestContext) -> None:
        """
        Purpose: Emit a request audit event that makes auth state and final URL visible.
        Inputs/Outputs: method plus request context; writes one structured audit event.
        Edge cases: logs auth booleans instead of secret values.
        """
        log_audit_event(
            "backend_request_outbound",
            source="backend_client",
            method=method,
            original_path=context.original_path,
            resolved_path=context.resolved_path,
            url=context.url,
            gpt_id=context.request_gpt_id,
            effective_gpt_id=context.effective_gpt_id,
            auth_mode=context.auth_mode,
            authenticated=context.has_authorization or context.has_x_gpt_id,
            has_authorization=context.has_authorization,
            has_cookie=context.has_cookie,
            has_x_gpt_id=context.has_x_gpt_id,
        )
        self._log_backend_route_request(
            method=method,
            url=context.url,
            resolved_endpoint=context.resolved_path,
            gpt_id=context.request_gpt_id,
        )

    def _log_request_response(
        self,
        method: str,
        context: BackendRequestContext,
        status_code: int,
        error_kind: Optional[str] = None,
        response_json: Optional[Mapping[str, Any]] = None,
    ) -> None:
        """
        Purpose: Emit a response audit event for success and failure paths.
        Inputs/Outputs: method/context/status/error kind; writes one structured audit event.
        Edge cases: status code zero denotes timeout or network failures before an HTTP response arrived.
        """
        log_audit_event(
            "backend_request_response",
            source="backend_client",
            method=method,
            original_path=context.original_path,
            resolved_path=context.resolved_path,
            url=context.url,
            gpt_id=context.request_gpt_id,
            effective_gpt_id=context.effective_gpt_id,
            status_code=status_code,
            error_kind=error_kind,
            auth_mode=context.auth_mode,
            authenticated=context.has_authorization or context.has_x_gpt_id,
            has_authorization=context.has_authorization,
            has_cookie=context.has_cookie,
            has_x_gpt_id=context.has_x_gpt_id,
        )
        self._log_backend_route_response(
            method=method,
            url=context.url,
            resolved_endpoint=context.resolved_path,
            gpt_id=context.request_gpt_id,
            status_code=status_code,
            response_json=response_json,
            error_kind=error_kind,
        )

    def _build_logged_error_response(
        self,
        method: str,
        context: BackendRequestContext,
        error: BackendRequestError,
        status_code: int = 0,
        error_kind: Optional[str] = None,
        response_json: Optional[Mapping[str, Any]] = None,
    ) -> BackendResponse[dict[str, Any]]:
        """
        Purpose: Centralize JSON error response creation for backend request failures.
        Inputs/Outputs: request context plus BackendRequestError -> BackendResponse error payload.
        Edge cases: defaults to status 0 for transport failures that never produced an HTTP response.
        """
        self._log_request_response(
            method,
            context,
            status_code=status_code,
            error_kind=error_kind or error.kind,
            response_json=response_json,
        )
        return BackendResponse(ok=False, error=error)


    def _make_request(
            self,
            method: str,
            path: str,
            json: Optional[Mapping[str, Any]] = None
        ) -> requests.Response:
            """
            Purpose: Perform a raw backend request and return the Response.
            Inputs/Outputs: method, path, optional json payload; returns requests.Response.
            Edge cases: Raises BackendRequestError for missing config, auth, or network failures.
            """
            context = self._build_request_context(method, path, json)
            self._log_outbound_request(method, context)

            try:
                response = self._request_sender(
                    method,
                    context.url,
                    headers=context.headers,
                    json=context.payload,
                    timeout=self._timeout_seconds
                )
                self._log_request_response(method, context, status_code=response.status_code)
                return response
            except requests.Timeout as exc:
                self._log_request_response(method, context, status_code=0, error_kind="timeout")
                raise BackendRequestError(kind="timeout", message="Backend request timed out", details=str(exc))
            except requests.RequestException as exc:
                self._log_request_response(method, context, status_code=0, error_kind="network")
                raise BackendRequestError(kind="network", message="Backend request failed", details=str(exc))

    def make_raw_request(self, method: str, path: str, json: Optional[Mapping[str, Any]] = None) -> requests.Response:
        """
        Purpose: Public wrapper to perform a raw backend request and return the underlying requests.Response.
        Inputs/Outputs: method, path, optional json payload; returns requests.Response or raises BackendRequestError.
        Edge cases: Mirrors behavior of _make_request but exposes a sanctioned public API to avoid private access.
        """
        return self._make_request(method, path, json)

    def request_ask_with_domain(
        self,
        message: str,
        domain: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[BackendChatResult]:
        return _request_ask_with_domain(self, message, domain, metadata, gpt_id)

    def request_chat_completion(
        self,
        messages: Sequence[Mapping[str, str]],
        temperature: Optional[float] = None,
        model: Optional[str] = None,
        stream: bool = False,
        metadata: Optional[Mapping[str, Any]] = None,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[BackendChatResult]:
        return _request_chat_completion(self, messages, temperature, model, stream, metadata, gpt_id)

    def request_system_state(
        self,
        metadata: Optional[Mapping[str, Any]] = None,
        expected_version: Optional[int] = None,
        patch: Optional[Mapping[str, Any]] = None,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[dict[str, Any]]:
        """
        Purpose: Request backend system state through the canonical daemon GPT route.
        Inputs/Outputs: optional metadata and optimistic-lock patch fields; returns raw state payload.
        Edge cases: returns structured validation errors for partial update payloads.
        """
        return _request_system_state(self, metadata, expected_version, patch, gpt_id)

    def request_query(
        self,
        prompt: str,
        metadata: Optional[Mapping[str, Any]] = None,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[BackendGptAsyncBridgeResult]:
        """
        Purpose: Create one async GPT writing job through the canonical `query` bridge action.
        Inputs/Outputs: prompt plus optional metadata/gpt_id; returns typed async bridge metadata.
        Edge cases: blank prompts fail fast as validation errors.
        """
        return _request_query(self, prompt, metadata, gpt_id)

    def request_query_and_wait(
        self,
        prompt: str,
        timeout_ms: Optional[int] = None,
        poll_interval_ms: Optional[int] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[BackendGptAsyncBridgeResult]:
        """
        Purpose: Create one async GPT writing job and wait briefly through the canonical `query_and_wait` bridge action.
        Inputs/Outputs: prompt plus optional wait controls/metadata/gpt_id; returns typed async bridge metadata.
        Edge cases: blank prompts fail fast as validation errors.
        """
        return _request_query_and_wait(
            self,
            prompt,
            timeout_ms,
            poll_interval_ms,
            metadata,
            gpt_id,
        )

    def request_gpt_job_status(
        self,
        job_id: str,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[BackendGptAsyncBridgeResult]:
        """
        Purpose: Read async job status through the canonical jobs API without enqueueing new work.
        Inputs/Outputs: required job_id and optional gpt_id; returns typed async bridge status metadata.
        Edge cases: blank ids fail fast as validation errors.
        """
        return _request_gpt_job_status(self, job_id, gpt_id)

    def request_gpt_job_result(
        self,
        job_id: str,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[BackendGptAsyncBridgeResult]:
        """
        Purpose: Read async job results through the canonical jobs API without enqueueing new work.
        Inputs/Outputs: required job_id and optional gpt_id; returns typed async bridge result metadata.
        Edge cases: blank ids fail fast as validation errors.
        """
        return _request_gpt_job_result(self, job_id, gpt_id)

    def request_job_result(
        self,
        job_id: str,
        gpt_id: Optional[str] = None,
    ) -> BackendResponse[dict[str, Any]]:
        """
        Purpose: Fetch one stored async GPT job result through the canonical jobs API.
        Inputs/Outputs: required job_id; returns raw job-result payload.
        Edge cases: blank ids fail fast as validation errors.
        """
        return _request_job_result(self, job_id, gpt_id)

    def request_job_status(
        self,
        job_id: str,
    ) -> BackendResponse[dict[str, Any]]:
        """
        Purpose: Fetch async GPT job status through the canonical jobs API.
        Inputs/Outputs: required job_id; returns raw job-status payload.
        Edge cases: blank ids fail fast as validation errors.
        """
        return _request_job_status(self, job_id)

    def request_vision_analysis(
        self,
        image_base64: Optional[str] = None,
        imageBase64: Optional[str] = None,
        prompt: Optional[str] = None,
        temperature: Optional[float] = None,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[BackendVisionResult]:
        """
        Purpose: Call backend /api/vision with base64 image data.
        Inputs/Outputs: image_base64 (snake) or imageBase64 (camel), optional prompt/temperature/model/max_tokens; returns BackendVisionResult.
        Edge cases: Returns validation error when both image_base64 and imageBase64 are missing.
        """
        resolved_image = image_base64 or imageBase64
        if not resolved_image:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="validation", message="imageBase64 is required")
            )
        return _request_vision_analysis(self, resolved_image, prompt, temperature, model, max_tokens, metadata)

    def request_transcription(
        self,
        audio_base64: Optional[str] = None,
        audioBase64: Optional[str] = None,
        filename: Optional[str] = None,
        model: Optional[str] = None,
        language: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[BackendTranscriptionResult]:
        """
        Purpose: Call backend /api/transcribe with base64 audio data.
        Inputs/Outputs: audio_base64 (snake) or audioBase64 (camel), optional filename/model/language; returns BackendTranscriptionResult.
        Edge cases: Returns validation error when both audio_base64 and audioBase64 are missing.
        """
        resolved_audio = audio_base64 or audioBase64
        if not resolved_audio:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="validation", message="audioBase64 is required")
            )
        return _request_transcription(self, resolved_audio, filename, model, language, metadata)

    def submit_update_event(
        self,
        update_type: Optional[str] = None,
        data: Optional[Mapping[str, Any]] = None,
        updateType: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[bool]:
        """
        Purpose: Call backend /api/update to record update event.
        Inputs/Outputs: update_type (snake) or updateType (camel), data mapping; returns bool from 'success' response field.
        Edge cases: Returns validation error when update type or data is missing.
        """
        resolved_update_type = update_type or updateType
        if not resolved_update_type or data is None:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="validation", message="updateType and data are required")
            )
        return _submit_update_event(self, resolved_update_type, data, metadata)

    def _request_json(
        self,
        method: str,
        path: str,
        payload: Optional[Mapping[str, Any]]
    ) -> BackendResponse[dict[str, Any]]:
        try:
            context = self._build_request_context(method, path, payload)
        except BackendRequestError as error:
            return BackendResponse(ok=False, error=error)

        self._log_outbound_request(method, context)

        try:
            response = self._request_sender(
                method,
                context.url,
                headers=context.headers,
                json=context.payload,
                timeout=self._timeout_seconds
            )
        except requests.Timeout as exc:
            return self._build_logged_error_response(
                method,
                context,
                BackendRequestError(kind="timeout", message="Backend request timed out", details=str(exc)),
                error_kind="timeout",
            )
        except requests.RequestException as exc:
            return self._build_logged_error_response(
                method,
                context,
                BackendRequestError(kind="network", message="Backend request failed", details=str(exc)),
                error_kind="network",
            )

        if response.status_code == 401:
            self._log_request_response(method, context, status_code=response.status_code, error_kind="auth")
            log_audit_event(
                "auth_failure",
                source="backend_client",
                reason="401_unauthorized",
                path=context.original_path,
                method=method,
                status_code=response.status_code
            )
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="auth",
                    message="Backend authorization failed",
                    status_code=response.status_code,
                    details=response.text
                )
            )

        if response.status_code == 403:
            parsed: Any = None
            try:
                parsed = response.json()
            except ValueError:
                parsed = None

            if isinstance(parsed, dict):
                code = parsed.get("code")
                challenge = parsed.get("confirmationChallenge")
                pending = parsed.get("pending_actions")
                if (
                    code == "CONFIRMATION_REQUIRED"
                    and isinstance(challenge, dict)
                    and isinstance(challenge.get("id"), str)
                    and isinstance(pending, list)
                ):
                    return self._build_logged_error_response(
                        method,
                        context,
                        BackendRequestError(
                            kind="confirmation",
                            message="Backend confirmation required",
                            status_code=response.status_code,
                            confirmation_challenge_id=challenge["id"],
                            pending_actions=pending
                        ),
                        status_code=response.status_code,
                        error_kind="confirmation",
                        response_json=parsed,
                    )

            self._log_request_response(
                method,
                context,
                status_code=response.status_code,
                error_kind="auth",
                response_json=parsed if isinstance(parsed, dict) else None,
            )
            log_audit_event(
                "auth_failure",
                source="backend_client",
                reason="403_forbidden_not_confirmation",
                path=context.original_path,
                method=method,
                status_code=response.status_code
            )
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="auth",
                    message="Backend authorization failed",
                    status_code=response.status_code,
                    details=response.text
                )
            )

        if response.status_code == 429:
            parsed_429: Any = None
            retry_after_sec: Optional[int] = None
            try:
                parsed_429 = response.json()
                if isinstance(parsed_429, dict):
                    ra = parsed_429.get("retryAfter")
                    if isinstance(ra, (int, float)) and ra >= 0:
                        retry_after_sec = int(ra)
            except ValueError:
                pass
            if retry_after_sec is None and response.headers.get("Retry-After"):
                try:
                    retry_after_sec = int(response.headers["Retry-After"])
                except (ValueError, TypeError):
                    pass
            if retry_after_sec is not None:
                mins = (retry_after_sec + 59) // 60
                msg = f"Rate limit exceeded. Try again in {mins} {'minute' if mins == 1 else 'minutes'}."
            else:
                msg = "Rate limit exceeded. Try again later."
            return self._build_logged_error_response(
                method,
                context,
                BackendRequestError(
                    kind="rate_limit",
                    message=msg,
                    status_code=429,
                    details=response.text
                ),
                status_code=response.status_code,
                error_kind="rate_limit",
                response_json=parsed_429 if isinstance(parsed_429, dict) else None,
            )

        if response.status_code >= 400:
            parsed_error: Any = None
            try:
                parsed_error = response.json()
            except ValueError:
                parsed_error = None
            return self._build_logged_error_response(
                method,
                context,
                BackendRequestError(
                    kind="http",
                    message="Backend request returned error",
                    status_code=response.status_code,
                    details=response.text
                ),
                status_code=response.status_code,
                error_kind="http",
                response_json=parsed_error if isinstance(parsed_error, dict) else None,
            )

        try:
            parsed = response.json()
        except ValueError as exc:
            return self._build_logged_error_response(
                method,
                context,
                BackendRequestError(
                    kind="parse",
                    message="Backend response is not valid JSON",
                    status_code=response.status_code,
                    details=str(exc)
                ),
                status_code=response.status_code,
                error_kind="parse",
            )

        if not isinstance(parsed, dict):
            return self._build_logged_error_response(
                method,
                context,
                BackendRequestError(
                    kind="parse",
                    message="Backend response is not a JSON object",
                    status_code=response.status_code
                ),
                status_code=response.status_code,
                error_kind="parse",
            )

        self._log_request_response(
            method,
            context,
            status_code=response.status_code,
            response_json=parsed,
        )
        return BackendResponse(ok=True, value=parsed)

    def request_confirm_daemon_actions(
        self,
        confirmation_token: str,
        instance_id: str
    ) -> BackendResponse[dict[str, Any]]:
        return _request_confirm_daemon_actions(self, confirmation_token, instance_id)

    def request_registry(self) -> BackendResponse[dict[str, Any]]:
        return _request_registry(self)

    def fetch_plan(self, plan_id: str) -> BackendResponse[dict[str, Any]]:
        return _fetch_plan(self, plan_id)

    def approve_plan(self, plan_id: str) -> BackendResponse[dict[str, Any]]:
        return _approve_plan(self, plan_id)

    def submit_execution_result(
        self, plan_id: str, result_data: dict[str, Any]
    ) -> BackendResponse[dict[str, Any]]:
        return _submit_execution_result(self, plan_id, result_data)

    def block_plan(self, plan_id: str) -> BackendResponse[dict[str, Any]]:
        return _block_plan(self, plan_id)

    def _parse_chat_response(self, response_json: Mapping[str, Any]) -> BackendResponse[BackendChatResult]:
        if response_json.get("ok") is True and "result" in response_json:
            response_text = self._extract_chat_text(response_json.get("result"))
            route_meta = response_json.get("_route")
            route_module = route_meta.get("module") if isinstance(route_meta, dict) else None
            model_hint = response_json.get("model") or response_json.get("activeModel") or route_module
        else:
            # Support both "result" (production backend) and "response" (legacy) field names
            response_text = self._extract_chat_text(response_json.get("result") or response_json.get("response"))
            model_hint = response_json.get("model") or response_json.get("activeModel")

        tokens = self._extract_tokens_used(response_json)
        cost = response_json.get("cost")
        model = model_hint

        if not isinstance(response_text, str):
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="parse", message="Chat response missing text")
            )
        if not isinstance(cost, (int, float)):
            cost = 0.0
        if not isinstance(model, str):
            model = "unknown"

        return BackendResponse(
            ok=True,
            value=BackendChatResult(
                response_text=response_text,
                tokens_used=tokens,
                cost_usd=float(cost),
                model=model
            )
        )

    @staticmethod
    def _extract_chat_text(response_payload: Any) -> Optional[str]:
        """
        Purpose: Normalize chat text from both legacy compatibility responses and `/gpt/:gptId` envelopes.
        Inputs/Outputs: arbitrary response payload; returns best-effort text string or None.
        Edge cases: structured module responses without a canonical text field are serialized to deterministic JSON.
        """
        if isinstance(response_payload, str):
            return response_payload

        if isinstance(response_payload, Mapping):
            for key in (
                "response",
                "result",
                "arcanos_tutor",
                "gaming_response",
                "storyline",
                "match",
                "text",
            ):
                value = response_payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value

            try:
                return json.dumps(dict(response_payload), ensure_ascii=True, sort_keys=True)
            except (TypeError, ValueError):
                return None

        return None

    def _parse_vision_response(self, response_json: Mapping[str, Any]) -> BackendResponse[BackendVisionResult]:
        response_text = response_json.get("response")
        tokens = response_json.get("tokens")
        cost = response_json.get("cost")
        model = response_json.get("model")

        if not isinstance(response_text, str):
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="parse", message="Vision response missing text")
            )
        if not isinstance(tokens, int):
            tokens = 0
        if not isinstance(cost, (int, float)):
            cost = 0.0
        if not isinstance(model, str):
            model = "unknown"

        return BackendResponse(
            ok=True,
            value=BackendVisionResult(
                response_text=response_text,
                tokens_used=tokens,
                cost_usd=float(cost),
                model=model
            )
        )

    def _parse_transcription_response(
        self,
        response_json: Mapping[str, Any]
    ) -> BackendResponse[BackendTranscriptionResult]:
        text = response_json.get("text")
        model = response_json.get("model")

        if not isinstance(text, str):
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="parse", message="Transcription response missing text")
            )
        if not isinstance(model, str):
            model = "unknown"

        return BackendResponse(
            ok=True,
            value=BackendTranscriptionResult(text=text, model=model)
        )
