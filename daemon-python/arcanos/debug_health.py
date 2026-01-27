import os
import shutil
import time
from typing import Any, Dict, Optional

try:
    import psutil  # type: ignore[import]
except Exception:  # pragma: no cover - optional dependency
    psutil = None  # type: ignore[assignment]

from .config import Config


def _backend_healthy(cli_instance: Any) -> bool:
    client = getattr(cli_instance, "backend_client", None)
    return client is not None


def _log_dir_writable() -> bool:
    try:
        test_path = Config.LOG_DIR / ".health_check"
        Config.LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(test_path, "w", encoding="utf-8") as handle:
            handle.write(str(time.time()))
        test_path.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def _memory_ok(threshold_mb: int = 100) -> bool:
    if psutil is None:
        # Fallback: use shutil and os if available
        try:
            total, used, free = shutil.disk_usage(os.getcwd())
            return free >= threshold_mb * 1024 * 1024
        except OSError:
            return True
    try:
        mem = psutil.virtual_memory()
        return mem.available >= threshold_mb * 1024 * 1024
    except Exception:
        return True


def liveness() -> Dict[str, Any]:
    """Always-true liveness probe if process is running."""
    return {
        "ok": True,
        "ts": time.time(),
        "version": Config.VERSION,
    }


def readiness(cli_instance: Any) -> Dict[str, Any]:
    """
    Readiness probe based on CLI initialization and dependencies.
    """
    checks: Dict[str, bool] = {
        "cli_initialized": cli_instance is not None,
        "backend_healthy": _backend_healthy(cli_instance) if Config.BACKEND_URL else True,
        "log_dir_writable": _log_dir_writable(),
        "memory_ok": _memory_ok(),
    }
    all_ok = all(checks.values())
    return {
        "ok": all_ok,
        "checks": checks,
        "ts": time.time(),
        "version": Config.VERSION,
    }

