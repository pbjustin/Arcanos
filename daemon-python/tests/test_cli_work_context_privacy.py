"""Working-context answers must protect the same credentials as status views."""

from __future__ import annotations

import io

import pytest
from rich.console import Console

from arcanos.cli import cli as cli_module
from arcanos.config import Config, is_valid_daemon_access_token
from .credential_observation import assert_no_credential_material
from .test_cli_diagnostic_audit import diagnostic_cli, DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN


@pytest.fixture
def work_context_cli(diagnostic_cli, monkeypatch):
    """Configure distinct synthetic credentials on the real client fixture."""
    cli, scenario, requests, clock = diagnostic_cli
    scenario["state_payload"].setdefault("routing", {"preferred": "backend"})
    for environment_name, attribute, token in (
        ("ARCANOS_DAEMON_ACCESS_TOKEN", "DAEMON_ACCESS_TOKEN", DAEMON_TOKEN),
        ("ARCANOS_CONTROL_PLANE_ACCESS_TOKEN", "CONTROL_PLANE_ACCESS_TOKEN", CONTROL_TOKEN),
        ("BACKEND_TOKEN", "BACKEND_TOKEN", GPT_TOKEN),
    ):
        monkeypatch.setenv(environment_name, token)
        monkeypatch.setattr(Config, attribute, token)
    return cli, scenario, requests, clock


@pytest.mark.parametrize("return_result", [False, True], ids=["console", "structured"])
@pytest.mark.parametrize("token", [DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN], ids=["daemon", "control", "writing"])
@pytest.mark.parametrize("form", ["raw", "embedded", "zero_width", "terminal_control"])
def test_work_context_redacts_configured_credentials_before_each_output(
    work_context_cli, capsys, return_result, token, form,
):
    """Protect credential-bearing labels without generation or retries."""
    cli, scenario, requests, _ = work_context_cli
    value = token
    expected_label = "[REDACTED]"
    if form == "embedded":
        value = f"Continue {token} after review"
        expected_label = "Continue [REDACTED] after review"
    elif form == "zero_width":
        value = token[:12] + "\u200b" + token[12:]
    elif form == "terminal_control":
        value = "\x1b[2K" + token
    scenario["state_payload"]["intent"] = {
        "intentId": "working-context-fixture", "label": value, "status": "active",
    }
    capsys.readouterr()

    result = cli.handle_ask("What am I working on?", return_result=return_result)

    shown = result.response_text if return_result else cli.console.file.getvalue()
    captured = capsys.readouterr()
    observations = (
        shown, captured.out, captured.err, cli.session.current_intent,
        cli.session.conversation_goal, cli_module.state.build_system_prompt(cli),
        cli.audio.speak.call_args_list, cli.memory.mock_calls,
    )
    for credential in (DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN):
        assert_no_credential_material(credential, *observations)
    assert value not in shown
    assert expected_label in shown
    assert cli.session.current_intent == cli.session.conversation_goal == expected_label
    assert requests == [("get", "/system-state")]
    cli.audio.speak.assert_not_called()
    cli.memory.add_conversation.assert_not_called()
    cli_module.memory_ops.record_conversation_turn.assert_not_called()
    if return_result:
        assert result.tokens_used == result.cost_usd == 0


@pytest.mark.parametrize("return_result", [False, True], ids=["console", "structured"])
@pytest.mark.parametrize("label", [
    "Café 🐍 進捗 [red]draft[/red] — Δοκιμή",
    "Continue reviewing the requested context. " * 320,
    "Review the family 👨‍👩‍👧 scene",
    "Review the shield 🛡️ marker",
    "متابعة التقدم — שלום",
], ids=["unicode-and-markup", "complete-long-label", "joined-emoji", "variation-selector", "ordinary-rtl"])
def test_work_context_preserves_complete_benign_labels(work_context_cli, return_result, label):
    """Keep ordinary Unicode and literal markup without truncating the label."""
    cli, scenario, requests, _ = work_context_cli
    cli.console = Console(file=io.StringIO(), width=20000, color_system=None, force_terminal=False)
    scenario["state_payload"]["intent"] = {
        "intentId": "ordinary-context-fixture", "label": label, "status": "active",
    }

    result = cli.handle_ask("What am I working on?", return_result=return_result)

    shown = result.response_text if return_result else cli.console.file.getvalue()
    assert label in shown
    assert "[truncated]" not in shown
    assert cli.session.current_intent == cli.session.conversation_goal == label.strip()
    assert label.strip() in cli_module.state.build_system_prompt(cli)
    assert requests == [("get", "/system-state")]
    cli.memory.add_conversation.assert_not_called()


@pytest.mark.parametrize("return_result", [False, True], ids=["console", "structured"])
@pytest.mark.parametrize("echo", ["raw", "normalized"])
def test_work_context_protects_valid_credentials_containing_ignorable_characters(
    work_context_cli, monkeypatch, return_result, echo,
):
    """Redact raw/canonical credential echoes while keeping neighboring emoji intact."""
    cli, scenario, requests, _ = work_context_cli
    credential = "private-daemon-synthetic-\u00adcredential-1234567890"
    normalized = credential.replace("\u00ad", "")
    assert is_valid_daemon_access_token(credential)
    monkeypatch.setenv("ARCANOS_DAEMON_ACCESS_TOKEN", credential)
    monkeypatch.setattr(Config, "DAEMON_ACCESS_TOKEN", credential)
    prefix = "Family 👨‍👩‍👧 "
    scenario["state_payload"]["intent"] = {
        "intentId": "ignorable-credential-fixture",
        "label": prefix + (credential if echo == "raw" else normalized), "status": "active",
    }

    result = cli.handle_ask("What am I working on?", return_result=return_result)

    shown = result.response_text if return_result else cli.console.file.getvalue()
    observations = (shown, cli.session.current_intent, cli.session.conversation_goal,
                    cli_module.state.build_system_prompt(cli))
    assert_no_credential_material(credential, *observations)
    assert_no_credential_material(normalized, *observations)
    assert prefix + "[REDACTED]" in shown
    assert cli.session.current_intent == cli.session.conversation_goal == prefix + "[REDACTED]"
    assert requests == [("get", "/system-state")]
    cli.memory.add_conversation.assert_not_called()
