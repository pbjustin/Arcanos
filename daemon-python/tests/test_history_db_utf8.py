"""Regression tests for UTF-8 sanitization in HistoryDB writes."""

from __future__ import annotations

import sqlite3

from arcanos.agentic.history_db import HistoryDB


def test_history_db_accepts_surrogate_text_and_persists_safely(tmp_path) -> None:
    """HistoryDB writes should sanitize lone surrogates instead of raising encode errors."""
    db_path = tmp_path / "history.db"
    history_db = HistoryDB(db_path=db_path)

    bad_text = "prefix\udc8fsuffix"
    history_db.log_message("session-1", "user", bad_text)
    history_db.log_command("session-1", bad_text, "ok", 0, bad_text, "")
    history_db.log_policy_event("session-1", "event", {"payload": bad_text})
    history_db.set_state("state_key", {"note": bad_text})
    history_db.log_feedback("session-1", "target-1", 4, bad_text)

    with sqlite3.connect(str(db_path)) as conn:
        message_content = conn.execute("SELECT content FROM messages LIMIT 1").fetchone()[0]
        command_value = conn.execute("SELECT command FROM commands LIMIT 1").fetchone()[0]
        feedback_note = conn.execute("SELECT note FROM feedback LIMIT 1").fetchone()[0]

    assert "\udc8f" not in message_content
    assert "\udc8f" not in command_value
    assert "\udc8f" not in feedback_note
    assert "prefix" in message_content


def test_history_db_redacts_command_output_and_patch_text(tmp_path) -> None:
    db_path = tmp_path / "history.db"
    history_db = HistoryDB(db_path=db_path)

    fake_secret_name = "OPENAI_API" + "_KEY"
    fake_secret_value = "placeholder-redaction-value"
    fake_secret = f"{fake_secret_name}={fake_secret_value}"
    patch_text = "\n".join(
        [
            "diff --git a/sample.txt b/sample.txt",
            "--- a/sample.txt",
            "+++ b/sample.txt",
            "@@ -1 +1 @@",
            "-old",
            f"+{fake_secret}",
        ]
    )
    history_db.log_command("session-1", f"echo {fake_secret}", "failed", 1, fake_secret, f"Bearer abcdefghijklmnop")
    history_db.log_patch("session-1", "rollback-1", "denied", "secret patch", ["sample.txt"], {}, patch_text)

    with sqlite3.connect(str(db_path)) as conn:
        command, stdout, stderr = conn.execute("SELECT command, stdout, stderr FROM commands LIMIT 1").fetchone()
        stored_patch, patch_hash = conn.execute("SELECT patch_text, patch_sha256 FROM patches LIMIT 1").fetchone()

    for value in (command, stdout, stderr, stored_patch):
        assert fake_secret_value not in value
        assert "abcdefghijklmnop" not in value
    assert "+[redacted added line]" in stored_patch
    assert patch_hash
