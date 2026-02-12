import sys
from pathlib import Path

CLI_V2_ROOT = Path(__file__).resolve().parent
if str(CLI_V2_ROOT) not in sys.path:
    # //audit Assumption: test imports should resolve from local checkout; risk: hardcoded path breaks CI portability; invariant: local cli_v2 root inserted once; handling: dynamic path insertion.
    sys.path.append(str(CLI_V2_ROOT))

from bridge.contracts import RawBackendResponse, Action
from bridge.client import BackendClient
import main

# Mocking the backend to simulate a complex response with actions
def mock_analyze(self, context_payload, artifacts):
    """
    Purpose: Replace backend analyze with deterministic action payload for manual smoke tests.
    Inputs/Outputs: context payload + artifacts; returns RawBackendResponse with sample actions.
    Edge cases: None; always returns fixed contract payload.
    """
    return RawBackendResponse(
        result="I will now check the system status.",
        actions=[
            Action(type="shell", command="whoami"),
            Action(type="shell", command="pwd")
        ],
        contract_version="1.0.0"
    )

# Inject the mock
BackendClient.analyze = mock_analyze

print("--- STARTING LIVE STRUCTURED ACTION TEST ---")
main.run_command("vulnerability exploit") # This triggers escalation
print("--- TEST COMPLETE ---")
