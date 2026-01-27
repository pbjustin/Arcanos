"""
Backend API and CLI Agent Validation Script

This script validates:
1. Backend API connectivity
2. CLI agent availability
3. Command execution (help, status, version)

PREREQUISITES:
- Backend API must be running and accessible at BACKEND_URL (default: http://localhost:8080)
- CLI agent must be running with debug server enabled
  - Set environment variables: IDE_AGENT_DEBUG=true and DAEMON_DEBUG_PORT=9999
  - Or add to .env file: IDE_AGENT_DEBUG=true and DAEMON_DEBUG_PORT=9999
  - Then run: python -m arcanos.cli
  - Debug server should be on http://127.0.0.1:9999

See DEBUG_SERVER_README.md for detailed instructions.
"""

import json
import sys
import time
from pathlib import Path
from typing import Dict, Any, Optional

import requests

# Add the arcanos package to path
sys.path.insert(0, str(Path(__file__).parent))

from arcanos.config import Config
from arcanos.backend_client import BackendApiClient, BackendRequestError

# Debug server configuration
DEBUG_SERVER_PORT = Config.DAEMON_DEBUG_PORT if (Config.DAEMON_DEBUG_PORT and Config.DAEMON_DEBUG_PORT > 0) else 9999
DEBUG_SERVER_URL = f"http://127.0.0.1:{DEBUG_SERVER_PORT}"

# Results storage
results: Dict[str, Any] = {
    "backend_connectivity": {},
    "cli_agent": {},
    "commands": {},
    "bugs": [],
    "verdict": "UNKNOWN"
}


def get_debug_auth_headers() -> Dict[str, str]:
    """Get authentication headers for debug server requests"""
    headers = {}
    if Config.DEBUG_SERVER_TOKEN:
        headers["Authorization"] = f"Bearer {Config.DEBUG_SERVER_TOKEN}"
    return headers


def log_result(category: str, key: str, value: Any, error: Optional[str] = None):
    """Log a test result"""
    if category not in results:
        results[category] = {}
    results[category][key] = {
        "value": value,
        "error": error,
        "timestamp": time.time()
    }
    if error:
        results["bugs"].append(f"{category}.{key}: {error}")


def test_backend_connectivity() -> bool:
    """Test if backend API is reachable and responsive"""
    print("\n" + "="*60)
    print("TEST 1: Backend API Connectivity")
    print("="*60)
    
    if not Config.BACKEND_URL:
        log_result("backend_connectivity", "configured", False, "BACKEND_URL not configured")
        print("[FAIL] Backend URL not configured (BACKEND_URL environment variable)")
        return False
    
    log_result("backend_connectivity", "configured", True)
    print(f"[OK] Backend URL configured: {Config.BACKEND_URL}")
    
    # Test 1.1: Ping backend via registry endpoint
    print(f"\n[1.1] Testing backend registry endpoint...")
    try:
        client = BackendApiClient(
            base_url=Config.BACKEND_URL,
            token_provider=lambda: Config.BACKEND_TOKEN,
            timeout_seconds=Config.BACKEND_REQUEST_TIMEOUT
        )
        
        response = client.request_registry()
        
        if response.ok:
            log_result("backend_connectivity", "registry_endpoint", True, None)
            print(f"[OK] Registry endpoint accessible")
            print(f"  Response keys: {list(response.value.keys()) if response.value else 'empty'}")
            return True
        else:
            error_msg = f"Registry request failed: {response.error.message if response.error else 'unknown'}"
            log_result("backend_connectivity", "registry_endpoint", False, error_msg)
            print(f"[FAIL] {error_msg}")
            if response.error:
                print(f"   Error kind: {response.error.kind}")
                print(f"   Status code: {response.error.status_code}")
            return False
            
    except BackendRequestError as e:
        error_msg = f"Backend request error: {e.message} (kind: {e.kind})"
        log_result("backend_connectivity", "registry_endpoint", False, error_msg)
        print(f"[FAIL] {error_msg}")
        return False
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        log_result("backend_connectivity", "registry_endpoint", False, error_msg)
        print(f"[FAIL] {error_msg}")
        return False


def test_cli_agent_availability() -> bool:
    """Test if CLI agent debug server is running"""
    print("\n" + "="*60)
    print("TEST 2: CLI Agent Availability")
    print("="*60)
    
    print(f"Checking debug server at {DEBUG_SERVER_URL}...")
    
    # Check if authentication is required
    if not Config.DEBUG_SERVER_TOKEN:
        print("[WARN] DEBUG_SERVER_TOKEN not set. Authentication may be required.")
        print("       Set DEBUG_SERVER_TOKEN environment variable for secure access.")
    
    try:
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/status", headers=get_debug_auth_headers(), timeout=5)
        
        if response.status_code == 200:
            log_result("cli_agent", "debug_server", True)
            print(f"[OK] Debug server is running on port {DEBUG_SERVER_PORT}")
            return True
        else:
            error_msg = f"Debug server returned status {response.status_code}"
            log_result("cli_agent", "debug_server", False, error_msg)
            print(f"[FAIL] {error_msg}")
            return False
            
    except requests.exceptions.ConnectionError:
        error_msg = "Debug server not reachable (connection refused)"
        log_result("cli_agent", "debug_server", False, error_msg)
        print(f"[FAIL] {error_msg}")
        print(f"   Make sure the CLI agent is running with IDE_AGENT_DEBUG=true or DAEMON_DEBUG_PORT={DEBUG_SERVER_PORT}")
        return False
    except requests.exceptions.Timeout:
        error_msg = "Debug server request timed out"
        log_result("cli_agent", "debug_server", False, error_msg)
        print(f"[FAIL] {error_msg}")
        return False
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        log_result("cli_agent", "debug_server", False, error_msg)
        print(f"[FAIL] {error_msg}")
        return False


def test_help_command() -> bool:
    """Test help command execution"""
    print("\n" + "="*60)
    print("TEST 3: Command Execution - HELP")
    print("="*60)
    
    try:
        # Use debug API to get help via dedicated help endpoint
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/help", headers=get_debug_auth_headers(), timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            if data.get("ok"):
                help_text = data.get("help_text", "")
                log_result("commands", "help", True)
                print("[OK] Help command executed successfully")
                print(f"  Help text received (length: {len(help_text)} chars)")
                if help_text:
                    # Show first few lines of help
                    lines = help_text.split('\n')[:5]
                    print(f"  Preview: {lines[0] if lines else 'N/A'}")
                return True
            else:
                error_msg = data.get("error", "Unknown error")
                log_result("commands", "help", False, error_msg)
                print(f"[FAIL] Help command failed: {error_msg}")
                return False
        else:
            error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
            log_result("commands", "help", False, error_msg)
            print(f"[FAIL] Help command failed: {error_msg}")
            return False
            
    except Exception as e:
        error_msg = f"Exception: {str(e)}"
        log_result("commands", "help", False, error_msg)
        print(f"[FAIL] Help command error: {error_msg}")
        return False


def test_status_command() -> bool:
    """Test status command execution"""
    print("\n" + "="*60)
    print("TEST 4: Command Execution - STATUS")
    print("="*60)
    
    try:
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/status", headers=get_debug_auth_headers(), timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            if data.get("ok"):
                status_data = {k: v for k, v in data.items() if k != "ok"}
                log_result("commands", "status", True, None)
                print("[OK] Status command executed successfully")
                print(f"  Instance ID: {status_data.get('instanceId', 'N/A')}")
                print(f"  Client ID: {status_data.get('clientId', 'N/A')}")
                print(f"  Uptime: {status_data.get('uptime', 'N/A')} seconds")
                print(f"  Backend configured: {status_data.get('backend_configured', 'N/A')}")
                print(f"  Version: {status_data.get('version', 'N/A')}")
                if status_data.get('last_error'):
                    print(f"  [WARN] Last error: {status_data.get('last_error')}")
                return True
            else:
                error_msg = data.get("error", "Unknown error")
                log_result("commands", "status", False, error_msg)
                print(f"[FAIL] Status command failed: {error_msg}")
                return False
        else:
            error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
            log_result("commands", "status", False, error_msg)
            print(f"[FAIL] Status command failed: {error_msg}")
            return False
            
    except Exception as e:
        error_msg = f"Exception: {str(e)}"
        log_result("commands", "status", False, error_msg)
        print(f"[FAIL] Status command error: {error_msg}")
        return False


def test_version_command() -> bool:
    """Test version command execution"""
    print("\n" + "="*60)
    print("TEST 5: Command Execution - VERSION")
    print("="*60)
    
    try:
        # Version is included in status endpoint
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/status", headers=get_debug_auth_headers(), timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            if data.get("ok"):
                version = data.get("version", Config.VERSION)
                log_result("commands", "version", True, None)
                print("[OK] Version command executed successfully")
                print(f"  Version: {version}")
                
                # Also check Config.VERSION for consistency
                config_version = Config.VERSION
                if version != config_version:
                    error_msg = f"Version mismatch: status={version}, config={config_version}"
                    log_result("commands", "version", True, error_msg)
                    print(f"  [WARN] {error_msg}")
                else:
                    print(f"  [OK] Version consistent with config: {config_version}")
                
                return True
            else:
                error_msg = data.get("error", "Unknown error")
                log_result("commands", "version", False, error_msg)
                print(f"[FAIL] Version command failed: {error_msg}")
                return False
        else:
            error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
            log_result("commands", "version", False, error_msg)
            print(f"[FAIL] Version command failed: {error_msg}")
            return False
            
    except Exception as e:
        error_msg = f"Exception: {str(e)}"
        log_result("commands", "version", False, error_msg)
        print(f"[FAIL] Version command error: {error_msg}")
        return False


def test_health_endpoint() -> bool:
    """Test health endpoint"""
    print("\n" + "="*60)
    print("TEST 6: Health Endpoint")
    print("="*60)
    
    try:
        # Health endpoint doesn't require authentication (read-only)
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/health", timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            if data.get("ok"):
                log_result("endpoints", "health", True)
                print("[OK] Health endpoint working")
                print(f"  Version: {data.get('version', 'N/A')}")
                return True
            else:
                error_msg = "Health endpoint returned ok=false"
                log_result("endpoints", "health", False, error_msg)
                print(f"[FAIL] {error_msg}")
                return False
        else:
            error_msg = f"HTTP {response.status_code}"
            log_result("endpoints", "health", False, error_msg)
            print(f"[FAIL] Health endpoint failed: {error_msg}")
            return False
    except Exception as e:
        error_msg = f"Exception: {str(e)}"
        log_result("endpoints", "health", False, error_msg)
        print(f"[FAIL] Health endpoint error: {error_msg}")
        return False


def test_ready_endpoint() -> bool:
    """Test readiness endpoint"""
    print("\n" + "="*60)
    print("TEST 7: Readiness Endpoint")
    print("="*60)
    
    try:
        # Ready endpoint doesn't require authentication (read-only)
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/ready", timeout=5)
        
        status_ok = response.status_code in (200, 503)  # Both are valid
        data = response.json()
        
        if status_ok and "ok" in data and "checks" in data:
            log_result("endpoints", "ready", True)
            ready_status = "READY" if data.get("ok") else "NOT READY"
            print(f"[OK] Readiness endpoint working ({ready_status})")
            checks = data.get("checks", {})
            for check_name, check_result in checks.items():
                status_icon = "✓" if check_result else "✗"
                print(f"  {status_icon} {check_name}: {check_result}")
            return True
        else:
            error_msg = "Invalid readiness response format"
            log_result("endpoints", "ready", False, error_msg)
            print(f"[FAIL] {error_msg}")
            return False
    except Exception as e:
        error_msg = f"Exception: {str(e)}"
        log_result("endpoints", "ready", False, error_msg)
        print(f"[FAIL] Readiness endpoint error: {error_msg}")
        return False


def test_metrics_endpoint() -> bool:
    """Test metrics endpoint"""
    print("\n" + "="*60)
    print("TEST 8: Metrics Endpoint")
    print("="*60)
    
    try:
        # Metrics endpoint doesn't require authentication (read-only)
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/metrics", timeout=5)
        
        if response.status_code == 200:
            content_type = response.headers.get("Content-Type", "")
            if "text/plain" in content_type:
                metrics_text = response.text
                if "arcanos_debug" in metrics_text:
                    log_result("endpoints", "metrics", True)
                    print("[OK] Metrics endpoint working")
                    print(f"  Content-Type: {content_type}")
                    print(f"  Metrics lines: {len(metrics_text.splitlines())}")
                    return True
                else:
                    error_msg = "Metrics text doesn't contain expected content"
                    log_result("endpoints", "metrics", False, error_msg)
                    print(f"[FAIL] {error_msg}")
                    return False
            else:
                error_msg = f"Unexpected Content-Type: {content_type}"
                log_result("endpoints", "metrics", False, error_msg)
                print(f"[FAIL] {error_msg}")
                return False
        else:
            error_msg = f"HTTP {response.status_code}"
            log_result("endpoints", "metrics", False, error_msg)
            print(f"[FAIL] Metrics endpoint failed: {error_msg}")
            return False
    except Exception as e:
        error_msg = f"Exception: {str(e)}"
        log_result("endpoints", "metrics", False, error_msg)
        print(f"[FAIL] Metrics endpoint error: {error_msg}")
        return False


def test_error_handling() -> bool:
    """Test error handling (404, invalid requests)"""
    print("\n" + "="*60)
    print("TEST 9: Error Handling")
    print("="*60)
    
    tests_passed = 0
    tests_total = 2
    
    # Test 404
    try:
        response = requests.get(f"{DEBUG_SERVER_URL}/debug/nonexistent", headers=get_debug_auth_headers(), timeout=5)
        if response.status_code == 404:
            print("[OK] 404 handling works")
            tests_passed += 1
        else:
            print(f"[FAIL] Expected 404, got {response.status_code}")
    except Exception as e:
        print(f"[FAIL] 404 test error: {e}")
    
    # Test invalid POST body
    try:
        response = requests.post(f"{DEBUG_SERVER_URL}/debug/ask", headers=get_debug_auth_headers(), data="invalid json", timeout=5)
        if response.status_code == 400:
            print("[OK] Invalid JSON handling works")
            tests_passed += 1
        else:
            print(f"[FAIL] Expected 400, got {response.status_code}")
    except Exception as e:
        print(f"[FAIL] Invalid JSON test error: {e}")
    
    success = tests_passed == tests_total
    log_result("error_handling", "tests", success, None if success else f"{tests_passed}/{tests_total} passed")
    return success


def generate_report():
    """Generate final validation report"""
    print("\n" + "="*60)
    print("VALIDATION REPORT")
    print("="*60)
    
    # Backend connectivity
    backend_ok = results["backend_connectivity"].get("registry_endpoint", {}).get("value", False)
    print(f"\nBackend Connectivity: {'[PASS]' if backend_ok else '[FAIL]'}")
    
    # CLI agent
    cli_ok = results["cli_agent"].get("debug_server", {}).get("value", False)
    print(f"CLI Agent Availability: {'[PASS]' if cli_ok else '[FAIL]'}")
    
    # Commands
    help_ok = results["commands"].get("help", {}).get("value", False)
    status_ok = results["commands"].get("status", {}).get("value", False)
    version_ok = results["commands"].get("version", {}).get("value", False)
    
    print(f"\nCommand Execution:")
    print(f"  help:   {'[PASS]' if help_ok else '[FAIL]'}")
    print(f"  status: {'[PASS]' if status_ok else '[FAIL]'}")
    print(f"  version: {'[PASS]' if version_ok else '[FAIL]'}")
    
    # New endpoints
    health_ok = results.get("endpoints", {}).get("health", {}).get("value", False)
    ready_ok = results.get("endpoints", {}).get("ready", {}).get("value", False)
    metrics_ok = results.get("endpoints", {}).get("metrics", {}).get("value", False)
    
    print(f"\nNew Endpoints:")
    print(f"  health:  {'[PASS]' if health_ok else '[FAIL]'}")
    print(f"  ready:   {'[PASS]' if ready_ok else '[FAIL]'}")
    print(f"  metrics: {'[PASS]' if metrics_ok else '[FAIL]'}")
    
    # Error handling
    error_handling_ok = results.get("error_handling", {}).get("tests", {}).get("value", False)
    print(f"\nError Handling: {'[PASS]' if error_handling_ok else '[FAIL]'}")
    
    # Bugs
    print(f"\nBug Log:")
    if results["bugs"]:
        for i, bug in enumerate(results["bugs"], 1):
            print(f"  {i}. {bug}")
    else:
        print("  No bugs detected")
    
    # Final verdict
    all_tests_passed = (
        backend_ok and cli_ok and help_ok and status_ok and version_ok
        and health_ok and ready_ok and metrics_ok and error_handling_ok
    )
    results["verdict"] = "PASS" if all_tests_passed else "FAIL"
    
    print(f"\n{'='*60}")
    print(f"FINAL VERDICT: {results['verdict']}")
    print(f"{'='*60}")
    
    return results["verdict"] == "PASS"


def generate_html_report():
    """Generate HTML validation report"""
    html = f"""<!DOCTYPE html>
<html>
<head>
    <title>ARCANOS Debug Server Validation Report</title>
    <style>
        body {{ font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }}
        .container {{ max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }}
        h1 {{ color: #333; }}
        .section {{ margin: 20px 0; padding: 15px; background: #f9f9f9; border-radius: 4px; }}
        .pass {{ color: green; font-weight: bold; }}
        .fail {{ color: red; font-weight: bold; }}
        .warn {{ color: orange; font-weight: bold; }}
        table {{ width: 100%; border-collapse: collapse; margin: 10px 0; }}
        th, td {{ padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }}
        th {{ background: #4CAF50; color: white; }}
        .bug {{ background: #ffebee; padding: 10px; margin: 5px 0; border-left: 4px solid #f44336; }}
        .timestamp {{ color: #666; font-size: 0.9em; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>ARCANOS Debug Server Validation Report</h1>
        <p class="timestamp">Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}</p>
        
        <div class="section">
            <h2>Summary</h2>
            <p><strong>Verdict:</strong> <span class="{'pass' if results['verdict'] == 'PASS' else 'fail'}">{results['verdict']}</span></p>
        </div>
        
        <div class="section">
            <h2>Test Results</h2>
            <table>
                <tr><th>Category</th><th>Test</th><th>Status</th><th>Error</th></tr>
"""
    
    # Add test results
    for category, tests in results.items():
        if category in ("bugs", "verdict"):
            continue
        if isinstance(tests, dict):
            for test_name, test_data in tests.items():
                if isinstance(test_data, dict) and "value" in test_data:
                    status = "PASS" if test_data["value"] else "FAIL"
                    error = test_data.get("error", "")
                    html += f'<tr><td>{category}</td><td>{test_name}</td><td class="{"pass" if status == "PASS" else "fail"}">{status}</td><td>{error}</td></tr>\n'
    
    html += """            </table>
        </div>
"""
    
    # Add bugs
    if results.get("bugs"):
        html += """        <div class="section">
            <h2>Issues Found</h2>
"""
        for bug in results["bugs"]:
            html += f'            <div class="bug">{bug}</div>\n'
        html += "        </div>\n"
    
    html += """    </div>
</body>
</html>"""
    
    return html


def main():
    """Main validation function"""
    print("="*60)
    print("BACKEND API & CLI AGENT VALIDATION")
    print("="*60)
    print(f"Backend URL: {Config.BACKEND_URL or 'Not configured'}")
    print(f"Debug Server: {DEBUG_SERVER_URL}")
    print(f"Config Version: {Config.VERSION}")
    
    # Run tests
    test_backend_connectivity()
    test_cli_agent_availability()
    
    # Only test commands if CLI agent is available
    if results["cli_agent"].get("debug_server", {}).get("value", False):
        test_help_command()
        test_status_command()
        test_version_command()
        test_health_endpoint()
        test_ready_endpoint()
        test_metrics_endpoint()
        test_error_handling()
    else:
        print("\n[WARN] Skipping command tests - CLI agent not available")
        log_result("commands", "help", False, "CLI agent not available")
        log_result("commands", "status", False, "CLI agent not available")
        log_result("commands", "version", False, "CLI agent not available")
        log_result("endpoints", "health", False, "CLI agent not available")
        log_result("endpoints", "ready", False, "CLI agent not available")
        log_result("endpoints", "metrics", False, "CLI agent not available")
        log_result("error_handling", "tests", False, "CLI agent not available")
    
    # Generate report
    success = generate_report()
    
    # Save results to file
    results_file = Path(__file__).parent / "validation_results.json"
    with open(results_file, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nResults saved to: {results_file}")
    
    # Generate HTML report
    html_report = generate_html_report()
    html_file = Path(__file__).parent / "validation_report.html"
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html_report)
    print(f"HTML report saved to: {html_file}")
    
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
