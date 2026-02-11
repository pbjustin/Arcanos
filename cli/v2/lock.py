"""
v2 Trust Verification — Distributed Lock with Heartbeat

Provides atomic lock acquisition with unique owner tokens, heartbeat-based
TTL extension, and safe conditional release. Uses a Lua script for
owner-verified delete to prevent releasing another holder's lock.
"""

import uuid
import logging
import threading
from typing import TypeVar, Callable, Optional

from .config import V2Config
from .redis_client import get_redis
from .circuit_breaker import CircuitBreaker

logger = logging.getLogger("arcanos.v2.lock")
T = TypeVar("T")
_breaker = CircuitBreaker()

# Lua script: delete only if the value matches our owner token
_RELEASE_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""

_EXTEND_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
else
    return 0
end
"""


class DistributedLock:
    def __init__(
        self,
        name: str,
        ttl_sec: int = V2Config.LOCK_TTL_SEC,
        heartbeat_sec: float = V2Config.LOCK_HEARTBEAT_SEC,
        on_lock_lost: Optional[Callable[[str], None]] = None,
    ):
        self._key = f"{V2Config.LOCK_PREFIX}{name}"
        self._ttl_sec = ttl_sec
        self._heartbeat_sec = heartbeat_sec
        self._owner_id = str(uuid.uuid4())
        self._heartbeat_timer: threading.Timer | None = None
        self._released = False
        self._timer_lock = threading.Lock()
        self._on_lock_lost = on_lock_lost

    def acquire(self) -> None:
        """Acquire the lock with a unique owner token. Raises on failure."""
        def _op() -> bool:
            client = get_redis()
            result = client.set(self._key, self._owner_id, nx=True, ex=self._ttl_sec)
            return result is True

        was_set = _breaker.call(_op)
        if not was_set:
            raise RuntimeError(f"Lock already held: {self._key}")
        self._released = False
        self._start_heartbeat()

    def release(self) -> None:
        """Release the lock only if we still own it (conditional delete)."""
        if self._released:
            return
        self._released = True
        self._stop_heartbeat()

        try:
            client = get_redis()
            client.eval(_RELEASE_SCRIPT, 1, self._key, self._owner_id)
        except Exception:
            logger.error("Failed to release lock: %s", self._key)

    def _start_heartbeat(self) -> None:
        """Schedule a single heartbeat timer that reschedules itself."""
        with self._timer_lock:
            if self._released:
                return

            def _beat():
                if self._released:
                    return
                try:
                    client = get_redis()
                    # Atomically extend TTL only if we still own the lock
                    res = client.eval(_EXTEND_SCRIPT, 1, self._key, self._owner_id, self._ttl_sec)
                    if not res:
                        self._released = True
                        if self._on_lock_lost:
                            self._on_lock_lost(self._key)
                        return
                except Exception:
                    logger.error("Heartbeat failed for %s", self._key)
                    self._released = True
                    if self._on_lock_lost:
                        self._on_lock_lost(self._key)
                    return
                # Reschedule under the timer lock
                self._start_heartbeat()

            self._heartbeat_timer = threading.Timer(self._heartbeat_sec, _beat)
            self._heartbeat_timer.daemon = True
            self._heartbeat_timer.start()

    def _stop_heartbeat(self) -> None:
        with self._timer_lock:
            if self._heartbeat_timer is not None:
                self._heartbeat_timer.cancel()
                self._heartbeat_timer = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()
        return False


def with_lock(name: str, fn: Callable[[], T], **kwargs) -> T:
    """Convenience: acquire lock, run fn, release lock."""
    lock = DistributedLock(name, **kwargs)
    with lock:
        return fn()
