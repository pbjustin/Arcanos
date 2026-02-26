"""
ARCANOS Configuration Manager
Loads and validates environment variables with sensible defaults.
Uses a user-writable data dir for configuration, logs, and crash reports.
"""

import sys
from pathlib import Path
from typing import Optional

from .env import (
    bootstrap_runtime_env,
    get_env,
    get_env_bool,
    get_env_float,
    get_env_int,
    get_env_path,
    get_fallback_env_path,
    get_primary_env_path,
    get_runtime_base_dir,
)

# Note: Removed PyInstaller frozen EXE detection - CLI agent runs as Python application
bootstrap_runtime_env()

BASE_DIR: Path = get_runtime_base_dir()
PRIMARY_ENV_PATH = get_primary_env_path()
FALLBACK_ENV_PATH = get_fallback_env_path()
ENV_PATHS = [PRIMARY_ENV_PATH] + (
    [FALLBACK_ENV_PATH]
    if FALLBACK_ENV_PATH and FALLBACK_ENV_PATH != PRIMARY_ENV_PATH
    else []
)
ENV_PATH = PRIMARY_ENV_PATH


def get_backend_base_url() -> Optional[str]:
    raw = (
        get_env("ARCANOS_BACKEND_URL")
        or get_env("SERVER_URL")
        or get_env("BACKEND_URL")
    )
    if not raw:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    return trimmed.rstrip("/")


def get_automation_auth() -> tuple[str, str]:
    header_name = (get_env("ARCANOS_AUTOMATION_HEADER", "x-arcanos-automation") or "x-arcanos-automation").lower()
    secret = (get_env("ARCANOS_AUTOMATION_SECRET", "") or "").strip()
    return header_name, secret


def get_backend_token() -> Optional[str]:
    """
    Purpose: Resolve backend auth token from canonical and compatibility env keys.
    Inputs/Outputs: Reads process env and returns the first non-empty token string.
    Edge cases: Ignores blank values so whitespace-only secrets cannot be treated as valid credentials.
    """
    backend_token = (get_env("BACKEND_TOKEN") or "").strip()
    # //audit assumption: BACKEND_TOKEN is the canonical daemon credential; failure risk: stale fallback precedence; expected invariant: canonical token wins when present; handling strategy: return early.
    if backend_token:
        return backend_token

    arcanos_api_key = (get_env("ARCANOS_API_KEY") or "").strip()
    # //audit assumption: deployments may only inject ARCANOS_API_KEY; failure risk: daemon appears offline despite valid backend secret; expected invariant: compatibility fallback keeps auth functional; handling strategy: accept as fallback.
    if arcanos_api_key:
        return arcanos_api_key

    admin_key = (get_env("ADMIN_KEY") or "").strip()
    # //audit assumption: some environments reuse ADMIN_KEY for daemon auth; failure risk: hidden auth mismatch in production probes; expected invariant: final fallback remains explicit and non-empty; handling strategy: return admin key only when other keys absent.
    if admin_key:
        return admin_key

    return None


_DEBUG_LOG_PATH_OVERRIDE = get_env_path("DEBUG_LOG_PATH")


class Config:
    """Central configuration for ARCANOS daemon"""

    ENV_PATH: Path = ENV_PATH
    FALLBACK_ENV_PATH: Optional[Path] = FALLBACK_ENV_PATH
    ENV_PATHS: list[Path] = ENV_PATHS

    # ============================================
    # Required Settings
    # ============================================
    OPENAI_API_KEY: str = get_env("OPENAI_API_KEY", "") or ""

    # ============================================
    # Backend Settings
    # ============================================
    BACKEND_URL: Optional[str] = get_backend_base_url()
    BACKEND_TOKEN: Optional[str] = get_backend_token()
    BACKEND_LOGIN_EMAIL: Optional[str] = get_env("BACKEND_LOGIN_EMAIL")
    BACKEND_ALLOW_GPT_ID_AUTH: bool = get_env_bool("BACKEND_ALLOW_GPT_ID_AUTH", False)
    BACKEND_ALLOW_HTTP: bool = get_env_bool("BACKEND_ALLOW_HTTP", False)
    BACKEND_JWT_SECRET: Optional[str] = get_env("BACKEND_JWT_SECRET") or None
    BACKEND_JWT_PUBLIC_KEY: Optional[str] = get_env("BACKEND_JWT_PUBLIC_KEY") or None
    BACKEND_JWT_JWKS_URL: Optional[str] = get_env("BACKEND_JWT_JWKS_URL") or None
    BACKEND_ROUTING_MODE: str = (get_env("BACKEND_ROUTING_MODE", "hybrid") or "hybrid").lower()
    # //audit assumption: prefixes are comma-separated; risk: empty tokens; invariant: trimmed list; strategy: strip and filter.
    BACKEND_DEEP_PREFIXES: list[str] = [
        prefix.strip()
        for prefix in (get_env("BACKEND_DEEP_PREFIXES", "deep:,backend:") or "deep:,backend:").split(",")
        if prefix.strip()
    ]
    BACKEND_FALLBACK_TO_LOCAL: bool = get_env_bool("BACKEND_FALLBACK_TO_LOCAL", True)
    BACKEND_REQUEST_TIMEOUT: int = get_env_int("BACKEND_REQUEST_TIMEOUT", 15)
    BACKEND_SEND_UPDATES: bool = get_env_bool("BACKEND_SEND_UPDATES", True)
    BACKEND_CHAT_MODEL: Optional[str] = get_env("BACKEND_CHAT_MODEL") or None
    BACKEND_VISION_MODEL: Optional[str] = get_env("BACKEND_VISION_MODEL") or None
    BACKEND_TRANSCRIBE_MODEL: Optional[str] = get_env("BACKEND_TRANSCRIBE_MODEL") or None
    BACKEND_HISTORY_LIMIT: int = get_env_int("BACKEND_HISTORY_LIMIT", 8)
    BACKEND_VISION_ENABLED: bool = get_env_bool("BACKEND_VISION_ENABLED", False)
    BACKEND_TRANSCRIBE_ENABLED: bool = get_env_bool("BACKEND_TRANSCRIBE_ENABLED", False)
    # When backend would be chosen, route to backend only if confidence >= threshold; else local. 0.0=always local, 1.0=always backend when otherwise chosen.
    BACKEND_CONFIDENCE_THRESHOLD: float = get_env_float("BACKEND_CONFIDENCE_THRESHOLD", 0.5)
    REGISTRY_CACHE_TTL_MINUTES: int = get_env_int("REGISTRY_CACHE_TTL_MINUTES", 10)

    # ============================================
    # Rate Limiting
    # ============================================
    MAX_REQUESTS_PER_HOUR: int = get_env_int("MAX_REQUESTS_PER_HOUR", 60)
    MAX_TOKENS_PER_DAY: int = get_env_int("MAX_TOKENS_PER_DAY", 100000)
    MAX_COST_PER_DAY: float = get_env_float("MAX_COST_PER_DAY", 10.0)

    # ============================================
    # Feature Flags
    # ============================================
    TELEMETRY_ENABLED: bool = get_env_bool("TELEMETRY_ENABLED", False)
    SENTRY_DSN: Optional[str] = get_env("SENTRY_DSN")
    AUTO_START: bool = get_env_bool("AUTO_START", False)
    VOICE_ENABLED: bool = get_env_bool("VOICE_ENABLED", True)
    VISION_ENABLED: bool = get_env_bool("VISION_ENABLED", True)
    SPEAK_RESPONSES: bool = get_env_bool("SPEAK_RESPONSES", False)
    STREAM_RESPONSES: bool = get_env_bool("STREAM_RESPONSES", True)

    # ============================================
    # AI Model Settings
    # ============================================
    OPENAI_MODEL: str = get_env("OPENAI_MODEL", "gpt-4.1-mini") or "gpt-4.1-mini"
    OPENAI_VISION_MODEL: str = get_env("OPENAI_VISION_MODEL", "gpt-4o") or "gpt-4o"
    OPENAI_TRANSCRIBE_MODEL: str = get_env("OPENAI_TRANSCRIBE_MODEL", "whisper-1") or "whisper-1"
    OPENAI_IMAGE_MODEL: str = get_env("OPENAI_IMAGE_MODEL", "dall-e-3") or "dall-e-3"
    TEMPERATURE: float = get_env_float("TEMPERATURE", 0.7)
    MAX_TOKENS: int = get_env_int("MAX_TOKENS", 2048)
    REQUEST_TIMEOUT: int = get_env_int("REQUEST_TIMEOUT", 30)

    # ============================================
    # Storage Paths
    # ============================================
    BASE_DIR: Path = BASE_DIR  # module-level resolved base dir (frozen/user data or project root fallback)
    MEMORY_FILE: Path = BASE_DIR / (get_env("MEMORY_FILE", "memories.json") or "memories.json")
    LOG_DIR: Path = BASE_DIR / (get_env("LOG_DIR", "logs") or "logs")
    # Debug log for instrumentation; override with DEBUG_LOG_PATH env (absolute path) for portability.
    DEBUG_LOG_PATH: Path = (
        _DEBUG_LOG_PATH_OVERRIDE
        if _DEBUG_LOG_PATH_OVERRIDE
        else (BASE_DIR / (get_env("LOG_DIR", "logs") or "logs") / "debug.log")
    )
    SCREENSHOT_DIR: Path = BASE_DIR / (get_env("SCREENSHOT_DIR", "screenshots") or "screenshots")
    CRASH_REPORTS_DIR: Path = BASE_DIR / "crash_reports"
    TELEMETRY_DIR: Path = BASE_DIR / "telemetry"

    # ============================================
    # Security Settings
    # ============================================
    # Run shell commands with elevation (UAC on Windows, sudo on Unix) so admin-required tasks work. Prompt per run when True.
    RUN_ELEVATED: bool = get_env_bool("RUN_ELEVATED", False)
    # Prompt "Do you confirm this action?" before sensitive daemon commands (run, mouse, keyboard, etc.). Set false to skip.
    CONFIRM_SENSITIVE_ACTIONS: bool = (get_env("CONFIRM_SENSITIVE_ACTIONS", "true") or "true").strip().lower() in ("true", "1", "yes")
    ALLOW_DANGEROUS_COMMANDS: bool = get_env_bool("ALLOW_DANGEROUS_COMMANDS", False)
    COMMAND_WHITELIST: list[str] = [
        cmd.strip() for cmd in (get_env("COMMAND_WHITELIST", "") or "").split(",") if cmd.strip()
    ]
    COMMAND_BLACKLIST: list[str] = [
        cmd.strip() for cmd in (get_env("COMMAND_BLACKLIST", "format,cipher,takeown") or "format,cipher,takeown").split(",") if cmd.strip()
    ]

    # Default dangerous commands
    DEFAULT_DANGEROUS_COMMANDS: list[str] = [
        "rm -rf", "del /f", "format", "diskpart", "reg delete",
        "shutdown", "restart", "taskkill /f", "cipher /w"
    ]

    # ============================================
    # UI Settings
    # ============================================
    COLOR_SCHEME: str = get_env("COLOR_SCHEME", "dark") or "dark"
    SHOW_WELCOME: bool = get_env_bool("SHOW_WELCOME", True)
    SHOW_STATS: bool = get_env_bool("SHOW_STATS", True)

    # ============================================
    # Version & Update checker
    # ============================================
    VERSION: str = "1.1.2"
    APP_NAME: str = "ARCANOS"
    # GitHub "owner/repo" for releases. If set, the app checks for updates on startup.
    GITHUB_RELEASES_REPO: Optional[str] = get_env("GITHUB_RELEASES_REPO") or None

    # ============================================
    # Developer/Debug Settings
    # ============================================
    IDE_AGENT_DEBUG: bool = (get_env("IDE_AGENT_DEBUG", "") or "").lower() in ("1", "true", "yes")
    DAEMON_DEBUG_PORT: int = get_env_int("DAEMON_DEBUG_PORT", 0)
    # New debug server config (prefer these over legacy envs when set)
    DEBUG_SERVER_ENABLED: bool = (get_env("DEBUG_SERVER_ENABLED", "") or "").lower() in ("1", "true", "yes")
    DEBUG_SERVER_PORT: int = get_env_int("DEBUG_SERVER_PORT", 9999)
    DEBUG_SERVER_LOG_LEVEL: str = get_env("DEBUG_SERVER_LOG_LEVEL", "INFO") or "INFO"
    DEBUG_SERVER_RATE_LIMIT: int = get_env_int("DEBUG_SERVER_RATE_LIMIT", 60)
    DEBUG_SERVER_METRICS_ENABLED: bool = get_env_bool("DEBUG_SERVER_METRICS_ENABLED", True)
    # WARNING: Enabling CORS on unauthenticated debug server is a security risk.
    # Only enable if you have implemented authentication or are in a secure development environment.
    DEBUG_SERVER_CORS_ENABLED: bool = get_env_bool("DEBUG_SERVER_CORS_ENABLED", False)
    # Security: Disable token-in-query by default (headers-only auth). Set to true to allow ?token= for development.
    DEBUG_SERVER_ALLOW_QUERY_TOKEN: bool = get_env_bool("DEBUG_SERVER_ALLOW_QUERY_TOKEN", False)
    DEBUG_SERVER_LOG_RETENTION_DAYS: int = get_env_int("DEBUG_SERVER_LOG_RETENTION_DAYS", 7)
    # Security: Authentication token for debug server (required for non-read-only endpoints)
    # Generate a secure random token: python -c "import secrets; print(secrets.token_urlsafe(32))"
    DEBUG_SERVER_TOKEN: Optional[str] = get_env("DEBUG_SERVER_TOKEN") or None
    # Security: Allow unauthenticated access to debug server (default: false, only for development)
    DEBUG_SERVER_ALLOW_UNAUTHENTICATED: bool = get_env_bool("DEBUG_SERVER_ALLOW_UNAUTHENTICATED", False)
    
    # ============================================
    # Daemon Settings
    # ============================================
    # Heartbeat interval for daemon (seconds)
    DAEMON_HEARTBEAT_INTERVAL_SECONDS: int = get_env_int("DAEMON_HEARTBEAT_INTERVAL_SECONDS", 60)
    # Command poll interval for daemon (seconds)
    DAEMON_COMMAND_POLL_INTERVAL_SECONDS: int = get_env_int("DAEMON_COMMAND_POLL_INTERVAL_SECONDS", 30)
    # Shell override for terminal commands
    ARCANOS_SHELL: Optional[str] = get_env("ARCANOS_SHELL") or None
    
    # ============================================
    # OpenAI Base URL (for custom endpoints)
    # ============================================
    OPENAI_BASE_URL: Optional[str] = get_env("OPENAI_BASE_URL") or get_env("OPENAI_API_BASE_URL") or get_env("OPENAI_API_BASE") or None

    @classmethod
    def validate(cls) -> tuple[bool, list[str]]:
        """
        Validate configuration and return (is_valid, errors)
        """
        errors = []

        # Check required settings
        if not cls.OPENAI_API_KEY or cls.OPENAI_API_KEY == "":
            errors.append("OPENAI_API_KEY is required. Get one from https://platform.openai.com/api-keys")

        # Validate rate limits
        if cls.MAX_REQUESTS_PER_HOUR < 1:
            errors.append("MAX_REQUESTS_PER_HOUR must be at least 1")
        if cls.MAX_TOKENS_PER_DAY < 1000:
            errors.append("MAX_TOKENS_PER_DAY must be at least 1000")
        if cls.MAX_COST_PER_DAY < 0.01:
            errors.append("MAX_COST_PER_DAY must be at least 0.01")

        # Validate backend settings
        if cls.BACKEND_ROUTING_MODE not in {"local", "backend", "hybrid"}:
            # //audit assumption: routing mode should be valid; risk: invalid routing; invariant: allowed values; strategy: add error.
            errors.append("BACKEND_ROUTING_MODE must be one of: local, backend, hybrid")
        if cls.BACKEND_REQUEST_TIMEOUT < 1:
            # //audit assumption: backend timeout positive; risk: invalid timeout; invariant: >=1; strategy: add error.
            errors.append("BACKEND_REQUEST_TIMEOUT must be at least 1 second")
        if cls.BACKEND_HISTORY_LIMIT < 0:
            # //audit assumption: history limit non-negative; risk: invalid limit; invariant: >=0; strategy: add error.
            errors.append("BACKEND_HISTORY_LIMIT must be 0 or greater")
        if not (0.0 <= cls.BACKEND_CONFIDENCE_THRESHOLD <= 1.0):
            errors.append("BACKEND_CONFIDENCE_THRESHOLD must be between 0.0 and 1.0")
        if cls.REGISTRY_CACHE_TTL_MINUTES < 1:
            # //audit assumption: registry TTL must be positive; risk: excessive fetches; invariant: >=1; strategy: add error.
            errors.append("REGISTRY_CACHE_TTL_MINUTES must be at least 1")

        # Validate AI settings
        if not (0.0 <= cls.TEMPERATURE <= 2.0):
            errors.append("TEMPERATURE must be between 0.0 and 2.0")
        if cls.MAX_TOKENS < 10:
            errors.append("MAX_TOKENS must be at least 10")
        if cls.REQUEST_TIMEOUT < 5:
            errors.append("REQUEST_TIMEOUT must be at least 5 seconds")

        # Create directories
        for directory in [cls.LOG_DIR, cls.SCREENSHOT_DIR, cls.CRASH_REPORTS_DIR, cls.TELEMETRY_DIR]:
            directory.mkdir(parents=True, exist_ok=True)

        return len(errors) == 0, errors

    @classmethod
    def get_dangerous_commands(cls) -> list[str]:
        """Get list of dangerous commands considering whitelist"""
        if cls.COMMAND_WHITELIST:
            return []  # Whitelist overrides everything
        return cls.DEFAULT_DANGEROUS_COMMANDS + cls.COMMAND_BLACKLIST


# Validate on import (non-fatal - allows importing config for reading)
is_valid, validation_errors = Config.validate()
if not is_valid:
    print("Configuration Errors:")
    for error in validation_errors:
        print(f"   - {error}")
    print("\nCheck your .env file and fix the errors above.")


def validate_required_config(exit_on_error: bool = True) -> bool:
    """
    Fail-fast validation for required configuration.
    Exits with code 1 if required vars are missing (unless exit_on_error=False).
    
    Args:
        exit_on_error: If True, call sys.exit(1) on validation failure
        
    Returns:
        True if valid, False if invalid (only returned if exit_on_error=False)
    """
    is_valid, errors = Config.validate()
    
    if not is_valid:
        print("[❌ CONFIG VALIDATION FAILED]")
        print("Required configuration is missing or invalid:")
        for error in errors:
            print(f"  - {error}")
        print("\nApplication cannot start. Please set the required variables.")
        
        if exit_on_error:
            sys.exit(1)
        return False
    
    return True
