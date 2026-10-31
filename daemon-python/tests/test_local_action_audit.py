"""Local action diagnostics must not retain credentials from failed operations."""

from collections import deque
import json
import sqlite3
import threading
from types import SimpleNamespace

import pytest

from arcanos.agentic.history_db import HistoryDB
from arcanos.agentic.policy_guard import PolicyGuard
from arcanos.cli import audit, state
from arcanos.voice_boundary import sanitize_tool_output


SECRET = "sun" + "shine"
SENSITIVE = "Authorization: Token " + SECRET


def test_execution_audit_redacts_nested_values_and_keys(capsys):
    audit.record("execute_attempt", payload={SENSITIVE: [SENSITIVE], "password": SECRET})
    emitted = capsys.readouterr().out
    assert SECRET not in emitted
    assert "execute_attempt" in emitted


def test_activity_redacts_command_credentials():
    cli = SimpleNamespace(_activity=deque(), _activity_lock=threading.Lock())
    state.append_activity(cli, "run", SENSITIVE)
    assert SECRET not in json.dumps(list(cli._activity))


def test_patch_failure_summary_error_and_feedback_are_redacted(tmp_path):
    db = HistoryDB(tmp_path / "history.db")
    db.log_patch("session", "rollback", "failed", SENSITIVE, [], {}, "", error=SENSITIVE)
    db.log_feedback("session", "rollback", 1, SENSITIVE)
    with sqlite3.connect(db.path) as connection:
        summary, error = connection.execute("SELECT summary, error FROM patches").fetchone()
        note = connection.execute("SELECT note FROM feedback").fetchone()[0]
    assert SECRET not in summary + error + note
    db.export_audit(tmp_path / "audit.json")
    assert SECRET not in (tmp_path / "audit.json").read_text(encoding="utf-8")


def test_patch_status_update_preserves_operation_metadata(tmp_path):
    db = HistoryDB(tmp_path / "history.db")
    db.log_patch("session", "rollback", "applied", "summary", ["a.txt"], {"a.txt": "backup"}, "patch")
    original = db.get_patch("rollback")
    assert original["status"] == "applied"
    assert original["session_id"] == "session"
    db.update_patch_status("rollback", "rolled_back")
    updated = db.get_patch("rollback")
    assert updated == {**original, "status": "rolled_back"}


def test_command_history_withholds_private_tool_output(tmp_path):
    db = HistoryDB(tmp_path / "history.db")
    private = '<vbl severity="3" />\noperator-private-fixture'
    db.log_command("session", "command", "failed", 7, private, private)
    with sqlite3.connect(db.path) as connection:
        stdout, stderr, status, code = connection.execute(
            "SELECT stdout, stderr, status, return_code FROM commands"
        ).fetchone()
    assert "operator-private-fixture" not in stdout + stderr
    assert status == "failed" and code == 7


def test_private_action_diagnostics_are_withheld(tmp_path, capsys):
    private = '<vbl severity="3" />\noperator-private-fixture'
    audit.record("execute_failed", error=private)
    assert "operator-private-fixture" not in capsys.readouterr().out
    cli = SimpleNamespace(_activity=deque(), _activity_lock=threading.Lock())
    state.append_activity(cli, "error", private)
    assert "operator-private-fixture" not in json.dumps(list(cli._activity))
    db = HistoryDB(tmp_path / "history.db")
    db.log_patch("session", "rollback", "failed", private, [], {}, "", error=private)
    row = db.recent_patches()[0]
    assert "operator-private-fixture" not in row.summary + row.error
    db.update_patch_status("rollback", "failed", private)
    assert "operator-private-fixture" not in db.recent_patches()[0].error


@pytest.mark.parametrize("stored", ["{bad", "null", "0", '"false"'])
def test_corrupt_safe_mode_state_cannot_enable_execution(tmp_path, stored):
    db = HistoryDB(tmp_path / "history.db")
    with db._conn() as connection:
        connection.execute(
            "INSERT INTO kv_state(key, value_json, ts_ms) VALUES(?,?,0)",
            (PolicyGuard.SAFE_MODE_KEY, stored),
        )
    assert PolicyGuard(db).check_command("echo fixture").allowed is False


def test_structured_credentials_are_redacted_in_policy_history(tmp_path):
    db = HistoryDB(tmp_path / "history.db")
    db.log_policy_event("session", "action_failed", {"nested": {"password": SECRET}})
    db.set_state("fixture", {"password": SECRET})
    db.export_audit(tmp_path / "audit.json")
    assert SECRET not in (tmp_path / "audit.json").read_text(encoding="utf-8")
    assert SECRET not in json.dumps(db.get_state("fixture"))


@pytest.mark.parametrize("value", [" ", "\t", "\r\n", " \n\t "])
def test_whitespace_tool_output_is_empty_not_withheld(value):
    assert sanitize_tool_output(value) == ""
