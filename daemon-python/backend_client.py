"""
Backend API client for ARCANOS daemon.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Generic, Mapping, Optional, Sequence, TypeVar

import requests

from backend_auth_client import normalize_backend_url

T = TypeVar("T")


@dataclass(frozen=True)
class BackendRequestError:
    """
    Purpose: Structured error for backend request failures.
    Inputs/Outputs: kind, message, optional status code, optional details.
    Edge cases: details may be None for network or parsing errors.
    """

    kind: str
    message: str
    status_code: Optional[int] = None
    details: Optional[str] = None


@dataclass(frozen=True)
class BackendResponse(Generic[T]):
    """
    Purpose: Wrapper for backend responses with structured errors.
    Inputs/Outputs: ok flag, optional value, optional error.
    Edge cases: value is None when ok is False.
    """

    ok: bool
    value: Optional[T] = None
    error: Optional[BackendRequestError] = None


@dataclass(frozen=True)
class BackendChatResult:
    """
    Purpose: Parsed chat response from backend ask endpoint.
    Inputs/Outputs: response text, tokens, cost, and model.
    Edge cases: tokens and cost may be zero if backend omits usage.
    """

    response_text: str
    tokens_used: int
    cost_usd: float
    model: str


@dataclass(frozen=True)
class BackendVisionResult:
    """
    Purpose: Parsed vision response from backend vision endpoint.
    Inputs/Outputs: response text, tokens, cost, and model.
    Edge cases: tokens and cost may be zero if backend omits usage.
    """

    response_text: str
    tokens_used: int
    cost_usd: float
    model: str


@dataclass(frozen=True)
class BackendTranscriptionResult:
    """
    Purpose: Parsed transcription response from backend transcribe endpoint.
    Inputs/Outputs: transcription text and model name.
    Edge cases: text may be empty if backend returns no transcription.
    """

    text: str
    model: str


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
        request_sender: Callable[..., requests.Response] = requests.request,
        auth_required: bool = True,
        auth_header_name: str = "Authorization",
        auth_header_prefix: Optional[str] = "Bearer",
        auth_mode: str = "jwt",
        daemon_gpt_id: Optional[str] = None,
        daemon_gpt_header_name: str = "OpenAI-GPT-ID"
    ) -> None:
        """
        Purpose: Initialize backend API client.
        Inputs/Outputs: base_url, token provider, timeout, request sender, auth config, daemon GPT ID; stores config.
        Edge cases: Empty base_url disables requests and returns config errors.
        """
        self._base_url = normalize_backend_url(base_url)
        self._token_provider = token_provider
        self._timeout_seconds = timeout_seconds
        self._request_sender = request_sender
        self._auth_required = auth_required
        # //audit assumption: header name may be empty; risk: missing auth header; invariant: fallback to Authorization; strategy: strip and default.
        self._auth_header_name = auth_header_name.strip() or "Authorization"
        # //audit assumption: prefix optional; risk: wrong auth scheme; invariant: preserve None; strategy: strip or keep None.
        self._auth_header_prefix = auth_header_prefix.strip() if auth_header_prefix is not None else None
        # //audit assumption: auth mode used for messaging; risk: invalid mode; invariant: normalized value; strategy: lower and default.
        self._auth_mode = auth_mode.strip().lower() or "jwt"
        # //audit assumption: daemon GPT ID optional; risk: whitespace/empty values; invariant: trimmed string or None; strategy: strip and fallback.
        self._daemon_gpt_id = daemon_gpt_id.strip() if daemon_gpt_id else None
        # //audit assumption: daemon GPT header name may be empty; risk: missing header name; invariant: default header used; strategy: strip and fallback.
        normalized_daemon_header = daemon_gpt_header_name.strip() or "OpenAI-GPT-ID"
        self._daemon_gpt_header_name = normalized_daemon_header

    def request_chat_completion(
        self,
        messages: Sequence[Mapping[str, str]],
        temperature: Optional[float] = None,
        model: Optional[str] = None,
        stream: bool = False
    ) -> BackendResponse[BackendChatResult]:
        """
        Purpose: Call backend /api/ask with conversation messages.
        Inputs/Outputs: messages, optional temperature/model, stream flag; returns BackendChatResult.
        Edge cases: Returns structured error on auth, network, or parsing failures.
        """
        payload: dict[str, Any] = {
            "messages": list(messages),
            "stream": stream
        }
        if temperature is not None:
            # //audit assumption: temperature optional; risk: missing value; invariant: include when provided; strategy: conditional field.
            payload["temperature"] = temperature
        if model:
            # //audit assumption: model override optional; risk: invalid model; invariant: include when provided; strategy: conditional field.
            payload["model"] = model

        response = self._request_json("post", "/api/ask", payload)
        if not response.ok or not response.value:
            # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
            return BackendResponse(ok=False, error=response.error)

        return self._parse_chat_response(response.value)

    def request_vision_analysis(
        self,
        image_base64: str,
        prompt: Optional[str] = None,
        temperature: Optional[float] = None,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None
    ) -> BackendResponse[BackendVisionResult]:
        """
        Purpose: Call backend /api/vision to analyze an image.
        Inputs/Outputs: base64 image, optional prompt/temperature/model/max_tokens; returns BackendVisionResult.
        Edge cases: Returns structured error on auth, network, or parsing failures.
        """
        payload: dict[str, Any] = {
            "imageBase64": image_base64
        }
        if prompt:
            # //audit assumption: prompt optional; risk: empty prompt; invariant: include when provided; strategy: conditional field.
            payload["prompt"] = prompt
        if temperature is not None:
            # //audit assumption: temperature optional; risk: missing value; invariant: include when provided; strategy: conditional field.
            payload["temperature"] = temperature
        if model:
            # //audit assumption: model override optional; risk: invalid model; invariant: include when provided; strategy: conditional field.
            payload["model"] = model
        if max_tokens is not None:
            # //audit assumption: max tokens optional; risk: invalid value; invariant: include when provided; strategy: conditional field.
            payload["maxTokens"] = max_tokens

        response = self._request_json("post", "/api/vision", payload)
        if not response.ok or not response.value:
            # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
            return BackendResponse(ok=False, error=response.error)

        return self._parse_vision_response(response.value)

    def request_transcription(
        self,
        audio_base64: str,
        filename: Optional[str] = None,
        model: Optional[str] = None,
        language: Optional[str] = None
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

        response = self._request_json("post", "/api/transcribe", payload)
        if not response.ok or not response.value:
            # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
            return BackendResponse(ok=False, error=response.error)

        return self._parse_transcription_response(response.value)

    def submit_update_event(
        self,
        update_type: str,
        data: Mapping[str, Any]
    ) -> BackendResponse[bool]:
        """
        Purpose: Call backend /api/update to record a structured update event.
        Inputs/Outputs: update_type string and data mapping; returns bool success.
        Edge cases: Returns structured error on auth, network, or parsing failures.
        """
        payload = {
            "updateType": update_type,
            "data": dict(data)
        }

        response = self._request_json("post", "/api/update", payload)
        if not response.ok or not response.value:
            # //audit assumption: response must be ok; risk: backend failure; invariant: ok response; strategy: return error.
            return BackendResponse(ok=False, error=response.error)

        success_value = response.value.get("success")
        if isinstance(success_value, bool):
            # //audit assumption: success is boolean; risk: wrong type; invariant: bool value; strategy: return parsed value.
            return BackendResponse(ok=True, value=success_value)

        # //audit assumption: success should be boolean; risk: parse failure; invariant: bool; strategy: return error.
        return BackendResponse(
            ok=False,
            error=BackendRequestError(kind="parse", message="update response missing success flag")
        )

    def _build_auth_header_value(self, token: str) -> str:
        """
        Purpose: Build authorization header value from token and optional prefix.
        Inputs/Outputs: token string; returns header value string.
        Edge cases: Empty prefix yields raw token.
        """
        # //audit assumption: prefix may be None; risk: missing prefix; invariant: raw token allowed; strategy: return token.
        if not self._auth_header_prefix:
            return token
        # //audit assumption: prefix may be whitespace; risk: malformed header; invariant: non-empty prefix; strategy: strip and fallback.
        trimmed_prefix = self._auth_header_prefix.strip()
        if not trimmed_prefix:
            return token
        return f"{trimmed_prefix} {token}"

    def _apply_daemon_gpt_header(self, headers: dict[str, str]) -> None:
        """
        Purpose: Append daemon GPT ID header when configured.
        Inputs/Outputs: headers dict mutated in place; no return.
        Edge cases: Skips when ID is missing or header would overwrite an existing header.
        """
        if not self._daemon_gpt_id:
            # //audit assumption: daemon GPT ID optional; risk: header absent; invariant: no header when missing; strategy: return.
            return
        # //audit assumption: header comparison should be case-insensitive; risk: overwrite auth header; invariant: avoid conflicts; strategy: lowercase names.
        existing_header_names = {name.lower() for name in headers.keys()}
        if self._daemon_gpt_header_name.lower() in existing_header_names:
            # //audit assumption: do not overwrite existing header; risk: auth clobbered; invariant: existing header preserved; strategy: skip.
            return
        headers[self._daemon_gpt_header_name] = self._daemon_gpt_id

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
        if not token and self._auth_required:
            # //audit assumption: auth token required; risk: unauthorized request; invariant: token present; strategy: return auth error.
            auth_label = "token" if self._auth_mode == "jwt" else "API key"
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="auth", message=f"Backend {auth_label} is missing")
            )

        url = f"{self._base_url}{path}"
        headers = {
            "Content-Type": "application/json"
        }
        if token:
            # //audit assumption: token optional; risk: unauthorized request; invariant: auth header when token present; strategy: add header.
            headers[self._auth_header_name] = self._build_auth_header_value(token)
        self._apply_daemon_gpt_header(headers)

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

        if response.status_code in (401, 403):
            # //audit assumption: auth errors should be surfaced; risk: unauthorized usage; invariant: auth error returned; strategy: return auth error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(
                    kind="auth",
                    message="Backend authorization failed",
                    status_code=response.status_code,
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

    def _parse_chat_response(self, response_json: Mapping[str, Any]) -> BackendResponse[BackendChatResult]:
        response_text = response_json.get("response")
        tokens = response_json.get("tokens")
        cost = response_json.get("cost")
        model = response_json.get("model")

        if not isinstance(response_text, str):
            # //audit assumption: response text required; risk: parse failure; invariant: string response; strategy: return parse error.
            return BackendResponse(
                ok=False,
                error=BackendRequestError(kind="parse", message="Chat response missing text")
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
