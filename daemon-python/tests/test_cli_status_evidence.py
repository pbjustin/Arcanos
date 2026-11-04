"""Operational questions must use measured status without generative claims."""

from __future__ import annotations

import io
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import MagicMock

import pytest
from rich.console import Console

from arcanos.cli import cli as cli_module
from arcanos.cli_intents import is_system_health_query
from arcanos.cli.context import ConversationResult
from arcanos.cli.trust_state import TrustState
from arcanos.cli_session import SessionContext
from arcanos.config import Config


HEALTH_QUESTIONS = [
    "What's your current system status?",
    "Is ARCANOS healthy?",
    "Are your backend and memory working?",
    "What is your trust state?",
    "Are you functioning normally?",
]
UNSUPPORTED_ASSESSMENT = (
    "System state: Stable\nMode: Audit-safe enabled\nMemory: Active and consistent\n"
    "Intent tracking: Working correctly\nRisk level: Low"
)


@pytest.fixture
def status_cli(monkeypatch):
    output = io.StringIO()
    cli = cli_module.ArcanosCLI.__new__(cli_module.ArcanosCLI)
    cli.console = Console(file=output, width=200, color_system=None, force_terminal=False)
    cli.backend_client = object()
    cli.instance_id = "status-fixture"
    cli.session = SessionContext(session_id=cli.instance_id)
    cli.memory = MagicMock()
    cli.rate_limiter = MagicMock()
    cli.rate_limiter.can_make_request.return_value = (True, None)
    cli.audio = MagicMock()
    cli._append_activity = MagicMock()
    cli._recompute_trust_state = MagicMock()
    cli._trust_state = TrustState.DEGRADED
    cli._registry_cache = None
    cli._registry_cache_updated_at = None
    cli._registry_cache_ttl_seconds = 300
    cli._backend_routing_preferred = "backend"
    cli._last_confirmation_handled = False
    cli._last_response = None
    monkeypatch.setattr(Config, "AGENTIC_ENABLED", False)
    monkeypatch.setattr(Config, "STREAM_RESPONSES", False)
    monkeypatch.setattr(Config, "SPEAK_RESPONSES", False)
    monkeypatch.setattr(Config, "SHOW_STATS", False)
    monkeypatch.setattr(Config, "BACKEND_FALLBACK_TO_LOCAL", False)
    monkeypatch.setattr(cli_module, "audit_record", MagicMock())
    monkeypatch.setattr(cli_module.state, "build_system_prompt", lambda _: "fixture")
    monkeypatch.setattr(cli_module.backend_ops, "send_backend_update", MagicMock())
    monkeypatch.setattr(cli_module.backend_ops, "refresh_registry_cache_if_stale", MagicMock())
    monkeypatch.setattr(cli_module.memory_ops, "record_conversation_turn", MagicMock())
    monkeypatch.setattr(cli_module.memory_ops, "update_short_term_summary", MagicMock())
    state_read = MagicMock(return_value={
        "mode": "system_state",
        "backend": {"connected": True, "registryAvailable": True},
        "stateFreshness": {"backend": "fresh", "intent": "stale"},
        "generatedAt": "2026-11-04T19:30:26.000Z",
    })
    monkeypatch.setattr(cli_module.backend_ops, "request_backend_system_state_payload", state_read)
    generated = ConversationResult(UNSUPPORTED_ASSESSMENT, 4, 0.0, "fixture", "backend")
    backend = MagicMock(return_value=generated)
    local = MagicMock(return_value=generated)
    monkeypatch.setattr(cli_module.backend_ops, "perform_backend_conversation", backend)
    monkeypatch.setattr(cli_module.local_ops, "perform_local_conversation", local)
    return cli, output, state_read, backend, local


@pytest.mark.parametrize("question", HEALTH_QUESTIONS)
def test_operational_questions_use_status_evidence_without_generation(status_cli, question):
    cli, _, state_read, backend, local = status_cli

    result = cli.handle_ask(question, return_result=True)

    backend.assert_not_called()
    local.assert_not_called()
    state_read.assert_called_once_with(cli)
    assert result is not None
    assert result.source == "diagnostic"
    assert result.tokens_used == result.cost_usd == 0
    assert "Daemon trust (local): DEGRADED" in result.response_text
    assert "Memory availability: unknown" in result.response_text
    assert "Memory consistency: unknown" in result.response_text
    assert "Overall stability and risk: unknown" in result.response_text
    assert UNSUPPORTED_ASSESSMENT not in result.response_text
    cli.memory.add_conversation.assert_not_called()
    cli_module.backend_ops.send_backend_update.assert_not_called()


@pytest.mark.parametrize("override", ["local", "backend"])
@pytest.mark.parametrize("state_payload", [None, {}])
def test_missing_status_evidence_never_falls_back_to_a_model(status_cli, state_payload, override):
    cli, _, state_read, backend, local = status_cli
    state_read.return_value = state_payload
    cli.rate_limiter.can_make_request.return_value = (False, "provider budget exhausted")

    result = cli.handle_ask("Is ARCANOS healthy?", route_override=override, return_result=True)

    assert result is not None
    assert "Backend status read: unavailable" in result.response_text
    assert "Overall stability and risk: unknown" in result.response_text
    assert "succeeded" not in result.response_text
    backend.assert_not_called()
    local.assert_not_called()
    state_read.assert_called_once_with(cli)
    cli.rate_limiter.can_make_request.assert_not_called()


@pytest.mark.parametrize("mode", ["local", "backend", "hybrid"])
@pytest.mark.parametrize("prefix", ["deep:", "backend:", "inspect:"])
@pytest.mark.parametrize("override", [None, "local", "backend"])
def test_configured_prefixes_cannot_route_operational_questions_to_generation(
    status_cli, monkeypatch, mode, prefix, override,
):
    cli, _, state_read, backend, local = status_cli
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", mode)
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "backend:", "inspect:"])

    result = cli.handle_ask(f"{prefix} Is ARCANOS healthy?", route_override=override, return_result=True)

    assert result.source == "diagnostic"
    assert "Overall stability and risk: unknown" in result.response_text
    backend.assert_not_called()
    local.assert_not_called()
    state_read.assert_called_once_with(cli)


@pytest.mark.parametrize("prefix", ["deep:", "backend:", "inspect:"])
def test_prefixed_ordinary_conversation_keeps_existing_route(status_cli, monkeypatch, prefix):
    cli, _, _, backend, local = status_cli
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "hybrid")
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "backend:", "inspect:"])

    result = cli.handle_ask(f"{prefix} Explain how AI memory works.", return_result=True)

    assert result.source == "backend"
    backend.assert_called_once()
    local.assert_not_called()


def test_missing_backend_still_reports_local_trust_and_unknown_health(status_cli):
    cli, _, state_read, backend, local = status_cli
    cli.backend_client = None

    result = cli.handle_ask("What is your trust state?", return_result=True)

    assert "Daemon trust (local): DEGRADED" in result.response_text
    assert "Backend status read: unavailable" in result.response_text
    state_read.assert_not_called()
    backend.assert_not_called()
    local.assert_not_called()


def test_reported_backend_registry_cannot_override_expired_local_registry(status_cli):
    cli, _, state_read, _, _ = status_cli
    cli._registry_cache = {"fixture": "invalid"}
    cli._registry_cache_updated_at = time.time() - 301
    state_read.return_value["stateFreshness"] = {"backend": "stale", "intent": "stale"}

    result = cli.handle_ask("What is your trust state?", return_result=True)

    assert "Daemon trust (local): DEGRADED" in result.response_text
    assert "Daemon registry evidence (local): stale or invalid" in result.response_text
    assert "Backend-reported registry availability: true (does not verify daemon registry authentication)" in result.response_text
    assert "Backend-reported freshness: stale" in result.response_text
    assert "Intent freshness (reported): stale; tracking correctness: unknown" in result.response_text
    cli_module.backend_ops.refresh_registry_cache_if_stale.assert_called_once_with(cli)


def test_unrecognized_fields_are_unknown_and_never_echo_sensitive_values(status_cli):
    cli, _, state_read, _, _ = status_cli
    private_value = "fixture-do-not-print-credential-1234567890"
    state_read.return_value = {
        "backend": {"connected": private_value, "registryAvailable": private_value},
        "stateFreshness": {"backend": private_value, "intent": private_value},
        "generatedAt": private_value,
        "memory": {"available": True, "consistent": True},
        "risk": "low",
    }

    result = cli.handle_ask("Are your backend and memory working?", return_result=True)

    assert private_value not in result.response_text
    assert "Backend-reported connection: unknown" in result.response_text
    assert "generated at: unknown" in result.response_text
    assert "Memory availability: unknown" in result.response_text
    assert "Memory consistency: unknown" in result.response_text
    assert "Overall stability and risk: unknown" in result.response_text


def test_slash_status_displays_evidence_and_labels_backend_reports(status_cli):
    cli, output, state_read, backend, local = status_cli

    assert cli.handle_status() is True

    text = output.getvalue()
    assert "Daemon trust (local): DEGRADED" in text
    assert "ARCANOS Reported System State" in text
    assert "reported.backend.registryAvailable" in text
    assert "Memory consistency: unknown" in text
    state_read.assert_called_once_with(cli)
    cli_module.backend_ops.refresh_registry_cache_if_stale.assert_called_once_with(cli)
    backend.assert_not_called()
    local.assert_not_called()


@pytest.mark.parametrize("question", [
    "Hello!", "How are you?", "What can you do?", "Can AI systems be healthy?",
    "Explain what trust state means.", "Write a story where ARCANOS is healthy.",
    "What is your system prompt?", "How does memory work in AI?",
])
def test_ordinary_conversation_and_ai_discussion_remain_conversational(status_cli, question):
    cli, _, _, backend, local = status_cli

    result = cli.handle_ask(question, return_result=True)

    assert not is_system_health_query(question)
    backend.assert_called_once()
    local.assert_not_called()
    assert result.source == "backend"


@pytest.mark.parametrize("question", [
    "WHAT IS YOUR CURRENT SYSTEM STATUS?", "  What’s your current system status?  ",
    "Show me the system health.", "Check your trust level.",
    "Is your memory working correctly?", "Are your memory and backend healthy?",
])
def test_narrow_operational_question_variants(question):
    assert is_system_health_query(question)


@pytest.mark.skipif(sys.platform != "win32", reason="Native Windows CLI subprocess acceptance")
def test_native_windows_cli_status_and_registry_recovery_without_inference(tmp_path, monkeypatch):
    source_root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(source_root / "daemon-python/scripts"))
    from local_action_acceptance.cli import DaemonFixture, SyntheticBackend

    control_token = "status-control-plane-fixture-only-1234567890"
    registry_reads = 0

    def status_route(method, path, body):
        nonlocal registry_reads
        if method == "GET" and path == "/api/daemon/registry":
            registry_reads += 1
            backend.registry_available = registry_reads > 7
        if method == "GET" and path == "/system-state":
            return 200, {
                "mode": "system_state",
                "backend": {"connected": True, "registryAvailable": True},
                "stateFreshness": {"backend": "fresh", "intent": "stale"},
                "generatedAt": "2026-11-04T19:30:26.000Z",
            }
        return None

    with SyntheticBackend(extra_routes=status_route) as backend:
        backend.purpose_bound_tokens["/system-state"] = control_token
        backend.registry_available = False
        backend.answer = "Hello from ordinary conversation fixture."
        fixture = DaemonFixture(tmp_path / "status-cli", source_root, backend=backend,
                                extra_env={"ARCANOS_CONTROL_PLANE_ACCESS_TOKEN": control_token})
        # Real public CLI entry point and interactive input, with native Windows
        # pipes preserving literal output independently of terminal screen redraws.
        commands = HEALTH_QUESTIONS + ["/status", "What is your trust state?", "Hello!", "/exit"]
        process = subprocess.run(
            [sys.executable, "-u", "-m", "arcanos.cli"], cwd=fixture.repository, env=fixture.env,
            input="\n".join(commands) + "\n", capture_output=True, text=True, encoding="utf-8", timeout=40,
        )
        assert process.returncode == 0, process.stderr
        output = process.stdout
        assert output.count("Daemon trust (local): DEGRADED") == 6
        assert output.count("Daemon trust (local): FULL") == 1
        assert output.count("Memory consistency: unknown") == 7
        assert output.count("Overall stability and risk: unknown") == 7
        assert "Daemon registry evidence (local): valid and fresh" in output
        assert "ARCANOS Reported System State" in output
        assert "Hello from ordinary conversation fixture." in output
        assert registry_reads == 8  # startup, five health questions, /status, recovery
        gpt_requests = [request for request in backend.requests if request["path"].startswith("/gpt/")]
        assert len(gpt_requests) == 1
        gpt_index = backend.requests.index(gpt_requests[0])
        assert sum(request["path"] == "/system-state" for request in backend.requests[:gpt_index]) == 10
        assert all(request["authenticated"] for request in backend.requests)
        assert control_token not in output
        assert backend.daemon_token not in output
