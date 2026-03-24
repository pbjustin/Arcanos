"""Tests for ActionPlan handler."""

import pytest
from unittest.mock import MagicMock, patch
from arcanos.action_plan_handler import handle_action_plan


class TestHandleActionPlan:
    def setup_method(self):
        self.console = MagicMock()
        self.backend_client = MagicMock()
        self.backend_client._request_json = MagicMock(
            return_value=MagicMock(ok=True, value={})
        )
        self.run_handler = MagicMock()
        self.confirm_prompt = MagicMock(return_value=True)

    def _make_plan_data(self, decision="allow", requires_confirmation=False):
        return {
            "plan_id": "plan-test",
            "created_by": "user",
            "origin": "test",
            "status": "approved",
            "confidence": 0.8,
            "requires_confirmation": requires_confirmation,
            "idempotency_key": "key-1",
            "actions": [
                {
                    "action_id": "a1",
                    "agent_id": "agent-1",
                    "capability": "terminal.run",
                    "params": {"command": "echo hello"},
                }
            ],
            "metadata": {
                "clear_score": {
                    "clarity": 0.9,
                    "leverage": 0.8,
                    "efficiency": 0.7,
                    "alignment": 0.85,
                    "resilience": 0.75,
                    "overall": 0.82 if decision == "allow" else 0.5 if decision == "confirm" else 0.2,
                    "decision": decision,
                },
                "clear_decision": decision,
            },
        }

    def test_executes_allowed_plan(self):
        plan_data = self._make_plan_data("allow")
        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        self.run_handler.assert_called_once_with("echo hello")

    def test_rejects_blocked_plan(self):
        plan_data = self._make_plan_data("block")
        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        self.run_handler.assert_not_called()
        # Should print rejection message
        calls = [str(c) for c in self.console.print.call_args_list]
        assert any("BLOCKED" in c for c in calls)

    def test_requires_confirmation_for_confirm_decision(self):
        plan_data = self._make_plan_data("confirm", requires_confirmation=True)
        self.confirm_prompt.return_value = True

        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        self.confirm_prompt.assert_called_once()
        self.run_handler.assert_called_once()

    def test_user_can_reject_confirmation(self):
        plan_data = self._make_plan_data("confirm", requires_confirmation=True)
        self.confirm_prompt.return_value = False

        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        self.run_handler.assert_not_called()

    def test_shows_clear_summary(self):
        plan_data = self._make_plan_data("allow")
        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        # Should have printed a table (CLEAR summary)
        assert self.console.print.call_count >= 1

    def test_handles_invalid_plan_data(self):
        handle_action_plan(
            {"invalid": True}, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        # Should not crash, should print error
        self.run_handler.assert_not_called()

    def test_handles_unsupported_capability(self):
        plan_data = self._make_plan_data("allow")
        plan_data["actions"][0]["capability"] = "unknown.cap"
        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        self.run_handler.assert_not_called()
        calls = [str(c) for c in self.console.print.call_args_list]
        assert any("Unsupported" in c for c in calls)
