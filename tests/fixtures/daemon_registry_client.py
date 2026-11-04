"""Provider-free real HTTP fixture for the Python daemon registry client."""

import json
import os
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[1])
import arcanos.env as runtime_env

# Never hydrate the developer's installed or project environment files.
runtime_env._BOOTSTRAPPED = True
runtime_env._BASE_DIR = Path(os.environ["DATA_DIR"])
from arcanos.backend_client import BackendApiClient
from arcanos.config import Config


def unrelated_credential():
    raise AssertionError("Registry reads must not select unrelated credentials")


client = BackendApiClient(
    sys.argv[2],
    unrelated_credential,
    timeout_seconds=5,
    daemon_access_token_provider=lambda: Config.DAEMON_ACCESS_TOKEN,
)
results = []
for _ in range(int(sys.argv[3])):
    response = client.request_registry()
    results.append({
        "ok": response.ok,
        "kind": response.error.kind if response.error else None,
        "status": response.error.status_code if response.error else None,
        "version": response.value.get("version") if response.value else None,
    })
print(json.dumps(results))
