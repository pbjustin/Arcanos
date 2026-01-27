# Debugging the Live ARCANOS Daemon

This document explains how to enable and use the local debug server for the ARCANOS daemon. This server allows IDEs, CLI tools, and other agents to inspect the live daemon's status, logs, and activity, and to send commands for debugging purposes.

## Enabling the Debug Server

To enable the debug server, you need to set one of the following environment variables before starting the ARCANOS application:

- **`IDE_AGENT_DEBUG=1`**: Enables the debug server on the default port (9999).
- **`DAEMON_DEBUG_PORT=<port>`**: Enables the debug server on a specific port. For example, `DAEMON_DEBUG_PORT=9999`.

### For Installed Application

1.  Open or create the `.env` file in your user's local application data directory for ARCANOS. The path is typically:
    - **Windows**: `%LOCALAPPDATA%\ARCANOS\.env`
    - **macOS**: `~/Library/Application Support/ARCANOS/.env`
    - **Linux**: `~/.local/share/ARCANOS/.env`
2.  Add one of the following lines to the file:
    ```
    IDE_AGENT_DEBUG=1
    ```
    or
    ```
    DAEMON_DEBUG_PORT=9999
    ```
3.  Save the file and **restart the ARCANOS application**.

### For Development

1.  Edit the `daemon-python/.env` file in your project directory.
2.  Add or uncomment the debug variables:
    ```
    IDE_AGENT_DEBUG=1
    # or
    DAEMON_DEBUG_PORT=9999
    ```
3.  Run the daemon as usual (`python -m arcanos.cli`).

## Using the Debug Server API

You can interact with the debug server using HTTP requests or curl commands.

### Port Configuration

The debug server uses the port specified in the `DAEMON_DEBUG_PORT` or `DEBUG_SERVER_PORT` environment variable. If that variable is not set, it defaults to `9999`.

### Available Endpoints

Here are the available endpoints. The debug server runs on `http://127.0.0.1:9999` by default.

**GET Endpoints:**
-   **`GET /debug/status`**: Shows the current status of the daemon, including instance ID, uptime, and the last recorded error.
-   **`GET /debug/instance-id`**: Retrieves just the instance ID.
-   **`GET /debug/chat-log`**: Displays the recent conversation history (the "chat log").
-   **`GET /debug/logs?tail=50`**: Shows the tail of the main daemon log file (`errors.log`). This is useful to **see your logs**.
    -   Query param: `tail` (number of lines, default: 50, max: 1000).
-   **`GET /debug/log-files`**: Lists all files in the log directory.
-   **`GET /debug/audit?limit=50`**: Displays the in-memory activity trail (ask, see, run, voice, commands, errors). This helps you see **what's happening**.
    -   Query params: `limit` (number of entries, default: 50, max: 500), `filter` (optional), `order` (optional).
-   **`GET /debug/crash-reports`**: Lists crash report files and displays the content of the most recent one.

**POST Endpoints:**
-   **`POST /debug/ask`**: Sends a conversational prompt to the daemon.
    -   Body: `{"message": "your message", "route_override": "backend" (optional)}`
-   **`POST /debug/run`**: Executes a shell command through the daemon's `run` handler.
    -   Body: `{"command": "your command"}`
-   **`POST /debug/see`**: Captures the screen and returns the AI's description.
    -   Body: `{"use_camera": false}` (optional, default: false)

### Example Usage with curl

```bash
# Get status
curl http://127.0.0.1:9999/debug/status

# Get logs
curl http://127.0.0.1:9999/debug/logs?tail=100

# Send a message
curl -X POST http://127.0.0.1:9999/debug/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "What is your status?"}'

# Execute a command
curl -X POST http://127.0.0.1:9999/debug/run \
  -H "Content-Type: application/json" \
  -d '{"command": "echo hello"}'
```

**Note:** On Windows, you can use PowerShell's `Invoke-WebRequest` or `Invoke-RestMethod` if curl is not available.

## Security

The debug server is designed for local use only and binds exclusively to `127.0.0.1`. This **does not** by itself make it safe to expose powerful operations like `run`, `see`, or log/crash-report access: modern web browsers can still issue cross-origin requests to `http://127.0.0.1:<port>`, so a malicious website opened in your browser could trigger debug operations on your machine if the server is enabled without additional protection.

For this reason, you must protect the debug server with an unguessable secret (for example, via an environment variable such as `DAEMON_DEBUG_TOKEN` that the client must send with each request) and/or with strict `Origin`/`Host` header checks to reject browser-driven cross-site requests. Treat the debug API as a high-privilege local interface: assume that any user or process on the machine, as well as any website running in your browser, can attempt to connect to it. Do not enable the debug server without such protections, and never enable it on machines or user accounts that may run untrusted code or browse untrusted websites.
