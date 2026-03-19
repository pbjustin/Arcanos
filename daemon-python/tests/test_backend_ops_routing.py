"""Tests for backend domain-to-gpt routing in CLI backend ops."""

from __future__ import annotations

from types import SimpleNamespace

from arcanos.backend_client_models import BackendChatResult, BackendResponse
from arcanos.cli import backend_ops


def _make_cli_stub() -> SimpleNamespace:
    memory_stub = SimpleNamespace(get_recent_conversations=lambda limit: [])
    console_stub = SimpleNamespace(print=lambda *args, **kwargs: None)
    backend_client_stub = SimpleNamespace()
    return SimpleNamespace(
        backend_client=backend_client_stub,
        _last_confirmation_handled=False,
        memory=memory_stub,
        system_prompt="system prompt",
        instance_id="test-instance",
        client_id="test-client",
        console=console_stub,
    )


def test_perform_backend_conversation_uses_gaming_gpt_id_for_gaming_domain(monkeypatch) -> None:
    cli_stub = _make_cli_stub()
    captured_kwargs: dict[str, object] = {}

    def _request_ask_with_domain(**kwargs):
        captured_kwargs.update(kwargs)
        return BackendResponse(
            ok=True,
            value=BackendChatResult(
                response_text="Gaming response",
                tokens_used=12,
                cost_usd=0.0,
                model="backend-model",
            ),
        )

    cli_stub.backend_client.request_ask_with_domain = _request_ask_with_domain

    monkeypatch.setattr(backend_ops, "refresh_registry_cache_if_stale", lambda cli: None)
    monkeypatch.setattr(
        backend_ops,
        "build_backend_metadata",
        lambda cli: {"source": "daemon", "client": "test", "instanceId": cli.instance_id},
    )
    monkeypatch.setattr(
        backend_ops,
        "request_with_auth_retry",
        lambda cli, request_func, action_label, report_errors=True: request_func(),
    )
    monkeypatch.setattr(backend_ops, "log_audit_event", lambda *args, **kwargs: None)

    result = backend_ops.perform_backend_conversation(
        cli_stub,
        "Ping the gaming backend for SWTOR Defense Guardian tips.",
        domain="gaming",
    )

    assert result is not None
    assert result.source == "backend"
    assert captured_kwargs["gpt_id"] == "arcanos-gaming"
    assert captured_kwargs["domain"] == "gaming"


def test_perform_backend_conversation_keeps_default_gpt_id_for_non_gaming_chat(monkeypatch) -> None:
    cli_stub = _make_cli_stub()
    captured_kwargs: dict[str, object] = {}

    def _request_chat_completion(**kwargs):
        captured_kwargs.update(kwargs)
        return BackendResponse(
            ok=True,
            value=BackendChatResult(
                response_text="Tutor response",
                tokens_used=8,
                cost_usd=0.0,
                model="backend-model",
            ),
        )

    cli_stub.backend_client.request_chat_completion = _request_chat_completion

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
        lambda cli, request_func, action_label, report_errors=True: request_func(),
    )
    monkeypatch.setattr(backend_ops, "log_audit_event", lambda *args, **kwargs: None)

    result = backend_ops.perform_backend_conversation(
        cli_stub,
        "Explain the backend routing flow.",
        domain=None,
    )

    assert result is not None
    assert result.source == "backend"
    assert captured_kwargs["gpt_id"] is None
