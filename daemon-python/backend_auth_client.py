"""
Backend authentication client for obtaining JWT tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

import requests


class BackendAuthError(RuntimeError):
    """
    Purpose: Structured error for backend login failures.
    Inputs/Outputs: Message describing failure context; raised on login errors.
    Edge cases: Wraps HTTP and JSON parsing failures.
    """


@dataclass(frozen=True)
class BackendLoginResult:
    """
    Purpose: Result of backend login with token details.
    Inputs/Outputs: token string, optional expires_at epoch, and user_id.
    Edge cases: expires_at may be None if backend omits it.
    """

    token: str
    expires_at: Optional[int]
    user_id: str


def normalize_backend_url(base_url: str) -> str:
    """
    Purpose: Normalize backend base URL for request building.
    Inputs/Outputs: base_url string; returns normalized URL without trailing slash.
    Edge cases: Empty input returns empty string.
    """
    # //audit assumption: URL is a string; risk: trailing slash duplication; invariant: no trailing slash; strategy: rstrip.
    return base_url.strip().rstrip("/")


def build_login_payload(email: str, password: str) -> dict[str, str]:
    """
    Purpose: Build the JSON payload for login requests.
    Inputs/Outputs: email and password strings; returns JSON-ready dict.
    Edge cases: Caller is responsible for non-empty validation.
    """
    # //audit assumption: payload is simple key/value; risk: malformed JSON; invariant: dict with email/password; strategy: explicit keys.
    return {"email": email, "password": password}


def parse_login_response(response_json: Any) -> BackendLoginResult:
    """
    Purpose: Parse backend login response JSON into a result.
    Inputs/Outputs: response_json object; returns BackendLoginResult.
    Edge cases: Raises BackendAuthError if token is missing or invalid.
    """
    if not isinstance(response_json, dict):
        # //audit assumption: response JSON is object; risk: unexpected schema; invariant: dict; strategy: raise error.
        raise BackendAuthError("Login response is not a JSON object")

    token = response_json.get("token")
    user_id = response_json.get("userId")
    expires_at = response_json.get("expiresAt")

    if not isinstance(token, str) or not token:
        # //audit assumption: token is required; risk: unusable auth; invariant: non-empty token; strategy: raise error.
        raise BackendAuthError("Login response missing token")
    if not isinstance(user_id, str) or not user_id:
        # //audit assumption: userId is required; risk: unclear ownership; invariant: non-empty userId; strategy: raise error.
        raise BackendAuthError("Login response missing userId")

    if expires_at is not None and not isinstance(expires_at, int):
        # //audit assumption: expiresAt is int or null; risk: parse error; invariant: optional int; strategy: ignore invalid.
        expires_at = None

    return BackendLoginResult(token=token, expires_at=expires_at, user_id=user_id)


def request_backend_login(
    base_url: str,
    email: str,
    password: str,
    timeout_seconds: int = 10,
    post_request: Callable[..., requests.Response] = requests.post
) -> BackendLoginResult:
    """
    Purpose: Call backend login endpoint and return token details.
    Inputs/Outputs: base_url, email, password, timeout; returns BackendLoginResult.
    Edge cases: Raises BackendAuthError on HTTP or JSON failures.
    """
    normalized_url = normalize_backend_url(base_url)
    if not normalized_url:
        # //audit assumption: base_url is configured; risk: login target missing; invariant: non-empty URL; strategy: raise error.
        raise BackendAuthError("Backend URL is not configured")

    login_url = f"{normalized_url}/api/auth/login"
    payload = build_login_payload(email, password)

    try:
        response = post_request(login_url, json=payload, timeout=timeout_seconds)
    except requests.RequestException as exc:
        # //audit assumption: network can fail; risk: login unreachable; invariant: error surfaced; strategy: raise BackendAuthError.
        raise BackendAuthError(f"Login request failed: {exc}") from exc

    if response.status_code != 200:
        # //audit assumption: 200 indicates success; risk: invalid credentials or server error; invariant: status 200; strategy: raise error.
        raise BackendAuthError(f"Login failed with status {response.status_code}")

    try:
        response_json = response.json()
    except ValueError as exc:
        # //audit assumption: response is JSON; risk: parse failure; invariant: JSON body; strategy: raise BackendAuthError.
        raise BackendAuthError("Login response is not valid JSON") from exc

    return parse_login_response(response_json)
