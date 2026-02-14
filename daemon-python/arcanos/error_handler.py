import sys
import logging
from typing import Callable, Any, Optional, TypeVar
T = TypeVar("T")

from functools import wraps
from .config import Config
from .utils.telemetry import get_telemetry

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
        """Initialize error handling (delegates to Telemetry)"""
        if cls._initialized:
            return

        if Config.TELEMETRY_ENABLED:
            # Telemetry class handles Sentry initialization
            get_telemetry()
            cls._initialized = True

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

        # Track error via Telemetry (which handles Sentry if enabled)
        if Config.TELEMETRY_ENABLED:
            try:
                get_telemetry().track_error(e, {"context": context})
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

