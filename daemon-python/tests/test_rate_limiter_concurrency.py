"""Foreground quota operations must not discard concurrent recovered usage."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import threading
from types import SimpleNamespace

import pytest

from arcanos import rate_limiter


@pytest.fixture
def concurrent_limiter(monkeypatch):
    """Freeze accounting time and expose contention without timing-dependent sleeps."""
    now = datetime(2026, 11, 5, 12, 0, 0)
    progress = threading.Event()

    class ControlledDateTime(datetime):
        """Keep all recovered and foreground charges on the same deterministic day."""

        @classmethod
        def now(cls, tz=None):
            """Return the frozen local accounting clock."""
            return now

    class ObservedLock:
        """Signal when recovery must wait for an actual held native Python lock."""

        def __init__(self, native):
            self.native = native

        def __enter__(self):
            if not self.native.acquire(blocking=False):
                progress.set()
                assert self.native.acquire(timeout=5), "Quota operation did not release its lock"
            return self

        def __exit__(self, *_error):
            self.native.release()

    monkeypatch.setattr(rate_limiter, "datetime", ControlledDateTime)
    monkeypatch.setattr(rate_limiter, "time", SimpleNamespace(time=lambda: now.timestamp()))
    monkeypatch.setattr(rate_limiter, "threading", SimpleNamespace(
        Lock=lambda: ObservedLock(threading.Lock()), RLock=lambda: ObservedLock(threading.RLock()),
    ))
    monkeypatch.setattr(rate_limiter.Config, "MAX_REQUESTS_PER_HOUR", 10)
    monkeypatch.setattr(rate_limiter.Config, "MAX_TOKENS_PER_DAY", 1000)
    monkeypatch.setattr(rate_limiter.Config, "MAX_COST_PER_DAY", 10.0)
    return rate_limiter.RateLimiter(), now.timestamp(), progress


def _interleave_recovery(limiter, now, progress, foreground, captured, resume):
    """Let recovery finish, or block on foreground's lock, before releasing its snapshot."""
    def recovered():
        """Record one actual recovered receipt and signal completion on an unlocked implementation."""
        try:
            return limiter.record_recovered_request("a" * 64, 17, 0.0123, now)
        finally:
            progress.set()

    with ThreadPoolExecutor(max_workers=2) as pool:
        foreground_result = pool.submit(foreground)
        try:
            assert captured.wait(5), "Foreground did not reach the controlled accounting boundary"
            recovery_result = pool.submit(recovered)
            assert progress.wait(5), "Recovery neither finished nor encountered the held quota lock"
        finally:
            resume.set()
        foreground_result.result(timeout=5)
        assert recovery_result.result(timeout=5) is True


@pytest.mark.parametrize("reader", ["can_make_request", "get_usage_stats"])
def test_hourly_cleanup_cannot_erase_a_recovered_request(concurrent_limiter, reader):
    """An hourly-list snapshot must not overwrite a receipt added by another thread."""
    limiter, now, progress = concurrent_limiter
    captured, resume = threading.Event(), threading.Event()
    foreground_identity = []

    class PausedSnapshot(list):
        """Pause only foreground's real list-comprehension snapshot before reassignment."""

        def __iter__(self):
            snapshot = list(list.__iter__(self))
            if threading.get_ident() == foreground_identity[0] and not captured.is_set():
                captured.set()
                assert resume.wait(5), "Hourly cleanup was never released"
            return iter(snapshot)

    limiter.requests_per_hour = PausedSnapshot()

    def foreground():
        """Run the public quota reader while recovery attempts the same hourly state."""
        foreground_identity.append(threading.get_ident())
        return getattr(limiter, reader)()

    _interleave_recovery(limiter, now, progress, foreground, captured, resume)
    assert limiter.get_usage_stats()["requests_this_hour"] == 1
    assert limiter.requests_per_hour == [now]
    assert limiter.tokens_today == 17
    assert limiter.cost_today == pytest.approx(0.0123)
    assert not limiter.record_recovered_request("a" * 64, 17, 0.0123, now)
    assert limiter.get_usage_stats()["requests_this_hour"] == 1


@pytest.mark.parametrize("counter", ["tokens_today", "cost_today"])
def test_foreground_charge_cannot_overwrite_recovered_daily_usage(concurrent_limiter, counter):
    """Interleaved read/add/write operations must preserve both authoritative charges."""
    limiter, now, progress = concurrent_limiter
    captured, resume = threading.Event(), threading.Event()
    foreground_identity = []

    def pause_add(value, amount):
        """Capture the old counter before recovery attempts to add its completed usage."""
        previous = float(value) if counter == "cost_today" else int(value)
        if threading.get_ident() == foreground_identity[0] and not captured.is_set():
            captured.set()
            assert resume.wait(5), "Foreground charge was never released"
        return previous + amount

    class PausedInt(int):
        """Expose the normal integer augmented-assignment race deterministically."""

        __add__ = pause_add

    class PausedFloat(float):
        """Expose the normal float augmented-assignment race deterministically."""

        __add__ = pause_add

    setattr(limiter, counter, PausedFloat(0) if counter == "cost_today" else PausedInt(0))

    def foreground():
        """Charge a separate synchronous conversation while the original job completes."""
        foreground_identity.append(threading.get_ident())
        limiter.record_request(5, 0.02)

    _interleave_recovery(limiter, now, progress, foreground, captured, resume)
    assert limiter.tokens_today == 22
    assert limiter.cost_today == pytest.approx(0.0323)
    assert limiter.get_usage_stats()["requests_this_hour"] == 2
    assert not limiter.record_recovered_request("a" * 64, 17, 0.0123, now)
    assert limiter.tokens_today == 22 and limiter.cost_today == pytest.approx(0.0323)


def test_concurrent_recovered_receipt_is_charged_once(concurrent_limiter):
    """Two workers reconciling one durable receipt cannot duplicate quota accounting."""
    limiter, now, _progress = concurrent_limiter
    ready = threading.Barrier(2)

    def recover():
        """Attempt the same actual receipt from two simultaneous recovery workers."""
        ready.wait(timeout=5)
        return limiter.record_recovered_request("a" * 64, 17, 0.0123, now)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(recover) for _ in range(2)]
        assert sorted(result.result(timeout=5) for result in results) == [False, True]
    assert limiter.get_usage_stats()["requests_this_hour"] == 1
    assert limiter.tokens_today == 17 and limiter.cost_today == pytest.approx(0.0123)
