"""Durability and permission tests for the Phase 2E execution journal."""

from __future__ import annotations

import os
import stat
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from arcanos import action_plan_execution_journal as journal_module
from arcanos.action_plan_execution_journal import (
    ActionPlanExecutionJournal,
    ActionPlanExecutionJournalError,
)
from arcanos.action_plan_execution_protocol import ActionPlanExecutionAssignment


def _assignment(**overrides: object) -> ActionPlanExecutionAssignment:
    values: dict[str, object] = {
        "execution_realm": "local:test",
        "command_id": "command-1",
        "plan_id": "plan-1",
        "run_id": "run-1",
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "snapshot_version": "action-execution-snapshot-v1",
        "capability": "terminal.run",
        "action_snapshot": {
            "agent_id": "agent-1",
            "capability": "terminal.run",
            "params": {"command": "echo safe"},
        },
        "lifecycle": {"status": "approved", "expires_at": None},
        "policy": {
            "category": "ALLOW",
            "evidence_id": "clear-evidence-1",
            "evaluated_at": "2026-07-17T12:00:00.000Z",
        },
        "execution_generation": 1,
        "disposition": "CLAIMED",
        "timeout_ms": 1000,
    }
    values.update(overrides)
    return ActionPlanExecutionAssignment(**values)  # type: ignore[arg-type]


@pytest.fixture
def journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> ActionPlanExecutionJournal:
    monkeypatch.setattr(
        "arcanos.action_plan_execution_journal._secure_path",
        lambda *_args, **_kwargs: None,
    )
    return ActionPlanExecutionJournal(
        tmp_path / "private" / "journal.sqlite3",
        expected_realm="local:test",
    )


def test_journal_persists_each_pre_effect_transition(
    journal: ActionPlanExecutionJournal,
) -> None:
    assignment = _assignment()
    journal.save_claim_intent("claim-key")
    assert journal.load_claim_intent() == "claim-key"

    journal.save_assignment(assignment, claim_key="claim-key")
    journal.save_start_intent("run-1", "start-key")
    journal.mark_running_not_started("run-1")
    journal.mark_local_execution_started("run-1")
    journal.save_pending_result(
        "run-1",
        result_key="result-key",
        result={
            "action_id": "action-1",
            "snapshot_id": "snapshot-1",
            "outcome": "failed",
            "error": {"code": "FAILED", "category": "execution"},
        },
    )

    pending = journal.load_run("run-1")
    assert pending is not None
    assert pending.state == "RESULT_PENDING"
    assert pending.result_key == "result-key"
    assert pending.pending_result is not None
    assert pending.pending_result["outcome"] == "failed"
    assert pending.assignment is not None
    assert pending.assignment["lifecycle"]["status"] == "approved"
    assert pending.assignment["policy"]["category"] == "ALLOW"

    journal.mark_accepted("run-1", "receipt-1")
    accepted = journal.load_run("run-1")
    assert accepted is not None
    assert accepted.state == "ACCEPTED"
    assert accepted.acceptance_receipt == "receipt-1"
    assert accepted.assignment is None
    assert accepted.pending_result is None
    assert accepted.claim_key is None
    assert accepted.start_key is None
    assert accepted.result_key is None


def test_journal_rejects_conflicting_replay_evidence(
    journal: ActionPlanExecutionJournal,
) -> None:
    journal.save_claim_intent("claim-key")
    with pytest.raises(ActionPlanExecutionJournalError):
        journal.save_claim_intent("different-claim-key")
    journal.save_assignment(_assignment(), claim_key="claim-key")

    with pytest.raises(ActionPlanExecutionJournalError):
        journal.save_assignment(
            _assignment(action_id="action-other"),
            claim_key="claim-key",
        )

    journal.save_start_intent("run-1", "start-key")
    with pytest.raises(ActionPlanExecutionJournalError):
        journal.save_start_intent("run-1", "different-start-key")


def test_concurrent_claim_intents_cannot_bind_two_local_keys(
    journal: ActionPlanExecutionJournal,
) -> None:
    barrier = threading.Barrier(2)

    def write(key: str) -> str:
        barrier.wait()
        try:
            journal.save_claim_intent(key)
            return "stored"
        except ActionPlanExecutionJournalError:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(write, ("claim-key-a", "claim-key-b")))

    assert sorted(results) == ["conflict", "stored"]
    assert journal.load_claim_intent() in {"claim-key-a", "claim-key-b"}


def test_journal_realm_pin_cannot_be_adopted_from_assignment(
    journal: ActionPlanExecutionJournal,
) -> None:
    with pytest.raises(ActionPlanExecutionJournalError):
        journal.save_assignment(
            _assignment(execution_realm="production"),
            claim_key="claim-key",
        )
    assert journal.load_run("run-1") is None


def test_journal_uses_parameterized_values(journal: ActionPlanExecutionJournal) -> None:
    key = "claim-key-'; DROP TABLE execution_run; --"
    journal.save_claim_intent(key)
    assert journal.load_claim_intent() == key
    journal.clear_claim_intent()
    journal.save_assignment(_assignment(), claim_key="claim-key")
    assert journal.load_run("run-1") is not None


def test_permission_verification_failure_is_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "arcanos.action_plan_execution_journal._secure_path",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            ActionPlanExecutionJournalError("permissions unavailable")
        ),
    )

    with pytest.raises(ActionPlanExecutionJournalError):
        ActionPlanExecutionJournal(
            tmp_path / "private" / "journal.sqlite3",
            expected_realm="local:test",
        )


def test_default_permission_enforcement_creates_private_storage(tmp_path: Path) -> None:
    path = tmp_path / "private" / "journal.sqlite3"
    journal = ActionPlanExecutionJournal(path, expected_realm="local:test")

    assert journal.path.exists()
    if os.name != "nt":
        assert stat.S_IMODE(journal.path.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(journal.path.stat().st_mode) == 0o600


@pytest.mark.parametrize("directory", [False, True])
def test_windows_permissions_use_native_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    directory: bool,
) -> None:
    identity = "EXAMPLE\\runner"
    monkeypatch.setattr(journal_module, "_windows_current_identity", lambda: identity)
    path = tmp_path / ("private" if directory else "journal.sqlite3")
    calls: list[list[str]] = []

    def run(args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        stdout = ""
        if args == ["icacls", str(path)]:
            permissions = "(OI)(CI)(F)" if directory else "(F)"
            stdout = f"{path} {identity}:{permissions}\n"
        return subprocess.CompletedProcess(args, 0, stdout=stdout)

    monkeypatch.setattr(journal_module.subprocess, "run", run)

    journal_module._secure_windows_path(path, directory=directory)

    grant = f"{identity}:(OI)(CI)(F)" if directory else f"{identity}:(F)"
    assert calls == [
        ["icacls", str(path), "/inheritance:r", "/grant:r", grant],
        ["icacls", str(path)],
    ]


def test_windows_permissions_remove_extra_principals(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity = "EXAMPLE\\runner"
    extra_identity = "S-1-5-32-544"
    monkeypatch.setattr(journal_module, "_windows_current_identity", lambda: identity)
    path = tmp_path / "journal.sqlite3"
    calls: list[list[str]] = []
    query_count = 0

    def run(args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal query_count
        calls.append(args)
        stdout = ""
        if args == ["icacls", str(path)]:
            query_count += 1
            stdout = f"{path} {identity}:(F)\n"
            if query_count == 1:
                stdout += f"  {extra_identity}:(F)\n"
        return subprocess.CompletedProcess(args, 0, stdout=stdout)

    monkeypatch.setattr(journal_module.subprocess, "run", run)

    journal_module._secure_windows_path(path, directory=False)

    assert calls == [
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{identity}:(F)"],
        ["icacls", str(path)],
        ["icacls", str(path), "/remove", f"*{extra_identity}"],
        ["icacls", str(path)],
    ]


def test_windows_permissions_reject_extra_principal_that_remains(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity = "EXAMPLE\\runner"
    extra_identity = "BUILTIN\\Administrators"
    monkeypatch.setattr(journal_module, "_windows_current_identity", lambda: identity)
    path = tmp_path / "journal.sqlite3"

    def run(args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        stdout = ""
        if args == ["icacls", str(path)]:
            stdout = f"{path} {identity}:(F)\n" f"  {extra_identity}:(F)\n"
        return subprocess.CompletedProcess(args, 0, stdout=stdout)

    monkeypatch.setattr(journal_module.subprocess, "run", run)

    with pytest.raises(
        ActionPlanExecutionJournalError,
        match="Journal permissions are not private",
    ):
        journal_module._secure_windows_path(path, directory=False)


@pytest.mark.parametrize(
    "acl_lines",
    [
        ["EXAMPLE\\runner:(M)"],
        ["EXAMPLE\\runner:(I)(F)"],
        ["EXAMPLE\\runner:(F)", "EXAMPLE\\runner:(DENY)(F)"],
        [],
    ],
)
def test_windows_permissions_reject_non_private_acl(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    acl_lines: list[str],
) -> None:
    identity = "EXAMPLE\\runner"
    monkeypatch.setattr(journal_module, "_windows_current_identity", lambda: identity)
    path = tmp_path / "journal.sqlite3"

    def run(args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        stdout = ""
        if args == ["icacls", str(path)] and acl_lines:
            stdout = f"{path} {acl_lines[0]}\n"
            stdout += "".join(f"  {line}\n" for line in acl_lines[1:])
        return subprocess.CompletedProcess(args, 0, stdout=stdout)

    monkeypatch.setattr(journal_module.subprocess, "run", run)

    with pytest.raises(
        ActionPlanExecutionJournalError,
        match="Journal permissions are not private",
    ):
        journal_module._secure_windows_path(path, directory=False)


def test_journal_reopen_preserves_pending_result_for_exact_retry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "arcanos.action_plan_execution_journal._secure_path",
        lambda *_args, **_kwargs: None,
    )
    path = tmp_path / "private" / "journal.sqlite3"
    first = ActionPlanExecutionJournal(path, expected_realm="local:test")
    first.save_assignment(_assignment(), claim_key="claim-key")
    first.save_start_intent("run-1", "start-key")
    first.mark_running_not_started("run-1")
    first.mark_local_execution_started("run-1")
    body = {
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "outcome": "succeeded",
        "output": {"command_sha256": "abc"},
    }
    first.save_pending_result("run-1", result_key="result-key", result=body)

    reopened = ActionPlanExecutionJournal(path, expected_realm="local:test")
    pending = reopened.list_recoverable()
    assert len(pending) == 1
    assert pending[0].result_key == "result-key"
    assert pending[0].pending_result == body
