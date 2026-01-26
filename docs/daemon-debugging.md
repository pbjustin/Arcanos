# Debugging the Live ARCANOS Daemon

This document explains how to enable and use the local debug server for the ARCANOS daemon. This server allows IDEs, CLI tools, and other agents to inspect the live daemon's status, logs, and activity, and to send commands for debugging purposes.

## Enabling the Debug Server

To enable the debug server, you need to set one of the following environment variables before starting the ARCANOS application:

- **`IDE_AGENT_DEBUG=1`**: Enables the debug server on the default port (9999).
- **`DAEMON_DEBUG_PORT=<port>`**: Enables the debug server on a specific port. For example, `DAEMON_DEBUG_PORT=9999`.

### For the Installed .exe

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
3.  Run the daemon as usual (`python daemon-python/cli.py`).

## Using the `daemon-debug.ps1` CLI

The easiest way to interact with the debug server is by using the `scripts/daemon-debug.ps1` PowerShell script.

### Port Configuration

The script will automatically connect to the port specified in the `DAEMON_DEBUG_PORT` environment variable. If that variable is not set, it defaults to `9999`.

### Commands

Here are the available commands. Run them from your project's root directory.

-   **`scripts\daemon-debug.ps1 status`**: Shows the current status of the daemon, including instance ID, uptime, and the last recorded error.
-   **`scripts\daemon-debug.ps1 instance-id`**: Retrieves just the instance ID.
-   **`scripts\daemon-debug.ps1 chat-log`**: Displays the recent conversation history (the "chat log").
-   **`scripts\daemon-debug.ps1 logs`**: Shows the tail of the main daemon log file (`errors.log`). This is useful to **see your logs**.
    -   `--tail <number>`: Specify the number of lines to show (e.g., `--tail 100`).
-   **`scripts\daemon-debug.ps1 log-files`**: Lists all files in the log directory.
-   **`scripts\daemon-debug.ps1 audit`**: Displays the in-memory activity trail (ask, see, run, voice, commands, errors). This helps you see **what's happening**.
    -   `--limit <number>`: Specify the number of entries to show (e.g., `--limit 100`).
-   **`scripts\daemon-debug.ps1 see`**: Captures the screen and returns the AI's description.
    -   `--camera`: Use the webcam instead of the screen.
-   **`scripts\daemon-debug.ps1 crash-reports`**: Lists crash report files and displays the content of the most recent one.
-   **`scripts\daemon-debug.ps1 ask "your message"`**: Sends a conversational prompt to the daemon.
-   **`scripts\daemon-debug.ps1 run "your command"`**: Executes a shell command through the daemon's `run` handler.

## Security

The debug server is designed for local use only and binds exclusively to `127.0.0.1`. It is not accessible from the network. However, be aware that any user or process on the local machine with knowledge of the port can access this debugging interface. Do not enable it in untrusted environments.
