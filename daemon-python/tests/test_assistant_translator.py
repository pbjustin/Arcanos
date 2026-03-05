"""Tests for CLI assistant translation from raw backend output."""

from __future__ import annotations

from arcanos.assistant.translator import translate_response


def test_translate_response_suppresses_proposals_and_keeps_natural_text() -> None:
    """Raw backend payloads should render as natural text while proposals stay separately actionable."""

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
    assert "diff --git" not in translated.message
    assert "npm test" not in translated.message
    assert len(translated.patches) == 1
    assert len(translated.commands) == 1
