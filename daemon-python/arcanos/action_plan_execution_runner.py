"""Phase 2E ActionPlan executor orchestration with durable local recovery."""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, TYPE_CHECKING

from .action_plan_execution_journal import (
    ActionPlanExecutionJournal,
    ActionPlanExecutionJournalError,
    JournalRun,
)
from .action_plan_execution_protocol import (
    ActionPlanExecutionAssignment,
    ActionPlanExecutionProtocolClient,
    parse_acceptance,
    parse_assignment,
    parse_protocol_capability,
    parse_result_read,
    parse_start,
    parse_status,
)
from .config import Config
from .cli import run_ops
from .error_handler import logger as error_logger

if TYPE_CHECKING:
    from rich.console import Console


@dataclass(frozen=True)
class ExecutionCycleResult:
    disposition: str
    run_id: Optional[str] = None


class ActionPlanExecutionRunner:
    """Claim, execute, and report one server-assigned action at a time."""

    def __init__(
        self,
        *,
        client: ActionPlanExecutionProtocolClient,
        journal: ActionPlanExecutionJournal,
        expected_realm: str,
        executor_principal_id: str,
        executor_instance_id: str,
        assigned_agent_id: str,
        console: "Console",
        run_handler: Callable[[str, Optional[int], str], Any],
        confirm_prompt: Callable[[str], bool],
        key_factory: Callable[[], str] = lambda: secrets.token_urlsafe(32),
    ) -> None:
        self.client = client
        self.journal = journal
        self.expected_realm = expected_realm
        self.executor_principal_id = executor_principal_id
        self.executor_instance_id = executor_instance_id
        self.assigned_agent_id = assigned_agent_id
        self.console = console
        self.run_handler = run_handler
        self.confirm_prompt = confirm_prompt
        self.key_factory = key_factory
        self._capability_verified = False
        self._permitted_operations: frozenset[str] = frozenset()

    def verify_capability(self) -> ExecutionCycleResult:
        response = self.client.get_capability()
        if not response.ok or response.value is None:
            return ExecutionCycleResult("PROTOCOL_INCOMPATIBLE")
        try:
            capability = parse_protocol_capability(response.value)
        except (TypeError, ValueError):
            return ExecutionCycleResult("PROTOCOL_INCOMPATIBLE")
        if capability.execution_realm != self.expected_realm:
            return ExecutionCycleResult("PROTOCOL_INCOMPATIBLE")
        if (
            capability.executor_principal_id != self.executor_principal_id
            or capability.executor_instance_id != self.executor_instance_id
            or capability.assigned_agent_id != self.assigned_agent_id
        ):
            return ExecutionCycleResult("PROTOCOL_INCOMPATIBLE")
        self._capability_verified = True
        self._permitted_operations = frozenset(capability.permitted_operations)
        return ExecutionCycleResult("READY")

    def run_once(self) -> ExecutionCycleResult:
        if not self._capability_verified:
            capability = self.verify_capability()
            if capability.disposition != "READY":
                return capability

        try:
            recoverable = self.journal.list_recoverable()
        except ActionPlanExecutionJournalError:
            return ExecutionCycleResult("RECOVERY_REQUIRED")
        if recoverable:
            required = _required_recovery_operations(recoverable[0].state)
            if not required.issubset(self._permitted_operations):
                return ExecutionCycleResult(
                    "PROTOCOL_INCOMPATIBLE",
                    recoverable[0].run_id,
                )
            return self._recover(recoverable[0])

        new_work_operations = {
            "claim-next",
            "claim",
            "start",
            "submit-result",
            "read-status",
            "read-result",
        }
        if not new_work_operations.issubset(self._permitted_operations):
            return ExecutionCycleResult("DRAIN_ONLY")

        claim_key = self.journal.load_claim_intent() or self.key_factory()
        try:
            self.journal.save_claim_intent(claim_key)
        except ActionPlanExecutionJournalError:
            return ExecutionCycleResult("RECOVERY_REQUIRED")
        response = self.client.claim_next(claim_key)
        if not response.ok:
            return ExecutionCycleResult("RECOVERY_REQUIRED")
        if response.value is None:
            try:
                self.journal.clear_claim_intent()
            except ActionPlanExecutionJournalError:
                return ExecutionCycleResult("RECOVERY_REQUIRED")
            return ExecutionCycleResult("NO_WORK")
        try:
            assignment = parse_assignment(
                response.value,
                expected_realm=self.expected_realm,
            )
            self._validate_local_assignment(assignment)
            self.journal.save_assignment(assignment, claim_key=claim_key)
        except (ActionPlanExecutionJournalError, TypeError, ValueError):
            return ExecutionCycleResult("PROTOCOL_INCOMPATIBLE")
        return self._authorize_start_execute(assignment)

    def _recover(self, run: JournalRun) -> ExecutionCycleResult:
        if run.expected_realm != self.expected_realm:
            return ExecutionCycleResult("PROTOCOL_INCOMPATIBLE", run.run_id)
        if run.state == "RESULT_PENDING":
            return self._submit_pending(run)
        if run.state == "LOCAL_EXECUTION_STARTED":
            self._quarantine(run.run_id, "LOCAL_EFFECT_OUTCOME_UNKNOWN")
            return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
        assignment = _restore_assignment(run)
        if assignment is None:
            self._quarantine(run.run_id, "LOCAL_ASSIGNMENT_UNAVAILABLE")
            return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
        try:
            self._validate_local_assignment(assignment)
        except ValueError:
            self._quarantine(run.run_id, "LOCAL_ASSIGNMENT_INVALID")
            return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)

        if run.state == "CLAIMED":
            if not run.claim_key:
                self._quarantine(run.run_id, "LOCAL_CLAIM_KEY_UNAVAILABLE")
                return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
            response = self.client.claim(
                run.plan_id,
                run.run_id,
                run.claim_key,
            )
            if not response.ok or response.value is None:
                return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
            try:
                replay = parse_assignment(
                    response.value,
                    expected_realm=self.expected_realm,
                )
            except (TypeError, ValueError):
                return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
            if not _same_assignment(replay, assignment):
                self._quarantine(run.run_id, "LOCAL_ASSIGNMENT_CONFLICT")
                return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
            return self._authorize_start_execute(assignment)

        if run.state == "START_INTENT":
            if not run.start_key:
                self._quarantine(run.run_id, "LOCAL_START_KEY_UNAVAILABLE")
                return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
            return self._start_then_execute(assignment, run.start_key)

        if run.state == "RUNNING_LOCAL_NOT_STARTED":
            response = self.client.get_status(run.plan_id, run.run_id)
            if not response.ok or response.value is None:
                return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
            try:
                status = parse_status(
                    response.value,
                    plan_id=run.plan_id,
                    run_id=run.run_id,
                    action_id=run.action_id,
                    snapshot_id=run.snapshot_id,
                    expected_realm=self.expected_realm,
                )
            except (TypeError, ValueError):
                return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
            if status.state != "RUNNING":
                self._quarantine(run.run_id, "REMOTE_STATE_NOT_EXECUTABLE")
                return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
            return self._execute_and_submit(assignment)

        self._quarantine(run.run_id, "LOCAL_STATE_UNSUPPORTED")
        return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)

    def _authorize_start_execute(
        self,
        assignment: ActionPlanExecutionAssignment,
    ) -> ExecutionCycleResult:
        command = _assignment_command(assignment)
        if command is None:
            self._quarantine(assignment.run_id, "ASSIGNMENT_CAPABILITY_UNSUPPORTED")
            return ExecutionCycleResult(
                "QUARANTINED_REJECTION",
                assignment.run_id,
            )
        approved = self.confirm_prompt(
            "Run assigned terminal action? "
            f"run_id={assignment.run_id} action_id={assignment.action_id} "
            f"snapshot_id={assignment.snapshot_id}"
        )
        if not approved:
            self._quarantine(assignment.run_id, "LOCAL_CONFIRMATION_DENIED")
            return ExecutionCycleResult(
                "QUARANTINED_REJECTION",
                assignment.run_id,
            )
        start_key = self.key_factory()
        try:
            self.journal.save_start_intent(assignment.run_id, start_key)
        except ActionPlanExecutionJournalError:
            return ExecutionCycleResult("RECOVERY_REQUIRED", assignment.run_id)
        return self._start_then_execute(assignment, start_key)

    def _start_then_execute(
        self,
        assignment: ActionPlanExecutionAssignment,
        start_key: str,
    ) -> ExecutionCycleResult:
        response = self.client.start(
            assignment.plan_id,
            assignment.run_id,
            start_key,
        )
        if not response.ok or response.value is None:
            return ExecutionCycleResult("RECOVERY_REQUIRED", assignment.run_id)
        try:
            parse_start(
                response.value,
                plan_id=assignment.plan_id,
                run_id=assignment.run_id,
                action_id=assignment.action_id,
                expected_realm=self.expected_realm,
            )
            self.journal.mark_running_not_started(assignment.run_id)
        except (ActionPlanExecutionJournalError, TypeError, ValueError):
            return ExecutionCycleResult("RECOVERY_REQUIRED", assignment.run_id)
        return self._execute_and_submit(assignment)

    def _execute_and_submit(
        self,
        assignment: ActionPlanExecutionAssignment,
    ) -> ExecutionCycleResult:
        command = _assignment_command(assignment)
        if command is None:
            self._quarantine(assignment.run_id, "ASSIGNMENT_CAPABILITY_UNSUPPORTED")
            return ExecutionCycleResult(
                "QUARANTINED_REJECTION",
                assignment.run_id,
            )
        try:
            self.journal.mark_local_execution_started(assignment.run_id)
        except ActionPlanExecutionJournalError:
            return ExecutionCycleResult("RECOVERY_REQUIRED", assignment.run_id)

        outcome = "succeeded"
        output: Optional[dict[str, Any]] = None
        error: Optional[dict[str, str]] = None
        try:
            execution = self.run_handler(
                command,
                assignment.timeout_ms,
                assignment.run_id,
            )
            return_code = (
                execution.get("return_code") if isinstance(execution, Mapping) else None
            )
            if (
                not isinstance(execution, Mapping)
                or execution.get("ok") is not True
                or isinstance(return_code, bool)
                or not isinstance(return_code, int)
                or return_code != 0
            ):
                outcome = "failed"
                output = None
                error = {
                    "code": "ACTION_EXECUTION_FAILED",
                    "category": "nonzero_or_unconfirmed",
                }
        except Exception as exc:
            outcome = "failed"
            output = None
            error = {
                "code": "ACTION_EXECUTION_FAILED",
                "category": _safe_exception_class(exc),
            }

        result: dict[str, Any] = {
            "action_id": assignment.action_id,
            "snapshot_id": assignment.snapshot_id,
            "outcome": outcome,
        }
        if output is not None:
            result["output"] = output
        if error is not None:
            result["error"] = error
        result_key = self.key_factory()
        try:
            self.journal.save_pending_result(
                assignment.run_id,
                result_key=result_key,
                result=result,
            )
        except ActionPlanExecutionJournalError:
            self._quarantine(assignment.run_id, "LOCAL_RESULT_PERSISTENCE_FAILED")
            return ExecutionCycleResult("QUARANTINED_REJECTION", assignment.run_id)
        run = self.journal.load_run(assignment.run_id)
        if run is None:
            return ExecutionCycleResult("RECOVERY_REQUIRED", assignment.run_id)
        return self._submit_pending(run)

    def _submit_pending(self, run: JournalRun) -> ExecutionCycleResult:
        if not run.result_key or not run.pending_result:
            self._quarantine(run.run_id, "LOCAL_RESULT_EVIDENCE_UNAVAILABLE")
            return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
        outcome = run.pending_result.get("outcome")
        if outcome not in {"succeeded", "failed"}:
            self._quarantine(run.run_id, "LOCAL_RESULT_EVIDENCE_INVALID")
            return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
        response = self.client.submit_result(
            run.plan_id,
            run.run_id,
            run.pending_result,
            run.result_key,
        )
        if not response.ok:
            error_kind = response.error.kind if response.error else "unknown"
            status_code = response.error.status_code if response.error else None
            if error_kind in {
                "network",
                "timeout",
                "transport",
                "ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED",
            } or (isinstance(status_code, int) and status_code >= 500):
                return ExecutionCycleResult("RETRY_RESULT", run.run_id)
            self._quarantine(run.run_id, "REMOTE_RESULT_REJECTED")
            return ExecutionCycleResult("QUARANTINED_REJECTION", run.run_id)
        if response.value is None:
            return self._confirm_result_evidence(run)
        try:
            acceptance = parse_acceptance(
                response.value,
                plan_id=run.plan_id,
                run_id=run.run_id,
                action_id=run.action_id,
                snapshot_id=run.snapshot_id,
                expected_outcome=outcome,
                expected_realm=self.expected_realm,
            )
            self.journal.mark_accepted(run.run_id, acceptance.acceptance_receipt)
        except (ActionPlanExecutionJournalError, TypeError, ValueError):
            return self._confirm_result_evidence(run)
        self.console.print("[green]Action execution result accepted[/green]")
        disposition = (
            "ACCEPTED"
            if acceptance.disposition == "RESULT_ACCEPTED"
            else "CONFIRMED_REPLAY"
        )
        return ExecutionCycleResult(disposition, run.run_id)

    def _confirm_result_evidence(
        self,
        run: JournalRun,
    ) -> ExecutionCycleResult:
        response = self.client.get_result(run.plan_id, run.run_id)
        if not response.ok or response.value is None:
            return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
        try:
            evidence = parse_result_read(
                response.value,
                plan_id=run.plan_id,
                run_id=run.run_id,
                action_id=run.action_id,
                snapshot_id=run.snapshot_id,
                expected_realm=self.expected_realm,
            )
        except (TypeError, ValueError):
            return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
        if evidence.result != run.pending_result:
            return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
        try:
            self.journal.mark_accepted(run.run_id, evidence.acceptance_receipt)
        except ActionPlanExecutionJournalError:
            return ExecutionCycleResult("RECOVERY_REQUIRED", run.run_id)
        self.console.print("[green]Action execution result accepted[/green]")
        return ExecutionCycleResult("CONFIRMED_REPLAY", run.run_id)

    def _validate_local_assignment(
        self,
        assignment: ActionPlanExecutionAssignment,
    ) -> None:
        if assignment.execution_realm != self.expected_realm:
            raise ValueError("assignment realm mismatch")
        agent_id = assignment.action_snapshot.get("agent_id")
        if agent_id != self.assigned_agent_id:
            raise ValueError("assignment agent mismatch")
        if assignment.capability != "terminal.run":
            raise ValueError("assignment capability unsupported")

    def _quarantine(self, run_id: str, reason_code: str) -> None:
        try:
            self.journal.quarantine(run_id, reason_code)
        except ActionPlanExecutionJournalError:
            pass
        try:
            error_logger.error(
                "[ACTION_PLAN_EXECUTION] Automatic processing stopped "
                "reason_code=%s",
                reason_code,
            )
        except Exception:
            pass


def build_action_plan_execution_runner(cli: Any) -> ActionPlanExecutionRunner:
    backend_url = _required_config_string(Config.BACKEND_URL)
    executor_principal_id = _required_config_string(
        Config.ACTION_PLAN_EXECUTOR_PRINCIPAL_ID
    )
    executor_instance_id = _required_config_string(
        Config.ACTION_PLAN_EXECUTOR_INSTANCE_ID
    )
    assigned_agent_id = _required_config_string(Config.ACTION_PLAN_EXECUTOR_AGENT_ID)
    expected_realm = _required_config_string(Config.ACTION_PLAN_EXECUTOR_EXPECTED_REALM)
    _required_config_string(Config.ACTION_PLAN_EXECUTOR_TOKEN)
    if getattr(cli, "instance_id", None) != executor_instance_id:
        raise ValueError("ActionPlan executor instance identity is incompatible")
    client = ActionPlanExecutionProtocolClient(
        backend_url,
        lambda: Config.ACTION_PLAN_EXECUTOR_TOKEN,
        timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT,
    )
    journal = ActionPlanExecutionJournal(
        Config.ACTION_PLAN_EXECUTION_JOURNAL_PATH,
        expected_realm=expected_realm,
    )
    return ActionPlanExecutionRunner(
        client=client,
        journal=journal,
        expected_realm=expected_realm,
        executor_principal_id=executor_principal_id,
        executor_instance_id=executor_instance_id,
        assigned_agent_id=assigned_agent_id,
        console=cli.console,
        run_handler=lambda command, timeout_ms, run_id: _execute_cli_command(
            cli,
            command,
            timeout_ms,
            run_id,
        ),
        confirm_prompt=lambda message: cli._confirm_action(message),
    )


def action_plan_execution_loop(cli: Any) -> None:
    try:
        runner = build_action_plan_execution_runner(cli)
    except Exception:
        error_logger.error(
            "[ACTION_PLAN_EXECUTION] Executor disabled "
            "reason_code=ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE"
        )
        return
    while cli._daemon_running:
        try:
            result = runner.run_once()
        except Exception:
            error_logger.error(
                "[ACTION_PLAN_EXECUTION] Executor stopped "
                "reason_code=ACTION_PLAN_EXECUTION_LOCAL_STATE_UNAVAILABLE"
            )
            return
        if result.disposition == "PROTOCOL_INCOMPATIBLE":
            error_logger.error(
                "[ACTION_PLAN_EXECUTION] Executor stopped "
                "reason_code=ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE"
            )
            return
        if result.disposition in {"RECOVERY_REQUIRED", "QUARANTINED_REJECTION"}:
            error_logger.warning(
                "[ACTION_PLAN_EXECUTION] Executor paused " "reason_code=%s",
                result.disposition,
            )
            if result.disposition == "QUARANTINED_REJECTION":
                return
        time.sleep(max(1, Config.DAEMON_COMMAND_POLL_INTERVAL_SECONDS))


def _restore_assignment(run: JournalRun) -> Optional[ActionPlanExecutionAssignment]:
    if not isinstance(run.assignment, dict):
        return None
    try:
        return ActionPlanExecutionAssignment(**run.assignment)
    except (TypeError, ValueError):
        return None


def _assignment_command(
    assignment: ActionPlanExecutionAssignment,
) -> Optional[str]:
    if assignment.capability != "terminal.run":
        return None
    params = assignment.action_snapshot.get("params")
    if not isinstance(params, dict):
        return None
    command = params.get("command")
    if not isinstance(command, str) or not command.strip() or len(command) > 16_384:
        return None
    return command


def _same_assignment(
    left: ActionPlanExecutionAssignment,
    right: ActionPlanExecutionAssignment,
) -> bool:
    return (
        left.execution_realm == right.execution_realm
        and left.command_id == right.command_id
        and left.plan_id == right.plan_id
        and left.run_id == right.run_id
        and left.action_id == right.action_id
        and left.snapshot_id == right.snapshot_id
        and left.snapshot_version == right.snapshot_version
        and left.capability == right.capability
        and left.action_snapshot == right.action_snapshot
        and left.lifecycle == right.lifecycle
        and left.policy == right.policy
        and left.execution_generation == right.execution_generation
        and left.timeout_ms == right.timeout_ms
    )


def _safe_exception_class(error: BaseException) -> str:
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, PermissionError):
        return "permission"
    if isinstance(error, ValueError):
        return "validation"
    return "execution"


def _execute_cli_command(
    cli: Any,
    command: str,
    timeout_ms: Optional[int],
    run_id: str,
) -> Any:
    return run_ops.handle_action_plan_run(
        cli,
        command,
        execution_identity=run_id,
        timeout_seconds=(timeout_ms + 999) // 1000 if timeout_ms is not None else None,
    )


def _required_recovery_operations(state: str) -> frozenset[str]:
    if state == "RESULT_PENDING":
        return frozenset({"submit-result", "read-result"})
    if state == "CLAIMED":
        return frozenset(
            {"claim", "start", "submit-result", "read-status", "read-result"}
        )
    if state == "START_INTENT":
        return frozenset({"start", "submit-result", "read-status", "read-result"})
    if state == "RUNNING_LOCAL_NOT_STARTED":
        return frozenset({"submit-result", "read-status", "read-result"})
    return frozenset()


def _required_config_string(value: Optional[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("ActionPlan execution configuration is incomplete")
    return value.strip()


__all__ = [
    "ActionPlanExecutionRunner",
    "ExecutionCycleResult",
    "action_plan_execution_loop",
    "build_action_plan_execution_runner",
]
