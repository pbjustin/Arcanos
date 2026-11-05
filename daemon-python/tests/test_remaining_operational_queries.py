"""Direct operational questions must stay on the existing diagnostic path."""

from __future__ import annotations

import pytest

from arcanos.cli import cli as cli_module
from arcanos.cli_intents import is_system_health_query
from arcanos.config import Config

from .test_cli_status_evidence import status_cli


OPERATIONAL_QUESTIONS = [
    "How healthy is the backend?",
    "Is my system stable?",
    "Is the daemon operational?",
    "How is ARCANOS doing operationally?",
    "What's the current backend health?",
]
CONVERSATIONAL_CONTROLS = [
    "Hello!",
    "How are you?",
    "How healthy can an AI system be?",
    "Explain how backend health is measured.",
    "If the daemon were operational, what would happen?",
    "What's the current backend health of my other application?",
]


@pytest.mark.parametrize("question", OPERATIONAL_QUESTIONS)
@pytest.mark.parametrize("variant", ["plain", "normalized", "deep_local", "backend_override"])
def test_remaining_operational_questions_never_invoke_generation(
    status_cli, monkeypatch, question, variant,
):
    """Exercise actual ask routing across normalization, prefixes, and forced routes."""
    cli, _, state_read, backend, local = status_cli
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "backend:"])
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "hybrid")
    override = None
    if variant == "normalized":
        question = " \t" + question.rstrip("?.!").upper() + "?! \n"
    elif variant == "deep_local":
        question = "deep: " + question
        monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "local")
        override = "local"
    elif variant == "backend_override":
        question = "backend: " + question
        monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "backend")
        override = "backend"

    result = cli.handle_ask(question, route_override=override, return_result=True)

    assert result is not None and result.source == "diagnostic"
    assert result.tokens_used == result.cost_usd == 0
    assert "Daemon trust (local): DEGRADED" in result.response_text
    assert "Memory consistency: unknown" in result.response_text
    assert "Overall stability and risk: unknown" in result.response_text
    state_read.assert_called_once_with(cli)
    cli_module.backend_ops.refresh_registry_cache_if_stale.assert_called_once_with(cli)
    backend.assert_not_called()
    local.assert_not_called()
    cli.memory.add_conversation.assert_not_called()


@pytest.mark.parametrize("question", CONVERSATIONAL_CONTROLS)
@pytest.mark.parametrize("prefix", ["", "deep: ", "backend: "])
def test_general_hypothetical_and_external_questions_remain_conversational(
    status_cli, monkeypatch, question, prefix,
):
    """Keep greetings and discussion of other systems on ordinary conversation routing."""
    cli, _, _, backend, local = status_cli
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "hybrid")
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "backend:"])

    result = cli.handle_ask(prefix + question, return_result=True)

    assert result is not None and result.source == "backend"
    backend.assert_called_once()
    local.assert_not_called()
    cli_module.backend_ops.refresh_registry_cache_if_stale.assert_not_called()


@pytest.mark.parametrize("question,expected", [
    *((question, True) for question in OPERATIONAL_QUESTIONS),
    *((question, False) for question in CONVERSATIONAL_CONTROLS),
])
def test_bounded_classifier_distinguishes_current_operations_from_discussion(question, expected):
    """Verify the public classifier's narrow current-system question boundary."""
    assert is_system_health_query(question) is expected
