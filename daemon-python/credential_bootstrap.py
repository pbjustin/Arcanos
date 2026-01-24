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


def _init_bootstrap_trace_path() -> Optional[Path]:
    """
    Purpose: Prepare a trace log path for bootstrap diagnostics.
    Inputs/Outputs: None; returns log path if directory is available.
    Edge cases: Returns None if directory creation fails.
    """
    try:
        trace_dir = Config.CRASH_REPORTS_DIR
        trace_dir.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        return trace_dir / f"credential_bootstrap_trace_{timestamp}.log"
    except OSError:
        # //audit assumption: trace setup can fail; risk: no trace; invariant: best-effort; strategy: return None.
        return None


def _write_bootstrap_trace(trace_path: Optional[Path], message: str) -> None:
    """
    Purpose: Append a line to the bootstrap trace log.
    Inputs/Outputs: trace path and message; appends line with timestamp.
    Edge cases: Best-effort write; ignores failures.
    """
    if not trace_path:
        return

    try:
        with trace_path.open("a", encoding="utf-8") as handle:
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            handle.write(f"[{timestamp}] {message}\n")
    except OSError:
        # //audit assumption: trace write can fail; risk: missing diagnostics; invariant: best-effort logging; strategy: ignore.
        pass


def ensure_env_parent_dir(env_path: Path) -> None:
    """
    Purpose: Ensure parent directory for env file exists.
    Inputs/Outputs: env path; creates parent directory if needed.
    Edge cases: Raises EnvFileError on mkdir failures.
    """
    try:
        env_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # //audit assumption: directory creation can fail; risk: no env persistence; invariant: error surfaced; strategy: raise EnvFileError.
        raise EnvFileError(f"Failed to create env directory at {env_path.parent}: {exc}") from exc


def write_bootstrap_crash_report(
    error_message: str,
    primary_env_path: Path,
    fallback_env_path: Optional[Path]
) -> Optional[Path]:
    """
    Purpose: Write a crash report when credential persistence fails.
    Inputs/Outputs: error message and env paths; returns report path if written.
    Edge cases: Best-effort write; returns None on failure.
    """
    try:
        report_dir = Config.CRASH_REPORTS_DIR
        report_dir.mkdir(parents=True, exist_ok=True)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        report_path = report_dir / f"credential_bootstrap_{timestamp}.log"
        report_lines = [
            "Credential bootstrap persistence failure",
            f"Primary env path: {primary_env_path}",
            f"Fallback env path: {fallback_env_path or 'None'}",
            f"Error: {error_message}",
            f"Timestamp: {timestamp}"
        ]
        report_path.write_text("\n".join(report_lines) + "\n", encoding="utf-8")
        return report_path
    except OSError:
        # //audit assumption: crash report write can fail; risk: missing diagnostics; invariant: best-effort logging; strategy: return None.
        return None


def persist_credentials(
    env_path: Path,
    updates: Mapping[str, str],
    fallback_env_path: Optional[Path] = None,
    trace_path: Optional[Path] = None
) -> Path:
    """
    Purpose: Persist credential updates to .env and runtime.
    Inputs/Outputs: env_path, updates, fallback path; writes .env and sets runtime env.
    Edge cases: Falls back to user-writable path or raises CredentialBootstrapError.
    """
    try:
        _write_bootstrap_trace(trace_path, f"Persisting credentials to {env_path}")
        ensure_env_parent_dir(env_path)
        upsert_env_values(env_path, updates)
    except EnvFileError as exc:
        # //audit assumption: env write can fail; risk: credentials not saved; invariant: error surfaced; strategy: attempt fallback.
        _write_bootstrap_trace(trace_path, f"Primary env write failed: {exc}")
        report_path = write_bootstrap_crash_report(str(exc), env_path, fallback_env_path)
        if not fallback_env_path:
            raise CredentialBootstrapError(str(exc)) from exc

        try:
            _write_bootstrap_trace(trace_path, f"Persisting credentials to fallback {fallback_env_path}")
            ensure_env_parent_dir(fallback_env_path)
            upsert_env_values(fallback_env_path, updates)
        except EnvFileError as fallback_exc:
            # //audit assumption: fallback can fail; risk: no persistence; invariant: error surfaced; strategy: raise with details.
            _write_bootstrap_trace(trace_path, f"Fallback env write failed: {fallback_exc}")
            write_bootstrap_crash_report(
                f"Primary error: {exc}\nFallback error: {fallback_exc}",
                env_path,
                fallback_env_path
            )
            raise CredentialBootstrapError(
                f"Failed to write env file at {env_path} and fallback {fallback_env_path}: {fallback_exc}"
            ) from fallback_exc
        else:
            if report_path:
                print(f"Saved crash report to: {report_path}")
            print(f"Saved credentials to fallback env file: {fallback_env_path}")
            env_path = fallback_env_path

    apply_runtime_env_updates(updates)
    _write_bootstrap_trace(trace_path, f"Credentials persisted successfully to {env_path}")
    return env_path


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
    resolved_env_path = env_path or Config.ENV_PATH
    openai_api_key = Config.OPENAI_API_KEY or ""
    backend_token = Config.BACKEND_TOKEN or None
    backend_login_email = Config.BACKEND_LOGIN_EMAIL or None
    fallback_env_path = getattr(Config, "FALLBACK_ENV_PATH", None)
    trace_path = _init_bootstrap_trace_path()
    _write_bootstrap_trace(trace_path, "Bootstrap start")
    _write_bootstrap_trace(trace_path, f"OpenAI key present: {bool(openai_api_key)}")
    _write_bootstrap_trace(trace_path, f"Backend URL present: {bool(Config.BACKEND_URL)}")

    if not openai_api_key:
        # //audit assumption: OpenAI key required; risk: GPT client init fails; invariant: non-empty key; strategy: prompt and persist.
        openai_api_key = prompt_for_value(
            "OpenAI API key: ",
            input_provider
        )
        _write_bootstrap_trace(trace_path, "Received OpenAI key input; persisting.")
        persist_credentials(
            resolved_env_path,
            {"OPENAI_API_KEY": openai_api_key},
            fallback_env_path,
            trace_path
        )

    backend_url = Config.BACKEND_URL or ""
    if backend_url:
        # //audit assumption: backend login required when URL set; risk: unauthenticated backend calls; invariant: token available; strategy: ensure token.
        token_is_valid = bool(backend_token) and not is_jwt_expired(backend_token, now_seconds())
        _write_bootstrap_trace(trace_path, f"Backend token valid: {token_is_valid}")

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
                _write_bootstrap_trace(trace_path, "Attempting backend login")
                login_result = login_requester(backend_url, backend_login_email, backend_password)
            except BackendAuthError as exc:
                # //audit assumption: login can fail; risk: blocked startup; invariant: error surfaced; strategy: raise CredentialBootstrapError.
                _write_bootstrap_trace(trace_path, f"Backend login failed: {exc}")
                raise CredentialBootstrapError(str(exc)) from exc

            backend_token = login_result.token
            _write_bootstrap_trace(trace_path, "Backend login succeeded; persisting token")
            persist_credentials(
                resolved_env_path,
                {"BACKEND_TOKEN": backend_token, "BACKEND_LOGIN_EMAIL": backend_login_email},
                fallback_env_path,
                trace_path
            )

    _write_bootstrap_trace(trace_path, "Bootstrap complete")
    return CredentialBootstrapResult(
        openai_api_key=openai_api_key,
        backend_token=backend_token,
        backend_login_email=backend_login_email
    )
