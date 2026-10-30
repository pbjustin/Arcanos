"""Tests for CLI mid-layer translation behavior."""

from __future__ import annotations

import pytest

from arcanos.cli_midlayer import translate


def test_local_response_passthrough_without_artifacts() -> None:
    """Local responses without structured artifacts should remain unchanged."""
    raw_response = "This is a plain local response."
    translated, should_show = translate(
        user_message="hello",
        response_text=raw_response,
        source="local",
        debug=False,
    )

    assert should_show is True
    assert translated == raw_response


def test_local_response_with_structured_artifacts_is_cleaned() -> None:
    """Local responses that mimic backend scaffolding should be cleaned for natural display."""
    raw_response = """
### Answer
Here is the update you asked for.

### Audit Summary
No issues detected.

System Routing Details
- Modules involved: Core conversational kernel
- Backend endpoint: POST /api/ask
"""

    translated, should_show = translate(
        user_message="Please summarize the update",
        response_text=raw_response,
        source="local",
        debug=False,
    )

    assert should_show is True
    assert "Here is the update you asked for." in translated
    assert "Audit Summary" not in translated
    assert "System Routing Details" not in translated
    assert "Modules involved" not in translated
    assert "Backend endpoint" not in translated


def test_local_response_with_emoji_artifact_markers_is_cleaned() -> None:
    """Emoji variant scaffolding should also be removed from local fallback responses."""
    raw_response = """
### 🧰 Answer
Hello! How can I assist you today?

### 🛑 Audit Summary
Standard greeting provided.

System Routing Details
 • Intent: general greeting response
 • Modules involved: Core conversational kernel
 • Backend endpoint: POST /api/ask
"""

    translated, should_show = translate(
        user_message="hello",
        response_text=raw_response,
        source="local",
        debug=False,
    )

    assert should_show is True
    assert translated.strip() == "Hello! How can I assist you today?"


@pytest.mark.parametrize("fence", ["```", "~~~~"])
def test_private_heading_literals_inside_code_are_preserved(fence) -> None:
    code = f"{fence}text\n### Answer\n### 🛡️ Audit Summary\nSystem Routing Details\n{fence}"
    raw = f"Warning: nothing was executed.\n\n{code}\n\n### 🛡️ Audit Summary\nprivate payload"
    text, show = translate("What is this?", raw, source="backend")
    assert show
    assert code in text
    assert text.startswith("Warning: nothing was executed.")
    assert "private payload" not in text


def test_private_section_does_not_discard_later_public_sections() -> None:
    raw = "### Answer\nFirst paragraph.\n\n### Audit Summary\nprivate\n\n### Warning\nThe task failed."
    text, show = translate("What is this?", raw, source="backend")
    assert show
    assert "First paragraph." in text
    assert "### Warning\nThe task failed." in text
    assert "private" not in text


@pytest.mark.parametrize("source", ["local", "backend"])
@pytest.mark.parametrize("debug", [False, True])
def test_no_content_or_unsupported_input_invents_an_answer(source, debug) -> None:
    for raw in [None, "", "  \n", {}, [], 123, "### Audit Summary\nprivate"]:
        assert translate("hello", raw, source=source, debug=debug) == ("", False)


def test_nested_disclosure_tags_cannot_bypass_translation() -> None:
    raw = '<vbl severity="0" />\n<vbl severity="0" />\n<vbl severity="3" />\nprivate'
    assert translate("explain", raw, source="backend", debug=True) == ("", False)


def test_decorated_private_section_is_removed_before_rendering() -> None:
    raw = "Public answer.\n\x1b[31m### Audit Summary\x1b[0m\nprivate payload"
    assert translate("explain", raw, source="backend") == ("Public answer.", True)


@pytest.mark.parametrize(
    "heading", ["### Audit Summary", "System Routing Details", "📊 COMPLIANCE STATUS"]
)
def test_producer_marked_public_answer_preserves_ambiguous_sections(heading) -> None:
    """The exact public contract preserves complete public report sections."""
    raw = f"Public preface.\n\n{heading}\nRequested report.\n\n### Warning\nNo task was completed."
    assert translate(
        "explain", raw, source="backend", presentation="public-answer-v1"
    ) == (raw, True)


@pytest.mark.parametrize("presentation", [None, "public-answer-v2"])
def test_unmarked_and_unknown_contracts_keep_legacy_audit_sections_private(
    presentation,
) -> None:
    """Absent or unsupported metadata does not grant public-answer handling."""
    raw = "### Answer\nPublic answer.\n\n### Audit Summary\nprivate-legacy-fixture"
    assert translate("explain", raw, source="backend", presentation=presentation) == (
        "Public answer.",
        True,
    )


@pytest.mark.parametrize(
    "raw",
    [
        '<vbl severity="3" />\nprivate-audit-fixture',
        '<vbl severity="4" />\nprivate-developer-fixture',
        "audit_trace: private-machine-fixture",
        "Public answer.\bunsafe-tail",
    ],
)
def test_public_metadata_does_not_bypass_disclosure_or_terminal_safety(raw) -> None:
    """Presentation metadata governs headings and cannot overrule safety labels."""
    assert translate(
        "explain", raw, source="backend", presentation="public-answer-v1"
    ) == ("", False)
