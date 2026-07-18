"""Fail-closed local journal for one-instance ActionPlan execution recovery."""

from __future__ import annotations

import getpass
import json
import os
import sqlite3
import stat
import subprocess
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

from .action_plan_execution_protocol import ActionPlanExecutionAssignment

JOURNAL_SCHEMA_VERSION = 1
MAX_JOURNAL_JSON_BYTES = 64 * 1024


class ActionPlanExecutionJournalError(RuntimeError):
    """Raised when durable local execution evidence cannot be trusted."""


@dataclass(frozen=True)
class JournalRun:
    run_id: str
    state: str
    expected_realm: str
    command_id: str
    plan_id: str
    action_id: str
    snapshot_id: str
    assignment: Optional[dict[str, Any]]
    claim_key: Optional[str]
    start_key: Optional[str]
    result_key: Optional[str]
    pending_result: Optional[dict[str, Any]]
    acceptance_receipt: Optional[str]
    reason_code: Optional[str]


class ActionPlanExecutionJournal:
    """SQLite journal whose transitions commit before protected side effects."""

    def __init__(self, path: Path, *, expected_realm: str) -> None:
        if not isinstance(expected_realm, str) or not expected_realm.strip():
            raise ActionPlanExecutionJournalError(
                "Expected execution realm is required"
            )
        self.path = path.resolve()
        self.expected_realm = expected_realm.strip()
        self._prepare_storage()
        self._initialize()

    def save_claim_intent(self, idempotency_key: str) -> None:
        _validate_key(idempotency_key)
        with self._transaction() as connection:
            existing = connection.execute(
                "SELECT idempotency_key FROM claim_intent WHERE singleton_id = 1"
            ).fetchone()
            if existing is not None and existing[0] != idempotency_key:
                raise ActionPlanExecutionJournalError("Conflicting local claim intent")
            connection.execute(
                "INSERT INTO claim_intent(singleton_id, idempotency_key) VALUES (1, ?) "
                "ON CONFLICT(singleton_id) DO NOTHING",
                (idempotency_key,),
            )

    def load_claim_intent(self) -> Optional[str]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT idempotency_key FROM claim_intent WHERE singleton_id = 1"
            ).fetchone()
        return str(row[0]) if row else None

    def clear_claim_intent(self) -> None:
        with self._transaction() as connection:
            connection.execute("DELETE FROM claim_intent WHERE singleton_id = 1")

    def save_assignment(
        self,
        assignment: ActionPlanExecutionAssignment,
        *,
        claim_key: str,
    ) -> None:
        _validate_key(claim_key)
        if assignment.execution_realm != self.expected_realm:
            raise ActionPlanExecutionJournalError("Execution realm mismatch")
        assignment_json = _encode_json(asdict(assignment))
        with self._transaction() as connection:
            existing = connection.execute(
                "SELECT plan_id, action_id, snapshot_id, assignment_json, claim_key "
                "FROM execution_run WHERE run_id = ?",
                (assignment.run_id,),
            ).fetchone()
            if existing and existing != (
                assignment.plan_id,
                assignment.action_id,
                assignment.snapshot_id,
                assignment_json,
                claim_key,
            ):
                raise ActionPlanExecutionJournalError(
                    "Conflicting local assignment evidence"
                )
            connection.execute(
                "INSERT INTO execution_run("
                "run_id, state, expected_realm, command_id, plan_id, action_id, "
                "snapshot_id, assignment_json, claim_key"
                ") VALUES (?, 'CLAIMED', ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(run_id) DO NOTHING",
                (
                    assignment.run_id,
                    self.expected_realm,
                    assignment.command_id,
                    assignment.plan_id,
                    assignment.action_id,
                    assignment.snapshot_id,
                    assignment_json,
                    claim_key,
                ),
            )
            connection.execute("DELETE FROM claim_intent WHERE singleton_id = 1")

    def save_start_intent(self, run_id: str, start_key: str) -> None:
        _validate_key(start_key)
        self._transition(
            run_id,
            allowed={"CLAIMED", "START_INTENT"},
            target="START_INTENT",
            updates={"start_key": start_key},
            immutable={"start_key": start_key},
        )

    def mark_running_not_started(self, run_id: str) -> None:
        self._transition(
            run_id,
            allowed={"START_INTENT", "RUNNING_LOCAL_NOT_STARTED"},
            target="RUNNING_LOCAL_NOT_STARTED",
        )

    def mark_local_execution_started(self, run_id: str) -> None:
        self._transition(
            run_id,
            allowed={"RUNNING_LOCAL_NOT_STARTED"},
            target="LOCAL_EXECUTION_STARTED",
        )

    def save_pending_result(
        self,
        run_id: str,
        *,
        result_key: str,
        result: Mapping[str, Any],
    ) -> None:
        _validate_key(result_key)
        result_json = _encode_json(result)
        self._transition(
            run_id,
            allowed={"LOCAL_EXECUTION_STARTED", "RESULT_PENDING"},
            target="RESULT_PENDING",
            updates={"result_key": result_key, "pending_result_json": result_json},
            immutable={"result_key": result_key, "pending_result_json": result_json},
        )

    def mark_accepted(self, run_id: str, acceptance_receipt: str) -> None:
        if (
            not isinstance(acceptance_receipt, str)
            or not acceptance_receipt
            or len(acceptance_receipt) > 256
        ):
            raise ActionPlanExecutionJournalError("Acceptance receipt is invalid")
        self._transition(
            run_id,
            allowed={"RESULT_PENDING", "ACCEPTED"},
            target="ACCEPTED",
            updates={
                "acceptance_receipt": acceptance_receipt,
                "assignment_json": None,
                "claim_key": None,
                "start_key": None,
                "result_key": None,
                "pending_result_json": None,
                "reason_code": None,
            },
            immutable={"acceptance_receipt": acceptance_receipt},
        )

    def quarantine(self, run_id: str, reason_code: str) -> None:
        if (
            not isinstance(reason_code, str)
            or not reason_code
            or len(reason_code) > 128
        ):
            raise ActionPlanExecutionJournalError("Quarantine reason is invalid")
        self._transition(
            run_id,
            allowed={
                "CLAIMED",
                "START_INTENT",
                "RUNNING_LOCAL_NOT_STARTED",
                "LOCAL_EXECUTION_STARTED",
                "RESULT_PENDING",
                "QUARANTINED",
            },
            target="QUARANTINED",
            updates={"reason_code": reason_code},
            immutable={"reason_code": reason_code},
        )

    def load_run(self, run_id: str) -> Optional[JournalRun]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT run_id, state, expected_realm, command_id, plan_id, action_id, "
                "snapshot_id, assignment_json, claim_key, start_key, result_key, "
                "pending_result_json, acceptance_receipt, reason_code "
                "FROM execution_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        return _to_journal_run(row) if row else None

    def list_recoverable(self) -> list[JournalRun]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT run_id, state, expected_realm, command_id, plan_id, action_id, "
                "snapshot_id, assignment_json, claim_key, start_key, result_key, "
                "pending_result_json, acceptance_receipt, reason_code "
                "FROM execution_run WHERE state NOT IN ('ACCEPTED', 'QUARANTINED') "
                "ORDER BY run_id"
            ).fetchall()
        return [_to_journal_run(row) for row in rows]

    def _prepare_storage(self) -> None:
        journal_dir = self.path.parent
        journal_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        _secure_path(journal_dir, directory=True)
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
                    expected_realm TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS claim_intent (
                    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                    idempotency_key TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS execution_run (
                    run_id TEXT PRIMARY KEY,
                    state TEXT NOT NULL CHECK (state IN (
                        'CLAIMED', 'START_INTENT', 'RUNNING_LOCAL_NOT_STARTED',
                        'LOCAL_EXECUTION_STARTED', 'RESULT_PENDING', 'ACCEPTED',
                        'QUARANTINED'
                    )),
                    expected_realm TEXT NOT NULL,
                    command_id TEXT NOT NULL,
                    plan_id TEXT NOT NULL,
                    action_id TEXT NOT NULL,
                    snapshot_id TEXT NOT NULL,
                    assignment_json TEXT,
                    claim_key TEXT,
                    start_key TEXT,
                    result_key TEXT,
                    pending_result_json TEXT,
                    acceptance_receipt TEXT,
                    reason_code TEXT
                );
                """)
            metadata = connection.execute(
                "SELECT schema_version, expected_realm FROM journal_metadata "
                "WHERE singleton_id = 1"
            ).fetchone()
            if metadata is None:
                connection.execute(
                    "INSERT INTO journal_metadata("
                    "singleton_id, schema_version, expected_realm"
                    ") "
                    "VALUES (1, ?, ?)",
                    (JOURNAL_SCHEMA_VERSION, self.expected_realm),
                )
            elif metadata != (JOURNAL_SCHEMA_VERSION, self.expected_realm):
                raise ActionPlanExecutionJournalError(
                    "Journal schema or execution realm is incompatible"
                )

    def _transition(
        self,
        run_id: str,
        *,
        allowed: set[str],
        target: str,
        updates: Optional[Mapping[str, Any]] = None,
        immutable: Optional[Mapping[str, Any]] = None,
    ) -> None:
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT state, start_key, result_key, pending_result_json, "
                "acceptance_receipt, reason_code FROM execution_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None or row[0] not in allowed:
                raise ActionPlanExecutionJournalError("Journal transition is invalid")
            columns = {
                "start_key": row[1],
                "result_key": row[2],
                "pending_result_json": row[3],
                "acceptance_receipt": row[4],
                "reason_code": row[5],
            }
            for key, value in (immutable or {}).items():
                current = columns.get(key)
                if current is not None and current != value:
                    raise ActionPlanExecutionJournalError(
                        "Conflicting journal transition evidence"
                    )
            update_values = {"state": target, **dict(updates or {})}
            assignments = ", ".join(f"{key} = ?" for key in update_values)
            connection.execute(
                f"UPDATE execution_run SET {assignments} WHERE run_id = ?",
                (*update_values.values(), run_id),
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


def _to_journal_run(row: tuple[Any, ...]) -> JournalRun:
    return JournalRun(
        run_id=row[0],
        state=row[1],
        expected_realm=row[2],
        command_id=row[3],
        plan_id=row[4],
        action_id=row[5],
        snapshot_id=row[6],
        assignment=json.loads(row[7]) if row[7] else None,
        claim_key=row[8],
        start_key=row[9],
        result_key=row[10],
        pending_result=json.loads(row[11]) if row[11] else None,
        acceptance_receipt=row[12],
        reason_code=row[13],
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
        raise ActionPlanExecutionJournalError("Journal value is invalid") from exc
    if len(encoded.encode("utf-8")) > MAX_JOURNAL_JSON_BYTES:
        raise ActionPlanExecutionJournalError("Journal value is too large")
    return encoded


def _validate_key(value: Any) -> None:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > 256
        or any(ord(character) < 0x20 or ord(character) > 0x7E for character in value)
    ):
        raise ActionPlanExecutionJournalError("Idempotency key is invalid")


def _secure_path(path: Path, *, directory: bool) -> None:
    if os.name == "nt":
        _secure_windows_path(path, directory=directory)
        return
    mode = 0o700 if directory else 0o600
    try:
        os.chmod(path, mode)
        details = path.stat()
    except OSError as exc:
        raise ActionPlanExecutionJournalError(
            "Journal permissions cannot be verified"
        ) from exc
    getuid = getattr(os, "getuid", None)
    if (
        not callable(getuid)
        or details.st_uid != getuid()
        or stat.S_IMODE(details.st_mode) != mode
    ):
        raise ActionPlanExecutionJournalError("Journal permissions are not private")


def _secure_windows_path(path: Path, *, directory: bool) -> None:
    """Replace inherited ACLs and verify that only the current account is listed."""
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        identity_result = subprocess.run(
            ["whoami"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=creation_flags,
        )
        identity = identity_result.stdout.strip()
        if not identity:
            identity = getpass.getuser()
        grant = f"{identity}:(OI)(CI)(F)" if directory else f"{identity}:(F)"
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", grant],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=creation_flags,
        )
        acl_result = subprocess.run(
            ["icacls", str(path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=creation_flags,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ActionPlanExecutionJournalError(
            "Journal permissions cannot be verified"
        ) from exc

    principals: list[str] = []
    for line in acl_result.stdout.splitlines():
        normalized = line.strip()
        if not normalized or ":(" not in normalized:
            continue
        if normalized.lower().startswith(str(path).lower()):
            normalized = normalized[len(str(path)) :].strip()
        principal = normalized.split(":(", 1)[0].strip()
        if principal:
            principals.append(principal.lower())
    if not principals or any(principal != identity.lower() for principal in principals):
        raise ActionPlanExecutionJournalError("Journal permissions are not private")


__all__ = [
    "ActionPlanExecutionJournal",
    "ActionPlanExecutionJournalError",
    "JournalRun",
]
