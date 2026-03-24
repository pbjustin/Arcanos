"""Tests for backend failure telemetry emitted by CLI backend ops."""

from __future__ import annotations

from types import SimpleNamespace

from arcanos.backend_client_models import (
    BackendChatResult,
    BackendRequestError,
    BackendResponse,
)
from arcanos.cli import backend_ops


def _make_cli_stub() -> SimpleNamespace:
    """Create a lightweight CLI stub for backend_ops unit tests."""

    memory_stub = SimpleNamespace(get_recent_conversations=lambda limit: [])
    console_stub = SimpleNamespace(print=lambda *args, **kwargs: None)
    backend_client_stub = SimpleNamespace(
        request_chat_completion=lambda **kwargs: None,
        request_ask_with_domain=lambda **kwargs: None,
    )
    return SimpleNamespace(
        backend_client=backend_client_stub,
        _last_confirmation_handled=False,
        memory=memory_stub,
        system_prompt="system prompt",
        instance_id="test-instance",
        client_id="test-client",
        console=console_stub,
    )


def test_backend_failure_telemetry_records_retry_failed(monkeypatch) -> None:
    """Telemetry should include payload mode, error code, and retry_failed outcome."""

    primary_failure = BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="http",
            message="Backend request returned error",
            status_code=500,
            details='{"code":"AI_FAILURE","detail":"Missing required parameter: \'tools[0].name\'"}',
        ),
    )
    retry_failure = BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="timeout",
            message="Backend request timed out",
            details="timeout",
        ),
    )

    queued_responses = [primary_failure, retry_failure]
    telemetry_events: list[tuple[str, dict]] = []

    monkeypatch.setattr(backend_ops, "refresh_registry_cache_if_stale", lambda cli: None)
    monkeypatch.setattr(
        backend_ops,
        "build_conversation_messages",
        lambda **kwargs: [{"role": "user", "content": kwargs["user_message"]}],
    )
    monkeypatch.setattr(
        backend_ops,
        "build_backend_metadata",
        lambda cli: {"source": "daemon", "client": "test", "instanceId": cli.instance_id},
    )
    monkeypatch.setattr(
        backend_ops,
        "request_with_auth_retry",
        lambda cli, request_func, action_label, report_errors=True: queued_responses.pop(0),
    )
    monkeypatch.setattr(
        backend_ops,
        "log_audit_event",
        lambda event_type, **kwargs: telemetry_events.append((event_type, kwargs)),
    )

    result = backend_ops.perform_backend_conversation(_make_cli_stub(), "hello world", domain=None)

    assert result is None
    assert len(telemetry_events) == 1
    event_type, payload = telemetry_events[0]
    assert event_type == "backend_chat_failure_telemetry"
    assert payload["primary_payload_mode"] == "chat_completion:no_domain:metadata"
    assert payload["retry_payload_mode"] == "ask:no_domain:minimal"
    assert payload["retry_outcome"] == "retry_failed"
    assert payload["primary_error_code"] == "AI_FAILURE"
    assert payload["final_error_kind"] == "timeout"


def test_backend_failure_telemetry_records_recovery_on_retry(monkeypatch) -> None:
    """Telemetry should capture recovered_on_retry when minimal retry succeeds."""

    primary_failure = BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="http",
            message="Backend request returned error",
            status_code=500,
            details='{"code":"AI_FAILURE","detail":"Missing required parameter: \'tools[0].name\'"}',
        ),
    )
    retry_success = BackendResponse(
        ok=True,
        value=BackendChatResult(
            response_text="Recovered backend response.",
            tokens_used=123,
            cost_usd=0.01,
            model="backend-model",
        ),
    )

    queued_responses = [primary_failure, retry_success]
    telemetry_events: list[tuple[str, dict]] = []

    monkeypatch.setattr(backend_ops, "refresh_registry_cache_if_stale", lambda cli: None)
    monkeypatch.setattr(
        backend_ops,
        "build_conversation_messages",
        lambda **kwargs: [{"role": "user", "content": kwargs["user_message"]}],
    )
    monkeypatch.setattr(
        backend_ops,
        "build_backend_metadata",
        lambda cli: {"source": "daemon", "client": "test", "instanceId": cli.instance_id},
    )
    monkeypatch.setattr(
        backend_ops,
        "request_with_auth_retry",
        lambda cli, request_func, action_label, report_errors=True: queued_responses.pop(0),
    )
    monkeypatch.setattr(
        backend_ops,
        "log_audit_event",
        lambda event_type, **kwargs: telemetry_events.append((event_type, kwargs)),
    )

    result = backend_ops.perform_backend_conversation(_make_cli_stub(), "hello world", domain=None)

    assert result is not None
    assert result.source == "backend"
    assert len(telemetry_events) == 1
    event_type, payload = telemetry_events[0]
    assert event_type == "backend_chat_failure_telemetry"
    assert payload["retry_outcome"] == "recovered_on_retry"
    assert payload["primary_error_code"] == "AI_FAILURE"
    assert payload["final_error_code"] is None


def test_backend_recovery_retry_suppresses_user_error_line(monkeypatch) -> None:
    """Recovered retries should not surface a backend failure line to the user."""

    printed_lines: list[str] = []
    report_error_calls: list[tuple[str, str]] = []
    report_flags: list[bool] = []

    def _console_print(*args, **kwargs) -> None:
        printed_lines.append(" ".join(str(part) for part in args))

    cli_stub = _make_cli_stub()
    cli_stub.console = SimpleNamespace(print=_console_print)

    primary_failure = BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="http",
            message="Backend request returned error",
            status_code=500,
            details='{"code":"AI_FAILURE","detail":"Missing required parameter: \'tools[0].name\'"}',
        ),
    )
    retry_success = BackendResponse(
        ok=True,
        value=BackendChatResult(
            response_text="Recovered backend response.",
            tokens_used=99,
            cost_usd=0.02,
            model="backend-model",
        ),
    )
    queued_responses = [primary_failure, retry_success]

    monkeypatch.setattr(backend_ops, "refresh_registry_cache_if_stale", lambda cli: None)
    monkeypatch.setattr(
        backend_ops,
        "build_conversation_messages",
        lambda **kwargs: [{"role": "user", "content": kwargs["user_message"]}],
    )
    monkeypatch.setattr(
        backend_ops,
        "build_backend_metadata",
        lambda cli: {"source": "daemon", "client": "test", "instanceId": cli.instance_id},
    )

    def _mock_request_with_auth_retry(cli, request_func, action_label, report_errors=True):
        report_flags.append(bool(report_errors))
        return queued_responses.pop(0)

    monkeypatch.setattr(backend_ops, "request_with_auth_retry", _mock_request_with_auth_retry)
    monkeypatch.setattr(
        backend_ops,
        "report_backend_error",
        lambda cli, action_label, error: report_error_calls.append((action_label, getattr(error, "message", ""))),
    )
    monkeypatch.setattr(backend_ops, "log_audit_event", lambda *args, **kwargs: None)

    result = backend_ops.perform_backend_conversation(cli_stub, "hello world", domain=None)

    assert result is not None
    assert result.source == "backend"
    assert report_flags == [False, False]
    assert report_error_calls == []
    assert not any("Backend chat failed" in line for line in printed_lines)
