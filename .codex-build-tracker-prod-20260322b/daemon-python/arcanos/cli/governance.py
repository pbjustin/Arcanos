"""
Governance checks for privileged CLI actions.
"""

from __future__ import annotations

from .trust_state import TrustState


class GovernanceError(RuntimeError):
    """Purpose: Signal that governance policy blocked an action."""


def assert_allowed(action_name: str, trust_state: TrustState, requires_confirmation: bool) -> None:
    """
    Purpose: Enforce trust-level policy before an action executes.
    Inputs/Outputs: action metadata + current trust state; raises GovernanceError on policy denial.
    Edge cases: Allows non-confirmed actions in DEGRADED/UNSAFE modes while still blocking privileged actions.
    """
    # //audit assumption: confirmation-gated actions must require FULL trust; failure risk: privileged command execution under stale/unsafe state; expected invariant: privileged actions denied unless trust is FULL; handling strategy: raise GovernanceError.
    if requires_confirmation and trust_state != TrustState.FULL:
        raise GovernanceError(
            f"Action '{action_name}' requires FULL trust; current={trust_state.name}"
        )

