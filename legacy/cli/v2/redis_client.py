"""
v2 Trust Verification — Redis Client

Atomic NX-based nonce and lock operations with fail-closed semantics.
All calls go through a CircuitBreaker to prevent cascading failures.
Thread-safe singleton initialization.

REQUIRES: pip install redis
"""

import logging
import threading
import redis
from .config import V2Config
from .circuit_breaker import CircuitBreaker

logger = logging.getLogger("arcanos.v2.redis")

_client: redis.Redis | None = None
_client_lock = threading.Lock()
_breaker = CircuitBreaker()


def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = redis.Redis.from_url(
                    V2Config.REDIS_URL,
                    decode_responses=True,
                    socket_connect_timeout=5,
                    socket_timeout=5,
                    retry_on_timeout=True,
                )
    return _client


def set_nx(key: str, ttl_sec: int) -> bool:
    """
    Atomically set key only if it doesn't exist. Fail-closed on error.
    Returns True if set succeeded, False if key already exists.
    """
    if ttl_sec <= 0:
        raise ValueError(f"Invalid TTL: {ttl_sec}s — token may be expired")

    def _op() -> bool:
        client = get_redis()
        result = client.set(key, "1", nx=True, ex=ttl_sec)
        return result is True

    return _breaker.call(_op)


def extend_ttl(key: str, ttl_sec: int) -> bool:
    """Extend key TTL (for lock heartbeat)."""
    def _op() -> bool:
        client = get_redis()
        return bool(client.expire(key, ttl_sec))

    return _breaker.call(_op)


def delete_key(key: str) -> None:
    """Delete key (for lock release). Best-effort — does not throw."""
    try:
        client = get_redis()
        client.delete(key)
    except Exception:
        logger.error("Failed to delete Redis key")


def disconnect() -> None:
    """Graceful disconnect."""
    global _client
    with _client_lock:
        if _client is not None:
            try:
                _client.close()
            except Exception:
                pass
            _client = None
