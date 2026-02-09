"""
Backend API client for ARCANOS daemon.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, Sequence

import requests

from ..backend_auth_client import normalize_backend_url
from .chat import request_ask_with_domain as _request_ask_with_domain
from .chat import request_chat_completion as _request_chat_completion
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
    BackendRequestError,
    BackendResponse,
    BackendTranscriptionResult,
    BackendVisionResult,
)
from ..config import Config
from arcanos.debug import log_audit_event


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
        if not self._base_url:
            raise BackendRequestError(kind="configuration", message="Backend URL is not configured")

        token = self._token_provider()
        if not token:
            log_audit_event(
                "auth_failure",
                source="backend_client",
                reason="token_missing",
                path=path,
                method=method
            )
            raise BackendRequestError(kind="auth", message="Backend token is missing")

        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

        try:
            return self._request_sender(
                method,
                url,
                headers=headers,
                json=json,
                timeout=self._timeout_seconds
            )
        except requests.Timeout as exc:
            raise BackendRequestError(kind="timeout", message="Backend request timed out", details=str(exc))
        except requests.RequestException as exc:
            raise BackendRequestError(kind="network", message="Backend request failed", details=str(exc))

    def request_ask_with_domain(
        self,
        message: str,
        domain: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[BackendChatResult]:
        return _request_ask_with_domain(self, message, domain, metadata)

    def request_chat_completion(
        self,
        messages: Sequence[Mapping[str, str]],
        temperature: Optional[float] = None,
        model: Optional[str] = None,
        stream: bool = False,
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[BackendChatResult]:
        return _request_chat_completion(self, messages, temperature, model, stream, metadata)

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
        if not self._base_url:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="configuration", message="Backend URL is not configured")
            )

        token = self._token_provider()
        if not token:
            log_audit_event(
                "auth_failure",
                source="backend_client",
                reason="token_missing",
                path=path,
                method=method
            )
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="auth", message="Backend token is missing")
            )

        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }

        try:
            response = self._request_sender(
                method,
                url,
                headers=headers,
                json=payload,
                timeout=self._timeout_seconds
            )
        except requests.Timeout as exc:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="timeout", message="Backend request timed out", details=str(exc))
            )
        except requests.RequestException as exc:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="network", message="Backend request failed", details=str(exc))
            )

        if response.status_code == 401:
            log_audit_event(
                "auth_failure",
                source="backend_client",
                reason="401_unauthorized",
                path=path,
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
                    return BackendResponse(
                        ok=False,
                        error=BackendRequestError(
                            kind="confirmation",
                            message="Backend confirmation required",
                            status_code=response.status_code,
                            confirmation_challenge_id=challenge["id"],
                            pending_actions=pending
                        )
                    )

            log_audit_event(
                "auth_failure",
                source="backend_client",
                reason="403_forbidden_not_confirmation",
                path=path,
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
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="rate_limit",
                    message=msg,
                    status_code=429,
                    details=response.text
                )
            )

        if response.status_code >= 400:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="http",
                    message="Backend request returned error",
                    status_code=response.status_code,
                    details=response.text
                )
            )

        try:
            parsed = response.json()
        except ValueError as exc:
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="parse",
                    message="Backend response is not valid JSON",
                    status_code=response.status_code,
                    details=str(exc)
                )
            )

        if not isinstance(parsed, dict):
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="parse",
                    message="Backend response is not a JSON object",
                    status_code=response.status_code
                )
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
        # Support both "result" (production backend) and "response" (legacy) field names
        response_text = response_json.get("result") or response_json.get("response")
        tokens = self._extract_tokens_used(response_json)
        cost = response_json.get("cost")
        model = response_json.get("model") or response_json.get("activeModel")

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
