
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from ..config import Config
from ..utils.text import sanitize_utf8_text


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sanitize_json_value(value: Any) -> Any:
    """
    Purpose: Recursively sanitize JSON-like values before serialization/storage.
    Inputs/Outputs: arbitrary value -> UTF-8-safe value with preserved shape.
    Edge cases: Non-container values pass through unchanged.
    """
    if isinstance(value, str):
        return sanitize_utf8_text(value)
    if isinstance(value, list):
        return [_sanitize_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(_sanitize_json_value(key)): _sanitize_json_value(item) for key, item in value.items()}
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

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self.path = db_path or Config.HISTORY_DB_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path))
        conn.execute("PRAGMA journal_mode=WAL;")
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

    # -----------------------
    # Messages
    # -----------------------
    def log_message(self, session_id: str, role: str, content: str) -> None:
        normalized_session_id = sanitize_utf8_text(session_id)
        normalized_role = sanitize_utf8_text(role)
        normalized_content = sanitize_utf8_text(content)
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
        normalized_command = sanitize_utf8_text(command)
        normalized_status = sanitize_utf8_text(status)
        normalized_stdout = sanitize_utf8_text(stdout)
        normalized_stderr = sanitize_utf8_text(stderr)
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
        normalized_patch_text = sanitize_utf8_text(patch_text or "")
        normalized_summary = sanitize_utf8_text(summary)
        normalized_error = sanitize_utf8_text(error) if isinstance(error, str) else None
        normalized_session_id = sanitize_utf8_text(session_id)
        sanitized_files = _sanitize_json_value(files)
        sanitized_backups = _sanitize_json_value(backups)
        if patch_sha256 is None:
            patch_sha256 = hashlib.sha256(normalized_patch_text.encode("utf-8")).hexdigest()
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
                "SELECT rollback_id, files_json, backups_json, patch_text FROM patches WHERE rollback_id=?",
                (rollback_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "rollback_id": row[0],
            "files": json.loads(row[1] or "[]"),
            "backups": json.loads(row[2] or "{}"),
            "patch_text": row[3] or "",
        }

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

    def get_state(self, key: str, default: Any = None) -> Any:
        with self._conn() as c:
            row = c.execute("SELECT value_json FROM kv_state WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row[0])
        except Exception:
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
                    sanitize_utf8_text(note),
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
