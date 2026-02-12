"""
Show CLI Agent Status and Connection Info
"""
import sys
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(env_path)
from arcanos.config import Config
from arcanos.backend_client import BackendApiClient

print("="*60)
print("ARCANOS CLI Agent Status")
print("="*60)

print("\n[Configuration]")
print(f"  Version: {Config.VERSION}")
print(f"  Backend URL: {Config.BACKEND_URL or 'Not configured'}")
print(f"  Backend Token: {'Set' if Config.BACKEND_TOKEN else 'Not set'}")
print(f"  OpenAI API Key: {'Set' if Config.OPENAI_API_KEY and Config.OPENAI_API_KEY != 'sk-dummy-api-key' else 'Not set or dummy'}")

if Config.BACKEND_URL:
    print("\n[Backend Connection]")
    try:
        client = BackendApiClient(
            base_url=Config.BACKEND_URL,
            token_provider=lambda: Config.BACKEND_TOKEN,
            timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT
        )
        response = client.request_registry()
        if response.ok:
            print("  Status: CONNECTED")
            if response.value and isinstance(response.value, dict):
                version = response.value.get('version', 'Unknown')
                print(f"  Backend Version: {version}")
        else:
            print("  Status: CONNECTION FAILED")
            if response.error:
                print(f"  Error: {response.error.message}")
    except Exception as e:
        print(f"  Status: ERROR - {str(e)}")

print("\n[How to Run]")
print("  To start the CLI agent interactively, run:")
print("    python -m arcanos.cli")
print("\n  Or from the daemon-python directory:")
print("    .venv\\Scripts\\python.exe -m arcanos.cli")
print("\n  The CLI will start and wait for your input.")
print("  Type 'help' for available commands.")
print("="*60)
