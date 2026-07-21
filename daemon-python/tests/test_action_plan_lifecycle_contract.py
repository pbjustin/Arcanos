"""Cross-language ActionPlan lifecycle contract shared with TypeScript."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from arcanos.action_plan_lifecycle import (
    ActionPlanLifecycleResult,
    evaluate_action_plan_lifecycle,
)

CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "tests"
    / "fixtures"
    / "action-plan-lifecycle-contract.json"
)
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_contract_metadata_is_deterministic() -> None:
    """The fixture pins the lifecycle vocabulary and unique case names."""
    assert CONTRACT["schemaVersion"] == 1
    assert CONTRACT["observedStatuses"] == [
        "planned",
        "awaiting_confirmation",
        "approved",
        "in_progress",
        "completed",
        "failed",
        "expired",
        "blocked",
    ]
    case_names = [case["name"] for case in CONTRACT["cases"]]
    unsupported_names = [
        case["name"] for case in CONTRACT["unsupportedScenarios"]
    ]
    assert len(case_names) == len(set(case_names))
    assert len(unsupported_names) == len(set(unsupported_names))


@pytest.mark.parametrize(
    "test_case",
    CONTRACT["cases"],
    ids=[case["name"] for case in CONTRACT["cases"]],
)
def test_python_evaluator_matches_shared_lifecycle_contract(
    test_case: dict[str, object],
) -> None:
    """Python must classify enforceable cases like TypeScript."""
    plan = test_case["plan"]
    policy = test_case["policy"]
    expected = test_case["expectedSemantic"]
    assert isinstance(plan, dict)
    assert isinstance(policy, dict)
    assert isinstance(expected, dict)

    assert evaluate_action_plan_lifecycle(
        operation=test_case["operation"],
        status_present="status" in plan,
        status=plan.get("status"),
        policy_kind=policy["kind"],
        policy_provenance=policy["provenance"],
        expiry=plan["expiry"],
    ) == ActionPlanLifecycleResult(
        classification=expected["classification"],
        reason_code=expected["reasonCode"],
        operation_allowed=expected["operationAllowed"],
        policy_recheck_allowed=expected["policyRecheckAllowed"],
        status_transition_allowed=expected["statusTransitionAllowed"],
        target_status=expected["targetStatus"],
    )


def test_unsupported_integrity_guarantees_are_explicitly_deferred() -> None:
    """Unavailable version and race evidence must not claim enforcement."""
    assert len(CONTRACT["unsupportedScenarios"]) >= 8
    for scenario in CONTRACT["unsupportedScenarios"]:
        assert scenario["enforced"] is False
        assert scenario["deferredRisk"] is True
        assert scenario["observedBehavior"].replace("_", "").isalnum()
        assert scenario["support"].startswith(
            ("unavailable_", "characterized_")
        )
        assert scenario["expectedCategory"].startswith("ACTION_PLAN_")
