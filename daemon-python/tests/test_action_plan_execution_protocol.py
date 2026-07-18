"""Decision tests for the dedicated Phase 2E Python protocol client."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from arcanos.action_plan_execution_protocol import (
    ActionPlanExecutionProtocolClient,
    parse_acceptance,
    parse_assignment,
    parse_protocol_capability,
    parse_result_read,
    parse_start,
    parse_status,
)
from arcanos.backend_client import plans

EXECUTOR_TOKEN = "executor-token-sentinel-0000000000"


def _response(payload: object, status: int = 200) -> SimpleNamespace:
    encoded = json.dumps(payload).encode("utf-8")
    return SimpleNamespace(
        status_code=status,
        headers={
            "Content-Length": str(len(encoded)),
            "Content-Type": "application/json; charset=utf-8",
        },
        content=encoded,
        json=lambda: payload,
    )


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


def _assignment(**overrides: object) -> dict[str, object]:
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
            "params": {"command": "echo safe"},
            "timeout_ms": 1000,
        },
    }
    payload.update(overrides)
    return payload


def _run_response(code: str, **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "ok": True,
        "code": code,
        "protocol_version": "action-plan-execution-v1",
        "execution_realm": "local:test",
        "plan_id": "plan-1",
        "run_id": "run-1",
        "action_id": "action-1",
        "snapshot_id": "snapshot-1",
    }
    payload.update(overrides)
    return payload


@pytest.mark.parametrize(
    ("payload", "parser"),
    [
        (
            _capability(code="ACTION_PLAN_EXECUTION_STATUS"),
            lambda payload: parse_protocol_capability(payload),
        ),
        (
            _assignment(code="ACTION_PLAN_EXECUTION_STATUS"),
            lambda payload: parse_assignment(payload, expected_realm="local:test"),
        ),
        (
            _run_response(
                "ACTION_PLAN_EXECUTION_STATUS",
                state="RUNNING",
                disposition="STARTED",
            ),
            lambda payload: parse_start(
                payload,
                plan_id="plan-1",
                run_id="run-1",
                action_id="action-1",
                expected_realm="local:test",
            ),
        ),
        (
            _run_response(
                "ACTION_PLAN_EXECUTION_STATUS",
                state="SUCCEEDED",
                terminal_category="succeeded",
                disposition="RESULT_ACCEPTED",
                acceptance_receipt="receipt-1",
            ),
            lambda payload: parse_acceptance(
                payload,
                plan_id="plan-1",
                run_id="run-1",
                action_id="action-1",
                snapshot_id="snapshot-1",
                expected_outcome="succeeded",
                expected_realm="local:test",
            ),
        ),
        (
            _run_response(
                "ACTION_PLAN_EXECUTION_RESULT",
                state="RUNNING",
                acceptance_receipt=None,
            ),
            lambda payload: parse_status(
                payload,
                plan_id="plan-1",
                run_id="run-1",
                action_id="action-1",
                snapshot_id="snapshot-1",
                expected_realm="local:test",
            ),
        ),
        (
            _run_response(
                "ACTION_PLAN_EXECUTION_STATUS",
                state="SUCCEEDED",
                terminal_category="succeeded",
                outcome="succeeded",
                acceptance_receipt="receipt-1",
            ),
            lambda payload: parse_result_read(
                payload,
                plan_id="plan-1",
                run_id="run-1",
                action_id="action-1",
                snapshot_id="snapshot-1",
                expected_realm="local:test",
            ),
        ),
    ],
)
def test_success_response_parsers_reject_another_operations_stable_code(
    payload: dict[str, object],
    parser,
) -> None:
    with pytest.raises(ValueError, match="protocol response code is invalid"):
        parser(payload)


def test_client_uses_executor_bearer_and_never_execute_result_route() -> None:
    sender = MagicMock(return_value=_response({"ok": True, "code": "ACCEPTED"}))
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: EXECUTOR_TOKEN,
        request_sender=sender,
    )

    client.submit_result(
        "plan-1",
        "run-1",
        {
            "action_id": "action-1",
            "snapshot_id": "snapshot-1",
            "outcome": "failed",
        },
        "result-key",
    )

    args, kwargs = sender.call_args
    assert args[:2] == (
        "POST",
        "https://backend.example/plans/plan-1/executions/run-1/result",
    )
    assert kwargs["headers"]["Authorization"] == f"Bearer {EXECUTOR_TOKEN}"
    assert kwargs["headers"]["Idempotency-Key"] == "result-key"
    assert kwargs["allow_redirects"] is False
    assert "/execute" not in args[1]


def test_client_fails_closed_without_executor_token() -> None:
    sender = MagicMock()
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: None,
        request_sender=sender,
    )

    response = client.claim_next("claim-key")

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "ACTION_PLAN_EXECUTION_AUTH_REQUIRED"
    sender.assert_not_called()


def test_client_rejects_idempotency_key_with_internal_space() -> None:
    sender = MagicMock()
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: EXECUTOR_TOKEN,
        request_sender=sender,
    )

    response = client.claim_next("claim key")

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "ACTION_PLAN_EXECUTION_REQUEST_INVALID"
    sender.assert_not_called()


@pytest.mark.parametrize(
    "token",
    ["x" * 31, "x" * 4097, " " + ("x" * 32), ("x" * 32) + " "],
)
def test_client_fails_closed_for_out_of_contract_executor_token(
    token: str,
) -> None:
    sender = MagicMock()
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: token,
        request_sender=sender,
    )

    response = client.claim_next("claim-key")

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "ACTION_PLAN_EXECUTION_AUTH_REQUIRED"
    assert token not in repr(response)
    sender.assert_not_called()


@pytest.mark.parametrize("length", [32, 4096])
def test_client_accepts_executor_token_contract_boundaries(length: int) -> None:
    sender = MagicMock(return_value=_response({"ok": True, "code": "ACCEPTED"}))
    token = "x" * length
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: token,
        request_sender=sender,
    )

    response = client.get_capability()

    assert response.ok is True
    sender.assert_called_once()


def test_client_rejects_result_owner_fields_without_network_call() -> None:
    sender = MagicMock()
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: EXECUTOR_TOKEN,
        request_sender=sender,
    )

    response = client.submit_result(
        "plan-1",
        "run-1",
        {
            "action_id": "action-1",
            "snapshot_id": "snapshot-1",
            "outcome": "succeeded",
            "executor_kind": "caller-selected",
        },
        "result-key",
    )

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "ACTION_PLAN_EXECUTION_REQUEST_INVALID"
    sender.assert_not_called()


def test_client_does_not_disclose_remote_exception_body() -> None:
    sentinel = "credential=TOP-SECRET /private/path SELECT * FROM secrets"
    sender = MagicMock(
        return_value=_response(
            {
                "ok": False,
                "code": "ACTION_PLAN_EXECUTION_FORBIDDEN",
                "message": sentinel,
            },
            status=403,
        )
    )
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: EXECUTOR_TOKEN,
        request_sender=sender,
    )

    response = client.get_status("plan-1", "run-1")

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "ACTION_PLAN_EXECUTION_FORBIDDEN"
    assert sentinel not in repr(response)


def test_client_uses_nested_stable_error_code_without_disclosing_body() -> None:
    sentinel = "credential=TOP-SECRET /private/path SELECT * FROM secrets"
    sender = MagicMock(
        return_value=_response(
            {
                "ok": False,
                "error": {
                    "code": "ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED",
                    "message": sentinel,
                },
            },
            status=503,
        )
    )
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: EXECUTOR_TOKEN,
        request_sender=sender,
    )

    response = client.get_status("plan-1", "run-1")

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED"
    assert sentinel not in repr(response)


def test_client_rejects_oversized_response_before_parsing() -> None:
    response = SimpleNamespace(
        status_code=200,
        headers={
            "Content-Length": str(65 * 1024),
            "Content-Type": "application/json",
        },
        content=b"{}",
        json=MagicMock(return_value={"ok": True}),
    )
    client = ActionPlanExecutionProtocolClient(
        "https://backend.example",
        lambda: EXECUTOR_TOKEN,
        request_sender=MagicMock(return_value=response),
    )

    result = client.get_capability()

    assert result.ok is False
    assert result.error is not None
    assert result.error.kind == "ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE"
    response.json.assert_not_called()


def test_legacy_result_facade_fails_closed_independent_of_phase2e_activation() -> None:
    legacy_client = MagicMock()
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            plans.Config,
            "ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED",
            False,
        )
        response = plans.submit_execution_result(
            legacy_client,
            "plan-1",
            {"status": "success"},
        )

    assert response.ok is False
    assert response.error is not None
    assert response.error.kind == "ACTION_PLAN_RESULT_ENDPOINT_REQUIRED"
    legacy_client._request_json.assert_not_called()


def test_protocol_and_assignment_parsers_require_pinned_identity() -> None:
    capability = parse_protocol_capability(_capability())
    assignment = parse_assignment(_assignment(), expected_realm="local:test")

    assert capability.executor_principal_id == "executor-principal"
    assert capability.executor_instance_id == "executor-instance"
    assert capability.assigned_agent_id == "agent-1"
    assert assignment.action_snapshot["params"] == {"command": "echo safe"}


def test_protocol_capability_accepts_drain_only_recovery_operations() -> None:
    capability = parse_protocol_capability(
        _capability(operations=["start", "submit-result", "read-status", "read-result"])
    )
    assert capability.permitted_operations == (
        "start",
        "submit-result",
        "read-status",
        "read-result",
    )


@pytest.mark.parametrize(
    "operations",
    [
        ["submit-result"],
        ["read-status", "read-status"],
        ["read-status", "unknown-operation"],
    ],
)
def test_protocol_capability_rejects_incomplete_duplicate_or_unknown_operations(
    operations: list[str],
) -> None:
    with pytest.raises(ValueError):
        parse_protocol_capability(_capability(operations=operations))


@pytest.mark.parametrize(
    "payload",
    [
        _assignment(execution_realm="local:other"),
        _assignment(plan_execution_generation=True),
        _assignment(state="RUNNING"),
        _assignment(disposition="CLAIM_REPLAY_RUNNING"),
        _assignment(
            assignment={
                "agent_id": "agent-1",
                "capability": "terminal.run",
                "params": {"command": "echo safe", "value": float("nan")},
            }
        ),
    ],
)
def test_assignment_parser_rejects_untrusted_or_non_executable_shape(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        parse_assignment(payload, expected_realm="local:test")


@pytest.mark.parametrize(
    "payload",
    [
        _assignment(snapshot_version="action-execution-snapshot-v2"),
        _assignment(lifecycle={"status": "approved", "expires_at": "not-a-date"}),
        _assignment(
            lifecycle={
                "status": "approved",
                "expires_at": "2026-07-17T11:59:59Z",
            }
        ),
        _assignment(
            policy={
                "category": "ALLOW",
                "evidence_id": "clear-evidence-1",
                "evaluated_at": "2026-07-17T12:00:00",
            }
        ),
    ],
)
def test_assignment_parser_rejects_incompatible_or_stale_authority(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        parse_assignment(
            payload,
            expected_realm="local:test",
            now=datetime(2026, 7, 17, 12, 0, tzinfo=timezone.utc),
        )


def test_assignment_parser_accepts_unexpired_offset_timestamp() -> None:
    parsed = parse_assignment(
        _assignment(
            lifecycle={
                "status": "approved",
                "expires_at": "2026-07-17T08:00:01-04:00",
            }
        ),
        expected_realm="local:test",
        now=datetime(2026, 7, 17, 12, 0, tzinfo=timezone.utc),
    )

    assert parsed.lifecycle["expires_at"] == "2026-07-17T08:00:01-04:00"


@pytest.mark.parametrize("disposition", ["STARTED", "START_REPLAY"])
def test_start_parser_accepts_canonical_initial_and_replay_dispositions(
    disposition: str,
) -> None:
    parsed = parse_start(
        {
            "ok": True,
            "code": "ACTION_PLAN_EXECUTION_STARTED",
            "protocol_version": "action-plan-execution-v1",
            "execution_realm": "local:test",
            "plan_id": "plan-1",
            "run_id": "run-1",
            "action_id": "action-1",
            "state": "RUNNING",
            "disposition": disposition,
        },
        plan_id="plan-1",
        run_id="run-1",
        action_id="action-1",
        expected_realm="local:test",
    )

    assert parsed.disposition == disposition


def test_acceptance_requires_ok_code_receipt_and_matching_terminal_state() -> None:
    accepted = parse_acceptance(
        {
            "ok": True,
            "code": "ACTION_PLAN_EXECUTION_RESULT_ACCEPTED",
            "protocol_version": "action-plan-execution-v1",
            "execution_realm": "local:test",
            "plan_id": "plan-1",
            "run_id": "run-1",
            "action_id": "action-1",
            "snapshot_id": "snapshot-1",
            "state": "FAILED",
            "terminal_category": "failed",
            "disposition": "RESULT_ACCEPTED",
            "acceptance_receipt": "receipt-1",
        },
        plan_id="plan-1",
        run_id="run-1",
        action_id="action-1",
        snapshot_id="snapshot-1",
        expected_outcome="failed",
        expected_realm="local:test",
    )
    assert accepted.acceptance_receipt == "receipt-1"

    with pytest.raises(ValueError):
        parse_acceptance(
            {
                "ok": True,
                "code": "ACTION_PLAN_EXECUTION_RESULT_ACCEPTED",
                "protocol_version": "action-plan-execution-v1",
                "execution_realm": "local:test",
                "run_id": "run-1",
                "state": "SUCCEEDED",
                "disposition": "ACCEPTED",
            },
            plan_id="plan-1",
            run_id="run-1",
            action_id="action-1",
            snapshot_id="snapshot-1",
            expected_outcome="succeeded",
            expected_realm="local:test",
        )
