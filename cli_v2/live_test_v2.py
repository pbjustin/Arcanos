import sys
from pathlib import Path
sys.path.append(str(Path(r"C:\arcanos-hybrid\cli_v2")))

from bridge.contracts import RawBackendResponse, Action
from bridge.client import BackendClient
import main

# Mocking the backend to simulate a complex response with actions
def mock_analyze(self, context_payload, artifacts):
    return RawBackendResponse(
        result="I will now check the system status.",
        actions=[
            Action(type="shell", command="whoami"),
            Action(type="shell", command="dir cli_v2")
        ],
        contract_version="1.0.0"
    )

# Inject the mock
BackendClient.analyze = mock_analyze

print("--- STARTING LIVE STRUCTURED ACTION TEST ---")
main.run_command("vulnerability exploit") # This triggers escalation
print("--- TEST COMPLETE ---")
