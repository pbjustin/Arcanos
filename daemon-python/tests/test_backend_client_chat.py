from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from arcanos.backend_client.chat import (
    resolve_backend_chat_route,
    request_ask_with_domain,
    request_chat_completion,
    request_system_state,
)
from arcanos.backend_client import BackendApiClient
from arcanos.backend_client_models import BackendResponse


def test_request_chat_completion_keeps_generic_ask_payload_free_of_gpt_id() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value={"instanceId": "cli-123"})
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"response": "ok"})
    )
    parsed_response = BackendResponse(ok=True, value=SimpleNamespace(response_text="ok"))
    client._parse_chat_response = MagicMock(return_value=parsed_response)

    messages: list[dict[str, str]] = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "ping backend"},
    ]

    response = request_chat_completion(
        client,
        messages=messages,
        temperature=0.3,
        model="gpt-test",
        stream=True,
        metadata={"instanceId": "cli-123"},
    )

    assert response is parsed_response
    client._request_json.assert_called_once()
    _, path, payload = client._request_json.call_args.args
    assert path == "/ask"
    assert "gptId" not in payload
    assert payload["prompt"] == "ping backend"
    assert payload["messages"] == messages
    assert payload["stream"] is True
    assert payload["temperature"] == 0.3
    assert payload["model"] == "gpt-test"
    assert payload["metadata"] == {"instanceId": "cli-123"}
    assert payload["sessionId"] == "cli-123"


def test_resolve_backend_chat_route_uses_gpt_gateway_for_explicit_gpt_id() -> None:
    route = resolve_backend_chat_route(" arcanos-gaming ")

    assert route.endpoint == "/gpt/arcanos-gaming"
    assert route.gpt_id == "arcanos-gaming"


def test_resolve_backend_chat_route_keeps_generic_chat_on_ask_without_gpt_id() -> None:
    route = resolve_backend_chat_route("   ")

    assert route.endpoint == "/ask"
    assert route.gpt_id is None


def test_request_ask_with_domain_honors_explicit_gpt_id_override() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value=None)
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"response": "ok"})
    )
    parsed_response = BackendResponse(ok=True, value=SimpleNamespace(response_text="ok"))
    client._parse_chat_response = MagicMock(return_value=parsed_response)

    response = request_ask_with_domain(
        client,
        message="gaming ping",
        domain="gaming",
        gpt_id="arcanos-gaming",
    )

    assert response is parsed_response
    _, path, payload = client._request_json.call_args.args
    assert path == "/gpt/arcanos-gaming"
    assert "gptId" not in payload
    assert payload["prompt"] == "gaming ping"
    assert payload["domain"] == "gaming"


def test_request_chat_completion_routes_explicit_gpt_ids_to_gpt_endpoint() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value=None)
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"ok": True, "result": {"gaming_response": "ok"}})
    )
    client._parse_chat_response = MagicMock(return_value=BackendResponse(ok=True, value=SimpleNamespace(response_text="ok")))

    request_chat_completion(
        client,
        messages=[{"role": "user", "content": "ping gaming"}],
        gpt_id="arcanos-gaming",
    )

    _, path, payload = client._request_json.call_args.args
    assert path == "/gpt/arcanos-gaming"
    assert "gptId" not in payload
    assert payload["prompt"] == "ping gaming"


def test_backend_api_client_request_json_prefers_route_gpt_id_for_header_and_logs(monkeypatch) -> None:
    logged_events: list[dict[str, Any]] = []

    def _request_sender(method: str, url: str, headers: dict[str, str], json: dict[str, Any], timeout: int):
        assert method == "post"
        assert url == "https://backend.example.com/gpt/arcanos-gaming"
        assert headers["Authorization"] == "Bearer token"
        assert headers["x-gpt-id"] == "arcanos-gaming"
        assert json == {"prompt": "Ping gaming"}
        assert timeout == 15
        return SimpleNamespace(
            status_code=200,
            json=lambda: {
                "ok": True,
                "result": {"gaming_response": "ready"},
                "_route": {"module": "ARCANOS:GAMING"},
            },
        )

    monkeypatch.setattr(
        "arcanos.backend_client.log_audit_event",
        lambda event_type, **kwargs: logged_events.append(
            {"event_type": event_type, **kwargs}
        ),
    )
    monkeypatch.setattr("arcanos.backend_client.Config.BACKEND_ALLOW_GPT_ID_AUTH", True, raising=False)
    monkeypatch.setattr("arcanos.backend_client.Config.BACKEND_GPT_ID", "arcanos-daemon", raising=False)

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: "token",
        request_sender=_request_sender,
    )

    response = client._request_json("post", "/gpt/arcanos-gaming", {"prompt": "Ping gaming"})

    assert response.ok is True
    route_request_log = next(event for event in logged_events if event["event_type"] == "backend_route_request")
    assert route_request_log["full_request_url"] == "https://backend.example.com/gpt/arcanos-gaming"
    assert route_request_log["gpt_id"] == "arcanos-gaming"
    assert route_request_log["resolved_endpoint"] == "/gpt/arcanos-gaming"

    route_response_log = next(event for event in logged_events if event["event_type"] == "backend_route_response")
    assert route_response_log["response_module"] == "ARCANOS:GAMING"
    assert route_response_log["gpt_id"] == "arcanos-gaming"


def test_backend_api_client_request_json_keeps_generic_ask_without_gpt_header(monkeypatch) -> None:
    captured_headers: dict[str, str] = {}

    def _request_sender(method: str, url: str, headers: dict[str, str], json: dict[str, Any], timeout: int):
        del method, url, json, timeout
        captured_headers.update(headers)
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"response": "generic ok", "model": "generic-model"},
        )

    monkeypatch.setattr(
        "arcanos.backend_client.log_audit_event",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "arcanos.backend_client.Config.BACKEND_ALLOW_GPT_ID_AUTH",
        False,
        raising=False,
    )
    monkeypatch.setattr("arcanos.backend_client.Config.BACKEND_GPT_ID", "arcanos-daemon", raising=False)

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: "token",
        request_sender=_request_sender,
    )

    response = client._request_json("post", "/ask", {"prompt": "Ping ask"})

    assert response.ok is True
    assert "x-gpt-id" not in captured_headers


def test_request_system_state_uses_ask_mode_without_gpt_id_and_with_update_fields() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value={"instanceId": "cli-123"})
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"state": {"ok": True}})
    )

    response = request_system_state(
        client,
        metadata={"instanceId": "cli-123"},
        expected_version=4,
        patch={"status": "ready"},
    )

    assert response.ok is True
    assert response.value == {"state": {"ok": True}}
    client._request_json.assert_called_once()
    _, path, payload = client._request_json.call_args.args
    assert path == "/ask"
    assert "gptId" not in payload
    assert payload["mode"] == "system_state"
    assert payload["metadata"] == {"instanceId": "cli-123"}
    assert payload["sessionId"] == "cli-123"
    assert payload["expectedVersion"] == 4
    assert payload["patch"] == {"status": "ready"}


def test_request_system_state_ignores_explicit_gpt_id_for_ask_mode_payload() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value=None)
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"state": {"ok": True}})
    )

    response = request_system_state(client, gpt_id="arcanos-gaming")

    assert response.ok is True
    _, path, payload = client._request_json.call_args.args
    assert path == "/ask"
    assert "gptId" not in payload
    assert payload["mode"] == "system_state"


def test_backend_api_client_parses_gpt_envelope_chat_response() -> None:
    client = BackendApiClient("https://backend.example.com", lambda: "token")

    response = client._parse_chat_response(
        {
            "ok": True,
            "result": {"gaming_response": "Gaming pipeline ready", "hrc": {"verdict": "ok"}},
            "_route": {"module": "ARCANOS:GAMING", "route": "gaming"},
        }
    )

    assert response.ok is True
    assert response.value is not None
    assert response.value.response_text == "Gaming pipeline ready"
    assert response.value.model == "ARCANOS:GAMING"
