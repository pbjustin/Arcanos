"""Registry authority expires by elapsed time despite independent wall-clock changes."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest

from arcanos.backend_client import BackendApiClient
from arcanos.cli import backend_ops, confirmation, state
from arcanos.cli.governance import GovernanceError, assert_allowed
from arcanos.cli.trust_state import TrustState
from arcanos.cli_session import SessionContext
from arcanos.config import Config
from .test_registry_trust import registry_payload


DAEMON_TOKEN = "monotonic-registry-daemon-fixture-1234567890"
CONTROL_TOKEN = "monotonic-registry-control-fixture-1234567890"
GPT_TOKEN = "monotonic-registry-writing-fixture-1234567890"


@pytest.fixture
def registry_clock_fixture(monkeypatch):
    """Use a real client with independent fake clocks and an in-memory HTTP sender."""
    clock = SimpleNamespace(wall=1000.0, elapsed=500.0)
    monkeypatch.setattr(state.time, "time", lambda: clock.wall)
    monkeypatch.setattr(state.time, "monotonic", lambda: clock.elapsed)
    monkeypatch.setattr(state, "audit_record", MagicMock())
    monkeypatch.setattr(backend_ops, "audit_record", MagicMock())
    monkeypatch.setattr(Config, "CONTROL_PLANE_ACCESS_TOKEN", CONTROL_TOKEN)
    monkeypatch.setattr(Config, "REPO_INDEX_ENABLED", False)
    monkeypatch.setattr(Config, "BACKEND_GPT_ID", "arcanos-daemon")
    scenario = {"registry_status": 200, "registry_payload": registry_payload(), "confirmation": False}
    requests = []

    def sender(method, url, **kwargs):
        """Serve only isolated registry, structured-state, and synthetic conversation responses."""
        path = urlsplit(url).path
        requests.append((method, path))
        status = 200
        if path == "/api/daemon/registry":
            assert kwargs["headers"].get("x-arcanos-daemon-token") == DAEMON_TOKEN
            status, payload = scenario["registry_status"], scenario["registry_payload"]
        elif path == "/system-state":
            assert kwargs["headers"].get("Authorization") == f"Bearer {CONTROL_TOKEN}"
            payload = {
                "mode": "system_state", "intent": {"intentId": None}, "routing": {"preferred": "backend"},
                "backend": {"connected": True, "registryAvailable": True},
                "stateFreshness": {"intent": "stale", "backend": "fresh"},
                "generatedAt": "2026-11-04T19:30:26.000Z",
            }
        elif path == "/gpt/arcanos-daemon":
            assert kwargs["headers"].get("Authorization") == f"Bearer {GPT_TOKEN}"
            if scenario["confirmation"]:
                status = 403
                payload = {"code": "CONFIRMATION_REQUIRED",
                           "confirmationChallenge": {"id": "082ce8db-8ebe-45ec-b31e-3a7c5e828f5f"},
                           "pending_actions": [{"summary": "Synthetic sensitive action"}]}
            else:
                payload = {"response": "Synthetic conversation succeeded.", "model": "fixture", "tokens": 0, "cost": 0}
        else:
            raise AssertionError(f"Unexpected fixture request: {method} {path}")
        return SimpleNamespace(status_code=status, json=lambda: payload, text=json.dumps(payload), headers={})

    generic = MagicMock(return_value=GPT_TOKEN)
    client = BackendApiClient(
        "https://monotonic.example.invalid", generic, request_sender=sender,
        daemon_access_token_provider=lambda: DAEMON_TOKEN,
    )
    cli = SimpleNamespace(
        backend_client=client, console=SimpleNamespace(print=MagicMock()),
        session=SessionContext(session_id="fixture-session"),
        instance_id="fixture-session", client_id="fixture-client",
        memory=SimpleNamespace(get_recent_conversations=lambda **kwargs: []),
    )
    state.initialize_runtime_state(cli)
    backend_ops.refresh_registry_cache(cli)
    cli.system_prompt = state.build_system_prompt(cli)
    assert cli._trust_state is TrustState.FULL
    generic.assert_not_called()
    return SimpleNamespace(cli=cli, clock=clock, scenario=scenario, requests=requests)


def _expire_then_roll_wall_back(fixture):
    """Expire elapsed authority, then place wall time inside its original TTL window."""
    fixture.clock.wall += fixture.cli._registry_cache_ttl_seconds + 1
    fixture.clock.elapsed += fixture.cli._registry_cache_ttl_seconds + 1
    state.recompute_trust_state(fixture.cli)
    assert fixture.cli._trust_state is TrustState.DEGRADED
    fixture.clock.wall = fixture.cli._registry_cache_updated_at + 1
    fixture.clock.elapsed += 1


def test_expired_registry_never_regains_trust_when_wall_clock_reenters_old_ttl(registry_clock_fixture):
    """A backward wall-clock adjustment cannot resurrect already expired authority."""
    fixture = registry_clock_fixture
    _expire_then_roll_wall_back(fixture)

    state.recompute_trust_state(fixture.cli)

    assert fixture.cli._trust_state is TrustState.DEGRADED
    assert state.registry_cache_is_valid(fixture.cli) is False
    assert fixture.requests == [("get", "/api/daemon/registry")]
    with pytest.raises(GovernanceError):
        assert_allowed("backend_confirm", fixture.cli._trust_state, requires_confirmation=True)


@pytest.mark.parametrize("status", [401, 429, 503, 200], ids=["unauthorized", "rate-limited", "unavailable", "malformed"])
def test_failed_registry_refresh_cannot_extend_elapsed_authority(registry_clock_fixture, status):
    """Authentication, transport, and parsing failures preserve the original cache anchors."""
    fixture = registry_clock_fixture
    _expire_then_roll_wall_back(fixture)
    wall_anchor = fixture.cli._registry_cache_updated_at
    elapsed_anchor = getattr(fixture.cli, "_registry_cache_updated_monotonic_at", None)
    fixture.scenario.update(registry_status=status, registry_payload={"error": "fixture registry unavailable"})

    backend_ops.refresh_registry_cache(fixture.cli)

    assert fixture.cli._trust_state is TrustState.DEGRADED
    assert fixture.cli._registry_cache_updated_at == wall_anchor
    assert getattr(fixture.cli, "_registry_cache_updated_monotonic_at", None) == elapsed_anchor
    assert fixture.requests == [("get", "/api/daemon/registry")] * 2


def test_new_authenticated_registry_refresh_recovers_after_wall_clock_rollback(registry_clock_fixture):
    """Only a new valid dedicated-credential registry read resets elapsed authority."""
    fixture = registry_clock_fixture
    _expire_then_roll_wall_back(fixture)
    old_stamp = fixture.cli._registry_cache_updated_at
    ttl = fixture.cli._registry_cache_ttl_seconds

    backend_ops.refresh_registry_cache(fixture.cli)

    assert fixture.cli._trust_state is TrustState.FULL
    assert fixture.cli._registry_cache_updated_at == fixture.clock.wall != old_stamp
    assert fixture.cli._registry_cache_updated_monotonic_at == fixture.clock.elapsed
    assert fixture.cli._registry_cache_ttl_seconds == ttl
    assert fixture.requests == [("get", "/api/daemon/registry")] * 2


def test_successful_state_and_gpt_reads_cannot_restore_expired_registry(registry_clock_fixture):
    """Other successful planes cannot renew registry authority after a wall-clock rollback."""
    fixture = registry_clock_fixture
    _expire_then_roll_wall_back(fixture)
    fixture.scenario["registry_status"] = 503
    anchors = (fixture.cli._registry_cache_updated_at, fixture.cli._registry_cache_updated_monotonic_at)

    assert backend_ops.request_backend_system_state_payload(fixture.cli) is not None
    result = backend_ops.perform_backend_conversation(fixture.cli, "Hello")

    assert result is not None and result.source == "backend"
    assert fixture.cli._trust_state is TrustState.DEGRADED
    assert state.registry_cache_is_valid(fixture.cli) is False
    assert (fixture.cli._registry_cache_updated_at, fixture.cli._registry_cache_updated_monotonic_at) == anchors
    assert fixture.requests == [
        ("get", "/api/daemon/registry"), ("get", "/system-state"),
        ("get", "/api/daemon/registry"), ("post", "/gpt/arcanos-daemon"),
    ]


def test_sensitive_confirmation_stays_unsafe_after_expiry_and_wall_rollback(registry_clock_fixture, monkeypatch):
    """A model confirmation response cannot bypass expired-registry governance."""
    fixture = registry_clock_fixture
    _expire_then_roll_wall_back(fixture)
    fixture.scenario.update(registry_status=401, confirmation=True)
    anchors = (fixture.cli._registry_cache_updated_at, fixture.cli._registry_cache_updated_monotonic_at)
    handler = MagicMock(return_value=None)
    monkeypatch.setattr(confirmation, "handle_confirmation_required", handler)

    assert backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request") is None

    assert fixture.cli._trust_state is TrustState.UNSAFE
    assert (fixture.cli._registry_cache_updated_at, fixture.cli._registry_cache_updated_monotonic_at) == anchors
    handler.assert_not_called()
    assert fixture.requests == [
        ("get", "/api/daemon/registry"), ("get", "/api/daemon/registry"),
        ("post", "/gpt/arcanos-daemon"),
    ]


def test_wall_clock_forward_jump_cannot_shorten_elapsed_ttl(registry_clock_fixture):
    """Wall timestamps report receipt time while elapsed time owns TTL enforcement."""
    fixture = registry_clock_fixture
    fixture.clock.wall += fixture.cli._registry_cache_ttl_seconds * 100
    fixture.clock.elapsed += 1

    state.recompute_trust_state(fixture.cli)

    assert fixture.cli._trust_state is TrustState.FULL
    assert fixture.requests == [("get", "/api/daemon/registry")]


def test_prior_future_wall_timestamp_guard_still_fails_closed(registry_clock_fixture):
    """A wall clock preceding the receipt timestamp remains insufficient authority."""
    fixture = registry_clock_fixture
    fixture.clock.wall -= 1
    fixture.clock.elapsed += 1

    state.recompute_trust_state(fixture.cli)

    assert fixture.cli._trust_state is TrustState.DEGRADED
    assert state.registry_cache_is_valid(fixture.cli) is False


def test_elapsed_expiration_boundary_is_preserved_while_wall_clock_is_frozen(registry_clock_fixture):
    """The existing inclusive TTL boundary depends only on bounded elapsed time."""
    fixture = registry_clock_fixture
    fixture.clock.elapsed += fixture.cli._registry_cache_ttl_seconds
    state.recompute_trust_state(fixture.cli)
    assert fixture.cli._trust_state is TrustState.FULL

    fixture.clock.elapsed += 0.001
    state.recompute_trust_state(fixture.cli)

    assert fixture.cli._trust_state is TrustState.DEGRADED
    assert state.registry_cache_is_valid(fixture.cli) is False
    assert fixture.requests == [("get", "/api/daemon/registry")]


@pytest.mark.parametrize("anchor", [None, 501.0], ids=["missing", "future"])
def test_missing_or_future_elapsed_anchor_never_falls_back_to_wall_time(registry_clock_fixture, anchor):
    """Unknown or invalid monotonic evidence fails closed even with a fresh wall timestamp."""
    fixture = registry_clock_fixture
    fixture.cli._registry_cache_updated_monotonic_at = anchor

    state.recompute_trust_state(fixture.cli)

    assert fixture.cli._trust_state is TrustState.DEGRADED
    assert state.registry_cache_is_valid(fixture.cli) is False
