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
