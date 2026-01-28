"""
Unified Health Check Utilities for Python CLI Agent

Provides reusable health check patterns for Railway-native deployments:
- Service health checks (OpenAI, backend, etc.)
- Dependency health aggregation
- Health check endpoint builder for debug server
- Railway-compatible health responses

Features:
- Stateless health checks (no local state dependencies)
- Railway-compatible response formats
- Comprehensive dependency checking
- Audit trail for health checks
"""

from typing import Callable, List, Dict, Any, Optional
from dataclasses import dataclass
from datetime import datetime
from ..openai.unified_client import validate_client_health, HealthStatus
import logging

logger = logging.getLogger("arcanos.health")


@dataclass
class HealthCheckResult:
    """Health check result"""
    healthy: bool
    name: str
    error: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    duration: Optional[float] = None


@dataclass
class AggregatedHealthStatus:
    """Aggregated health status"""
    status: str  # 'healthy', 'degraded', or 'unhealthy'
    timestamp: str
    checks: List[HealthCheckResult]
    summary: Dict[str, int]


@dataclass
class HealthChecker:
    """Health checker instance"""
    name: str
    check: Callable[[], HealthCheckResult]
    critical: bool = True


def create_health_check(
    name: str,
    check: Callable[[], HealthCheckResult],
    critical: bool = True
) -> HealthChecker:
    """
    Creates a health check instance
    
    Args:
        name: Health check name
        check: Health check function
        critical: Whether this check is critical (default: True)
    
    Returns:
        Health checker instance
    """
    return HealthChecker(name=name, check=check, critical=critical)


def aggregate_health_checks(checks: List[HealthChecker]) -> AggregatedHealthStatus:
    """
    Aggregates multiple health checks into a single status
    
    Determines overall health status based on individual checks:
    - healthy: All checks are healthy
    - degraded: Some non-critical checks are unhealthy
    - unhealthy: Any critical check is unhealthy
    """
    import time
    
    start_time = time.time()
    
    # Execute all checks
    results: List[HealthCheckResult] = []
    for checker in checks:
        try:
            result = checker.check()
            results.append(result)
        except Exception as error:
            results.append(HealthCheckResult(
                healthy=False,
                name=checker.name,
                error=str(error)
            ))
    
    # Calculate summary
    summary = {
        "total": len(results),
        "healthy": sum(1 for r in results if r.healthy),
        "unhealthy": sum(1 for r in results if not r.healthy),
        "degraded": 0
    }
    
    # Determine overall status
    critical_checks = [c for c in checks if c.critical]
    critical_results = [
        r for r, c in zip(results, checks)
        if c in critical_checks
    ]
    has_unhealthy_critical = any(not r.healthy for r in critical_results)
    has_unhealthy_non_critical = any(
        not r.healthy and not c.critical
        for r, c in zip(results, checks)
    )
    
    if has_unhealthy_critical:
        status = "unhealthy"
    elif has_unhealthy_non_critical:
        status = "degraded"
        summary["degraded"] = summary["unhealthy"]
        summary["unhealthy"] = 0
    else:
        status = "healthy"
    
    duration = (time.time() - start_time) * 1000
    
    return AggregatedHealthStatus(
        status=status,
        timestamp=datetime.now().isoformat(),
        checks=results,
        summary=summary
    )


def check_openai_health() -> HealthCheckResult:
    """OpenAI client health check"""
    try:
        health = validate_client_health()
        return HealthCheckResult(
            healthy=health.healthy,
            name="openai",
            error=health.error,
            metadata={
                "apiKeyConfigured": health.api_key_configured,
                "apiKeySource": health.api_key_source,
                "defaultModel": health.default_model,
            }
        )
    except Exception as error:
        return HealthCheckResult(
            healthy=False,
            name="openai",
            error=str(error)
        )


def check_application_health() -> HealthCheckResult:
    """Application health check"""
    import sys
    
    return HealthCheckResult(
        healthy=True,
        name="application",
        metadata={
            "platform": sys.platform,
            "pythonVersion": sys.version,
        }
    )


def build_health_response(checks: List[HealthChecker]) -> Dict[str, Any]:
    """
    Builds a health response dictionary
    
    Creates a Railway-compatible health response.
    """
    health = aggregate_health_checks(checks)
    
    return {
        "status": health.status,
        "timestamp": health.timestamp,
        "checks": [
            {
                "name": r.name,
                "healthy": r.healthy,
                "error": r.error,
                "metadata": r.metadata
            }
            for r in health.checks
        ],
        "summary": health.summary
    }


__all__ = [
    "create_health_check",
    "aggregate_health_checks",
    "check_openai_health",
    "check_application_health",
    "build_health_response",
    "HealthCheckResult",
    "AggregatedHealthStatus",
    "HealthChecker"
]
