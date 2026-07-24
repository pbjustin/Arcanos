"""Focused tests for the outbound local-agent protocol and recovery runner."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping, Optional
from unittest.mock import MagicMock

import pytest

from arcanos.backend_client_models import BackendRequestError, BackendResponse
from arcanos.cli import daemon_ops
from arcanos.local_agent.contracts import (
    load_local_agent_capability_catalog,
    validate_local_agent_input,
)
from arcanos.local_agent import journal as journal_module
from arcanos.local_agent.journal import LocalAgentExecutionJournal
from arcanos.local_agent.protocol import (
    MAX_ASSIGNMENT_BYTES,
    MAX_RESPONSE_BYTES,
    LocalAgentAuthorization,
    LocalAgentJobAssignment,
    LocalAgentProtocolClient,
    LocalAgentTerminalReplay,
    PROTOCOL_VERSION,
    parse_claim_response,
)
from arcanos.local_agent.process_runner import ProcessCancelledError
from arcanos.local_agent.runner import (
    LocalAgentExecutionRunner,
    sanitize_handler_output,
)
from arcanos.local_agent.workspace_registry import (
    RegisteredWorkspaceRegistry,
    WorkspaceRegistryError,
)

EXECUTOR_TOKEN = "local-agent-executor-token-sentinel-000000"
JOB_ID = "11111111-1111-4111-8111-111111111111"


def test_patch_catalog_limit_fits_assignment_transport() -> None:
    catalog = load_local_agent_capability_catalog()
    patch_schema = catalog["patch.apply"]["inputSchema"]["properties"]["patch"]
    patch_limit = patch_schema["maxLength"]
    assert patch_schema["maxUtf8Bytes"] == 200_000
    with pytest.raises(ValueError, match="maxUtf8Bytes"):
        validate_local_agent_input(
            "patch.apply",
            {
                "patch": "\U0010ffff" * 50_001,
                "expectedPatchSha256": "a" * 64,
            },
        )
    encoded = json.dumps(
        {
            "protocolVersion": PROTOCOL_VERSION,
            "payload": {
                "patch": "x" * patch_limit,
                "expectedPatchSha256": "a" * 64,
            },
        }
    ).encode("utf-8")

    assert len(encoded) <= MAX_ASSIGNMENT_BYTES <= MAX_RESPONSE_BYTES

    multibyte_encoded = json.dumps(
        {
            "protocolVersion": PROTOCOL_VERSION,
            "payload": {
                "patch": "\U0010ffff" * patch_limit,
                "expectedPatchSha256": "a" * 64,
            },
        },
        ensure_ascii=False,
    ).encode("utf-8")
    assert len(multibyte_encoded) <= MAX_ASSIGNMENT_BYTES


def _response(payload: object, status: int = 200) -> SimpleNamespace:
    encoded = json.dumps(payload).encode("utf-8")
    return SimpleNamespace(
        status_code=status,
        headers={
            "Content-Length": str(len(encoded)),
            "Content-Type": "application/json",
        },
        content=encoded,
        json=lambda: payload,
    )


def _assignment(
    *,
    action: str = "git.status",
    payload: Optional[dict[str, Any]] = None,
    authorization: str = "allow",
    expires_at: Optional[datetime] = None,
) -> LocalAgentJobAssignment:
    read_only = action not in {"tests.run", "patch.apply"}
    may_modify_files = not read_only
    timeout_ms = {
        "local_agent.status": 10_000,
        "repo.search": 30_000,
        "git.status": 15_000,
        "git.diff": 30_000,
        "tests.run": 900_000,
        "patch.preview": 30_000,
        "patch.apply": 60_000,
    }[action]
    return LocalAgentJobAssignment(
        job_id=JOB_ID,
        action=action,
        payload=dict(payload or {}),
        principal="requesting-principal",
        workspace="personal",
        device_id="device-1",
        trace_id="trace-1",
        request_id="request-1",
        idempotency_key="gpt-turn-1",
        authorization_context=LocalAgentAuthorization(
            decision=authorization,
            evidence_id="policy-evidence-1",
            evaluated_at=datetime.now(timezone.utc),
        ),
        expires_at=expires_at or datetime.now(timezone.utc) + timedelta(minutes=5),
        timeout_ms=timeout_ms,
        required_device_scopes=(action,),
        read_only=read_only,
        may_modify_files=may_modify_files,
        disposition="CLAIMED",
    )


def _claim_payload(assignment: LocalAgentJobAssignment) -> dict[str, Any]:
    return {
        "ok": True,
        "code": "LOCAL_AGENT_JOB_CLAIMED",
        "result": {
            "protocolVersion": PROTOCOL_VERSION,
            "disposition": assignment.disposition,
            "state": "RUNNING",
            "jobId": assignment.job_id,
            "action": assignment.action,
            "payload": assignment.payload,
            "principal": assignment.principal,
            "workspace": assignment.workspace,
            "deviceId": assignment.device_id,
            "traceId": assignment.trace_id,
            "requestId": assignment.request_id,
            "idempotencyKey": assignment.idempotency_key,
            "authorization": {
                "decision": assignment.authorization_context.decision,
                "evidenceId": assignment.authorization_context.evidence_id,
                "evaluatedAt": assignment.authorization_context.evaluated_at.isoformat(),
            },
            "expiresAt": assignment.expires_at.isoformat(),
            "timeoutMs": assignment.timeout_ms,
            "requiredDeviceScopes": list(assignment.required_device_scopes),
            "readOnly": assignment.read_only,
            "mayModifyFiles": assignment.may_modify_files,
        },
    }


def _acceptance(job_id: str, outcome: str) -> dict[str, Any]:
    return {
        "ok": True,
        "code": "LOCAL_AGENT_JOB_RESULT_ACCEPTED",
        "protocolVersion": PROTOCOL_VERSION,
        "result": {
            "jobId": job_id,
            "state": "COMPLETED" if outcome == "succeeded" else "FAILED",
            "disposition": "RESULT_ACCEPTED",
            "acceptanceReceipt": "receipt-1",
        },
    }


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    return root


@pytest.fixture
def journal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> LocalAgentExecutionJournal:
    monkeypatch.setattr(
        journal_module,
        "_secure_path",
        lambda *_args, **_kwargs: None,
    )
    return LocalAgentExecutionJournal(
        tmp_path / "private" / "local-agent.sqlite3",
        expected_device_id="device-1",
    )


def test_protocol_client_uses_only_purpose_bound_bearer() -> None:
    sender = MagicMock(return_value=_response({"ok": True}))
    client = LocalAgentProtocolClient(
        "https://backend.example",
        lambda: EXECUTOR_TOKEN,
        request_sender=sender,
    )

    response = client.claim("claim-key")

    assert response.ok is True
    args, kwargs = sender.call_args
    assert args[:2] == (
        "POST",
        "https://backend.example/gpt-access/local-agent/jobs/claim",
    )
    assert kwargs["headers"]["Authorization"] == f"Bearer {EXECUTOR_TOKEN}"
    assert kwargs["headers"]["Idempotency-Key"] == "claim-key"
    assert "principal" not in kwargs["headers"]
    assert "workspace" not in kwargs["headers"]
    assert "device" not in kwargs["headers"]
    assert kwargs["json"] == {"claimKey": "claim-key"}
    assert kwargs["allow_redirects"] is False


def test_protocol_client_stays_offline_without_executor_token() -> None:
    sender = MagicMock()
    client = LocalAgentProtocolClient(
        "https://backend.example",
        lambda: None,
        request_sender=sender,
    )

    response = client.heartbeat()

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "LOCAL_AGENT_AUTH_REQUIRED"
    sender.assert_not_called()


def test_daemon_startup_does_not_start_local_agent_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cli = SimpleNamespace(
        _daemon_running=False,
        backend_client=None,
        _heartbeat_thread=None,
        _command_poll_thread=None,
        _action_plan_execution_thread=None,
        _local_agent_execution_thread=None,
    )
    thread_factory = MagicMock()
    monkeypatch.setattr(daemon_ops.threading, "Thread", thread_factory)
    monkeypatch.setattr(daemon_ops.Config, "BACKEND_TOKEN", None)
    monkeypatch.setattr(
        daemon_ops.Config,
        "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
        False,
    )
    monkeypatch.setattr(daemon_ops.Config, "LOCAL_AGENT_ENABLED", False)

    daemon_ops.start_daemon_threads(cli)

    assert cli._daemon_running is False
    thread_factory.assert_not_called()


def test_daemon_starts_and_stops_local_agent_only_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cli = SimpleNamespace(
        _daemon_running=False,
        backend_client=None,
        _heartbeat_thread=None,
        _command_poll_thread=None,
        _action_plan_execution_thread=None,
        _local_agent_execution_thread=None,
    )
    local_thread = MagicMock()
    thread_factory = MagicMock(return_value=local_thread)
    monkeypatch.setattr(daemon_ops.threading, "Thread", thread_factory)
    monkeypatch.setattr(daemon_ops.Config, "BACKEND_TOKEN", None)
    monkeypatch.setattr(
        daemon_ops.Config,
        "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
        False,
    )
    monkeypatch.setattr(daemon_ops.Config, "LOCAL_AGENT_ENABLED", True)

    daemon_ops.start_daemon_threads(cli)

    assert cli._daemon_running is True
    thread_factory.assert_called_once()
    assert thread_factory.call_args.kwargs["name"] == "local-agent-execution-poll"
    assert callable(thread_factory.call_args.kwargs["args"][0])
    local_thread.start.assert_called_once_with()

    daemon_ops.stop_daemon_service(cli)
    assert cli._daemon_running is False
    local_thread.join.assert_called_once_with(timeout=5.0)


@pytest.mark.parametrize(
    "server_field",
    ["workspaceId", "principalId", "deviceId", "authorization", "confirmationToken"],
)
def test_claim_parser_rejects_server_controlled_fields_in_payload(
    server_field: str,
) -> None:
    assignment = _assignment(
        action="repo.search",
        payload={"query": "needle", server_field: "attacker-selected"},
    )

    with pytest.raises(ValueError, match="server-controlled"):
        parse_claim_response(_claim_payload(assignment))


def test_claim_parser_accepts_terminal_replay_without_assignment() -> None:
    replay = parse_claim_response(
        {
            "ok": True,
            "code": "LOCAL_AGENT_JOB_CLAIMED",
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "disposition": "TERMINAL_REPLAY",
                "state": "COMPLETED",
                "jobId": JOB_ID,
            },
        }
    )

    assert isinstance(replay, LocalAgentTerminalReplay)
    assert replay.job_id == JOB_ID


def test_generated_catalog_is_runtime_schema_authority() -> None:
    catalog = load_local_agent_capability_catalog()

    assert set(catalog) == {
        "local_agent.status",
        "repo.search",
        "git.status",
        "git.diff",
        "tests.run",
        "patch.preview",
        "patch.apply",
    }
    validate_local_agent_input("tests.run", {"profile": "python-unit"})
    with pytest.raises(ValueError):
        validate_local_agent_input(
            "tests.run",
            {"profile": "arbitrary-command"},
        )


class _FakeClient:
    def __init__(
        self,
        *,
        claim: Optional[LocalAgentJobAssignment | LocalAgentTerminalReplay] = None,
        online: bool = True,
        result_failures: int = 0,
        heartbeat_fail_after: Optional[int] = None,
    ) -> None:
        self.claim_value = claim
        self.online = online
        self.result_failures = result_failures
        self.heartbeat_fail_after = heartbeat_fail_after
        self.claim_calls = 0
        self.job_heartbeat_calls = 0
        self.result_calls: list[tuple[str, Mapping[str, Any], str]] = []

    def heartbeat(self) -> BackendResponse[Optional[dict[str, Any]]]:
        if not self.online:
            return BackendResponse(
                ok=False,
                error=BackendRequestError("network", "offline"),
            )
        return BackendResponse(ok=True, value={"ok": True})

    def claim(self, _claim_key: str) -> BackendResponse[Optional[dict[str, Any]]]:
        self.claim_calls += 1
        if self.claim_value is None:
            return BackendResponse(ok=True, value=None)
        if isinstance(self.claim_value, LocalAgentTerminalReplay):
            return BackendResponse(
                ok=True,
                value={
                    "ok": True,
                    "code": "LOCAL_AGENT_JOB_CLAIMED",
                    "result": {
                        "protocolVersion": PROTOCOL_VERSION,
                        "disposition": "TERMINAL_REPLAY",
                        "state": self.claim_value.state,
                        "jobId": self.claim_value.job_id,
                    },
                },
            )
        return BackendResponse(ok=True, value=_claim_payload(self.claim_value))

    def job_heartbeat(
        self,
        _job_id: str,
    ) -> BackendResponse[Optional[dict[str, Any]]]:
        self.job_heartbeat_calls += 1
        if not self.online or (
            self.heartbeat_fail_after is not None
            and self.job_heartbeat_calls >= self.heartbeat_fail_after
        ):
            return BackendResponse(
                ok=False,
                error=BackendRequestError("network", "offline"),
            )
        return BackendResponse(ok=True, value={"ok": True})

    def submit_result(
        self,
        job_id: str,
        result: Mapping[str, Any],
        result_key: str,
    ) -> BackendResponse[Optional[dict[str, Any]]]:
        self.result_calls.append((job_id, result, result_key))
        if self.result_failures > 0:
            self.result_failures -= 1
            return BackendResponse(
                ok=False,
                error=BackendRequestError("network", "offline"),
            )
        return BackendResponse(
            ok=True,
            value=_acceptance(job_id, str(result["outcome"])),
        )


def _runner(
    *,
    client: _FakeClient,
    journal: LocalAgentExecutionJournal,
    workspace: Path,
    execute_handler: Any,
    patch_factory: Any = None,
    allowed_actions: Optional[set[str]] = None,
    now_factory: Any = None,
    heartbeat_interval_seconds: float = 0,
    should_continue: Any = None,
) -> LocalAgentExecutionRunner:
    return LocalAgentExecutionRunner(
        client=client,  # type: ignore[arg-type]
        journal=journal,
        workspace_registry=RegisteredWorkspaceRegistry({"personal": workspace}),
        device_id="device-1",
        principal_id="executor-principal",
        device_scopes={
            "local_agent.status",
            "repo.search",
            "git.status",
            "git.diff",
            "tests.run",
            "patch.preview",
            "patch.apply",
        },
        allowed_actions=allowed_actions
        or {
            "local_agent.status",
            "repo.search",
            "git.status",
            "git.diff",
            "tests.run",
            "patch.preview",
            "patch.apply",
        },
        execute_handler=execute_handler,
        patch_authorization_factory=patch_factory or MagicMock(),
        key_factory=iter(
            ["claim-key", "result-key", "next-key", "another-key"]
        ).__next__,
        now_factory=now_factory or (lambda: datetime.now(timezone.utc)),
        heartbeat_interval_seconds=heartbeat_interval_seconds,
        should_continue=should_continue or (lambda: True),
    )


def test_offline_device_never_claims_or_executes(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    client = _FakeClient(claim=_assignment(), online=False)
    handler = MagicMock()
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
    )

    result = runner.run_once()

    assert result.disposition == "OFFLINE"
    assert client.claim_calls == 0
    handler.assert_not_called()


def test_terminal_replay_rotates_claim_intent_without_execution(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    client = _FakeClient(
        claim=LocalAgentTerminalReplay(job_id=JOB_ID, state="COMPLETED")
    )
    handler = MagicMock()
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
    )

    result = runner.run_once()

    assert result.disposition == "TERMINAL_REPLAY"
    assert journal.load_claim_intent() is None
    handler.assert_not_called()


def test_expired_job_is_reported_without_execution(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    assignment = _assignment(
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)
    )
    client = _FakeClient(claim=assignment)
    handler = MagicMock()
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
    )

    result = runner.run_once()

    assert result.disposition == "EXPIRED"
    handler.assert_not_called()
    assert client.result_calls == []
    expired_run = journal.load_run(assignment.job_id)
    assert expired_run is not None
    assert expired_run.state == "QUARANTINED"
    assert expired_run.reason_code == "LOCAL_AGENT_JOB_EXPIRED"


def test_expired_recovery_never_reexecutes_or_submits_result(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    assignment = _assignment(
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)
    )
    journal.save_assignment(assignment, claim_key="claim-key")
    journal.mark_execution_started(assignment.job_id)
    client = _FakeClient()
    handler = MagicMock()
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
    )

    result = runner.run_once()

    assert result.disposition == "EXPIRED"
    handler.assert_not_called()
    assert client.result_calls == []
    recovered = journal.load_run(assignment.job_id)
    assert recovered is not None
    assert recovered.state == "QUARANTINED"


def test_result_is_not_submitted_if_job_expires_during_handler(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    base_time = datetime(2026, 7, 24, 12, 0, tzinfo=timezone.utc)
    assignment = _assignment(expires_at=base_time + timedelta(minutes=5))
    client = _FakeClient(claim=assignment)
    handler = MagicMock(
        return_value={
            "clean": True,
            "changes": [],
            "gitAvailable": True,
            "workspaceType": "git",
        }
    )
    clock = iter(
        [
            base_time,
            base_time,
            base_time + timedelta(minutes=6),
        ]
    )
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
        now_factory=clock.__next__,
    )

    result = runner.run_once()

    assert result.disposition == "EXPIRED"
    handler.assert_called_once()
    assert client.result_calls == []
    recovered = journal.load_run(assignment.job_id)
    assert recovered is not None
    assert recovered.state == "QUARANTINED"


def test_pending_result_replays_without_reexecuting_handler(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    client = _FakeClient(claim=_assignment(), result_failures=1)
    handler = MagicMock(
        return_value={
            "clean": True,
            "changes": [],
            "gitAvailable": True,
            "workspaceType": "git",
        }
    )
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
    )

    first = runner.run_once()
    second = runner.run_once()

    assert first.disposition == "RETRY_RESULT"
    assert second.disposition == "ACCEPTED"
    handler.assert_called_once()
    assert len(client.result_calls) == 2
    assert client.result_calls[0][1] == client.result_calls[1][1]
    assert client.result_calls[0][2] == client.result_calls[1][2]


def test_job_heartbeat_loss_cancels_active_read_only_handler(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    client = _FakeClient(
        claim=_assignment(action="git.status"),
        heartbeat_fail_after=2,
    )

    def handler(
        _action: str,
        _payload: Mapping[str, Any],
        _workspace: Path,
        _timeout_ms: int,
        **kwargs: Any,
    ) -> Mapping[str, Any]:
        cancellation_event = kwargs["cancellation_event"]
        assert cancellation_event.wait(timeout=2)
        raise ProcessCancelledError("lease lost")

    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
        heartbeat_interval_seconds=0.01,
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    assert client.job_heartbeat_calls >= 2
    submitted = client.result_calls[0][1]
    assert submitted["outcome"] == "failed"
    assert submitted["error"]["code"] == "LOCAL_AGENT_EXECUTION_CANCELLED"


def test_unregistered_workspace_is_reported_without_execution(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    assignment = _assignment()
    assignment = LocalAgentJobAssignment(
        **{**assignment.__dict__, "workspace": "other"}
    )
    client = _FakeClient(claim=assignment)
    handler = MagicMock()
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    handler.assert_not_called()
    assert (
        client.result_calls[0][1]["error"]["code"]
        == "LOCAL_AGENT_WORKSPACE_UNREGISTERED"
    )


def test_action_missing_from_local_allowlist_is_not_executed(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    client = _FakeClient(claim=_assignment(action="git.status"))
    handler = MagicMock()
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
        allowed_actions={"git.diff"},
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    handler.assert_not_called()
    assert (
        client.result_calls[0][1]["error"]["code"] == "LOCAL_AGENT_ACTION_UNAUTHORIZED"
    )
    assert client.result_calls[0][1]["correlation"] == {
        "traceId": "trace-1",
        "requestId": "request-1",
        "deviceId": "device-1",
    }


def test_patch_apply_requires_confirmed_server_authorization(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    assignment = _assignment(
        action="patch.apply",
        payload={"patch": "diff --git a/a b/a\n", "expectedPatchSha256": "a" * 64},
        authorization="allow",
    )
    client = _FakeClient(claim=assignment)
    handler = MagicMock()
    patch_factory = MagicMock()
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
        patch_factory=patch_factory,
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    handler.assert_not_called()
    patch_factory.assert_not_called()
    assert (
        client.result_calls[0][1]["error"]["code"] == "LOCAL_AGENT_ACTION_UNAUTHORIZED"
    )


def test_patch_authorization_is_bound_to_exact_payload(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    payload = {
        "patch": "diff --git a/a b/a\n",
        "expectedPatchSha256": "a" * 64,
    }
    assignment = _assignment(
        action="patch.apply",
        payload=payload,
        authorization="confirmed",
    )
    client = _FakeClient(claim=assignment)
    authorization = object()
    patch_factory = MagicMock(return_value=authorization)
    handler = MagicMock(
        return_value={
            "patchSha256": "a" * 64,
            "files": ["a"],
            "applied": True,
        }
    )
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
        patch_factory=patch_factory,
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    patch_factory.assert_called_once_with(
        payload,
        authorization_id="policy-evidence-1",
    )
    assert handler.call_args.kwargs["mutation_authorization"] is authorization


def test_file_modifying_execution_exception_requires_manual_reconciliation(
    journal: LocalAgentExecutionJournal,
    workspace: Path,
) -> None:
    payload = {
        "patch": "diff --git a/a b/a\n",
        "expectedPatchSha256": "a" * 64,
    }
    assignment = _assignment(
        action="patch.apply",
        payload=payload,
        authorization="confirmed",
    )
    client = _FakeClient(claim=assignment)
    handler = MagicMock(side_effect=TimeoutError("execution timed out"))
    runner = _runner(
        client=client,
        journal=journal,
        workspace=workspace,
        execute_handler=handler,
        patch_factory=MagicMock(return_value=object()),
    )

    result = runner.run_once()

    assert result.disposition == "ACCEPTED"
    submitted = client.result_calls[0][1]
    assert submitted["outcome"] == "failed"
    assert submitted["error"] == {
        "code": "LOCAL_EFFECT_OUTCOME_UNKNOWN",
        "classification": "execution",
        "message": (
            "Local execution failed after a file-modifying operation began; "
            "manual reconciliation is required."
        ),
        "retryable": False,
    }


def test_output_sanitizer_redacts_credentials_and_bounds_text(
    workspace: Path,
) -> None:
    output, truncated = sanitize_handler_output(
        "tests.run",
        {
            "profile": "python-unit",
            "status": "passed",
            "exitCode": 0,
            "stdout": (
                f"{workspace}\\src Authorization: Bearer SUPERSECRETTOKEN "
                "api_key=TOPSECRET " + ("x" * 20_000)
            ),
            "stderr": "",
            "durationMs": 1,
            "truncated": False,
        },
        workspace_root=workspace,
    )

    assert "<workspace>" in output["stdout"]
    assert "SUPERSECRETTOKEN" not in output["stdout"]
    assert "TOPSECRET" not in output["stdout"]
    assert output["truncated"] is True
    assert truncated is True


def test_output_sanitizer_preserves_git_truncation_semantics(
    workspace: Path,
) -> None:
    diff_output, diff_truncated = sanitize_handler_output(
        "git.diff",
        {
            "base": "main",
            "head": "feature",
            "diff": "x" * 20_000,
            "bytes": 20_000,
            "truncated": False,
        },
        workspace_root=workspace,
    )
    status_output, status_truncated = sanitize_handler_output(
        "git.status",
        {
            "clean": False,
            "changes": [
                {
                    "path": f"file-{index}.txt",
                    "indexStatus": "M",
                    "workTreeStatus": " ",
                }
                for index in range(1_001)
            ],
            "gitAvailable": True,
            "workspaceType": "git",
        },
        workspace_root=workspace,
    )

    assert diff_output["bytes"] == len(diff_output["diff"].encode("utf-8"))
    assert diff_output["truncated"] is True
    assert diff_truncated is True
    assert 0 < len(status_output["changes"]) <= 1_000
    assert "truncated" in status_output["message"].lower()
    assert status_output["clean"] is False
    assert status_truncated is True


def test_workspace_registry_denies_traversal_secret_and_symlink_escape(
    workspace: Path,
    tmp_path: Path,
) -> None:
    registry = RegisteredWorkspaceRegistry({"personal": workspace})
    with pytest.raises(WorkspaceRegistryError):
        registry.resolve_relative("personal", "../outside.txt")
    with pytest.raises(WorkspaceRegistryError):
        registry.resolve_relative("personal", ".env", allow_missing=True)
    with pytest.raises(WorkspaceRegistryError):
        registry.resolve_relative("personal", ".git/config", allow_missing=True)

    outside = tmp_path / "outside"
    outside.mkdir()
    link = workspace / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Symbolic links are unavailable in this environment")
    with pytest.raises(
        WorkspaceRegistryError,
        match="Symbolic-link|reparse-point|escapes",
    ):
        registry.resolve_relative("personal", "link/public.txt", allow_missing=True)


def test_workspace_registry_rejects_unregistered_workspace(
    workspace: Path,
) -> None:
    registry = RegisteredWorkspaceRegistry({"personal": workspace})
    with pytest.raises(WorkspaceRegistryError, match="not registered"):
        registry.resolve("other")


def test_journal_reopen_preserves_exact_pending_result(
    journal: LocalAgentExecutionJournal,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assignment = _assignment()
    journal.save_assignment(assignment, claim_key="claim-key")
    journal.mark_execution_started(assignment.job_id)
    pending_result = {
        "protocolVersion": PROTOCOL_VERSION,
        "resultKey": "result-key",
        "outcome": "failed",
        "error": {
            "code": "LOCAL_AGENT_EXECUTION_FAILED",
            "classification": "execution",
            "message": "The allowlisted local operation failed.",
            "retryable": False,
        },
        "metrics": {"durationMs": 1, "outputTruncated": False},
        "correlation": {
            "traceId": assignment.trace_id,
            "requestId": assignment.request_id,
            "deviceId": assignment.device_id,
        },
    }
    journal.save_pending_result(
        assignment.job_id,
        result_key="result-key",
        result=pending_result,
    )
    monkeypatch.setattr(
        journal_module,
        "_secure_path",
        lambda *_args, **_kwargs: None,
    )

    reopened = LocalAgentExecutionJournal(
        journal.path,
        expected_device_id="device-1",
    )
    recoverable = reopened.list_recoverable()

    assert len(recoverable) == 1
    assert recoverable[0].result_key == "result-key"
    assert recoverable[0].pending_result == pending_result
