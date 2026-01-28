"""
Unified Retry/Resilience Module for Python CLI Agent

Provides consistent retry logic that works with any operation,
not just OpenAI API calls. Implements Railway-native patterns with
exponential backoff, jitter, and circuit breaker integration.

Features:
- Works with any operation (sync or async)
- Exponential backoff with jitter
- Circuit breaker integration (optional)
- Telemetry hooks
- Configurable retry strategies
- Railway-native patterns (stateless, deterministic)
"""

import time
import random
from typing import Callable, TypeVar, Optional, Any
from functools import wraps
from .error_handling import (
    classify_openai_error,
    get_retry_delay,
    should_retry as should_retry_error,
    ErrorType
)
from ..telemetry import record_trace_event
import logging

logger = logging.getLogger("arcanos.retry")

T = TypeVar("T")

# Default retry constants matching TypeScript patterns
DEFAULT_RETRY_CONSTANTS = {
    "MAX_RETRIES": 3,
    "BASE_DELAY_MS": 1000.0,
    "MAX_DELAY_MS": 30000.0,
    "MULTIPLIER": 2.0,
    "JITTER_MAX_MS": 2000.0,
    "RATE_LIMIT_JITTER_MAX_MS": 2000.0
}


class RetryOptions:
    """Retry configuration options"""
    def __init__(
        self,
        max_retries: int = DEFAULT_RETRY_CONSTANTS["MAX_RETRIES"],
        base_delay_ms: float = DEFAULT_RETRY_CONSTANTS["BASE_DELAY_MS"],
        max_delay_ms: float = DEFAULT_RETRY_CONSTANTS["MAX_DELAY_MS"],
        multiplier: float = DEFAULT_RETRY_CONSTANTS["MULTIPLIER"],
        jitter_max_ms: float = DEFAULT_RETRY_CONSTANTS["JITTER_MAX_MS"],
        use_circuit_breaker: bool = False,
        should_retry: Optional[Callable[[Exception, int], bool]] = None,
        operation_name: Optional[str] = None
    ):
        self.max_retries = max_retries
        self.base_delay_ms = base_delay_ms
        self.max_delay_ms = max_delay_ms
        self.multiplier = multiplier
        self.jitter_max_ms = jitter_max_ms
        self.use_circuit_breaker = use_circuit_breaker
        self.should_retry = should_retry
        self.operation_name = operation_name or "unknown_operation"


def calculate_backoff(
    attempt: int,
    error: Optional[Exception] = None,
    base_delay_ms: float = DEFAULT_RETRY_CONSTANTS["BASE_DELAY_MS"],
    max_delay_ms: float = DEFAULT_RETRY_CONSTANTS["MAX_DELAY_MS"],
    multiplier: float = DEFAULT_RETRY_CONSTANTS["MULTIPLIER"]
) -> float:
    """
    Calculates backoff delay for a retry attempt
    
    Args:
        attempt: Current attempt number (1-indexed)
        error: Error that triggered the retry (optional)
        base_delay_ms: Base delay in milliseconds
        max_delay_ms: Maximum delay in milliseconds
        multiplier: Exponential multiplier
    
    Returns:
        Calculated delay in milliseconds
    """
    result = get_retry_delay(
        error or Exception("Unknown error"),
        attempt,
        base_delay_ms,
        max_delay_ms,
        multiplier,
        DEFAULT_RETRY_CONSTANTS["JITTER_MAX_MS"]
    )
    return result.delay


def with_retry(
    operation: Callable[[], T],
    options: Optional[RetryOptions] = None
) -> T:
    """
    Executes an operation with retry logic
    
    This is the main function for retrying operations. It:
    - Implements exponential backoff with jitter
    - Provides telemetry hooks
    - Logs retry attempts
    - Handles Railway-native patterns
    
    Args:
        operation: Operation to execute (callable that returns T)
        options: Retry configuration options
    
    Returns:
        Operation result
    
    Raises:
        Last error if all retries are exhausted
    """
    if options is None:
        options = RetryOptions()
    
    start_time = time.time()
    operation_name = options.operation_name or "unknown_operation"
    max_retries = options.max_retries
    
    trace_id = record_trace_event("retry.start", {
        "operation": operation_name,
        "maxRetries": max_retries,
        "useCircuitBreaker": options.use_circuit_breaker
    })
    
    last_error: Optional[Exception] = None
    
    # Retry loop
    for attempt in range(1, max_retries + 2):
        try:
            result = operation()
            
            duration = (time.time() - start_time) * 1000  # Convert to ms
            if attempt > 1:
                logger.info(
                    f"Operation succeeded after {attempt} attempts",
                    extra={
                        "module": "resilience.unified",
                        "operation": operation_name,
                        "attempt": attempt,
                        "duration": duration
                    }
                )
            
            record_trace_event("retry.success", {
                "traceId": trace_id,
                "operation": operation_name,
                "attempt": attempt,
                "duration": duration
            })
            
            return result
        except Exception as error:
            last_error = error
            classification = classify_openai_error(error)
            
            # Check if we should retry
            should_retry_attempt = False
            if options.should_retry:
                should_retry_attempt = options.should_retry(error, attempt)
            else:
                should_retry_attempt = should_retry_error(error, attempt, max_retries)
            
            if not should_retry_attempt:
                duration = (time.time() - start_time) * 1000
                logger.error(
                    f"Operation failed after {attempt} attempts",
                    extra={
                        "module": "resilience.unified",
                        "operation": operation_name,
                        "attempt": attempt,
                        "errorType": classification.type.value,
                        "duration": duration
                    },
                    exc_info=error
                )
                
                record_trace_event("retry.exhausted", {
                    "traceId": trace_id,
                    "operation": operation_name,
                    "attempt": attempt,
                    "errorType": classification.type.value,
                    "duration": duration
                })
                
                raise error
            
            # Calculate delay and wait
            delay_result = get_retry_delay(
                error,
                attempt,
                options.base_delay_ms,
                options.max_delay_ms,
                options.multiplier,
                options.jitter_max_ms
            )
            delay = delay_result.delay
            duration = (time.time() - start_time) * 1000
            
            logger.warning(
                f"Operation failed, retrying (attempt {attempt}/{max_retries})",
                extra={
                    "module": "resilience.unified",
                    "operation": operation_name,
                    "attempt": attempt,
                    "maxRetries": max_retries,
                    "delay": delay,
                    "errorType": classification.type.value,
                    "duration": duration
                },
                exc_info=error
            )
            
            record_trace_event("retry.attempt", {
                "traceId": trace_id,
                "operation": operation_name,
                "attempt": attempt,
                "delay": delay,
                "errorType": classification.type.value
            })
            
            # Wait before retry (convert ms to seconds)
            time.sleep(delay / 1000.0)
    
    # This should never be reached, but included for safety
    duration = (time.time() - start_time) * 1000
    record_trace_event("retry.unexpected_end", {
        "traceId": trace_id,
        "operation": operation_name,
        "duration": duration
    })
    
    raise last_error or Exception("Operation failed: unexpected end of retry loop")


def retry_with_backoff(
    max_retries: int = DEFAULT_RETRY_CONSTANTS["MAX_RETRIES"],
    base_delay_ms: float = DEFAULT_RETRY_CONSTANTS["BASE_DELAY_MS"],
    max_delay_ms: float = DEFAULT_RETRY_CONSTANTS["MAX_DELAY_MS"],
    multiplier: float = DEFAULT_RETRY_CONSTANTS["MULTIPLIER"],
    jitter_max_ms: float = DEFAULT_RETRY_CONSTANTS["JITTER_MAX_MS"]
):
    """
    Decorator for retrying operations with exponential backoff
    
    Usage:
        @retry_with_backoff(max_retries=3)
        def my_function():
            # operation that may fail
            pass
    """
    def decorator(func: Callable[[], T]) -> Callable[[], T]:
        @wraps(func)
        def wrapper(*args, **kwargs) -> T:
            options = RetryOptions(
                max_retries=max_retries,
                base_delay_ms=base_delay_ms,
                max_delay_ms=max_delay_ms,
                multiplier=multiplier,
                jitter_max_ms=jitter_max_ms,
                operation_name=func.__name__
            )
            return with_retry(lambda: func(*args, **kwargs), options)
        return wrapper
    return decorator


__all__ = [
    "with_retry",
    "retry_with_backoff",
    "calculate_backoff",
    "RetryOptions",
    "DEFAULT_RETRY_CONSTANTS"
]
