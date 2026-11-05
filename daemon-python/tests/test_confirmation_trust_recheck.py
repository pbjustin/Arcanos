"""Sensitive confirmation requires current registry authority at each submission."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest

from arcanos.backend_client import BackendApiClient
from arcanos.cli import backend_ops, cli as cli_module, confirmation, state
from arcanos.cli.context import ConversationResult
from arcanos.cli.trust_state import TrustState
from arcanos.config import Config
from .test_cli_diagnostic_audit import CONTROL_TOKEN, DAEMON_TOKEN, GPT_TOKEN, _execution_events, diagnostic_cli
from .test_registry_trust import registry_payload


CHALLENGE = "082ce8db-8ebe-45ec-b31e-3a7c5e828f5f"


@pytest.fixture
def confirmation_fixture(diagnostic_cli, monkeypatch):
    """Build an actual CLI/client with synthetic challenge, approval, and queue transport."""
    cli, _, _, _ = diagnostic_cli
    clock = SimpleNamespace(wall=1000.0, elapsed=500.0)
    monkeypatch.setattr(state.time, "time", lambda: clock.wall)
    monkeypatch.setattr(state.time, "monotonic", lambda: clock.elapsed)
    monkeypatch.setattr(Config, "CONFIRM_SENSITIVE_ACTIONS", True)
    monkeypatch.setattr(confirmation.sys.stdin, "isatty", lambda: True)
    audit = MagicMock()
    monkeypatch.setattr(backend_ops, "audit_record", audit)
    scenario = {"expire_on_challenge": False, "first_confirmation_forbidden": False}
    requests, queued = [], []

    def sender(method, url, **kwargs):
        """Record local requests and simulate server challenge consumption without execution."""
        path = urlsplit(url).path
        requests.append((method, path))
        status = 200
        if path == "/api/daemon/registry":
            assert kwargs["headers"].get("x-arcanos-daemon-token") == DAEMON_TOKEN
            payload = registry_payload()
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
            if scenario["expire_on_challenge"]:
                clock.elapsed += cli._registry_cache_ttl_seconds + 1
                clock.wall += cli._registry_cache_ttl_seconds + 1
            status = 403
            payload = {"code": "CONFIRMATION_REQUIRED", "confirmationChallenge": {"id": CHALLENGE},
                       "pending_actions": [{"summary": "Run the synthetic sensitive action"}]}
        elif path == "/api/daemon/confirm-actions":
            assert kwargs["headers"] == {"Content-Type": "application/json", "x-arcanos-daemon-token": DAEMON_TOKEN}
            assert kwargs["json"] == {"confirmation_token": CHALLENGE, "instanceId": cli.instance_id}
            if scenario["first_confirmation_forbidden"]:
                scenario["first_confirmation_forbidden"] = False
                status, payload = 403, {"error": "Synthetic authorization denial"}
            elif queued:
                status, payload = 404, {"error": "Synthetic challenge was already consumed"}
            else:
                queued.append("synthetic-action")
                payload = {"status": "executed", "queued": 1}
        else:
            raise AssertionError(f"Unexpected fixture request: {method} {path}")
        return SimpleNamespace(status_code=status, json=lambda: payload, text=json.dumps(payload), headers={})

    cli.backend_client = BackendApiClient(
        "https://confirmation.example.invalid", lambda: GPT_TOKEN, request_sender=sender,
        daemon_access_token_provider=lambda: DAEMON_TOKEN,
    )
    backend_ops.refresh_registry_cache(cli)
    cli.system_prompt = state.build_system_prompt(cli)
    assert cli._trust_state is TrustState.FULL
    requests.clear()
    return SimpleNamespace(cli=cli, clock=clock, requests=requests, queued=queued, audit=audit, scenario=scenario)


@pytest.mark.parametrize("change", [
    "expired", "expired_then_wall_rollback", "future_wall", "missing_registry", "empty_registry",
    "missing_elapsed_anchor", "future_elapsed_anchor",
])
def test_confirmation_rechecks_registry_after_user_wait_without_refresh(confirmation_fixture, monkeypatch, change):
    """Approval cannot submit a sensitive action after its registry authority becomes invalid."""
    fixture = confirmation_fixture
    original_anchors = (fixture.cli._registry_cache_updated_at, fixture.cli._registry_cache_updated_monotonic_at)

    def approve_after_wait(_prompt):
        """Invalidate only the requested authority input while a real approval prompt is pending."""
        if change in ("expired", "expired_then_wall_rollback"):
            fixture.clock.elapsed += fixture.cli._registry_cache_ttl_seconds + 1
            fixture.clock.wall += fixture.cli._registry_cache_ttl_seconds + 1
            if change == "expired_then_wall_rollback":
                fixture.clock.wall = original_anchors[0] + 1
        elif change == "future_wall":
            fixture.clock.wall = original_anchors[0] - 1
        elif change == "missing_registry":
            fixture.cli._registry_cache = None
        elif change == "empty_registry":
            fixture.cli._registry_cache = {}
        elif change == "missing_elapsed_anchor":
            fixture.cli._registry_cache_updated_monotonic_at = None
        elif change == "future_elapsed_anchor":
            fixture.cli._registry_cache_updated_monotonic_at = fixture.clock.elapsed + 1
        return "yes"

    monkeypatch.setattr(fixture.cli.console, "input", approve_after_wait)

    result = backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request")

    assert result is None
    assert fixture.cli._trust_state is TrustState.UNSAFE
    assert fixture.cli._last_confirmation_handled is True
    assert fixture.requests == [("post", "/gpt/arcanos-daemon")]
    assert fixture.queued == []
    assert any(call.args[0] == "governance_denial" for call in fixture.audit.call_args_list)
    if change not in ("missing_elapsed_anchor", "future_elapsed_anchor"):
        assert (fixture.cli._registry_cache_updated_at, fixture.cli._registry_cache_updated_monotonic_at) == original_anchors


def test_fresh_approval_preserves_one_purpose_bound_confirmation_and_replay_response(confirmation_fixture, monkeypatch):
    """Normal approval submits once, and a later replay retains the server's rejection."""
    fixture = confirmation_fixture
    monkeypatch.setattr(fixture.cli.console, "input", lambda _prompt: "yes")

    result = backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request")

    assert result is not None and result.response_text == "Queued 1 action."
    assert fixture.cli._trust_state is TrustState.FULL
    assert fixture.requests == [("post", "/gpt/arcanos-daemon"), ("post", "/api/daemon/confirm-actions")]
    assert fixture.queued == ["synthetic-action"]
    assert backend_ops.confirm_pending_actions(fixture.cli, CHALLENGE) is None
    assert fixture.queued == ["synthetic-action"]
    assert fixture.requests[-1] == ("post", "/api/daemon/confirm-actions")


def test_direct_confirmation_call_cannot_bypass_expired_registry(confirmation_fixture):
    """The submission boundary gates direct callers as well as the interactive handler."""
    fixture = confirmation_fixture
    fixture.clock.elapsed += fixture.cli._registry_cache_ttl_seconds + 1

    assert backend_ops.confirm_pending_actions(fixture.cli, CHALLENGE) is None

    assert fixture.cli._trust_state is TrustState.UNSAFE
    assert fixture.requests == []
    assert fixture.queued == []


def test_direct_confirmation_without_backend_fails_closed(confirmation_fixture):
    """Removing the backend cannot retain an old FULL decision at the submission boundary."""
    fixture = confirmation_fixture
    fixture.cli.backend_client = None

    assert backend_ops.confirm_pending_actions(fixture.cli, CHALLENGE) is None

    assert fixture.cli._trust_state is TrustState.UNSAFE
    assert fixture.requests == [] and fixture.queued == []


@pytest.mark.parametrize("token", [None, "short"])
def test_missing_or_invalid_daemon_credential_never_falls_back_to_another_plane(
    confirmation_fixture, token,
):
    """The existing transport rejects invalid dedicated credentials before HTTP or queue mutation."""
    fixture = confirmation_fixture
    unrelated = MagicMock(side_effect=AssertionError("Confirmation must not read GPT credentials"))
    fixture.cli.backend_client._token_provider = unrelated
    fixture.cli.backend_client._daemon_access_token_provider = lambda: token

    assert backend_ops.confirm_pending_actions(fixture.cli, CHALLENGE) is None

    assert fixture.requests == [] and fixture.queued == []
    unrelated.assert_not_called()


def test_auth_retry_rechecks_trust_before_a_second_confirmation_submission(confirmation_fixture, monkeypatch):
    """Existing auth retry ownership cannot submit again after authority expires during recovery."""
    fixture = confirmation_fixture
    fixture.scenario["first_confirmation_forbidden"] = True
    monkeypatch.setattr(fixture.cli.console, "input", lambda _prompt: "yes")

    def recover_after_expiry(_cli):
        """Simulate the existing credential-recovery delay without changing credentials."""
        fixture.clock.elapsed += fixture.cli._registry_cache_ttl_seconds + 1
        return True

    recovery = MagicMock(side_effect=recover_after_expiry)
    monkeypatch.setattr(backend_ops, "refresh_backend_credentials", recovery)

    assert backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request") is None

    recovery.assert_called_once_with(fixture.cli)
    assert fixture.cli._trust_state is TrustState.UNSAFE
    assert fixture.requests == [("post", "/gpt/arcanos-daemon"), ("post", "/api/daemon/confirm-actions")]
    assert fixture.queued == []


def test_challenge_expiry_denial_never_falls_back_to_local_generation(confirmation_fixture, monkeypatch, capsys):
    """A confirmation governance denial remains handled and cannot trigger provider fallback."""
    fixture = confirmation_fixture
    fixture.scenario["expire_on_challenge"] = True
    monkeypatch.setattr(Config, "BACKEND_FALLBACK_TO_LOCAL", True)
    local = MagicMock(return_value=ConversationResult("Synthetic fallback", 0, 0.0, "fixture", "local"))
    monkeypatch.setattr(cli_module.local_ops, "perform_local_conversation", local)
    capsys.readouterr()

    result = fixture.cli.handle_ask("Synthetic sensitive request", return_result=True)

    assert result is None
    local.assert_not_called()
    assert fixture.cli._last_confirmation_handled is True
    assert fixture.cli._trust_state is TrustState.UNSAFE
    assert [event["event"] for event in _execution_events(capsys.readouterr().out)] == ["execute_attempt"]
    assert not any(path == "/api/daemon/confirm-actions" for _, path in fixture.requests)
    assert fixture.queued == []


def test_fresh_auth_retry_retains_the_existing_bounded_transport_behavior(confirmation_fixture, monkeypatch):
    """One existing auth recovery may retry while independently valid registry authority remains fresh."""
    fixture = confirmation_fixture
    fixture.scenario["first_confirmation_forbidden"] = True
    monkeypatch.setattr(fixture.cli.console, "input", lambda _prompt: "yes")
    recovery = MagicMock(return_value=True)
    monkeypatch.setattr(backend_ops, "refresh_backend_credentials", recovery)

    result = backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request")

    assert result is not None and result.response_text == "Queued 1 action."
    assert fixture.cli._trust_state is TrustState.FULL
    assert fixture.requests == [
        ("post", "/gpt/arcanos-daemon"), ("post", "/api/daemon/confirm-actions"),
        ("post", "/api/daemon/confirm-actions"),
    ]
    recovery.assert_called_once_with(fixture.cli)
    assert fixture.queued == ["synthetic-action"]


def test_existing_noninteractive_confirmation_policy_is_unchanged(confirmation_fixture, monkeypatch):
    """Disabling interactive prompting still requires legitimate FULL trust and one submission."""
    fixture = confirmation_fixture
    monkeypatch.setattr(Config, "CONFIRM_SENSITIVE_ACTIONS", False)
    prompt = MagicMock(side_effect=AssertionError("This existing configuration does not prompt"))
    monkeypatch.setattr(fixture.cli.console, "input", prompt)

    result = backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request")

    assert result is not None and result.response_text == "Queued 1 action."
    assert fixture.requests == [("post", "/gpt/arcanos-daemon"), ("post", "/api/daemon/confirm-actions")]
    prompt.assert_not_called()


def test_debug_confirmation_remains_rejected_without_prompt_or_submission(confirmation_fixture, monkeypatch):
    """The debug-source denial still precedes interactive approval and confirmation HTTP."""
    fixture = confirmation_fixture
    prompt = MagicMock(side_effect=AssertionError("Debug confirmation must not prompt"))
    monkeypatch.setattr(fixture.cli.console, "input", prompt)

    assert backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request", from_debug=True) is None

    assert fixture.requests == [("post", "/gpt/arcanos-daemon")]
    assert fixture.queued == []
    prompt.assert_not_called()


@pytest.mark.parametrize("answer", ["no", "", "cancel"])
def test_user_decline_does_not_submit_or_refresh(confirmation_fixture, monkeypatch, answer):
    """Existing explicit-denial behavior remains local and never queues an action."""
    fixture = confirmation_fixture
    monkeypatch.setattr(fixture.cli.console, "input", lambda _prompt: answer)

    assert backend_ops.perform_backend_conversation(fixture.cli, "Synthetic sensitive request") is None

    assert fixture.requests == [("post", "/gpt/arcanos-daemon")]
    assert fixture.queued == []
