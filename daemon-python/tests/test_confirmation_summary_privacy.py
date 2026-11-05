"""Confirmation summaries use the existing credential policy and literal rendering."""

from __future__ import annotations

import re
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from arcanos.backend_client_models import BackendRequestError
from arcanos.cli import confirmation
from arcanos.config import Config
from arcanos.utils.text import DEFAULT_IGNORABLE_CODE_POINT_PATTERN

from .credential_observation import assert_no_credential_material
from .test_cli_diagnostic_audit import CONTROL_TOKEN, DAEMON_TOKEN, GPT_TOKEN, diagnostic_cli


CREDENTIALS = (DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN)


@pytest.fixture
def confirmation_cli(diagnostic_cli, monkeypatch):
    """Prepare a valid local registry and reject approval without making another request."""
    cli, _, requests, _ = diagnostic_cli
    for name, token in zip(("DAEMON_ACCESS_TOKEN", "CONTROL_PLANE_ACCESS_TOKEN", "BACKEND_TOKEN"), CREDENTIALS):
        monkeypatch.setattr(Config, name, token)
    monkeypatch.setattr(Config, "CONFIRM_SENSITIVE_ACTIONS", True)
    monkeypatch.setattr(confirmation.sys, "stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr(cli.console, "input", MagicMock(return_value="n"))
    return cli, requests


def _assert_private_summary_was_not_retained(cli, requests, capsys, caplog):
    """Inspect visible, audit/log, and mutable-context sinks without exposing credential values."""
    captured = capsys.readouterr()
    observed = (
        cli.console.file.getvalue(), captured.out, captured.err, caplog.text,
        cli.session.current_intent, cli.session.conversation_goal, cli.system_prompt,
        cli.memory.mock_calls, cli._append_activity.mock_calls, cli.audio.mock_calls,
    )
    canonical = DEFAULT_IGNORABLE_CODE_POINT_PATTERN.sub(
        "", re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", "\n".join(str(value) for value in observed)),
    )
    for token in CREDENTIALS:
        assert_no_credential_material(token, *observed, canonical)
    assert requests == []
    cli.console.input.assert_called_once()
    cli.memory.add_conversation.assert_not_called()
    cli.audio.speak.assert_not_called()


@pytest.mark.parametrize("token", CREDENTIALS, ids=["daemon", "control", "writing"])
@pytest.mark.parametrize("decoration", ["raw", "embedded", "zero_width", "terminal_color"])
def test_confirmation_summary_redacts_each_configured_credential(
    confirmation_cli, capsys, caplog, token, decoration,
):
    """Protect configured credentials even when backend summaries embed safe display decoration."""
    cli, requests = confirmation_cli
    if decoration == "embedded":
        summary = "Review the configured value " + token + " before proceeding."
    elif decoration == "zero_width":
        summary = token[:12] + "\u200b" + token[12:]
    elif decoration == "terminal_color":
        summary = token[:12] + "\x1b[31m" + token[12:] + "\x1b[0m"
    else:
        summary = token
    error = BackendRequestError(
        kind="confirmation", message="Synthetic approval required",
        confirmation_challenge_id="082ce8db-8ebe-45ec-b31e-3a7c5e828f5f",
        pending_actions=[{"summary": summary}],
    )
    capsys.readouterr()

    assert confirmation.handle_confirmation_required(cli, error) is None

    assert "[REDACTED]" in cli.console.file.getvalue()
    assert "Action rejected." in cli.console.file.getvalue()
    _assert_private_summary_was_not_retained(cli, requests, capsys, caplog)


@pytest.mark.parametrize("token", CREDENTIALS, ids=["daemon", "control", "writing"])
@pytest.mark.parametrize("shape", ["string_entry", "missing_summary", "nonstring_summary"])
def test_confirmation_summary_fallbacks_redact_configured_credentials(
    confirmation_cli, capsys, caplog, token, shape,
):
    """Protect the existing stringified-action fallback when a summary is absent or malformed."""
    cli, requests = confirmation_cli
    action = token if shape == "string_entry" else {"details": token}
    if shape == "nonstring_summary":
        action["summary"] = 123
    error = BackendRequestError(
        kind="confirmation", message="Synthetic approval required",
        confirmation_challenge_id="082ce8db-8ebe-45ec-b31e-3a7c5e828f5f",
        pending_actions=[action],
    )
    capsys.readouterr()

    assert confirmation.handle_confirmation_required(cli, error) is None

    assert "[REDACTED]" in cli.console.file.getvalue()
    _assert_private_summary_was_not_retained(cli, requests, capsys, caplog)


def test_confirmation_summary_preserves_literal_unicode_and_rich_markers(
    confirmation_cli, capsys, caplog,
):
    """Retain an ordinary action description literally while rejecting approval as before."""
    cli, requests = confirmation_cli
    summary = "Review [red]draft[/red] — café 👩‍💻"
    error = BackendRequestError(
        kind="confirmation", message="Synthetic approval required",
        confirmation_challenge_id="082ce8db-8ebe-45ec-b31e-3a7c5e828f5f",
        pending_actions=[{"summary": summary}],
    )
    capsys.readouterr()

    assert confirmation.handle_confirmation_required(cli, error) is None

    assert summary in cli.console.file.getvalue()
    assert "[REDACTED]" not in cli.console.file.getvalue()
    _assert_private_summary_was_not_retained(cli, requests, capsys, caplog)
