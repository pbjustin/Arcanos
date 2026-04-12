"""Tests for backend domain-to-gpt routing in CLI backend ops."""

from __future__ import annotations

import json
from types import SimpleNamespace

from arcanos.backend_client_models import BackendChatResult, BackendResponse
from arcanos.cli import backend_ops


def _make_cli_stub() -> SimpleNamespace:
    memory_stub = SimpleNamespace(get_recent_conversations=lambda limit: [])
    console_stub = SimpleNamespace(print=lambda *args, **kwargs: None)
    backend_client_stub = SimpleNamespace(
        request_chat_completion=lambda **kwargs: None,
        request_ask_with_domain=lambda **kwargs: None,
        request_job_result=lambda job_id: None,
        request_job_status=lambda job_id: None,
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


def test_perform_backend_conversation_uses_backstage_gpt_id_for_backstage_domain(monkeypatch) -> None:
    cli_stub = _make_cli_stub()
    captured_kwargs: dict[str, object] = {}

    def _request_ask_with_domain(**kwargs):
        captured_kwargs.update(kwargs)
        return BackendResponse(
            ok=True,
            value=BackendChatResult(
                response_text="Backstage response",
                tokens_used=5,
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
        "Generate a booking plan for WrestleMania season.",
        domain="backstage",
    )

    assert result is not None
    assert result.source == "backend"
    assert captured_kwargs["gpt_id"] == "backstage-booker"
    assert captured_kwargs["domain"] == "backstage"


def test_perform_backend_conversation_routes_job_result_lookups_to_jobs_api(monkeypatch) -> None:
    cli_stub = _make_cli_stub()
    captured_job_ids: list[str] = []
    chat_called = {"value": False}

    def _request_job_result(job_id: str):
        captured_job_ids.append(job_id)
        return BackendResponse(
            ok=True,
            value={
                "ok": True,
                "result": {
                    "jobId": job_id,
                    "status": "completed",
                    "result": {"answer": "stored output"},
                },
            },
        )

    def _request_chat_completion(**kwargs):
        chat_called["value"] = True
        raise AssertionError("chat completion should not be used for job result retrieval")

    cli_stub.backend_client.request_job_result = _request_job_result
    cli_stub.backend_client.request_chat_completion = _request_chat_completion

    monkeypatch.setattr(
        backend_ops,
        "request_with_auth_retry",
        lambda cli, request_func, action_label, report_errors=True: request_func(),
    )

    result = backend_ops.perform_backend_conversation(
        cli_stub,
        "Pull result for job job-123 immediately.",
        domain=None,
    )

    assert result is not None
    assert result.source == "backend"
    assert captured_job_ids == ["job-123"]
    assert chat_called["value"] is False
    payload = json.loads(result.response_text)
    assert payload == {
        "data": {
            "ok": True,
            "result": {
                "jobId": "job-123",
                "result": {"answer": "stored output"},
                "status": "completed",
            },
        },
        "jobId": "job-123",
        "lookupType": "job_result",
        "ok": True,
    }


def test_perform_backend_conversation_routes_job_status_lookups_to_jobs_api(monkeypatch) -> None:
    cli_stub = _make_cli_stub()
    captured_job_ids: list[str] = []
    ask_called = {"value": False}

    def _request_job_status(job_id: str):
        captured_job_ids.append(job_id)
        return BackendResponse(
            ok=True,
            value={
                "id": job_id,
                "status": "running",
                "lifecycle_status": "running",
            },
        )

    def _request_ask_with_domain(**kwargs):
        ask_called["value"] = True
        raise AssertionError("domain ask route should not be used for job status retrieval")

    cli_stub.backend_client.request_job_status = _request_job_status
    cli_stub.backend_client.request_ask_with_domain = _request_ask_with_domain

    monkeypatch.setattr(
        backend_ops,
        "request_with_auth_retry",
        lambda cli, request_func, action_label, report_errors=True: request_func(),
    )

    result = backend_ops.perform_backend_conversation(
        cli_stub,
        "Check status for job job-456.",
        domain="gaming",
    )

    assert result is not None
    assert result.source == "backend"
    assert captured_job_ids == ["job-456"]
    assert ask_called["value"] is False
    payload = json.loads(result.response_text)
    assert payload == {
        "data": {
            "id": "job-456",
            "lifecycle_status": "running",
            "status": "running",
        },
        "jobId": "job-456",
        "lookupType": "job_status",
        "ok": True,
    }


def test_perform_backend_conversation_rejects_missing_job_id_for_lookup_requests() -> None:
    cli_stub = _make_cli_stub()
    job_result_calls: list[str] = []
    job_status_calls: list[str] = []

    cli_stub.backend_client.request_job_result = lambda job_id: job_result_calls.append(job_id)
    cli_stub.backend_client.request_job_status = lambda job_id: job_status_calls.append(job_id)

    result = backend_ops.perform_backend_conversation(
        cli_stub,
        "Fetch result for job please.",
        domain=None,
    )

    assert result is not None
    assert result.source == "backend"
    assert job_result_calls == []
    assert job_status_calls == []
    payload = json.loads(result.response_text)
    assert payload == {
        "data": {
            "error": {
                "code": "JOB_ID_REQUIRED",
                "message": "Job retrieval requests must include a concrete job ID.",
            }
        },
        "jobId": None,
        "lookupType": "job_result",
        "ok": False,
    }
