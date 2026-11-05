"""Diagnostic audit outcomes retain the identity of the invoked CLI command."""

from __future__ import annotations

import io
import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest
from rich.console import Console

from arcanos.backend_client import BackendApiClient
from arcanos.cli import backend_ops, cli as cli_module, state
from arcanos.cli_runner import _dispatch_command
from arcanos.cli_session import SessionContext
from arcanos.config import Config


DAEMON_TOKEN = "diagnostic-audit-daemon-fixture-1234567890"
CONTROL_TOKEN = "diagnostic-audit-control-fixture-1234567890"
GPT_TOKEN = "diagnostic-audit-writing-fixture-1234567890"


def _response(status, payload):
    return SimpleNamespace(status_code=status, json=lambda: payload,
                           text=json.dumps(payload), headers={})


@pytest.fixture
def diagnostic_cli(monkeypatch):
    """Build a real client with synthetic credentials, state, clock, and a controlled sender."""
    now = [1000.0]
    monkeypatch.setattr(state.time, "time", lambda: now[0])
    monkeypatch.setattr(state.time, "monotonic", lambda: now[0])
    for name, value in {
        "CONTROL_PLANE_ACCESS_TOKEN": CONTROL_TOKEN,
        "AGENTIC_ENABLED": False, "STREAM_RESPONSES": False, "SPEAK_RESPONSES": False,
        "BACKEND_FALLBACK_TO_LOCAL": False, "BACKEND_SEND_UPDATES": False,
        "REPO_INDEX_ENABLED": False,
    }.items():
        monkeypatch.setattr(Config, name, value)
    registry = {
        "version": 1, "updatedAt": "2026-11-04T19:30:20.000Z",
        "endpoints": [{"method": "POST", "path": "/gpt/arcanos-daemon", "description": "Chat"}],
        "modules": [],
        "daemonTools": [{"name": "run_command", "description": "Run command", "sensitive": True}],
        "core": [{"id": "HRC", "description": "Core"}],
    }
    system_state = {
        "mode": "system_state", "backend": {"connected": True, "registryAvailable": True},
        "intent": {"intentId": None}, "routing": {"preferred": "backend"},
        "stateFreshness": {"backend": "fresh", "intent": "stale"},
        "generatedAt": "2026-11-04T19:30:26.000Z",
    }
    scenario = {"registry_status": 200, "state_status": 200, "state_payload": system_state}
    requests = []

    def sender(method, url, **kwargs):
        """Serve deterministic responses while checking each route's credential purpose."""
        path = urlsplit(url).path
        requests.append((method, path))
        if path == "/api/daemon/registry":
            assert kwargs["headers"].get("x-arcanos-daemon-token") == DAEMON_TOKEN
            return _response(scenario["registry_status"], registry)
        if path == "/system-state":
            assert kwargs["headers"].get("Authorization") == f"Bearer {CONTROL_TOKEN}"
            if scenario.get("expire_during_read"):
                now[0] += cli._registry_cache_ttl_seconds + 1
            return _response(scenario["state_status"], scenario["state_payload"])
        if path == "/gpt/arcanos-daemon":
            assert kwargs["headers"].get("Authorization") == f"Bearer {GPT_TOKEN}"
            return _response(200, {"response": "Hello from the conversation fixture."})
        raise AssertionError(f"Unexpected local fixture request: {method} {path}")

    cli = cli_module.ArcanosCLI.__new__(cli_module.ArcanosCLI)
    cli.console = Console(file=io.StringIO(), width=200, color_system=None, force_terminal=False)
    cli.backend_client = BackendApiClient(
        "https://diagnostic.example.invalid", lambda: GPT_TOKEN, request_sender=sender,
        daemon_access_token_provider=lambda: DAEMON_TOKEN,
    )
    state.initialize_runtime_state(cli)
    cli.instance_id = "private-diagnostic-audit-session"
    cli.client_id = "fixture-client"
    cli.session = SessionContext(session_id=cli.instance_id)
    cli.memory = MagicMock()
    cli.memory.get_recent_conversations.return_value = []
    cli.rate_limiter = MagicMock()
    cli.rate_limiter.can_make_request.return_value = (True, None)
    cli._append_activity = MagicMock()
    cli.audio = MagicMock()
    monkeypatch.setattr(cli_module.local_ops, "perform_local_conversation", MagicMock(
        side_effect=AssertionError("Diagnostics must not invoke a local provider"),
    ))
    monkeypatch.setattr(cli_module.memory_ops, "record_conversation_turn", MagicMock())
    monkeypatch.setattr(cli_module.memory_ops, "update_short_term_summary", MagicMock())
    backend_ops.refresh_registry_cache(cli)
    cli.system_prompt = state.build_system_prompt(cli)
    requests.clear()
    return cli, scenario, requests, now


def _execution_events(output):
    events = [json.loads(line.removeprefix("[AUDIT] ")) for line in output.splitlines()
              if line.startswith("[AUDIT] ")]
    return [event for event in events if event["event"].startswith("execute_")]


@pytest.mark.parametrize("entrypoint", ["ask", "slash_status"])
@pytest.mark.parametrize("condition", [
    "success", "missing_backend", "http_401", "http_403", "http_503",
    "malformed_list", "malformed_error", "malformed_mode", "expired_registry", "expires_during_read",
])
def test_diagnostic_audit_pairs_command_and_reports_only_observed_outcome(
    diagnostic_cli, capsys, entrypoint, condition,
):
    """Keep diagnostic audit identity, outcome, trust, privacy, and request counts accurate."""
    cli, scenario, requests, now = diagnostic_cli
    if condition == "missing_backend":
        cli.backend_client = None
    elif condition.startswith("http_"):
        scenario["state_status"] = int(condition.removeprefix("http_"))
    elif condition == "malformed_list":
        scenario["state_payload"] = ["not a system-state object"]
    elif condition == "malformed_error":
        scenario["state_payload"] = {"error": "system state unavailable"}
    elif condition == "malformed_mode":
        scenario["state_payload"] = {"mode": "chat", "backend": {"connected": True}}
    elif condition == "expired_registry":
        now[0] += cli._registry_cache_ttl_seconds + 1
        scenario["registry_status"] = 503
    elif condition == "expires_during_read":
        scenario["expire_during_read"] = True
    capsys.readouterr()  # Exclude the fixture's authenticated registry initialization.

    if entrypoint == "ask":
        result = cli.handle_ask("Is ARCANOS healthy?", return_result=True)
        text = result.response_text
        assert result.source == "diagnostic"
    else:
        _dispatch_command(cli, "status")
        text = cli.console.file.getvalue()

    output = capsys.readouterr().out
    events = _execution_events(output)
    succeeded = condition in ("success", "expired_registry", "expires_during_read")
    command = "ask" if entrypoint == "ask" else "status"
    assert [(event["event"], event["command"]) for event in events] == [
        ("execute_attempt", command), ("execute_success" if succeeded else "execute_failed", command),
    ]
    attempt_trust = "DEGRADED" if condition in ("missing_backend", "expired_registry") else "FULL"
    terminal_trust = "DEGRADED" if condition == "expires_during_read" else attempt_trust
    assert [event["trust"] for event in events] == [attempt_trust, terminal_trust]
    assert f"Daemon trust (local): {terminal_trust}" in text
    assert all(event["source"] == "diagnostic" and event["operation"] == "status" for event in events)
    observed_read = "Backend status read (observed): authenticated GET /system-state succeeded"
    if succeeded:
        assert observed_read in text
    else:
        assert "Backend status read: unavailable" in text
        assert observed_read not in text
    assert "Memory availability: unknown" in text
    assert "Memory consistency: unknown" in text
    assert "Overall stability and risk: unknown" in text
    assert "System state: Stable" not in text
    assert "Risk level: Low" not in text
    assert sum(path == "/system-state" for _, path in requests) == (condition != "missing_backend")
    assert sum(path == "/api/daemon/registry" for _, path in requests) == (condition == "expired_registry")
    assert not any(path.startswith("/gpt/") for _, path in requests)
    for private in (DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN, cli.instance_id, "Is ARCANOS healthy?"):
        assert private not in output
    assert all("payload" not in event and "response" not in event for event in events)


def test_ordinary_gpt_audit_keeps_ask_identity_without_diagnostic_operation(diagnostic_cli, capsys):
    """Preserve ordinary ask audit fields and its single synthetic chat request."""
    cli, _, requests, _ = diagnostic_cli
    capsys.readouterr()

    result = cli.handle_ask("Hello", return_result=True)

    events = _execution_events(capsys.readouterr().out)
    assert result.source == "backend"
    assert [(event["event"], event["command"]) for event in events] == [
        ("execute_attempt", "ask"), ("execute_success", "ask"),
    ]
    assert events[-1]["source"] == "backend"
    assert all(event["trust"] == "FULL" and "operation" not in event for event in events)
    assert requests.count(("post", "/gpt/arcanos-daemon")) == 1
