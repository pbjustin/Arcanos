"""Offline regressions at the daemon's actual text and speech boundaries."""

from __future__ import annotations

import io
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from rich.console import Console

from arcanos.agentic import agent_loop
from arcanos.agentic.history_db import HistoryDB
from arcanos.backend_client import BackendApiClient, BackendResponse
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
PUBLIC_ANSWER_HEADINGS = [
    "Audit Summary",
    "### Audit Summary",
    "### 🛡️ Audit Summary",
    "### 🛑 Audit Summary",
    "System Routing Details",
    "### System Routing Details",
    "COMPLIANCE STATUS",
    "📊 COMPLIANCE STATUS",
    "### 📊 COMPLIANCE STATUS",
]
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


def _deliver(
    monkeypatch,
    cli,
    answer,
    *,
    agentic=False,
    source="backend",
    speak=False,
    presentation=None,
    message="What is the complete answer?",
):
    result = ConversationResult(
        answer, 7, 0.0, "backend-fixture", source, presentation=presentation
    )
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
    cli.handle_ask(message, route_override=source, speak_response=speak)


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
@pytest.mark.parametrize("heading", PUBLIC_ANSWER_HEADINGS)
def test_backend_public_answer_metadata_preserves_headings_failures_and_proposals(
    presentation_cli, monkeypatch, agentic, heading
):
    """Trusted producer metadata makes otherwise ambiguous headings public content."""
    cli, output = presentation_cli
    answer = (
        f"Public preface.\n\n{heading}\nThis is the requested public report.\n\n"
        "### Failure\nBackend unavailable; the requested task was not completed.\n\n"
        "```bash\nprintf public-proposal-fixture\n```"
    )
    _deliver(monkeypatch, cli, answer, agentic=agentic, presentation="public-answer-v1")

    assert answer in output.getvalue()
    assert NO_DISPLAYABLE_NOTICE not in output.getvalue()
    if agentic:
        cli.terminal.is_command_safe.assert_called_once_with(
            "printf public-proposal-fixture"
        )
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_public_metadata_survives_real_backend_parsing_projection_and_cli_display(
    presentation_cli, monkeypatch, agentic
):
    """Only transport is stubbed along the complete backend answer presentation path."""
    cli, output = presentation_cli
    answer = "Public preface.\n\n### Audit Summary\nRequested public report.\n\n### Failure\nThe task was not completed."
    client = BackendApiClient.__new__(BackendApiClient)
    client._request_json = MagicMock(
        return_value=BackendResponse(
            ok=True,
            value={
                "ok": True,
                "result": {"text": answer},
                "presentation": "public-answer-v1",
                "model": "backend-fixture",
            },
        )
    )
    cli.backend_client = client
    cli.client_id = "fixture-client"
    cli.memory.get_recent_conversations.return_value = []
    monkeypatch.setattr(Config, "AGENTIC_ENABLED", agentic)
    monkeypatch.setattr(Config, "BACKEND_GPT_ID", "arcanos-daemon")
    monkeypatch.setattr(
        cli_module.backend_ops, "refresh_registry_cache_if_stale", lambda _: None
    )

    cli.handle_ask("Give a complete answer.", route_override="backend")

    assert answer in output.getvalue()
    assert NO_DISPLAYABLE_NOTICE not in output.getvalue()
    assert cli._last_error is None
    client._request_json.assert_called_once()
    assert client._request_json.call_args.args[1] == "/gpt/arcanos-daemon"
    cli.gpt_client.ask.assert_not_called()
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "presentation", [None, "public-answer-v2"], ids=["unmarked", "unknown"]
)
def test_unmarked_or_unknown_backend_metadata_keeps_legacy_sections_private(
    presentation_cli, monkeypatch, agentic, presentation
):
    """Only the exact established producer label changes legacy section handling."""
    cli, output = presentation_cli
    answer = "### Answer\nPublic answer.\n\n### Audit Summary\nprivate-legacy-fixture"
    _deliver(monkeypatch, cli, answer, agentic=agentic, presentation=presentation)

    assert "Public answer." in output.getvalue()
    assert "private-legacy-fixture" not in output.getvalue()
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
    "presentation", [None, "public-answer-v1"], ids=["legacy", "public-answer"]
)
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
        ("audit_trace: private-machine-fixture", "private-machine-fixture"),
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
    presentation_cli, monkeypatch, agentic, answer, secret, presentation
):
    cli, output = presentation_cli
    _deliver(
        monkeypatch, cli, answer, agentic=agentic, speak=True, presentation=presentation
    )

    assert secret not in output.getvalue()
    assert "Handled." not in output.getvalue()
    assert secret not in (cli._last_response or "")
    assert all(secret not in str(call) for call in cli.audio.speak.call_args_list)
    assert output.getvalue().count(NO_DISPLAYABLE_NOTICE) == int(
        answer.startswith(("<vbl", "audit_trace:"))
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


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "scheme,credential",
    [
        ("Token", "sunshine"),
        ("ApiKey", "orchid"),
        ("OAuth", "maple"),
        ("Negotiate", "example"),
        ("CustomScheme", "birch"),
    ],
)
def test_short_authorization_credentials_stay_private_in_display_and_stored_history(
    presentation_cli, monkeypatch, tmp_path, agentic, scheme, credential
):
    """The approved failure reaches console and durable history without credentials."""
    cli, output = presentation_cli
    history = HistoryDB(tmp_path / "history.sqlite3") if agentic else None
    if history is not None:
        monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    failure = (
        "The requested task failed; no changes were made.\n\nKeep this qualification."
    )
    answer = f"Authorization: {scheme} {credential}\n\n{failure}"
    expected = f"Authorization: [REDACTED]\n\n{failure}"
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True)

    assert expected in output.getvalue()
    assert credential not in output.getvalue()
    assert credential not in (cli._last_response or "")
    assert all(credential not in str(call) for call in cli.audio.speak.call_args_list)
    assert "Handled." not in output.getvalue()
    stored_turns = [call.args[1] for call in cli.memory.add_conversation.call_args_list]
    assert stored_turns and all(content == expected for content in stored_turns)
    if history is not None:
        export_path = tmp_path / "audit.json"
        history.export_audit(export_path, session_id=cli.instance_id)
        audit = json.loads(export_path.read_text(encoding="utf-8"))
        assert [row[2] for row in audit["messages"] if row[1] == "assistant"] == [
            expected
        ]
        assert credential not in export_path.read_text(encoding="utf-8")
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "credential_text,secrets",
    [
        (
            'Authorization: CustomScheme credential="sunshine", realm="canopy"',
            ["sunshine"],
        ),
        ('Authorization: X+ sunshine', ["sunshine"]),
        (
            "Authorization: CustomScheme token=orchard, version=one",
            ["orchard"],
        ),
        ('{"\\u0054oken":"orchard"}', ["orchard"]),
        ('{"\\u0061pi_key":"meadow"}', ["meadow"]),
    ],
    ids=["quoted-auth-params", "custom-token-scheme", "auth-params", "escaped-token", "escaped-api-key"],
)
def test_encoded_credentials_are_private_across_presentation_and_both_history_roles(
    presentation_cli, monkeypatch, tmp_path, agentic, credential_text, secrets
):
    """Header parameters and JSON escapes cannot bypass actual persisted sinks."""
    cli, output = presentation_cli
    history = HistoryDB(tmp_path / "history.sqlite3") if agentic else None
    if history is not None:
        monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    failure = (
        "The requested task failed; no changes were made.\n\nKeep this qualification."
    )
    answer = f"{credential_text}\n\n{failure}"
    message = f"{credential_text}\n\nExplain the failure."
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True, message=message)
    cli.handle_speak()

    displayed = output.getvalue()
    assert failure in displayed
    assert "[REDACTED]" in displayed
    assert NO_DISPLAYABLE_NOTICE not in displayed
    stored = [call.args[:2] for call in cli.memory.add_conversation.call_args_list]
    assert len(stored) == 1
    assert stored[0][0].endswith("\n\nExplain the failure.")
    assert stored[0][1].endswith(f"\n\n{failure}")
    surfaces = [displayed, cli._last_response or "", *stored[0]]
    surfaces.extend(str(call) for call in cli.audio.speak.call_args_list)
    if history is not None:
        export_path = tmp_path / "audit.json"
        history.export_audit(export_path, session_id=cli.instance_id)
        audit_text = export_path.read_text(encoding="utf-8")
        audit = json.loads(audit_text)
        assert {row[1]: row[2] for row in audit["messages"]} == {
            "user": stored[0][0],
            "assistant": stored[0][1],
        }
        surfaces.append(audit_text)
    assert all(secret not in surface for secret in secrets for surface in surfaces)
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "answer,presentation",
    [
        (
            "Authorization: RFC6750 describes bearer token usage.\n\nThe task failed.",
            None,
        ),
        (PYTHON_ANSWER, None),
        (UNICODE_ANSWER, None),
        (STRUCTURED_ANSWER, None),
        ('{"message":"Keep \\u2603 and \\u0061 exactly.","status":"pending"}', None),
        (
            "## Audit Summary\nRequested public report.\n\n## Failure\nThe task was not completed.",
            "public-answer-v1",
        ),
    ],
    ids=[
        "explanatory-prose",
        "markdown-code",
        "unicode-literal",
        "structured",
        "literal-json-escapes",
        "public-report",
    ],
)
def test_safe_explanations_and_code_remain_exact_in_stored_history(
    presentation_cli, monkeypatch, tmp_path, agentic, answer, presentation
):
    """Protecting history cannot rewrite legitimate prose, Markdown or code literals."""
    cli, output = presentation_cli
    history = HistoryDB(tmp_path / "history.sqlite3") if agentic else None
    if history is not None:
        monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    _deliver(
        monkeypatch, cli, answer, agentic=agentic, speak=True, presentation=presentation
    )

    assert answer in output.getvalue()
    assert NO_DISPLAYABLE_NOTICE not in output.getvalue()
    assert all(call.args[0] == answer for call in cli.audio.speak.call_args_list)
    stored_turns = [call.args[1] for call in cli.memory.add_conversation.call_args_list]
    assert stored_turns and all(content == answer for content in stored_turns)
    if history is not None:
        export_path = tmp_path / "audit.json"
        history.export_audit(export_path, session_id=cli.instance_id)
        audit = json.loads(export_path.read_text(encoding="utf-8"))
        assert [row[2] for row in audit["messages"] if row[1] == "assistant"] == [
            answer
        ]
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "answer,presentation",
    [
        ('<vbl severity="3" />\nPRIVATE_HISTORY_FIXTURE', None),
        ("audit_trace: PRIVATE_HISTORY_FIXTURE", None),
        ("UNSAFE_HISTORY_FIXTURE\bPRIVATE_HISTORY_FIXTURE", None),
        ('{"\\u0061udit_trace":{"payload":"PRIVATE_HISTORY_FIXTURE"}}', None),
        (
            '{"outer":[{"\\u0062oot_snapshot":{"payload":"PRIVATE_HISTORY_FIXTURE"}}]}',
            "public-answer-v1",
        ),
        (
            '```json\n{"\\u0061udit_trace":"PRIVATE_HISTORY_FIXTURE"}\n```\n\n```bash\nprintf PRIVATE_HISTORY_FIXTURE\n```',
            "public-answer-v1",
        ),
    ],
    ids=[
        "private-label",
        "private-record",
        "unsafe-control",
        "escaped-private-key",
        "nested-escaped-private-key",
        "fenced-escaped-private-proposal",
    ],
)
def test_withheld_answers_cannot_reappear_in_conversation_or_audit_history(
    presentation_cli, monkeypatch, tmp_path, agentic, answer, presentation
):
    """Both persisted surfaces follow the approved display decision, including replay."""
    cli, output = presentation_cli
    history = HistoryDB(tmp_path / "history.sqlite3") if agentic else None
    if history is not None:
        monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    _deliver(
        monkeypatch, cli, answer, agentic=agentic, speak=True, presentation=presentation
    )

    assert output.getvalue().count(NO_DISPLAYABLE_NOTICE) == 1
    assert "PRIVATE_HISTORY_FIXTURE" not in output.getvalue()
    assert [call.args[1] for call in cli.memory.add_conversation.call_args_list] == [""]
    if history is not None:
        export_path = tmp_path / "audit.json"
        history.export_audit(export_path, session_id=cli.instance_id)
        audit = json.loads(export_path.read_text(encoding="utf-8"))
        assert [row[2] for row in audit["messages"] if row[1] == "assistant"] == [""]
        assert "PRIVATE_HISTORY_FIXTURE" not in export_path.read_text(encoding="utf-8")
    cli.handle_speak()
    assert "Nothing to speak yet." in output.getvalue()
    cli.audio.speak.assert_not_called()
    cli.terminal.is_command_safe.assert_not_called()
    cli.terminal.execute.assert_not_called()


def test_programmatic_raw_result_is_preserved_while_its_withheld_text_is_not_stored(
    presentation_cli, monkeypatch
):
    """History filtering must not replace the backend result used by internal callers."""
    cli, output = presentation_cli
    raw = '<vbl severity="3" />\nPRIVATE_HISTORY_FIXTURE'
    result = ConversationResult(raw, 7, 0.0, "backend-fixture", "backend")
    monkeypatch.setattr(
        cli_module.backend_ops,
        "perform_backend_conversation",
        lambda *args, **kwargs: result,
    )

    returned = cli.handle_ask("Explain", route_override="backend", return_result=True)

    assert returned is result
    assert returned.response_text == raw
    assert [call.args[1] for call in cli.memory.add_conversation.call_args_list] == [""]
    assert "PRIVATE_HISTORY_FIXTURE" not in output.getvalue()
    cli.audio.speak.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_user_credentials_are_private_and_long_answers_are_complete_in_history(
    presentation_cli, monkeypatch, tmp_path, agentic
):
    """Both history roles are protected without the default output truncation limit."""
    cli, output = presentation_cli
    history = HistoryDB(tmp_path / "history.sqlite3") if agentic else None
    if history is not None:
        monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    credential = "rose" + "wood"
    message = f"Authorization: CustomScheme {credential}\n\nExplain the failure."
    safe_message = "Authorization: [REDACTED]\n\nExplain the failure."
    answer = (
        "Keep every qualification unchanged.\n" * 400 + "\nThe task was not completed."
    )
    assert len(answer) > 12_000
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True, message=message)

    assert answer in output.getvalue()
    assert credential not in output.getvalue()
    assert credential not in (cli._last_response or "")
    assert all(credential not in str(call) for call in cli.audio.speak.call_args_list)
    assert [
        (call.args[0], call.args[1])
        for call in cli.memory.add_conversation.call_args_list
    ] == [(safe_message, answer)]
    if history is not None:
        export_path = tmp_path / "audit.json"
        history.export_audit(export_path, session_id=cli.instance_id)
        audit = json.loads(export_path.read_text(encoding="utf-8"))
        assert {row[1]: row[2] for row in audit["messages"]} == {
            "user": safe_message,
            "assistant": answer,
        }
        assert credential not in export_path.read_text(encoding="utf-8")
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
    "presentation", [None, "public-answer-v1"], ids=["legacy", "public-answer"]
)
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
    presentation_cli, monkeypatch, agentic, control, presentation
):
    """Reject unsafe display controls before rendering, replay, speech or proposals."""
    cli, output = presentation_cli
    answer = (
        f"Failure-prefix-fixture: task incomplete.{control}unsafe-tail\n\n"
        "```bash\nprintf private-control-fixture\n```"
    )
    _deliver(
        monkeypatch, cli, answer, agentic=agentic, speak=True, presentation=presentation
    )

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


def test_agentic_rate_limit_does_not_add_a_misleading_display_notice(
    presentation_cli, monkeypatch
):
    cli, output = presentation_cli
    cli.rate_limiter.can_make_request.side_effect = [
        (True, None),
        (False, "Fixture request limit reached"),
    ]
    monkeypatch.setattr(Config, "AGENTIC_ENABLED", True)

    cli.handle_ask("Explain the result", route_override="backend")

    assert output.getvalue().strip() == "Rate limit: Fixture request limit reached"
    assert NO_DISPLAYABLE_NOTICE not in output.getvalue()
    agent_loop.HistoryDB.return_value.log_message.assert_not_called()
    cli.audio.speak.assert_not_called()
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
@pytest.mark.parametrize(
    "scheme", ["Token", "ApiKey", "Negotiate", "OAuth", "AWS4-HMAC-SHA256"]
)
def test_additional_authorization_schemes_are_safe_at_actual_cli_boundaries(
    presentation_cli, monkeypatch, agentic, scheme
):
    cli, output = presentation_cli
    credential = "test" + "123456789" * 2
    failure = "The operation failed; no task was completed."
    answer = f"Authorization: {scheme} {credential}\n\n{failure}"
    _deliver(monkeypatch, cli, answer, agentic=agentic, speak=True)

    assert credential not in output.getvalue()
    assert "Authorization: [REDACTED]" in output.getvalue()
    assert failure in output.getvalue()
    assert all(credential not in str(call) for call in cli.audio.speak.call_args_list)
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_balanced_colon_span_keeps_following_content_and_redacts_later_fields(
    presentation_cli, monkeypatch, agentic
):
    cli, output = presentation_cli
    answer = (
        "Token: [OAuth's docs](https://example.com) explains this.\n\n"
        "The operation failed; no task was completed.\n\nSecret: maple"
    )
    _deliver(monkeypatch, cli, answer, agentic=agentic)

    assert "Token: [REDACTED](https://example.com) explains this." in output.getvalue()
    assert "The operation failed; no task was completed." in output.getvalue()
    assert "Secret: [REDACTED]" in output.getvalue()
    assert "maple" not in output.getvalue()
    cli.terminal.execute.assert_not_called()


@pytest.mark.parametrize("agentic", [False, True], ids=["ordinary", "agentic"])
def test_authorization_standard_explanation_stays_complete(
    presentation_cli, monkeypatch, agentic
):
    cli, output = presentation_cli
    answer = (
        "Authorization: RFC6750 describes bearer token usage.\n\nNo task was completed."
    )
    _deliver(monkeypatch, cli, answer, agentic=agentic)

    assert answer in output.getvalue()


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
    presentation_cli, monkeypatch, tmp_path, agentic
):
    cli, output = presentation_cli
    history = HistoryDB(tmp_path / "history.sqlite3") if agentic else None
    if history is not None:
        monkeypatch.setattr(agent_loop, "HistoryDB", lambda: history)
    answer = "### Answer\nThe request failed; no file was changed.\n\n### Audit Summary\nprivate-tail-fixture"
    _deliver(monkeypatch, cli, answer, agentic=agentic)

    assert "The request failed; no file was changed." in output.getvalue()
    assert "private-tail-fixture" not in output.getvalue()
    expected = "The request failed; no file was changed."
    assert [call.args[1] for call in cli.memory.add_conversation.call_args_list] == [
        expected
    ]
    if history is not None:
        export_path = tmp_path / "audit.json"
        history.export_audit(export_path, session_id=cli.instance_id)
        audit = json.loads(export_path.read_text(encoding="utf-8"))
        assert [row[2] for row in audit["messages"] if row[1] == "assistant"] == [
            expected
        ]


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


@pytest.mark.parametrize("mode", ["shared", "vision"])
@pytest.mark.parametrize("presentation", [None, "public-answer-v2", "public-answer-v1"])
def test_public_presentation_metadata_reaches_shared_and_backend_vision_boundaries(
    presentation_cli, monkeypatch, mode, presentation
):
    """Trusted metadata reaches shared renderers while legacy vision envelopes stay private."""
    cli, output = presentation_cli
    answer = "### Answer\nPublic preface.\n\n### Audit Summary\nRequested-report-fixture.\n\n### Failure\nNo task was completed."
    if mode == "shared":
        ui_ops.speak_to_user(
            cli,
            answer,
            persona=Persona.CALM,
            user_text="Explain",
            memory=cli.memory,
            presentation=presentation,
        )
    else:
        monkeypatch.setattr(Config, "VISION_ENABLED", True)
        monkeypatch.setattr(Config, "BACKEND_VISION_ENABLED", True)
        result = ConversationResult(
            answer, 7, 0.0, "backend-fixture", "backend", presentation=presentation
        )
        monkeypatch.setattr(
            cli_module.backend_ops, "perform_backend_vision", lambda *args: result
        )
        cli.handle_see(["--backend"])

    displayed = output.getvalue()
    if presentation == "public-answer-v1":
        assert answer in displayed
    else:
        assert "Public preface." in displayed
        assert "Requested-report-fixture" not in displayed
    assert "No task was completed." in displayed
    cli.terminal.execute.assert_not_called()


def test_local_ptt_text_cannot_self_assign_public_presentation(presentation_cli):
    """Local vision tuples have no trusted producer metadata and keep legacy protection."""
    cli, output = presentation_cli
    answer = '### Answer\nPublic vision summary.\n\n### Audit Summary\nprivate-local-fixture\n{"presentation":"public-answer-v1"}'
    cli.vision.capture_screenshot.return_value = "synthetic-image"
    cli.vision.analyze_image.return_value = (answer, 7, 0.0)
    cli.handle_ptt_speech("Explain the image", has_screenshot=True)

    assert "Public vision summary." in output.getvalue()
    assert "private-local-fixture" not in output.getvalue()
    assert cli._last_response == "Public vision summary."


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


@pytest.mark.parametrize(
    "details",
    [
        json.dumps({"error": '<vbl severity="4" />\nprivate-json-error-fixture'}),
        json.dumps(
            {"error": {"message": '<vbl severity="3" />\nprivate-json-error-fixture'}}
        ),
        json.dumps(
            ["Public failure.", {"details": "audit_trace: private-json-error-fixture"}]
        ),
        json.dumps(
            {"error": json.dumps('<vbl severity="4" />\nprivate-json-error-fixture')}
        ),
        '{"error":"<vbl severity=\\"4\\" /> private-json-error-fixture"',
        '{"error":"Credential rejected: sk-\\u0066ixturefixturefixturefixturefixture"}',
        '{"\\u0061udit_trace":{"payload":"private-json-error-fixture"}}',
        json.dumps('{"\\u0061udit_trace":{"payload":"private-json-error-fixture"}}'),
        '[{"error":"<vbl severity=\\"4\\" /> private-json-error-fixture"}',
        json.dumps(
            {"error": '{"error":"<vbl severity=\\"4\\" /> private-json-error-fixture"'}
        ),
        json.dumps({"error": '["<vbl severity=\\"4\\" /> private-json-error-fixture"'}),
        *[
            json.dumps({key: "private-json-error-fixture"})
            for key in [
                "active session id",
                "session_boot",
                "logic_engine",
                "goals_processor",
            ]
        ],
    ],
    ids=[
        "label",
        "nested-label",
        "record",
        "encoded-label",
        "malformed",
        "encoded-credential",
        "encoded-audit-key",
        "nested-encoded-audit-key",
        "malformed-array",
        "nested-malformed-object",
        "nested-malformed-array",
        "session-id",
        "boot-record",
        "logic-record",
        "goals-record",
    ],
)
def test_structured_backend_errors_cannot_hide_private_fields_in_json(
    presentation_cli, details
):
    from arcanos.backend_client import BackendRequestError

    cli, output = presentation_cli
    error = BackendRequestError(
        kind="http", status_code=503, message="No task was completed.", details=details
    )
    cli_module.backend_ops.report_backend_error(cli, "chat", error)

    displayed = output.getvalue()
    assert "Backend chat failed [503]: No task was completed." in displayed
    assert "internal diagnostic details were withheld" in displayed
    assert "private-json-error-fixture" not in displayed
    assert "fixturefixturefixture" not in displayed
    cli.audio.speak.assert_not_called()


def test_public_structured_backend_error_remains_complete_and_literal(presentation_cli):
    from arcanos.backend_client import BackendRequestError

    cli, output = presentation_cli
    details = json.dumps(
        {
            "error": {"message": 'The backend failed. Keep "It is exact" and [red].'},
            "warnings": ["No task was completed.", "Retry only after recovery."],
            "retryable": False,
        },
        indent=2,
    )
    cli_module.backend_ops.report_backend_error(
        cli,
        "chat",
        BackendRequestError(kind="http", message="Unavailable", details=details),
    )

    assert details in output.getvalue()
    assert "internal diagnostic details were withheld" not in output.getvalue()


@pytest.mark.parametrize("structured", [False, True], ids=["plain", "json-field"])
def test_plain_bracketed_backend_warning_remains_complete(presentation_cli, structured):
    from arcanos.backend_client import BackendRequestError

    cli, output = presentation_cli
    details = (
        "[Warning] Backend unavailable; no task completed.\n\nRetry after recovery."
    )
    if structured:
        details = json.dumps({"error": details})
    cli_module.backend_ops.report_backend_error(
        cli,
        "chat",
        BackendRequestError(kind="http", message="Unavailable", details=details),
    )
    assert details in output.getvalue()
    assert "internal diagnostic details were withheld" not in output.getvalue()


@pytest.mark.parametrize("key", ["password", r"\u0054oken", r"\u0061pi_key"])
def test_structured_error_redacts_credentials_and_retains_public_failure(
    presentation_cli, key,
):
    from arcanos.backend_client import BackendRequestError

    cli, output = presentation_cli
    details = '{"error": "No task was completed.", "' + key + '": "sunshine"}'
    cli_module.backend_ops.report_backend_error(
        cli,
        "chat",
        BackendRequestError(kind="http", message="Unavailable", details=details),
    )

    assert details.replace("sunshine", "[REDACTED]") in output.getvalue()
    assert "sunshine" not in output.getvalue()
    assert "internal diagnostic details were withheld" not in output.getvalue()


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
