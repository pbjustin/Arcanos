"""
Unified Telemetry Utilities for Python CLI Agent

Provides Railway-native telemetry patterns for tracing, metrics, and logging.
Enhances the existing telemetry module with additional utilities.

Features:
- Request tracing with automatic span management
- Performance metrics collection
- Error tracking with context
- Railway-compatible logging
- Operation timing and profiling
"""

import time
import uuid
import re
from typing import Callable, TypeVar, Optional, Dict, Any
from datetime import datetime
from ..telemetry import Telemetry
import logging

logger = logging.getLogger("arcanos.telemetry")

T = TypeVar("T")

# Patterns for sensitive data that should be redacted
SENSITIVE_PATTERNS = [
    r'api[_-]?key',
    r'api[_-]?token',
    r'bearer[_-]?token',
    r'access[_-]?token',
    r'secret[_-]?key',
    r'password',
    r'passwd',
    r'auth[_-]?token',
    r'authorization',
    r'credential',
    r'private[_-]?key',
    r'secret',
    r'token',
    r'openai[_-]?api[_-]?key',
    r'backend[_-]?token',
]


def sanitize_sensitive_data(data: Any, depth: int = 0, max_depth: int = 10) -> Any:
    """
    Recursively sanitizes sensitive data from dictionaries and nested structures.
    
    Redacts values for keys matching sensitive patterns (API keys, tokens, passwords, etc.)
    to prevent credential leakage in logs.
    
    Args:
        data: Data structure to sanitize (dict, list, or primitive)
        depth: Current recursion depth
        max_depth: Maximum recursion depth to prevent stack overflow
    
    Returns:
        Sanitized data structure with sensitive values redacted
    """
    if depth > max_depth:
        return "[max depth reached]"
    
    if isinstance(data, dict):
        sanitized = {}
        for key, value in data.items():
            key_lower = str(key).lower()
            # Check if key matches any sensitive pattern
            is_sensitive = any(re.search(pattern, key_lower, re.IGNORECASE) for pattern in SENSITIVE_PATTERNS)
            
            if is_sensitive:
                # Redact sensitive values
                if isinstance(value, str) and len(value) > 0:
                    sanitized[key] = f"[REDACTED:{len(value)} chars]"
                else:
                    sanitized[key] = "[REDACTED]"
            else:
                # Recursively sanitize nested structures
                sanitized[key] = sanitize_sensitive_data(value, depth + 1, max_depth)
        return sanitized
    if isinstance(data, list):
        return [sanitize_sensitive_data(item, depth + 1, max_depth) for item in data]
    return data
# Global telemetry instance
_telemetry_instance: Optional[Telemetry] = None


def get_telemetry() -> Telemetry:
    """Gets or creates the global telemetry instance"""
    global _telemetry_instance
    if _telemetry_instance is None:
        _telemetry_instance = Telemetry()
    return _telemetry_instance


def record_trace_event(name: str, attributes: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Records a distributed trace event for tracking operations
    
    Args:
        name: Name identifying the traced operation
        attributes: Optional key-value attributes providing operation context
    
    Returns:
        Trace event dictionary with ID
    """
    # Sanitize attributes to prevent credential leakage
    sanitized_attributes = sanitize_sensitive_data(attributes or {}) if attributes else {}
    event = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now().isoformat(),
        "name": name,
        "attributes": sanitized_attributes
    }
    
    # Track via telemetry system
    telemetry = get_telemetry()
    if telemetry.enabled:
        telemetry.track_event(f"trace.{name}", sanitized_attributes)
    
    return event


def trace_operation(
    name: str,
    operation: Callable[[], T],
    attributes: Optional[Dict[str, Any]] = None
) -> T:
    """
    Traces an operation with automatic span management
    
    Creates a span, executes the operation, and automatically ends the span.
    Handles errors and records them in the span.
    
    Args:
        name: Operation name
        operation: Operation to trace (callable that returns T)
        attributes: Additional span attributes
    
    Returns:
        Operation result
    
    Raises:
        Last error if operation fails
    """
    start_time = time.time()
    trace_id = record_trace_event(f"operation.start.{name}", attributes)
    
    try:
        result = operation()
        duration = (time.time() - start_time) * 1000
        
        record_trace_event(f"operation.success.{name}", {
            "traceId": trace_id["id"],
            "duration": duration
        })
        
        return result
    except Exception as error:
        duration = (time.time() - start_time) * 1000
        error_message = str(error)
        
        record_trace_event(f"operation.error.{name}", {
            "traceId": trace_id["id"],
            "duration": duration,
            "error": error_message
        })
        
        raise error


def record_metric(
    name: str,
    value: float,
    tags: Optional[Dict[str, str]] = None
) -> None:
    """
    Records a metric with tags
    
    Metrics are used to track numerical values over time.
    Tags allow filtering and grouping metrics.
    
    Args:
        name: Metric name
        value: Metric value
        tags: Metric tags
    """
    metric = {
        "name": name,
        "value": value,
        "tags": tags or {},
        "timestamp": datetime.now().isoformat()
    }
    
    telemetry = get_telemetry()
    if telemetry.enabled:
        telemetry.track_event(f"metric.{name}", {"value": value, "tags": tags})


def record_error(
    error: Exception,
    context: Optional[Dict[str, Any]] = None,
    level: str = "error"
) -> None:
    """
    Records an error with full context
    
    Provides structured error logging with telemetry integration.
    
    Args:
        error: Error to record
        context: Additional context
        level: Log level ('error' or 'warn')
    """
    error_message = str(error)
    error_name = type(error).__name__
    
    # Sanitize context to prevent credential leakage
    sanitized_context = sanitize_sensitive_data(context or {}) if context else {}
    
    telemetry = get_telemetry()
    if telemetry.enabled:
        telemetry.track_event(
            f"{level}.recorded",
            {
                "error": error_message,
                "errorName": error_name,
                **sanitized_context,
            },
        )
    
    if level == "error":
        logger.error(
            error_message,
            extra={"module": "telemetry.unified", **sanitized_context},
            exc_info=error,
        )
    else:
        logger.warning(
            error_message,
            extra={"module": "telemetry.unified", **sanitized_context},
            exc_info=error,
        )


def start_timer(
    operation: str,
    attributes: Optional[Dict[str, Any]] = None
) -> Callable[[], None]:
    """
    Creates a timer for measuring operation duration
    
    Returns a function that, when called, records the duration.
    
    Args:
        operation: Operation name
        attributes: Additional attributes
    
    Returns:
        Function to call when operation completes
    """
    start_time = time.time()
    trace_id = record_trace_event(f"timer.start.{operation}", attributes)
    
    def end_timer() -> None:
        duration = (time.time() - start_time) * 1000
        record_trace_event(f"timer.end.{operation}", {
            "traceId": trace_id["id"],
            "duration": duration,
            **attributes or {}
        })
        record_metric(f"operation.duration.{operation}", duration, {"operation": operation})
    
    return end_timer


def log_railway(
    level: str,
    message: str,
    metadata: Optional[Dict[str, Any]] = None
) -> None:
    """
    Railway-compatible logging
    
    Formats logs for Railway's log aggregation system.
    In production, outputs structured JSON.
    
    Args:
        level: Log level ('debug', 'info', 'warn', 'error')
        message: Log message
        metadata: Additional metadata
    """
    import os
    import json
    
    # Sanitize metadata to prevent credential leakage
    sanitized_metadata = sanitize_sensitive_data(metadata or {}) if metadata else {}
    # Use Config for env access (adapter boundary pattern)
    # Note: NODE_ENV and RAILWAY_ENVIRONMENT are not yet in Config class, so check env directly
    # These are system/env detection vars, acceptable to check via os.getenv
    node_env = os.getenv("NODE_ENV")
    railway_env = os.getenv("RAILWAY_ENVIRONMENT")
    is_production = node_env == "production" or bool(railway_env)
    
    if is_production:
        # Railway-compatible structured JSON logging
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "level": level,
            "message": message,
            **sanitized_metadata,
            "service": "arcanos-cli",
            "environment": railway_env or node_env or "development"
        }
        print(json.dumps(log_entry))
    else:
        # Human-readable format for development
        getattr(logger, level)(message, extra={"module": "telemetry.unified", **sanitized_metadata})
    
    # Also track via telemetry system
    telemetry = get_telemetry()
    if telemetry.enabled:
        telemetry.track_event(f"log.{level}", {"message": message, **sanitized_metadata})


__all__ = [
    "record_trace_event",
    "trace_operation",
    "record_metric",
    "record_error",
    "start_timer",
    "log_railway",
    "get_telemetry",
    "sanitize_sensitive_data",
]
