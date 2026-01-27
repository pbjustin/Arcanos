# ARCANOS CLI Debug Server

This document explains how to start the ARCANOS CLI with debug server enabled for validation and testing.

## Quick Start

### Starting the CLI Agent with Debug Server

**Option 1: Using environment variables (Cross-platform)**
```bash
cd daemon-python
export IDE_AGENT_DEBUG=true
export DAEMON_DEBUG_PORT=9999
python -m arcanos.cli
```

**Option 2: Using .env file**
Add to `daemon-python/.env`:
```
IDE_AGENT_DEBUG=true
DAEMON_DEBUG_PORT=9999
```

Then run:
```bash
cd daemon-python
python -m arcanos.cli
```

**Option 3: Windows PowerShell (if using PowerShell)**
```powershell
cd daemon-python
$env:IDE_AGENT_DEBUG = "true"
$env:DAEMON_DEBUG_PORT = "9999"
python -m arcanos.cli
```

The debug server will start on `http://127.0.0.1:9999` and you should see a message like:
```
✓ IDE agent debug server on 127.0.0.1:9999
```

### Running Validation

Once the CLI agent is running with debug server enabled, open a **new terminal window** and run:

```bash
cd daemon-python
python validate_backend_cli.py
```

The validation script will:
1. Test backend API connectivity
2. Test CLI agent debug server availability
3. Execute commands: `help`, `status`, `version`
4. Generate a validation report

## Debug Server Endpoints

**Security Note:** All endpoints except `/debug/health`, `/debug/ready`, and `/debug/metrics` require authentication via `DEBUG_SERVER_TOKEN`. See the Configuration section below for details.

The debug server exposes the following endpoints:

### GET Endpoints

- **`GET /debug/status`** - Get CLI agent status
  - Returns: `instanceId`, `clientId`, `uptime`, `backend_configured`, `version`, `last_error`
  
- **`GET /debug/help`** - Get help text
  - Returns: `help_text` (markdown formatted command documentation)
  
- **`GET /debug/instance-id`** - Get instance ID
  - Returns: `instanceId`
  
- **`GET /debug/chat-log`** - Get recent conversation log
  - Returns: `chat_log` (array of conversation entries)
  
- **`GET /debug/logs?tail=50`** - Get error logs
  - Query params: `tail` (number of lines, default: 50, max: 1000)
  - Returns: `path`, `lines` (array of log lines), `total`, `returned`
  
- **`GET /debug/log-files`** - List log files
  - Returns: `log_dir`, `files` (array of file metadata)
  
- **`GET /debug/audit?limit=50&filter=error&order=desc`** - Get audit trail
  - Query params:
    - `limit` (number of entries, default: 50, max: 500)
    - `filter` (optional: filter by activity kind, e.g., "error", "ask", "run")
    - `order` (optional: "asc" or "desc", default: "desc")
  - Returns: `entries`, `total`, `returned`, `limit`
  
- **`GET /debug/crash-reports`** - Get crash reports
  - Returns: `files` (array of crash report files), `latest_content` (content of most recent crash report)

- **`GET /debug/health`** - Liveness probe (always returns 200 if server is running)
  - Returns: `{"ok": true, "ts": float, "version": str}`
  
- **`GET /debug/ready`** - Readiness probe (checks CLI initialization and dependencies)
  - Returns: `{"ok": bool, "checks": {...}, "ts": float, "version": str}` (200 if ready, 503 if not)
  
- **`GET /debug/metrics`** - Prometheus metrics export
  - Returns: Prometheus text format (Content-Type: text/plain)

### POST Endpoints

- **`POST /debug/ask`** - Send a message to the AI
  - Body: `{"message": "your message", "route_override": "backend" (optional)}`
  - Returns: `_ConversationResult` with `response_text`, `tokens_used`, `cost_usd`, `model`, `source`
  
- **`POST /debug/run`** - Execute a shell command
  - Body: `{"command": "your command"}`
  - Returns: Command execution result
  
- **`POST /debug/see`** - Analyze screenshot or webcam
  - Body: `{"use_camera": false}` (optional, default: false)
  - Returns: Vision analysis result

## Configuration

The debug server is enabled when **any** of these conditions is met:

1. **`DEBUG_SERVER_ENABLED=true`** (or `"1"`, `"yes"`) - New recommended setting
2. **`IDE_AGENT_DEBUG=true`** (or `"1"`, `"yes"`) - Legacy setting
3. **`DAEMON_DEBUG_PORT=<port>`** - Legacy setting with a positive integer port number

**New Configuration Options:**
- **`DEBUG_SERVER_PORT`** - Port number (default: 9999)
- **`DEBUG_SERVER_LOG_LEVEL`** - Logging level: DEBUG, INFO, WARN, ERROR (default: INFO)
- **`DEBUG_SERVER_METRICS_ENABLED`** - Enable Prometheus metrics (default: true)
- **`DEBUG_SERVER_CORS_ENABLED`** - Enable CORS headers (default: false)
- **`DEBUG_SERVER_LOG_RETENTION_DAYS`** - Days to keep log files (default: 7)
- **`DEBUG_SERVER_TOKEN`** - **REQUIRED for security** - Authentication token for debug server endpoints. Generate with: `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Without this, the server will reject requests to prevent RCE vulnerabilities.
- **`DEBUG_SERVER_ALLOW_UNAUTHENTICATED`** - **NOT RECOMMENDED** - Allow unauthenticated access (default: false). Only enable in secure development environments. Setting this to true disables authentication and exposes the server to RCE attacks.

If `DEBUG_SERVER_PORT` is not set, falls back to `DAEMON_DEBUG_PORT`, or defaults to **9999**.

### Rate Limiting Configuration

To reduce backend load (especially if the backend is rate-limited by GitHub or other services), you can configure longer intervals:

- **`DAEMON_HEARTBEAT_INTERVAL_SECONDS=<seconds>`** - How often to send heartbeat to backend (default: 60 seconds)
- **`DAEMON_COMMAND_POLL_INTERVAL_SECONDS=<seconds>`** - How often to poll for commands (default: 30 seconds)

**Note:** Longer intervals mean fewer requests to the backend, which helps avoid rate limiting but also means:
- Commands from the backend may take longer to be received
- Backend may consider the CLI agent "offline" if heartbeat interval is too long

You can set these environment variables in your `.env` file or export them before starting the CLI to reduce backend load.

## Expected Behavior

### When Starting the CLI

When the CLI starts with debug enabled, you should see:
- Console message: `✓ IDE agent debug server on 127.0.0.1:9999`
- CLI remains in foreground (attached to terminal)
- Debug server runs in a background daemon thread

### When Running Validation

The validation script expects:
- **Backend Connectivity**: PASS (backend API at `http://localhost:8080` is reachable)
- **CLI Agent Availability**: PASS (debug server responds to `GET /debug/status`)
- **Command Execution**:
  - `help`: PASS (returns help text via `GET /debug/help`)
  - `status`: PASS (returns status via `GET /debug/status`)
  - `version`: PASS (version included in status response)

## Troubleshooting

### Debug Server Not Starting

**Problem**: No "IDE agent debug server" message appears

**Solutions**:
1. Verify environment variables are set:
   ```bash
   # On macOS/Linux:
   echo $IDE_AGENT_DEBUG
   echo $DAEMON_DEBUG_PORT
   # On Windows (PowerShell):
   # $env:IDE_AGENT_DEBUG
   # $env:DAEMON_DEBUG_PORT
   ```
2. Check that the CLI process started successfully (no errors in console)
3. Verify port 9999 is not already in use:
   ```bash
   # On macOS/Linux:
   lsof -i :9999
   # On Windows:
   # netstat -an | findstr :9999
   ```

### Connection Refused

**Problem**: Validation script reports "connection refused" on `http://127.0.0.1:9999`

**Solutions**:
1. Ensure the CLI agent is running (check the terminal window where you started it)
2. Verify the debug server started (look for the success message)
3. Check if another process is using port 9999
4. Try a different port by setting `DAEMON_DEBUG_PORT` to a different value

### Authentication Errors

**Problem**: Requests return 401 "Authentication required" errors

**Solutions**:
1. **Set DEBUG_SERVER_TOKEN environment variable:**
   ```bash
   # Generate a secure token:
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   
   # Set it (macOS/Linux):
   export DEBUG_SERVER_TOKEN="your-generated-token-here"
   
   # Or add to .env file:
   echo "DEBUG_SERVER_TOKEN=your-generated-token-here" >> daemon-python/.env
   ```

2. **Use the token in requests:**
   ```bash
   # Via Authorization header (recommended):
   curl -H "Authorization: Bearer $DEBUG_SERVER_TOKEN" http://127.0.0.1:9999/debug/status
   
   # Via X-Debug-Token header:
   curl -H "X-Debug-Token: $DEBUG_SERVER_TOKEN" http://127.0.0.1:9999/debug/status
   
   # Via query parameter (less secure):
   curl "http://127.0.0.1:9999/debug/status?token=$DEBUG_SERVER_TOKEN"
   ```

3. **For development only** (NOT RECOMMENDED for production):
   ```bash
   # Only use in isolated development environments:
   export DEBUG_SERVER_ALLOW_UNAUTHENTICATED=true
   ```

### Commands Failing

**Problem**: Validation shows command execution failures

**Solutions**:
1. Check the CLI agent console for errors
2. Verify authentication is configured (see "Authentication Errors" above)
3. Verify the debug server endpoints are accessible:
   ```bash
   # Using curl with authentication (cross-platform):
   curl -H "Authorization: Bearer $DEBUG_SERVER_TOKEN" http://127.0.0.1:9999/debug/status
   # On Windows PowerShell:
   # $headers = @{"Authorization" = "Bearer $env:DEBUG_SERVER_TOKEN"}
   # Invoke-WebRequest -Uri "http://127.0.0.1:9999/debug/status" -Headers $headers
   ```
4. Review the validation results JSON file for detailed error messages

## Notes

- The debug server is **localhost-only** (127.0.0.1) for security
- Environment variables set in the terminal are **session-only** and won't persist after closing the terminal (use `.env` file for persistence)
- The CLI agent must remain running for the debug server to be accessible
- Use Ctrl+C in the CLI agent window to stop it (this also stops the debug server)
