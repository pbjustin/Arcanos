"""
Governed command execution wrapper.
"""

from __future__ import annotations

from typing import Any, Callable

from .audit import record
from .governance import GovernanceError, assert_allowed
from .trust_state import TrustState


def _record_observation(event: str, **fields: Any) -> None:
    """Audit an observed outcome without replacing its result or primary error."""
    try:
        record(event, **fields)
    except Exception:
        try:
            print("Local execution audit is incomplete.")
        except Exception:
            pass


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
        _record_observation("execute_blocked", command=command_name, trust=trust_state.name)
        raise
    except Exception as exc:
        _record_observation("execute_failed", command=command_name, trust=trust_state.name, error_type=type(exc).__name__)
        raise
    # The pre-dispatch audit above remains fail-closed. Once execution has
    # returned, an audit outage cannot replace its known result or exit code.
    if isinstance(result, tuple) and len(result) == 3 and type(result[2]) is int:
        _record_observation("execute_success" if result[2] == 0 else "execute_failed",
                            command=command_name, trust=trust_state.name, return_code=result[2])
    else:
        _record_observation("execute_unconfirmed", command=command_name, trust=trust_state.name)
    return result

