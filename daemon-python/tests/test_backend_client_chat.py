from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from arcanos.backend_client.chat import (
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
