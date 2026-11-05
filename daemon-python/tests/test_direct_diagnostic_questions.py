"""Direct status questions use read-only evidence across existing routing options."""

from __future__ import annotations

import pytest

from arcanos.cli_intents import is_system_health_query
from arcanos.config import Config

from .test_cli_diagnostic_audit import _execution_events, diagnostic_cli


DIRECT_QUESTIONS = [
    "Is the backend healthy?",
    "Are you up and running?",
    "Can you check your system status?",
    "Is ARCANOS healthy?",
    "How healthy is the backend?",
]
CONVERSATIONAL_CONTROLS = [
    "Hello!",
    "How are you?",
    "Tell me a story.",
    "If the backend were healthy, what would happen?",
    "Suppose you were up and running, how would you respond?",
    "Could a fictional AI check its system status?",
    "Is Slack healthy?",
    "Are my other applications up and running?",
    "Can you check my unrelated application's system status?",
    "Is the backend of my other application healthy?",
    "Explain how backend health is measured.",
    "What does up and running mean?",
    "Can you explain how to check your system status?",
    "Is the backend healthy in general?",
    "Are you up and running a marathon?",
    "Can you check your system status for my unrelated application?",
]


@pytest.mark.parametrize("question", DIRECT_QUESTIONS)
@pytest.mark.parametrize("mode,prefix,override,normalized", [
    ("hybrid", "", None, False),
    ("hybrid", "", None, True),
    ("local", "deep: ", "local", False),
    ("backend", "backend: ", "backend", False),
    ("local", "inspect: ", None, False),
])
def test_direct_questions_preserve_diagnostic_audit_and_one_read(
    diagnostic_cli, monkeypatch, capsys, question, mode, prefix, override, normalized,
):
    """Use actual ask routing and client transport without inference, retries, or trust changes."""
    cli, _, requests, _ = diagnostic_cli
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", mode)
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "backend:", "inspect:"])
    if normalized:
        question = " \t" + question.rstrip("?.!").upper().replace(" ", "  ") + "?! \n"
    capsys.readouterr()

    result = cli.handle_ask(prefix + question, route_override=override, return_result=True)

    assert result is not None and result.source == "diagnostic"
    assert result.tokens_used == result.cost_usd == 0
    assert "Daemon trust (local): FULL" in result.response_text
    assert "Memory availability: unknown" in result.response_text
    assert "Memory consistency: unknown" in result.response_text
    assert "Overall stability and risk: unknown" in result.response_text
    assert requests == [("get", "/system-state")]
    assert cli._registry_cache is not None
    cli.memory.add_conversation.assert_not_called()
    events = _execution_events(capsys.readouterr().out)
    assert [(event["event"], event["command"]) for event in events] == [
        ("execute_attempt", "ask"), ("execute_success", "ask"),
    ]
    assert all(event["source"] == "diagnostic" and event["operation"] == "status"
               and event["trust"] == "FULL" for event in events)


@pytest.mark.parametrize("question", CONVERSATIONAL_CONTROLS)
@pytest.mark.parametrize("prefix", ["", "inspect: "])
def test_related_discussion_stays_outside_the_bounded_diagnostic_classifier(question, prefix):
    """Keep general, hypothetical, external, and educational prompts outside full matches."""
    assert is_system_health_query(prefix + question, ["inspect:"]) is False


@pytest.mark.parametrize("question", CONVERSATIONAL_CONTROLS[:3] + [CONVERSATIONAL_CONTROLS[10]])
@pytest.mark.parametrize("prefix", ["", "deep: ", "inspect: "])
def test_conversational_controls_preserve_ordinary_request_and_audit_semantics(
    diagnostic_cli, monkeypatch, capsys, question, prefix,
):
    """Retain one synthetic GPT turn and its existing context reads for ordinary prompts."""
    cli, _, requests, _ = diagnostic_cli
    monkeypatch.setattr(Config, "BACKEND_ROUTING_MODE", "hybrid")
    monkeypatch.setattr(Config, "BACKEND_DEEP_PREFIXES", ["deep:", "inspect:"])
    capsys.readouterr()

    result = cli.handle_ask(prefix + question, return_result=True)

    assert result is not None and result.source == "backend"
    assert requests == [
        ("get", "/system-state"), ("post", "/gpt/arcanos-daemon"), ("get", "/system-state"),
    ]
    events = _execution_events(capsys.readouterr().out)
    assert [(event["event"], event["command"]) for event in events] == [
        ("execute_attempt", "ask"), ("execute_success", "ask"),
    ]
    assert all("operation" not in event for event in events)
    assert events[-1]["source"] == "backend"
