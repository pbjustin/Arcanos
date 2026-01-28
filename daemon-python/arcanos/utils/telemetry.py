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
from typing import Callable, TypeVar, Optional, Dict, Any
from datetime import datetime
from ..telemetry import Telemetry
import logging

logger = logging.getLogger("arcanos.telemetry")

T = TypeVar("T")

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
    event = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now().isoformat(),
        "name": name,
        "attributes": attributes or {}
    }
    
    # Track via telemetry system
    telemetry = get_telemetry()
    if telemetry.enabled:
        telemetry.track_event(f"trace.{name}", attributes)
    
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
    
    telemetry = get_telemetry()
    if telemetry.enabled:
        telemetry.track_event(f"{level}.recorded", {
            "error": error_message,
            "errorName": error_name,
            **context or {}
        })
    
    if level == "error":
        logger.error(
            error_message,
            extra={"module": "telemetry.unified", **context or {}},
            exc_info=error
        )
    else:
        logger.warning(
            error_message,
            extra={"module": "telemetry.unified", **context or {}},
            exc_info=error
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
    
    is_production = os.getenv("NODE_ENV") == "production" or os.getenv("RAILWAY_ENVIRONMENT")
    
    if is_production:
        # Railway-compatible structured JSON logging
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "level": level,
            "message": message,
            **metadata or {},
            "service": "arcanos-cli",
            "environment": os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("NODE_ENV", "development")
        }
        print(json.dumps(log_entry))
    else:
        # Human-readable format for development
        getattr(logger, level)(message, extra={"module": "telemetry.unified", **metadata or {}})
    
    # Also track via telemetry system
    telemetry = get_telemetry()
    if telemetry.enabled:
        telemetry.track_event(f"log.{level}", {"message": message, **metadata or {}})


__all__ = [
    "record_trace_event",
    "trace_operation",
    "record_metric",
    "record_error",
    "start_timer",
    "log_railway",
    "get_telemetry"
]
