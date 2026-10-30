"""Answer fidelity and disclosure regression tests for the voice boundary."""

from unittest.mock import Mock

import pytest

from arcanos.voice_boundary import (
    Persona,
    Severity,
    apply_voice_boundary,
    classify,
    extract_severity,
)


@pytest.mark.parametrize("persona", list(Persona))
@pytest.mark.parametrize(
    "label",
    ["", '<vbl severity="0" />\n', '<vbl severity="1" />\n', '<vbl severity="2" />\n'],
)
def test_failure_is_never_reassurance_or_silence(persona, label):
    memory = Mock()
    failure = "Backend unavailable; your requested task was not completed."
    for _ in range(4):
        assert (
            apply_voice_boundary(label + failure, persona=persona, memory=memory)
            == failure
        )
    assert memory.mock_calls == []


@pytest.mark.parametrize(
    "text",
    [
        "No memory entry was created because saving failed.",
        "Session validation failed; sign in again before retrying.",
        "A traceback (most recent call last) shows where your code failed.",
        "The audit_trace field records events; do not publish its private contents.",
        "Rate limit exceeded; retry later. Nothing was completed.",
        "I am an AI; this answer may need verification.",
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
    ],
)
def test_ordinary_diagnostic_explanations_remain_complete(text):
    assert apply_voice_boundary(text, persona=Persona.CALM) == text


@pytest.mark.parametrize(
    "text",
    [
        '<vbl severity="3" />\nprivate audit payload',
        '<vbl severity="4" />\nprivate developer payload',
        '<vbl severity="9" />\nunknown disclosure label',
        '<vbl severity="invalid" />\nmalformed disclosure label',
        "audit_trace: private payload",
        '{"audit_trace": {"private": "payload"}}',
        '```json\n{"answer": "public", "audit_trace": {"private": "payload"}}\n```',
        '```json\n{\n    "audit_trace": "private payload"\n}\n```',
        "boot_snapshot: private payload",
        "memory_shell_123: private payload",
        "Active session id: private identifier",
        "Traceback (most recent call last):\n  private developer details",
    ],
)
def test_private_records_never_become_user_content_even_in_debug(text):
    assert (
        apply_voice_boundary(
            text,
            persona=Persona.DIRECT,
            debug_voice=True,
            user_text="explain debug audit",
        )
        is None
    )


def test_disclosure_prefix_only_consumes_one_leading_tag():
    text = '<vbl severity="0" />\r\nExample:\n<vbl severity="3" />\n'
    clean, severity = extract_severity(text)
    assert severity == Severity.SEV_0
    assert clean == 'Example:\n<vbl severity="3" />\n'


def test_ambiguous_nested_disclosure_labels_fail_closed():
    text = '<vbl severity="0" />\n<vbl severity="0" />\n<vbl severity="3" />\nprivate'
    assert apply_voice_boundary(text, persona=Persona.CALM) is None


@pytest.mark.parametrize(
    "text",
    [
        "\x1b[31maudit_trace: private payload\x1b[0m",
        "audit_\u200btrace: private payload",
        '\x1b[31m<vbl severity="3" />\x1b[0m\nprivate payload',
        '[{"audit_trace": "private payload"}]',
    ],
)
def test_control_normalization_cannot_hide_private_metadata(text):
    assert apply_voice_boundary(text, persona=Persona.CALM) is None


def test_literal_unicode_is_preserved_but_obfuscated_credentials_are_redacted():
    code = '```python\nmessage = "🛡️ family 👨‍👩‍👧; a\u200bb"\n```'
    assert apply_voice_boundary(code, persona=Persona.CALM) == code
    secret = "sk-" + "fixture" * 5
    obfuscated = secret[:6] + "\u200b" + secret[6:]
    result = apply_voice_boundary(
        f"Credential rejected: {obfuscated}", persona=Persona.CALM
    )
    assert result == "Credential rejected: [REDACTED]"


def test_fenced_diagnostic_example_is_content():
    text = "```text\nTraceback (most recent call last):\nValueError: cannot parse\n```\nThis is your error."
    assert classify(text) == Severity.SEV_0
    assert apply_voice_boundary(text, persona=Persona.CALM) == text


def test_credentials_are_redacted_without_shortening_the_answer():
    secret = "sk-" + "fixture" * 5
    text = (
        f"Failure: credential {secret} was rejected.\n"
        + "Important qualification.\n" * 1000
    )
    result = apply_voice_boundary(text, persona=Persona.CALM)
    assert result == text.replace(secret, "[REDACTED]")


@pytest.mark.parametrize("text", [None, "", "  \n\t", {}, [], 42])
def test_unsupported_content_has_no_invented_answer(text):
    assert apply_voice_boundary(text, persona=Persona.CALM) is None
