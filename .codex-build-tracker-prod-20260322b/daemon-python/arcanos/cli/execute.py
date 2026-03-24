"""
Governed command execution wrapper.
"""

from __future__ import annotations

from typing import Any, Callable

from .audit import record
from .governance import assert_allowed
from .trust_state import TrustState


def execute(
    command_name: str,
    command_callable: Callable[[], Any],
    *,
    trust_state: TrustState,
    requires_confirmation: bool,
    payload: dict[str, Any],
) -> Any:
    """
    Purpose: Execute a command through governance and audit boundaries.
    Inputs/Outputs: command metadata + callable; returns callable result or raises on governance/command failure.
    Edge cases: Always emits audit attempt/success events around command execution.
    """
    record("execute_attempt", command=command_name, trust=trust_state.name, payload=payload)
    assert_allowed(command_name, trust_state, requires_confirmation)
    result = command_callable()
    record("execute_success", command=command_name, trust=trust_state.name)
    return result

