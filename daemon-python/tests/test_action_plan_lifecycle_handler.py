"""Operation-boundary tests for Python ActionPlan lifecycle enforcement."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from arcanos.action_plan_handler import handle_action_plan


@pytest.fixture(autouse=True)
def _enable_historical_lifecycle_handler(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "arcanos.action_plan_handler.Config.ACTION_PLAN_LEGACY_CHARACTERIZATION_TEST_SEAM",
        True,
    )


def _plan_data(
    *,
    status: object = "approved",
    decision: str = "allow",
    expires_at: object = None,
    include_status: bool = True,
) -> dict[str, object]:
    overall = {"allow": 0.8, "confirm": 0.5, "block": 0.2}[decision]
    plan: dict[str, object] = {
        "plan_id": "phase2d-plan",
        "created_by": "policy",
        "origin": "phase2d-test",
        "requires_confirmation": False,
        "expires_at": expires_at,
        "actions": [
            {
                "action_id": "phase2d-action",
                "agent_id": "phase2d-agent",
                "capability": "terminal.run",
                "params": {"command": "echo phase2d"},
            }
        ],
        "metadata": {
            "clear_score": {"decision": decision, "overall": overall},
            "clear_decision": decision,
        },
    }
    if include_status:
        plan["status"] = status
    return plan


def _effects() -> tuple[MagicMock, MagicMock, MagicMock, MagicMock]:
    console = MagicMock()
    backend = MagicMock()
    backend._request_json = MagicMock(
        return_value=MagicMock(ok=True, value={})
    )
    run_handler = MagicMock()
    confirm_prompt = MagicMock(return_value=True)
    return console, backend, run_handler, confirm_prompt


@pytest.mark.parametrize(
    ("status", "decision", "expires_at", "include_status", "category"),
    [
        pytest.param(
            "blocked",
            "allow",
            None,
            True,
            "ACTION_PLAN_STATE_INVALID",
            id="blocked-allow",
        ),
        pytest.param(
            "blocked",
            "confirm",
            None,
            True,
            "ACTION_PLAN_STATE_INVALID",
            id="blocked-confirm",
        ),
        pytest.param(
            "planned",
            "allow",
            None,
            True,
            "ACTION_PLAN_TRANSITION_FORBIDDEN",
            id="planned-allow",
        ),
        pytest.param(
            "awaiting_confirmation",
            "confirm",
            None,
            True,
            "ACTION_PLAN_CONFIRMATION_REQUIRED",
            id="awaiting-confirmation-confirm",
        ),
        pytest.param(
            "in_progress",
            "allow",
            None,
            True,
            "ACTION_PLAN_TRANSITION_FORBIDDEN",
            id="in-progress-allow",
        ),
        pytest.param(
            "completed",
            "allow",
            None,
            True,
            "ACTION_PLAN_TERMINAL",
            id="completed-allow",
        ),
        pytest.param(
            "failed",
            "block",
            None,
            True,
            "ACTION_PLAN_TERMINAL",
            id="failed-block",
        ),
        pytest.param(
            "expired",
            "allow",
            "2000-01-01T00:00:00Z",
            True,
            "ACTION_PLAN_TERMINAL",
            id="expired-allow",
        ),
        pytest.param(
            None,
            "allow",
            None,
            False,
            "ACTION_PLAN_STATE_UNAVAILABLE",
            id="missing-status",
        ),
        pytest.param(
            None,
            "allow",
            None,
            True,
            "ACTION_PLAN_STATE_INVALID",
            id="null-status",
        ),
        pytest.param(
            "PHASE2D_STATUS_SENTINEL",
            "allow",
            None,
            True,
            "ACTION_PLAN_STATE_INVALID",
            id="unknown-status",
        ),
        pytest.param(
            "cancelled",
            "allow",
            None,
            True,
            "ACTION_PLAN_STATE_INVALID",
            id="unsupported-cancelled",
        ),
        pytest.param(
            7,
            "allow",
            None,
            True,
            "ACTION_PLAN_STATE_INVALID",
            id="non-string-status",
        ),
        pytest.param(
            "approved",
            "allow",
            "not-a-timestamp",
            True,
            "ACTION_PLAN_STATE_INVALID",
            id="malformed-expiry",
        ),
        pytest.param(
            "approved",
            "allow",
            "2000-01-01T00:00:00Z",
            True,
            "ACTION_PLAN_TERMINAL",
            id="elapsed-expiry",
        ),
    ],
)
def test_invalid_or_forbidden_lifecycle_stops_before_every_effect(
    status: object,
    decision: str,
    expires_at: object,
    include_status: bool,
    category: str,
) -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    with (
        patch(
            "arcanos.action_plan_handler._show_clear_summary"
        ) as show_clear_summary,
        patch("arcanos.action_plan_handler.error_logger.error") as error_log,
    ):
        handle_action_plan(
            _plan_data(
                status=status,
                decision=decision,
                expires_at=expires_at,
                include_status=include_status,
            ),
            console,
            backend,
            "phase2d-instance",
            run_handler,
            confirm_prompt,
        )

    show_clear_summary.assert_not_called()
    confirm_prompt.assert_not_called()
    run_handler.assert_not_called()
    backend._request_json.assert_not_called()

    console_output = repr(console.print.call_args_list)
    diagnostic_output = repr(error_log.call_args_list)
    assert category in console_output
    assert "Executing ActionPlan" not in console_output
    assert "completed" not in console_output
    assert "success" not in console_output.lower()
    assert "PHASE2D_STATUS_SENTINEL" not in console_output
    assert "PHASE2D_STATUS_SENTINEL" not in diagnostic_output


def test_repeated_block_is_idempotent_and_does_not_write() -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    handle_action_plan(
        _plan_data(status="blocked", decision="block"),
        console,
        backend,
        "phase2d-instance",
        run_handler,
        confirm_prompt,
    )

    confirm_prompt.assert_not_called()
    run_handler.assert_not_called()
    backend._request_json.assert_not_called()
    assert "already blocked" in repr(console.print.call_args_list)


@pytest.mark.parametrize(
    "status",
    ["planned", "awaiting_confirmation", "approved", "in_progress"],
)
def test_authoritative_block_performs_exactly_one_block_callback(
    status: str,
) -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    handle_action_plan(
        _plan_data(status=status, decision="block"),
        console,
        backend,
        "phase2d-instance",
        run_handler,
        confirm_prompt,
    )

    confirm_prompt.assert_not_called()
    run_handler.assert_not_called()
    backend._request_json.assert_called_once_with(
        "POST",
        "/plans/phase2d-plan/block",
        {},
    )


@pytest.mark.parametrize(
    ("decision", "confirmation_count"),
    [pytest.param("allow", 1), pytest.param("confirm", 2)],
)
def test_approved_execution_behavior_is_preserved(
    decision: str,
    confirmation_count: int,
) -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    handle_action_plan(
        _plan_data(status="approved", decision=decision),
        console,
        backend,
        "phase2d-instance",
        run_handler,
        confirm_prompt,
    )

    assert confirm_prompt.call_count == confirmation_count
    run_handler.assert_called_once_with("echo phase2d")
    backend._request_json.assert_called_once()
    assert (
        backend._request_json.call_args.args[1]
        == "/plans/phase2d-plan/execute"
    )
    assert "completed" in repr(console.print.call_args_list)


@pytest.mark.parametrize(
    "plan_id",
    [
        None,
        7,
        True,
        "",
        "   ",
        "plan/escape",
        "plan?query",
        "snowman-☃",
        "p" * 129,
    ],
)
def test_missing_or_malformed_plan_identity_stops_before_every_effect(
    plan_id: object,
) -> None:
    console, backend, run_handler, confirm_prompt = _effects()
    plan = _plan_data(status="approved", decision="allow")
    plan["plan_id"] = plan_id

    with patch(
        "arcanos.action_plan_handler._show_clear_summary"
    ) as show_summary:
        handle_action_plan(
            plan,
            console,
            backend,
            "phase2d-instance",
            run_handler,
            confirm_prompt,
        )

    show_summary.assert_not_called()
    confirm_prompt.assert_not_called()
    run_handler.assert_not_called()
    backend._request_json.assert_not_called()
    assert "ACTION_PLAN_STATE_UNAVAILABLE" in repr(
        console.print.call_args_list
    )


@pytest.mark.parametrize("requires_confirmation", [None, 0, "false", [], {}])
def test_malformed_confirmation_requirement_stops_before_every_effect(
    requires_confirmation: object,
) -> None:
    console, backend, run_handler, confirm_prompt = _effects()
    plan = _plan_data(status="approved", decision="allow")
    plan["requires_confirmation"] = requires_confirmation

    handle_action_plan(
        plan,
        console,
        backend,
        "phase2d-instance",
        run_handler,
        confirm_prompt,
    )

    confirm_prompt.assert_not_called()
    run_handler.assert_not_called()
    backend._request_json.assert_not_called()
    assert "Failed to parse ActionPlan" in repr(console.print.call_args_list)


def test_lifecycle_denial_is_stable_when_diagnostic_logging_fails() -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    with patch(
        "arcanos.action_plan_handler.error_logger.error",
        side_effect=RuntimeError("phase2d logger failure"),
    ):
        handle_action_plan(
            _plan_data(status="blocked", decision="allow"),
            console,
            backend,
            "phase2d-instance",
            run_handler,
            confirm_prompt,
        )

    confirm_prompt.assert_not_called()
    run_handler.assert_not_called()
    backend._request_json.assert_not_called()
    assert "ACTION_PLAN_STATE_INVALID" in repr(console.print.call_args_list)


def test_allowed_execution_is_stable_when_diagnostic_logging_fails() -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    with patch(
        "arcanos.action_plan_handler.error_logger.info",
        side_effect=RuntimeError("phase2d logger failure"),
    ):
        handle_action_plan(
            _plan_data(status="approved", decision="allow"),
            console,
            backend,
            "phase2d-instance",
            run_handler,
            confirm_prompt,
        )

    run_handler.assert_called_once_with("echo phase2d")
    backend._request_json.assert_called_once()
    assert "completed" in repr(console.print.call_args_list)


def test_block_callback_failure_log_does_not_disclose_exception_message() -> (
    None
):
    console, backend, run_handler, confirm_prompt = _effects()
    disclosure_sentinel = "phase2d-block-callback-private-path"
    backend._request_json.side_effect = RuntimeError(disclosure_sentinel)

    with patch("arcanos.action_plan_handler.error_logger.error") as error_log:
        handle_action_plan(
            _plan_data(status="approved", decision="block"),
            console,
            backend,
            "phase2d-instance",
            run_handler,
            confirm_prompt,
        )

    confirm_prompt.assert_not_called()
    run_handler.assert_not_called()
    assert disclosure_sentinel not in repr(error_log.call_args_list)
    assert "ACTION_PLAN_BLOCK_CALLBACK_FAILED" in repr(
        error_log.call_args_list
    )
