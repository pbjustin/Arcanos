from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional


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

    # Prefer project .env when running from project (dev/local) so BACKEND_URL etc. from daemon-python/.env are used
    if (project_root / ".env").exists() and (
        (project_root / ".env.example").exists() or (project_root / "requirements.txt").exists()
    ):
        return project_root

    # User data directory for production install (no project .env or not running from project)
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


def _get_primary_env_path(base_dir: Path) -> Path:
    return base_dir / ".env"


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
