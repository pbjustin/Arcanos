"""Private durable journal for one-at-a-time local-agent execution."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

from ..action_plan_execution_journal import (
    _secure_path as _action_plan_secure_path,
)
from .protocol import LocalAgentJobAssignment, valid_idempotency_key

JOURNAL_SCHEMA_VERSION = 1
MAX_JOURNAL_JSON_BYTES = 64 * 1024


class LocalAgentJournalError(RuntimeError):
    """Raised when local execution evidence cannot be persisted or trusted."""


@dataclass(frozen=True)
class LocalAgentJournalRun:
    job_id: str
    state: str
    expected_device_id: str
    action: str
    workspace: str
    trace_id: str
    request_id: str
    assignment: Optional[dict[str, Any]]
    claim_key: Optional[str]
    result_key: Optional[str]
    pending_result: Optional[dict[str, Any]]
    acceptance_receipt: Optional[str]
    reason_code: Optional[str]


class LocalAgentExecutionJournal:
    """SQLite journal that commits before any local handler side effect."""

    def __init__(self, path: Path, *, expected_device_id: str) -> None:
        if not isinstance(expected_device_id, str) or not expected_device_id.strip():
            raise LocalAgentJournalError("Expected device identity is required")
        self.path = path.resolve()
        self.expected_device_id = expected_device_id.strip()
        self._prepare_storage()
        self._initialize()

    def save_claim_intent(self, claim_key: str) -> None:
        _validate_key(claim_key)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT claim_key FROM claim_intent WHERE singleton_id = 1"
            ).fetchone()
            if row is not None and row[0] != claim_key:
                raise LocalAgentJournalError("Conflicting local claim intent")
            connection.execute(
                "INSERT INTO claim_intent(singleton_id, claim_key) VALUES (1, ?) "
                "ON CONFLICT(singleton_id) DO NOTHING",
                (claim_key,),
            )

    def load_claim_intent(self) -> Optional[str]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT claim_key FROM claim_intent WHERE singleton_id = 1"
            ).fetchone()
        return str(row[0]) if row else None

    def clear_claim_intent(self) -> None:
        with self._transaction() as connection:
            connection.execute("DELETE FROM claim_intent WHERE singleton_id = 1")

    def save_assignment(
        self,
        assignment: LocalAgentJobAssignment,
        *,
        claim_key: str,
    ) -> None:
        _validate_key(claim_key)
        if assignment.device_id != self.expected_device_id:
            raise LocalAgentJournalError("Assignment device identity mismatch")
        assignment_json = _encode_json(_serialize_assignment(assignment))
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT action, workspace, trace_id, request_id, assignment_json, "
                "claim_key FROM local_agent_run WHERE job_id = ?",
                (assignment.job_id,),
            ).fetchone()
            expected = (
                assignment.action,
                assignment.workspace,
                assignment.trace_id,
                assignment.request_id,
                assignment_json,
                claim_key,
            )
            if row is not None and row != expected:
                raise LocalAgentJournalError("Conflicting local assignment evidence")
            connection.execute(
                "INSERT INTO local_agent_run("
                "job_id, state, expected_device_id, action, workspace, trace_id, "
                "request_id, assignment_json, claim_key"
                ") VALUES (?, 'CLAIMED', ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(job_id) DO NOTHING",
                (
                    assignment.job_id,
                    self.expected_device_id,
                    assignment.action,
                    assignment.workspace,
                    assignment.trace_id,
                    assignment.request_id,
                    assignment_json,
                    claim_key,
                ),
            )
            connection.execute("DELETE FROM claim_intent WHERE singleton_id = 1")

    def mark_execution_started(self, job_id: str) -> None:
        self._transition(
            job_id,
            allowed={"CLAIMED"},
            target="EXECUTION_STARTED",
        )

    def save_pending_result(
        self,
        job_id: str,
        *,
        result_key: str,
        result: Mapping[str, Any],
    ) -> None:
        _validate_key(result_key)
        encoded = _encode_json(result)
        self._transition(
            job_id,
            allowed={"CLAIMED", "EXECUTION_STARTED", "RESULT_PENDING"},
            target="RESULT_PENDING",
            updates={
                "result_key": result_key,
                "pending_result_json": encoded,
            },
            immutable={
                "result_key": result_key,
                "pending_result_json": encoded,
            },
        )

    def mark_accepted(self, job_id: str, acceptance_receipt: str) -> None:
        if (
            not isinstance(acceptance_receipt, str)
            or not acceptance_receipt
            or len(acceptance_receipt) > 256
        ):
            raise LocalAgentJournalError("Acceptance receipt is invalid")
        self._transition(
            job_id,
            allowed={"RESULT_PENDING", "ACCEPTED"},
            target="ACCEPTED",
            updates={
                "acceptance_receipt": acceptance_receipt,
                "assignment_json": None,
                "claim_key": None,
                "result_key": None,
                "pending_result_json": None,
                "reason_code": None,
            },
            immutable={"acceptance_receipt": acceptance_receipt},
        )

    def quarantine(self, job_id: str, reason_code: str) -> None:
        if (
            not isinstance(reason_code, str)
            or not reason_code
            or len(reason_code) > 128
        ):
            raise LocalAgentJournalError("Quarantine reason is invalid")
        self._transition(
            job_id,
            allowed={
                "CLAIMED",
                "EXECUTION_STARTED",
                "RESULT_PENDING",
                "QUARANTINED",
            },
            target="QUARANTINED",
            updates={"reason_code": reason_code},
            immutable={"reason_code": reason_code},
        )

    def load_run(self, job_id: str) -> Optional[LocalAgentJournalRun]:
        with self._connection() as connection:
            row = connection.execute(
                _SELECT_RUN + " WHERE job_id = ?",
                (job_id,),
            ).fetchone()
        return _to_run(row) if row else None

    def list_recoverable(self) -> list[LocalAgentJournalRun]:
        with self._connection() as connection:
            rows = connection.execute(
                _SELECT_RUN + " WHERE state NOT IN ('ACCEPTED', 'QUARANTINED') "
                "ORDER BY job_id"
            ).fetchall()
        return [_to_run(row) for row in rows]

    def _prepare_storage(self) -> None:
        directory = self.path.parent
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        _secure_path(directory, directory=True)
        if not self.path.exists():
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            os.close(descriptor)
        _secure_path(self.path, directory=False)

    def _initialize(self) -> None:
        with self._transaction() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS journal_metadata (
                    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                    schema_version INTEGER NOT NULL,
                    expected_device_id TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS claim_intent (
                    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                    claim_key TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS local_agent_run (
                    job_id TEXT PRIMARY KEY,
                    state TEXT NOT NULL CHECK (state IN (
                        'CLAIMED', 'EXECUTION_STARTED', 'RESULT_PENDING',
                        'ACCEPTED', 'QUARANTINED'
                    )),
                    expected_device_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    workspace TEXT NOT NULL,
                    trace_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    assignment_json TEXT,
                    claim_key TEXT,
                    result_key TEXT,
                    pending_result_json TEXT,
                    acceptance_receipt TEXT,
                    reason_code TEXT
                );
                """)
            metadata = connection.execute(
                "SELECT schema_version, expected_device_id FROM journal_metadata "
                "WHERE singleton_id = 1"
            ).fetchone()
            if metadata is None:
                connection.execute(
                    "INSERT INTO journal_metadata("
                    "singleton_id, schema_version, expected_device_id"
                    ") VALUES (1, ?, ?)",
                    (JOURNAL_SCHEMA_VERSION, self.expected_device_id),
                )
            elif metadata != (JOURNAL_SCHEMA_VERSION, self.expected_device_id):
                raise LocalAgentJournalError(
                    "Journal schema or device identity is incompatible"
                )

    def _transition(
        self,
        job_id: str,
        *,
        allowed: set[str],
        target: str,
        updates: Optional[Mapping[str, Any]] = None,
        immutable: Optional[Mapping[str, Any]] = None,
    ) -> None:
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT state, result_key, pending_result_json, "
                "acceptance_receipt, reason_code FROM local_agent_run "
                "WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            if row is None or row[0] not in allowed:
                raise LocalAgentJournalError("Journal transition is invalid")
            current_values = {
                "result_key": row[1],
                "pending_result_json": row[2],
                "acceptance_receipt": row[3],
                "reason_code": row[4],
            }
            for key, value in (immutable or {}).items():
                current = current_values.get(key)
                if current is not None and current != value:
                    raise LocalAgentJournalError(
                        "Conflicting journal transition evidence"
                    )
            update_values = {"state": target, **dict(updates or {})}
            assignments = ", ".join(f"{key} = ?" for key in update_values)
            connection.execute(
                f"UPDATE local_agent_run SET {assignments} WHERE job_id = ?",
                (*update_values.values(), job_id),
            )

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        _secure_path(self.path.parent, directory=True)
        _secure_path(self.path, directory=False)
        connection = sqlite3.connect(str(self.path), timeout=5.0)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = DELETE")
            connection.execute("PRAGMA synchronous = FULL")
            connection.execute("PRAGMA secure_delete = ON")
            yield connection
        finally:
            connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._connection() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise


_SELECT_RUN = (
    "SELECT job_id, state, expected_device_id, action, workspace, trace_id, "
    "request_id, assignment_json, claim_key, result_key, pending_result_json, "
    "acceptance_receipt, reason_code FROM local_agent_run"
)


def _serialize_assignment(assignment: LocalAgentJobAssignment) -> dict[str, Any]:
    result = asdict(assignment)
    result["expires_at"] = assignment.expires_at.isoformat()
    authorization_record = dict(result.pop("authorization_context"))
    authorization_record[
        "evaluated_at"
    ] = assignment.authorization_context.evaluated_at.isoformat()
    result["authorization"] = authorization_record
    result["required_device_scopes"] = list(assignment.required_device_scopes)
    return result


def _to_run(row: tuple[Any, ...]) -> LocalAgentJournalRun:
    return LocalAgentJournalRun(
        job_id=row[0],
        state=row[1],
        expected_device_id=row[2],
        action=row[3],
        workspace=row[4],
        trace_id=row[5],
        request_id=row[6],
        assignment=json.loads(row[7]) if row[7] else None,
        claim_key=row[8],
        result_key=row[9],
        pending_result=json.loads(row[10]) if row[10] else None,
        acceptance_receipt=row[11],
        reason_code=row[12],
    )


def _encode_json(value: Any) -> str:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise LocalAgentJournalError("Journal value is invalid") from exc
    if len(encoded.encode("utf-8")) > MAX_JOURNAL_JSON_BYTES:
        raise LocalAgentJournalError("Journal value is too large")
    return encoded


def _validate_key(value: Any) -> None:
    if not valid_idempotency_key(value):
        raise LocalAgentJournalError("Idempotency key is invalid")


def _secure_path(path: Path, *, directory: bool) -> None:
    try:
        _action_plan_secure_path(path, directory=directory)
    except Exception as exc:
        raise LocalAgentJournalError(
            "Local-agent journal permissions cannot be verified"
        ) from exc


__all__ = [
    "LocalAgentExecutionJournal",
    "LocalAgentJournalError",
    "LocalAgentJournalRun",
]
