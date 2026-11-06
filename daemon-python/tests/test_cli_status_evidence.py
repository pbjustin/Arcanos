"""Operational questions must use measured status without generative claims."""

from __future__ import annotations

import io
import json
import logging
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
from arcanos.cli_runner import _dispatch_command
from arcanos.debug import logging as debug_logging
from .credential_observation import assert_no_credential_material
from .test_cli_diagnostic_audit import diagnostic_cli, DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN


HEALTH_QUESTIONS = [
    "What's your current system status?",
    "Is ARCANOS healthy?",
    "Are your backend and memory working?",
    "What is your trust state?",
    "Are you functioning normally?",
]
ADDITIONAL_HEALTH_QUESTIONS = [
    "Run a system health check.",
    "What's your backend status?",
    "Check ARCANOS health.",
    "Show your current operational status.",
    "Is the daemon connected securely?",
    "What is your current trust level?",
    "Check whether your backend is healthy.",
    "Give me your system status.",
]
CONVERSATIONAL_STATUS_CONTROLS = [
    "Explain how health checks work.",
    "What does DEGRADED mean?",
    "Write a story about a healthy AI.",
    "How do I check a Python application's status?",
    "What is the status of my GitHub PR?",
    "What's the weather?",
    "Are you able to help with coding?",
    "Hello!",
    "How are you?",
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
    cli.rate_limiter.reserve_request.return_value = ("test-admission", None)
    cli.audio = MagicMock()
    cli._append_activity = MagicMock()
    cli._recompute_trust_state = lambda: cli_module.state.recompute_trust_state(cli)
    cli._trust_state = TrustState.DEGRADED
    cli._registry_cache = None
    cli._registry_cache_updated_at = None
    cli._registry_cache_updated_monotonic_at = None
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
        "intent": {"intentId": None}, "routing": {"preferred": "backend"},
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


@pytest.mark.parametrize("question", ADDITIONAL_HEALTH_QUESTIONS)
@pytest.mark.parametrize("variant", ["plain", "normalized", "deep", "backend"])
def test_additional_direct_status_questions_avoid_generation(status_cli, monkeypatch, question, variant):
    """Route direct operational variants through evidence reads instead of either model."""
    cli, _, state_read, backend, local = status_cli
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "backend:"])
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "hybrid")
    override = None
    if variant == "normalized":
        question = " \t" + question.rstrip("?.!").upper() + "?!  \n"
    elif variant == "deep":
        question = "deep: " + question
        monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "local")
        override = "local"
    elif variant == "backend":
        question = "backend: " + question
        monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "backend")
        override = "backend"

    result = cli.handle_ask(question, route_override=override, return_result=True)

    assert result is not None
    assert result.source == "diagnostic"
    assert result.tokens_used == result.cost_usd == 0
    assert "Daemon trust (local): DEGRADED" in result.response_text
    assert "Memory consistency: unknown" in result.response_text
    assert "Overall stability and risk: unknown" in result.response_text
    state_read.assert_called_once_with(cli)
    backend.assert_not_called()
    local.assert_not_called()


@pytest.mark.parametrize("question", CONVERSATIONAL_STATUS_CONTROLS)
@pytest.mark.parametrize("prefix", ["", "deep: ", "backend: "])
def test_status_terms_in_conversational_controls_do_not_trigger_diagnostics(
    status_cli, monkeypatch, question, prefix,
):
    cli, _, _, backend, local = status_cli
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "hybrid")
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "backend:"])
    message = prefix + question

    result = cli.handle_ask(message, return_result=True)

    assert not is_system_health_query(message, Config.BACKEND_DEEP_PREFIXES)
    assert result.source == "backend"
    backend.assert_called_once()
    local.assert_not_called()


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


@pytest.mark.parametrize("handler", ["health", "slash_status"])
def test_missing_backend_still_reports_local_trust_and_unknown_health(status_cli, handler):
    """Recompute FULL to DEGRADED and report unknowns when no backend is configured."""
    cli, output, state_read, backend, local = status_cli
    cli.backend_client = None
    cli._trust_state = TrustState.FULL
    cli._recompute_trust_state = lambda: cli_module.state.recompute_trust_state(cli)

    if handler == "health":
        result = cli.handle_ask("What is your trust state?", return_result=True)
        text = result.response_text
    else:
        assert cli.handle_status() is False
        text = output.getvalue()

    assert cli._trust_state is TrustState.DEGRADED
    assert "Daemon trust (local): DEGRADED" in text
    assert "Backend status read: unavailable" in text
    state_read.assert_not_called()
    backend.assert_not_called()
    local.assert_not_called()


@pytest.mark.parametrize("value", [True, False])
def test_slash_status_preserves_genuine_reported_booleans(status_cli, value):
    """Render genuine booleans consistently in the evidence summary and status table."""
    cli, output, state_read, _, _ = status_cli
    state_read.return_value["backend"] = {"connected": value, "registryAvailable": value}

    assert cli.handle_status() is True

    text = output.getvalue()
    expected = str(value).lower()
    assert f"Backend-reported connection: {expected}" in text
    assert f"Backend-reported registry availability: {expected}" in text
    for label in ("reported.backend.connected", "reported.backend.registryAvailable"):
        row = next(line for line in text.splitlines() if label in line)
        assert expected in row


@pytest.mark.parametrize("state_available", [True, False])
@pytest.mark.parametrize("speech_setting", ["explicit", "configured"])
@pytest.mark.parametrize("generated_at", ["2026-11-04T19:30:26.000Z", "2026-11-04T19:30:26.123456Z"])
def test_spoken_status_preserves_all_essential_unknowns(
    status_cli, monkeypatch, state_available, speech_setting, generated_at,
):
    """Retain all essential evidence caveats within explicit or configured bounded speech."""
    cli, _, state_read, backend, local = status_cli
    if not state_available:
        state_read.return_value = None
    else:
        state_read.return_value["generatedAt"] = generated_at
    monkeypatch.setattr(Config, "SPEAK_RESPONSES", speech_setting == "configured")

    cli.handle_ask("Is ARCANOS healthy?", speak_response=speech_setting == "explicit")

    cli.audio.speak.assert_called_once()
    spoken = cli.audio.speak.call_args.args[0]
    assert len(spoken) <= 603  # Existing 600-character bound plus ellipsis.
    assert "Daemon trust (local): DEGRADED" in spoken
    assert "Daemon registry evidence (local): unavailable" in spoken
    for unknown in (
        "Backend dependency health: unknown", "Memory availability: unknown",
        "Memory consistency: unknown", "Audit-safe mode: unknown",
        "tracking correctness: unknown", "Overall stability and risk: unknown",
    ):
        assert unknown in spoken, spoken
    backend.assert_not_called()
    local.assert_not_called()


@pytest.mark.parametrize("handler", ["health", "slash_status"])
def test_status_recomputes_trust_when_registry_expires_during_state_read(status_cli, monkeypatch, handler):
    """Recompute trust after a blocking read expires otherwise-fresh registry evidence."""
    cli, output, state_read, backend, local = status_cli
    clock = [1000.0]
    monkeypatch.setattr(cli_module.state.time, "time", lambda: clock[0])
    monkeypatch.setattr(cli_module.state.time, "monotonic", lambda: clock[0])
    cli._registry_cache = {"validated-fixture": True}
    cli._registry_cache_updated_at = clock[0] - 1
    cli._registry_cache_updated_monotonic_at = clock[0] - 1
    cli._registry_cache_ttl_seconds = 5
    cli._trust_state = TrustState.FULL
    cli._recompute_trust_state = lambda: cli_module.state.recompute_trust_state(cli)
    payload = state_read.return_value

    def blocking_state_read(_cli):
        assert cli._trust_state is TrustState.FULL
        assert cli_module.state.registry_cache_is_valid(cli)
        clock[0] += 6
        return payload

    state_read.side_effect = blocking_state_read
    if handler == "health":
        result = cli.handle_ask("What is your trust state?", return_result=True)
        text = result.response_text
        final_audit = cli_module.audit_record.call_args.kwargs
        assert final_audit["trust"] == "DEGRADED"
    else:
        assert cli.handle_status() is True
        text = output.getvalue()

    assert cli._trust_state is TrustState.DEGRADED
    assert "Daemon trust (local): DEGRADED" in text
    assert "Daemon registry evidence (local): stale or invalid" in text
    state_read.assert_called_once_with(cli)
    cli_module.backend_ops.refresh_registry_cache_if_stale.assert_called_once_with(cli)
    backend.assert_not_called()
    local.assert_not_called()


@pytest.mark.parametrize("untrusted_value", [
    "fixture-do-not-print-credential-1234567890", "true", 1, 0, None, [], {},
])
def test_slash_status_allowlists_reported_booleans_in_evidence_and_table(status_cli, untrusted_value):
    """Treat null booleans as unknown and reject malformed non-boolean envelopes."""
    cli, output, state_read, backend, local = status_cli
    state_read.return_value["backend"] = {"connected": untrusted_value, "registryAvailable": untrusted_value}

    assert cli.handle_status() is (untrusted_value is None)

    text = output.getvalue()
    if untrusted_value is None:
        assert "Backend-reported connection: unknown" in text
        assert "Backend-reported registry availability: unknown" in text
        for label in ("reported.backend.connected", "reported.backend.registryAvailable"):
            row = next(line for line in text.splitlines() if label in line)
            assert "unknown" in row, row
    else:
        assert "Backend status read: unavailable" in text
        assert "ARCANOS Reported System State" not in text
    if isinstance(untrusted_value, str):
        assert untrusted_value not in text
    backend.assert_not_called()
    local.assert_not_called()


def test_reported_backend_registry_cannot_override_expired_local_registry(status_cli, monkeypatch):
    """Reported availability cannot renew local registry evidence past its elapsed TTL."""
    cli, _, state_read, _, _ = status_cli
    monkeypatch.setattr(cli_module.state.time, "time", lambda: 1000.0)
    monkeypatch.setattr(cli_module.state.time, "monotonic", lambda: 500.0)
    cli._registry_cache = {"fixture": "invalid"}
    cli._registry_cache_updated_at = time.time() - 301
    cli._registry_cache_updated_monotonic_at = time.monotonic() - 301
    state_read.return_value["stateFreshness"] = {"backend": "stale", "intent": "stale"}

    result = cli.handle_ask("What is your trust state?", return_result=True)

    assert "Daemon trust (local): DEGRADED" in result.response_text
    assert "Daemon registry evidence (local): stale or invalid" in result.response_text
    assert "Backend-reported registry availability: true (does not verify daemon registry authentication)" in result.response_text
    assert "Backend-reported freshness: stale" in result.response_text
    assert "Intent freshness (reported): stale" in result.response_text
    assert "Intent tracking correctness: unknown" in result.response_text
    cli_module.backend_ops.refresh_registry_cache_if_stale.assert_called_once_with(cli)


def test_unrecognized_fields_are_unknown_and_never_echo_sensitive_values(status_cli):
    cli, _, state_read, _, _ = status_cli
    private_value = "fixture-do-not-print-credential-1234567890"
    state_read.return_value = {
        "mode": "system_state",
        "backend": {"connected": private_value, "registryAvailable": private_value},
        "stateFreshness": {"backend": private_value, "intent": private_value},
        "generatedAt": private_value,
        "memory": {"available": True, "consistent": True},
        "risk": "low",
    }

    result = cli.handle_ask("Are your backend and memory working?", return_result=True)

    assert private_value not in result.response_text
    assert "Backend status read: unavailable" in result.response_text
    assert "authenticated GET /system-state succeeded" not in result.response_text
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


@pytest.mark.parametrize("decoration", ["plain", "zero_width", "terminal_control"])
def test_status_protects_configured_credentials_in_table_and_hydrated_context(
    diagnostic_cli, monkeypatch, capsys, decoration,
):
    """Redact configured credentials from status output, logs, and hydrated context."""
    cli, scenario, requests, _ = diagnostic_cli
    for environment_name, attribute, token in (
        ("ARCANOS_DAEMON_ACCESS_TOKEN", "DAEMON_ACCESS_TOKEN", DAEMON_TOKEN),
        ("ARCANOS_CONTROL_PLANE_ACCESS_TOKEN", "CONTROL_PLANE_ACCESS_TOKEN", CONTROL_TOKEN),
        ("BACKEND_TOKEN", "BACKEND_TOKEN", GPT_TOKEN),
    ):
        monkeypatch.setenv(environment_name, token)
        monkeypatch.setattr(Config, attribute, token)

    def decorate(token):
        """Produce raw, zero-width, or terminal-control versions of a fixture credential."""
        if decoration == "zero_width":
            return token[:12] + "\u200b" + token[12:]
        return "\x1b[2K" + token if decoration == "terminal_control" else token

    private_label = " ".join(decorate(token) for token in (DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN))
    scenario["state_payload"]["intent"] = {"intentId": "active-fixture-intent", "label": private_label}
    log_output = io.StringIO()
    logger = logging.Logger("status-privacy")
    handler = logging.StreamHandler(log_output)
    handler.setFormatter(debug_logging.JsonLogFormatter())
    logger.addHandler(handler)
    monkeypatch.setattr(debug_logging, "_logger", logger)
    capsys.readouterr()

    _dispatch_command(cli, "status")

    captured = capsys.readouterr()
    observed = (
        cli.console.file.getvalue(), captured.out, captured.err, log_output.getvalue(),
        cli.audio.speak.call_args_list, cli.memory.mock_calls,
        cli.session.current_intent, cli.session.conversation_goal,
        cli_module.state.build_system_prompt(cli),
    )
    for token in (DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN):
        assert_no_credential_material(token, *observed)
        assert decorate(token) not in "\n".join(str(value) for value in observed)
    assert "[REDACTED]" in cli.console.file.getvalue()
    assert cli.session.current_intent == cli.session.conversation_goal
    assert cli.session.current_intent == cli_module.state.redact_status_text(private_label)
    assert requests == [("get", "/system-state")]
    cli.audio.speak.assert_not_called()
    cli.memory.add_conversation.assert_not_called()
    cli_module.memory_ops.record_conversation_turn.assert_not_called()


def test_status_preserves_ordinary_intent_labels_as_literal_text(diagnostic_cli):
    cli, scenario, requests, _ = diagnostic_cli
    label = "Review Python status checks [red]draft[/red] — café"
    scenario["state_payload"]["intent"] = {"intentId": "ordinary-fixture-intent", "label": label}

    _dispatch_command(cli, "status")

    assert label in cli.console.file.getvalue()
    assert cli.session.current_intent == cli.session.conversation_goal == label
    assert label in cli_module.state.build_system_prompt(cli)
    assert requests == [("get", "/system-state")]


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
@pytest.mark.parametrize("questions", [HEALTH_QUESTIONS, ADDITIONAL_HEALTH_QUESTIONS], ids=["original", "additional"])
def test_native_windows_cli_status_and_registry_recovery_without_inference(tmp_path, monkeypatch, questions):
    """Exercise public Windows CLI diagnostics, trust recovery, and ordinary conversation."""
    source_root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(source_root / "daemon-python/scripts"))
    from local_action_acceptance.cli import DaemonFixture, SyntheticBackend

    control_token = "status-control-plane-fixture-only-1234567890"
    registry_reads = 0

    def status_route(method, path, body):
        """Serve canonical state and release registry evidence at the planned recovery."""
        nonlocal registry_reads
        if method == "GET" and path == "/api/daemon/registry":
            registry_reads += 1
            backend.registry_available = registry_reads > len(questions) + 2
        if method == "GET" and path == "/system-state":
            return 200, {
                "mode": "system_state",
                "intent": {"intentId": None}, "routing": {"preferred": "backend"},
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
        commands = questions + ["/status", "What is your trust state?", "Hello!", "/exit"]
        process = subprocess.run(
            [sys.executable, "-u", "-m", "arcanos.cli"], cwd=fixture.repository, env=fixture.env,
            input="\n".join(commands) + "\n", capture_output=True, text=True, encoding="utf-8", timeout=40,
        )
        assert process.returncode == 0, process.stderr
        output = process.stdout
        assert output.count("Daemon trust (local): DEGRADED") == len(questions) + 1
        assert output.count("Daemon trust (local): FULL") == 1
        assert output.count("Memory consistency: unknown") == len(questions) + 2
        assert output.count("Overall stability and risk: unknown") == len(questions) + 2
        assert "Daemon registry evidence (local): valid and fresh" in output
        assert "ARCANOS Reported System State" in output
        assert "Hello from ordinary conversation fixture." in output
        assert registry_reads == len(questions) + 3  # startup, questions, /status, recovery
        gpt_requests = [request for request in backend.requests if request["path"].startswith("/gpt/")]
        assert len(gpt_requests) == 1
        gpt_index = backend.requests.index(gpt_requests[0])
        assert sum(request["path"] == "/system-state" for request in backend.requests[:gpt_index]) == len(questions) + 5
        assert all(request["authenticated"] for request in backend.requests)
        for credential in (control_token, backend.daemon_token, backend.token):
            assert credential not in output
            assert credential not in process.stderr
        audit_events = [json.loads(line.split("[AUDIT] ", 1)[1])
                        for line in output.splitlines() if "[AUDIT] " in line]
        executions = [event for event in audit_events if event["event"].startswith("execute_")]
        expected_commands = ["ask"] * len(questions) + ["status", "ask"]
        assert len(executions) == 2 * len(expected_commands) + 3
        for index, command in enumerate(expected_commands):
            pair = executions[2 * index:2 * index + 2]
            assert [(event["event"], event["command"]) for event in pair] == [
                ("execute_attempt", command), ("execute_success", command),
            ]
            assert all(event["source"] == "diagnostic" and event["operation"] == "status" for event in pair)
        # The existing agentic greeting calls handle_ask again for its provider
        # turn: two attempts share one observed conversational outcome.
        greeting = executions[2 * len(expected_commands):]
        assert [(event["event"], event["command"]) for event in greeting] == [
            ("execute_attempt", "ask"), ("execute_attempt", "ask"), ("execute_success", "ask"),
        ]
        assert all("operation" not in event for event in greeting)
        assert greeting[-1]["source"] == "backend"
