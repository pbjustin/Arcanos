"""
v2 Trust Verification — Circuit Breaker

Prevents cascading failures. States: CLOSED → OPEN → HALF_OPEN → CLOSED.
Thread-safe via threading.Lock. Uses time.monotonic() for timing.

The call() method holds the lock during state transitions but releases it
during fn() execution to avoid blocking other threads.
"""

import time
import threading
from typing import TypeVar, Callable
from .config import V2Config

T = TypeVar("T")


class CircuitBreaker:
    """Circuit breaker preventing cascading failures.

    Raises `CircuitBreakerOpenError` when the breaker is open so callers
    can handle the condition explicitly.
    """

    class CircuitBreakerOpenError(RuntimeError):
        """Raised when the circuit breaker is OPEN or rejects probes."""
        pass
    def __init__(
        self,
        failure_threshold: int = V2Config.CB_FAILURE_THRESHOLD,
        reset_timeout_sec: float = V2Config.CB_RESET_TIMEOUT_SEC,
        half_open_max_calls: int = V2Config.CB_HALF_OPEN_MAX_CALLS,
    ):
        self._lock = threading.Lock()
        self._state = "CLOSED"
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._half_open_calls = 0
        self._in_flight = 0
        self._failure_threshold = failure_threshold
        self._reset_timeout_sec = reset_timeout_sec
        self._half_open_max_calls = half_open_max_calls

    @property
    def state(self) -> str:
        # Return current state without side-effects. Use internal
        # transition helper from callers that intend to mutate state.
        with self._lock:
            return self._state

    def _transition_open_if_needed(self) -> None:
        """Transition OPEN -> HALF_OPEN when reset timeout elapses."""
        with self._lock:
            if (
                self._state == "OPEN"
                and time.monotonic() - self._last_failure_time >= self._reset_timeout_sec
            ):
                self._state = "HALF_OPEN"
                self._half_open_calls = 0

    def call(self, fn: Callable[[], T]) -> T:
        # Ensure time-based transition is applied before checks
        self._transition_open_if_needed()
        with self._lock:
            current = self._state

            if current == "OPEN":
                raise CircuitBreaker.CircuitBreakerOpenError("Circuit breaker OPEN — failing fast")

            if current == "HALF_OPEN":
                if self._half_open_calls >= self._half_open_max_calls:
                    raise CircuitBreaker.CircuitBreakerOpenError(
                        "Circuit breaker HALF_OPEN — max probe calls reached"
                    )
                self._half_open_calls += 1

            self._in_flight += 1

        # Execute fn() outside the lock
        try:
            result = fn()

            with self._lock:
                self._in_flight -= 1
                if self._in_flight == 0:
                    self._state = "CLOSED"
                    self._failure_count = 0
                    self._half_open_calls = 0

            return result

        except Exception:
            with self._lock:
                self._in_flight -= 1
                self._failure_count += 1
                self._last_failure_time = time.monotonic()
                if current == "HALF_OPEN" or self._failure_count >= self._failure_threshold:
                    self._state = "OPEN"
            raise
