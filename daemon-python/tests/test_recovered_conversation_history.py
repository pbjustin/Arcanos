"""Durable same-job history and usage receipts, using the actual SQLite boundary."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from arcanos import rate_limiter
from arcanos.agentic import history_db
from arcanos.agentic.history_db import HistoryDB, RecoveredConversationStorageError
from arcanos.config import Config
from arcanos.schema import Memory


def delivery_key(number=1):
    """Make a non-secret originating-job identity."""
    return sha256(f"https://fixture.invalid/job-{number}".encode()).hexdigest()


def memory_at(tmp_path):
    """Create isolated normal memory, with conftest providing isolated SQLite."""
    return Memory(tmp_path / "memory.json")


def test_plain_memory_remains_lazy_and_does_not_create_history(tmp_path):
    """Existing JSON-only users do not create or open operator recovery state."""
    memory = memory_at(tmp_path)
    assert memory.get_recent_conversations() == []
    assert memory.get_statistics()["total_requests"] == 0
    assert memory.get_recovered_usage() == []
    assert not Config.HISTORY_DB_PATH.exists()


def test_json_only_getters_do_not_create_recovery_table_in_legacy_database(tmp_path):
    """An existing unrelated history database remains unchanged by ordinary JSON reads."""
    with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
        connection.execute("CREATE TABLE legacy_history(value TEXT)")
    memory = memory_at(tmp_path)
    assert memory.get_recent_conversations() == []
    assert memory.get_statistics()["total_requests"] == 0
    with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [("legacy_history",)]


def test_normal_history_reopens_without_monitoring_or_usage_hydration(tmp_path, monkeypatch):
    """Completed answers remain visible after restart even when automatic recovery is off."""
    memory = memory_at(tmp_path)
    memory.add_conversation("normal q", "normal a", 3, 0.1)
    memory.record_recovered_conversation(delivery_key(), "s", "recovered q", "recovered a", 10, 0.01)
    monkeypatch.setattr(Config, "CONVERSATION_RECOVERY_ENABLED", False)
    restarted = memory_at(tmp_path)
    assert [turn["ai"] for turn in restarted.get_recent_conversations()] == ["normal a", "recovered a"]
    assert restarted.get_statistics()["total_requests"] == 2
    assert restarted.get_statistics()["total_tokens"] == 13
    assert restarted.get_statistics()["total_cost"] == pytest.approx(0.11)


def test_reopened_clear_and_statistics_reset_include_existing_sql_receipts(tmp_path):
    """Clearing from a fresh Memory instance preserves deduplication but hides saved turns."""
    memory = memory_at(tmp_path)
    memory.record_recovered_conversation(delivery_key(), "s", "q", "a", 10, 0.01)
    restarted = memory_at(tmp_path)
    restarted.clear_conversations()
    # Use another unopened instance so reset cannot rely on the clear operation.
    memory_at(tmp_path).reset_statistics()
    after_clear = memory_at(tmp_path)
    assert after_clear.get_recent_conversations() == []
    assert after_clear.get_statistics()["total_requests"] == 0
    assert after_clear.get_recovered_conversation(delivery_key()) is not None
    assert not after_clear.record_recovered_conversation(delivery_key(), "s", "q", "a", 10, 0.01)


def test_custom_memory_profile_does_not_read_another_configured_history(tmp_path):
    """An explicit unrelated JSON fixture cannot accidentally load operator-approved turns."""
    memory_at(tmp_path).record_recovered_conversation(delivery_key(), "s", "q", "a", 10, 0.01)
    unrelated = Memory(tmp_path / "other-profile" / "memory.json")
    assert unrelated.get_recent_conversations() == []
    assert unrelated.get_statistics()["total_requests"] == 0
    assert unrelated._recovery_db is None


def test_recovered_turn_is_atomic_idempotent_and_visible_after_restart(tmp_path):
    """A crash after commit can replay safely, preserving the original turn and usage."""
    memory = memory_at(tmp_path)
    memory.add_conversation("normal question", "normal answer", 3, 0.1)
    key = delivery_key()
    assert memory.record_recovered_conversation(key, "original-session", "original question", "complete answer", 19, 0.02)
    assert not memory.record_recovered_conversation(key, "other-session", "wrong question", "wrong answer", 99, 9)
    restarted = memory_at(tmp_path)
    usage = restarted.get_recovered_usage()
    assert len(usage) == 1
    row = restarted.get_recovered_conversation(key)
    assert row["session_id"] == "original-session"
    assert row["user"] == "original question"
    assert row["ai"] == "complete answer"
    assert not row["displayed"] and not row["audit_emitted"]
    assert [turn["ai"] for turn in restarted.get_recent_conversations()] == ["normal answer", "complete answer"]
    assert restarted.get_statistics()["total_requests"] == 2
    assert restarted.get_statistics()["total_tokens"] == 22
    assert restarted.get_statistics()["total_cost"] == pytest.approx(0.12)
    assert len(json.loads((tmp_path / "memory.json").read_text())["conversations"]) == 1
    with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
        assert connection.execute("SELECT COUNT(*) FROM conversation_deliveries").fetchone()[0] == 1
        event, detail = connection.execute("SELECT event,detail_json FROM policy_events").fetchone()
        assert event == "conversation.completed"
        assert json.loads(detail) == {"delivery_id": key, "tokens": 19, "cost": 0.02}
        assert connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0


def test_concurrent_workers_commit_and_claim_once(tmp_path):
    """Independent connections cannot insert or claim a job's completion twice."""
    database = HistoryDB(Config.HISTORY_DB_PATH)
    key = delivery_key()
    with ThreadPoolExecutor(max_workers=4) as executor:
        inserted = list(executor.map(lambda _: database.record_recovered_conversation(key, "s", "q", "a", 10, 0.01), range(8)))
        audited = list(executor.map(lambda _: database.claim_recovered_audit(key), range(8)))
    assert sum(inserted) == 1
    assert sum(audited) == 1
    assert database.get_recovered_statistics()["total_requests"] == 1
    database.mark_recovered_displayed(key)
    restarted = HistoryDB(Config.HISTORY_DB_PATH)
    assert restarted.get_recovered_conversation(key)["displayed"]
    assert restarted.get_recovered_conversation(key)["audit_emitted"]
    assert not restarted.claim_recovered_audit(key)


def test_audit_failure_rolls_back_turn_and_usage(tmp_path):
    """An interrupted completion transaction leaves no false saved or billed turn."""
    database = HistoryDB(Config.HISTORY_DB_PATH)
    with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
        connection.execute("CREATE TRIGGER reject_completion BEFORE INSERT ON policy_events BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END")
    with pytest.raises(RecoveredConversationStorageError, match="could not be saved") as error:
        database.record_recovered_conversation(delivery_key(), "s", "q", "a", 10, 0.01)
    assert "private" not in str(error.value)
    assert database.get_recovered_conversation(delivery_key()) is None
    assert database.get_recovered_statistics()["total_requests"] == 0
    assert database.get_recovered_usage() == []


def test_process_crash_mid_transaction_does_not_commit_partial_history(tmp_path):
    """A fresh process dying after history and totals writes leaves neither committed."""
    database = HistoryDB(Config.HISTORY_DB_PATH)
    program = """
import os, sqlite3, sys
from pathlib import Path
import arcanos.env as runtime_env
runtime_env._BOOTSTRAPPED = True
runtime_env._BASE_DIR = Path(os.environ['DATA_DIR'])
from arcanos.agentic.history_db import HistoryDB
db = HistoryDB(Path(sys.argv[1]))
class InterruptedConnection(sqlite3.Connection):
    def execute(self, sql, parameters=()):
        if sql.startswith('INSERT INTO policy_events'):
            os._exit(73)
        return super().execute(sql, parameters)
def connection():
    conn = sqlite3.connect(str(db.path), factory=InterruptedConnection)
    conn.execute('PRAGMA journal_mode=WAL')
    return conn
db._conn = connection
db.record_recovered_conversation(sys.argv[2], 's', 'q', 'a', 10, 0.01)
"""
    environment = {
        key: os.environ[key] for key in ("PATH", "SYSTEMROOT") if key in os.environ
    }
    environment.update(DATA_DIR=str(tmp_path), PYTHONPATH=str(Path(__file__).resolve().parents[1]))
    child = subprocess.run(
        [sys.executable, "-c", program, str(Config.HISTORY_DB_PATH), delivery_key()],
        cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=20,
    )
    assert child.returncode == 73, child.stderr
    assert database.get_recovered_conversation(delivery_key()) is None
    assert database.get_recovered_statistics()["total_requests"] == 0
    assert database.get_recovered_usage() == []
    assert database.record_recovered_conversation(delivery_key(), "s", "q", "a", 10, 0.01)


def test_failed_display_preserves_approved_answer_without_another_turn(tmp_path):
    """Commit-before-display permits restart delivery without regenerating or recounting."""
    memory = memory_at(tmp_path)
    key = delivery_key()
    memory.record_recovered_conversation(key, "s", "q", "a", 10, 0.01)
    # Simulate terminal output raising before its acknowledgement can commit.
    restarted = memory_at(tmp_path)
    assert restarted.get_recovered_conversation(key)["ai"] == "a"
    assert not restarted.get_recovered_conversation(key)["displayed"]
    assert not restarted.record_recovered_conversation(key, "s", "q", "a", 10, 0.01)
    restarted.mark_recovered_displayed(key)
    assert restarted.get_statistics()["total_requests"] == 1


def test_withheld_output_records_empty_history_and_truthful_audit(tmp_path):
    """Output validation can withhold text while preserving authoritative usage once."""
    memory = memory_at(tmp_path)
    memory.record_recovered_conversation(delivery_key(), "s", "q", "", 10, 0.01)
    assert memory.get_recovered_conversation(delivery_key())["ai"] == ""
    assert memory.get_recent_conversations()[0]["ai"] == ""
    with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
        assert connection.execute("SELECT event FROM policy_events").fetchone()[0] == "conversation.withheld"


def test_clear_and_reset_preserve_replay_receipts(tmp_path):
    """Normal clearing semantics hide history without reopening a completed job."""
    memory = memory_at(tmp_path)
    key = delivery_key()
    memory.record_recovered_conversation(key, "s", "q", "a", 10, 0.01)
    memory.clear_conversations()
    memory.reset_statistics()
    assert memory.get_recent_conversations() == []
    assert memory.get_statistics()["total_requests"] == 0
    assert not memory.record_recovered_conversation(key, "s", "q", "a", 10, 0.01)
    assert len(memory.get_recovered_usage()) == 1


@pytest.mark.parametrize("budget_name,budget", [("RECOVERED_CONVERSATION_LIMIT", 1), ("RECOVERED_CONVERSATION_BYTES", 600)])
def test_capacity_failure_keeps_existing_receipt_and_accounting(tmp_path, monkeypatch, budget_name, budget):
    """Bounded capacity fails closed, allowing the caller to retain encrypted pending work."""
    monkeypatch.setattr(history_db, budget_name, budget)
    database = HistoryDB(Config.HISTORY_DB_PATH)
    database.record_recovered_conversation(delivery_key(), "s", "q", "a", 10, 0.01)
    with pytest.raises(RecoveredConversationStorageError, match="capacity"):
        database.record_recovered_conversation(delivery_key(2), "s", "q", "a", 10, 0.01)
    assert database.get_recovered_conversation(delivery_key(2)) is None
    assert database.get_recovered_statistics()["total_requests"] == 1


def test_pruning_keeps_eight_day_receipts_and_lifetime_totals(tmp_path, monkeypatch):
    """Only old displayed rows retire; undelivered answers and cumulative totals survive."""
    clock = [2_000_000_000.0]
    monkeypatch.setattr(history_db, "time", SimpleNamespace(time=lambda: clock[0]))
    database = HistoryDB(Config.HISTORY_DB_PATH)
    old_key, pending_key = delivery_key(), delivery_key(2)
    database.record_recovered_conversation(old_key, "s", "q", "a", 10, 0.01)
    database.mark_recovered_displayed(old_key)
    database.record_recovered_conversation(pending_key, "s", "q", "a", 20, 0.02)
    clock[0] += history_db.RECOVERED_DEDUP_RETENTION_SECONDS - 1
    database.record_recovered_conversation(delivery_key(3), "s", "q", "a", 30, 0.03)
    assert database.get_recovered_conversation(old_key) is not None
    clock[0] += 2
    database.record_recovered_conversation(delivery_key(4), "s", "q", "a", 40, 0.04)
    assert database.get_recovered_conversation(old_key) is None
    assert database.get_recovered_conversation(pending_key) is not None
    assert database.get_recovered_statistics()["total_tokens"] == 100


def test_full_approved_answer_is_preserved_and_credentials_are_redacted(tmp_path):
    """Persistence applies current presentation redaction without truncating long answers."""
    memory = memory_at(tmp_path)
    capability = "v1." + "C" * 43
    answer = "Complete paragraph.\n" * 2000 + "OPENAI_API_KEY=synthetic-private-key " + capability
    memory.record_recovered_conversation(delivery_key(), capability, "Bearer abcdefghijklmnop", answer, 10, 0.01)
    row = memory.get_recovered_conversation(delivery_key())
    assert row["ai"].startswith("Complete paragraph.\n" * 2000)
    assert "synthetic-private-key" not in row["ai"]
    assert "abcdefghijklmnop" not in row["user"]
    assert capability not in row["session_id"]
    with sqlite3.connect(Config.HISTORY_DB_PATH) as connection:
        dump = "\n".join(connection.iterdump())
    assert "synthetic-private-key" not in dump
    assert "abcdefghijklmnop" not in dump
    assert capability not in dump


@pytest.mark.parametrize("key,tokens,cost", [("bad", 1, 0.1), (delivery_key(), -1, 0.1), (delivery_key(), 1, float("nan")), (delivery_key(), True, 0.1)])
def test_invalid_accounting_is_rejected_without_saved_completion(tmp_path, key, tokens, cost):
    """Invalid identity or fabricated usage cannot become a completed history record."""
    memory = memory_at(tmp_path)
    with pytest.raises(RecoveredConversationStorageError):
        memory.record_recovered_conversation(key, "s", "q", "a", tokens, cost)
    assert memory.get_recovered_usage() == []


def test_recovered_limiter_hydrates_once_and_charges_original_day(monkeypatch):
    """Restart hydration never moves yesterday's charge onto today's daily budget."""
    clock = [datetime(2026, 11, 6, 0, 30)]

    class ControlledDateTime(datetime):
        """Control both limiter calendar operations."""

        @classmethod
        def now(cls, tz=None):
            """Return the deterministic local clock."""
            return clock[0]

    monkeypatch.setattr(rate_limiter, "datetime", ControlledDateTime)
    monkeypatch.setattr(rate_limiter, "time", SimpleNamespace(time=lambda: clock[0].timestamp()))
    limiter = rate_limiter.RateLimiter()
    yesterday = (clock[0] - timedelta(minutes=45)).timestamp()
    today = (clock[0] - timedelta(minutes=5)).timestamp()
    assert limiter.record_recovered_request(delivery_key(), 20, 0.02, yesterday)
    assert limiter.record_recovered_request(delivery_key(2), 10, 0.01, today)
    assert not limiter.record_recovered_request(delivery_key(2), 10, 0.01, today)
    assert limiter.tokens_today == 10
    assert limiter.cost_today == pytest.approx(0.01)
    assert limiter.requests_per_hour == [yesterday, today]
    clock[0] += timedelta(days=1)
    assert not limiter.record_recovered_request(delivery_key(2), 10, 0.01, today)
    assert limiter.get_usage_stats()["tokens_today"] == 0


def test_sql_usage_hydrates_fresh_limiter_without_duplicate_charge(tmp_path):
    """The actual durable receipts initialize the next process's local rate limits."""
    memory = memory_at(tmp_path)
    memory.record_recovered_conversation(delivery_key(), "s", "q", "a", 10, 0.01)
    restarted = memory_at(tmp_path)
    limiter = rate_limiter.RateLimiter()
    for _ in range(2):
        for row in restarted.get_recovered_usage():
            limiter.record_recovered_request(row["delivery_id"], row["tokens"], row["cost"], row["created_at"])
    assert limiter.get_usage_stats()["tokens_today"] == 10
    assert limiter.get_usage_stats()["requests_this_hour"] == 1


def test_duplicate_limiter_hydration_does_not_sweep_or_recharge(monkeypatch):
    """Repeated startup reconciliation is constant-time for already-known receipts."""
    limiter = rate_limiter.RateLimiter()
    now = rate_limiter.time.time()
    assert limiter.record_recovered_request(delivery_key(), 10, 0.01, now)

    class NoSweepDict(dict):
        """Reject an accidental full receipt scan on the duplicate fast path."""

        def items(self):
            """Expose an unneeded O(n) scan as a functional regression."""
            raise AssertionError("Duplicate hydration must not scan retained receipts")

    limiter._recovered_requests = NoSweepDict(limiter._recovered_requests)
    hourly = list(limiter.requests_per_hour)
    assert not limiter.record_recovered_request(delivery_key(), 10, 0.01, now)
    assert limiter.tokens_today == 10
    assert limiter.cost_today == pytest.approx(0.01)
    assert limiter.requests_per_hour == hourly
