"""Read-only status evidence must retain the TypeScript-owned envelope shape."""

from __future__ import annotations

from copy import deepcopy
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from arcanos.backend_client import BackendApiClient
from arcanos.cli import state
from arcanos.cli_session import SessionContext
from arcanos.config import Config


CONTROL_TOKEN = "envelope-control-fixture-only-1234567890"


def system_state_payload() -> dict:
    """Mirror the response emitted by src/services/systemState.ts."""
    return {
        "mode": "system_state",
        "intent": {
            "intentId": None, "label": None, "status": None, "phase": None,
            "confidence": 0, "version": 1, "lastTouchedAt": None,
        },
        "routing": {"preferred": "backend", "lastUsed": "local", "confidenceGate": 0.75},
        "backend": {
            "connected": True, "registryAvailable": True,
            "lastHeartbeatAt": "2026-11-04T19:30:26.000Z",
        },
        "stateFreshness": {
            "intent": "stale", "backend": "fresh", "lastValidatedAt": "2026-11-04T19:30:26.000Z",
        },
        "limits": {"rateLimited": False, "remainingRequests": 0},
        "generatedAt": "2026-11-04T19:30:26.000Z", "confidence": 0.99,
    }


def _response(payload):
    """Return an in-memory HTTP response without contacting any service."""
    return SimpleNamespace(status_code=200, json=lambda: payload, text=json.dumps(payload), headers={})


@pytest.fixture
def make_client(monkeypatch):
    """Create real clients whose sole transport is a deterministic fixture sender."""
    monkeypatch.setattr(Config, "CONTROL_PLANE_ACCESS_TOKEN", CONTROL_TOKEN)

    def build(payload):
        """Build one client and expose its sender for request-count assertions."""
        sender = MagicMock(return_value=_response(payload))
        unrelated = MagicMock(side_effect=AssertionError("Control reads must not read unrelated credentials"))
        client = BackendApiClient(
            "https://envelope.example.invalid", unrelated, request_sender=sender,
            daemon_access_token_provider=unrelated,
        )
        return client, sender, unrelated

    return build


@pytest.mark.parametrize("payload", [{}, {"mode": "system_state"}, {"mode": "chat"}, {"error": "unavailable"}])
def test_real_client_rejects_missing_status_envelope(make_client, payload):
    """A canonical mode label alone cannot turn HTTP 200 into valid evidence."""
    client, sender, unrelated = make_client(payload)

    response = client.request_system_state()

    assert response.ok is False
    assert response.value is None
    assert response.error is not None and response.error.kind == "parse"
    assert response.error.details is None
    sender.assert_called_once()
    unrelated.assert_not_called()


@pytest.mark.parametrize("field", ["intent", "routing", "backend", "stateFreshness", "generatedAt"])
def test_real_client_rejects_missing_essential_sections(make_client, field):
    """Each essential section remains required even when other fields look valid."""
    payload = system_state_payload()
    del payload[field]
    client, sender, _ = make_client(payload)

    response = client.request_system_state()

    assert response.ok is False
    assert response.error is not None and response.error.kind == "parse"
    sender.assert_called_once()


@pytest.mark.parametrize("field,value", [
    ("intent", []), ("routing", "backend"), ("backend", True), ("stateFreshness", None),
    ("generatedAt", 1),
])
def test_real_client_rejects_wrong_envelope_section_types(make_client, field, value):
    """Wrong section types cannot be silently replaced by empty successful sections."""
    payload = system_state_payload()
    payload[field] = value
    client, sender, _ = make_client(payload)

    assert client.request_system_state().ok is False
    sender.assert_called_once()


def test_complete_status_envelope_preserves_the_server_owned_value(make_client):
    """The consumer accepts the complete existing response without changing it."""
    payload = system_state_payload()
    client, sender, unrelated = make_client(payload)

    response = client.request_system_state(metadata={"instanceId": "fixture-session"})

    assert response.ok is True
    assert response.value == payload
    sender.assert_called_once()
    assert sender.call_args.args == ("get", "https://envelope.example.invalid/system-state?sessionId=fixture-session")
    assert sender.call_args.kwargs["headers"] == {
        "Content-Type": "application/json", "Authorization": f"Bearer {CONTROL_TOKEN}",
    }
    unrelated.assert_not_called()


@pytest.mark.parametrize("section,key", [
    ("intent", "intentId"), ("routing", "preferred"),
    ("backend", "connected"), ("backend", "registryAvailable"),
    ("stateFreshness", "intent"), ("stateFreshness", "backend"),
])
def test_missing_required_measurement_keys_do_not_make_an_empty_section_valid(make_client, section, key):
    """Explicitly unknown values are supported, but absent envelope keys are invalid."""
    payload = system_state_payload()
    del payload[section][key]
    client, sender, _ = make_client(payload)

    assert client.request_system_state().ok is False
    sender.assert_called_once()


@pytest.mark.parametrize("section,key,value", [
    ("intent", "intentId", 1), ("intent", "label", {}),
    ("intent", "status", "healthy"), ("intent", "phase", "ready"),
    ("intent", "confidence", True), ("intent", "confidence", float("nan")),
    ("intent", "confidence", float("inf")), ("intent", "confidence", 10 ** 400),
    ("intent", "version", True), ("intent", "version", 0),
    ("intent", "lastTouchedAt", "not a timestamp"),
    ("routing", "preferred", "cloud"), ("routing", "lastUsed", []),
    ("routing", "confidenceGate", 1.5),
    ("backend", "connected", "true"), ("backend", "registryAvailable", 1),
    ("backend", "lastHeartbeatAt", "2026-11-04T19:30:26"),
    ("stateFreshness", "intent", []), ("stateFreshness", "backend", "healthy"),
    ("stateFreshness", "lastValidatedAt", 1),
    ("limits", "rateLimited", "false"), ("limits", "remainingRequests", -1),
])
def test_wrong_known_field_types_and_enums_fail_closed(make_client, section, key, value):
    """Malformed measurements cannot masquerade as a recognized status envelope."""
    payload = system_state_payload()
    payload[section][key] = value
    client, sender, _ = make_client(payload)

    response = client.request_system_state()

    assert response.ok is False
    assert response.value is None
    assert response.error is not None and response.error.kind == "parse"
    assert response.error.details is None
    sender.assert_called_once()


def test_minimal_envelope_allows_optional_fields_to_be_absent(make_client):
    """Transient details and unused limit/confidence metadata are not mandatory."""
    payload = {
        "mode": "system_state", "intent": {"intentId": None}, "routing": {"preferred": "backend"},
        "backend": {"connected": False, "registryAvailable": False},
        "stateFreshness": {"intent": "stale", "backend": "stale"}, "generatedAt": None,
    }
    client, sender, _ = make_client(payload)

    response = client.request_system_state()

    assert response.ok is True and response.value == payload
    sender.assert_called_once()


def test_explicit_unknown_measurements_are_valid_without_inventing_health(make_client):
    """Null measurements preserve a valid envelope and remain unknown to consumers."""
    payload = {
        "mode": "system_state", "intent": {"intentId": None}, "routing": {"preferred": None},
        "backend": {"connected": None, "registryAvailable": None},
        "stateFreshness": {"intent": None, "backend": "unknown"}, "generatedAt": None,
    }
    client, sender, _ = make_client(payload)

    response = client.request_system_state()

    assert response.ok is True and response.value == payload
    assert response.value["backend"]["connected"] is None
    sender.assert_called_once()


def test_extra_server_fields_do_not_change_envelope_recognition(make_client):
    """Additional server metadata is accepted without becoming required or authoritative."""
    payload = deepcopy(system_state_payload())
    payload.update({"memory": {"available": True, "consistent": True}, "risk": "low", "future": []})
    client, sender, _ = make_client(payload)

    response = client.request_system_state()

    assert response.ok is True and response.value == payload
    sender.assert_called_once()


def test_malformed_envelope_error_never_reflects_response_credentials(make_client):
    """Envelope rejection exposes a fixed parse error rather than the response body."""
    payload = system_state_payload()
    payload["backend"]["connected"] = CONTROL_TOKEN
    client, sender, _ = make_client(payload)

    response = client.request_system_state()

    assert response.ok is False
    assert CONTROL_TOKEN not in repr(response)
    assert response.error.message == "Backend system-state envelope is malformed or unsupported"
    sender.assert_called_once()


def test_rejected_status_can_recover_on_one_subsequent_read_without_registry_trust(make_client):
    """A later valid read recovers status evidence without granting daemon trust."""
    client, sender, _ = make_client({"mode": "system_state"})
    cli = SimpleNamespace(backend_client=client, console=SimpleNamespace(print=MagicMock()),
                          session=SessionContext(session_id="fixture-session"))
    state.initialize_runtime_state(cli)
    initial_trust = cli._trust_state

    assert client.request_system_state().ok is False
    sender.return_value = _response(system_state_payload())
    recovered = client.request_system_state()

    assert recovered.ok is True
    assert sender.call_count == 2
    assert cli._registry_cache is None
    assert cli._trust_state is initial_trust
