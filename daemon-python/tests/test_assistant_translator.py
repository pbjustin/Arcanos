"""Tests for CLI assistant translation from raw backend output."""

from __future__ import annotations

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
