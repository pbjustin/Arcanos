# Daemon Architecture: HTTP-Based Connection Model

## Overview

The ARCANOS daemon uses an HTTP-based connection model that provides GPT-like interaction with elevated privileges. The daemon behaves like a Custom GPT at the surface level (same `/api/ask` intake) but has additional capabilities for heartbeat, commands, status reporting, and module access.

## Architecture Principles

### GPT-like Surface
- **Same intake**: Uses `/api/ask`, `/api/vision`, `/api/transcribe` endpoints (same as Custom GPTs)
- **HTTP-only**: No WebSocket by default (`IPC_ENABLED=false`)
- **Same request shape**: Compatible with Custom GPT action format

### Elevated Privileges
- **Daemon-only endpoints**: `/api/daemon/heartbeat`, `/api/daemon/commands`, `/api/daemon/commands/ack`, `/api/update`
- **Module access**: Can call `/gpt/:gptId` endpoints without `gpt_id` validation (authenticated via Bearer token)
- **Natural language routing**: Automatic module routing via domain hints in `/api/ask`

## Connection Model

### HTTP-Only (Default)
- **Default mode**: `IPC_ENABLED=false`
- **All communication**: HTTP REST requests
- **Benefits**: Works everywhere, no WebSocket proxy issues, Railway-compatible

### Optional IPC Mode
- **Opt-in**: Set `IPC_ENABLED=true` for WebSocket IPC
- **Use case**: Local development or environments where WebSocket works reliably
- **Fallback**: Updates still fall back to REST if IPC fails

## Daemon Identification

### Client ID
- **Static identifier**: `"arcanos-daemon"` (identifies client type)
- **Used in**: All requests, heartbeat, metadata

### Instance ID
- **Unique identifier**: UUID generated on first run
- **Persistence**: Stored in daemon memory, reused across restarts
- **Used in**: Heartbeat, commands, metadata for tracking specific daemon installations

## API Endpoints

### Shared with Custom GPTs
- `POST /api/ask` - Chat/completion requests (with domain routing)
- `POST /api/vision` - Image analysis
- `POST /api/transcribe` - Audio transcription

### Daemon-Only (Elevated)
- `POST /api/daemon/heartbeat` - Send heartbeat with status/stats
- `GET /api/daemon/commands` - Poll for pending commands
- `POST /api/daemon/commands/ack` - Acknowledge processed commands
- `POST /api/update` - Send update events

### Module Access
- `POST /gpt/:gptId` - Access backend modules (daemon bypasses `gpt_id` validation)

## Natural Language Protocol

### Intent Detection
The daemon detects user intent from natural language input:
- **Keyword matching**: Simple pattern matching (e.g., "book a match" → `domain: "backstage:booker"`)
- **Extensible**: Can be enhanced with AI-based classification

### Domain Routing
- **Domain hints**: Daemon sets `domain` in `/api/ask` requests
- **Backend dispatcher**: `/api/ask` routes to modules based on domain
- **Fallback**: If no domain match, falls back to Trinity brain (general AI conversation)

### Example Flow
1. User: "book a match between John Cena and The Rock"
2. Daemon detects: `domain: "backstage:booker"`
3. Daemon calls: `POST /api/ask` with `{ message: "...", domain: "backstage:booker", metadata: {...} }`
4. Backend dispatcher routes to Backstage Booker module
5. Module executes `bookEvent` action
6. Result formatted as natural language response

## Heartbeat & Commands

### Heartbeat Loop
- **Interval**: Configurable (default: 30 seconds, via `IPC_HEARTBEAT_INTERVAL_SECONDS`)
- **Payload**: `clientId`, `instanceId`, `version`, `uptime`, `routingMode`, `stats`
- **Purpose**: Maintain presence, report status, replace `ping`/`get_status`/`get_stats`

### Command Polling
- **Interval**: 10 seconds (configurable)
- **Flow**: Poll `GET /api/daemon/commands` → process commands → `POST /api/daemon/commands/ack`
- **Commands**: Reuse existing `_handle_ipc_command` logic (ping, get_status, get_stats, notify)

## Authentication

### Bearer Token
- **Header**: `Authorization: Bearer <token>`
- **Source**: `BACKEND_TOKEN` environment variable
- **Used for**: All daemon endpoints, module access

### Daemon Bypass
- **Module access**: Daemon requests to `/gpt/:gptId` bypass `gpt_id` validation
- **Identification**: Backend recognizes daemon via Bearer token
- **Privilege**: Daemon can access any module without matching `gpt_id`

## Metadata

All daemon requests include metadata:
```json
{
  "source": "daemon",
  "client": "arcanos-daemon",
  "instanceId": "<uuid>"
}
```

This metadata is included in:
- `/api/ask` requests
- `/api/vision` requests
- `/api/transcribe` requests
- `/api/update` requests

## Configuration

### Environment Variables
- `BACKEND_URL` - Backend server URL (required for daemon service)
- `BACKEND_TOKEN` - Bearer token for authentication (required)
- `IPC_ENABLED` - Enable WebSocket IPC (default: `false`)
- `IPC_HEARTBEAT_INTERVAL_SECONDS` - Heartbeat interval (default: `30`)

### Daemon Settings
- Instance ID stored in daemon memory (persistent across restarts)
- Client ID: `"arcanos-daemon"` (static)

## Railway Deployment

### Compatibility
- **HTTP-only mode**: Works through Railway's proxy (no WebSocket issues)
- **Health checks**: New endpoints don't affect `/health` endpoint
- **Environment variables**: All required variables documented in `.env.example`

### Deployment Notes
- Daemon runs client-side (local machine)
- Backend deployed on Railway
- Daemon connects to Railway-deployed backend via HTTP

## Benefits Over WebSocket IPC

| Feature | WebSocket IPC | HTTP REST |
|---------|---------------|-----------|
| **Reliability** | Proxy issues on Railway | Works everywhere |
| **Simplicity** | Complex connection management | Simple request/response |
| **Debugging** | Hard to debug | Standard HTTP debugging |
| **Compatibility** | Requires WebSocket support | Universal HTTP support |

## Future Enhancements

- **AI-based intent detection**: Replace keyword matching with AI classification
- **Persistent command queue**: Migrate from in-memory to database/Redis
- **Enhanced stats**: More detailed statistics in heartbeat payload
- **Command batching**: Batch command acknowledgments for efficiency
