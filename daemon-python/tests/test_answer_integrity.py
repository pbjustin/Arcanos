"""Offline regressions at the daemon's actual text and speech boundaries."""

from __future__ import annotations

import io
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from rich.console import Console

from arcanos.agentic import agent_loop
from arcanos.backend_client import BackendApiClient
from arcanos.cli import cli as cli_module
from arcanos.cli import ui_ops
from arcanos.cli.context import ConversationResult
from arcanos.cli.trust_state import TrustState
from arcanos.cli_midlayer import translate
from arcanos.cli_session import SessionContext
from arcanos.config import Config
from arcanos.voice_boundary import Persona, apply_voice_boundary

PYTHON_ANSWER = """```python
def message(enabled):
    if enabled:
        return "It is ready; do not change this literal."
    return 'You are waiting; cannot continue.'
```"""

TAB_AND_CRLF_ANSWER = '```python\r\ndef message():\r\n\treturn "left\tright"\r\n```'
UNICODE_ANSWER = '```python\nmessage = "🛡️ 👨‍👩‍👧 a\u200bb"\n```'
FAKE_API_KEY = "sk-" + "fixture" * 5
FAKE_BEARER = "fixture" * 5
FAKE_PASSWORD = "P@" + "ssw0rd!"
NO_DISPLAYABLE_NOTICE = "No displayable response was returned."
SHORT_CREDENTIALS = [
    ("Password", "sunshine"),
    ("Token", "orchard"),
    ("Secret", "maple"),
    ("api_key", "meadow"),
    ("Authorization", "willow"),
    ("Cookie", "cedar"),
]

PUBLIC_LABELS = [
    "Password: must be 12 characters.",
    "Authorization: required for every endpoint.",
    "Token: a short-lived credential.",
    "Cookie: stores a browser preference.",
    "- **Token:** a short-lived credential",
    "Password: must be 12 characters or longer",
    "Authorization: required for every endpoint",
    "api_key: use your dashboard value",
    "Transaction type: a database transaction groups related changes",
    "Clearance level: least privilege limits access to required operations",
    "Backend endpoint: POST /api/example accepts the example request",
    "Included modules: math and json are Python standard-library modules",
    "Logic trace: compare values before choosing the next branch",
    "Retrieval context: documents cited in this answer support the explanation",
]

STRUCTURED_ANSWER = """## Result

```json
{
    "message": "It is unchanged",
    "status": "pending",
    "items": [1, 2, 3]
}
```

| Field | Value |
| --- | --- |
| status | pending |

1. Keep the original result.
2. Do not infer completion.

> Warning: this result is partial."""

JAVASCRIPT_ANSWER = """```javascript
function message() {
    return "It is ready; do not rewrite it.";
}
```

The literal must remain exact."""

SHELL_ANSWER = """Run both checks, in order:

```bash
printf '%s\\n' "It is unchanged"
printf '%s\\n' "Do not truncate the second command"
```

If either fails, stop and report the failure."""

PARAGRAPH_ANSWER = (
    "A detailed answer can contain several necessary qualifications. " * 4
    + "\n\nThe second paragraph explains an exception that changes the recommendation."
    + "\n\nThe third paragraph warns that no task has been executed."
)

PUBLIC_ANSWERS = [
    PYTHON_ANSWER,
    TAB_AND_CRLF_ANSWER,
    UNICODE_ANSWER,
    JAVASCRIPT_ANSWER,
    STRUCTURED_ANSWER,
    SHELL_ANSWER,
    PARAGRAPH_ANSWER,
    "Backend unavailable; your requested task was not completed.",
    "Rate limit exceeded. No result was generated; retry later.",
    "The phrase `session validation failed` means your session expired. Sign in again.",
    "Source verification is incomplete. The answer may need correction.",
    "Certainly, I can explain that. It is a useful distinction.",
]


@pytest.fixture
def presentation_cli(monkeypatch):
    """Use real presentation code without starting clients, threads, or inference."""
    output = io.StringIO()
    cli = cli_module.ArcanosCLI.__new__(cli_module.ArcanosCLI)
    cli.console = Console(
        file=output, width=1000, color_system=None, force_terminal=False
    )
    cli.memory = MagicMock()
    cli.memory.get_setting.return_value = 0
    cli.rate_limiter = MagicMock()
    cli.rate_limiter.can_make_request.return_value = (True, None)
    cli.audio = MagicMock()
    cli.gpt_client = MagicMock()
    cli.vision = MagicMock()
    cli.terminal = MagicMock()
    cli.terminal.is_command_safe.return_value = (False, "Fixture forbids execution")
    cli.backend_client = object()
    cli.instance_id = "integrity-fixture"
    cli.session = SessionContext(session_id=cli.instance_id)
    cli._voice_persona = Persona.CALM
    cli._trust_state = TrustState.FULL
    cli._backend_routing_preferred = "backend"
    cli._last_confirmation_handled = False
    cli._last_response = None
    cli._last_error = None
    cli._append_activity = MagicMock()
    cli._recompute_trust_state = MagicMock()
    monkeypatch.setattr(Config, "AGENTIC_ENABLED", False)
    monkeypatch.setattr(Config, "AGENT_MAX_STEPS", 1)
    monkeypatch.setattr(Config, "STREAM_RESPONSES", False)
    monkeypatch.setattr(Config, "SPEAK_RESPONSES", False)
    monkeypatch.setattr(Config, "SHOW_STATS", False)
    monkeypatch.setattr(Config, "BACKEND_FALLBACK_TO_LOCAL", False)
    monkeypatch.setattr(Config, "REPO_INDEX_ENABLED", False)
    monkeypatch.setattr(cli_module, "audit_record", MagicMock())
    monkeypatch.setattr(cli_module.state, "build_system_prompt", lambda _: "fixture")
    monkeypatch.setattr(
        cli_module.backend_ops, "request_backend_system_state_payload", lambda _: None
    )
    monkeypatch.setattr(cli_module.backend_ops, "send_backend_update", MagicMock())
    monkeypatch.setattr(cli_module.memory_ops, "update_short_term_summary", MagicMock())
    monkeypatch.setattr(agent_loop, "HistoryDB", MagicMock())
    monkeypatch.setattr(agent_loop, "PolicyGuard", MagicMock())
    monkeypatch.setattr(agent_loop, "PatchOrchestrator", MagicMock())
    return cli, output


def _deliver(monkeypatch, cli, answer, *, agentic=False, source="backend", speak=False):
    result = ConversationResult(answer, 7, 0.0, "backend-fixture", source)
    monkeypatch.setattr(
        cli_module.backend_ops,
        "perform_backend_conversation",
        lambda *args, **kwargs: result,
    )
    monkeypatch.setattr(
        cli_module.local_ops,
        "perform_local_conversation",
        lambda *args, **kwargs: result,
    )
    monkeypatch.setattr(Config, "AGENTIC_ENABLED", agentic)
    cli.handle_ask(
        "What is the complete answer?", route_override=source, speak_response=speak
    )


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "answer",
    PUBLIC_ANSWERS,
    ids=[
        "python",
        "tabs-crlf",
        "unicode-literal",
        "javascript",
        "json-markdown",
        "shell",
        "paragraphs",
        "unavailable",
        "rate-limit",
        "diagnostic",
        "qualification",
        "conversation",
    ],
)
def test_complete_answers_reach_real_console_unchanged(
    presentation_cli, monkeypatch, agentic, answer
):
    cli, output = presentation_cli
    _deliver(monkeypatch, cli, answer, agentic=agentic)

    assert answer in output.getvalue()
    assert NO_DISPLAYABLE_NOTICE not in output.getvalue()
    assert cli._last_error is None
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "multiparagraph", [False, True], ids=["standalone", "paragraphs"]
)
@pytest.mark.parametrize("label", PUBLIC_LABELS)
def test_glossaries_and_diagnostic_labels_are_complete_public_answers(
    presentation_cli, monkeypatch, agentic, multiparagraph, label
):
    """A public explanation stays intact even when its label also names metadata."""
    cli, output = presentation_cli
    answer = (
        f"Here is the explanation.\n\n{label}\n\nNo operation was executed."
        if multiparagraph
        else label
    )
    _deliver(monkeypatch, cli, answer, agentic=agentic)

    assert answer in output.getvalue()
    if not agentic:
        assert cli._last_response == answer
    assert cli._last_error is None
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("source", ["backend", "local"])
def test_full_text_is_retained_separately_from_short_speech(
    presentation_cli, monkeypatch, source
):
    cli, output = presentation_cli
    answer = (
        "Keep this complete paragraph. " * 50
        + "\n\nFinal warning: the task is incomplete."
    )
    _deliver(monkeypatch, cli, answer, source=source, speak=True)

    assert answer in output.getvalue()
    assert cli._last_response == answer
    spoken = cli.audio.speak.call_args.args[0]
    assert len(spoken) < len(answer)
    assert "Final warning" not in spoken


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "answer,secret",
    [
        (
            '<vbl severity="3" />\nPrivate audit payload: private-fixture-value',
            "private-fixture-value",
        ),
        (
            '<vbl severity="4" />\nDeveloper-only data: developer-fixture-value',
            "developer-fixture-value",
        ),
        (
            f"The request failed. API_KEY={FAKE_API_KEY}",
            FAKE_API_KEY,
        ),
        (
            f"The request failed. Authorization: Bearer {FAKE_BEARER}",
            FAKE_BEARER,
        ),
        (
            f"The request failed. Password: {FAKE_PASSWORD}",
            FAKE_PASSWORD,
        ),
    ],
)
def test_private_content_and_credentials_do_not_reach_console(
    presentation_cli, monkeypatch, agentic, answer, secret
):
    cli, output = presentation_cli
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True)

    assert secret not in output.getvalue()
    assert "Handled." not in output.getvalue()
    assert secret not in (cli._last_response or "")
    assert all(secret not in str(call) for call in cli.audio.speak.call_args_list)
    assert output.getvalue().count(NO_DISPLAYABLE_NOTICE) == int(
        answer.startswith("<vbl")
    )
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("key,value", SHORT_CREDENTIALS)
@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_short_alphabetic_credentials_are_hidden_but_failures_remain_complete(
    presentation_cli, monkeypatch, key, value, agentic
):
    """Simple credential values stay private without concealing a backend failure."""
    cli, output = presentation_cli
    failure = "Backend unavailable; your requested task was not completed."
    answer = f"{key}: {value}\n\n{failure}"
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True)

    displayed = output.getvalue()
    assert value not in displayed
    assert f"{key}: [REDACTED]\n\n{failure}" in displayed
    assert NO_DISPLAYABLE_NOTICE not in displayed
    assert "Handled." not in displayed
    assert "I've got this covered." not in displayed
    assert all(value not in str(call) for call in cli.audio.speak.call_args_list)
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("key,value", SHORT_CREDENTIALS)
def test_voice_boundary_redacts_short_alphabetic_credentials(key, value):
    """The shared voice boundary applies the same protection as actual CLI output."""
    failure = "Backend unavailable; your requested task was not completed."
    answer = f"{key}: {value}\n\n{failure}"

    assert apply_voice_boundary(answer, persona=Persona.CALM) == (
        f"{key}: [REDACTED]\n\n{failure}"
    )


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "control",
    ["\b", "\r", "\x1b[2D", "\x1b[", "\x1b", "\x1b]0;unterminated"],
    ids=[
        "backspace",
        "bare-cr",
        "cursor-move",
        "incomplete-csi",
        "escape",
        "incomplete-osc",
    ],
)
def test_unsafe_terminal_frame_gets_one_notice_without_partial_answer_or_actions(
    presentation_cli, monkeypatch, agentic, control
):
    """Reject unsafe display controls before rendering, replay, speech or proposals."""
    cli, output = presentation_cli
    answer = (
        f"Failure-prefix-fixture: task incomplete.{control}unsafe-tail\n\n"
        "```bash\nprintf private-control-fixture\n```"
    )
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True)

    assert output.getvalue().strip() == NO_DISPLAYABLE_NOTICE
    assert not cli._last_response
    cli.audio.speak.assert_not_called()
    cli.terminal.is_command_safe.assert_not_called()
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_private_tail_cannot_hide_an_unsafe_control_from_the_display_boundary(
    presentation_cli, monkeypatch, agentic
):
    """Removing a private section cannot turn an invalid full frame into an answer."""
    cli, output = presentation_cli
    answer = "Public-prefix-fixture.\n\n### Audit Summary\nprivate-tail\bunsafe-tail"
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True)

    assert output.getvalue().strip() == NO_DISPLAYABLE_NOTICE
    assert not cli._last_response
    cli.audio.speak.assert_not_called()
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize(
    "answer",
    [
        "Public-prefix-fixture.\bunsafe-tail",
        "Public-prefix-fixture.\n\n### Audit Summary\nprivate-tail\bunsafe-tail",
    ],
    ids=["answer", "private-tail"],
)
def test_translation_rejects_unsafe_full_frames_before_any_section_is_removed(answer):
    """A rejected frame cannot become an approved prefix or redaction-only answer."""
    assert translate("Explain", answer, source="backend") == ("", False)


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_safe_sgr_decoration_preserves_the_complete_failure_answer(
    presentation_cli, monkeypatch, agentic
):
    """Safe SGR decoration does not withhold or replace a substantive answer."""
    cli, output = presentation_cli
    failure = "Backend unavailable; your requested task was not completed."
    _deliver(monkeypatch, cli, f"\x1b[31m{failure}\x1b[0m", agentic=agentic)

    assert output.getvalue().strip() == failure
    if not agentic:
        assert cli._last_response == failure
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize("answer", [None, "", "   ", 42, ["unsupported"]])
def test_unsupported_answers_never_invent_success(
    presentation_cli, monkeypatch, answer, agentic
):
    cli, output = presentation_cli
    _deliver(monkeypatch, cli, answer, agentic=agentic)

    assert "Handled." not in output.getvalue()
    assert "I've got this covered." not in output.getvalue()
    assert "unsupported" not in output.getvalue()
    assert output.getvalue().count(NO_DISPLAYABLE_NOTICE) == 1
    assert "None" not in output.getvalue()
    assert not cli._last_response
    cli.audio.speak.assert_not_called()


def test_backend_parse_to_cli_preserves_code_and_ignores_private_envelope_fields(
    presentation_cli, monkeypatch
):
    cli, output = presentation_cli
    client = BackendApiClient.__new__(BackendApiClient)
    parsed = client._parse_chat_response(
        {
            "ok": True,
            "result": {"text": PYTHON_ANSWER},
            "audit_trace": {"private": "private-envelope-fixture"},
            "model": "fixture-model",
        }
    )
    assert parsed.ok
    assert parsed.value is not None
    _deliver(monkeypatch, cli, parsed.value.response_text)

    assert PYTHON_ANSWER in output.getvalue()
    assert "private-envelope-fixture" not in output.getvalue()


def test_private_agentic_payload_cannot_become_an_action_proposal(
    presentation_cli, monkeypatch
):
    cli, output = presentation_cli
    answer = '<vbl severity="4" />\n```bash\nprintf private-proposal-fixture\n```'
    _deliver(monkeypatch, cli, answer, agentic=True)

    assert "private-proposal-fixture" not in output.getvalue()
    cli.terminal.is_command_safe.assert_not_called()
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_legacy_private_tail_does_not_remove_the_public_answer(
    presentation_cli, monkeypatch, agentic
):
    cli, output = presentation_cli
    answer = "### Answer\nThe request failed; no file was changed.\n\n### Audit Summary\nprivate-tail-fixture"
    _deliver(monkeypatch, cli, answer, agentic=agentic)

    assert "The request failed; no file was changed." in output.getvalue()
    assert "private-tail-fixture" not in output.getvalue()


def test_shared_vision_presentation_keeps_failure_details(presentation_cli):
    cli, output = presentation_cli
    answer = (
        "Backend unavailable; the image could not be analyzed. No task was completed."
    )
    displayed = ui_ops.speak_to_user(
        cli,
        answer,
        persona=Persona.DIRECT,
        user_text="Analyze this image",
        memory=cli.memory,
    )

    assert displayed == answer
    assert answer in output.getvalue()
    assert NO_DISPLAYABLE_NOTICE not in output.getvalue()


@pytest.mark.parametrize(
    "answer",
    [None, "", " \n\t", 42, {}, [], '<vbl severity="3" />\nprivate-shared-fixture'],
    ids=["none", "empty", "whitespace", "number", "object", "array", "private"],
)
def test_shared_presentation_reports_withheld_or_invalid_answer_once(
    presentation_cli, answer
):
    """Every shared presentation caller receives one neutral notice after denial."""
    cli, output = presentation_cli
    displayed = ui_ops.speak_to_user(
        cli, answer, persona=Persona.CALM, user_text="Explain", memory=cli.memory
    )

    assert output.getvalue().strip() == NO_DISPLAYABLE_NOTICE
    assert not displayed
    cli.audio.speak.assert_not_called()


@pytest.mark.parametrize("filtered", [None, ""], ids=["none", "empty"])
def test_explicit_suppression_never_falls_back_to_raw_answer(
    presentation_cli, filtered
):
    """A caller's deny result stays denied without reprocessing or leaking raw text."""
    cli, output = presentation_cli
    displayed = ui_ops.speak_to_user(
        cli,
        "private-raw-answer-must-stay-hidden",
        persona=Persona.CALM,
        user_text="Explain",
        memory=cli.memory,
        filtered_text=filtered,
    )

    assert output.getvalue().strip() == NO_DISPLAYABLE_NOTICE
    assert not displayed
    cli.audio.speak.assert_not_called()


@pytest.mark.parametrize(
    "answer",
    [PYTHON_ANSWER, '<vbl severity="4" />\nprivate-stream-fixture'],
    ids=["code", "private"],
)
def test_stream_is_complete_and_filtered_before_any_answer_is_displayed(
    presentation_cli, monkeypatch, answer
):
    cli, output = presentation_cli
    monkeypatch.setattr(Config, "STREAM_RESPONSES", True)

    def chunks():
        yield answer[:8]
        # No partial answer may escape before later chunks establish its safety.
        assert answer[:8] not in output.getvalue()
        yield answer[8:]
        yield SimpleNamespace(total_tokens=7, prompt_tokens=4, completion_tokens=3)

    cli.gpt_client.ask_stream.return_value = chunks()
    cli.handle_ask("Explain the complete result", route_override="local")

    if "private-stream-fixture" in answer:
        assert "private-stream-fixture" not in output.getvalue()
        assert output.getvalue().count(NO_DISPLAYABLE_NOTICE) == 1
        assert not cli._last_response
    else:
        assert output.getvalue().count(answer) == 1
        assert cli._last_response == answer
    cli.gpt_client.ask.assert_not_called()
    assert cli._last_error is None


@pytest.mark.parametrize("mode", ["vision", "ptt"])
@pytest.mark.parametrize(
    "answer",
    [PYTHON_ANSWER, '<vbl severity="4" />\nprivate-vision-fixture'],
    ids=["code", "private"],
)
def test_multimodal_display_uses_the_same_integrity_boundary(
    presentation_cli, monkeypatch, mode, answer
):
    cli, output = presentation_cli
    if mode == "vision":
        monkeypatch.setattr(Config, "VISION_ENABLED", True)
        monkeypatch.setattr(Config, "BACKEND_VISION_ENABLED", True)
        result = ConversationResult(answer, 7, 0.0, "backend-fixture", "backend")
        monkeypatch.setattr(
            cli_module.backend_ops, "perform_backend_vision", lambda *args: result
        )
        cli.handle_see(["--backend"])
    else:
        cli.vision.capture_screenshot.return_value = "synthetic-image"
        cli.vision.analyze_image.return_value = (answer, 7, 0.0)
        cli.handle_ptt_speech("Explain the image", has_screenshot=True)

    if "private-vision-fixture" in answer:
        assert "private-vision-fixture" not in output.getvalue()
        assert output.getvalue().count(NO_DISPLAYABLE_NOTICE) == 1
        assert "None" not in output.getvalue()
        assert not cli._last_response
        cli.audio.speak.assert_not_called()
    else:
        assert answer in output.getvalue()
        assert NO_DISPLAYABLE_NOTICE not in output.getvalue()
        assert cli._last_response == answer
    assert cli._last_error is None


@pytest.mark.parametrize("private_field", ["message", "details"])
def test_backend_error_disclosure_labels_cannot_be_hidden_by_error_prefix(
    presentation_cli, private_field
):
    from arcanos.backend_client import BackendRequestError

    cli, output = presentation_cli
    values = {
        "message": "The backend is unavailable; no task was completed.",
        "details": "Retry after the service recovers.",
    }
    values[private_field] = '<vbl severity="3" />\nprivate-error-fixture'
    error = BackendRequestError(kind="network", status_code=503, **values)
    cli_module.backend_ops.report_backend_error(cli, "chat", error)

    displayed = output.getvalue()
    assert "Backend chat failed [503]" in displayed
    assert "internal diagnostic details were withheld" in displayed
    assert "private-error-fixture" not in displayed
    assert "Handled." not in displayed


def test_backend_error_is_complete_literal_and_credential_safe(presentation_cli):
    from arcanos.backend_client import BackendRequestError

    cli, output = presentation_cli
    explanation = 'No task completed. Keep [red] and "It is exact" literally.\n' * 200
    error = BackendRequestError(
        kind="http",
        status_code=503,
        message="Backend unavailable",
        details=explanation + 'BACKEND_TOKEN="test-credential-value"',
    )
    cli_module.backend_ops.report_backend_error(cli, "chat", error)
    displayed = output.getvalue()
    assert "Backend chat failed [503]: Backend unavailable" in displayed
    assert explanation in displayed
    assert "test-credential-value" not in displayed
    assert "[REDACTED]" in displayed
