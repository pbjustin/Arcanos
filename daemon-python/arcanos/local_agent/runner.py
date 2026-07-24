"""Polling local-agent executor with durable replay and fail-closed effects."""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from ..config import Config
from ..cli.cli_policy import strip_unsafe_output_controls
from ..error_handler import logger as error_logger
from .contracts import (
    load_local_agent_capability_catalog,
    validate_local_agent_input,
    validate_local_agent_output,
)
from .journal import (
    LocalAgentExecutionJournal,
    LocalAgentJournalError,
    LocalAgentJournalRun,
)
from .protocol import (
    LocalAgentAuthorization,
    LocalAgentJobAssignment,
    LocalAgentProtocolClient,
    LocalAgentTerminalReplay,
    PROTOCOL_VERSION,
    parse_claim_response,
    parse_result_acceptance,
    valid_idempotency_key,
)
from .process_runner import ProcessCancelledError
from .workspace_registry import (
    RegisteredWorkspaceRegistry,
    WorkspaceRegistryError,
)

INITIAL_ACTIONS = frozenset(
    {
        "local_agent.status",
        "repo.search",
        "git.status",
        "git.diff",
        "tests.run",
        "patch.preview",
        "patch.apply",
    }
)
MAX_SANITIZED_OUTPUT_BYTES = 32 * 1024
MAX_OUTPUT_STRING_CHARS = 16 * 1024
MAX_OUTPUT_COLLECTION_ITEMS = 1_000
MAX_OUTPUT_DEPTH = 8
_SENSITIVE_KEY_RE = re.compile(
    r"(?:authorization|bearer|cookie|credential|password|secret|session|token|"
    r"api[_-]?key|private[_-]?key)",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}")
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(token|secret|password|api[_-]?key|cookie)\b(\s*[:=]\s*)" r"([^\s,;]+)"
)
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?" r"-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.DOTALL,
)


class LocalAgentRunnerError(RuntimeError):
    """Internal failure that is safe to classify without exposing details."""


class LocalAgentOutputError(LocalAgentRunnerError):
    """Handler output could not be bounded safely."""


@dataclass(frozen=True)
class LocalAgentCycleResult:
    disposition: str
    job_id: Optional[str] = None


class LocalAgentExecutionRunner:
    """Claims and executes at most one server-authorized local job per cycle."""

    def __init__(
        self,
        *,
        client: LocalAgentProtocolClient,
        journal: LocalAgentExecutionJournal,
        workspace_registry: RegisteredWorkspaceRegistry,
        device_id: str,
        principal_id: str,
        device_scopes: set[str] | frozenset[str],
        allowed_actions: set[str] | frozenset[str],
        execute_handler: Callable[..., Mapping[str, Any]],
        patch_authorization_factory: Callable[..., Any],
        capability_catalog: Optional[Mapping[str, Mapping[str, Any]]] = None,
        key_factory: Callable[[], str] = lambda: secrets.token_urlsafe(32),
        now_factory: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        monotonic: Callable[[], float] = time.monotonic,
        heartbeat_interval_seconds: float = 10.0,
        should_continue: Callable[[], bool] = lambda: True,
    ) -> None:
        if not device_id or not principal_id:
            raise ValueError("Pinned local-agent identity is required")
        catalog = dict(capability_catalog or load_local_agent_capability_catalog())
        _validate_catalog_metadata(catalog)
        if frozenset(catalog) != INITIAL_ACTIONS:
            raise ValueError("Generated local-agent action catalog is incompatible")
        normalized_actions = frozenset(allowed_actions)
        if not normalized_actions or not normalized_actions.issubset(catalog):
            raise ValueError("Local-agent action allowlist is invalid")
        normalized_scopes = frozenset(device_scopes)
        if not normalized_scopes or not normalized_scopes.issubset(catalog):
            raise ValueError("Local-agent device scopes are invalid")
        self.client = client
        self.journal = journal
        self.workspace_registry = workspace_registry
        self.device_id = device_id
        self.principal_id = principal_id
        self.device_scopes = normalized_scopes
        self.allowed_actions = normalized_actions
        self.capability_catalog = catalog
        self.execute_handler = execute_handler
        self.patch_authorization_factory = patch_authorization_factory
        self.key_factory = key_factory
        self.now_factory = now_factory
        self.monotonic = monotonic
        self.heartbeat_interval_seconds = max(0.0, heartbeat_interval_seconds)
        self.should_continue = should_continue

    def run_once(self) -> LocalAgentCycleResult:
        device_heartbeat = self.client.heartbeat()
        if not device_heartbeat.ok:
            return LocalAgentCycleResult("OFFLINE")
        try:
            recoverable = self.journal.list_recoverable()
        except LocalAgentJournalError:
            return LocalAgentCycleResult("RECOVERY_REQUIRED")
        if recoverable:
            return self._recover(recoverable[0])

        claim_key = self.journal.load_claim_intent() or self.key_factory()
        try:
            self.journal.save_claim_intent(claim_key)
        except LocalAgentJournalError:
            return LocalAgentCycleResult("RECOVERY_REQUIRED")
        response = self.client.claim(claim_key)
        if not response.ok:
            return LocalAgentCycleResult("OFFLINE")
        if response.value is None:
            try:
                self.journal.clear_claim_intent()
            except LocalAgentJournalError:
                return LocalAgentCycleResult("RECOVERY_REQUIRED")
            return LocalAgentCycleResult("NO_WORK")
        try:
            claim = parse_claim_response(response.value)
        except (TypeError, ValueError):
            return LocalAgentCycleResult("PROTOCOL_INCOMPATIBLE")
        if isinstance(claim, LocalAgentTerminalReplay):
            try:
                self.journal.clear_claim_intent()
            except LocalAgentJournalError:
                return LocalAgentCycleResult("RECOVERY_REQUIRED", claim.job_id)
            return LocalAgentCycleResult("TERMINAL_REPLAY", claim.job_id)

        try:
            self._validate_pinned_identity(claim)
            self.journal.save_assignment(claim, claim_key=claim_key)
        except (LocalAgentJournalError, ValueError):
            return LocalAgentCycleResult("PROTOCOL_INCOMPATIBLE", claim.job_id)
        return self._execute_or_report(claim)

    def _recover(self, run: LocalAgentJournalRun) -> LocalAgentCycleResult:
        if run.expected_device_id != self.device_id:
            return LocalAgentCycleResult("PROTOCOL_INCOMPATIBLE", run.job_id)
        assignment = _restore_assignment(run)
        if assignment is None:
            self._quarantine(run.job_id, "LOCAL_ASSIGNMENT_UNAVAILABLE")
            return LocalAgentCycleResult("QUARANTINED", run.job_id)
        try:
            self._validate_pinned_identity(assignment)
        except ValueError:
            self._quarantine(run.job_id, "LOCAL_ASSIGNMENT_IDENTITY_INVALID")
            return LocalAgentCycleResult("QUARANTINED", run.job_id)
        if assignment.is_expired(self.now_factory()):
            return self._expire_local_assignment(assignment)
        if run.state == "RESULT_PENDING":
            return self._submit_pending(run, assignment)
        if run.state == "EXECUTION_STARTED":
            result = self._failure_result(
                assignment,
                code="LOCAL_EFFECT_OUTCOME_UNKNOWN",
                classification="execution",
                message="Local execution was interrupted and was not replayed.",
                retryable=False,
                duration_ms=0,
            )
            return self._persist_and_submit(assignment, result)
        if run.state == "CLAIMED":
            return self._execute_or_report(assignment)
        self._quarantine(run.job_id, "LOCAL_STATE_UNSUPPORTED")
        return LocalAgentCycleResult("QUARANTINED", run.job_id)

    def _execute_or_report(
        self,
        assignment: LocalAgentJobAssignment,
    ) -> LocalAgentCycleResult:
        try:
            self._validate_execution_contract(assignment)
        except ValueError:
            result = self._failure_result(
                assignment,
                code="LOCAL_AGENT_ACTION_UNAUTHORIZED",
                classification="authorization",
                message="The assigned action is not authorized on this device.",
                retryable=False,
                duration_ms=0,
            )
            return self._persist_and_submit(assignment, result)

        if assignment.is_expired(self.now_factory()):
            return self._expire_local_assignment(assignment)
        try:
            workspace_root = self.workspace_registry.resolve(assignment.workspace)
        except WorkspaceRegistryError:
            result = self._failure_result(
                assignment,
                code="LOCAL_AGENT_WORKSPACE_UNREGISTERED",
                classification="workspace",
                message="The assigned workspace is not registered on this device.",
                retryable=False,
                duration_ms=0,
            )
            return self._persist_and_submit(assignment, result)
        heartbeat = self.client.job_heartbeat(assignment.job_id)
        if not heartbeat.ok:
            return LocalAgentCycleResult("OFFLINE", assignment.job_id)
        execution_now = self.now_factory()
        if assignment.is_expired(execution_now):
            return self._expire_local_assignment(assignment)
        remaining_ms = max(
            1,
            int(
                (
                    assignment.expires_at - execution_now.astimezone(timezone.utc)
                ).total_seconds()
                * 1_000
            ),
        )
        effective_timeout_ms = min(assignment.timeout_ms, remaining_ms)

        try:
            self.journal.mark_execution_started(assignment.job_id)
        except LocalAgentJournalError:
            return LocalAgentCycleResult("RECOVERY_REQUIRED", assignment.job_id)

        started = self.monotonic()
        cancellation_event = threading.Event()
        heartbeat_pump = _JobHeartbeatPump(
            self.client,
            assignment.job_id,
            self.heartbeat_interval_seconds,
            cancellation_event=cancellation_event,
            should_continue=self.should_continue,
        )
        heartbeat_pump.start()
        try:
            mutation_authorization = self._mutation_authorization(assignment)
            raw_output = self.execute_handler(
                assignment.action,
                assignment.payload,
                workspace_root,
                effective_timeout_ms,
                mutation_authorization=mutation_authorization,
                cancellation_event=cancellation_event,
            )
            if cancellation_event.is_set():
                raise ProcessCancelledError("Local execution authorization was lost.")
            output, output_truncated = sanitize_handler_output(
                assignment.action,
                raw_output,
                workspace_root=workspace_root,
            )
            validate_local_agent_output(assignment.action, output)
            duration_ms = _bounded_duration_ms(self.monotonic() - started)
            result = self._success_result(
                assignment,
                output=output,
                duration_ms=duration_ms,
                output_truncated=output_truncated,
            )
        except Exception as exc:
            duration_ms = _bounded_duration_ms(self.monotonic() - started)
            if assignment.may_modify_files:
                code = "LOCAL_EFFECT_OUTCOME_UNKNOWN"
                classification = "execution"
                message = (
                    "Local execution failed after a file-modifying operation began; "
                    "manual reconciliation is required."
                )
                retryable = False
            else:
                code, classification, message, retryable = _classify_execution_error(
                    exc
                )
            result = self._failure_result(
                assignment,
                code=code,
                classification=classification,
                message=message,
                retryable=retryable,
                duration_ms=duration_ms,
            )
        finally:
            heartbeat_pump.stop()
        return self._persist_and_submit(assignment, result)

    def _mutation_authorization(
        self,
        assignment: LocalAgentJobAssignment,
    ) -> Any:
        if assignment.action != "patch.apply":
            return None
        if not isinstance(assignment.payload.get("patch"), str):
            raise ValueError("Patch payload is invalid")
        return self.patch_authorization_factory(
            assignment.payload,
            authorization_id=assignment.authorization_context.evidence_id,
        )

    def _validate_pinned_identity(
        self,
        assignment: LocalAgentJobAssignment,
    ) -> None:
        if (
            assignment.protocol_version != PROTOCOL_VERSION
            or assignment.state != "RUNNING"
            or assignment.disposition not in {"CLAIMED", "CLAIM_REPLAY"}
            or not valid_idempotency_key(assignment.idempotency_key)
        ):
            raise ValueError("assignment protocol identity is invalid")
        if assignment.device_id != self.device_id:
            raise ValueError("assignment device mismatch")
        if assignment.principal != self.principal_id:
            raise ValueError("assignment principal mismatch")

    def _validate_execution_contract(
        self,
        assignment: LocalAgentJobAssignment,
    ) -> None:
        if assignment.action not in self.allowed_actions:
            raise ValueError("assignment action is not allowlisted")
        contract = self.capability_catalog.get(assignment.action)
        if contract is None:
            raise ValueError("assignment action is not registered")
        if (
            assignment.read_only != contract["readOnly"]
            or assignment.may_modify_files != contract["mayModifyFiles"]
            or assignment.timeout_ms != contract["timeoutMs"]
        ):
            raise ValueError("assignment contract metadata mismatch")
        if assignment.required_device_scopes != tuple(contract["requiredDeviceScopes"]):
            raise ValueError("assignment device scopes do not match action")
        if not set(assignment.required_device_scopes).issubset(self.device_scopes):
            raise ValueError("device lacks required scope")
        if contract["requiresConfirmation"] and (
            assignment.authorization_context.decision != "confirmed"
        ):
            raise ValueError("mutation lacks confirmed authorization")
        if not contract["requiresConfirmation"] and (
            assignment.authorization_context.decision not in {"allow", "confirmed"}
        ):
            raise ValueError("read assignment lacks authorization")
        validate_local_agent_input(assignment.action, assignment.payload)

    def _persist_and_submit(
        self,
        assignment: LocalAgentJobAssignment,
        result: Mapping[str, Any],
    ) -> LocalAgentCycleResult:
        if assignment.is_expired(self.now_factory()):
            return self._expire_local_assignment(assignment)
        result_key = self.key_factory()
        result_body = dict(result)
        result_body["resultKey"] = result_key
        try:
            self.journal.save_pending_result(
                assignment.job_id,
                result_key=result_key,
                result=result_body,
            )
        except LocalAgentJournalError:
            self._quarantine(assignment.job_id, "LOCAL_RESULT_PERSISTENCE_FAILED")
            return LocalAgentCycleResult("QUARANTINED", assignment.job_id)
        run = self.journal.load_run(assignment.job_id)
        if run is None:
            return LocalAgentCycleResult("RECOVERY_REQUIRED", assignment.job_id)
        return self._submit_pending(run, assignment)

    def _submit_pending(
        self,
        run: LocalAgentJournalRun,
        assignment: LocalAgentJobAssignment,
    ) -> LocalAgentCycleResult:
        if assignment.is_expired(self.now_factory()):
            return self._expire_local_assignment(assignment)
        if not run.result_key or not run.pending_result:
            self._quarantine(run.job_id, "LOCAL_RESULT_EVIDENCE_UNAVAILABLE")
            return LocalAgentCycleResult("QUARANTINED", run.job_id)
        outcome = run.pending_result.get("outcome")
        if outcome not in {"succeeded", "failed"}:
            self._quarantine(run.job_id, "LOCAL_RESULT_EVIDENCE_INVALID")
            return LocalAgentCycleResult("QUARANTINED", run.job_id)
        response = self.client.submit_result(
            run.job_id,
            run.pending_result,
            run.result_key,
        )
        if not response.ok:
            error = response.error
            if (
                error is None
                or error.kind in {"network", "timeout", "transport"}
                or (isinstance(error.status_code, int) and error.status_code >= 500)
            ):
                return LocalAgentCycleResult("RETRY_RESULT", run.job_id)
            self._quarantine(run.job_id, "REMOTE_RESULT_REJECTED")
            return LocalAgentCycleResult("QUARANTINED", run.job_id)
        if response.value is None:
            return LocalAgentCycleResult("RECOVERY_REQUIRED", run.job_id)
        try:
            acceptance = parse_result_acceptance(
                response.value,
                job_id=run.job_id,
                outcome=outcome,
            )
            self.journal.mark_accepted(
                run.job_id,
                acceptance.acceptance_receipt,
            )
        except (LocalAgentJournalError, TypeError, ValueError):
            return LocalAgentCycleResult("RECOVERY_REQUIRED", run.job_id)
        disposition = (
            "ACCEPTED"
            if acceptance.disposition == "RESULT_ACCEPTED"
            else "CONFIRMED_REPLAY"
        )
        return LocalAgentCycleResult(disposition, run.job_id)

    def _expire_local_assignment(
        self,
        assignment: LocalAgentJobAssignment,
    ) -> LocalAgentCycleResult:
        self._quarantine(assignment.job_id, "LOCAL_AGENT_JOB_EXPIRED")
        return LocalAgentCycleResult("EXPIRED", assignment.job_id)

    def _success_result(
        self,
        assignment: LocalAgentJobAssignment,
        *,
        output: Mapping[str, Any],
        duration_ms: int,
        output_truncated: bool,
    ) -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "outcome": "succeeded",
            "output": dict(output),
            "metrics": {
                "durationMs": duration_ms,
                "outputTruncated": output_truncated,
            },
            "correlation": _correlation(assignment),
        }

    def _failure_result(
        self,
        assignment: LocalAgentJobAssignment,
        *,
        code: str,
        classification: str,
        message: str,
        retryable: bool,
        duration_ms: int,
    ) -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "outcome": "failed",
            "error": {
                "code": code,
                "classification": classification,
                "message": message,
                "retryable": retryable,
            },
            "metrics": {
                "durationMs": duration_ms,
                "outputTruncated": False,
            },
            "correlation": _correlation(assignment),
        }

    def _quarantine(self, job_id: str, reason_code: str) -> None:
        try:
            self.journal.quarantine(job_id, reason_code)
        except LocalAgentJournalError:
            pass
        try:
            error_logger.error(
                "[LOCAL_AGENT] Automatic processing stopped reason_code=%s",
                reason_code,
            )
        except Exception:
            pass


class _JobHeartbeatPump:
    def __init__(
        self,
        client: LocalAgentProtocolClient,
        job_id: str,
        interval_seconds: float,
        *,
        cancellation_event: threading.Event,
        should_continue: Callable[[], bool],
    ) -> None:
        self.client = client
        self.job_id = job_id
        self.interval_seconds = interval_seconds
        self.cancellation_event = cancellation_event
        self.should_continue = should_continue
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if not self.should_continue():
            self.cancellation_event.set()
            return
        if self.interval_seconds <= 0:
            return
        self._thread = threading.Thread(
            target=self._run,
            name="arcanos-local-agent-heartbeat",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=min(1.0, self.interval_seconds))

    def _run(self) -> None:
        next_heartbeat = time.monotonic() + self.interval_seconds
        while not self._stop.wait(0.1):
            if not self.should_continue():
                self.cancellation_event.set()
                return
            if time.monotonic() < next_heartbeat:
                continue
            response = self.client.job_heartbeat(self.job_id)
            if not response.ok:
                self.cancellation_event.set()
                return
            next_heartbeat = time.monotonic() + self.interval_seconds


def sanitize_handler_output(
    action: str,
    output: Mapping[str, Any],
    *,
    workspace_root: Path,
) -> tuple[dict[str, Any], bool]:
    if not isinstance(output, Mapping):
        raise LocalAgentOutputError("Handler output must be an object")
    state = {"truncated": False}
    sanitized = _sanitize_value(
        output,
        workspace_root=workspace_root,
        state=state,
        depth=0,
    )
    if not isinstance(sanitized, dict):
        raise LocalAgentOutputError("Handler output must remain an object")
    _apply_action_truncation_marker(action, sanitized, state["truncated"])
    if _encoded_size(sanitized) > MAX_SANITIZED_OUTPUT_BYTES:
        sanitized = _shrink_action_output(action, sanitized, state)
    if _encoded_size(sanitized) > MAX_SANITIZED_OUTPUT_BYTES:
        raise LocalAgentOutputError("Handler output exceeds the safe output limit")
    return sanitized, bool(state["truncated"])


def build_local_agent_execution_runner(
    should_continue: Callable[[], bool] = lambda: True,
) -> LocalAgentExecutionRunner:
    backend_url = _required_config(Config.BACKEND_URL, "backend URL")
    executor_credential = _required_config(
        Config.LOCAL_AGENT_EXECUTOR_TOKEN,
        "purpose-bound local-agent executor token",
    )
    principal_id = _required_config(
        Config.LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID,
        "local-agent executor principal",
    )
    _required_config(
        Config.LOCAL_AGENT_EXECUTOR_INSTANCE_ID,
        "local-agent executor instance",
    )
    device_id = _required_config(
        Config.LOCAL_AGENT_EXECUTOR_DEVICE_ID,
        "registered local-agent device id",
    )
    allowed_actions = _parse_allowlist_environment("ARCANOS_LOCAL_AGENT_ACTIONS")
    device_scopes = _parse_allowlist_environment("ARCANOS_LOCAL_AGENT_DEVICE_SCOPES")
    workspace_registry = RegisteredWorkspaceRegistry.from_environment()
    from .handlers import (  # Imported lazily to keep the transport reusable.
        execute_local_agent_action,
    )
    from .patch_handler import issue_patch_execution_authorization

    return LocalAgentExecutionRunner(
        client=LocalAgentProtocolClient(
            backend_url,
            lambda: executor_credential,
            timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT,
        ),
        journal=LocalAgentExecutionJournal(
            Config.DATA_DIR / "local_agent" / "journal.sqlite3",
            expected_device_id=device_id,
        ),
        workspace_registry=workspace_registry,
        device_id=device_id,
        principal_id=principal_id,
        device_scopes=device_scopes,
        allowed_actions=allowed_actions,
        execute_handler=execute_local_agent_action,
        patch_authorization_factory=issue_patch_execution_authorization,
        heartbeat_interval_seconds=float(
            max(
                1,
                _optional_positive_int_environment(
                    "ARCANOS_LOCAL_AGENT_HEARTBEAT_SECONDS",
                    10,
                ),
            )
        ),
        should_continue=should_continue,
    )


def local_agent_execution_loop(
    should_continue: Callable[[], bool],
) -> None:
    """Run the outbound polling loop until the embedding daemon stops."""
    try:
        runner = build_local_agent_execution_runner(should_continue)
    except Exception:
        error_logger.error(
            "[LOCAL_AGENT] Executor disabled "
            "reason_code=LOCAL_AGENT_CONFIGURATION_INVALID"
        )
        return
    poll_seconds = _optional_positive_int_environment(
        "ARCANOS_LOCAL_AGENT_POLL_INTERVAL_SECONDS",
        5,
    )
    while should_continue():
        try:
            result = runner.run_once()
        except Exception:
            error_logger.error(
                "[LOCAL_AGENT] Executor stopped "
                "reason_code=LOCAL_AGENT_LOCAL_STATE_UNAVAILABLE"
            )
            return
        if result.disposition == "PROTOCOL_INCOMPATIBLE":
            error_logger.error(
                "[LOCAL_AGENT] Executor stopped "
                "reason_code=LOCAL_AGENT_PROTOCOL_INCOMPATIBLE"
            )
            return
        if result.disposition == "QUARANTINED":
            error_logger.error(
                "[LOCAL_AGENT] Executor stopped "
                "reason_code=LOCAL_AGENT_EXECUTION_QUARANTINED"
            )
            return
        time.sleep(poll_seconds)


def _restore_assignment(
    run: LocalAgentJournalRun,
) -> Optional[LocalAgentJobAssignment]:
    value = run.assignment
    if not isinstance(value, dict):
        return None
    try:
        authorization_value = value["authorization"]
        if not isinstance(authorization_value, dict):
            return None
        authorization_context = LocalAgentAuthorization(
            decision=str(authorization_value["decision"]),
            evidence_id=str(authorization_value["evidence_id"]),
            evaluated_at=_parse_internal_timestamp(authorization_value["evaluated_at"]),
        )
        scopes = value["required_device_scopes"]
        if not isinstance(scopes, list):
            return None
        return LocalAgentJobAssignment(
            job_id=str(value["job_id"]),
            action=str(value["action"]),
            payload=dict(value["payload"]),
            principal=str(value["principal"]),
            workspace=str(value["workspace"]),
            device_id=str(value["device_id"]),
            trace_id=str(value["trace_id"]),
            request_id=str(value["request_id"]),
            idempotency_key=str(value["idempotency_key"]),
            authorization_context=authorization_context,
            expires_at=_parse_internal_timestamp(value["expires_at"]),
            timeout_ms=int(value["timeout_ms"]),
            required_device_scopes=tuple(str(item) for item in scopes),
            read_only=bool(value["read_only"]),
            may_modify_files=bool(value["may_modify_files"]),
            disposition=str(value["disposition"]),
            state=str(value.get("state", "RUNNING")),
            protocol_version=str(value.get("protocol_version", PROTOCOL_VERSION)),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _parse_internal_timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp is invalid")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp is invalid")
    return parsed.astimezone(timezone.utc)


def _correlation(assignment: LocalAgentJobAssignment) -> dict[str, str]:
    return {
        "traceId": assignment.trace_id,
        "requestId": assignment.request_id,
        "deviceId": assignment.device_id,
    }


def _classify_execution_error(
    error: BaseException,
) -> tuple[str, str, str, bool]:
    if isinstance(error, TimeoutError):
        return (
            "LOCAL_AGENT_COMMAND_TIMEOUT",
            "timeout",
            "The allowlisted local operation timed out.",
            True,
        )
    if isinstance(error, ProcessCancelledError):
        return (
            "LOCAL_AGENT_EXECUTION_CANCELLED",
            "cancelled",
            "The local operation stopped after its execution lease was lost.",
            False,
        )
    if isinstance(error, PermissionError):
        return (
            "LOCAL_AGENT_ACCESS_DENIED",
            "permission",
            "The local operation was denied by workspace policy.",
            False,
        )
    if isinstance(error, (ValueError, WorkspaceRegistryError)):
        return (
            "LOCAL_AGENT_VALIDATION_FAILED",
            "validation",
            "The local operation failed validation.",
            False,
        )
    if isinstance(error, LocalAgentOutputError):
        return (
            "LOCAL_AGENT_OUTPUT_LIMIT",
            "output",
            "The local operation produced output that could not be returned safely.",
            False,
        )
    return (
        "LOCAL_AGENT_EXECUTION_FAILED",
        "execution",
        "The allowlisted local operation failed.",
        False,
    )


def _sanitize_value(
    value: Any,
    *,
    workspace_root: Path,
    state: dict[str, bool],
    depth: int,
) -> Any:
    if depth > MAX_OUTPUT_DEPTH:
        state["truncated"] = True
        return "[TRUNCATED]"
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_OUTPUT_COLLECTION_ITEMS:
                state["truncated"] = True
                break
            safe_key = str(key)[:256]
            if _SENSITIVE_KEY_RE.search(safe_key):
                result[safe_key] = "[REDACTED]"
            else:
                result[safe_key] = _sanitize_value(
                    item,
                    workspace_root=workspace_root,
                    state=state,
                    depth=depth + 1,
                )
        return result
    if isinstance(value, (list, tuple)):
        if len(value) > MAX_OUTPUT_COLLECTION_ITEMS:
            state["truncated"] = True
        return [
            _sanitize_value(
                item,
                workspace_root=workspace_root,
                state=state,
                depth=depth + 1,
            )
            for item in value[:MAX_OUTPUT_COLLECTION_ITEMS]
        ]
    if isinstance(value, str):
        sanitized = _sanitize_text(value, workspace_root)
        if len(sanitized) > MAX_OUTPUT_STRING_CHARS:
            state["truncated"] = True
            return sanitized[:MAX_OUTPUT_STRING_CHARS] + "\n[TRUNCATED]"
        return sanitized
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        if value != value or value in {float("inf"), float("-inf")}:
            return None
        return value
    return str(value)[:1_024]


def _sanitize_text(value: str, workspace_root: Path) -> str:
    result = strip_unsafe_output_controls(value)
    root_text = str(workspace_root)
    for form in {root_text, root_text.replace("\\", "/")}:
        if form:
            result = result.replace(form, "<workspace>")
    result = _PRIVATE_KEY_RE.sub("[REDACTED PRIVATE KEY]", result)
    result = _BEARER_RE.sub(r"\1 [REDACTED]", result)
    result = _SECRET_ASSIGNMENT_RE.sub(r"\1\2[REDACTED]", result)
    return result


def _apply_action_truncation_marker(
    action: str,
    output: dict[str, Any],
    truncated: bool,
) -> None:
    if not truncated:
        return
    if action in {"repo.search", "tests.run"}:
        output["truncated"] = True
    elif action == "git.diff":
        output["truncated"] = True
        if isinstance(output.get("diff"), str):
            output["bytes"] = len(output["diff"].encode("utf-8"))
    elif action == "git.status":
        output["clean"] = False
        existing = output.get("message")
        prefix = f"{existing} " if isinstance(existing, str) and existing else ""
        output["message"] = (
            prefix + "Change list was truncated by the local-agent output limit."
        )[:1_000]
    elif action == "patch.preview" and isinstance(output.get("check"), dict):
        output["check"]["truncated"] = True


def _shrink_action_output(
    action: str,
    output: dict[str, Any],
    state: dict[str, bool],
) -> dict[str, Any]:
    state["truncated"] = True
    if action == "git.diff" and isinstance(output.get("diff"), str):
        output["diff"] = output["diff"][:12_000] + "\n[TRUNCATED]"
        output["bytes"] = len(output["diff"].encode("utf-8"))
        output["truncated"] = True
    elif action == "tests.run":
        for key in ("stdout", "stderr"):
            if isinstance(output.get(key), str):
                output[key] = output[key][:8_000] + "\n[TRUNCATED]"
        output["truncated"] = True
    elif action == "repo.search" and isinstance(output.get("matches"), list):
        matches = output["matches"]
        while matches and _encoded_size(output) > MAX_SANITIZED_OUTPUT_BYTES:
            matches.pop()
        output["truncated"] = True
    elif action == "git.status" and isinstance(output.get("changes"), list):
        output["clean"] = False
        existing = output.get("message")
        if not (isinstance(existing, str) and "truncated" in existing.lower()):
            prefix = f"{existing} " if isinstance(existing, str) and existing else ""
            output["message"] = (
                prefix + "Change list was truncated by the local-agent output limit."
            )[:1_000]
        changes = output["changes"]
        while changes and _encoded_size(output) > MAX_SANITIZED_OUTPUT_BYTES:
            changes.pop()
    elif action == "patch.preview" and isinstance(output.get("check"), dict):
        for key in ("stdout", "stderr"):
            if isinstance(output["check"].get(key), str):
                output["check"][key] = output["check"][key][:8_000] + "\n[TRUNCATED]"
        output["check"]["truncated"] = True
    return output


def _encoded_size(value: Any) -> int:
    try:
        return len(
            json.dumps(
                value,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
    except (TypeError, ValueError) as exc:
        raise LocalAgentOutputError("Handler output is not JSON compatible") from exc


def _bounded_duration_ms(seconds: float) -> int:
    return max(0, min(3_600_000, int(seconds * 1_000)))


def _required_config(value: Optional[str], label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Local-agent {label} is required")
    return value.strip()


def _validate_catalog_metadata(
    catalog: Mapping[str, Mapping[str, Any]],
) -> None:
    for action, contract in catalog.items():
        if (
            not isinstance(action, str)
            or not isinstance(contract, Mapping)
            or contract.get("id") != action
            or contract.get("executionTarget") != "python-daemon"
            or not isinstance(contract.get("requiresConfirmation"), bool)
            or not isinstance(contract.get("idempotent"), bool)
            or isinstance(contract.get("timeoutMs"), bool)
            or not isinstance(contract.get("timeoutMs"), int)
            or not isinstance(contract.get("requiredDeviceScopes"), list)
            or not contract.get("requiredDeviceScopes")
            or any(
                not isinstance(scope, str) or not scope
                for scope in contract["requiredDeviceScopes"]
            )
            or not isinstance(contract.get("readOnly"), bool)
            or not isinstance(contract.get("mayModifyFiles"), bool)
        ):
            raise ValueError("Generated local-agent catalog metadata is invalid")


def _parse_allowlist_environment(name: str) -> frozenset[str]:
    raw = os.environ.get(name)
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"{name} is required")
    values = frozenset(item.strip() for item in raw.split(",") if item.strip())
    if not values or not values.issubset(INITIAL_ACTIONS):
        raise ValueError(f"{name} contains an unsupported action")
    return values


def _optional_positive_int_environment(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        parsed = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 1 or parsed > 3_600:
        raise ValueError(f"{name} is out of range")
    return parsed


__all__ = [
    "INITIAL_ACTIONS",
    "LocalAgentCycleResult",
    "LocalAgentExecutionRunner",
    "LocalAgentOutputError",
    "build_local_agent_execution_runner",
    "local_agent_execution_loop",
    "sanitize_handler_output",
]
