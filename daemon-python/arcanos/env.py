"""
Runtime environment access and hydration for ARCANOS daemon.

This module is the canonical runtime boundary for:
- Loading .env files (primary/fallback/override).
- Reading typed environment values.
- Updating process env values for controlled runtime overrides.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from .config_paths import _get_fallback_env_path, _get_primary_env_path, _resolve_base_dir

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    load_dotenv = None


_BASE_DIR = _resolve_base_dir()
_PRIMARY_ENV_PATH = _get_primary_env_path(_BASE_DIR)
_FALLBACK_ENV_PATH = _get_fallback_env_path()
_ENV_PATHS = [_PRIMARY_ENV_PATH] + (
    [_FALLBACK_ENV_PATH]
    if _FALLBACK_ENV_PATH and _FALLBACK_ENV_PATH != _PRIMARY_ENV_PATH
    else []
)
_BOOTSTRAPPED = False


def _load_dotenv_fallback(path: Path, *, override: bool = False) -> None:
    """
    Purpose: Load KEY=VALUE pairs when python-dotenv is unavailable.
    Inputs/Outputs: path + override flag; mutates process env in place.
    Edge cases: Missing file is ignored; malformed lines are skipped.
    """
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
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

                #audit Assumption: explicit override controls precedence; failure risk: unintentional env clobbering; invariant: existing values kept unless override=True; handling strategy: conditional set.
                if override or key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        return
    except OSError:
        print("Warning: Failed to read .env file; environment variables may be missing.")


def bootstrap_runtime_env(force: bool = False) -> list[Path]:
    """
    Purpose: Hydrate runtime env from configured .env paths.
    Inputs/Outputs: force flag; returns loaded candidate paths.
    Edge cases: Safe to call multiple times; no-op after first load unless force=True.
    """
    global _BOOTSTRAPPED

    #audit Assumption: repeated env hydration can overwrite test-local mutations; failure risk: flaky tests/runtime drift; invariant: bootstrap once by default; handling strategy: guarded one-time load unless forced.
    if _BOOTSTRAPPED and not force:
        return list(_ENV_PATHS)

    for env_path in _ENV_PATHS:
        if load_dotenv is not None:
            load_dotenv(dotenv_path=env_path)
        else:
            _load_dotenv_fallback(env_path, override=False)

    override_path_raw = os.environ.get("ARCANOS_ENV_PATH", "").strip()
    if override_path_raw:
        override_path = Path(override_path_raw)
        if override_path.is_file():
            #audit Assumption: ARCANOS_ENV_PATH should override earlier env files; failure risk: wrong backend target/credentials; invariant: override file wins; handling strategy: load with override semantics.
            if load_dotenv is not None:
                load_dotenv(dotenv_path=override_path, override=True)
            else:
                _load_dotenv_fallback(override_path, override=True)

    _BOOTSTRAPPED = True
    return list(_ENV_PATHS)


def get_env(key: str, default: Optional[str] = None) -> Optional[str]:
    """
    Purpose: Read raw env value from hydrated runtime environment.
    Inputs/Outputs: env key + optional default; returns string or None.
    Edge cases: Empty strings are returned as-is to preserve explicit empty config.
    """
    bootstrap_runtime_env()
    return os.environ.get(key, default)


def set_env_value(key: str, value: str) -> None:
    """
    Purpose: Set a runtime env value intentionally.
    Inputs/Outputs: key + value; mutates process environment.
    Edge cases: Value is coerced to string before assignment.
    """
    os.environ[key] = str(value)


def get_env_bool(key: str, default: bool = False) -> bool:
    """
    Purpose: Read env value as boolean.
    Inputs/Outputs: env key + default bool; returns parsed bool.
    Edge cases: Accepts true/1/yes/on case-insensitively.
    """
    raw = get_env(key)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def get_env_int(key: str, default: int) -> int:
    """
    Purpose: Read env value as integer.
    Inputs/Outputs: env key + default int; returns parsed int.
    Edge cases: Invalid integer falls back to default.
    """
    raw = get_env(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def get_env_float(key: str, default: float) -> float:
    """
    Purpose: Read env value as float.
    Inputs/Outputs: env key + default float; returns parsed float.
    Edge cases: Invalid float falls back to default.
    """
    raw = get_env(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def get_env_path(key: str, default: Optional[Path] = None) -> Optional[Path]:
    """
    Purpose: Read env value as filesystem Path.
    Inputs/Outputs: env key + optional default Path; returns Path or None.
    Edge cases: Empty env values fall back to default.
    """
    raw = get_env(key)
    if raw is None:
        return default
    normalized = raw.strip()
    if not normalized:
        return default
    return Path(normalized)


def get_runtime_base_dir() -> Path:
    """
    Purpose: Return resolved base directory used for runtime assets.
    Inputs/Outputs: none; returns base Path.
    Edge cases: Value is pre-resolved during module import.
    """
    return _BASE_DIR


def get_primary_env_path() -> Path:
    """
    Purpose: Return primary .env path used for runtime loading.
    Inputs/Outputs: none; returns Path.
    Edge cases: Value is pre-resolved during module import.
    """
    return _PRIMARY_ENV_PATH


def get_fallback_env_path() -> Optional[Path]:
    """
    Purpose: Return fallback .env path when available.
    Inputs/Outputs: none; returns Path or None.
    Edge cases: May be None on unsupported platforms.
    """
    return _FALLBACK_ENV_PATH

