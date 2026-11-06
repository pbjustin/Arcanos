"""Completed usage must stay charged to the day on which it is recorded."""

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from arcanos import rate_limiter


@pytest.fixture
def limiter_clock(monkeypatch):
    """Control the limiter's wall clock without affecting other process clocks."""
    clock = [datetime(2026, 11, 5, 23, 59, 0)]

    class ControlledDateTime:
        """Expose only the local clock operation consumed by RateLimiter."""

        @staticmethod
        def now():
            """Return the current deterministic local date and time."""
            return clock[0]

    monkeypatch.setattr(rate_limiter, "datetime", ControlledDateTime)
    monkeypatch.setattr(rate_limiter, "time", SimpleNamespace(time=lambda: clock[0].timestamp()))
    return rate_limiter.RateLimiter(), clock


def test_record_after_midnight_keeps_new_usage_without_an_admission_read(limiter_clock, monkeypatch):
    """A resumed answer clears stale daily totals before adding its real usage."""
    limiter, clock = limiter_clock
    limiter.record_request(80, 0.8)
    old_request_time = limiter.requests_per_hour[0]
    clock[0] += timedelta(minutes=2)
    limiter.record_request(17, 0.0123)

    assert limiter.tokens_today == 17
    assert limiter.cost_today == pytest.approx(0.0123)
    assert limiter.last_reset == clock[0]
    assert limiter.requests_per_hour == [old_request_time, clock[0].timestamp()]
    assert limiter.get_usage_stats()["tokens_today"] == 17
    assert limiter.get_usage_stats()["cost_today"] == pytest.approx(0.0123)
    monkeypatch.setattr(rate_limiter.Config, "MAX_REQUESTS_PER_HOUR", 100)
    monkeypatch.setattr(rate_limiter.Config, "MAX_TOKENS_PER_DAY", 17)
    allowed, reason = limiter.can_make_request()
    assert not allowed
    assert reason.startswith("Daily token limit reached")


def test_same_day_records_accumulate_without_resetting_previous_usage(limiter_clock):
    """Recording another completed turn on the same day preserves prior charges."""
    limiter, clock = limiter_clock
    initial_reset = limiter.last_reset
    limiter.record_request(11, 0.01)
    clock[0] += timedelta(seconds=5)
    limiter.record_request(23, 0.02)

    assert limiter.tokens_today == 34
    assert limiter.cost_today == pytest.approx(0.03)
    assert limiter.last_reset == initial_reset
    assert len(limiter.requests_per_hour) == 2
