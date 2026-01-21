"""
ARCANOS Configuration Manager
Loads and validates environment variables with sensible defaults.
"""

import os
import sys
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    load_dotenv = None

from openai_key_validation import is_openai_api_key_placeholder

def _is_frozen_application() -> bool:
    """
    Purpose: Detect whether the app is running as a packaged executable.
    Inputs/Outputs: none; returns True when frozen, otherwise False.
    Edge cases: Missing sys.frozen defaults to False.
    """
    # //audit assumption: sys.frozen indicates packaged build; risk: false negatives; invariant: bool return; strategy: bool cast.
    return bool(getattr(sys, "frozen", False))


def _resolve_application_directory() -> Path:
    """
    Purpose: Resolve the directory containing app resources or the executable.
    Inputs/Outputs: none; returns application directory Path.
    Edge cases: Frozen apps use sys.executable; source runs use module directory.
    """
    if _is_frozen_application():
        # //audit assumption: frozen apps use executable location; risk: wrong path; invariant: Path resolved; strategy: use sys.executable.
        return Path(sys.executable).resolve().parent
    # //audit assumption: source runs use module directory; risk: relative path; invariant: Path resolved; strategy: resolve __file__ parent.
    return Path(__file__).resolve().parent


def _resolve_local_appdata_directory() -> Path:
    """
    Purpose: Resolve the base LocalAppData directory for the current user.
    Inputs/Outputs: none; returns LocalAppData Path.
    Edge cases: Falls back to ~/AppData/Local when LOCALAPPDATA is missing.
    """
    local_appdata = os.getenv("LOCALAPPDATA")
    if local_appdata:
        # //audit assumption: LOCALAPPDATA is valid; risk: invalid path; invariant: Path returned; strategy: use env path.
        return Path(local_appdata)
    # //audit assumption: fallback path exists on Windows; risk: missing folder; invariant: Path returned; strategy: use home-based path.
    return Path.home() / "AppData" / "Local"


def _is_portable_mode(app_dir: Path) -> bool:
    """
    Purpose: Decide if runtime should store data in the app directory.
    Inputs/Outputs: app_dir path; returns True when portable mode is enabled.
    Edge cases: Presence of .env in app_dir implies portable mode.
    """
    # //audit assumption: env values may include whitespace; risk: misread flag; invariant: normalized flag; strategy: strip env value.
    raw_flag = os.getenv("ARCANOS_PORTABLE", "").strip()
    if raw_flag:
        # //audit assumption: portable flag is boolean-like; risk: invalid value; invariant: strict match; strategy: compare to "true".
        # //audit assumption: lowercase normalization is safe; risk: locale issues; invariant: lowercase compare; strategy: lower().
        return raw_flag.lower() == "true"
    if (app_dir / ".env").exists():
        # //audit assumption: .env near app implies portable setup; risk: accidental file; invariant: portable mode on; strategy: detect file.
        return True
    # //audit assumption: no portable indicators; risk: none; invariant: default false; strategy: return False.
    return False


def _resolve_data_directory(app_dir: Path) -> Path:
    """
    Purpose: Resolve the base directory for mutable application data.
    Inputs/Outputs: app_dir path; returns data directory Path.
    Edge cases: Explicit ARCANOS_DATA_DIR overrides defaults.
    """
    # //audit assumption: override may include whitespace; risk: invalid path; invariant: normalized string; strategy: strip env value.
    raw_override = os.getenv("ARCANOS_DATA_DIR", "").strip()
    if raw_override:
        # //audit assumption: override path is intentional; risk: invalid path; invariant: Path returned; strategy: expand user path.
        return Path(raw_override).expanduser()

    if _is_portable_mode(app_dir):
        # //audit assumption: portable mode stores data with app; risk: write failure in protected dirs; invariant: app_dir used; strategy: return app_dir.
        return app_dir

    if _is_frozen_application():
        # //audit assumption: installed app should use LocalAppData; risk: permission issues in Program Files; invariant: user-writable path; strategy: LocalAppData\ARCANOS.
        return _resolve_local_appdata_directory() / "ARCANOS"

    # //audit assumption: source run stores data locally; risk: repo pollution; invariant: dev convenience; strategy: use app_dir.
    return app_dir


def _resolve_env_file_path(app_dir: Path, data_dir: Path) -> Path:
    """
    Purpose: Resolve the .env file path with override and fallback rules.
    Inputs/Outputs: app_dir and data_dir; returns .env Path.
    Edge cases: Explicit ARCANOS_ENV_PATH takes precedence.
    """
    # //audit assumption: env path may include whitespace; risk: invalid path; invariant: normalized string; strategy: strip env value.
    raw_env_path = os.getenv("ARCANOS_ENV_PATH", "").strip()
    if raw_env_path:
        # //audit assumption: override path may be relative; risk: wrong base; invariant: absolute path when possible; strategy: resolve against app_dir.
        candidate = Path(raw_env_path).expanduser()
        if not candidate.is_absolute():
            # //audit assumption: relative path should anchor to app_dir; risk: cwd surprises; invariant: anchored path; strategy: join app_dir.
            candidate = app_dir / candidate
        return candidate

    portable_env_path = app_dir / ".env"
    if portable_env_path.exists():
        # //audit assumption: portable .env should be used when present; risk: stale config; invariant: app_dir config used; strategy: select portable path.
        return portable_env_path

    # //audit assumption: default to data_dir for installed app; risk: missing file; invariant: data_dir path used; strategy: data_dir/.env.
    return data_dir / ".env"


def _resolve_data_path(data_dir: Path, raw_value: str, default_name: str) -> Path:
    """
    Purpose: Resolve a file or folder path under the data directory.
    Inputs/Outputs: data_dir, raw_value, default_name; returns resolved Path.
    Edge cases: Absolute paths bypass data_dir prefixing.
    """
    # //audit assumption: values may include whitespace; risk: unintended empty names; invariant: normalized value; strategy: strip and fallback.
    stripped_value = raw_value.strip()
    normalized_value = stripped_value if stripped_value else default_name
    candidate = Path(normalized_value)
    if candidate.is_absolute():
        # //audit assumption: absolute paths are intentional; risk: invalid path; invariant: absolute path used; strategy: return candidate.
        return candidate
    # //audit assumption: relative paths should live under data_dir; risk: inconsistent layout; invariant: data_dir prefixed; strategy: join data_dir.
    return data_dir / candidate


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

# Load .env file if python-dotenv is available.
APP_DIR = _resolve_application_directory()
DATA_DIR = _resolve_data_directory(APP_DIR)
ENV_PATH = _resolve_env_file_path(APP_DIR, DATA_DIR)
if load_dotenv is not None:
    load_dotenv(dotenv_path=ENV_PATH)
else:
    _load_dotenv_fallback(ENV_PATH)


class Config:
    """Central configuration for ARCANOS daemon"""

    # ============================================
    # Required Settings
    # ============================================
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    OPENAI_BASE_URL: Optional[str] = os.getenv("OPENAI_BASE_URL") or None
    OPENAI_ORG_ID: Optional[str] = os.getenv("OPENAI_ORG_ID") or None
    OPENAI_PROJECT_ID: Optional[str] = os.getenv("OPENAI_PROJECT_ID") or None

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
    BACKEND_WS_URL: Optional[str] = os.getenv("BACKEND_WS_URL") or None
    BACKEND_WS_PATH: str = os.getenv("BACKEND_WS_PATH", "/ws/daemon")
    IPC_HEARTBEAT_INTERVAL_SECONDS: int = int(os.getenv("IPC_HEARTBEAT_INTERVAL_SECONDS", "30"))
    IPC_RECONNECT_MAX_SECONDS: int = int(os.getenv("IPC_RECONNECT_MAX_SECONDS", "60"))
    IPC_ENABLED: bool = os.getenv("IPC_ENABLED", "true").lower() == "true"

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
    APP_DIR: Path = APP_DIR
    BASE_DIR: Path = APP_DIR
    DATA_DIR: Path = DATA_DIR
    ASSETS_DIR: Path = APP_DIR / "assets"
    ENV_PATH: Path = ENV_PATH
    MEMORY_FILE: Path = _resolve_data_path(DATA_DIR, os.getenv("MEMORY_FILE", "memories.json"), "memories.json")
    LOG_DIR: Path = _resolve_data_path(DATA_DIR, os.getenv("LOG_DIR", "logs"), "logs")
    SCREENSHOT_DIR: Path = _resolve_data_path(DATA_DIR, os.getenv("SCREENSHOT_DIR", "screenshots"), "screenshots")
    CRASH_REPORTS_DIR: Path = _resolve_data_path(DATA_DIR, os.getenv("CRASH_REPORTS_DIR", "crash_reports"), "crash_reports")
    TELEMETRY_DIR: Path = _resolve_data_path(DATA_DIR, os.getenv("TELEMETRY_DIR", "telemetry"), "telemetry")

    # ============================================
    # Security Settings
    # ============================================
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
    # Version
    # ============================================
    VERSION: str = "1.0.2"
    APP_NAME: str = "ARCANOS"

    @classmethod
    def validate(cls) -> tuple[bool, list[str]]:
        """
        Validate configuration and return (is_valid, errors)
        """
        errors = []

        # Check required settings
        if not cls.OPENAI_API_KEY or cls.OPENAI_API_KEY == "":
            # //audit assumption: key required; risk: missing API access; invariant: error raised; strategy: add error.
            errors.append("OPENAI_API_KEY is required. Get one from https://platform.openai.com/api-keys")
        elif is_openai_api_key_placeholder(cls.OPENAI_API_KEY):
            # //audit assumption: placeholder key is invalid; risk: authentication failure; invariant: error raised; strategy: add error.
            errors.append(f"OPENAI_API_KEY appears to be a placeholder. Update it in {cls.ENV_PATH}")

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
        if cls.IPC_HEARTBEAT_INTERVAL_SECONDS < 5:
            # //audit assumption: heartbeat interval positive; risk: tight loop; invariant: >=5; strategy: add error.
            errors.append("IPC_HEARTBEAT_INTERVAL_SECONDS must be at least 5 seconds")
        if cls.IPC_RECONNECT_MAX_SECONDS < 5:
            # //audit assumption: reconnect max positive; risk: tight loop; invariant: >=5; strategy: add error.
            errors.append("IPC_RECONNECT_MAX_SECONDS must be at least 5 seconds")

        # Validate AI settings
        if not (0.0 <= cls.TEMPERATURE <= 2.0):
            errors.append("TEMPERATURE must be between 0.0 and 2.0")
        if cls.MAX_TOKENS < 10:
            errors.append("MAX_TOKENS must be at least 10")
        if cls.REQUEST_TIMEOUT < 5:
            errors.append("REQUEST_TIMEOUT must be at least 5 seconds")

        # Create directories
        directories_to_create = [
            cls.LOG_DIR,
            cls.SCREENSHOT_DIR,
            cls.CRASH_REPORTS_DIR,
            cls.TELEMETRY_DIR,
            cls.ENV_PATH.parent
        ]
        for directory in directories_to_create:
            # //audit assumption: directories must exist; risk: write failures; invariant: directories created; strategy: mkdir with parents.
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
