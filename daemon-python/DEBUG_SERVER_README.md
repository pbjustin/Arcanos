# Daemon Debug Server

## Overview
The daemon can expose a local debug HTTP server for operator tooling and IDE integrations.

## Prerequisites
- Daemon installed and runnable.
- Localhost access only (`127.0.0.1`).
- Strong debug token configured for authenticated endpoints.

## Setup
Enable debug server in `daemon-python/.env`:
```env
DEBUG_SERVER_ENABLED=true
DEBUG_SERVER_PORT=9999
DEBUG_SERVER_TOKEN=<strong-random-token>
```

Legacy toggles also enable debug mode:
- `IDE_AGENT_DEBUG=true`
- `DAEMON_DEBUG_PORT=<port>`

## Configuration
Auth behavior:
- `/debug/health`, `/debug/ready`, `/debug/metrics` are unauthenticated read-only endpoints.
- Other endpoints require one of:
  - `Authorization: Bearer <DEBUG_SERVER_TOKEN>`
  - `X-Debug-Token: <DEBUG_SERVER_TOKEN>`
  - automation secret header flow (`ARCANOS_AUTOMATION_SECRET`)

Key endpoints:
- `GET /debug/status`
- `GET /debug/help`
- `GET /debug/logs?tail=50`
- `GET /debug/audit?limit=50`
- `POST /debug/ask`
- `POST /debug/run`
- `POST /debug/see`

## Run locally
Start daemon, then query debug server:
```bash
curl http://127.0.0.1:9999/debug/health
curl -H "Authorization: Bearer <DEBUG_SERVER_TOKEN>" http://127.0.0.1:9999/debug/status
```

## Deploy (Railway)
Not applicable. Debug server is local daemon functionality.

## Troubleshooting
- Connection refused: daemon not running or debug server not enabled.
- 401 responses: missing/invalid token headers.
- No debug logs: confirm `LOG_DIR` path and file permissions.

## References
- `arcanos/debug_server.py`
- `arcanos/config.py`
- `README.md`
