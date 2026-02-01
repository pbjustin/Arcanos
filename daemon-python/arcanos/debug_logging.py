import json
import logging
import logging.handlers
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .config import Config

_logger_lock = threading.Lock()
_logger: Optional[logging.Logger] = None


class JsonLogFormatter(logging.Formatter):
    """Minimal JSON formatter for debug server logs."""

    def format(self, record: logging.LogRecord) -> str:  # type: ignore[override]
        payload: Dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "level": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        # Optional extra fields (endpoint, request_id, duration_ms, status_code, etc.)
        for key in ("endpoint", "request_id", "duration_ms", "status_code", "method", "path"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value

        return json.dumps(payload, ensure_ascii=False)


def _ensure_log_dir() -> Path:
    Config.LOG_DIR.mkdir(parents=True, exist_ok=True)
    return Config.LOG_DIR


def get_debug_logger() -> logging.Logger:
    """
    Get a process-wide logger for the debug server.

    Idempotent and thread-safe; safe to call from multiple threads.
    """
    global _logger
    if _logger is not None:
        return _logger

    with _logger_lock:
        if _logger is not None:
            return _logger

        log_dir = _ensure_log_dir()
        log_path = log_dir / "debug_server.log"

        logger = logging.getLogger("arcanos.debug_server")

        # Avoid configuring multiple times if something else already did.
        if not logger.handlers:
            level_name = getattr(Config, "DEBUG_SERVER_LOG_LEVEL", "INFO").upper()
            level = getattr(logging, level_name, logging.INFO)
            logger.setLevel(level)

            handler = logging.handlers.RotatingFileHandler(
                log_path,
                maxBytes=5 * 1024 * 1024,  # 5 MB
                backupCount=getattr(Config, "DEBUG_SERVER_LOG_RETENTION_DAYS", 7),
                encoding="utf-8",
            )
            handler.setFormatter(JsonLogFormatter())
            logger.addHandler(handler)

        _logger = logger
        return logger


def log_audit_event(event_type: str, **kwargs: Any) -> None:
    """
    Purpose: Log audit events (e.g. command execution attempts) with sanitized data.
    Inputs/Outputs: event_type string and keyword arguments; writes to debug log.
    Edge cases: All kwargs are sanitized to prevent credential leakage.
    """
    logger = get_debug_logger()
    # Sanitize kwargs to prevent credential leakage
    try:
        from .utils.telemetry import sanitize_sensitive_data
        sanitized_kwargs = sanitize_sensitive_data(kwargs) if kwargs else {}
    except ImportError:
        # Fallback if telemetry not available
        sanitized_kwargs = kwargs
    logger.info(
        f"audit.{event_type}",
        extra={"event_type": event_type, **sanitized_kwargs}
    )


def log_request(
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    request_id: Optional[str] = None,
) -> None:
    """
    Convenience helper for middleware to log a completed HTTP request.
    """
    logger = get_debug_logger()
    logger.info(
        "debug request",
        extra={
            "method": method,
            "path": path,
            "status_code": status_code,
            "duration_ms": round(duration_ms, 2),
            "request_id": request_id,
        },
    )

