"""
Credential bootstrapper for OpenAI and backend JWT authentication.
"""

from __future__ import annotations

import importlib.resources as importlib_resources
import logging
import time
from pathlib import Path
from typing import Callable, Mapping, Optional
from .config import Config
from .env_store import EnvFileError, upsert_env_values
from .credential_bootstrap.env_utils import apply_runtime_env_updates, ensure_env_parent_dir, prompt_for_value
from .credential_bootstrap.jwt_utils import is_jwt_expired, verify_backend_jwt
from .credential_bootstrap.types import CredentialBootstrapError, CredentialBootstrapResult

logger = logging.getLogger("arcanos.credential_bootstrap")


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


def _resolve_env_template_text(trace_path: Optional[Path]) -> Optional[str]:
    """
    Purpose: Load the .env template text from packaged assets.
    Inputs/Outputs: Optional trace path for diagnostics; returns template text or None.
    Edge cases: Missing template or read failures return None with trace logging.
    """
    try:
        template_resource = importlib_resources.files("arcanos").joinpath("assets", "env.example")
        if template_resource.is_file():
            # //audit assumption: packaged template exists; risk: missing resource; invariant: read text; strategy: use packaged template.
            return template_resource.read_text(encoding="utf-8")
    except (AttributeError, FileNotFoundError, OSError, ModuleNotFoundError) as exc:
        # //audit assumption: resource lookup can fail; risk: no template seed; invariant: best-effort; strategy: log and return None.
        _write_bootstrap_trace(trace_path, f"Failed to read packaged env template: {exc}")

    return None


def _seed_env_file_if_missing(env_path: Path, trace_path: Optional[Path]) -> bool:
    """
    Purpose: Ensure a .env exists by seeding from the template on first run.
    Inputs/Outputs: env_path and trace path; returns True when a seed file was created.
    Edge cases: Missing template or write failures return False without stopping bootstrap.
    """
    if env_path.exists():
        # //audit assumption: existing env should be preserved; risk: overwriting user config; invariant: no overwrite; strategy: skip.
        return False

    project_root = Path(__file__).resolve().parent.parent
    if env_path.parent == project_root:
        # //audit assumption: repo installs manage .env manually; risk: unwanted file creation; invariant: avoid auto-seed in repo; strategy: skip.
        return False

    template_text = _resolve_env_template_text(trace_path)
    if not template_text:
        # //audit assumption: template may be missing; risk: minimal config; invariant: bootstrap continues; strategy: skip seeding.
        return False

    try:
        ensure_env_parent_dir(env_path)
        env_path.write_text(template_text, encoding="utf-8")
    except (EnvFileError, OSError) as exc:
        # //audit assumption: template write can fail; risk: no seed file; invariant: bootstrap continues; strategy: log and continue.
        _write_bootstrap_trace(trace_path, f"Failed to seed env template: {exc}")
        return False

    _write_bootstrap_trace(trace_path, f"Seeded env template at {env_path}")
    return True


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

    _seed_env_file_if_missing(resolved_env_path, trace_path)

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
        # Backend is optional: do not prompt for login. Use BACKEND_TOKEN from env if set.
        token_is_valid = False
        if backend_token:
            # Check expiration first (quick check)
            if not is_jwt_expired(backend_token, now_seconds()):
                # If verification keys are configured, verify signature
                if Config.BACKEND_JWT_SECRET or Config.BACKEND_JWT_PUBLIC_KEY or Config.BACKEND_JWT_JWKS_URL:
                    token_is_valid = verify_backend_jwt(
                        backend_token,
                        secret=Config.BACKEND_JWT_SECRET,
                        public_key=Config.BACKEND_JWT_PUBLIC_KEY,
                        jwks_url=Config.BACKEND_JWT_JWKS_URL
                    )
                    if not token_is_valid:
                        _write_bootstrap_trace(trace_path, "Backend token failed signature verification")
                        logger.warning(
                            "Backend JWT token failed signature verification. "
                            "Token will be rejected. Please refresh your backend token."
                        )
                        # Clear invalid token
                        backend_token = None
                else:
                    # No verification key configured, only check expiration
                    token_is_valid = True
                    _write_bootstrap_trace(trace_path, "Backend token expiration check passed (signature verification not configured)")
            else:
                _write_bootstrap_trace(trace_path, "Backend token expired")
        _write_bootstrap_trace(trace_path, f"Backend token valid: {token_is_valid}")

    _write_bootstrap_trace(trace_path, "Bootstrap complete")
    return CredentialBootstrapResult(
        openai_api_key=openai_api_key,
        backend_token=backend_token,
        backend_login_email=backend_login_email
    )

