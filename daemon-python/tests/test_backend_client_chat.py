from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

from arcanos.backend_client.chat import (
    request_ask_with_domain,
    request_chat_completion,
    request_system_state,
)
from arcanos.backend_client_models import BackendResponse
from arcanos.config import Config


def test_request_chat_completion_includes_gpt_id_and_chat_fields() -> None:
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
    _, _, payload = client._request_json.call_args.args
    assert payload["gptId"] == Config.BACKEND_GPT_ID
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
    _, _, payload = client._request_json.call_args.args
    assert payload["gptId"] == "arcanos-gaming"
    assert payload["prompt"] == "gaming ping"
    assert payload["domain"] == "gaming"


def test_request_system_state_includes_gpt_id_and_update_fields() -> None:
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
    _, _, payload = client._request_json.call_args.args
    assert payload["gptId"] == Config.BACKEND_GPT_ID
    assert payload["mode"] == "system_state"
    assert payload["metadata"] == {"instanceId": "cli-123"}
    assert payload["sessionId"] == "cli-123"
    assert payload["expectedVersion"] == 4
    assert payload["patch"] == {"status": "ready"}


def test_request_system_state_honors_explicit_gpt_id_override() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value=None)
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"state": {"ok": True}})
    )

    response = request_system_state(client, gpt_id="arcanos-gaming")

    assert response.ok is True
    _, _, payload = client._request_json.call_args.args
    assert payload["gptId"] == "arcanos-gaming"
    assert payload["mode"] == "system_state"
