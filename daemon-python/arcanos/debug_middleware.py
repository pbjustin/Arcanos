import time
import uuid
from typing import Any, Callable

from .config import Config
from .debug_logging import log_request, get_debug_logger
from .debug_metrics import get_metrics


def handle_request(handler: Any, endpoint: str, fn: Callable[[], None]) -> None:
    """
    Wrap a handler method with timing, logging, and metrics.

    - Sets handler._request_id
    - Ensures handler._last_status_code is present (via _send_response)
    """
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

