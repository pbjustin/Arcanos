"""CLI diagnostics consume valid status evidence before hydration or success."""

from __future__ import annotations

from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from arcanos.cli import backend_ops, state
from .test_cli_diagnostic_audit import diagnostic_cli, _execution_events


def _status_payload():
    """Return a minimum valid envelope with an observable, server-reported intent."""
    return {
        "mode": "system_state",
        "intent": {"intentId": "envelope-fixture-intent", "label": "Continue the reviewed task", "status": "active"},
        "routing": {"preferred": "backend"},
        "backend": {"connected": False, "registryAvailable": False},
        "stateFreshness": {"intent": "stale", "backend": "stale"},
        "generatedAt": "2026-11-04T19:30:26.000Z",
    }


def _invalid_payload(condition):
    """Create malformed envelopes while retaining tempting intent labels where possible."""
    payload = _status_payload()
    if condition == "empty":
        return {}
    if condition == "mode_only":
        return {"mode": "system_state"}
    if condition == "wrong_mode":
        payload["mode"] = "chat"
    elif condition == "missing_intent":
        del payload["intent"]
    elif condition == "missing_routing":
        del payload["routing"]
    elif condition == "missing_backend":
        del payload["backend"]
    elif condition == "missing_freshness":
        del payload["stateFreshness"]
    elif condition == "wrong_backend_type":
        payload["backend"] = []
    elif condition == "wrong_boolean_type":
        payload["backend"]["connected"] = "true"
    elif condition == "missing_core_key":
        del payload["backend"]["registryAvailable"]
    return payload


def _invoke(cli, entrypoint):
    """Invoke the actual public handler and return its diagnostic text and result."""
    if entrypoint == "ask":
        result = cli.handle_ask("Is ARCANOS healthy?", return_result=True)
        assert result.source == "diagnostic"
        return result.response_text, result
    result = cli.handle_status()
    return cli.console.file.getvalue(), result


def _assert_audit(events, entrypoint, succeeded, trust):
    """Require one matching attempt/outcome pair without inferring overall health."""
    command = "ask" if entrypoint == "ask" else "status"
    assert [(event["event"], event["command"]) for event in events] == [
        ("execute_attempt", command), ("execute_success" if succeeded else "execute_failed", command),
    ]
    assert all(event["trust"] == trust for event in events)
    assert all(event["source"] == "diagnostic" and event["operation"] == "status" for event in events)


@pytest.mark.parametrize("entrypoint", ["ask", "status"])
@pytest.mark.parametrize("condition", [
    "empty", "mode_only", "wrong_mode", "missing_intent", "missing_routing",
    "missing_backend", "missing_freshness", "wrong_backend_type", "wrong_boolean_type", "missing_core_key",
])
def test_real_client_invalid_envelopes_never_hydrate_or_record_success(
    diagnostic_cli, capsys, entrypoint, condition,
):
    """Malformed HTTP 200 bodies remain unavailable evidence in each CLI diagnostic path."""
    cli, scenario, requests, _ = diagnostic_cli
    cli.session.current_intent = cli.session.conversation_goal = "Keep the prior local context"
    scenario["state_payload"] = _invalid_payload(condition)
    initial_cache = deepcopy(cli._registry_cache)
    initial_stamp = cli._registry_cache_updated_at
    initial_trust = cli._trust_state.name
    capsys.readouterr()

    text, result = _invoke(cli, entrypoint)

    _assert_audit(_execution_events(capsys.readouterr().out), entrypoint, False, initial_trust)
    assert "Backend status read: unavailable" in text
    assert "authenticated GET /system-state succeeded" not in text
    assert "Memory consistency: unknown" in text and "Overall stability and risk: unknown" in text
    assert cli.session.current_intent == cli.session.conversation_goal == "Keep the prior local context"
    assert cli._registry_cache == initial_cache and cli._registry_cache_updated_at == initial_stamp
    assert requests == [("get", "/system-state")]
    if entrypoint == "status":
        assert result is False


@pytest.mark.parametrize("entrypoint", ["ask", "status"])
@pytest.mark.parametrize("unknown", [False, True], ids=["reported-values", "explicit-unknowns"])
def test_valid_and_explicit_unknown_envelopes_retain_honest_diagnostic_evidence(
    diagnostic_cli, capsys, entrypoint, unknown,
):
    """A valid envelope may report false or unknown values without proving dependency health."""
    cli, scenario, requests, _ = diagnostic_cli
    cli.session.current_intent = cli.session.conversation_goal = "Keep the prior local context"
    payload = _status_payload()
    if unknown:
        payload.update({"intent": {"intentId": None}, "routing": {"preferred": None},
                        "backend": {"connected": None, "registryAvailable": None},
                        "stateFreshness": {"intent": None, "backend": None}, "generatedAt": None})
    scenario["state_payload"] = payload
    initial_trust = cli._trust_state.name
    capsys.readouterr()

    text, result = _invoke(cli, entrypoint)

    _assert_audit(_execution_events(capsys.readouterr().out), entrypoint, True, initial_trust)
    assert "authenticated GET /system-state succeeded" in text
    assert f"Backend-reported connection: {'unknown' if unknown else 'false'}" in text
    assert "Memory consistency: unknown" in text and "Overall stability and risk: unknown" in text
    assert "System state: Stable" not in text and "Risk level: Low" not in text
    expected_intent = "Keep the prior local context" if unknown else "Continue the reviewed task"
    assert cli.session.current_intent == cli.session.conversation_goal == expected_intent
    assert requests == [("get", "/system-state")]
    if entrypoint == "status":
        assert result is True


@pytest.mark.parametrize("entrypoint", ["ask", "status"])
def test_invalid_status_recovers_on_a_later_explicit_read_without_changing_trust(
    diagnostic_cli, capsys, entrypoint,
):
    """One later valid read restores status evidence without retries or registry elevation."""
    cli, scenario, requests, _ = diagnostic_cli
    scenario["state_payload"] = {"mode": "system_state"}
    initial_trust = cli._trust_state.name
    capsys.readouterr()
    _invoke(cli, entrypoint)
    _assert_audit(_execution_events(capsys.readouterr().out), entrypoint, False, initial_trust)
    assert requests == [("get", "/system-state")]
    scenario["state_payload"] = _status_payload()
    cli.console.file.seek(0)
    cli.console.file.truncate(0)

    text, result = _invoke(cli, entrypoint)

    _assert_audit(_execution_events(capsys.readouterr().out), entrypoint, True, initial_trust)
    assert "authenticated GET /system-state succeeded" in text
    assert cli.session.current_intent == "Continue the reviewed task"
    assert requests == [("get", "/system-state"), ("get", "/system-state")]
    if entrypoint == "status":
        assert result is True


@pytest.mark.parametrize("entrypoint", ["ask", "status"])
def test_valid_status_read_cannot_replace_missing_registry_evidence(diagnostic_cli, capsys, entrypoint):
    """A successful structured status read preserves DEGRADED when registry evidence is unavailable."""
    cli, scenario, requests, _ = diagnostic_cli
    state.initialize_runtime_state(cli)
    scenario["registry_status"] = 503
    scenario["state_payload"] = _status_payload()
    capsys.readouterr()

    text, result = _invoke(cli, entrypoint)

    _assert_audit(_execution_events(capsys.readouterr().out), entrypoint, True, "DEGRADED")
    assert "Daemon trust (local): DEGRADED" in text
    assert "Daemon registry evidence (local): unavailable" in text
    assert "authenticated GET /system-state succeeded" in text
    assert "Memory consistency: unknown" in text and "Overall stability and risk: unknown" in text
    assert cli._registry_cache is None and cli._registry_cache_updated_at is None
    assert requests == [("get", "/api/daemon/registry"), ("get", "/system-state")]
    if entrypoint == "status":
        assert result is True


@pytest.mark.parametrize("entrypoint", ["ask", "status"])
@pytest.mark.parametrize("condition", ["mode_only", "missing_backend", "wrong_boolean_type"])
def test_cli_validates_adapter_results_before_hydration_or_success(
    diagnostic_cli, capsys, monkeypatch, entrypoint, condition,
):
    """Diagnostic guards also reject incomplete values returned by an alternate adapter."""
    cli, _, requests, _ = diagnostic_cli
    cli.session.current_intent = "Keep the prior local context"
    read = MagicMock(return_value=_invalid_payload(condition))
    monkeypatch.setattr(backend_ops, "request_backend_system_state_payload", read)
    initial_trust = cli._trust_state.name
    capsys.readouterr()

    text, result = _invoke(cli, entrypoint)

    _assert_audit(_execution_events(capsys.readouterr().out), entrypoint, False, initial_trust)
    assert "Backend status read: unavailable" in text
    assert cli.session.current_intent == "Keep the prior local context"
    assert requests == []
    read.assert_called_once_with(cli)
    if entrypoint == "status":
        assert result is False
