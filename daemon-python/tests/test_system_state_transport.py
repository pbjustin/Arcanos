"""Isolated acceptance for the daemon's direct system-state control path."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from urllib.parse import parse_qs, urlsplit

import pytest
import requests

import arcanos.backend_client as backend_client_module
import arcanos.config as config_module
from arcanos.backend_client import BackendApiClient
from arcanos.cli import backend_ops
from arcanos.config import Config
from arcanos.credential_verification import PURPOSE_BOUND_CREDENTIAL_ENV_NAMES


CONTROL_TOKEN = "control-plane-fixture-only-1234567890"
GPT_TOKEN = "gpt-fixture-only-1234567890123456789"
CHALLENGE_ID = "082ce8db-8ebe-45ec-b31e-3a7c5e828f5f"


def _response(status=200, payload=None):
    body = payload if payload is not None else {"ok": True, "state": {"version": 1}}
    return SimpleNamespace(
        status_code=status, json=lambda: body, text=json.dumps(body), headers={}
    )


@pytest.fixture(autouse=True)
def isolate_control_credentials(monkeypatch):
    for name in PURPOSE_BOUND_CREDENTIAL_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(Config, "CONTROL_PLANE_ACCESS_TOKEN", CONTROL_TOKEN, raising=False)
    monkeypatch.setattr(Config, "BACKEND_ALLOW_GPT_ID_AUTH", True)
    monkeypatch.setattr(Config, "BACKEND_GPT_ID", "arcanos-daemon")
    monkeypatch.setattr(backend_client_module, "log_audit_event", MagicMock())


def test_read_uses_get_only_dedicated_bearer_and_preserves_session(monkeypatch):
    generic = MagicMock(side_effect=AssertionError("GPT token must not be read"))
    daemon = MagicMock(side_effect=AssertionError("daemon token must not be read"))
    sender = MagicMock(return_value=_response())
    client = BackendApiClient(
        "https://backend.example", generic, request_sender=sender,
        daemon_access_token_provider=daemon,
    )

    response = client.request_system_state(
        metadata={"instanceId": "session private/&+?", "repoIndex": "ignored-on-read"},
        gpt_id="arcanos-gaming",
    )

    assert response.ok
    method, url = sender.call_args.args
    assert method == "get"
    assert urlsplit(url).path == "/system-state"
    assert parse_qs(urlsplit(url).query) == {"sessionId": ["session private/&+?"]}
    assert sender.call_args.kwargs["json"] is None
    assert sender.call_args.kwargs["headers"] == {
        "Content-Type": "application/json", "Authorization": f"Bearer {CONTROL_TOKEN}"
    }
    assert sender.call_args.kwargs["allow_redirects"] is False
    generic.assert_not_called()
    daemon.assert_not_called()
    events = repr(backend_client_module.log_audit_event.call_args_list)
    assert CONTROL_TOKEN not in events
    assert "session private" not in events
    assert "sessionId" not in events


@pytest.mark.parametrize("token", [None, "", "short", " invalid-" + "x" * 32, "x" * 32 + "\n", "é" * 32])
def test_missing_or_invalid_control_token_never_substitutes_generic_credentials(monkeypatch, token):
    monkeypatch.setattr(Config, "CONTROL_PLANE_ACCESS_TOKEN", token)
    generic = MagicMock(return_value=GPT_TOKEN)
    sender = MagicMock(return_value=_response())
    client = BackendApiClient("https://backend.example", generic, request_sender=sender)

    response = client.request_system_state()

    assert not response.ok
    assert response.error.kind == "control_plane_auth"
    assert "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN" in response.error.message
    sender.assert_not_called()
    generic.assert_not_called()


@pytest.mark.parametrize(
    "status,code,kind",
    [(503, "CONTROL_PLANE_AUTH_UNAVAILABLE", "configuration"),
     (401, "CONTROL_PLANE_AUTH_REQUIRED", "control_plane_auth"),
     (403, "CONTROL_PLANE_SCOPE_DENIED", "control_plane_auth"),
     (403, "CONTROL_PLANE_FORBIDDEN", "control_plane_auth"),
     (400, "BAD_REQUEST", "http"),
     (409, "SYSTEM_STATE_CONFLICT", "http"),
     (500, "INTERNAL_ERROR", "http")],
)
def test_authorization_and_backend_failures_are_distinct_and_do_not_echo_secrets(status, code, kind):
    sender = MagicMock(return_value=_response(status, {
        "error": {"code": code, "message": CONTROL_TOKEN},
        "debug": {"authorization": CONTROL_TOKEN},
        "model": CONTROL_TOKEN,
    }))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state()

    assert not response.ok
    assert response.error.kind == kind
    assert response.error.status_code == status
    if code != "INTERNAL_ERROR":
        assert code in response.error.details
    assert CONTROL_TOKEN not in repr(response.error)
    assert CONTROL_TOKEN not in repr(backend_client_module.log_audit_event.call_args_list)
    assert sender.call_count == 1


def test_mutation_keeps_post_and_returns_server_challenge_without_auto_confirmation():
    sender = MagicMock(return_value=_response(403, {
        "code": "CONFIRMATION_REQUIRED", "confirmationChallenge": {"id": CHALLENGE_ID},
        "message": CONTROL_TOKEN,
    }))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state(
        metadata={"instanceId": "same-session"}, expected_version=4, patch={"status": "ready"}
    )

    assert not response.ok
    assert response.error.kind == "confirmation"
    assert response.error.confirmation_challenge_id == CHALLENGE_ID
    assert response.error.pending_actions == []
    assert CONTROL_TOKEN not in repr(response.error)
    assert sender.call_args.args == ("post", "https://backend.example/system-state")
    assert sender.call_args.kwargs["json"] == {
        "metadata": {"instanceId": "same-session"}, "sessionId": "same-session",
        "expectedVersion": 4, "patch": {"status": "ready"},
    }
    assert "x-confirmed" not in sender.call_args.kwargs["headers"]
    assert sender.call_count == 1


def test_partial_mutation_fails_before_transport():
    sender = MagicMock()
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state(expected_version=4)

    assert not response.ok
    assert response.error.kind == "validation"
    sender.assert_not_called()


@pytest.mark.parametrize("challenge", [CONTROL_TOKEN, None, "", "not-a-uuid"])
def test_malformed_confirmation_challenge_cannot_echo_a_credential(challenge):
    sender = MagicMock(return_value=_response(403, {
        "code": "CONFIRMATION_REQUIRED", "confirmationChallenge": {"id": challenge},
        "pending_actions": [{"summary": CONTROL_TOKEN}],
    }))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state(expected_version=1, patch={"status": "active"})

    assert not response.ok
    assert response.error.kind == "control_plane_auth"
    assert response.error.confirmation_challenge_id is None
    assert CONTROL_TOKEN not in repr(response.error)


def test_redirects_do_not_forward_control_credentials_or_echo_body():
    sender = MagicMock(return_value=_response(302, {"error": CONTROL_TOKEN}))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state()

    assert not response.ok
    assert response.error.kind == "http"
    assert response.error.status_code == 302
    assert CONTROL_TOKEN not in repr(response.error)
    assert sender.call_count == 1
    assert sender.call_args.kwargs["allow_redirects"] is False


def test_control_rate_limit_preserves_existing_error_kind():
    sender = MagicMock(return_value=_response(429, {"message": CONTROL_TOKEN}))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state()

    assert not response.ok
    assert response.error.kind == "rate_limit"
    assert response.error.status_code == 429
    assert response.error.message == "Rate limit exceeded. Try again later."
    assert response.error.details is None
    assert CONTROL_TOKEN not in repr(response.error)


@pytest.mark.parametrize(
    "retry_after,expected_wait",
    [(1, "1 second"), (60, "60 seconds"), (61, "61 seconds"),
     (300, "300 seconds"), (900, "900 seconds")],
)
def test_control_rate_limit_preserves_bounded_server_retry_guidance(retry_after, expected_wait):
    backend_response = _response(429, {
        "retryAfter": retry_after, "message": CONTROL_TOKEN, "model": CONTROL_TOKEN,
    })
    backend_response.headers["Retry-After"] = CONTROL_TOKEN
    sender = MagicMock(return_value=backend_response)
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state()

    assert not response.ok
    assert response.error.kind == "rate_limit"
    assert response.error.status_code == 429
    assert response.error.message == f"Rate limit exceeded. Try again in {expected_wait}."
    assert response.error.details is None
    assert CONTROL_TOKEN not in repr(response.error)
    assert CONTROL_TOKEN not in repr(backend_client_module.log_audit_event.call_args_list)
    assert sender.call_count == 1


@pytest.mark.parametrize(
    "retry_after",
    [None, True, False, 0, -1, 1.0, 1.5, "60", CONTROL_TOKEN,
     {"seconds": 60}, [60], 901, 2 ** 1000],
)
def test_control_rate_limit_rejects_malformed_or_excessive_retry_guidance(retry_after):
    sender = MagicMock(return_value=_response(429, {
        "retryAfter": retry_after, "message": CONTROL_TOKEN, "model": CONTROL_TOKEN,
    }))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state()

    assert not response.ok
    assert response.error.kind == "rate_limit"
    assert response.error.status_code == 429
    assert response.error.message == "Rate limit exceeded. Try again later."
    assert response.error.details is None
    assert CONTROL_TOKEN not in repr(response.error)
    assert CONTROL_TOKEN not in repr(backend_client_module.log_audit_event.call_args_list)
    assert sender.call_count == 1


@pytest.mark.parametrize("exception", [requests.Timeout, requests.ConnectionError])
def test_transport_errors_withhold_exception_text(exception):
    sender = MagicMock(side_effect=exception(CONTROL_TOKEN))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)

    response = client.request_system_state()

    assert not response.ok
    assert response.error.kind in ("timeout", "network")
    assert CONTROL_TOKEN not in repr(response.error)


def test_control_auth_failure_does_not_trigger_generic_credential_bootstrap(monkeypatch):
    sender = MagicMock(return_value=_response(401, {"error": {"code": "CONTROL_PLANE_AUTH_REQUIRED"}}))
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)
    refresh = MagicMock(return_value=True)
    monkeypatch.setattr(backend_ops, "refresh_backend_credentials", refresh)

    response = backend_ops.request_with_auth_retry(
        SimpleNamespace(), client.request_system_state, "system state", report_errors=False
    )

    assert not response.ok
    assert response.error.kind == "control_plane_auth"
    refresh.assert_not_called()
    assert sender.call_count == 1


def test_control_failure_leaves_gpt_conversation_transport_and_history_intact(monkeypatch):
    monkeypatch.setattr(Config, "BACKEND_ALLOW_GPT_ID_AUTH", False)
    sender = MagicMock(side_effect=[
        _response(503, {"error": {"code": "CONTROL_PLANE_AUTH_UNAVAILABLE"}}),
        _response(200, {"response": "π\n```python\n  print('ok')\n```", "model": "fixture"}),
    ])
    client = BackendApiClient("https://backend.example", lambda: GPT_TOKEN, request_sender=sender)
    messages = [{"role": "user", "content": "remember alpha"},
                {"role": "assistant", "content": "alpha"},
                {"role": "user", "content": "continue"}]

    assert not client.request_system_state().ok
    response = client.request_chat_completion(messages, metadata={"instanceId": "same-session"})

    assert response.ok
    assert response.value.response_text == "π\n```python\n  print('ok')\n```"
    assert sender.call_count == 2
    assert sender.call_args.args == ("post", "https://backend.example/gpt/arcanos-daemon")
    assert sender.call_args.kwargs["headers"]["Authorization"] == f"Bearer {GPT_TOKEN}"
    assert sender.call_args.kwargs["json"]["messages"] == messages
    assert sender.call_args.kwargs["json"]["sessionId"] == "same-session"


@pytest.mark.parametrize("peer", ["ARCANOS_GPT_ACCESS_TOKEN", "ARCANOS_DAEMON_ACCESS_TOKEN", "ARCANOS_AUTOMATION_SECRET"])
def test_control_credential_loader_rejects_reused_purpose_bound_peer(monkeypatch, peer):
    monkeypatch.setenv("ARCANOS_CONTROL_PLANE_ACCESS_TOKEN", CONTROL_TOKEN)
    monkeypatch.setenv(peer, CONTROL_TOKEN)

    assert config_module.get_control_plane_access_token() is None


def test_control_credential_loader_uses_only_its_exact_environment_value(monkeypatch):
    monkeypatch.setenv("ARCANOS_GPT_ACCESS_TOKEN", GPT_TOKEN)
    monkeypatch.setenv("OPENAI_API_KEY", "provider-fixture")
    monkeypatch.setenv("RAILWAY_API_TOKEN", "railway-fixture")
    assert config_module.get_control_plane_access_token() is None
    monkeypatch.setenv("ARCANOS_CONTROL_PLANE_ACCESS_TOKEN", CONTROL_TOKEN)
    assert config_module.get_control_plane_access_token() == CONTROL_TOKEN
