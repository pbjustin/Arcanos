"""Unavailable optional status measurements must remain explicitly unknown."""

from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from arcanos.backend_client import BackendApiClient
from arcanos.config import Config, is_valid_control_plane_access_token
from arcanos.cli import state
from .credential_observation import assert_no_credential_material
from .test_cli_diagnostic_audit import diagnostic_cli, DAEMON_TOKEN, CONTROL_TOKEN, GPT_TOKEN


@pytest.mark.parametrize("availability", ["missing", "null"])
def test_status_does_not_invent_missing_intent_confidence_or_version(diagnostic_cli, availability):
    """Render valid absent/null measurements as unknown instead of numeric defaults."""
    cli, scenario, requests, _ = diagnostic_cli
    if availability == "null":
        scenario["state_payload"]["intent"].update(confidence=None, version=None)

    assert cli.handle_status() is True

    lines = cli.console.file.getvalue().splitlines()
    for field in ("intent.confidence", "intent.version"):
        row = next(line for line in lines if field in line)
        assert "unknown" in row, row
    assert requests == [("get", "/system-state")]


@pytest.mark.parametrize("confidence,version", [(0.0, 1), (0.75, 2)])
def test_status_preserves_available_intent_confidence_and_version(diagnostic_cli, confidence, version):
    """Preserve explicit valid values, including a reported confidence of zero."""
    cli, scenario, requests, _ = diagnostic_cli
    scenario["state_payload"]["intent"].update(confidence=confidence, version=version)

    assert cli.handle_status() is True

    lines = cli.console.file.getvalue().splitlines()
    for field, value in (("intent.confidence", confidence), ("intent.version", version)):
        row = next(line for line in lines if field in line)
        assert str(value) in row
        assert "unknown" not in row
    assert requests == [("get", "/system-state")]


@pytest.mark.parametrize("role", ["daemon", "control", "writing"])
@pytest.mark.parametrize("credential", [
    "2097-03-11T07:19:23.123456+00:00",
    "2097-03-11T07:19:23.12345678901Z",
], ids=["offset", "zulu"])
def test_status_redacts_timestamp_shaped_credentials_before_normalization(
    diagnostic_cli, monkeypatch, capsys, role, credential,
):
    """A valid date-shaped credential must stay private before ISO normalization."""
    cli, scenario, requests, _ = diagnostic_cli
    configured = {"daemon": DAEMON_TOKEN, "control": CONTROL_TOKEN, "writing": GPT_TOKEN}
    configured[role] = credential
    for purpose, environment_name, attribute in (
        ("daemon", "ARCANOS_DAEMON_ACCESS_TOKEN", "DAEMON_ACCESS_TOKEN"),
        ("control", "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN", "CONTROL_PLANE_ACCESS_TOKEN"),
        ("writing", "BACKEND_TOKEN", "BACKEND_TOKEN"),
    ):
        monkeypatch.setenv(environment_name, configured[purpose])
        monkeypatch.setattr(Config, attribute, configured[purpose])
    assert is_valid_control_plane_access_token(credential)
    scenario["state_payload"]["generatedAt"] = credential
    payload = scenario["state_payload"]

    def sender(method, url, **kwargs):
        """Accept only one purpose-authenticated read for each diagnostic call."""
        path = urlsplit(url).path
        assert (method, path) == ("get", "/system-state")
        assert kwargs["headers"]["Authorization"] == f"Bearer {configured['control']}"
        requests.append((method, path))
        return SimpleNamespace(status_code=200, json=lambda: payload, text=json.dumps(payload), headers={})

    cli.backend_client = BackendApiClient(
        "https://diagnostic.example.invalid", lambda: configured["writing"], request_sender=sender,
        daemon_access_token_provider=lambda: configured["daemon"],
    )
    capsys.readouterr()

    assert cli.handle_status() is True
    result = cli.handle_ask("Is ARCANOS healthy?", return_result=True)
    cli.handle_ask("Is ARCANOS healthy?", speak_response=True)

    captured = capsys.readouterr()
    observations = (
        cli.console.file.getvalue(), result.response_text, captured.out, captured.err,
        cli.audio.speak.call_args_list, cli.memory.mock_calls,
        cli.session.current_intent, cli.session.conversation_goal, state.build_system_prompt(cli),
    )
    for token in configured.values():
        assert_no_credential_material(token, *observations)
    assert "generated at: unknown" in result.response_text
    assert requests == [("get", "/system-state")] * 3
    cli.audio.speak.assert_called_once()
    cli.memory.add_conversation.assert_not_called()
