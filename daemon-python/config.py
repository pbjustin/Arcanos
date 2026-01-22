"""
ARCANOS Configuration Manager
Loads and validates environment variables with sensible defaults.
"""

import os
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    load_dotenv = None

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
ENV_PATH = Path(__file__).parent / ".env"
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
    BASE_DIR: Path = Path(__file__).parent
    MEMORY_FILE: Path = BASE_DIR / os.getenv("MEMORY_FILE", "memories.json")
    LOG_DIR: Path = BASE_DIR / os.getenv("LOG_DIR", "logs")
    SCREENSHOT_DIR: Path = BASE_DIR / os.getenv("SCREENSHOT_DIR", "screenshots")
    CRASH_REPORTS_DIR: Path = BASE_DIR / "crash_reports"
    TELEMETRY_DIR: Path = BASE_DIR / "telemetry"

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
    VERSION: str = "1.0.0"
    APP_NAME: str = "ARCANOS"

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
