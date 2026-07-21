"""Cross-language CLEAR interpretation contract shared with TypeScript."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from arcanos import action_plan_types
from arcanos.action_plan_types import ClearOutcome, interpret_clear_outcome


CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "tests"
    / "fixtures"
    / "clear-decision-wire-contract.json"
)
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_contract_metadata_is_deterministic() -> None:
    """The shared fixture pins the TypeScript thresholds and unique case names."""
    assert CONTRACT["version"] == 1
    assert CONTRACT["thresholds"] == {
        "confirmMinimum": 0.4,
        "allowMinimum": 0.7,
    }
    names = [test_case["name"] for test_case in CONTRACT["cases"]]
    assert len(names) == len(set(names))


def test_python_exports_the_exact_shared_threshold_constants() -> None:
    """Public Python threshold constants must stay pinned to the wire fixture."""
    assert getattr(action_plan_types, "CLEAR_CONFIRM_MINIMUM", None) == CONTRACT[
        "thresholds"
    ]["confirmMinimum"]
    assert getattr(action_plan_types, "CLEAR_ALLOW_MINIMUM", None) == CONTRACT[
        "thresholds"
    ]["allowMinimum"]


@pytest.mark.parametrize(
    "test_case",
    CONTRACT["cases"],
    ids=[test_case["name"] for test_case in CONTRACT["cases"]],
)
def test_python_interpreter_matches_shared_wire_contract(test_case: dict[str, object]) -> None:
    """Python must classify every JSON-representable case exactly like TypeScript."""
    assert interpret_clear_outcome(test_case["evaluation"]) == ClearOutcome(
        **test_case["expected"]
    )


@pytest.mark.parametrize("overall", [math.nan, math.inf, -math.inf])
def test_python_interpreter_rejects_non_finite_runtime_scores(overall: float) -> None:
    """Non-standard JSON numeric values cannot become an authoritative decision."""
    assert interpret_clear_outcome(
        {"overall": overall, "decision": "allow"}
    ) == ClearOutcome(kind="invalid", reason="invalid_score")


def test_python_interpreter_does_not_treat_boolean_as_numeric() -> None:
    """Python bool subclasses int but the TypeScript number contract excludes it."""
    assert interpret_clear_outcome(
        {"overall": True, "decision": "allow"}
    ) == ClearOutcome(kind="invalid", reason="invalid_score")
