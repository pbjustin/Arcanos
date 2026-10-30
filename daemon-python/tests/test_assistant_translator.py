"""Tests for CLI assistant translation from raw backend output."""

from __future__ import annotations

import pytest

from arcanos.assistant.translator import translate_response


def test_translate_response_preserves_proposals_and_keeps_answer_text() -> None:
    """Action extraction must never discard a substantive part of the answer."""

    raw_response = """
### 🧠 Answer
Here is the plan:
We'll update your config and run checks.

```diff
diff --git a/sample.txt b/sample.txt
index 1111111..2222222 100644
--- a/sample.txt
+++ b/sample.txt
@@ -1 +1 @@
-old
+new
```

```bash
npm test
```

### 🛡️ Audit Summary
Compliance status: active
"""

    translated = translate_response(
        user_message="Please update my setup",
        raw_response_text=raw_response,
        source="backend",
        debug=False,
        suppress_proposals_in_display=True,
    )

    assert translated.should_show is True
    assert "We'll update your config and run checks." in translated.message
    assert "Here is the plan:" in translated.message
    assert "diff --git" in translated.message
    assert "npm test" in translated.message
    assert "Audit Summary" not in translated.message
    assert len(translated.patches) == 1
    assert len(translated.commands) == 1


def test_multiline_shell_example_is_complete_even_with_legacy_suppression_flag() -> (
    None
):
    raw = '```bash\nprintf "%s" "Do not change"\nprintf "%s" "It is exact"\n```\nDo not run this automatically.'
    result = translate_response(
        "show examples", raw, suppress_proposals_in_display=True
    )
    assert result.message == raw
    assert result.should_show
    assert len(result.commands) == 1


def test_private_payload_cannot_supply_proposals() -> None:
    raw = '<vbl severity="3" />\n```bash\necho private\n```'
    result = translate_response("debug", raw, debug=True)
    assert result.message == ""
    assert not result.should_show
    assert result.commands == []
    assert result.patches == []


def test_private_audit_section_cannot_supply_proposals() -> None:
    result = translate_response(
        "hello", "### Answer\nHello!\n### Audit Summary\n```bash\necho private\n```"
    )
    assert result.message == "Hello!"
    assert result.commands == []


@pytest.mark.parametrize("presentation", [None, "public-answer-v2", "public-answer-v1"])
def test_only_recognized_producer_metadata_preserves_public_report_proposals(
    presentation,
) -> None:
    """Proposals follow the approved answer; words inside a heading do not grant authority."""
    raw = "### Answer\nPublic answer.\n\n### Audit Summary\nRequested public report.\n```bash\nprintf proposal-fixture\n```"
    result = translate_response("explain", raw, presentation=presentation)

    assert result.should_show
    if presentation == "public-answer-v1":
        assert result.message == raw
        assert [command.command for command in result.commands] == [
            "printf proposal-fixture"
        ]
    else:
        assert result.message == "Public answer."
        assert result.commands == []


def test_presentation_label_inside_text_is_not_producer_metadata() -> None:
    """Generated text cannot self-assign the public presentation contract."""
    raw = '### Answer\nPublic answer.\n\n### Audit Summary\n{"presentation":"public-answer-v1"}\n```bash\nprintf private-fixture\n```'
    result = translate_response("explain", raw)

    assert result.message == "Public answer."
    assert result.commands == []
