"""Focused tests for the purpose-bound daemon HTTP transport credential."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

import arcanos.backend_client as backend_client_module
from arcanos.backend_client import (
    DAEMON_ACCESS_TOKEN_HEADER_NAME,
    BackendApiClient,
)
from arcanos.backend_client_models import BackendRequestError, BackendResponse
from arcanos.cli import backend_ops, daemon_ops
from arcanos.config import (
    MAX_DAEMON_ACCESS_TOKEN_LENGTH,
    MIN_DAEMON_ACCESS_TOKEN_LENGTH,
    Config,
    get_daemon_access_token,
    is_valid_daemon_access_token,
)


DAEMON_ACCESS_TOKEN = "python-daemon-access-token-1234567890"
GENERIC_BACKEND_TOKEN = "generic-backend-token"


def _response(status_code: int = 200, payload: dict[str, Any] | None = None):
    response_payload = payload or {"ok": True}
    return SimpleNamespace(
        status_code=status_code,
        json=lambda: response_payload,
        text=str(response_payload),
        headers={},
    )


@pytest.mark.parametrize(
    "path",
    [
        "/api/daemon",
        "/api/daemon/heartbeat",
        "/api/daemon/commands?instance_id=daemon-one",
        "/api/daemon/commands/ack",
        "/api/daemon/commands/result",
        "/api/daemon/confirm-actions",
        "/api/daemon/registry",
    ],
)
def test_raw_daemon_paths_send_only_the_dedicated_custom_header(path: str) -> None:
    generic_provider = MagicMock(side_effect=AssertionError("generic token must not be read"))
    sender = MagicMock(return_value=_response())
    client = BackendApiClient(
        "https://backend.example",
        generic_provider,
        request_sender=sender,
        daemon_access_token_provider=lambda: DAEMON_ACCESS_TOKEN,
    )

    response = client.make_raw_request("GET", path)

    assert response.status_code == 200
    request_headers = sender.call_args.kwargs["headers"]
    assert request_headers == {
        "Content-Type": "application/json",
        DAEMON_ACCESS_TOKEN_HEADER_NAME: DAEMON_ACCESS_TOKEN,
    }
    assert "Authorization" not in request_headers
    assert "x-gpt-id" not in request_headers
    assert sender.call_args.kwargs["allow_redirects"] is False
    generic_provider.assert_not_called()


def test_json_daemon_request_uses_the_same_dedicated_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged_events: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    sender = MagicMock(return_value=_response(payload={"commands": []}))
    monkeypatch.setattr(
        backend_client_module,
        "log_audit_event",
        lambda *args, **kwargs: logged_events.append((args, kwargs)),
    )
    client = BackendApiClient(
        "https://backend.example",
        lambda: GENERIC_BACKEND_TOKEN,
        request_sender=sender,
        daemon_access_token_provider=lambda: DAEMON_ACCESS_TOKEN,
    )

    response = client._request_json(
        "get",
        "/api/daemon/commands?instance_id=daemon-one",
        None,
    )

    assert response.ok is True
    headers = sender.call_args.kwargs["headers"]
    assert headers == {
        "Content-Type": "application/json",
        DAEMON_ACCESS_TOKEN_HEADER_NAME: DAEMON_ACCESS_TOKEN,
    }
    assert sender.call_args.kwargs["allow_redirects"] is False
    assert any(
        args
        and args[0] == "backend_request_outbound"
        and kwargs.get("auth_mode") == "daemon-token"
        and kwargs.get("authenticated") is True
        and kwargs.get("has_daemon_access_token") is True
        and kwargs.get("has_authorization") is False
        and kwargs.get("has_x_gpt_id") is False
        for args, kwargs in logged_events
    )
    assert DAEMON_ACCESS_TOKEN not in repr(logged_events)


@pytest.mark.parametrize(
    "path",
    [
        "/api/daemon-tools",
        "/api/daemonized",
        "/api/update",
        "/gpt/arcanos-daemon",
        "/api/DAEMON/heartbeat",
    ],
)
def test_non_daemon_lookalikes_keep_generic_auth_and_never_receive_daemon_header(
    path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    daemon_provider = MagicMock(
        side_effect=AssertionError("daemon token must not be read for non-daemon paths")
    )
    sender = MagicMock(return_value=_response())
    monkeypatch.setattr(Config, "BACKEND_ALLOW_GPT_ID_AUTH", False)
    client = BackendApiClient(
        "https://backend.example",
        lambda: GENERIC_BACKEND_TOKEN,
        request_sender=sender,
        daemon_access_token_provider=daemon_provider,
    )

    client.make_raw_request("POST", path, json={"ok": True})

    headers = sender.call_args.kwargs["headers"]
    assert headers["Authorization"] == f"Bearer {GENERIC_BACKEND_TOKEN}"
    assert DAEMON_ACCESS_TOKEN_HEADER_NAME not in headers
    assert sender.call_args.kwargs["allow_redirects"] is False
    daemon_provider.assert_not_called()


@pytest.mark.parametrize("raw", [False, True])
def test_daemon_credentials_are_not_forwarded_to_cross_origin_redirects(raw: bool) -> None:
    requested_urls: list[str] = []
    redirect_target_headers: list[dict[str, str]] = []
    redirect_target = "https://redirect.example/api/daemon/registry"

    def sender(method: str, url: str, **kwargs: Any):
        requested_urls.append(url)
        headers = dict(kwargs.get("headers", {}))
        if url == redirect_target:
            redirect_target_headers.append(headers)
            return _response()
        if kwargs.get("allow_redirects", True):
            return sender(method, redirect_target, headers=headers)
        return SimpleNamespace(
            status_code=302,
            json=lambda: {},
            text="redirect refused",
            headers={"Location": redirect_target},
        )

    client = BackendApiClient(
        "https://backend.example",
        lambda: GENERIC_BACKEND_TOKEN,
        request_sender=sender,
        daemon_access_token_provider=lambda: DAEMON_ACCESS_TOKEN,
    )

    if raw:
        response = client.make_raw_request("GET", "/api/daemon/registry")
        assert response.status_code == 302
    else:
        response = client._request_json("get", "/api/daemon/registry", None)
        assert response.ok is False
        assert response.error is not None
        assert response.error.kind == "http"
        assert response.error.message == "Authenticated backend request returned redirect"

    assert requested_urls == ["https://backend.example/api/daemon/registry"]
    assert redirect_target_headers == []


@pytest.mark.parametrize(
    "token",
    [
        None,
        "",
        "short",
        "x" * (MIN_DAEMON_ACCESS_TOKEN_LENGTH - 1),
        "x" * (MAX_DAEMON_ACCESS_TOKEN_LENGTH + 1),
        f" {DAEMON_ACCESS_TOKEN}",
        f"{DAEMON_ACCESS_TOKEN} ",
        f"{DAEMON_ACCESS_TOKEN} extra",
        "change-me-daemon-access-token-1234567890",
        "<daemon-access-token>",
    ],
)
def test_invalid_daemon_configuration_prevents_all_network_access(
    token: str | None,
) -> None:
    sender = MagicMock()
    client = BackendApiClient(
        "https://backend.example",
        lambda: GENERIC_BACKEND_TOKEN,
        request_sender=sender,
        daemon_access_token_provider=lambda: token,
    )

    with pytest.raises(BackendRequestError) as error:
        client.make_raw_request("GET", "/api/daemon/registry")

    assert error.value.kind == "daemon_auth"
    assert DAEMON_ACCESS_TOKEN not in str(error.value)
    sender.assert_not_called()

    json_response = client._request_json("get", "/api/daemon/registry", None)
    assert json_response.ok is False
    assert json_response.error is not None
    assert json_response.error.kind == "daemon_auth"
    sender.assert_not_called()


def test_daemon_401_is_classified_separately_from_generic_backend_auth() -> None:
    sender = MagicMock(return_value=_response(status_code=401, payload={"error": "denied"}))
    client = BackendApiClient(
        "https://backend.example",
        lambda: GENERIC_BACKEND_TOKEN,
        request_sender=sender,
        daemon_access_token_provider=lambda: DAEMON_ACCESS_TOKEN,
    )

    response = client._request_json("get", "/api/daemon/registry", None)

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "daemon_auth"
    assert response.error.status_code == 401


def test_daemon_auth_error_never_bootstraps_the_unrelated_backend_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bootstrap = MagicMock()
    monkeypatch.setattr(backend_ops, "bootstrap_credentials", bootstrap)
    request_func = MagicMock(
        return_value=BackendResponse(
            ok=False,
            error=BackendRequestError(
                kind="daemon_auth",
                message="Daemon authorization failed",
                status_code=401,
            ),
        )
    )
    cli = SimpleNamespace(console=SimpleNamespace(print=MagicMock()))

    response = backend_ops.request_with_auth_retry(
        cli,
        request_func,
        "daemon registry",
    )

    assert response.ok is False
    request_func.assert_called_once_with()
    bootstrap.assert_not_called()


def test_daemon_config_has_no_generic_backend_credential_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ARCANOS_DAEMON_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("BACKEND_TOKEN", DAEMON_ACCESS_TOKEN)
    monkeypatch.setenv("ARCANOS_API_KEY", DAEMON_ACCESS_TOKEN)
    monkeypatch.setenv("ADMIN_KEY", DAEMON_ACCESS_TOKEN)

    assert get_daemon_access_token() is None


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("x" * MIN_DAEMON_ACCESS_TOKEN_LENGTH, True),
        ("x" * MAX_DAEMON_ACCESS_TOKEN_LENGTH, True),
        ("x" * (MIN_DAEMON_ACCESS_TOKEN_LENGTH - 1), False),
        ("x" * (MAX_DAEMON_ACCESS_TOKEN_LENGTH + 1), False),
        (f"{DAEMON_ACCESS_TOKEN}\n", False),
        ("placeholder-daemon-access-token-1234567890", False),
    ],
)
def test_daemon_config_validation_matches_the_server_shape(
    token: str,
    expected: bool,
) -> None:
    assert is_valid_daemon_access_token(token) is expected


def _daemon_cli() -> SimpleNamespace:
    return SimpleNamespace(
        _daemon_running=False,
        backend_client=object(),
        _heartbeat_loop=MagicMock(),
        _command_poll_loop=MagicMock(),
        _heartbeat_thread=None,
        _command_poll_thread=None,
        _action_plan_execution_thread=None,
        _local_agent_execution_thread=None,
    )


def test_generic_daemon_threads_require_the_dedicated_token_not_backend_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cli = _daemon_cli()
    thread_factory = MagicMock()
    monkeypatch.setattr(daemon_ops.threading, "Thread", thread_factory)
    monkeypatch.setattr(daemon_ops.Config, "BACKEND_TOKEN", GENERIC_BACKEND_TOKEN)
    monkeypatch.setattr(daemon_ops.Config, "DAEMON_ACCESS_TOKEN", None)
    monkeypatch.setattr(
        daemon_ops.Config,
        "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
        False,
    )
    monkeypatch.setattr(daemon_ops.Config, "LOCAL_AGENT_ENABLED", False)

    daemon_ops.start_daemon_threads(cli)

    assert cli._daemon_running is False
    thread_factory.assert_not_called()


def test_dedicated_token_starts_generic_daemon_threads_without_backend_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cli = _daemon_cli()
    heartbeat_thread = MagicMock()
    command_thread = MagicMock()
    thread_factory = MagicMock(side_effect=[heartbeat_thread, command_thread])
    monkeypatch.setattr(daemon_ops.threading, "Thread", thread_factory)
    monkeypatch.setattr(daemon_ops.Config, "BACKEND_TOKEN", None)
    monkeypatch.setattr(
        daemon_ops.Config,
        "DAEMON_ACCESS_TOKEN",
        DAEMON_ACCESS_TOKEN,
    )
    monkeypatch.setattr(
        daemon_ops.Config,
        "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
        False,
    )
    monkeypatch.setattr(daemon_ops.Config, "LOCAL_AGENT_ENABLED", False)

    daemon_ops.start_daemon_threads(cli)

    assert cli._daemon_running is True
    assert [call.kwargs["name"] for call in thread_factory.call_args_list] == [
        "daemon-heartbeat",
        "daemon-command-poll",
    ]
    heartbeat_thread.start.assert_called_once_with()
    command_thread.start.assert_called_once_with()


def test_heartbeat_stops_after_daemon_auth_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cli = SimpleNamespace(
        _daemon_running=True,
        backend_client=object(),
        start_time=0.0,
        _heartbeat_interval=30,
    )
    request_heartbeat = MagicMock(
        return_value=SimpleNamespace(status_code=401, headers={})
    )
    sleep = MagicMock()
    monkeypatch.setattr(daemon_ops.backend_ops, "request_daemon_heartbeat", request_heartbeat)
    monkeypatch.setattr(daemon_ops.time, "sleep", sleep)
    monkeypatch.setattr(daemon_ops.time, "time", lambda: 100.0)

    daemon_ops.heartbeat_loop(cli)

    request_heartbeat.assert_called_once_with(cli, uptime=100.0)
    sleep.assert_called_once_with(daemon_ops._INITIAL_HEARTBEAT_DELAY_S)
