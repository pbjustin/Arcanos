"""Python consumption of the shared TypeScript/Python Phase 2E fixture corpus."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from arcanos.action_plan_execution_protocol import (
    PROTOCOL_VERSION,
    parse_acceptance,
    parse_assignment,
    parse_protocol_capability,
    parse_start,
    parse_status,
    validate_result_request,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "tests"
    / "fixtures"
    / "action-plan-execution-protocol-v1.json"
)


def _fixture() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_shared_fixture_protocol_and_limits_match_python_contract() -> None:
    fixture = _fixture()
    assert fixture["protocolVersion"] == PROTOCOL_VERSION
    limits = fixture["limits"]
    assert limits["maxHttpBodyBytes"] == 64 * 1024
    assert limits["maxOutputBytes"] == 32 * 1024
    assert limits["maxErrorBytes"] == 4 * 1024
    assert limits["maxJsonDepth"] == 8


def test_shared_valid_result_requests_all_pass_python_validation() -> None:
    valid = _fixture()["valid"]
    for case in valid["resultRequests"]:
        validate_result_request(case["value"])


def test_shared_json_depth_boundary_matches_python_validation() -> None:
    for case in _fixture()["jsonDepthCases"]:
        request = {
            "action_id": "action-depth",
            "snapshot_id": "snapshot-depth",
            "outcome": "succeeded",
            "output": case["value"],
        }
        if case["valid"]:
            validate_result_request(request)
        else:
            with pytest.raises(ValueError):
                validate_result_request(request)


def test_shared_identifier_boundary_matches_python_assignment_parser() -> None:
    template = _fixture()["valid"]["claimResponses"][0]["value"]
    for case in _fixture()["identifierCases"]:
        payload = deepcopy(template)
        payload["action_id"] = case["value"]
        if case["valid"]:
            parse_assignment(payload, expected_realm="local-test")
        else:
            with pytest.raises(ValueError):
                parse_assignment(payload, expected_realm="local-test")


def test_shared_invalid_result_requests_all_fail_python_validation() -> None:
    invalid = [case for case in _fixture()["invalid"] if case["schema"] == "result"]
    assert invalid
    for case in invalid:
        with pytest.raises(ValueError, match="result"):
            validate_result_request(case["value"])


def test_shared_executor_responses_parse_without_language_normalization() -> None:
    valid = _fixture()["valid"]
    capability_payload = valid["capabilityResponses"][0]["value"]
    assignment_payload = valid["claimResponses"][0]["value"]
    start_payload = valid["startResponses"][0]["value"]
    result_payload = valid["resultResponses"][0]["value"]
    status_payload = valid["statusResponses"][0]["value"]

    capability = parse_protocol_capability(capability_payload)
    assignment = parse_assignment(
        assignment_payload,
        expected_realm="local-test",
    )
    start = parse_start(
        start_payload,
        plan_id="plan-001",
        run_id="run-001",
        action_id="action-001",
        expected_realm="local-test",
    )
    acceptance = parse_acceptance(
        result_payload,
        plan_id="plan-001",
        run_id="run-002",
        action_id="action-002",
        snapshot_id="snapshot-002",
        expected_outcome="failed",
        expected_realm="local-test",
    )
    status = parse_status(
        status_payload,
        plan_id="plan-001",
        run_id="run-002",
        action_id="action-002",
        snapshot_id="snapshot-002",
        expected_realm="local-test",
    )

    assert capability.executor_instance_id == "python-executor-instance-001"
    assert assignment.action_snapshot["params"] == {"fixture": "synthetic-noop"}
    assert start.state == "RUNNING"
    assert acceptance.disposition == "RESULT_ACCEPTED"
    assert acceptance.state == "FAILED"
    assert status.acceptance_receipt == "receipt-002"
