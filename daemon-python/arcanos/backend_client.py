"""
Backend API client for ARCANOS daemon.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, Sequence

import requests

from .backend_auth_client import normalize_backend_url
from .backend_client.chat import request_ask_with_domain as _request_ask_with_domain
from .backend_client.chat import request_chat_completion as _request_chat_completion
from .backend_client.daemon import request_confirm_daemon_actions as _request_confirm_daemon_actions
from .backend_client.registry import request_registry as _request_registry
from .backend_client.transcribe import request_transcription as _request_transcription
from .backend_client.updates import submit_update_event as _submit_update_event
from .backend_client.vision import request_vision_analysis as _request_vision_analysis
from .backend_client_models import (
    BackendChatResult,
    BackendRequestError,
    BackendResponse,
    BackendTranscriptionResult,
    BackendVisionResult,
)
from .config import Config
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
            # //audit assumption: metadata optional; risk: missing context; invariant: None returned; strategy: skip metadata.
            return None
        # //audit assumption: metadata should be serialized; risk: non-serializable values; invariant: dict conversion attempted; strategy: dict() copy.
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
            # //audit assumption: tokens already provided; risk: incorrect type; invariant: integer tokens; strategy: return early.
            return tokens

        # //audit assumption: tokens may be nested under meta.tokens; risk: missing usage data; invariant: check nested metadata; strategy: fallback parsing.
        meta = response_json.get("meta", {})
        if isinstance(meta, dict):
            # //audit assumption: meta should be mapping; risk: schema mismatch; invariant: dict parsed; strategy: inspect tokens.
            tokens_obj = meta.get("tokens", {})
            if isinstance(tokens_obj, dict):
                # //audit assumption: tokens object should be mapping; risk: schema mismatch; invariant: dict parsed; strategy: read total_tokens.
                tokens = tokens_obj.get("total_tokens", 0)

        if not isinstance(tokens, int):
            # //audit assumption: tokens should be int; risk: missing usage; invariant: integer tokens; strategy: default to zero.
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
            # //audit assumption: base_url configured; risk: no target; invariant: base_url set; strategy: raise configuration error.
            raise BackendRequestError(kind="configuration", message="Backend URL is not configured")

        token = self._token_provider()
        if not token:
            # //audit assumption: auth token required; risk: unauthorized request; invariant: token present; strategy: raise auth error.
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
            # //audit assumption: network timeouts can happen; risk: request failure; invariant: error raised; strategy: raise timeout error.
            raise BackendRequestError(kind="timeout", message="Backend request timed out", details=str(exc))
        except requests.RequestException as exc:
            # //audit assumption: network errors can happen; risk: request failure; invariant: error raised; strategy: raise network error.
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
        image_base64: str,
        prompt: Optional[str] = None,
        temperature: Optional[float] = None,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[BackendVisionResult]:
        return _request_vision_analysis(self, image_base64, prompt, temperature, model, max_tokens, metadata)

    def request_transcription(
        self,
        audio_base64: str,
        filename: Optional[str] = None,
        model: Optional[str] = None,
        language: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[BackendTranscriptionResult]:
        return _request_transcription(self, audio_base64, filename, model, language, metadata)

    def submit_update_event(
        self,
        update_type: str,
        data: Mapping[str, Any],
        metadata: Optional[Mapping[str, Any]] = None
    ) -> BackendResponse[bool]:
        return _submit_update_event(self, update_type, data, metadata)

    def _request_json(
        self,
        method: str,
        path: str,
        payload: Optional[Mapping[str, Any]]
    ) -> BackendResponse[dict[str, Any]]:
        if not self._base_url:
            # //audit assumption: base_url configured; risk: no target; invariant: base_url set; strategy: return config error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="configuration", message="Backend URL is not configured")
            )

        token = self._token_provider()
        if not token:
            # //audit assumption: auth token required; risk: unauthorized request; invariant: token present; strategy: return auth error.
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
            # //audit assumption: network timeouts can happen; risk: request failure; invariant: error surfaced; strategy: return timeout error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="timeout", message="Backend request timed out", details=str(exc))
            )
        except requests.RequestException as exc:
            # //audit assumption: network errors can happen; risk: request failure; invariant: error surfaced; strategy: return network error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="network", message="Backend request failed", details=str(exc))
            )

        if response.status_code == 401:
            # //audit assumption: auth errors should be surfaced; risk: unauthorized usage; invariant: auth error returned; strategy: return auth error.
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
            # //audit assumption: 403 may be confirmation or auth; risk: misclassification; invariant: inspect payload; strategy: parse JSON.
            parsed: Any = None
            try:
                parsed = response.json()
            except ValueError:
                # //audit assumption: confirmation payload may not be JSON; risk: losing confirmation; invariant: fallback to auth error; strategy: return auth error.
                parsed = None

            if isinstance(parsed, dict):
                # //audit assumption: confirmation payload is JSON object; risk: schema mismatch; invariant: dict parsed; strategy: inspect fields.
                code = parsed.get("code")
                challenge = parsed.get("confirmationChallenge")
                pending = parsed.get("pending_actions")
                if (
                    code == "CONFIRMATION_REQUIRED"
                    and isinstance(challenge, dict)
                    and isinstance(challenge.get("id"), str)
                    and isinstance(pending, list)
                ):
                    # //audit assumption: confirmation payload is well-formed; risk: malformed pending actions; invariant: confirmation fields stored; strategy: return confirmation error.
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

            # //audit assumption: 403 without confirmation is auth failure; risk: misclassified error; invariant: auth error returned; strategy: return auth error.
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
            # Rate limit: parse retryAfter from body or Retry-After header for a clearer message.
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
            # //audit assumption: non-2xx indicates error; risk: backend failure; invariant: error returned; strategy: return http error.
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
            # //audit assumption: response JSON required; risk: parse failure; invariant: JSON body; strategy: return parse error.
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
            # //audit assumption: JSON object expected; risk: schema mismatch; invariant: dict response; strategy: return parse error.
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

    def _parse_chat_response(self, response_json: Mapping[str, Any]) -> BackendResponse[BackendChatResult]:
        # Support both "result" (production backend) and "response" (legacy) field names
        response_text = response_json.get("result") or response_json.get("response")
        tokens = self._extract_tokens_used(response_json)
        cost = response_json.get("cost")
        model = response_json.get("model") or response_json.get("activeModel")

        if not isinstance(response_text, str):
            # //audit assumption: response text required; risk: parse failure; invariant: string response; strategy: return parse error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="parse", message="Chat response missing text")
            )
        if not isinstance(cost, (int, float)):
            # //audit assumption: cost should be numeric; risk: missing cost; invariant: numeric cost; strategy: default to zero.
            cost = 0.0
        if not isinstance(model, str):
            # //audit assumption: model should be string; risk: missing model; invariant: model string; strategy: default to unknown.
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
            # //audit assumption: response text required; risk: parse failure; invariant: string response; strategy: return parse error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="parse", message="Vision response missing text")
            )
        if not isinstance(tokens, int):
            # //audit assumption: tokens should be int; risk: missing usage; invariant: integer tokens; strategy: default to zero.
            tokens = 0
        if not isinstance(cost, (int, float)):
            # //audit assumption: cost should be numeric; risk: missing cost; invariant: numeric cost; strategy: default to zero.
            cost = 0.0
        if not isinstance(model, str):
            # //audit assumption: model should be string; risk: missing model; invariant: model string; strategy: default to unknown.
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
            # //audit assumption: transcription text required; risk: parse failure; invariant: string text; strategy: return parse error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="parse", message="Transcription response missing text")
            )
        if not isinstance(model, str):
            # //audit assumption: model should be string; risk: missing model; invariant: model string; strategy: default to unknown.
            model = "unknown"

        return BackendResponse(
            ok=True,
            value=BackendTranscriptionResult(text=text, model=model)
        )
