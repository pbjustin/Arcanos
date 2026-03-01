from .governance import assert_allowed
from .audit import record
from .trust_state import TrustState


def execute(command_name, fn, *, trust_state: TrustState,
            requires_confirmation: bool, payload: dict):
    record("execute_attempt", command=command_name, trust=trust_state.name)
    assert_allowed(command_name, trust_state, requires_confirmation)
    result = fn()
    record("execute_success", command=command_name, trust=trust_state.name)
    return result
