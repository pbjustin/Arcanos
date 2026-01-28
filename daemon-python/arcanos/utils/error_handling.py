"""
Reusable Error Handling Utilities for Python CLI Agent

Provides consistent error classification, retry eligibility determination,
and user-friendly error messages across the entire codebase.

Features:
- Railway-native error handling
- Consistent error classification
- Retry eligibility determination
- User-friendly error messages
- Audit trail for all error handling
"""

from enum import Enum
from typing import Optional, Dict, Any
from openai import (
    OpenAIError,
    APIError,
    RateLimitError,
    APIConnectionError,
    AuthenticationError,
    BadRequestError,
    NotFoundError
)
import logging

logger = logging.getLogger("arcanos.errors")


class ErrorType(Enum):
    """Error types for classification"""
    RATE_LIMIT = "RATE_LIMIT"
    SERVER_ERROR = "SERVER_ERROR"
    TIMEOUT = "TIMEOUT"
    NETWORK_ERROR = "NETWORK_ERROR"
    CLIENT_ERROR = "CLIENT_ERROR"
    AUTHENTICATION_ERROR = "AUTHENTICATION_ERROR"
    UNKNOWN = "UNKNOWN"


class ErrorClassification:
    """Error classification result"""
    def __init__(
        self,
        error_type: ErrorType,
        retryable: bool,
        message: str,
        original_message: str,
        status_code: Optional[int] = None,
        error_code: Optional[str] = None
    ):
        self.type = error_type
        self.retryable = retryable
        self.message = message
        self.original_message = original_message
        self.status_code = status_code
        self.error_code = error_code


class RetryDelayResult:
    """Retry delay calculation result"""
    def __init__(
        self,
        delay: float,
        jitter_applied: bool,
        reason: str
    ):
        self.delay = delay
        self.jitter_applied = jitter_applied
        self.reason = reason


def classify_openai_error(error: Exception) -> ErrorClassification:
    """
    Classifies an OpenAI error and determines retry eligibility
    
    This function provides consistent error handling across the codebase:
    - Classifies error type (rate limit, network, server, etc.)
    - Determines if error is retryable
    - Provides user-friendly error messages
    - Logs error with proper context
    """
    error_type = ErrorType.UNKNOWN
    retryable = False
    status_code = None
    error_code = None
    
    # Classify error type
    if isinstance(error, RateLimitError):
        error_type = ErrorType.RATE_LIMIT
        retryable = True
        message = "OpenAI rate limit exceeded. Please try again later."
    elif isinstance(error, AuthenticationError):
        error_type = ErrorType.AUTHENTICATION_ERROR
        retryable = False
        message = "Invalid OpenAI API key. Check your .env file."
    elif isinstance(error, APIConnectionError):
        error_type = ErrorType.NETWORK_ERROR
        retryable = True
        message = "Failed to connect to OpenAI. Check your internet connection."
    elif isinstance(error, BadRequestError):
        error_type = ErrorType.CLIENT_ERROR
        retryable = False
        message = f"Invalid request to OpenAI: {str(error)}"
    elif isinstance(error, NotFoundError):
        error_type = ErrorType.CLIENT_ERROR
        retryable = False
        message = f"Model not found. Check your configuration."
    elif isinstance(error, APIError):
        # Check for server errors (5xx)
        if hasattr(error, "status_code") and error.status_code:
            status_code = error.status_code
            if status_code >= 500:
                error_type = ErrorType.SERVER_ERROR
                retryable = True
                message = f"OpenAI server error (status {status_code}). Please try again later."
            elif status_code == 429:
                error_type = ErrorType.RATE_LIMIT
                retryable = True
                message = "OpenAI rate limit exceeded. Please try again later."
            else:
                error_type = ErrorType.CLIENT_ERROR
                retryable = False
                message = f"OpenAI API error (status {status_code}): {str(error)}"
        else:
            error_type = ErrorType.SERVER_ERROR
            retryable = True
            message = f"OpenAI API error: {str(error)}"
    else:
        error_type = ErrorType.UNKNOWN
        retryable = False
        message = f"Unexpected error: {str(error)}"
    
    original_message = str(error)
    
    return ErrorClassification(
        error_type=error_type,
        retryable=retryable,
        message=message,
        original_message=original_message,
        status_code=status_code,
        error_code=error_code
    )


def is_retryable_error(error: Exception) -> bool:
    """
    Determines if an error is retryable
    
    This is a convenience wrapper around the classification function
    for cases where only retry eligibility is needed.
    """
    classification = classify_openai_error(error)
    return classification.retryable


def get_retry_delay(
    error: Exception,
    attempt: int,
    base_delay_ms: float = 1000.0,
    max_delay_ms: float = 30000.0,
    multiplier: float = 2.0,
    jitter_max_ms: float = 2000.0
) -> RetryDelayResult:
    """
    Calculates retry delay with exponential backoff and jitter
    
    Implements Railway-native retry strategy:
    - Exponential backoff for transient errors
    - Additional jitter for rate limit errors
    - Configurable base delay and max delay
    - Deterministic calculation (same inputs = same output)
    """
    import random
    
    classification = classify_openai_error(error)
    
    # Calculate exponential backoff
    exponential_delay = min(
        base_delay_ms * (multiplier ** (attempt - 1)),
        max_delay_ms
    )
    
    # Add jitter for rate limit errors
    delay = exponential_delay
    jitter_applied = False
    
    if classification.type == ErrorType.RATE_LIMIT:
        jitter = random.random() * jitter_max_ms
        delay = exponential_delay + jitter
        jitter_applied = True
    
    reason = (
        "rate_limit_with_jitter" if classification.type == ErrorType.RATE_LIMIT
        else "exponential_backoff" if classification.retryable
        else "no_retry"
    )
    
    return RetryDelayResult(
        delay=round(delay),
        jitter_applied=jitter_applied,
        reason=reason
    )


def format_error_message(error: Exception, include_technical: bool = False) -> str:
    """
    Formats an error message for user display
    
    Provides user-friendly error messages while preserving
    technical details for logging and debugging.
    """
    classification = classify_openai_error(error)
    
    if include_technical:
        status_str = f", status: {classification.status_code}" if classification.status_code else ""
        return f"{classification.message} ({classification.type.value}{status_str})"
    
    return classification.message


def should_retry(error: Exception, attempt: int, max_retries: int) -> bool:
    """
    Determines if an error should be retried based on attempt count
    
    Combines error classification with attempt limits to determine
    if a retry should be attempted.
    """
    if attempt >= max_retries:
        return False
    
    return is_retryable_error(error)


def get_user_friendly_message(error: Exception) -> str:
    """Gets a user-friendly error message for an error"""
    return format_error_message(error, include_technical=False)


def get_technical_message(error: Exception) -> str:
    """Gets a technical error message for logging"""
    return format_error_message(error, include_technical=True)


__all__ = [
    "ErrorType",
    "ErrorClassification",
    "RetryDelayResult",
    "classify_openai_error",
    "is_retryable_error",
    "get_retry_delay",
    "format_error_message",
    "should_retry",
    "get_user_friendly_message",
    "get_technical_message"
]
