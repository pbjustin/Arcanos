"""
Test CLI agent backend connection
This simulates what the CLI does when connecting to the backend
"""
import sys
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file explicitly
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(env_path)
    print(f"[OK] Loaded .env from: {env_path}")

# Add the arcanos package to path
sys.path.insert(0, str(Path(__file__).parent))

from arcanos.config import Config
from arcanos.backend_client import BackendApiClient, BackendRequestError

def main():
    print("="*60)
    print("ARCANOS CLI Agent - Backend Connection Test")
    print("="*60)
    
    # Show configuration
    print("\n[Configuration]")
    print(f"  BACKEND_URL: {Config.BACKEND_URL or 'NOT SET'}")
    print(f"  BACKEND_TOKEN: {'SET' if Config.BACKEND_TOKEN else 'NOT SET'}")
    print(f"  OPENAI_API_KEY: {'SET' if Config.OPENAI_API_KEY and Config.OPENAI_API_KEY != 'sk-dummy-api-key' else 'NOT SET or dummy'}")
    
    # Initialize backend client (like CLI does)
    backend_client = None
    if Config.BACKEND_URL:
        print(f"\n[Initializing Backend Client]")
        print(f"  Base URL: {Config.BACKEND_URL}")
        print(f"  Token: {'Provided' if Config.BACKEND_TOKEN else 'Missing'}")
        print(f"  Timeout: {Config.BACKEND_REQUEST_TIMEOUT}s")
        
        backend_client = BackendApiClient(
            base_url=Config.BACKEND_URL,
            token_provider=lambda: Config.BACKEND_TOKEN,
            timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT
        )
        print("  [OK] Backend client initialized")
    else:
        print("\n[WARNING] Backend URL not configured - backend features disabled")
        return
    
    # Test backend connection
    print("\n[Testing Backend Connection]")
    print(f"  Attempting to connect to: {Config.BACKEND_URL}")
    
    try:
        # Test registry endpoint (lightweight)
        response = backend_client.request_registry()
        
        if response.ok:
            print("  [SUCCESS] Backend connection successful!")
            if response.value:
                registry = response.value
                if isinstance(registry, dict):
                    print(f"  [OK] Registry received with {len(registry)} keys")
                    if registry:
                        print(f"    Sample keys: {list(registry.keys())[:5]}")
                else:
                    print(f"  [OK] Registry received: {type(registry).__name__}")
            return True
        else:
            print("  [FAIL] Backend connection failed")
            if response.error:
                print(f"    Error kind: {response.error.kind}")
                print(f"    Error message: {response.error.message}")
                if response.error.status_code:
                    print(f"    Status code: {response.error.status_code}")
                if response.error.details:
                    print(f"    Details: {response.error.details}")
            
            # Provide helpful suggestions
            if response.error and response.error.kind == "network":
                print("\n  [Troubleshooting]")
                print("    - Is the backend server running?")
                print("    - Check if the URL is correct")
                print("    - Verify network connectivity")
            elif response.error and response.error.kind == "auth":
                print("\n  [Troubleshooting]")
                print("    - Check if BACKEND_TOKEN is correct")
                print("    - Verify token has not expired")
            
            return False
            
    except BackendRequestError as e:
        print(f"  [FAIL] Backend request error: {e.message}")
        print(f"    Error kind: {e.kind}")
        if e.status_code:
            print(f"    Status code: {e.status_code}")
        return False
    except Exception as e:
        print(f"  [FAIL] Unexpected error: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = main()
    print("\n" + "="*60)
    if success:
        print("RESULT: Backend connection successful!")
    else:
        print("RESULT: Backend connection failed")
    print("="*60)
    sys.exit(0 if success else 1)
