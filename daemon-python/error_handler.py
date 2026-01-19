"""
Error Handler for ARCANOS
Centralized error handling with user-friendly messages and optional telemetry.
"""

import sys
import logging
from typing import Callable, Any
from functools import wraps
from config import Config

# Optional Sentry integration
try:
    import sentry_sdk
    SENTRY_AVAILABLE = True
except ImportError:
    SENTRY_AVAILABLE = False

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
        """Initialize error handling (Sentry if enabled)"""
        if cls._initialized:
            return

        if Config.TELEMETRY_ENABLED and Config.SENTRY_DSN and SENTRY_AVAILABLE:
            try:
                sentry_sdk.init(
                    dsn=Config.SENTRY_DSN,
                    traces_sample_rate=0.1,
                    environment="production",
                    release=f"arcanos@{Config.VERSION}"
                )
                cls._initialized = True
            except Exception:
                pass  # Fail silently if Sentry init fails

    @staticmethod
    def handle_exception(e: Exception, context: str = "") -> str:
        """
        Handle an exception and return user-friendly message
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

        # Log to Sentry if enabled
        if Config.TELEMETRY_ENABLED and SENTRY_AVAILABLE:
            try:
                with sentry_sdk.push_scope() as scope:
                    scope.set_context("error_context", {"context": context})
                    sentry_sdk.capture_exception(e)
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
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs) -> Any:
            try:
                return func(*args, **kwargs)
            except KeyboardInterrupt:
                print("\n👋 Goodbye!")
                sys.exit(0)
            except Exception as e:
                error_msg = ErrorHandler.handle_exception(e, context or func.__name__)
                print(error_msg)
                ErrorHandler.log_error(e, context or func.__name__)
                return None
        return wrapper
    return decorator


# Initialize on import if telemetry enabled
if Config.TELEMETRY_ENABLED:
    ErrorHandler.initialize()
