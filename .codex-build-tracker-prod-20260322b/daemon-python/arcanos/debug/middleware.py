import threading
import time
import uuid
from collections import defaultdict, deque
from typing import Any, Callable, Optional

from ..config import Config
from .logging import log_request, get_debug_logger
from .metrics import get_metrics


# Rate limiter: per-IP sliding window
_rate_limit_store: dict[str, deque[float]] = defaultdict(lambda: deque())
_rate_limit_lock = threading.Lock()
_RATE_LIMIT_WINDOW_SECONDS = 60  # 1 minute window


def _check_rate_limit(client_ip: str) -> tuple[bool, Optional[int]]:
    """
    Purpose: Check if client IP has exceeded rate limit.
    Inputs/Outputs: client_ip string; returns (allowed, retry_after_seconds).
    Edge cases: Returns (True, None) if allowed; (False, retry_after) if exceeded.
    """
    if Config.DEBUG_SERVER_RATE_LIMIT <= 0:
        # Rate limiting disabled
        return True, None

    now = time.time()

    with _rate_limit_lock:
        # Get request timestamps for this IP
        timestamps = _rate_limit_store[client_ip]

        # Remove timestamps outside the window
        while timestamps and timestamps[0] < now - _RATE_LIMIT_WINDOW_SECONDS:
            timestamps.popleft()

        # Check if limit exceeded
        if len(timestamps) >= Config.DEBUG_SERVER_RATE_LIMIT:
            # Calculate retry after (oldest request + window - now)
            if timestamps:
                retry_after = int(timestamps[0] + _RATE_LIMIT_WINDOW_SECONDS - now) + 1
                retry_after = max(1, retry_after)  # At least 1 second
            else:
                retry_after = _RATE_LIMIT_WINDOW_SECONDS
            return False, retry_after

        # Add current request timestamp
        timestamps.append(now)

        # Cleanup: remove old IPs (older than 2x window)
        cutoff = now - (_RATE_LIMIT_WINDOW_SECONDS * 2)
        ips_to_remove = [
            ip for ip, ts_list in _rate_limit_store.items()
            if ts_list and ts_list[-1] < cutoff
        ]
        for ip in ips_to_remove:
            del _rate_limit_store[ip]

    return True, None


def handle_request(handler: Any, endpoint: str, fn: Callable[[], None]) -> None:
    """
    Wrap a handler method with timing, logging, metrics, and rate limiting.

    - Sets handler._request_id
    - Ensures handler._last_status_code is present (via _send_response)
    - Enforces rate limiting per client IP
    """
    # Rate limit check (before processing request)
    client_ip = getattr(handler, "client_address", ("unknown",))[0]
    allowed, retry_after = _check_rate_limit(client_ip)

    if not allowed:
        # Rate limit exceeded
        handler._send_response(  # type: ignore[attr-defined]
            429,
            error=f"Rate limit exceeded. Maximum {Config.DEBUG_SERVER_RATE_LIMIT} requests per minute. Retry after {retry_after} seconds."
        )
        handler.send_header("Retry-After", str(retry_after))  # type: ignore[attr-defined]
        handler.end_headers()  # type: ignore[attr-defined]
        logger = get_debug_logger()
        logger.warning(
            f"Rate limit exceeded for IP {client_ip}",
            extra={"client_ip": client_ip, "endpoint": endpoint, "retry_after": retry_after}
        )
        return

    start = time.time()
    request_id = str(uuid.uuid4())
    setattr(handler, "_request_id", request_id)

    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        # Log unhandled exception and return generic 500
        logger = get_debug_logger()
        logger.exception(
            "Unhandled debug handler error",
            extra={
                "endpoint": endpoint,
                "request_id": request_id,
                "method": getattr(handler, "command", None),
                "path": getattr(handler, "path", None),
            },
        )
        # Fallback if handler's _send_response fails; best-effort only.
        try:
            handler._send_response(500, error="Internal Server Error")  # type: ignore[attr-defined]
        except Exception:
            pass
    finally:
        duration_ms = (time.time() - start) * 1000.0
        status_code = getattr(handler, "_last_status_code", 500)
        method = getattr(handler, "command", "GET")
        path = getattr(handler, "path", endpoint)

        if Config.DEBUG_SERVER_METRICS_ENABLED:
            get_metrics().record(endpoint, status_code, duration_ms)

        # Logging is always allowed; level controlled via config.
        log_request(method, path, status_code, duration_ms, request_id=request_id)
