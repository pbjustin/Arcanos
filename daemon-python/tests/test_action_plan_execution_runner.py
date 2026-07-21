"""End-to-end decision tests for one Phase 2E Python execution cycle."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from arcanos.action_plan_execution_journal import ActionPlanExecutionJournal
from arcanos.action_plan_execution_protocol import ActionPlanExecutionAssignment
from arcanos.action_plan_execution_runner import (
    ActionPlanExecutionRunner,
    _execute_cli_command,
    action_plan_execution_loop,
)
from arcanos.action_plan_handler import handle_action_plan
from arcanos.backend_client_models import BackendRequestError, BackendResponse
from arcanos.cli import daemon_ops
from arcanos.cli import run_ops
from arcanos import cli_daemon as legacy_daemon_ops
from arcanos.cli_types import DaemonCommand


def _capability(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "ok": True,
        "code": "ACTION_PLAN_EXECUTION_PROTOCOL_AVAILABLE",
        "protocol_version": "action-plan-execution-v1",
        "execution_realm": "local:test",
        "role": "executor",
        "operations": [
            "claim-next",
            "claim",
            "start",
            "submit-result",
            "read-status",
            "read-result",
        ],
        "executor_principal_id": "executor-principal",
        "executor_instance_id": "executor-instance",
        "assigned_agent_id": "agent-1",
    }
    payload.update(overrides)
    return payload


def _claim(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "ok": True,
        "code": "ACTION_PLAN_EXECUTION_CLAIMED",
        "protocol_version": "action-plan-execution-v1",
        "execution_realm": "local:test",
        "command_id": "command-1",
        "plan_id": "plan-1",
        "run_id": "run-1",
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "snapshot_version": "action-execution-snapshot-v1",
        "plan_execution_generation": 1,
        "lifecycle": {"status": "approved", "expires_at": None},
        "policy": {
            "category": "ALLOW",
            "evidence_id": "clear-evidence-1",
            "evaluated_at": "2026-07-17T12:00:00.000Z",
        },
        "state": "CLAIMED",
        "disposition": "CLAIMED",
        "assignment": {
            "agent_id": "agent-1",
            "capability": "terminal.run",
            "params": {"command": "echo assigned"},
            "timeout_ms": 1000,
        },
    }
    payload.update(overrides)
    return payload


def _start() -> dict[str, object]:
    return {
        "ok": True,
        "code": "ACTION_PLAN_EXECUTION_STARTED",
        "protocol_version": "action-plan-execution-v1",
        "execution_realm": "local:test",
        "run_id": "run-1",
        "plan_id": "plan-1",
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "state": "RUNNING",
        "disposition": "STARTED",
    }


def _accepted(state: str = "SUCCEEDED") -> dict[str, object]:
    return {
        "ok": True,
        "code": "ACTION_PLAN_EXECUTION_RESULT_ACCEPTED",
        "protocol_version": "action-plan-execution-v1",
        "execution_realm": "local:test",
        "run_id": "run-1",
        "plan_id": "plan-1",
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "state": state,
        "terminal_category": state.lower(),
        "disposition": "RESULT_ACCEPTED",
        "acceptance_receipt": "receipt-1",
    }


def _status(
    state: str,
    *,
    receipt: str | None = None,
) -> dict[str, object]:
    return {
        "ok": True,
        "code": "ACTION_PLAN_EXECUTION_STATUS",
        "protocol_version": "action-plan-execution-v1",
        "execution_realm": "local:test",
        "plan_id": "plan-1",
        "run_id": "run-1",
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "state": state,
        "terminal_category": (
            state.lower() if state in {"SUCCEEDED", "FAILED"} else None
        ),
        "disposition": "STATUS_CURRENT",
        "acceptance_receipt": receipt,
    }


def _result_read(
    outcome: str = "succeeded",
    *,
    error: dict[str, str] | None = None,
) -> dict[str, object]:
    state = "SUCCEEDED" if outcome == "succeeded" else "FAILED"
    payload: dict[str, object] = {
        "ok": True,
        "code": "ACTION_PLAN_EXECUTION_RESULT",
        "protocol_version": "action-plan-execution-v1",
        "execution_realm": "local:test",
        "plan_id": "plan-1",
        "run_id": "run-1",
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "state": state,
        "terminal_category": outcome,
        "outcome": outcome,
        "acceptance_receipt": "receipt-status-1",
    }
    if error is not None:
        payload["error"] = error
    return payload


def _assignment_model() -> ActionPlanExecutionAssignment:
    return ActionPlanExecutionAssignment(
        execution_realm="local:test",
        command_id="command-1",
        plan_id="plan-1",
        run_id="run-1",
        action_id="action-1",
        snapshot_id="snapshot-1",
        snapshot_version="action-execution-snapshot-v1",
        capability="terminal.run",
        action_snapshot={
            "agent_id": "agent-1",
            "capability": "terminal.run",
            "params": {"command": "echo assigned"},
            "timeout_ms": 1000,
        },
        lifecycle={"status": "approved", "expires_at": None},
        policy={
            "category": "ALLOW",
            "evidence_id": "clear-evidence-1",
            "evaluated_at": "2026-07-17T12:00:00.000Z",
        },
        execution_generation=1,
        disposition="CLAIMED",
        timeout_ms=1000,
    )


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


def _runner(
    journal: ActionPlanExecutionJournal,
    client: MagicMock,
    *,
    run_handler: MagicMock | None = None,
    keys: tuple[str, ...] = ("claim-key", "start-key", "result-key"),
) -> tuple[ActionPlanExecutionRunner, MagicMock, MagicMock]:
    console = MagicMock()
    handler = run_handler or MagicMock(return_value={"ok": True, "return_code": 0})
    key_iter = iter(keys)
    runner = ActionPlanExecutionRunner(
        client=client,
        journal=journal,
        expected_realm="local:test",
        executor_principal_id="executor-principal",
        executor_instance_id="executor-instance",
        assigned_agent_id="agent-1",
        console=console,
        run_handler=handler,
        confirm_prompt=MagicMock(return_value=True),
        key_factory=lambda: next(key_iter),
    )
    return runner, console, handler


def _successful_client(*, terminal_state: str = "SUCCEEDED") -> MagicMock:
    client = MagicMock()
    client.get_capability.return_value = BackendResponse(ok=True, value=_capability())
    client.claim_next.return_value = BackendResponse(ok=True, value=_claim())
    client.start.return_value = BackendResponse(ok=True, value=_start())
    client.submit_result.return_value = BackendResponse(
        ok=True,
        value=_accepted(terminal_state),
    )
    return client


def test_success_executes_exactly_one_assignment_and_waits_for_acceptance(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    runner, console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    handler.assert_called_once_with("echo assigned", 1000, "run-1")
    client.start.assert_called_once_with("plan-1", "run-1", "start-key")
    client.submit_result.assert_called_once()
    submitted = client.submit_result.call_args.args[2]
    assert submitted["outcome"] == "succeeded"
    assert submitted["action_id"] == "action-1"
    assert submitted["snapshot_id"] == "snapshot-1"
    assert client.submit_result.call_args.args[3] == "result-key"
    assert "/execute" not in repr(client.method_calls)
    assert "accepted" in repr(console.print.call_args_list).lower()
    stored = journal.load_run("run-1")
    assert stored is not None and stored.state == "ACCEPTED"


def test_wrong_claim_response_code_stops_before_start_or_execution(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    client.claim_next.return_value = BackendResponse(
        ok=True,
        value=_claim(code="ACTION_PLAN_EXECUTION_STATUS"),
    )
    runner, console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "PROTOCOL_INCOMPATIBLE"
    client.start.assert_not_called()
    handler.assert_not_called()
    client.submit_result.assert_not_called()
    assert "accepted" not in repr(console.print.call_args_list).lower()


def test_wrong_start_response_code_stops_before_local_execution(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    start = _start()
    start["code"] = "ACTION_PLAN_EXECUTION_STATUS"
    client.start.return_value = BackendResponse(ok=True, value=start)
    runner, console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "RECOVERY_REQUIRED"
    handler.assert_not_called()
    client.submit_result.assert_not_called()
    assert "accepted" not in repr(console.print.call_args_list).lower()


def test_wrong_result_response_code_never_acknowledges_durable_acceptance(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    accepted = _accepted()
    accepted["code"] = "ACTION_PLAN_EXECUTION_STATUS"
    client.submit_result.return_value = BackendResponse(ok=True, value=accepted)
    client.get_result.return_value = BackendResponse(
        ok=False,
        error=BackendRequestError(kind="network", message="request failed"),
    )
    runner, console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "RECOVERY_REQUIRED"
    handler.assert_called_once_with("echo assigned", 1000, "run-1")
    stored = journal.load_run("run-1")
    assert stored is not None and stored.state == "RESULT_PENDING"
    assert "accepted" not in repr(console.print.call_args_list).lower()


def test_authorized_command_whitespace_is_preserved_byte_for_byte(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    claim = _claim()
    claim["assignment"] = {
        "agent_id": "agent-1",
        "capability": "terminal.run",
        "params": {"command": "  echo assigned  "},
        "timeout_ms": 1000,
    }
    client.claim_next.return_value = BackendResponse(ok=True, value=claim)
    runner, _console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    handler.assert_called_once_with("  echo assigned  ", 1000, "run-1")


def test_failed_local_action_remains_failed_and_contains_no_raw_exception(
    journal: ActionPlanExecutionJournal,
) -> None:
    sentinel = "SECRET /private/path SELECT password"
    client = _successful_client(terminal_state="FAILED")
    handler = MagicMock(side_effect=RuntimeError(sentinel))
    runner, console, _ = _runner(journal, client, run_handler=handler)

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    submitted = client.submit_result.call_args.args[2]
    assert submitted["outcome"] == "failed"
    assert submitted["error"] == {
        "code": "ACTION_EXECUTION_FAILED",
        "category": "execution",
    }
    assert sentinel not in repr(client.method_calls)
    assert sentinel not in repr(console.method_calls)


def test_nonzero_local_exit_is_submitted_as_failure_without_output_payload(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client(terminal_state="FAILED")
    handler = MagicMock(
        return_value={
            "ok": True,
            "return_code": 7,
            "stdout": "sensitive stdout",
            "stderr": "sensitive stderr",
        }
    )
    runner, _console, _ = _runner(journal, client, run_handler=handler)

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    submitted = client.submit_result.call_args.args[2]
    assert submitted == {
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
        "outcome": "failed",
        "error": {
            "code": "ACTION_EXECUTION_FAILED",
            "category": "nonzero_or_unconfirmed",
        },
    }
    assert "sensitive stdout" not in repr(client.method_calls)
    assert "sensitive stderr" not in repr(client.method_calls)


def test_cli_execution_seam_passes_only_opaque_run_identity() -> None:
    command = "echo credential-sentinel"
    cli = MagicMock()
    with patch.object(
        run_ops,
        "handle_action_plan_run",
        return_value={"ok": True, "return_code": 0},
    ) as action_plan_run:
        result = _execute_cli_command(cli, command, 1500, "run-1")

    assert result == {"ok": True, "return_code": 0}
    action_plan_run.assert_called_once_with(
        cli,
        command,
        execution_identity="run-1",
        timeout_seconds=2,
    )


def test_run_operation_uses_sanitized_phase2e_activity_and_audit_payload() -> None:
    command = "echo credential-sentinel"
    cli = MagicMock()
    cli._idempotency_guard.check_and_record.return_value = True
    cli._trust_state = SimpleNamespace(name="trusted")
    safe_payload = {
        "source": "action-plan-execution-v1",
        "run_id": "run-1",
    }
    with (
        patch.object(run_ops.state, "recompute_trust_state"),
        patch.object(
            run_ops,
            "governed_execute",
            return_value=(None, None, 0),
        ) as governed,
        patch.object(run_ops, "audit_record"),
    ):
        result = run_ops.handle_action_plan_run(
            cli,
            command,
            execution_identity="run-1",
            timeout_seconds=2,
        )

    assert result == {
        "ok": True,
        "return_code": 0,
    }
    assert command not in repr(cli._append_activity.call_args)
    assert governed.call_args.kwargs["payload"] == safe_payload
    assert command not in repr(governed.call_args.kwargs["payload"])


def test_real_phase2e_run_seam_never_logs_raw_dependency_failure() -> None:
    sentinel = "CREDENTIAL_SENTINEL /private/action-plan.sql SELECT secret"
    cli = MagicMock()
    cli._idempotency_guard.check_and_record.return_value = True
    cli._trust_state = SimpleNamespace(name="trusted")
    cli.terminal.execute_action_plan_command.side_effect = OSError(sentinel)
    audit_calls: list[object] = []

    def capture_audit(*args: object, **kwargs: object) -> None:
        audit_calls.append((args, kwargs))

    with (
        patch.object(run_ops.state, "recompute_trust_state"),
        patch.object(run_ops, "audit_record", side_effect=capture_audit),
        patch.object(
            run_ops,
            "governed_execute",
            side_effect=lambda _name, callback, **_kwargs: callback(),
        ),
    ):
        result = run_ops.handle_action_plan_run(
            cli,
            "echo credential-sentinel",
            execution_identity="run-1",
            timeout_seconds=2,
        )

    assert result == {
        "ok": False,
        "return_code": None,
        "error_category": "execution",
    }
    observed = repr((result, audit_calls, cli._append_activity.call_args_list))
    assert sentinel not in observed
    assert "/private/" not in observed
    assert "SELECT secret" not in observed


def test_backend_rejection_never_prints_completion_or_marks_accepted(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    client.submit_result.return_value = BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="ACTION_PLAN_RESULT_IDEMPOTENCY_CONFLICT",
            message="Result rejected",
            status_code=409,
        ),
    )
    runner, console, _ = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "QUARANTINED_REJECTION"
    assert "accepted" not in repr(console.print.call_args_list).lower()
    stored = journal.load_run("run-1")
    assert stored is not None and stored.state == "QUARANTINED"


def test_response_loss_retries_same_result_body_and_key_without_reexecution(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    replay = _accepted()
    replay["disposition"] = "RESULT_REPLAY"
    client.submit_result.side_effect = [
        BackendResponse(
            ok=False,
            error=BackendRequestError(kind="network", message="request failed"),
        ),
        BackendResponse(ok=True, value=replay),
    ]
    runner, console, handler = _runner(journal, client)

    first = runner.run_once()
    second = runner.run_once()

    assert first.disposition == "RETRY_RESULT"
    assert second.disposition == "CONFIRMED_REPLAY"
    handler.assert_called_once_with("echo assigned", 1000, "run-1")
    first_call, second_call = client.submit_result.call_args_list
    assert first_call.args[2] == second_call.args[2]
    assert first_call.args[3] == second_call.args[3] == "result-key"
    assert len(console.print.call_args_list) == 1


def test_drain_only_capability_recovers_pending_result_without_claiming_new_work(
    journal: ActionPlanExecutionJournal,
) -> None:
    assignment = _assignment_model()
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
            "outcome": "succeeded",
        },
    )
    client = _successful_client()
    client.get_capability.return_value = BackendResponse(
        ok=True,
        value=_capability(
            operations=["start", "submit-result", "read-status", "read-result"]
        ),
    )
    runner, _console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    client.submit_result.assert_called_once()
    client.claim_next.assert_not_called()
    handler.assert_not_called()


def test_drain_only_capability_recovers_start_intent_and_submits_real_result(
    journal: ActionPlanExecutionJournal,
) -> None:
    assignment = _assignment_model()
    journal.save_assignment(assignment, claim_key="claim-key")
    journal.save_start_intent("run-1", "start-key")
    client = _successful_client()
    client.get_capability.return_value = BackendResponse(
        ok=True,
        value=_capability(
            operations=["start", "submit-result", "read-status", "read-result"]
        ),
    )
    runner, _console, handler = _runner(
        journal,
        client,
        keys=("result-key",),
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    client.start.assert_called_once_with("plan-1", "run-1", "start-key")
    handler.assert_called_once_with("echo assigned", 1000, "run-1")
    client.claim_next.assert_not_called()


def test_drain_only_capability_does_not_claim_when_no_recovery_exists(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    client.get_capability.return_value = BackendResponse(
        ok=True,
        value=_capability(
            operations=["start", "submit-result", "read-status", "read-result"]
        ),
    )
    runner, _console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "DRAIN_ONLY"
    client.claim_next.assert_not_called()
    handler.assert_not_called()


def test_backend_persistence_failure_remains_retryable(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    client.submit_result.return_value = BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED",
            message="ActionPlan execution request was rejected",
            status_code=409,
        ),
    )
    runner, console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "RETRY_RESULT"
    handler.assert_called_once_with("echo assigned", 1000, "run-1")
    stored = journal.load_run("run-1")
    assert stored is not None and stored.state == "RESULT_PENDING"
    assert "accepted" not in repr(console.print.call_args_list).lower()


def test_lost_acceptance_response_is_confirmed_by_exact_bound_result_evidence(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    client.submit_result.return_value = BackendResponse(
        ok=True,
        value={
            "ok": True,
            "code": "ACTION_PLAN_EXECUTION_RESULT_ACCEPTED",
            "protocol_version": "action-plan-execution-v1",
        },
    )
    client.get_result.return_value = BackendResponse(
        ok=True,
        value=_result_read(),
    )
    runner, console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "CONFIRMED_REPLAY"
    handler.assert_called_once_with("echo assigned", 1000, "run-1")
    client.get_result.assert_called_once_with("plan-1", "run-1")
    stored = journal.load_run("run-1")
    assert stored is not None and stored.acceptance_receipt == "receipt-status-1"
    assert "accepted" in repr(console.print.call_args_list).lower()


def test_same_outcome_with_different_terminal_evidence_does_not_clear_pending_result(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client(terminal_state="FAILED")
    handler = MagicMock(side_effect=RuntimeError("local failure"))
    client.submit_result.return_value = BackendResponse(
        ok=True,
        value={
            "ok": True,
            "code": "ACTION_PLAN_EXECUTION_RESULT_ACCEPTED",
            "protocol_version": "action-plan-execution-v1",
        },
    )
    client.get_result.return_value = BackendResponse(
        ok=True,
        value=_result_read(
            "failed",
            error={"code": "DIFFERENT_FAILURE", "category": "other"},
        ),
    )
    runner, console, _ = _runner(journal, client, run_handler=handler)

    result = runner.run_once()

    assert result.disposition == "RECOVERY_REQUIRED"
    stored = journal.load_run("run-1")
    assert stored is not None and stored.state == "RESULT_PENDING"
    assert "accepted" not in repr(console.print.call_args_list).lower()


def test_claimed_restart_recovers_same_assignment_without_duplicate_effect(
    journal: ActionPlanExecutionJournal,
) -> None:
    assignment = ActionPlanExecutionAssignment(
        execution_realm="local:test",
        command_id="command-1",
        plan_id="plan-1",
        run_id="run-1",
        action_id="action-1",
        snapshot_id="snapshot-1",
        snapshot_version="action-execution-snapshot-v1",
        capability="terminal.run",
        action_snapshot={
            "agent_id": "agent-1",
            "capability": "terminal.run",
            "params": {"command": "echo assigned"},
            "timeout_ms": 1000,
        },
        lifecycle={"status": "approved", "expires_at": None},
        policy={
            "category": "ALLOW",
            "evidence_id": "clear-evidence-1",
            "evaluated_at": "2026-07-17T12:00:00.000Z",
        },
        execution_generation=1,
        disposition="CLAIMED",
        timeout_ms=1000,
    )
    journal.save_assignment(assignment, claim_key="claim-key")
    client = _successful_client()
    client.claim.return_value = BackendResponse(
        ok=True,
        value=_claim(disposition="CLAIM_REPLAY_NOT_STARTED"),
    )
    runner, _console, handler = _runner(
        journal,
        client,
        keys=("start-key", "result-key"),
    )
    runner._capability_verified = True
    runner._permitted_operations = frozenset(
        {"claim", "start", "submit-result", "read-status", "read-result"}
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    client.claim.assert_called_once_with("plan-1", "run-1", "claim-key")
    handler.assert_called_once_with("echo assigned", 1000, "run-1")


def test_unknown_local_effect_after_restart_is_quarantined_not_reexecuted(
    journal: ActionPlanExecutionJournal,
) -> None:
    assignment = ActionPlanExecutionAssignment(
        execution_realm="local:test",
        command_id="command-1",
        plan_id="plan-1",
        run_id="run-1",
        action_id="action-1",
        snapshot_id="snapshot-1",
        snapshot_version="action-execution-snapshot-v1",
        capability="terminal.run",
        action_snapshot={
            "agent_id": "agent-1",
            "capability": "terminal.run",
            "params": {"command": "echo assigned"},
        },
        lifecycle={"status": "approved", "expires_at": None},
        policy={
            "category": "ALLOW",
            "evidence_id": "clear-evidence-1",
            "evaluated_at": "2026-07-17T12:00:00.000Z",
        },
        execution_generation=1,
        disposition="CLAIMED",
        timeout_ms=1000,
    )
    journal.save_assignment(assignment, claim_key="claim-key")
    journal.save_start_intent("run-1", "start-key")
    journal.mark_running_not_started("run-1")
    journal.mark_local_execution_started("run-1")
    client = _successful_client()
    runner, console, handler = _runner(journal, client)
    runner._capability_verified = True
    runner._permitted_operations = frozenset()

    result = runner.run_once()

    assert result.disposition == "QUARANTINED_REJECTION"
    handler.assert_not_called()
    client.submit_result.assert_not_called()
    assert "accepted" not in repr(console.print.call_args_list).lower()


def test_identity_or_realm_mismatch_stops_before_claim(
    journal: ActionPlanExecutionJournal,
) -> None:
    client = _successful_client()
    client.get_capability.return_value = BackendResponse(
        ok=True,
        value=_capability(executor_instance_id="other-instance"),
    )
    runner, _console, handler = _runner(journal, client)

    result = runner.run_once()

    assert result.disposition == "PROTOCOL_INCOMPATIBLE"
    client.claim_next.assert_not_called()
    handler.assert_not_called()


def test_quarantined_rejection_stops_executor_before_another_claim() -> None:
    cli = SimpleNamespace(_daemon_running=True)
    runner = MagicMock()
    runner.run_once.return_value = SimpleNamespace(disposition="QUARANTINED_REJECTION")

    with (
        patch(
            "arcanos.action_plan_execution_runner.build_action_plan_execution_runner",
            return_value=runner,
        ),
        patch("arcanos.action_plan_execution_runner.time.sleep") as sleep,
    ):
        action_plan_execution_loop(cli)

    runner.run_once.assert_called_once_with()
    sleep.assert_not_called()


def test_phase2e_refuses_legacy_queue_command_without_acknowledge() -> None:
    cli = MagicMock()
    command = DaemonCommand(
        id="legacy-command",
        name="action_plan",
        payload={"plan_id": "legacy-plan"},
        issuedAt="2026-07-17T00:00:00Z",
    )

    with patch.object(
        daemon_ops.Config,
        "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
        True,
    ):
        handled = daemon_ops.handle_daemon_command(cli, command)

    assert handled is False
    cli.handle_run.assert_not_called()
    assert "dedicated execution assignment required" in repr(
        cli.console.print.call_args_list
    )


def test_phase2e_legacy_queue_poller_does_not_send_ack() -> None:
    backend = MagicMock()
    cli = SimpleNamespace(
        _daemon_running=True,
        _command_poll_interval=0,
        backend_client=backend,
        instance_id="executor-instance",
        console=MagicMock(),
        handle_run=MagicMock(),
        _confirm_action=MagicMock(return_value=True),
        _append_activity=MagicMock(),
    )
    cli._handle_daemon_command = lambda command: daemon_ops.handle_daemon_command(
        cli,
        command,
    )
    backend.make_raw_request.return_value = SimpleNamespace(
        status_code=200,
        headers={},
        json=lambda: {
            "commands": [
                {
                    "id": "legacy-command",
                    "name": "action_plan",
                    "payload": {"plan_id": "legacy-plan"},
                    "issuedAt": "2026-07-17T00:00:00Z",
                }
            ]
        },
    )

    def stop_after_cycle(_seconds: float) -> None:
        cli._daemon_running = False

    with (
        patch.object(
            daemon_ops.Config,
            "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
            True,
        ),
        patch.object(daemon_ops.time, "sleep", side_effect=stop_after_cycle),
    ):
        daemon_ops.command_poll_loop(cli)

    backend.make_raw_request.assert_called_once_with(
        "GET",
        "/api/daemon/commands?instance_id=executor-instance",
    )
    cli.handle_run.assert_not_called()


def test_phase2e_legacy_daemon_module_refuses_action_plan_command() -> None:
    cli = MagicMock()
    command = DaemonCommand(
        id="legacy-command",
        name="action_plan",
        payload={"plan_id": "legacy-plan"},
        issuedAt="2026-07-17T00:00:00Z",
    )

    with patch.object(
        legacy_daemon_ops.Config,
        "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
        True,
    ):
        handled = legacy_daemon_ops.handle_daemon_command(cli, command)

    assert handled is False
    cli.handle_run.assert_not_called()
    assert "dedicated execution assignment required" in repr(
        cli.console.print.call_args_list
    )


def test_phase2e_direct_legacy_handler_refuses_without_side_effects() -> None:
    console = MagicMock()
    backend = MagicMock()
    run_handler = MagicMock()
    with patch(
        "arcanos.action_plan_handler.Config.ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
        True,
    ):
        handle_action_plan(
            {"plan_id": "legacy-plan"},
            console,
            backend,
            "executor-instance",
            run_handler,
            MagicMock(return_value=True),
        )

    run_handler.assert_not_called()
    backend._request_json.assert_not_called()
    assert "dedicated execution assignment required" in repr(
        console.print.call_args_list
    )
