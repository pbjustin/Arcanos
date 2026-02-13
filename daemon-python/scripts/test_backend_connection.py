"""
Quick test script to check backend connectivity from CLI agent
"""
import sys
import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file explicitly from current directory
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(env_path)
    print(f"Loaded .env from: {env_path}")

# Add the arcanos package to path

from arcanos.config import Config
from arcanos.backend_client import BackendApiClient, BackendRequestError

def test_backend_connection():
    """Test backend connection"""
    print("="*60)
    print("Testing Backend Connection")
    print("="*60)
    
    print(f"\nConfiguration:")
    print(f"  BACKEND_URL: {Config.BACKEND_URL}")
    print(f"  BACKEND_TOKEN: {'SET' if Config.BACKEND_TOKEN else 'NOT SET'}")
    print(f"  OPENAI_API_KEY: {'SET' if Config.OPENAI_API_KEY and Config.OPENAI_API_KEY != 'sk-dummy-api-key' else 'NOT SET or dummy'}")
    
    if not Config.BACKEND_URL:
        print("\n[FAIL] BACKEND_URL is not configured")
        return False
    
    if not Config.BACKEND_TOKEN:
        print("\n[WARN] BACKEND_TOKEN is not set - authentication may fail")
    
    print(f"\nAttempting to connect to backend at {Config.BACKEND_URL}...")
    
    try:
        client = BackendApiClient(
            base_url=Config.BACKEND_URL,
            token_provider=lambda: Config.BACKEND_TOKEN,
            timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT
        )
        
        # Test registry endpoint (lightweight test)
        print("\nTesting registry endpoint...")
        response = client.request_registry()
        
        if response.ok:
            print("[SUCCESS] Backend connection successful!")
            if response.value:
                print(f"  Registry keys: {list(response.value.keys()) if isinstance(response.value, dict) else 'N/A'}")
            return True
        else:
            print(f"[FAIL] Backend request failed")
            if response.error:
                print(f"  Error kind: {response.error.kind}")
                print(f"  Error message: {response.error.message}")
                print(f"  Status code: {response.error.status_code}")
            return False
            
    except BackendRequestError as e:
        print(f"[FAIL] Backend request error: {e.message}")
        print(f"  Error kind: {e.kind}")
        if e.status_code:
            print(f"  Status code: {e.status_code}")
        return False
    except Exception as e:
        print(f"[FAIL] Unexpected error: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_backend_connection()
    sys.exit(0 if success else 1)
