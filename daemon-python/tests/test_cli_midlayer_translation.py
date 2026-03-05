"""Tests for CLI mid-layer translation behavior."""

from __future__ import annotations

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
