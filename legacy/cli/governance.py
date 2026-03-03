from .trust_state import TrustState


class GovernanceError(RuntimeError):
    pass


def assert_allowed(action: str, trust_state: TrustState, requires_confirmation: bool):
    if requires_confirmation and trust_state != TrustState.FULL:
        raise GovernanceError(
            f"Action '{action}' requires FULL trust; current={trust_state.name}"
        )
