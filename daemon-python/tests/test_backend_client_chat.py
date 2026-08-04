from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

import arcanos.backend_client as backend_client_module
from arcanos.backend_client.chat import (
    resolve_backend_chat_route,
    request_ask_with_domain,
    request_chat_completion,
    request_gpt_job_result,
    request_gpt_job_status,
    request_job_result,
    request_job_status,
    request_query,
    request_query_and_wait,
    request_system_state,
)
from arcanos.backend_client import BackendApiClient
from arcanos.backend_client_models import BackendResponse


JOB_READ_TOKEN = f"v1.{'A' * 43}"
JOB_READ_TOKEN_HEADER = "x-arcanos-job-read-token"


def test_request_chat_completion_uses_daemon_gpt_route_without_body_gpt_id() -> None:
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
    assert path == "/gpt/arcanos-daemon"
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


def test_resolve_backend_chat_route_falls_back_to_daemon_gpt_without_explicit_id() -> None:
    route = resolve_backend_chat_route("   ")

    assert route.endpoint == "/gpt/arcanos-daemon"
    assert route.gpt_id == "arcanos-daemon"


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


def test_request_system_state_uses_direct_system_state_route_with_update_fields() -> None:
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
    assert path == "/system-state"
    assert "gptId" not in payload
    assert "mode" not in payload
    assert payload["metadata"] == {"instanceId": "cli-123"}
    assert payload["sessionId"] == "cli-123"
    assert payload["expectedVersion"] == 4
    assert payload["patch"] == {"status": "ready"}


def test_request_system_state_ignores_explicit_gpt_id_on_direct_route() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value=None)
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"state": {"ok": True}})
    )

    response = request_system_state(client, gpt_id="arcanos-gaming")

    assert response.ok is True
    _, path, payload = client._request_json.call_args.args
    assert path == "/system-state"
    assert "gptId" not in payload
    assert "mode" not in payload


def test_request_query_uses_canonical_gpt_bridge_action_and_normalizes_response() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value={"instanceId": "cli-123", "repoIndex": "repo-7"})
    client._request_json = MagicMock(
        return_value=BackendResponse(
            ok=True,
            value={
                "ok": True,
                "jobId": "job-query-1",
                "status": "pending",
                "jobReadToken": JOB_READ_TOKEN,
                "jobReadTokenHeader": JOB_READ_TOKEN_HEADER,
            },
        )
    )

    response = request_query(
        client,
        prompt="Draft the next promo",
        metadata={"instanceId": "cli-123", "repoIndex": "repo-7"},
    )

    assert response.ok is True
    assert response.value is not None
    _, path, payload = client._request_json.call_args.args
    assert path == "/gpt/arcanos-daemon"
    assert payload["action"] == "query"
    assert payload["prompt"] == "Draft the next promo"
    assert payload["metadata"] == {"instanceId": "cli-123", "repoIndex": "repo-7"}
    assert payload["sessionId"] == "cli-123"
    assert payload["context"] == {"repoIndex": "repo-7"}
    assert response.value.action == "query"
    assert response.value.job_id == "job-query-1"
    assert response.value.status == "pending"
    assert response.value.job_read_token == JOB_READ_TOKEN
    assert response.value.job_read_token_header == JOB_READ_TOKEN_HEADER


def test_request_query_and_wait_uses_bridge_wait_controls_and_normalizes_response() -> None:
    client = SimpleNamespace()
    client._normalize_metadata = MagicMock(return_value=None)
    client._request_json = MagicMock(
        return_value=BackendResponse(
            ok=True,
            value={
                "ok": True,
                "action": "query_and_wait",
                "jobId": "job-query-and-wait-1",
                "status": "completed",
                "result": {"text": "Generated Seth Rollins prompt"},
            },
        )
    )

    response = request_query_and_wait(
        client,
        prompt="Generate a Seth Rollins promo prompt",
        timeout_ms=25000,
        poll_interval_ms=500,
        gpt_id="arcanos-core",
    )

    assert response.ok is True
    assert response.value is not None
    _, path, payload = client._request_json.call_args.args
    assert path == "/gpt/arcanos-core"
    assert payload == {
        "action": "query_and_wait",
        "prompt": "Generate a Seth Rollins promo prompt",
        "timeoutMs": 25000,
        "pollIntervalMs": 500,
    }
    assert response.value.action == "query_and_wait"
    assert response.value.job_id == "job-query-and-wait-1"
    assert response.value.status == "completed"
    assert response.value.result == {"text": "Generated Seth Rollins prompt"}


def test_request_gpt_job_status_uses_canonical_jobs_route() -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock(
        return_value=BackendResponse(
            ok=True,
            value={
                "ok": True,
                "action": "get_status",
                "jobId": "job-123",
                "status": "running",
                "lifecycleStatus": "running",
                "result": {"id": "job-123", "status": "running", "lifecycle_status": "running"},
            },
        )
    )

    response = request_gpt_job_status(
        client,
        "job-123",
        gpt_id="backstage-booker",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    assert response.value is not None
    _, path, payload = client._request_json.call_args.args
    assert path == "/jobs/job-123"
    assert payload is None
    assert client._request_json.call_args.kwargs == {
        "job_read_token": JOB_READ_TOKEN,
    }
    assert response.value.action == "get_status"
    assert response.value.job_id == "job-123"
    assert response.value.status == "running"
    assert response.value.lifecycle_status == "running"
    assert response.value.result == {"id": "job-123", "status": "running", "lifecycle_status": "running"}


def test_request_gpt_job_result_uses_canonical_jobs_route() -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock(
        return_value=BackendResponse(
            ok=True,
            value={
                "ok": True,
                "action": "get_result",
                "jobId": "job-123",
                "status": "completed",
                "jobStatus": "completed",
                "lifecycleStatus": "completed",
                "poll": "/jobs/job-123",
                "stream": "/jobs/job-123/stream",
                "output": {"text": "final output"},
                "result": {
                    "jobId": "job-123",
                    "status": "completed",
                    "result": {"text": "final output"},
                },
            },
        )
    )

    response = request_gpt_job_result(
        client,
        "job-123",
        gpt_id="backstage-booker",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    assert response.value is not None
    _, path, payload = client._request_json.call_args.args
    assert path == "/jobs/job-123/result"
    assert payload is None
    assert client._request_json.call_args.kwargs == {
        "job_read_token": JOB_READ_TOKEN,
    }
    assert response.value.action == "get_result"
    assert response.value.job_id == "job-123"
    assert response.value.status == "completed"
    assert response.value.job_status == "completed"
    assert response.value.lifecycle_status == "completed"
    assert response.value.poll == "/jobs/job-123"
    assert response.value.stream == "/jobs/job-123/stream"
    assert response.value.result == {"text": "final output"}
    assert response.value.raw["result"] == {
        "jobId": "job-123",
        "status": "completed",
        "result": {"text": "final output"},
    }


@pytest.mark.parametrize(
    "stored_output",
    [{"status": "user-value", "answer": 42}, "scalar", None],
)
def test_gpt_job_status_preserves_exact_flat_payloads(stored_output: Any) -> None:
    payload = {
        "id": "job-flat-status",
        "status": "completed",
        "lifecycle_status": "completed",
        "result": stored_output,
    }
    client = SimpleNamespace(
        _request_json=MagicMock(return_value=BackendResponse(ok=True, value=payload))
    )

    response = request_gpt_job_status(
        client,
        "job-flat-status",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    assert response.value is not None
    assert response.value.result == payload
    assert response.value.lifecycle_status == "completed"
    assert response.value.raw == payload


@pytest.mark.parametrize(
    "stored_output",
    [
        {
            "jobId": "user-value",
            "status": "user-value",
            "lifecycleStatus": "user-value",
            "poll": "user-value",
            "answer": 42,
        },
        "scalar",
        None,
    ],
)
def test_gpt_job_result_preserves_exact_flat_results(stored_output: Any) -> None:
    payload = {
        "jobId": "job-flat-result",
        "status": "completed",
        "jobStatus": "completed",
        "lifecycleStatus": "completed",
        "poll": "/jobs/job-flat-result",
        "result": stored_output,
    }
    client = SimpleNamespace(
        _request_json=MagicMock(return_value=BackendResponse(ok=True, value=payload))
    )

    response = request_gpt_job_result(
        client,
        "job-flat-result",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    assert response.value is not None
    assert response.value.result == stored_output
    assert response.value.raw == payload


def test_gpt_job_result_unwraps_a_discriminated_compatibility_envelope() -> None:
    payload = {
        "ok": True,
        "action": "get_result",
        "result": {
            "jobId": "job-compatibility-result",
            "status": "completed",
            "lifecycleStatus": "completed",
            "result": {"nested": "output"},
        },
    }
    client = SimpleNamespace(
        _request_json=MagicMock(return_value=BackendResponse(ok=True, value=payload))
    )

    response = request_gpt_job_result(
        client,
        "job-compatibility-result",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    assert response.value is not None
    assert response.value.result == {"nested": "output"}
    assert response.value.raw == payload


def test_request_job_result_uses_canonical_jobs_result_route() -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"ok": True, "result": {"status": "complete"}})
    )

    response = request_job_result(
        client,
        "job-123",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    _, path, payload = client._request_json.call_args.args
    assert path == "/jobs/job-123/result"
    assert payload is None
    assert client._request_json.call_args.kwargs == {
        "job_read_token": JOB_READ_TOKEN,
    }


def test_request_job_result_rejects_blank_job_ids() -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock()

    response = request_job_result(client, "   ")

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "validation"
    client._request_json.assert_not_called()


def test_request_job_status_uses_canonical_jobs_status_route() -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock(
        return_value=BackendResponse(ok=True, value={"id": "job-123", "status": "running"})
    )

    response = request_job_status(
        client,
        "job-123",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    _, path, payload = client._request_json.call_args.args
    assert path == "/jobs/job-123"
    assert payload is None
    assert client._request_json.call_args.kwargs == {
        "job_read_token": JOB_READ_TOKEN,
    }


def test_request_job_status_rejects_missing_or_malformed_capabilities(
    monkeypatch,
) -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock()
    monkeypatch.setattr(
        "arcanos.backend_client.chat.Config.ARCANOS_JOB_READ_TOKEN",
        None,
    )

    missing_response = request_job_status(client, "job-123")
    malformed_response = request_job_status(
        client,
        "job-123",
        job_read_token="v1.invalid",
    )

    assert missing_response.ok is False
    assert missing_response.error is not None
    assert missing_response.error.kind == "validation"
    assert "ARCANOS_JOB_READ_TOKEN" in missing_response.error.message
    assert malformed_response.ok is False
    assert malformed_response.error is not None
    assert malformed_response.error.kind == "validation"
    assert "valid v1 job-read capability" in malformed_response.error.message
    client._request_json.assert_not_called()


def test_request_job_status_uses_configured_capability_fallback(monkeypatch) -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock(
        return_value=BackendResponse(
            ok=True,
            value={"id": "job-123", "status": "running"},
        )
    )
    monkeypatch.setattr(
        "arcanos.backend_client.chat.Config.ARCANOS_JOB_READ_TOKEN",
        JOB_READ_TOKEN,
    )

    response = request_job_status(client, "job-123")

    assert response.ok is True
    assert client._request_json.call_args.kwargs == {
        "job_read_token": JOB_READ_TOKEN,
    }


def test_backend_api_client_sends_job_read_capability_in_fixed_header() -> None:
    captured_request: dict[str, Any] = {}

    def _request_sender(method: str, url: str, **kwargs: Any) -> Any:
        captured_request["method"] = method
        captured_request["url"] = url
        captured_request["headers"] = dict(kwargs.get("headers", {}))
        captured_request["allow_redirects"] = kwargs.get("allow_redirects")
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"id": "job-123", "status": "running"},
            text='{"id": "job-123", "status": "running"}',
            headers={},
        )

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: "backend-token",
        request_sender=_request_sender,
    )

    response = client.request_job_status(
        "job-123",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is True
    assert captured_request["method"] == "get"
    assert captured_request["url"] == "https://backend.example.com/jobs/job-123"
    assert captured_request["headers"]["Authorization"] == "Bearer backend-token"
    assert captured_request["headers"][JOB_READ_TOKEN_HEADER] == JOB_READ_TOKEN
    assert captured_request["allow_redirects"] is False


def test_backend_api_client_does_not_forward_job_read_capability_through_redirects() -> None:
    requested_urls: list[str] = []
    redirect_target_headers: list[dict[str, str]] = []
    redirect_target = "https://redirect.example.com/jobs/job-123"

    def _request_sender(method: str, url: str, **kwargs: Any) -> Any:
        requested_urls.append(url)
        headers = dict(kwargs.get("headers", {}))
        if url == redirect_target:
            redirect_target_headers.append(headers)
            return SimpleNamespace(
                status_code=200,
                json=lambda: {"id": "job-123", "status": "running"},
                text='{"id": "job-123", "status": "running"}',
                headers={},
            )

        if kwargs.get("allow_redirects", True):
            return _request_sender(
                method,
                redirect_target,
                headers=headers,
                json=kwargs.get("json"),
                timeout=kwargs.get("timeout"),
            )

        return SimpleNamespace(
            status_code=302,
            json=lambda: {},
            text="redirect refused",
            headers={"Location": redirect_target},
        )

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: "backend-token",
        request_sender=_request_sender,
    )

    response = client.request_job_status(
        "job-123",
        job_read_token=JOB_READ_TOKEN,
    )

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "http"
    assert response.error.status_code == 302
    assert response.error.message == "Backend job-read request returned redirect"
    assert requested_urls == ["https://backend.example.com/jobs/job-123"]
    assert redirect_target_headers == []


def test_request_job_status_rejects_blank_job_ids() -> None:
    client = SimpleNamespace()
    client._request_json = MagicMock()

    response = request_job_status(client, "   ")

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "validation"
    client._request_json.assert_not_called()


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


def test_backend_api_client_request_json_prefers_route_gpt_id_for_header_and_logs(monkeypatch) -> None:
    logged_events: list[dict[str, Any]] = []

    def _request_sender(
        method: str,
        url: str,
        headers: dict[str, str],
        json: dict[str, Any],
        timeout: int,
        allow_redirects: bool,
    ):
        assert method == "post"
        assert url == "https://backend.example.com/gpt/arcanos-gaming"
        assert headers["Authorization"] == "Bearer token"
        assert headers["x-gpt-id"] == "arcanos-gaming"
        assert json == {"prompt": "Ping gaming"}
        assert timeout == 15
        assert allow_redirects is False
        return SimpleNamespace(
            status_code=200,
            json=lambda: {
                "ok": True,
                "result": {"gaming_response": "ready"},
                "_route": {"module": "ARCANOS:GAMING"},
            },
            text='{"ok": true}',
            headers={},
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


def test_backend_api_client_request_json_uses_canonical_gpt_route_for_gpt_payloads(monkeypatch) -> None:
    captured_request: dict[str, Any] = {}

    def _request_sender(method: str, url: str, **kwargs: Any) -> Any:
        captured_request["method"] = method
        captured_request["url"] = url
        captured_request["kwargs"] = kwargs
        return SimpleNamespace(
            status_code=200,
            json=lambda: {
                "ok": True,
                "result": {"gaming_response": "Routed correctly"},
                "_route": {"module": "ARCANOS:GAMING"},
            },
            text='{"ok": true}',
            headers={},
        )

    captured_logs: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    monkeypatch.setattr(
        backend_client_module,
        "log_audit_event",
        lambda *args, **kwargs: captured_logs.append((args, kwargs)),
    )

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: "token",
        request_sender=_request_sender,
    )

    response = client._request_json(
        "post",
        "/gpt/arcanos-gaming",
        {"gptId": "arcanos-gaming", "prompt": "Ping the gaming backend"},
    )

    assert response.ok is True
    assert captured_request["url"] == "https://backend.example.com/gpt/arcanos-gaming"
    assert captured_request["kwargs"]["headers"]["Authorization"] == "Bearer token"
    assert captured_request["kwargs"]["json"] == {"prompt": "Ping the gaming backend"}
    assert any(
        args and args[0] == "backend_request_outbound"
        and kwargs.get("resolved_path") == "/gpt/arcanos-gaming"
        and kwargs.get("url") == "https://backend.example.com/gpt/arcanos-gaming"
        and kwargs.get("authenticated") is True
        and kwargs.get("has_authorization") is True
        for args, kwargs in captured_logs
    )
    assert any(
        args and args[0] == "backend_request_response"
        and kwargs.get("resolved_path") == "/gpt/arcanos-gaming"
        and kwargs.get("status_code") == 200
        and kwargs.get("error_kind") is None
        for args, kwargs in captured_logs
    )
    assert any(
        args and args[0] == "backend_route_request"
        and kwargs.get("resolved_endpoint") == "/gpt/arcanos-gaming"
        and kwargs.get("full_request_url") == "https://backend.example.com/gpt/arcanos-gaming"
        and kwargs.get("gpt_id") == "arcanos-gaming"
        for args, kwargs in captured_logs
    )
    assert any(
        args and args[0] == "backend_route_response"
        and kwargs.get("resolved_endpoint") == "/gpt/arcanos-gaming"
        and kwargs.get("response_module") == "ARCANOS:GAMING"
        and kwargs.get("gpt_id") == "arcanos-gaming"
        for args, kwargs in captured_logs
    )


def test_backend_api_client_request_json_uses_canonical_daemon_route(monkeypatch) -> None:
    captured_request: dict[str, Any] = {}

    def _request_sender(method: str, url: str, **kwargs: Any) -> Any:
        captured_request["method"] = method
        captured_request["url"] = url
        captured_request["kwargs"] = kwargs
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"response": "ok"},
            text='{"response": "ok"}',
            headers={},
        )

    monkeypatch.setattr(backend_client_module, "log_audit_event", lambda *args, **kwargs: None)

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: "token",
        request_sender=_request_sender,
    )

    response = client._request_json(
        "post",
        "/gpt/arcanos-daemon",
        {"prompt": "Explain the routing flow"},
    )

    assert response.ok is True
    assert captured_request["url"] == "https://backend.example.com/gpt/arcanos-daemon"
    assert captured_request["kwargs"]["headers"]["Authorization"] == "Bearer token"
    assert captured_request["kwargs"]["json"] == {"prompt": "Explain the routing flow"}


def test_backend_api_client_end_user_login_flow_preserves_auth_on_gpt_request(monkeypatch) -> None:
    captured_requests: list[dict[str, Any]] = []
    captured_logs: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    auth_state = {"token": None}

    def _request_sender(method: str, url: str, **kwargs: Any) -> Any:
        captured_requests.append(
            {
                "method": method,
                "url": url,
                "headers": dict(kwargs.get("headers", {})),
                "json": kwargs.get("json"),
            }
        )
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"ok": True, "result": {"gaming_response": "Authenticated route ok"}},
            text='{"ok": true}',
            headers={},
        )

    monkeypatch.setattr(
        backend_client_module,
        "log_audit_event",
        lambda *args, **kwargs: captured_logs.append((args, kwargs)),
    )

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: auth_state["token"],
        request_sender=_request_sender,
    )

    anonymous_response = client._request_json(
        "post",
        "/gpt/arcanos-gaming",
        {"prompt": "Ping before login"},
    )
    assert anonymous_response.ok is False
    assert anonymous_response.error is not None
    assert anonymous_response.error.kind == "auth"
    assert captured_requests == []

    auth_state["token"] = "tok"

    authenticated_response = client._request_json(
        "post",
        "/gpt/arcanos-gaming",
        {"prompt": "Ping after login"},
    )

    assert authenticated_response.ok is True
    assert captured_requests == [
        {
            "method": "post",
            "url": "https://backend.example.com/gpt/arcanos-gaming",
            "headers": {
                "Authorization": "Bearer tok",
                "Content-Type": "application/json",
            },
            "json": {"prompt": "Ping after login"},
        }
    ]
    assert any(
        args and args[0] == "backend_request_outbound"
        and kwargs.get("resolved_path") == "/gpt/arcanos-gaming"
        and kwargs.get("authenticated") is True
        and kwargs.get("auth_mode") == "bearer"
        for args, kwargs in captured_logs
    )


def test_backend_api_client_request_json_supports_gpt_id_auth_without_bearer_token(monkeypatch) -> None:
    captured_request: dict[str, Any] = {}
    captured_logs: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def _request_sender(method: str, url: str, **kwargs: Any) -> Any:
        captured_request["method"] = method
        captured_request["url"] = url
        captured_request["kwargs"] = kwargs
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"ok": True, "result": {"gaming_response": "gpt-id auth ok"}},
            text='{"ok": true}',
            headers={},
        )

    monkeypatch.setattr(
        backend_client_module,
        "log_audit_event",
        lambda *args, **kwargs: captured_logs.append((args, kwargs)),
    )
    monkeypatch.setattr(backend_client_module.Config, "BACKEND_ALLOW_GPT_ID_AUTH", True)
    monkeypatch.setattr(backend_client_module.Config, "BACKEND_GPT_ID", "arcanos-daemon")

    client = BackendApiClient(
        "https://backend.example.com",
        lambda: None,
        request_sender=_request_sender,
    )

    response = client._request_json(
        "post",
        "/gpt/arcanos-gaming",
        {"prompt": "Ping with GPT auth"},
    )

    assert response.ok is True
    assert captured_request["url"] == "https://backend.example.com/gpt/arcanos-gaming"
    assert captured_request["kwargs"]["headers"] == {
        "Content-Type": "application/json",
        "x-gpt-id": "arcanos-gaming",
    }
    assert captured_request["kwargs"]["allow_redirects"] is False
    assert any(
        args and args[0] == "backend_request_outbound"
        and kwargs.get("auth_mode") == "gpt-id"
        and kwargs.get("has_x_gpt_id") is True
        and kwargs.get("effective_gpt_id") == "arcanos-gaming"
        for args, kwargs in captured_logs
    )
