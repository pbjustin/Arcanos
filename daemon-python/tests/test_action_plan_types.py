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

    def test_from_dict_does_not_default_a_missing_decision_to_block(self):
        with pytest.raises(ValueError):
            ClearScore.from_dict({})

    @pytest.mark.parametrize("decision", ["allow", "confirm", "block"])
    @pytest.mark.parametrize("include_overall", [False, True])
    def test_from_dict_preserves_explicit_decision_without_a_score(
        self,
        decision,
        include_overall,
    ):
        data = {"decision": decision}
        if include_overall:
            data["overall"] = None

        score = ClearScore.from_dict(data)

        assert score.decision == decision
        assert score.overall is None

    @pytest.mark.parametrize(
        "data",
        [
            {"overall": 0.8},
            {"overall": 0.8, "decision": None},
            {"overall": 0.8, "decision": "unknown"},
            {"overall": 0.8, "decision": "ALLOW"},
            {"overall": 0.8, "decision": 1},
            {"overall": "0.8", "decision": "allow"},
            {"overall": True, "decision": "allow"},
            {"overall": float("nan"), "decision": "allow"},
            {"overall": float("inf"), "decision": "allow"},
            {"overall": -0.001, "decision": "block"},
            {"overall": 1.001, "decision": "allow"},
            {"overall": 0.2, "decision": "allow"},
            {"overall": 0.8, "decision": "block"},
        ],
        ids=[
            "missing-decision",
            "null-decision",
            "unknown-decision",
            "case-variant-decision",
            "numeric-decision",
            "numeric-string-score",
            "boolean-score",
            "nan-score",
            "infinite-score",
            "negative-score",
            "score-above-one",
            "allow-with-block-score",
            "block-with-allow-score",
        ],
    )
    def test_from_dict_rejects_non_authoritative_outcomes(self, data):
        with pytest.raises(ValueError):
            ClearScore.from_dict(data)


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
        assert plan.clear_decision is None

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            pytest.param("planned", "planned", id="recognized"),
            pytest.param("unknown", "unknown", id="unknown"),
            pytest.param("APPROVED", "APPROVED", id="case-variant"),
            pytest.param(None, None, id="null"),
            pytest.param(7, 7, id="non-string"),
        ],
    )
    def test_from_dict_preserves_exact_present_lifecycle_value(
        self,
        status,
        expected,
    ):
        plan = ActionPlan.from_dict({"plan_id": "plan-status", "status": status})

        assert plan.status_present is True
        assert plan.status == expected

    def test_from_dict_preserves_missing_lifecycle_state_as_unavailable(self):
        plan = ActionPlan.from_dict({"plan_id": "plan-missing-status"})

        assert plan.status_present is False
        assert plan.status is None

    @pytest.mark.parametrize("plan_id", [None, 7, True, {}, []])
    def test_from_dict_does_not_coerce_malformed_plan_identity(self, plan_id):
        plan = ActionPlan.from_dict({"plan_id": plan_id, "status": "approved"})

        assert plan.plan_id == ""

    def test_from_dict_rejects_conflicting_plan_identity_aliases(self):
        with pytest.raises(ValueError, match="Conflicting ActionPlan identifiers"):
            ActionPlan.from_dict(
                {
                    "plan_id": "plan-authoritative",
                    "id": "plan-conflict",
                    "status": "approved",
                }
            )

    @pytest.mark.parametrize("requires_confirmation", [True, False])
    def test_from_dict_preserves_exact_confirmation_requirement(
        self,
        requires_confirmation,
    ):
        plan = ActionPlan.from_dict(
            {
                "plan_id": "plan-confirmation",
                "status": "approved",
                "requires_confirmation": requires_confirmation,
            }
        )

        assert plan.requires_confirmation is requires_confirmation

    @pytest.mark.parametrize(
        "requires_confirmation",
        [None, 0, 1, "", "false", [], {}],
    )
    def test_from_dict_rejects_malformed_confirmation_requirement(
        self,
        requires_confirmation,
    ):
        with pytest.raises(
            ValueError,
            match="ActionPlan confirmation requirement is malformed",
        ):
            ActionPlan.from_dict(
                {
                    "plan_id": "plan-confirmation",
                    "status": "approved",
                    "requires_confirmation": requires_confirmation,
                }
            )

    def test_from_dict_rejects_conflicting_confirmation_aliases(self):
        with pytest.raises(
            ValueError,
            match="Conflicting ActionPlan confirmation requirements",
        ):
            ActionPlan.from_dict(
                {
                    "plan_id": "plan-confirmation",
                    "status": "approved",
                    "requires_confirmation": False,
                    "requiresConfirmation": True,
                }
            )

    def test_from_dict_accepts_top_level_camel_case_clear_score(self):
        plan = ActionPlan.from_dict({
            "id": "plan-camel-score",
            "clearScore": {
                "overall": 0.8,
                "decision": "allow",
            },
        })

        assert plan.clear_score is not None
        assert plan.clear_score.decision == "allow"
        assert plan.clear_decision == "allow"

    def test_from_dict_accepts_explicit_metadata_decision_without_score(self):
        plan = ActionPlan.from_dict({
            "plan_id": "plan-decision-only",
            "metadata": {"clear_score": None, "clear_decision": "confirm"},
        })

        assert plan.clear_score is None
        assert plan.clear_decision == "confirm"

    def test_from_dict_rejects_invalid_metadata_decision_without_score(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-invalid-decision-only",
                "metadata": {"clear_decision": "unknown"},
            })

    def test_from_dict_rejects_partial_score_without_decision(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-partial-score",
                "metadata": {"clear_score": {"overall": 0.8}},
            })

    def test_from_dict_rejects_conflicting_duplicate_decisions(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-conflicting-decision",
                "metadata": {
                    "clear_score": {"overall": 0.8, "decision": "allow"},
                    "clear_decision": "block",
                },
            })

    def test_from_dict_treats_null_duplicate_decision_as_absent(self):
        plan = ActionPlan.from_dict({
            "plan_id": "plan-null-duplicate-decision",
            "metadata": {
                "clear_score": {"overall": 0.8, "decision": "allow"},
                "clear_decision": None,
            },
        })

        assert plan.clear_score is not None
        assert plan.clear_decision == "allow"

    def test_from_dict_rejects_conflicting_score_aliases(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-conflicting-scores",
                "metadata": {
                    "clear_score": {"overall": 0.8, "decision": "allow"},
                },
                "clearScore": {"overall": 0.2, "decision": "block"},
            })

    def test_from_dict_rejects_duplicate_score_aliases_with_conflicting_clarity(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-conflicting-clarity",
                "metadata": {
                    "clear_score": {
                        "clarity": 0.9,
                        "overall": 0.8,
                        "decision": "allow",
                    },
                },
                "clearScore": {
                    "clarity": 0.1,
                    "overall": 0.8,
                    "decision": "allow",
                },
            })

    def test_from_dict_rejects_malformed_shadow_score_alias(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-malformed-shadow-score",
                "metadata": {
                    "clear_score": {
                        "clarity": 0.9,
                        "overall": 0.8,
                        "decision": "allow",
                    },
                },
                "clearScore": {
                    "clarity": "malformed",
                    "overall": 0.8,
                    "decision": "allow",
                },
            })

    def test_from_dict_rejects_boolean_shadow_for_numeric_overall(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-boolean-overall-shadow",
                "metadata": {
                    "clear_score": {"overall": 1, "decision": "allow"},
                },
                "clearScore": {"overall": True, "decision": "allow"},
            })

    def test_from_dict_rejects_boolean_shadow_for_numeric_notes(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-boolean-notes-shadow",
                "metadata": {
                    "clear_score": {
                        "overall": 0.8,
                        "decision": "allow",
                        "notes": 1,
                    },
                },
                "clearScore": {
                    "overall": 0.8,
                    "decision": "allow",
                    "notes": True,
                },
            })

    def test_from_dict_rejects_nested_boolean_shadow_for_numeric_provider_metadata(self):
        with pytest.raises(ValueError):
            ActionPlan.from_dict({
                "plan_id": "plan-boolean-provider-shadow",
                "metadata": {
                    "clear_score": {
                        "overall": 0.8,
                        "decision": "allow",
                        "providerMetadata": {"attempt": 1},
                    },
                },
                "clearScore": {
                    "overall": 0.8,
                    "decision": "allow",
                    "providerMetadata": {"attempt": True},
                },
            })

    def test_from_dict_accepts_json_equivalent_integer_and_float_score_aliases(self):
        plan = ActionPlan.from_dict({
            "plan_id": "plan-json-number-equivalent-scores",
            "metadata": {
                "clear_score": {"overall": 1, "decision": "allow"},
            },
            "clearScore": {"overall": 1.0, "decision": "allow"},
        })

        assert plan.clear_score is not None
        assert plan.clear_score.overall == 1.0
        assert plan.clear_decision == "allow"

    def test_from_dict_accepts_matching_score_aliases(self):
        score = {"overall": 0.8, "decision": "allow"}
        plan = ActionPlan.from_dict({
            "plan_id": "plan-matching-scores",
            "metadata": {"clear_score": dict(score)},
            "clearScore": dict(score),
        })

        assert plan.clear_score is not None
        assert plan.clear_score.decision == "allow"
        assert plan.clear_decision == "allow"

    @pytest.mark.parametrize("decision", ["allow", "confirm", "block"])
    def test_from_dict_ignores_unsupported_top_level_clear_decision(self, decision):
        plan = ActionPlan.from_dict({
            "plan_id": "plan-unsupported-top-level-decision",
            "clearDecision": decision,
        })

        assert plan.clear_score is None
        assert plan.clear_decision is None

    def test_from_dict_does_not_let_top_level_clear_decision_override_score(self):
        plan = ActionPlan.from_dict({
            "plan_id": "plan-top-level-shadow-decision",
            "metadata": {
                "clear_score": {"overall": 0.8, "decision": "allow"},
            },
            "clearDecision": "block",
        })

        assert plan.clear_score is not None
        assert plan.clear_score.decision == "allow"
        assert plan.clear_decision == "allow"

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
