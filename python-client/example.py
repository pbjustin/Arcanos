"""Example usage of the Arcanos Python client."""

from __future__ import annotations

from arcanos_client import ArcanosPythonClient

if __name__ == "__main__":
    client = ArcanosPythonClient()
    try:
        content = client.run_simple_prompt("Confirm that the Arcanos Python client is online.")
    except Exception as exc:  # pragma: no cover - example script
        print("Arcanos Python client failed:", exc)
    else:
        print("Model replied:", content)
