"""Tests for ActionPlan handler."""

import pytest
from unittest.mock import MagicMock, patch
from arcanos.action_plan_handler import handle_action_plan


_MISSING = object()
_CONVERSION_SENTINEL = "PHASE2C_SYNTHETIC_CONVERSION_MARKER"


@pytest.fixture(autouse=True)
def _enable_historical_action_plan_handler(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "arcanos.action_plan_handler.Config.ACTION_PLAN_LEGACY_CHARACTERIZATION_TEST_SEAM",
        True,
    )


class _CredentialBearingFloat:
    def __float__(self):
        raise ValueError(_CONVERSION_SENTINEL)


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

    def test_terminal_run_allowed_plan_still_requires_confirmation(self):
        plan_data = self._make_plan_data("allow")
        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        self.confirm_prompt.assert_called_once()
        self.run_handler.assert_called_once_with("echo hello")

    def test_terminal_run_rejects_without_confirmation(self):
        plan_data = self._make_plan_data("allow")
        self.confirm_prompt.return_value = False
        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )
        self.confirm_prompt.assert_called_once()
        self.run_handler.assert_not_called()

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
        assert self.confirm_prompt.call_count == 2
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
        # Missing CLEAR evidence must stop before any execution boundary.
        self.run_handler.assert_not_called()
        self.confirm_prompt.assert_not_called()
        self.backend_client._request_json.assert_not_called()
        output = " ".join(str(call) for call in self.console.print.call_args_list)
        assert "BLOCKED" not in output
        assert "Executing" not in output
        assert "completed" not in output
        assert "success" not in output.lower()

    def test_parse_conversion_failure_does_not_disclose_exception_detail(self):
        plan_data = self._make_plan_data("allow")
        plan_data["confidence"] = _CredentialBearingFloat()

        with patch("arcanos.action_plan_handler.error_logger.error") as mock_error_log:
            handle_action_plan(
                plan_data, self.console, self.backend_client,
                "inst-1", self.run_handler, self.confirm_prompt,
            )

        self.run_handler.assert_not_called()
        self.confirm_prompt.assert_not_called()
        self.backend_client._request_json.assert_not_called()
        assert _CONVERSION_SENTINEL not in repr(self.console.print.call_args_list)
        assert _CONVERSION_SENTINEL not in repr(mock_error_log.call_args_list)

    @pytest.mark.parametrize(
        ("metadata", "top_level_score"),
        [
            pytest.param({}, _MISSING, id="missing-clear-evidence"),
            pytest.param({"clear_score": {}}, _MISSING, id="empty-score"),
            pytest.param(
                {"clear_score": {"overall": 0.8}},
                _MISSING,
                id="missing-decision",
            ),
            pytest.param(
                {"clear_score": {"overall": 0.8, "decision": None}},
                _MISSING,
                id="null-decision",
            ),
            pytest.param(
                {"clear_score": {"overall": 0.8, "decision": "unknown"}},
                _MISSING,
                id="unknown-decision",
            ),
            pytest.param(
                {"clear_decision": "unknown"},
                _MISSING,
                id="unknown-metadata-decision",
            ),
            pytest.param(
                {"clear_score": {"overall": "0.8", "decision": "allow"}},
                _MISSING,
                id="malformed-score",
            ),
            pytest.param(
                {"clear_score": {"overall": 0.2, "decision": "allow"}},
                _MISSING,
                id="contradictory-result",
            ),
            pytest.param(
                {
                    "clear_score": {
                        "error": {"code": "SYNTHETIC_FAILURE", "detail": "internal-only-detail"}
                    }
                },
                _MISSING,
                id="failed-result",
            ),
            pytest.param(
                {
                    "clear_score": {"overall": 0.8, "decision": "allow"},
                    "clear_decision": "block",
                },
                _MISSING,
                id="conflicting-duplicate-decision",
            ),
            pytest.param(
                {"clear_score": {"overall": 0.8, "decision": "allow"}},
                {"overall": 0.2, "decision": "block"},
                id="conflicting-score-aliases",
            ),
            pytest.param(
                {"clear_score": {"overall": 1, "decision": "allow"}},
                {"overall": True, "decision": "allow"},
                id="boolean-shadow-for-numeric-overall",
            ),
            pytest.param(None, _MISSING, id="malformed-metadata"),
        ],
    )
    def test_non_authoritative_clear_outcomes_stop_without_block_or_execution(
        self,
        metadata,
        top_level_score,
    ):
        plan_data = self._make_plan_data("allow")
        plan_data["metadata"] = metadata
        if top_level_score is not _MISSING:
            plan_data["clearScore"] = top_level_score

        with patch("arcanos.action_plan_handler.error_logger.error") as mock_error_log:
            handle_action_plan(
                plan_data, self.console, self.backend_client,
                "inst-1", self.run_handler, self.confirm_prompt,
            )

        self.run_handler.assert_not_called()
        self.confirm_prompt.assert_not_called()
        self.backend_client._request_json.assert_not_called()

        output = " ".join(str(call) for call in self.console.print.call_args_list)
        assert "BLOCKED" not in output
        assert "Executing" not in output
        assert "completed" not in output
        assert "success" not in output.lower()
        assert "internal-only-detail" not in output
        assert "internal-only-detail" not in repr(mock_error_log.call_args_list)

    @pytest.mark.parametrize("decision", ["allow", "confirm", "block"])
    def test_unsupported_top_level_clear_decision_cannot_authorize_or_block(self, decision):
        plan_data = self._make_plan_data("allow")
        plan_data["metadata"] = {}
        plan_data["clearDecision"] = decision

        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )

        self.run_handler.assert_not_called()
        self.confirm_prompt.assert_not_called()
        self.backend_client._request_json.assert_not_called()
        output = " ".join(str(call) for call in self.console.print.call_args_list)
        assert "BLOCKED" not in output
        assert "Executing" not in output
        assert "completed" not in output
        assert "success" not in output.lower()

    @pytest.mark.parametrize("overall_mode", ["missing", "null"])
    @pytest.mark.parametrize(
        ("decision", "expected_confirmation_count"),
        [("allow", 1), ("confirm", 2)],
    )
    def test_explicit_non_block_decision_remains_authoritative_without_score(
        self,
        overall_mode,
        decision,
        expected_confirmation_count,
    ):
        plan_data = self._make_plan_data(decision)
        score = plan_data["metadata"]["clear_score"]
        if overall_mode == "missing":
            score.pop("overall")
        else:
            score["overall"] = None

        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )

        assert self.confirm_prompt.call_count == expected_confirmation_count
        self.run_handler.assert_called_once_with("echo hello")
        self.backend_client._request_json.assert_called_once()
        assert self.backend_client._request_json.call_args.args[1] == "/plans/plan-test/execute"

    @pytest.mark.parametrize("overall_mode", ["missing", "null"])
    def test_explicit_block_remains_authoritative_without_score(self, overall_mode):
        plan_data = self._make_plan_data("block")
        score = plan_data["metadata"]["clear_score"]
        if overall_mode == "missing":
            score.pop("overall")
        else:
            score["overall"] = None

        handle_action_plan(
            plan_data, self.console, self.backend_client,
            "inst-1", self.run_handler, self.confirm_prompt,
        )

        self.confirm_prompt.assert_not_called()
        self.run_handler.assert_not_called()
        self.backend_client._request_json.assert_called_once_with(
            "POST",
            "/plans/plan-test/block",
            {},
        )

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
