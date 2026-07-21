"""Historical ActionPlan execution-ownership characterization.

These tests preserve the pre-Phase 2E behavior at commit
410c04a890c021ae51148e58391f8e653be11943. They intentionally describe the
existing command/result boundary and daemon acknowledgement ordering; they do
not define the desired ownership contract for the Phase 2E correction.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from arcanos.action_plan_handler import handle_action_plan
from arcanos.backend_client_models import BackendRequestError, BackendResponse
from arcanos.cli import daemon_ops

HISTORICAL_SOURCE_COMMIT = "410c04a890c021ae51148e58391f8e653be11943"


@pytest.fixture(autouse=True)
def _enable_immutable_historical_seam(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "arcanos.action_plan_handler.Config.ACTION_PLAN_LEGACY_CHARACTERIZATION_TEST_SEAM",
        True,
    )


def _approved_allow_plan(
    *, capability: str = "terminal.run"
) -> dict[str, object]:
    return {
        "plan_id": "phase2e-plan",
        "created_by": "policy",
        "origin": "phase2e-characterization",
        "status": "approved",
        "requires_confirmation": False,
        "actions": [
            {
                "action_id": "phase2e-action",
                "agent_id": "phase2e-agent",
                "capability": capability,
                "params": {"command": "echo phase2e"},
            }
        ],
        "metadata": {
            "clear_score": {"decision": "allow", "overall": 0.8},
            "clear_decision": "allow",
        },
    }


def _effects(
    backend_response: BackendResponse[object] | None = None,
) -> tuple[MagicMock, MagicMock, MagicMock, MagicMock]:
    console = MagicMock()
    backend = MagicMock()
    backend._request_json = MagicMock(
        return_value=backend_response or BackendResponse(ok=True, value={})
    )
    run_handler = MagicMock()
    confirm_prompt = MagicMock(return_value=True)
    return console, backend, run_handler, confirm_prompt


def test_historical_local_result_posts_to_plan_execute_command_path() -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    handle_action_plan(
        _approved_allow_plan(),
        console,
        backend,
        "phase2e-instance",
        run_handler,
        confirm_prompt,
    )

    backend._request_json.assert_called_once()
    method, path, payload = backend._request_json.call_args.args
    assert method == "POST"
    assert path == "/plans/phase2e-plan/execute"
    assert payload["plan_id"] == "phase2e-plan"
    assert payload["action_id"] == "phase2e-action"
    assert payload["agent_id"] == "phase2e-instance"
    assert payload["status"] == "success"
    assert payload["output"]["command_sha256"]
    assert payload["execution_id"]
    assert payload["timestamp"]
    assert "completed" in repr(console.print.call_args_list)


def test_historical_failed_action_posts_failure_to_execute_command() -> None:
    console, backend, run_handler, confirm_prompt = _effects()

    handle_action_plan(
        _approved_allow_plan(capability="unsupported.phase2e"),
        console,
        backend,
        "phase2e-instance",
        run_handler,
        confirm_prompt,
    )

    run_handler.assert_not_called()
    confirm_prompt.assert_not_called()
    backend._request_json.assert_called_once()
    method, path, payload = backend._request_json.call_args.args
    assert method == "POST"
    assert path == "/plans/phase2e-plan/execute"
    assert payload["status"] == "failure"
    assert payload["error"] == {
        "reason": "Unsupported capability: unsupported.phase2e"
    }
    assert "completed" in repr(console.print.call_args_list)


def test_historical_backend_rejection_still_emits_completion() -> None:
    failure = BackendResponse(
        ok=False,
        error=BackendRequestError(
            kind="http",
            message="historical durable result rejection",
            status_code=503,
        ),
    )
    console, backend, run_handler, confirm_prompt = _effects(failure)

    with patch("arcanos.action_plan_handler.error_logger.error") as error_log:
        handle_action_plan(
            _approved_allow_plan(),
            console,
            backend,
            "phase2e-instance",
            run_handler,
            confirm_prompt,
        )

    backend._request_json.assert_called_once()
    error_log.assert_not_called()
    assert "success" in repr(console.print.call_args_list)
    assert "completed" in repr(console.print.call_args_list)


def test_historical_poller_acks_after_result_submission_raises() -> None:
    events: list[str] = []
    console = MagicMock()
    backend = MagicMock()
    backend._request_json = MagicMock()

    cli = SimpleNamespace(
        _daemon_running=True,
        _command_poll_interval=0,
        backend_client=backend,
        instance_id="phase2e-instance",
        console=console,
        handle_run=MagicMock(),
        _confirm_action=MagicMock(return_value=True),
        _append_activity=MagicMock(),
    )

    def handle_command(command: object) -> None:
        daemon_ops.handle_daemon_command(cli, command)

    cli._handle_daemon_command = handle_command

    poll_response = SimpleNamespace(
        status_code=200,
        headers={},
        json=lambda: {
            "commands": [
                {
                    "id": "phase2e-command",
                    "name": "action_plan",
                    "payload": _approved_allow_plan(
                        capability="unsupported.phase2e"
                    ),
                    "issuedAt": "2026-07-17T00:00:00.000Z",
                }
            ]
        },
    )
    ack_response = SimpleNamespace(status_code=200, headers={})

    def submit_result(*_args: object, **_kwargs: object) -> None:
        events.append("result-submission-failed")
        raise OSError("historical durable result submission failure")

    def make_raw_request(
        method: str,
        path: str,
        **kwargs: object,
    ) -> object:
        if method == "GET":
            events.append("poll")
            return poll_response
        assert method == "POST"
        assert path == "/api/daemon/commands/ack"
        assert kwargs["json"] == {
            "commandIds": ["phase2e-command"],
            "instanceId": "phase2e-instance",
        }
        events.append("ack")
        cli._daemon_running = False
        return ack_response

    backend._request_json.side_effect = submit_result
    backend.make_raw_request.side_effect = make_raw_request

    with (
        patch("arcanos.cli.daemon_ops.time.sleep", return_value=None),
        patch("arcanos.action_plan_handler.error_logger.error"),
    ):
        daemon_ops.command_poll_loop(cli)

    assert events == ["poll", "result-submission-failed", "ack"]
    backend._request_json.assert_called_once()
    assert "completed" in repr(console.print.call_args_list)
    assert HISTORICAL_SOURCE_COMMIT == (
        "410c04a890c021ae51148e58391f8e653be11943"
    )
