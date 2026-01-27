"""
ARCANOS Configuration Manager
Loads and validates environment variables with sensible defaults.
Uses a user-writable data dir for configuration, logs, and crash reports.
"""

import os
import sys
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    load_dotenv = None

# Note: Removed PyInstaller frozen EXE detection - CLI agent runs as Python application


def _get_user_data_dir() -> Optional[Path]:
    """
    Purpose: Resolve a user-writable base dir for .env, logs, crash_reports.
    Inputs/Outputs: None; returns a platform-specific user data directory, or None on failure.
    Edge cases: Creates the directory; returns None if home directory cannot be found or mkdir fails.
    """
    try:
        if sys.platform == "win32":
            root = (
                os.environ.get("LOCALAPPDATA")
                or os.environ.get("APPDATA")
                or os.environ.get("USERPROFILE")
                or ""
            )
            if not root:
                return None
            p = Path(root) / "ARCANOS"
        elif sys.platform == "darwin":  # macOS
            p = Path.home() / "Library" / "Application Support" / "ARCANOS"
        else:  # Linux and other Unix-like
            p = Path.home() / ".local" / "share" / "ARCANOS"

        p.mkdir(parents=True, exist_ok=True)
        return p
    except (OSError, RuntimeError):  # RuntimeError for Path.home() if no home dir
        return None


def _resolve_base_dir() -> Path:
    """
    Purpose: Resolve the base directory for data, logs, and .env resolution.
    Inputs/Outputs: None; returns a writable Path.
    Edge cases: Falls back to package directory if user data dir cannot be created.
    """
    package_dir = Path(__file__).resolve().parent
    project_root = package_dir.parent

    # Prefer user data directory for production use
    user_dir = _get_user_data_dir()
    if user_dir and (user_dir / ".env").exists():
        # If .env exists in user data dir, prefer it (production install)
        return user_dir

    # //audit assumption: dev installs keep config at daemon-python root or package dir; risk: missing files; invariant: use project root when markers exist; strategy: check both locations.
    if (project_root / ".env.example").exists() or (project_root / "requirements.txt").exists():
        return project_root
    # Also check package directory (arcanos) for markers
    package_dir = project_root / "arcanos"
    if package_dir.exists() and ((package_dir / ".env.example").exists() or (package_dir / "requirements.txt").exists()):
        return package_dir.parent if package_dir.name == "arcanos" else package_dir

    user_dir = _get_user_data_dir()
    if user_dir:
        # //audit assumption: user dir available; risk: permission errors; invariant: user dir used; strategy: fallback to user dir.
        return user_dir

    # //audit assumption: fallback to package dir; risk: read-only install; invariant: best-effort; strategy: use package dir.
    return package_dir


BASE_DIR: Path = _resolve_base_dir()


def _load_dotenv_fallback(path: Path) -> None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if not key:
                    continue
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]
                if key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        return
    except OSError:
        print("Warning: Failed to read .env file; environment variables may be missing.")

def _get_primary_env_path() -> Path:
    return BASE_DIR / ".env"


def _get_fallback_env_path() -> Optional[Path]:
    """
    Purpose: Resolve a cross-platform fallback .env path.
    Inputs/Outputs: None; returns a candidate Path or None.
    Edge cases: Returns None when user data dir unavailable.
    """
    user_data_dir = _get_user_data_dir()
    if user_data_dir:
        # //audit assumption: user data dir available; risk: permission issues; invariant: fallback path derived; strategy: return .env under data dir.
        return user_data_dir / ".env"

    return None


# Load .env file if python-dotenv is available.
PRIMARY_ENV_PATH = _get_primary_env_path()
FALLBACK_ENV_PATH = _get_fallback_env_path()
ENV_PATHS = [PRIMARY_ENV_PATH] + (
    [FALLBACK_ENV_PATH]
    if FALLBACK_ENV_PATH and FALLBACK_ENV_PATH != PRIMARY_ENV_PATH
    else []
)
ENV_PATH = PRIMARY_ENV_PATH

if load_dotenv is not None:
    for env_path in ENV_PATHS:
        load_dotenv(dotenv_path=env_path)
else:
    for env_path in ENV_PATHS:
        _load_dotenv_fallback(env_path)


class Config:
    """Central configuration for ARCANOS daemon"""

    ENV_PATH: Path = ENV_PATH
    FALLBACK_ENV_PATH: Optional[Path] = FALLBACK_ENV_PATH
    ENV_PATHS: list[Path] = ENV_PATHS

    # ============================================
    # Required Settings
    # ============================================
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")

    # ============================================
    # Backend Settings
    # ============================================
    BACKEND_URL: Optional[str] = os.getenv("BACKEND_URL")
    BACKEND_TOKEN: Optional[str] = os.getenv("BACKEND_TOKEN")
    BACKEND_LOGIN_EMAIL: Optional[str] = os.getenv("BACKEND_LOGIN_EMAIL")
    BACKEND_ROUTING_MODE: str = os.getenv("BACKEND_ROUTING_MODE", "hybrid").lower()
    # //audit assumption: prefixes are comma-separated; risk: empty tokens; invariant: trimmed list; strategy: strip and filter.
    BACKEND_DEEP_PREFIXES: list[str] = [
        prefix.strip()
        for prefix in os.getenv("BACKEND_DEEP_PREFIXES", "deep:,backend:").split(",")
        if prefix.strip()
    ]
    BACKEND_FALLBACK_TO_LOCAL: bool = os.getenv("BACKEND_FALLBACK_TO_LOCAL", "true").lower() == "true"
    BACKEND_REQUEST_TIMEOUT: int = int(os.getenv("BACKEND_REQUEST_TIMEOUT", "15"))
    BACKEND_SEND_UPDATES: bool = os.getenv("BACKEND_SEND_UPDATES", "true").lower() == "true"
    BACKEND_CHAT_MODEL: Optional[str] = os.getenv("BACKEND_CHAT_MODEL") or None
    BACKEND_VISION_MODEL: Optional[str] = os.getenv("BACKEND_VISION_MODEL") or None
    BACKEND_TRANSCRIBE_MODEL: Optional[str] = os.getenv("BACKEND_TRANSCRIBE_MODEL") or None
    BACKEND_HISTORY_LIMIT: int = int(os.getenv("BACKEND_HISTORY_LIMIT", "8"))
    BACKEND_VISION_ENABLED: bool = os.getenv("BACKEND_VISION_ENABLED", "false").lower() == "true"
    BACKEND_TRANSCRIBE_ENABLED: bool = os.getenv("BACKEND_TRANSCRIBE_ENABLED", "false").lower() == "true"
    # When backend would be chosen, route to backend only if confidence >= threshold; else local. 0.0=always local, 1.0=always backend when otherwise chosen.
    BACKEND_CONFIDENCE_THRESHOLD: float = float(os.getenv("BACKEND_CONFIDENCE_THRESHOLD", "0.5"))
    REGISTRY_CACHE_TTL_MINUTES: int = int(os.getenv("REGISTRY_CACHE_TTL_MINUTES", "10"))

    # ============================================
    # Rate Limiting
    # ============================================
    MAX_REQUESTS_PER_HOUR: int = int(os.getenv("MAX_REQUESTS_PER_HOUR", "60"))
    MAX_TOKENS_PER_DAY: int = int(os.getenv("MAX_TOKENS_PER_DAY", "100000"))
    MAX_COST_PER_DAY: float = float(os.getenv("MAX_COST_PER_DAY", "10.0"))

    # ============================================
    # Feature Flags
    # ============================================
    TELEMETRY_ENABLED: bool = os.getenv("TELEMETRY_ENABLED", "false").lower() == "true"
    SENTRY_DSN: Optional[str] = os.getenv("SENTRY_DSN")
    AUTO_START: bool = os.getenv("AUTO_START", "false").lower() == "true"
    VOICE_ENABLED: bool = os.getenv("VOICE_ENABLED", "true").lower() == "true"
    VISION_ENABLED: bool = os.getenv("VISION_ENABLED", "true").lower() == "true"
    SPEAK_RESPONSES: bool = os.getenv("SPEAK_RESPONSES", "false").lower() == "true"

    # ============================================
    # AI Model Settings
    # ============================================
    OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    OPENAI_VISION_MODEL: str = os.getenv("OPENAI_VISION_MODEL", "gpt-4o")
    OPENAI_TRANSCRIBE_MODEL: str = os.getenv("OPENAI_TRANSCRIBE_MODEL", "whisper-1")
    TEMPERATURE: float = float(os.getenv("TEMPERATURE", "0.7"))
    MAX_TOKENS: int = int(os.getenv("MAX_TOKENS", "500"))
    REQUEST_TIMEOUT: int = int(os.getenv("REQUEST_TIMEOUT", "30"))

    # ============================================
    # Storage Paths
    # ============================================
    BASE_DIR: Path = BASE_DIR  # module-level resolved base dir (frozen/user data or project root fallback)
    MEMORY_FILE: Path = BASE_DIR / os.getenv("MEMORY_FILE", "memories.json")
    LOG_DIR: Path = BASE_DIR / os.getenv("LOG_DIR", "logs")
    SCREENSHOT_DIR: Path = BASE_DIR / os.getenv("SCREENSHOT_DIR", "screenshots")
    CRASH_REPORTS_DIR: Path = BASE_DIR / "crash_reports"
    TELEMETRY_DIR: Path = BASE_DIR / "telemetry"

    # ============================================
    # Security Settings
    # ============================================
    # Run shell commands with elevation (UAC on Windows, sudo on Unix) so admin-required tasks work. Prompt per run when True.
    RUN_ELEVATED: bool = os.getenv("RUN_ELEVATED", "false").lower() == "true"
    # Prompt "Do you confirm this action?" before sensitive daemon commands (run, mouse, keyboard, etc.). Set false to skip.
    CONFIRM_SENSITIVE_ACTIONS: bool = os.getenv("CONFIRM_SENSITIVE_ACTIONS", "true").strip().lower() in ("true", "1", "yes")
    ALLOW_DANGEROUS_COMMANDS: bool = os.getenv("ALLOW_DANGEROUS_COMMANDS", "false").lower() == "true"
    COMMAND_WHITELIST: list[str] = [
        cmd.strip() for cmd in os.getenv("COMMAND_WHITELIST", "").split(",") if cmd.strip()
    ]
    COMMAND_BLACKLIST: list[str] = [
        cmd.strip() for cmd in os.getenv("COMMAND_BLACKLIST", "format,cipher,takeown").split(",") if cmd.strip()
    ]

    # Default dangerous commands
    DEFAULT_DANGEROUS_COMMANDS: list[str] = [
        "rm -rf", "del /f", "format", "diskpart", "reg delete",
        "shutdown", "restart", "taskkill /f", "cipher /w"
    ]

    # ============================================
    # UI Settings
    # ============================================
    COLOR_SCHEME: str = os.getenv("COLOR_SCHEME", "dark")
    SHOW_WELCOME: bool = os.getenv("SHOW_WELCOME", "true").lower() == "true"
    SHOW_STATS: bool = os.getenv("SHOW_STATS", "true").lower() == "true"

    # ============================================
    # Version & Update checker
    # ============================================
    VERSION: str = "1.1.2"
    APP_NAME: str = "ARCANOS"
    # GitHub "owner/repo" for releases. If set, the app checks for updates on startup.
    GITHUB_RELEASES_REPO: Optional[str] = os.getenv("GITHUB_RELEASES_REPO") or None

    # ============================================
    # Developer/Debug Settings
    # ============================================
    IDE_AGENT_DEBUG: bool = os.getenv("IDE_AGENT_DEBUG","").lower() in ("1","true","yes")
    DAEMON_DEBUG_PORT: int = int(os.getenv("DAEMON_DEBUG_PORT", "0"))
    # New debug server config (prefer these over legacy envs when set)
    DEBUG_SERVER_ENABLED: bool = os.getenv("DEBUG_SERVER_ENABLED", "").lower() in ("1", "true", "yes")
    DEBUG_SERVER_PORT: int = int(os.getenv("DEBUG_SERVER_PORT", "9999"))
    DEBUG_SERVER_LOG_LEVEL: str = os.getenv("DEBUG_SERVER_LOG_LEVEL", "INFO")
    DEBUG_SERVER_RATE_LIMIT: int = int(os.getenv("DEBUG_SERVER_RATE_LIMIT", "60"))
    DEBUG_SERVER_METRICS_ENABLED: bool = os.getenv("DEBUG_SERVER_METRICS_ENABLED", "true").lower() in ("1", "true", "yes")
    # WARNING: Enabling CORS on unauthenticated debug server is a security risk.
    # Only enable if you have implemented authentication or are in a secure development environment.
    DEBUG_SERVER_CORS_ENABLED: bool = os.getenv("DEBUG_SERVER_CORS_ENABLED", "false").lower() in ("1", "true", "yes")
    DEBUG_SERVER_LOG_RETENTION_DAYS: int = int(os.getenv("DEBUG_SERVER_LOG_RETENTION_DAYS", "7"))
    # Security: Authentication token for debug server (required for non-read-only endpoints)
    # Generate a secure random token: python -c "import secrets; print(secrets.token_urlsafe(32))"
    DEBUG_SERVER_TOKEN: Optional[str] = os.getenv("DEBUG_SERVER_TOKEN") or None

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


# Validate on import
is_valid, validation_errors = Config.validate()
if not is_valid:
    print("Configuration Errors:")
    for error in validation_errors:
        print(f"   - {error}")
    print("\nCheck your .env file and fix the errors above.")

