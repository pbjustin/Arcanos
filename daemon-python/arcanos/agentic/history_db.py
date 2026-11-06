
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import time
import uuid
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from ..config import Config
from ..cli.cli_policy import redact_output, redact_patch_preview
from ..utils.text import sanitize_utf8_text
from ..voice_boundary import sanitize_tool_output


RECOVERED_CONVERSATION_LIMIT = 2048
RECOVERED_CONVERSATION_BYTES = 64 * 1024 * 1024
RECOVERED_DEDUP_RETENTION_SECONDS = 8 * 24 * 60 * 60
_RECOVERED_TOTALS_KEY = "conversation-delivery-totals-v1"


class RecoveredConversationStorageError(RuntimeError):
    """A recovered answer could not be committed; its pending receipt must remain."""


def _validate_delivery_id(delivery_id: str) -> None:
    """Accept only the non-secret SHA-256 identity of an originating backend job."""
    if not isinstance(delivery_id, str) or re.fullmatch(r"[a-f0-9]{64}", delivery_id) is None:
        raise RecoveredConversationStorageError("Invalid conversation delivery identity.")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sanitize_json_value(value: Any) -> Any:
    """
    Purpose: Recursively sanitize JSON-like values before serialization/storage.
    Inputs/Outputs: arbitrary value -> UTF-8-safe value with preserved shape.
    Edge cases: Non-container values pass through unchanged.
    """
    if isinstance(value, str):
        return sanitize_utf8_text(redact_output(value))
    if isinstance(value, list):
        return [_sanitize_json_value(item) for item in value]
    if isinstance(value, dict):
        sanitized = {str(_sanitize_json_value(key)): _sanitize_json_value(item) for key, item in value.items()}
        # Preserve key/value context: sanitizing a password value alone cannot
        # recognize that its otherwise ordinary text is a credential.
        encoded = redact_output(json.dumps(sanitized, ensure_ascii=False), apply_truncation=False)
        try:
            return json.loads(encoded)
        except (TypeError, ValueError):
            return "[REDACTED]"
    return value


@dataclass
class PatchLog:
    rollback_id: str
    ts_ms: int
    status: str
    summary: str
    files: list[str]
    backups: dict[str, str]
    error: Optional[str] = None


class HistoryDB:
    """SQLite-backed history for messages, patches, commands, snapshots, and policy events."""

    def __init__(self, db_path: Optional[Path] = None, *, recovery: bool = False) -> None:
        self.path = db_path or Config.HISTORY_DB_PATH
        # Recovery must release its foreground worker within the shutdown join
        # budget even while another process owns SQLite's WAL writer slot.
        # Other history callers retain sqlite3's existing five-second timeout.
        self._connection_timeout = 0.25 if recovery else 5.0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=self._connection_timeout)
        try:
            conn.execute("PRAGMA journal_mode=WAL;")
        except sqlite3.Error:
            conn.close()
            raise
        return conn

    def _init(self) -> None:
        with self._conn() as c:
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    ts_ms INTEGER,
                    role TEXT,
                    content TEXT
                )
                """
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS patches (
                    rollback_id TEXT PRIMARY KEY,
                    session_id TEXT,
                    ts_ms INTEGER,
                    status TEXT,
                    summary TEXT,
                    files_json TEXT,
                    backups_json TEXT,
                    patch_text TEXT,
                    patch_sha256 TEXT,
                    error TEXT
                )
                """
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS commands (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    ts_ms INTEGER,
                    command TEXT,
                    status TEXT,
                    return_code INTEGER,
                    stdout TEXT,
                    stderr TEXT
                )
                """
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS snapshots (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    ts_ms INTEGER,
                    git_head TEXT,
                    repo_root TEXT,
                    config_json TEXT,
                    repo_index_json TEXT,
                    repo_index_sha256 TEXT
                )
                """
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS policy_events (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    ts_ms INTEGER,
                    event TEXT,
                    detail_json TEXT
                )
                """
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS kv_state (
                    key TEXT PRIMARY KEY,
                    value_json TEXT,
                    ts_ms INTEGER
                )
                """
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS feedback (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    ts_ms INTEGER,
                    target_id TEXT,
                    rating INTEGER,
                    note TEXT
                )
                """
            )
            c.execute(
                """
                CREATE TABLE IF NOT EXISTS conversation_deliveries (
                    delivery_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    user_text TEXT NOT NULL,
                    answer_text TEXT NOT NULL,
                    tokens INTEGER NOT NULL,
                    cost REAL NOT NULL,
                    created_at REAL NOT NULL,
                    displayed INTEGER NOT NULL DEFAULT 0,
                    audit_emitted INTEGER NOT NULL DEFAULT 0,
                    history_visible INTEGER NOT NULL DEFAULT 1,
                    payload_bytes INTEGER NOT NULL
                )
                """
            )
            self._scrub_cleared_recovered_content(c)

    @staticmethod
    def _scrub_cleared_recovered_content(connection: sqlite3.Connection) -> None:
        """Remove cleared, displayed payloads while keeping delivery and audit receipts.

        Undisplayed answers remain available for crash recovery until display
        acknowledgement. This is logical content deletion, not physical erasure
        of SQLite pages, WAL files or independently retained backups.
        """
        connection.execute(
            """UPDATE conversation_deliveries
            SET session_id='', user_text='', answer_text='', payload_bytes=length(delivery_id)+256
            WHERE history_visible=0 AND displayed=1
            AND (session_id<>'' OR user_text<>'' OR answer_text<>'')"""
        )

    def record_recovered_conversation(
        self, delivery_id: str, session_id: str, user: str, response: str,
        tokens: int, cost: float,
    ) -> bool:
        """Atomically retain one approved turn, usage, and completion audit per job.

        Only display-approved text belongs here. The job-read capability and raw
        provider response must stay in the protected pending store, never SQLite.
        A false return means this job was already committed. Storage failures use
        fixed messages so database diagnostics cannot expose conversation data.
        """
        _validate_delivery_id(delivery_id)
        if (not isinstance(session_id, str) or not session_id or len(session_id) > 256
                or not isinstance(user, str) or not isinstance(response, str)
                or isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 0
                or isinstance(cost, bool) or not isinstance(cost, (int, float))
                or not math.isfinite(cost) or cost < 0):
            raise RecoveredConversationStorageError("Invalid completed conversation accounting.")
        normalized_user = sanitize_utf8_text(redact_output(
            user, apply_truncation=False, preserve_literal_unicode=True
        ))
        normalized_answer = sanitize_utf8_text(redact_output(
            response, apply_truncation=False, preserve_literal_unicode=True
        ))
        normalized_session = sanitize_utf8_text(redact_output(
            session_id, apply_truncation=False, preserve_literal_unicode=True
        ))
        payload_bytes = sum(len(value.encode("utf-8")) for value in (
            delivery_id, normalized_session, normalized_user, normalized_answer
        )) + 256
        if payload_bytes > RECOVERED_CONVERSATION_BYTES:
            raise RecoveredConversationStorageError("Conversation recovery history is at capacity.")
        now = time.time()
        try:
            with closing(self._conn()) as c, c:
                c.execute("PRAGMA synchronous=FULL")
                c.execute("BEGIN IMMEDIATE")
                if c.execute("SELECT 1 FROM conversation_deliveries WHERE delivery_id=?", (delivery_id,)).fetchone():
                    return False
                # Retained results have a server maximum of seven days. Keep
                # receipts longer, and never evict an answer awaiting display.
                c.execute(
                    "DELETE FROM conversation_deliveries WHERE displayed=1 AND created_at<?",
                    (now - RECOVERED_DEDUP_RETENTION_SECONDS,),
                )
                count, stored_bytes = c.execute(
                    "SELECT COUNT(*), COALESCE(SUM(payload_bytes),0) FROM conversation_deliveries"
                ).fetchone()
                if count >= RECOVERED_CONVERSATION_LIMIT or stored_bytes + payload_bytes > RECOVERED_CONVERSATION_BYTES:
                    raise RecoveredConversationStorageError("Conversation recovery history is at capacity.")
                c.execute(
                    """INSERT INTO conversation_deliveries
                    (delivery_id,session_id,user_text,answer_text,tokens,cost,created_at,payload_bytes)
                    VALUES(?,?,?,?,?,?,?,?)""",
                    (delivery_id, normalized_session, normalized_user, normalized_answer,
                     tokens, float(cost), now, payload_bytes),
                )
                totals_row = c.execute("SELECT value_json FROM kv_state WHERE key=?", (_RECOVERED_TOTALS_KEY,)).fetchone()
                totals = json.loads(totals_row[0]) if totals_row else {"total_requests": 0, "total_tokens": 0, "total_cost": 0.0}
                totals["total_requests"] += 1
                totals["total_tokens"] += tokens
                totals["total_cost"] += cost
                if not math.isfinite(totals["total_cost"]):
                    raise RecoveredConversationStorageError("Invalid completed conversation accounting.")
                c.execute(
                    "INSERT OR REPLACE INTO kv_state(key,value_json,ts_ms) VALUES(?,?,?)",
                    (_RECOVERED_TOTALS_KEY, json.dumps(totals), int(now * 1000)),
                )
                c.execute(
                    "INSERT INTO policy_events(id,session_id,ts_ms,event,detail_json) VALUES(?,?,?,?,?)",
                    ("conversation-delivery:" + delivery_id, normalized_session, int(now * 1000),
                     "conversation.completed" if normalized_answer else "conversation.withheld",
                     json.dumps({"delivery_id": delivery_id, "tokens": tokens, "cost": cost})),
                )
            return True
        except RecoveredConversationStorageError:
            raise
        except (sqlite3.Error, OSError, TypeError, ValueError, KeyError):
            raise RecoveredConversationStorageError("Conversation recovery history could not be saved.") from None

    def get_recovered_conversation(self, delivery_id: str) -> Optional[dict[str, Any]]:
        """Read a committed, sanitized turn and its delivery receipts by job identity."""
        _validate_delivery_id(delivery_id)
        with closing(self._conn()) as c:
            c.row_factory = sqlite3.Row
            row = c.execute(
                """SELECT delivery.*, event.event AS completion_event
                FROM conversation_deliveries AS delivery
                LEFT JOIN policy_events AS event ON event.id='conversation-delivery:' || delivery.delivery_id
                WHERE delivery.delivery_id=?""", (delivery_id,),
            ).fetchone()
        return self._recovered_record(row) if row else None

    @staticmethod
    def _recovered_record(row: sqlite3.Row) -> dict[str, Any]:
        """Expose approved history fields, without database implementation metadata."""
        return {
            "delivery_id": row["delivery_id"], "session_id": row["session_id"],
            "user": row["user_text"], "ai": row["answer_text"],
            "tokens": row["tokens"], "cost": row["cost"], "created_at": row["created_at"],
            "displayed": bool(row["displayed"]), "audit_emitted": bool(row["audit_emitted"]),
            "output_accepted": (
                row["completion_event"] == "conversation.completed"
                if "completion_event" in row.keys() and row["completion_event"] is not None
                else bool(row["answer_text"])
            ),
        }

    def mark_recovered_displayed(self, delivery_id: str) -> None:
        """Acknowledge terminal display after output succeeds, without altering usage."""
        _validate_delivery_id(delivery_id)
        with closing(self._conn()) as c, c:
            c.execute("PRAGMA synchronous=FULL")
            if not c.execute("UPDATE conversation_deliveries SET displayed=1 WHERE delivery_id=?", (delivery_id,)).rowcount:
                raise RecoveredConversationStorageError("Completed conversation receipt is unavailable.")
            self._scrub_cleared_recovered_content(c)

    def claim_recovered_audit(self, delivery_id: str) -> bool:
        """Claim at most one console audit emission; the durable event already exists."""
        _validate_delivery_id(delivery_id)
        with closing(self._conn()) as c, c:
            c.execute("PRAGMA synchronous=FULL")
            return bool(c.execute(
                "UPDATE conversation_deliveries SET audit_emitted=1 WHERE delivery_id=? AND audit_emitted=0",
                (delivery_id,),
            ).rowcount)

    def get_recovered_usage(self) -> list[dict[str, Any]]:
        """Return today's or the last 24 hours' receipts for limiter hydration.

        Local midnight can be over 24 hours ago during a daylight-saving change.
        """
        now = time.time()
        midnight = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        with closing(self._conn()) as c:
            c.row_factory = sqlite3.Row
            return [dict(row) for row in c.execute(
                "SELECT delivery_id,tokens,cost,created_at FROM conversation_deliveries WHERE created_at>=? ORDER BY created_at",
                (min(now - 24 * 60 * 60, midnight),),
            )]

    def get_recent_recovered_conversations(self, limit: int = 100) -> list[dict[str, Any]]:
        """Read the newest visible recovered turns for the ordinary history view."""
        with closing(self._conn()) as c:
            c.row_factory = sqlite3.Row
            rows = c.execute(
                "SELECT * FROM conversation_deliveries WHERE history_visible=1 ORDER BY created_at DESC,delivery_id LIMIT ?",
                (max(0, min(limit, RECOVERED_CONVERSATION_LIMIT)),),
            ).fetchall()
        return [self._recovered_record(row) for row in reversed(rows)]

    def get_recovered_statistics(self) -> dict[str, Any]:
        """Read cumulative totals, which survive safe pruning of old delivery receipts."""
        with closing(self._conn()) as c:
            row = c.execute("SELECT value_json FROM kv_state WHERE key=?", (_RECOVERED_TOTALS_KEY,)).fetchone()
        return json.loads(row[0]) if row else {"total_requests": 0, "total_tokens": 0, "total_cost": 0.0}

    def clear_recovered_history(self) -> None:
        """Clear displayed content; hide undisplayed work until it can be acknowledged."""
        with closing(self._conn()) as c, c:
            c.execute("PRAGMA synchronous=FULL")
            c.execute("UPDATE conversation_deliveries SET history_visible=0")
            self._scrub_cleared_recovered_content(c)

    def reset_recovered_statistics(self) -> None:
        """Reset displayed totals without deleting delivery or limiter deduplication."""
        with closing(self._conn()) as c, c:
            c.execute(
                "INSERT OR REPLACE INTO kv_state(key,value_json,ts_ms) VALUES(?,?,?)",
                (_RECOVERED_TOTALS_KEY, json.dumps({"total_requests": 0, "total_tokens": 0, "total_cost": 0.0}), _now_ms()),
            )

    # -----------------------
    # Messages
    # -----------------------
    def log_message(self, session_id: str, role: str, content: str) -> None:
        normalized_session_id = sanitize_utf8_text(session_id)
        normalized_role = sanitize_utf8_text(role)
        normalized_content = sanitize_utf8_text(redact_output(
            content, apply_truncation=False, preserve_literal_unicode=True
        ))
        with self._conn() as c:
            c.execute(
                "INSERT INTO messages(session_id, ts_ms, role, content) VALUES(?,?,?,?)",
                (normalized_session_id, _now_ms(), normalized_role, normalized_content),
            )

    # -----------------------
    # Commands
    # -----------------------
    def log_command(
        self,
        session_id: str,
        command: str,
        status: str,
        return_code: int,
        stdout: str,
        stderr: str,
    ) -> str:
        cmd_id = str(uuid.uuid4())
        normalized_session_id = sanitize_utf8_text(session_id)
        normalized_command = sanitize_utf8_text(redact_output(command))
        normalized_status = sanitize_utf8_text(status)
        normalized_stdout = sanitize_utf8_text(sanitize_tool_output(stdout))
        normalized_stderr = sanitize_utf8_text(sanitize_tool_output(stderr))
        with self._conn() as c:
            c.execute(
                "INSERT INTO commands(id, session_id, ts_ms, command, status, return_code, stdout, stderr) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    cmd_id,
                    normalized_session_id,
                    _now_ms(),
                    normalized_command,
                    normalized_status,
                    return_code,
                    normalized_stdout,
                    normalized_stderr,
                ),
            )
        return cmd_id

    # -----------------------
    # Patches
    # -----------------------
    def log_patch(
        self,
        session_id: str,
        rollback_id: str,
        status: str,
        summary: str,
        files: list[str],
        backups: dict[str, str],
        patch_text: str,
        patch_sha256: Optional[str] = None,
        error: Optional[str] = None,
    ) -> None:
        raw_patch_text = patch_text or ""
        normalized_patch_text = sanitize_utf8_text(redact_patch_preview(raw_patch_text))
        normalized_summary = sanitize_utf8_text(sanitize_tool_output(summary))
        normalized_error = sanitize_utf8_text(sanitize_tool_output(error)) if isinstance(error, str) else None
        normalized_session_id = sanitize_utf8_text(session_id)
        sanitized_files = _sanitize_json_value(files)
        sanitized_backups = _sanitize_json_value(backups)
        if patch_sha256 is None:
            patch_sha256 = hashlib.sha256(raw_patch_text.encode("utf-8")).hexdigest()
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO patches(rollback_id, session_id, ts_ms, status, summary, files_json, backups_json, patch_text, patch_sha256, error) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    rollback_id,
                    normalized_session_id,
                    _now_ms(),
                    sanitize_utf8_text(status),
                    normalized_summary,
                    json.dumps(sanitized_files),
                    json.dumps(sanitized_backups),
                    normalized_patch_text,
                    patch_sha256,
                    normalized_error,
                ),
            )

    def recent_patches(self, limit: int = 10) -> list[PatchLog]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT rollback_id, ts_ms, status, summary, files_json, backups_json, error FROM patches "
                "ORDER BY ts_ms DESC LIMIT ?",
                (limit,),
            ).fetchall()
        out: list[PatchLog] = []
        for r in rows:
            out.append(
                PatchLog(
                    rollback_id=r[0],
                    ts_ms=int(r[1]),
                    status=r[2],
                    summary=r[3],
                    files=json.loads(r[4] or "[]"),
                    backups=json.loads(r[5] or "{}"),
                    error=r[6],
                )
            )
        return out

    def get_patch(self, rollback_id: str) -> Optional[dict[str, Any]]:
        with self._conn() as c:
            row = c.execute(
                "SELECT rollback_id, files_json, backups_json, patch_sha256, status, session_id FROM patches WHERE rollback_id=?",
                (rollback_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "rollback_id": row[0],
            "files": json.loads(row[1] or "[]"),
            "backups": json.loads(row[2] or "{}"),
            "patch_sha256": row[3] or "",
            "status": row[4],
            "session_id": row[5],
        }

    def update_patch_status(self, rollback_id: str, status: str, error: Optional[str] = None) -> None:
        """Update the outcome without replacing the original recovery record."""
        with self._conn() as c:
            c.execute(
                "UPDATE patches SET status=?, error=? WHERE rollback_id=?",
                (sanitize_utf8_text(status),
                 sanitize_utf8_text(sanitize_tool_output(error)) if isinstance(error, str) else None,
                 rollback_id),
            )

    # -----------------------
    # Snapshots / Policy / State / Feedback
    # -----------------------
    def log_snapshot(
        self,
        session_id: str,
        git_head: str,
        repo_root: str,
        config: dict[str, Any],
        repo_index: dict[str, Any],
    ) -> str:
        snap_id = str(uuid.uuid4())
        sanitized_repo_index = _sanitize_json_value(repo_index)
        sanitized_config = _sanitize_json_value(config)
        repo_index_json = json.dumps(sanitized_repo_index, ensure_ascii=False)
        repo_index_sha = hashlib.sha256(repo_index_json.encode("utf-8")).hexdigest()
        with self._conn() as c:
            c.execute(
                "INSERT INTO snapshots(id, session_id, ts_ms, git_head, repo_root, config_json, repo_index_json, repo_index_sha256) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    snap_id,
                    sanitize_utf8_text(session_id),
                    _now_ms(),
                    sanitize_utf8_text(git_head),
                    sanitize_utf8_text(repo_root),
                    json.dumps(sanitized_config),
                    repo_index_json,
                    repo_index_sha,
                ),
            )
        return snap_id

    def log_policy_event(self, session_id: str, event: str, detail: dict[str, Any]) -> str:
        ev_id = str(uuid.uuid4())
        sanitized_detail = _sanitize_json_value(detail)
        with self._conn() as c:
            c.execute(
                "INSERT INTO policy_events(id, session_id, ts_ms, event, detail_json) VALUES(?,?,?,?,?)",
                (
                    ev_id,
                    sanitize_utf8_text(session_id),
                    _now_ms(),
                    sanitize_utf8_text(event),
                    json.dumps(sanitized_detail),
                ),
            )
        return ev_id

    def set_state(self, key: str, value: Any) -> None:
        sanitized_value = _sanitize_json_value(value)
        with self._conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO kv_state(key, value_json, ts_ms) VALUES(?,?,?)",
                (sanitize_utf8_text(key), json.dumps(sanitized_value), _now_ms()),
            )

    def get_state(self, key: str, default: Any = None, *, strict: bool = False) -> Any:
        with self._conn() as c:
            row = c.execute("SELECT value_json FROM kv_state WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row[0])
        except Exception:
            if strict:
                raise ValueError("Invalid local policy state.") from None
            return default

    def log_feedback(self, session_id: str, target_id: str, rating: int, note: str) -> str:
        fb_id = str(uuid.uuid4())
        with self._conn() as c:
            c.execute(
                "INSERT INTO feedback(id, session_id, ts_ms, target_id, rating, note) VALUES(?,?,?,?,?,?)",
                (
                    fb_id,
                    sanitize_utf8_text(session_id),
                    _now_ms(),
                    sanitize_utf8_text(target_id),
                    rating,
                    sanitize_utf8_text(redact_output(note)),
                ),
            )
        return fb_id

    # -----------------------
    # Audit export
    # -----------------------
    def export_audit(self, out_path: Path, session_id: str | None = None) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            def q(sql: str, params=()):
                return c.execute(sql, params).fetchall()

            if session_id:
                msgs = q("SELECT ts_ms, role, content FROM messages WHERE session_id=? ORDER BY ts_ms", (session_id,))
                patches = q("SELECT rollback_id, ts_ms, status, summary, files_json, backups_json, patch_sha256, error FROM patches WHERE session_id=? ORDER BY ts_ms", (session_id,))
                cmds = q("SELECT ts_ms, command, status, return_code FROM commands WHERE session_id=? ORDER BY ts_ms", (session_id,))
                snaps = q("SELECT id, ts_ms, git_head, repo_root, repo_index_sha256 FROM snapshots WHERE session_id=? ORDER BY ts_ms", (session_id,))
                pol = q("SELECT id, ts_ms, event, detail_json FROM policy_events WHERE session_id=? ORDER BY ts_ms", (session_id,))
                fb = q("SELECT id, ts_ms, target_id, rating, note FROM feedback WHERE session_id=? ORDER BY ts_ms", (session_id,))
            else:
                msgs = q("SELECT session_id, ts_ms, role, content FROM messages ORDER BY ts_ms")
                patches = q("SELECT session_id, rollback_id, ts_ms, status, summary, files_json, backups_json, patch_sha256, error FROM patches ORDER BY ts_ms")
                cmds = q("SELECT session_id, ts_ms, command, status, return_code FROM commands ORDER BY ts_ms")
                snaps = q("SELECT session_id, id, ts_ms, git_head, repo_root, repo_index_sha256 FROM snapshots ORDER BY ts_ms")
                pol = q("SELECT session_id, id, ts_ms, event, detail_json FROM policy_events ORDER BY ts_ms")
                fb = q("SELECT session_id, id, ts_ms, target_id, rating, note FROM feedback ORDER BY ts_ms")

        audit = {
            "sessionId": session_id,
            "messages": msgs,
            "patches": patches,
            "commands": cmds,
            "snapshots": snaps,
            "policyEvents": pol,
            "feedback": fb,
        }
        out_path.write_text(json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8")
