"""Pending backend work must occupy admission capacity before completion."""

from concurrent.futures import ThreadPoolExecutor
import os
import threading

import pytest

from arcanos.config import Config
from arcanos.rate_limiter import RateLimiter
from tests.test_automatic_conversation_recovery import recovery_profile, JOB


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Actual protected Windows recovery context required")


def test_sequential_pending_acceptances_respect_hourly_limit(recovery_profile, monkeypatch):
    """A second question cannot create paid work while the first accepted job is pending."""
    make_cli, wire = recovery_profile
    monkeypatch.setattr(Config, "MAX_REQUESTS_PER_HOUR", 1)
    cli = make_cli()
    wire["states"][JOB] = ["pending"]
    cli.handle_ask("first original question")
    cli.handle_ask("second question must wait")
    assert wire["posts"] == wire["providers"] == 1
    assert cli.memory.get_recent_conversations() == []
    assert cli.memory.get_statistics()["total_requests"] == 0
    assert cli.rate_limiter.tokens_today == 0 and cli.rate_limiter.cost_today == 0
    assert "Hourly request limit" in cli.console.file.getvalue()


def test_pending_admission_survives_controller_restart_without_completion_charge(recovery_profile, monkeypatch):
    """Restoration occupies the original hour without generating or inventing usage."""
    make_cli, wire = recovery_profile
    monkeypatch.setattr(Config, "MAX_REQUESTS_PER_HOUR", 1)
    first = make_cli()
    wire["states"][JOB] = ["pending"]
    first.handle_ask("original question")
    first._conversation_recovery.stop()
    restarted = make_cli(instance="restarted")
    restarted._conversation_recovery.tick()
    restarted.handle_ask("second question must wait")
    assert wire["posts"] == wire["providers"] == 1
    assert restarted.rate_limiter.get_usage_stats()["requests_this_hour"] == 1
    assert restarted.rate_limiter.tokens_today == restarted.rate_limiter.cost_today == 0
    wire["states"][JOB] = ["completed"]
    wire["clock"][0] += 2
    restarted._conversation_recovery.tick()
    restarted._conversation_recovery.tick()
    assert restarted.rate_limiter.get_usage_stats()["requests_this_hour"] == 1
    assert restarted.rate_limiter.tokens_today == 17
    assert restarted.memory.get_statistics()["total_requests"] == 1
    assert len(restarted.memory.get_recent_conversations()) == 1


def test_immediate_completion_consumes_its_admission_once(recovery_profile, monkeypatch):
    """HTTP200 does not increment hourly usage at both admission and completion."""
    make_cli, wire = recovery_profile
    monkeypatch.setattr(Config, "MAX_REQUESTS_PER_HOUR", 1)
    cli = make_cli()
    wire["immediate"] = True
    cli.handle_ask("immediate question")
    assert cli.rate_limiter.get_usage_stats()["requests_this_hour"] == 1
    assert cli.rate_limiter.tokens_today == 17
    assert cli.memory.get_statistics()["total_requests"] == 1
    cli.handle_ask("second question must wait")
    assert wire["posts"] == wire["providers"] == 1


def test_manual_continuation_consumes_accepted_admission_once(recovery_profile, monkeypatch):
    """The supported process-only fallback retains quota until its original result."""
    make_cli, wire = recovery_profile
    monkeypatch.setattr(Config, "MAX_REQUESTS_PER_HOUR", 1)
    cli = make_cli(recovery=False)
    wire["maximum_read_timeout"] = 5  # Manual one-shot reads use the normal client timeout.
    wire["states"][JOB] = ["completed"]
    cli.handle_ask("original question")
    cli.handle_ask("second question must wait")
    cli.handle_resume(JOB)
    assert wire["posts"] == wire["providers"] == wire["gets"] == 1
    assert cli.rate_limiter.get_usage_stats()["requests_this_hour"] == 1
    assert cli.rate_limiter.tokens_today == 17


def test_reservations_are_atomic_and_do_not_charge_incomplete_usage(monkeypatch):
    """Every competing caller uses the same admission lock before paid work."""
    monkeypatch.setattr(Config, "MAX_REQUESTS_PER_HOUR", 1)
    limiter = RateLimiter()
    ready = threading.Barrier(8)

    def admit():
        ready.wait(timeout=5)
        return limiter.reserve_request()[0]

    with ThreadPoolExecutor(max_workers=8) as pool:
        admissions = list(pool.map(lambda _: admit(), range(8)))
    admitted = [key for key in admissions if key is not None]
    assert len(admitted) == 1
    assert limiter.tokens_today == limiter.cost_today == 0
    limiter.release_request(admitted[0], refund=True)
    assert limiter.can_make_request() == (True, None)
    reservation, _ = limiter.reserve_request()
    limiter.release_request(reservation)
    assert not limiter.can_make_request()[0]


def test_overlapping_pending_acceptances_respect_hourly_limit(recovery_profile, monkeypatch):
    """Reserve before the first POST, while another request is already being admitted."""
    make_cli, wire = recovery_profile
    monkeypatch.setattr(Config, "MAX_REQUESTS_PER_HOUR", 1)
    cli = make_cli()
    first_entered, release_first = threading.Event(), threading.Event()
    original = cli.backend_client.request_chat_completion

    def held_original(*args, **kwargs):
        if not first_entered.is_set():
            first_entered.set()
            assert release_first.wait(5), "Original request was not released"
        return original(*args, **kwargs)

    monkeypatch.setattr(cli.backend_client, "request_chat_completion", held_original)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(cli.handle_ask, "first original question")
        try:
            assert first_entered.wait(5), "Original request did not reach its HTTP boundary"
            cli.handle_ask("overlapping question must wait")
        finally:
            release_first.set()
        first.result(timeout=5)
    assert wire["posts"] == wire["providers"] == 1
    assert cli.memory.get_recent_conversations() == []
    assert cli.memory.get_statistics()["total_requests"] == 0
    assert cli.rate_limiter.tokens_today == 0 and cli.rate_limiter.cost_today == 0


def test_post_commit_unlock_fault_preserves_one_hourly_admission(recovery_profile, monkeypatch):
    """A committed protected handle must retain the same admission even if cleanup reports failure."""
    import msvcrt
    from arcanos import continuation_store as storage

    make_cli, wire = recovery_profile
    cli = make_cli()
    replace, locking = storage._atomic_replace, msvcrt.locking
    fault = {"armed": False, "triggered": False}

    def committed(source, destination):
        """Arm the one-off fault only after actual DPAPI bytes were atomically committed."""
        replace(source, destination)
        fault["armed"] = True

    def failed_unlock(fd, mode, size):
        """Preserve actual native locking, failing only the first post-commit unlock."""
        if mode == msvcrt.LK_UNLCK and fault["armed"] and not fault["triggered"]:
            fault["triggered"] = True
            raise OSError("Synthetic post-commit unlock failure")
        return locking(fd, mode, size)

    monkeypatch.setattr(storage, "_atomic_replace", committed)
    monkeypatch.setattr(msvcrt, "locking", failed_unlock)
    cli.handle_ask("original question")
    assert fault["triggered"]
    wire["states"][JOB] = ["completed"]
    wire["maximum_read_timeout"] = 5
    cli.handle_resume(JOB)
    assert wire["posts"] == wire["providers"] == wire["gets"] == 1
    assert len(cli.memory.get_recent_conversations()) == 1
    assert cli.memory.get_statistics()["total_requests"] == 1
    assert cli.rate_limiter.tokens_today == 17
    assert cli.rate_limiter.cost_today == pytest.approx(0.0123)
    assert cli.rate_limiter.get_usage_stats()["requests_this_hour"] == 1
    assert cli.rate_limiter._request_reservations == {}
