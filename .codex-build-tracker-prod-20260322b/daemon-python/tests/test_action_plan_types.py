"""Tests for ActionPlan types and parsing."""

import pytest
from arcanos.action_plan_types import ActionPlan, ActionDef, ClearScore, ExecutionResult


class TestClearScore:
    def test_from_dict_basic(self):
        data = {
            "clarity": 0.85,
            "leverage": 0.7,
            "efficiency": 0.6,
            "alignment": 0.9,
            "resilience": 0.5,
            "overall": 0.73,
            "decision": "allow",
            "notes": "test",
        }
        score = ClearScore.from_dict(data)
        assert score.clarity == 0.85
        assert score.overall == 0.73
        assert score.decision == "allow"
        assert score.notes == "test"

    def test_from_dict_defaults(self):
        score = ClearScore.from_dict({})
        assert score.clarity == 0.0
        assert score.decision == "block"
        assert score.notes is None


class TestActionDef:
    def test_from_dict_snake_case(self):
        data = {
            "action_id": "a1",
            "agent_id": "agent-1",
            "capability": "terminal.run",
            "params": {"command": "ls"},
            "timeout_ms": 5000,
        }
        action = ActionDef.from_dict(data)
        assert action.action_id == "a1"
        assert action.agent_id == "agent-1"
        assert action.capability == "terminal.run"
        assert action.timeout_ms == 5000

    def test_from_dict_camel_case(self):
        data = {
            "id": "a2",
            "agentId": "agent-2",
            "capability": "vision.analyze",
            "timeoutMs": 10000,
        }
        action = ActionDef.from_dict(data)
        assert action.action_id == "a2"
        assert action.agent_id == "agent-2"
        assert action.timeout_ms == 10000


class TestActionPlan:
    def test_from_dict_full(self):
        data = {
            "plan_id": "plan-1",
            "created_by": "user",
            "origin": "test",
            "status": "approved",
            "confidence": 0.8,
            "requires_confirmation": False,
            "idempotency_key": "key-1",
            "actions": [
                {
                    "action_id": "a1",
                    "agent_id": "agent-1",
                    "capability": "terminal.run",
                    "params": {"command": "echo hi"},
                }
            ],
            "metadata": {
                "clear_score": {
                    "clarity": 0.9,
                    "leverage": 0.8,
                    "efficiency": 0.7,
                    "alignment": 0.85,
                    "resilience": 0.75,
                    "overall": 0.82,
                    "decision": "allow",
                },
                "clear_decision": "allow",
            },
        }
        plan = ActionPlan.from_dict(data)
        assert plan.plan_id == "plan-1"
        assert plan.created_by == "user"
        assert plan.status == "approved"
        assert len(plan.actions) == 1
        assert plan.actions[0].capability == "terminal.run"
        assert plan.clear_score is not None
        assert plan.clear_score.overall == 0.82
        assert plan.clear_decision == "allow"

    def test_from_dict_camel_case_keys(self):
        data = {
            "id": "plan-2",
            "createdBy": "system",
            "origin": "recovery",
            "status": "planned",
            "requiresConfirmation": True,
            "idempotencyKey": "key-2",
            "actions": [],
        }
        plan = ActionPlan.from_dict(data)
        assert plan.plan_id == "plan-2"
        assert plan.created_by == "system"
        assert plan.requires_confirmation is True

    def test_from_dict_blocked(self):
        data = {
            "plan_id": "plan-3",
            "created_by": "policy",
            "origin": "audit",
            "status": "blocked",
            "metadata": {
                "clear_score": {
                    "clarity": 0.2,
                    "leverage": 0.1,
                    "efficiency": 0.3,
                    "alignment": 0.1,
                    "resilience": 0.15,
                    "overall": 0.17,
                    "decision": "block",
                },
                "clear_decision": "block",
            },
        }
        plan = ActionPlan.from_dict(data)
        assert plan.clear_decision == "block"
        assert plan.clear_score.overall == 0.17


class TestExecutionResult:
    def test_to_dict(self):
        result = ExecutionResult(
            execution_id="exec-1",
            plan_id="plan-1",
            action_id="a1",
            agent_id="agent-1",
            status="success",
            output={"data": "ok"},
            timestamp="2025-01-01T00:00:00Z",
        )
        d = result.to_dict()
        assert d["execution_id"] == "exec-1"
        assert d["status"] == "success"
        assert d["output"] == {"data": "ok"}
        assert "error" not in d

    def test_to_dict_with_error(self):
        result = ExecutionResult(
            execution_id="exec-2",
            plan_id="plan-1",
            action_id="a1",
            agent_id="agent-1",
            status="failure",
            error={"reason": "timeout"},
        )
        d = result.to_dict()
        assert d["status"] == "failure"
        assert d["error"] == {"reason": "timeout"}
        assert "output" not in d
