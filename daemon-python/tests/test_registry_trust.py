"""Registry evidence must be authenticated, well formed, and within its TTL."""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from arcanos.backend_client import BackendApiClient
from arcanos.backend_client_models import BackendChatResult, BackendRequestError, BackendResponse
from arcanos.cli import backend_ops, state
from arcanos.cli.governance import GovernanceError, assert_allowed
from arcanos.cli.trust_state import TrustState
from arcanos.cli_session import SessionContext


DAEMON_TOKEN = "synthetic-registry-daemon-token-1234567890"


def registry_payload() -> dict:
    """Use the existing v1 shape emitted by src/routes/api-daemon.ts."""
    return {
        "version": 1,
        "updatedAt": "2026-11-04T19:30:20.000Z",
        "endpoints": [{"method": "POST", "path": "/gpt/arcanos-daemon", "description": "Chat"}],
        "modules": [{"id": "ARCANOS:CORE", "description": "Core", "route": "/gpt/arcanos-daemon", "actions": []}],
        "daemonTools": [{"name": "run_command", "description": "Run command", "sensitive": True}],
        "core": [{"id": "HRC", "description": "Core", "modes": ["HRC:STRICT"]}],
    }


def make_cli(payload: dict | None = None, *, status_code: int = 200, token: str | None = DAEMON_TOKEN):
    response = SimpleNamespace(status_code=status_code, json=lambda: payload, text="fixture response", headers={})
    sender = MagicMock(return_value=response)
    generic_token = MagicMock(side_effect=AssertionError("Registry must not read writing-plane credentials"))
    client = BackendApiClient(
        "https://registry.example.invalid", generic_token,
        request_sender=sender, daemon_access_token_provider=lambda: token,
    )
    cli = SimpleNamespace(
        backend_client=client, console=SimpleNamespace(print=MagicMock()),
        session=SessionContext(session_id="fixture-instance"),
    )
    state.initialize_runtime_state(cli)
    return cli, sender, generic_token


@pytest.fixture(autouse=True)
def isolate_audit(monkeypatch):
    monkeypatch.setattr(state, "audit_record", lambda *args, **kwargs: None)


@pytest.mark.parametrize("payload", [{"error": "registry initialization failed"}, {"ok": True}, {}])
def test_malformed_registry_does_not_grant_full_trust(payload):
    cli, sender, generic_token = make_cli(payload)
    backend_ops.refresh_registry_cache(cli)
    state.recompute_trust_state(cli)

    assert cli._trust_state is TrustState.DEGRADED
    assert cli._registry_cache is None
    assert cli._registry_cache_updated_at is None
    sender.assert_called_once()
    generic_token.assert_not_called()


def test_direct_registry_refresh_recovers_trust():
    cli, sender, _ = make_cli(registry_payload())
    backend_ops.refresh_registry_cache(cli)

    assert cli._trust_state is TrustState.FULL
    assert state.registry_cache_is_valid(cli)
    assert cli._registry_cache == registry_payload()
    assert sender.call_args.kwargs["headers"] == {
        "Content-Type": "application/json", "x-arcanos-daemon-token": DAEMON_TOKEN,
    }
    sender.assert_called_once()


def test_prompt_registry_status_does_not_infer_backend_health():
    cli, _, _ = make_cli(registry_payload())
    unavailable = state.get_backend_connection_status(cli)
    assert "registry evidence: unavailable or stale" in unavailable
    assert "Backend health is unknown" in unavailable
    backend_ops.refresh_registry_cache(cli)
    available = state.get_backend_connection_status(cli)
    assert "registry evidence: authenticated and fresh" in available
    assert "Backend health is not established" in available


@pytest.mark.parametrize("field,value", [
    ("version", True), ("version", 2), ("version", "1"),
    ("updatedAt", None), ("updatedAt", "yesterday"),
    ("updatedAt", "2026-11-04T19:30:20"),
    ("endpoints", []), ("endpoints", {}), ("endpoints", [{}]),
    ("modules", None), ("modules", ["module"]),
    ("daemonTools", []), ("daemonTools", [{}]),
    ("core", []), ("core", "HRC"),
])
def test_malformed_registry_fields_never_hydrate_cache(field, value):
    payload = registry_payload()
    payload[field] = value
    cli, sender, _ = make_cli(payload)

    response = cli.backend_client.request_registry()

    assert not response.ok
    assert response.error is not None and response.error.kind == "parse"
    assert response.error.details is None
    assert DAEMON_TOKEN not in str(response.error)
    assert cli._registry_cache is None
    sender.assert_called_once()


@pytest.mark.parametrize("field,key,value", [
    ("endpoints", "path", None),
    ("daemonTools", "sensitive", "false"),
    ("modules", "actions", "execute"),
    ("modules", "actions", [None]),
    ("modules", "description", 1),
    ("core", "modes", "strict"),
    ("core", "modes", [None]),
])
def test_malformed_registry_entries_never_grant_trust(field, key, value):
    payload = registry_payload()
    payload[field][0][key] = value
    cli, sender, _ = make_cli(payload)
    backend_ops.refresh_registry_cache(cli)

    assert cli._trust_state is TrustState.DEGRADED
    assert cli._registry_cache is None
    sender.assert_called_once()


def test_empty_module_catalog_and_nullable_module_fields_are_supported():
    for modules in ([], [{**registry_payload()["modules"][0], "description": None, "route": None}]):
        payload = {**registry_payload(), "modules": modules}
        cli, sender, _ = make_cli(payload)
        backend_ops.refresh_registry_cache(cli)
        assert cli._trust_state is TrustState.FULL
        sender.assert_called_once()


@pytest.mark.parametrize("status_code", [401, 429, 503])
def test_registry_http_failure_stays_degraded_without_retry(status_code):
    cli, sender, generic_token = make_cli({"error": "fixture unavailable"}, status_code=status_code)
    backend_ops.refresh_registry_cache_if_stale(cli)

    assert cli._trust_state is TrustState.DEGRADED
    assert cli._registry_cache is None
    sender.assert_called_once()
    generic_token.assert_not_called()


@pytest.mark.parametrize("token", [None, "", "short"])
def test_missing_or_invalid_local_daemon_credential_never_sends_request(token):
    cli, sender, generic_token = make_cli(registry_payload(), token=token)
    backend_ops.refresh_registry_cache_if_stale(cli)

    assert cli._trust_state is TrustState.DEGRADED
    sender.assert_not_called()
    generic_token.assert_not_called()


def test_registry_ttl_boundary_expiration_and_refresh_recovery(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(state.time, "time", lambda: now[0])
    cli, sender, _ = make_cli(registry_payload())
    backend_ops.refresh_registry_cache_if_stale(cli)
    assert cli._trust_state is TrustState.FULL
    ttl = cli._registry_cache_ttl_seconds

    now[0] += ttl
    backend_ops.refresh_registry_cache_if_stale(cli)
    sender.assert_called_once()
    assert state.registry_cache_is_valid(cli)

    now[0] += 0.001
    state.recompute_trust_state(cli)
    assert cli._trust_state is TrustState.DEGRADED
    assert not state.registry_cache_is_valid(cli)

    backend_ops.refresh_registry_cache_if_stale(cli)
    assert sender.call_count == 2
    assert cli._trust_state is TrustState.FULL
    assert cli._registry_cache_ttl_seconds == ttl


def test_clock_rollback_does_not_treat_future_cache_timestamp_as_fresh(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(state.time, "time", lambda: now[0])
    cli, _, _ = make_cli(registry_payload())
    backend_ops.refresh_registry_cache_if_stale(cli)
    now[0] = 999.0

    state.recompute_trust_state(cli)

    assert not state.registry_cache_is_valid(cli)
    assert cli._trust_state is TrustState.DEGRADED


def test_expired_registry_and_failed_refresh_preserve_degraded(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(state.time, "time", lambda: now[0])
    cli, sender, _ = make_cli(registry_payload())
    backend_ops.refresh_registry_cache_if_stale(cli)
    cached_at = cli._registry_cache_updated_at
    now[0] += cli._registry_cache_ttl_seconds + 1
    sender.return_value.status_code = 503
    backend_ops.refresh_registry_cache_if_stale(cli)

    assert cli._trust_state is TrustState.DEGRADED
    assert cli._registry_cache_updated_at == cached_at
    with pytest.raises(GovernanceError):
        assert_allowed("backend_confirm", cli._trust_state, requires_confirmation=True)


def test_malformed_refresh_does_not_replace_or_extend_existing_evidence(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(state.time, "time", lambda: now[0])
    cli, sender, _ = make_cli(registry_payload())
    backend_ops.refresh_registry_cache(cli)
    cached_at = cli._registry_cache_updated_at
    cached_payload = deepcopy(cli._registry_cache)
    now[0] += cli._registry_cache_ttl_seconds + 1
    sender.return_value.json = lambda: {"ok": True}

    backend_ops.refresh_registry_cache(cli)

    assert cli._trust_state is TrustState.DEGRADED
    assert cli._registry_cache == cached_payload
    assert cli._registry_cache_updated_at == cached_at
    assert sender.call_count == 2


@pytest.mark.parametrize("clock_change", ["expired", "rollback"])
@pytest.mark.parametrize("refresh_status", [200, 401, 429, 503])
def test_conversation_prompt_matches_registry_evidence_after_refresh(
    monkeypatch, clock_change, refresh_status,
):
    now = [1000.0]
    monkeypatch.setattr(state.time, "time", lambda: now[0])
    payload = registry_payload()
    payload["endpoints"][0]["description"] = "Fresh registry fixture marker"
    cli, sender, _ = make_cli(payload)
    cli.memory = SimpleNamespace(get_recent_conversations=lambda **kwargs: [])
    cli.instance_id = "fixture-instance"
    cli.client_id = "fixture-client"
    backend_ops.refresh_registry_cache(cli)
    cli.system_prompt = state.build_system_prompt(cli)
    assert "registry evidence: authenticated and fresh" in cli.system_prompt
    assert "Fresh registry fixture marker" in cli.system_prompt

    # The prompt was prepared while the cache was fresh. It becomes invalid
    # before perform_backend_conversation does its own freshness check.
    now[0] += cli._registry_cache_ttl_seconds + 1 if clock_change == "expired" else -1
    sender.return_value.status_code = refresh_status
    monkeypatch.setattr(backend_ops, "build_backend_metadata", lambda _: {})
    chat = MagicMock(return_value=BackendResponse(
        ok=True, value=BackendChatResult("Hello", 0, 0.0, "fixture"),
    ))
    monkeypatch.setattr(cli.backend_client, "request_chat_completion", chat)
    build_prompt = MagicMock(wraps=state.build_system_prompt)
    monkeypatch.setattr(state, "build_system_prompt", build_prompt)

    result = backend_ops.perform_backend_conversation(cli, "hello")

    assert result is not None and result.source == "backend"
    sent_prompt = chat.call_args.kwargs["messages"][0]["content"]
    if refresh_status == 200:
        assert cli._trust_state is TrustState.FULL
        assert "registry evidence: authenticated and fresh" in sent_prompt
        assert "Fresh registry fixture marker" in sent_prompt
    else:
        assert cli._trust_state is TrustState.DEGRADED
        assert "registry evidence: unavailable or stale" in sent_prompt
        assert "registry evidence: authenticated and fresh" not in sent_prompt
        assert "Fresh registry fixture marker" not in sent_prompt
    # One startup fetch plus one refresh; no retry or duplicate prompt rebuild.
    assert sender.call_count == 2
    build_prompt.assert_called_once_with(cli)
    chat.assert_called_once()


def test_fresh_conversation_avoids_registry_fetch_and_prompt_rebuild(monkeypatch):
    cli, sender, _ = make_cli(registry_payload())
    cli.memory = SimpleNamespace(get_recent_conversations=lambda **kwargs: [])
    cli.instance_id = "fixture-instance"
    cli.client_id = "fixture-client"
    backend_ops.refresh_registry_cache(cli)
    cli.system_prompt = state.build_system_prompt(cli)
    monkeypatch.setattr(backend_ops, "build_backend_metadata", lambda _: {})
    chat = MagicMock(return_value=BackendResponse(
        ok=True, value=BackendChatResult("Hello", 0, 0.0, "fixture"),
    ))
    monkeypatch.setattr(cli.backend_client, "request_chat_completion", chat)
    build_prompt = MagicMock(wraps=state.build_system_prompt)
    monkeypatch.setattr(state, "build_system_prompt", build_prompt)

    assert backend_ops.perform_backend_conversation(cli, "hello") is not None

    sender.assert_called_once()
    build_prompt.assert_not_called()
    chat.assert_called_once()


def test_successful_conversation_does_not_replace_unavailable_registry_evidence(monkeypatch):
    cli, sender, _ = make_cli({"error": "server credential missing"}, status_code=503)
    cli.memory = SimpleNamespace(get_recent_conversations=lambda **kwargs: [])
    cli.system_prompt = "fixture prompt"
    cli.instance_id = "fixture-instance"
    cli.client_id = "fixture-client"
    monkeypatch.setattr(backend_ops, "build_backend_metadata", lambda _: {})
    chat = MagicMock(return_value=BackendResponse(ok=True, value=BackendChatResult("Hello", 0, 0.0, "fixture")))
    monkeypatch.setattr(cli.backend_client, "request_chat_completion", chat)

    result = backend_ops.perform_backend_conversation(cli, "hello")

    assert result is not None and result.source == "backend"
    assert cli._trust_state is TrustState.DEGRADED
    assert cli._registry_cache is None
    sender.assert_called_once()
    chat.assert_called_once()


def test_confirmation_with_unavailable_registry_is_unsafe_and_not_executed(monkeypatch):
    cli, sender, _ = make_cli({"error": "server credential missing"}, status_code=503)
    cli.memory = SimpleNamespace(get_recent_conversations=lambda **kwargs: [])
    cli.system_prompt = "fixture prompt"
    cli.instance_id = "fixture-instance"
    cli.client_id = "fixture-client"
    monkeypatch.setattr(backend_ops, "build_backend_metadata", lambda _: {})
    monkeypatch.setattr(backend_ops, "audit_record", lambda *args, **kwargs: None)
    monkeypatch.setattr(backend_ops, "_emit_backend_failure_telemetry", lambda *args, **kwargs: None)
    monkeypatch.setattr(cli.backend_client, "request_chat_completion", lambda **kwargs: BackendResponse(
        ok=False, error=BackendRequestError(kind="confirmation", message="Confirmation required"),
    ))

    assert backend_ops.perform_backend_conversation(cli, "run a command") is None
    assert cli._trust_state is TrustState.UNSAFE
    sender.assert_called_once()
