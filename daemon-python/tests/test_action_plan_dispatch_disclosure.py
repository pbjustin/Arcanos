"""Credential-disclosure regression tests for daemon ActionPlan dispatch."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from arcanos import cli_daemon
from arcanos.cli import daemon_ops
from arcanos.cli_types import DaemonCommand


_CREDENTIAL_SENTINEL = "PHASE2C_SYNTHETIC_CREDENTIAL_MARKER"


@pytest.mark.parametrize(
    "dispatch",
    [
        pytest.param(daemon_ops.handle_daemon_command, id="current-daemon-ops"),
        pytest.param(cli_daemon.handle_daemon_command, id="legacy-cli-daemon"),
    ],
)
def test_action_plan_dispatch_does_not_record_payload_credentials(dispatch) -> None:
    """Neither daemon dispatcher may copy an ActionPlan payload into activity detail."""
    cli = MagicMock()
    cli.instance_id = "phase2c-test-instance"
    command = DaemonCommand(
        id="phase2c-command",
        name="action_plan",
        payload={
            "plan_id": "phase2c-plan",
            "metadata": {
                "clear_score": {
                    "overall": 0.8,
                    "decision": "allow",
                    "notes": _CREDENTIAL_SENTINEL,
                },
            },
        },
        issuedAt="2026-01-01T00:00:00Z",
    )

    with patch("arcanos.action_plan_handler.handle_action_plan") as mock_handler:
        dispatch(cli, command)

    cli._append_activity.assert_called_once()
    activity_kind, activity_detail = cli._append_activity.call_args.args
    assert activity_kind == "command"
    assert "action_plan" in activity_detail
    assert _CREDENTIAL_SENTINEL not in activity_detail
    mock_handler.assert_called_once()
