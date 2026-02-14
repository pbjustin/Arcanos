import sys
import logging
from typing import Callable, Any, Optional, TypeVar
T = TypeVar("T")

from functools import wraps
from .config import Config
from .utils.telemetry import get_telemetry, sanitize_sensitive_string

logger = logging.getLogger("arcanos")
if not logger.handlers:
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    if Config.LOG_DIR:
        log_file = Config.LOG_DIR / "errors.log"
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)


class ErrorHandler:
    """Centralized error handling and reporting"""

    _initialized = False

    @classmethod
    def initialize(cls) -> None:
        """
        Purpose: Initialize telemetry-backed error reporting one time.
        Inputs/Outputs: None; mutates class-level initialization state.
        Edge cases: Telemetry initialization failures are swallowed to avoid startup crashes.
        """
        if cls._initialized:
            return

        if Config.TELEMETRY_ENABLED:
            try:
                # //audit assumption: telemetry bootstrap can fail at import/startup time; failure risk: app fails before CLI loop starts; expected invariant: startup remains available without telemetry; handling strategy: swallow telemetry init errors and continue.
                get_telemetry()
                cls._initialized = True
            except Exception:
                cls._initialized = False

    @staticmethod
    def handle_exception(e: Exception, context: str = "") -> str:
        """
        Purpose: Convert an exception into a user-facing message and send telemetry.
        Inputs/Outputs: Exception + context string -> formatted user-friendly message.
        Edge cases: Telemetry failures are swallowed and sensitive error text is redacted.
        """
        error_type = type(e).__name__
        error_msg = str(e)

        # Map exceptions to user-friendly messages
        user_messages = {
            "ValueError": "❌ Invalid input or configuration",
            "ConnectionError": "❌ Network connection failed",
            "RuntimeError": "❌ An error occurred",
            "FileNotFoundError": "❌ File not found",
            "PermissionError": "❌ Permission denied",
            "TimeoutError": "❌ Request timed out",
            "KeyboardInterrupt": "👋 Goodbye!",
        }

        user_msg = user_messages.get(error_type, "❌ An unexpected error occurred")

        # Add specific error details if available
        if error_msg:
            full_message = f"{user_msg}: {error_msg}"
        else:
            full_message = user_msg

        # Track error via Telemetry (which handles Sentry if enabled)
        if Config.TELEMETRY_ENABLED:
            try:
                # //audit assumption: raw exception text may include secrets/PII; failure risk: sensitive data leakage to telemetry providers; expected invariant: telemetry error payload is redacted; handling strategy: sanitize message before track_error.
                sanitized_error_message = sanitize_sensitive_string(error_msg) if error_msg else error_type
                telemetry_error = Exception(sanitized_error_message)
                get_telemetry().track_error(telemetry_error, {"context": context, "error_type": error_type})
            except Exception:
                pass  # Fail silently

        return full_message

    @staticmethod
    def log_error(error: Exception, context: str = "") -> None:
        """Log error details to console (debug mode)"""
        try:
            logger.error("Context: %s Error: %s", context, error, exc_info=error)
        except Exception:
            pass


def handle_errors(context: str = ""):
    """
    Decorator to handle errors in functions
    Usage: @handle_errors("doing something")
    """
    def decorator(func: Callable[..., T]) -> Callable[..., Optional[T]]:
        @wraps(func)
        def wrapper(*args, **kwargs) -> Optional[T]:
            try:
                return func(*args, **kwargs)
            except KeyboardInterrupt:
                print("\n👋 Goodbye!")
                sys.exit(0)
            except Exception as e:
                error_string = str(e) or type(e).__name__
                
                # If the first arg is a class instance (like 'self'), try to set _last_error
                if args and hasattr(args[0], '_last_error'):
                    setattr(args[0], '_last_error', error_string)
                
                # Also log to activity buffer if available
                if args and hasattr(args[0], '_append_activity'):
                    getattr(args[0], '_append_activity')("error", error_string)

                error_msg = ErrorHandler.handle_exception(e, context or func.__name__)
                # Avoid printing for now as the main loop also prints.
                # This could be configurable if needed.
                # print(error_msg) 
                ErrorHandler.log_error(e, context or func.__name__)
                return None
        return wrapper
    return decorator


# Initialize on import if telemetry enabled
if Config.TELEMETRY_ENABLED:
    ErrorHandler.initialize()

