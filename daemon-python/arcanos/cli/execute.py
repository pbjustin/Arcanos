"""
Governed command execution wrapper.
"""

from __future__ import annotations

from typing import Any, Callable

from .audit import record
from .governance import GovernanceError, assert_allowed
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
    Edge cases: Dispatch and nonzero/unconfirmed execution never imply success.
    """
    record("execute_attempt", command=command_name, trust=trust_state.name, payload=payload)
    try:
        assert_allowed(command_name, trust_state, requires_confirmation)
        result = command_callable()
    except GovernanceError:
        record("execute_blocked", command=command_name, trust=trust_state.name)
        raise
    except Exception as exc:
        record("execute_failed", command=command_name, trust=trust_state.name, error_type=type(exc).__name__)
        raise
    if isinstance(result, tuple) and len(result) == 3 and type(result[2]) is int:
        record("execute_success" if result[2] == 0 else "execute_failed",
               command=command_name, trust=trust_state.name, return_code=result[2])
    else:
        record("execute_unconfirmed", command=command_name, trust=trust_state.name)
    return result

