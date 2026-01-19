"""
Credential bootstrapper for OpenAI and backend JWT authentication.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import time
from dataclasses import dataclass
from getpass import getpass
from pathlib import Path
from typing import Callable, Mapping, Optional

from backend_auth_client import BackendAuthError, BackendLoginResult, request_backend_login
from config import Config
from env_store import EnvFileError, upsert_env_values


class CredentialBootstrapError(RuntimeError):
    """
    Purpose: Structured error for credential bootstrap failures.
    Inputs/Outputs: Message describing the bootstrap failure reason.
    Edge cases: Wraps env file or backend auth errors for display.
    """


@dataclass(frozen=True)
class CredentialBootstrapResult:
    """
    Purpose: Result of credential bootstrap for runtime updates.
    Inputs/Outputs: OpenAI key, backend token, and backend login email.
    Edge cases: backend_token and backend_login_email may be None if backend is unused.
    """

    openai_api_key: str
    backend_token: Optional[str]
    backend_login_email: Optional[str]


def parse_jwt_expiration(token: str) -> Optional[int]:
    """
    Purpose: Extract JWT expiration (exp) without verifying signature.
    Inputs/Outputs: JWT token string; returns exp epoch seconds or None.
    Edge cases: Invalid tokens or missing exp return None.
    """
    parts = token.split(".")
    if len(parts) != 3:
        # //audit assumption: JWT has three parts; risk: malformed token; invariant: 3 segments; strategy: return None.
        return None

    payload_segment = parts[1]
    padding = "=" * (-len(payload_segment) % 4)
    padded_segment = f"{payload_segment}{padding}"

    try:
        payload_bytes = base64.urlsafe_b64decode(padded_segment.encode("ascii"))
    except (binascii.Error, ValueError):
        # //audit assumption: payload is base64url; risk: decode failure; invariant: decodable payload; strategy: return None.
        return None

    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        # //audit assumption: payload is JSON; risk: invalid JSON; invariant: JSON object; strategy: return None.
        return None

    exp_value = payload.get("exp") if isinstance(payload, dict) else None
    if not isinstance(exp_value, int):
        # //audit assumption: exp is integer; risk: missing expiry; invariant: exp optional; strategy: return None.
        return None

    return exp_value


def is_jwt_expired(token: str, now_seconds: float, leeway_seconds: int = 60) -> bool:
    """
    Purpose: Determine whether a JWT is expired or close to expiry.
    Inputs/Outputs: token string, current time, and leeway; returns True if expired.
    Edge cases: Tokens without exp are treated as expired.
    """
    exp_value = parse_jwt_expiration(token)
    if exp_value is None:
        # //audit assumption: tokens should have exp; risk: unbounded token; invariant: exp required; strategy: treat as expired.
        return True

    # //audit assumption: leeway avoids edge expiry; risk: near-expiry use; invariant: now+leeway < exp; strategy: compare with leeway.
    return now_seconds + leeway_seconds >= exp_value


def prompt_for_value(
    prompt_text: str,
    input_provider: Callable[[str], str],
    default_value: Optional[str] = None,
    max_attempts: int = 3
) -> str:
    """
    Purpose: Prompt user for a non-empty value with optional default.
    Inputs/Outputs: prompt text, input provider, default, attempts; returns user value.
    Edge cases: Raises CredentialBootstrapError after max attempts.
    """
    for attempt in range(max_attempts):
        value = input_provider(prompt_text).strip()

        if value:
            # //audit assumption: non-empty input is valid; risk: whitespace only; invariant: trimmed non-empty; strategy: accept.
            return value

        if default_value:
            # //audit assumption: default is acceptable; risk: unintended default use; invariant: default exists; strategy: return default.
            return default_value

        # //audit assumption: retry is acceptable; risk: endless loop; invariant: bounded attempts; strategy: continue.
        if attempt < max_attempts - 1:
            continue

    raise CredentialBootstrapError("Maximum input attempts exceeded")


def prompt_for_password(
    prompt_text: str,
    password_provider: Callable[[str], str],
    max_attempts: int = 3
) -> str:
    """
    Purpose: Prompt user for a non-empty password without echoing.
    Inputs/Outputs: prompt text, password provider, attempts; returns password.
    Edge cases: Raises CredentialBootstrapError after max attempts.
    """
    for attempt in range(max_attempts):
        value = password_provider(prompt_text).strip()
        if value:
            # //audit assumption: non-empty password required; risk: empty password; invariant: trimmed non-empty; strategy: accept.
            return value

        # //audit assumption: retry is acceptable; risk: endless loop; invariant: bounded attempts; strategy: continue.
        if attempt < max_attempts - 1:
            continue

    raise CredentialBootstrapError("Maximum password attempts exceeded")


def apply_runtime_env_updates(updates: Mapping[str, str]) -> None:
    """
    Purpose: Apply env updates to os.environ and Config for runtime use.
    Inputs/Outputs: mapping of env keys to values; updates process environment.
    Edge cases: Only known Config attributes are updated.
    """
    for key, value in updates.items():
        # //audit assumption: keys are valid env names; risk: missing config mapping; invariant: os.environ set; strategy: set env var.
        os.environ[key] = value

        if hasattr(Config, key):
            # //audit assumption: Config uses env key names; risk: attribute missing; invariant: update only if present; strategy: setattr.
            setattr(Config, key, value)


def persist_credentials(env_path: Path, updates: Mapping[str, str]) -> None:
    """
    Purpose: Persist credential updates to .env and runtime.
    Inputs/Outputs: env_path and updates mapping; writes .env and sets runtime env.
    Edge cases: Raises CredentialBootstrapError on write failure.
    """
    try:
        upsert_env_values(env_path, updates)
    except EnvFileError as exc:
        # //audit assumption: env write can fail; risk: credentials not saved; invariant: error surfaced; strategy: raise.
        raise CredentialBootstrapError(str(exc)) from exc

    apply_runtime_env_updates(updates)


def bootstrap_credentials(
    env_path: Optional[Path] = None,
    input_provider: Callable[[str], str] = input,
    password_provider: Callable[[str], str] = getpass,
    login_requester: Callable[..., BackendLoginResult] = request_backend_login,
    now_seconds: Callable[[], float] = time.time
) -> CredentialBootstrapResult:
    """
    Purpose: Ensure OpenAI and backend credentials are available at startup.
    Inputs/Outputs: Optional env_path and injected I/O dependencies; returns bootstrap result.
    Edge cases: Backend login is skipped if BACKEND_URL is unset.
    """
    resolved_env_path = env_path or (Path(__file__).parent / ".env")
    openai_api_key = Config.OPENAI_API_KEY or ""
    backend_token = Config.BACKEND_TOKEN or None
    backend_login_email = Config.BACKEND_LOGIN_EMAIL or None

    if not openai_api_key:
        # //audit assumption: OpenAI key required; risk: GPT client init fails; invariant: non-empty key; strategy: prompt and persist.
        openai_api_key = prompt_for_value(
            "OpenAI API key: ",
            input_provider
        )
        persist_credentials(resolved_env_path, {"OPENAI_API_KEY": openai_api_key})

    backend_url = Config.BACKEND_URL or ""
    if backend_url:
        # //audit assumption: backend login required when URL set; risk: unauthenticated backend calls; invariant: token available; strategy: ensure token.
        token_is_valid = bool(backend_token) and not is_jwt_expired(backend_token, now_seconds())

        if not token_is_valid:
            # //audit assumption: login needed when token missing/expired; risk: auth failures; invariant: fresh token; strategy: prompt and login.
            backend_login_email = prompt_for_value(
                "Backend login email: ",
                input_provider,
                default_value=backend_login_email
            )
            backend_password = prompt_for_password(
                "Backend password: ",
                password_provider
            )
            try:
                login_result = login_requester(backend_url, backend_login_email, backend_password)
            except BackendAuthError as exc:
                # //audit assumption: login can fail; risk: blocked startup; invariant: error surfaced; strategy: raise CredentialBootstrapError.
                raise CredentialBootstrapError(str(exc)) from exc

            backend_token = login_result.token
            persist_credentials(
                resolved_env_path,
                {"BACKEND_TOKEN": backend_token, "BACKEND_LOGIN_EMAIL": backend_login_email}
            )

    return CredentialBootstrapResult(
        openai_api_key=openai_api_key,
        backend_token=backend_token,
        backend_login_email=backend_login_email
    )
