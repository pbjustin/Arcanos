# ARCANOS Debug Server API Reference

Complete API reference for the ARCANOS CLI debug server.

## Base URL

All endpoints are served at `http://127.0.0.1:<port>` (default port: 9999).

## Response Format

All JSON endpoints return responses in the following format:

```json
{
  "ok": true,
  "data": {...},
  "error": null,
  "meta": {
    "request_id": "uuid",
    "timestamp": 1234567890.123,
    "duration_ms": 5.2
  }
}
```

**Note:** Legacy endpoints may not include the `meta` field. New endpoints and versioned endpoints (`/debug/v1/*`) will always include it.

## Error Responses

Error responses follow this format:

```json
{
  "ok": false,
  "error": "Error message",
  "error_code": "DEBUG_ERROR_NOT_FOUND"
}
```

## GET Endpoints

### `GET /debug/status`

Get CLI agent status and instance information.

**Response:**
```json
{
  "ok": true,
  "instanceId": "abc-123",
  "clientId": "arcanos-daemon",
  "uptime": 3600,
  "backend_configured": true,
  "version": "1.1.2",
  "last_error": null
}
```

### `GET /debug/health`

Liveness probe. Always returns 200 if the server is running.

**Response:**
```json
{
  "ok": true,
  "ts": 1234567890.123,
  "version": "1.1.2"
}
```

**Status Codes:**
- `200` - Server is alive

### `GET /debug/ready`

Readiness probe. Checks if CLI is initialized and dependencies are healthy.

**Response:**
```json
{
  "ok": true,
  "checks": {
    "cli_initialized": true,
    "backend_healthy": true,
    "log_dir_writable": true,
    "memory_ok": true
  },
  "ts": 1234567890.123,
  "version": "1.1.2"
}
```

**Status Codes:**
- `200` - Ready
- `503` - Not ready (one or more checks failed)

### `GET /debug/metrics`

Export Prometheus-compatible metrics.

**Response:** Plain text (Prometheus format)

**Content-Type:** `text/plain; version=0.0.4`

**Example:**
```
# TYPE arcanos_debug_requests_total counter
arcanos_debug_requests_total{endpoint="/debug/status"} 42
# TYPE arcanos_debug_errors_total counter
arcanos_debug_errors_total{endpoint="/debug/status"} 0
```

### `GET /debug/instance-id`

Get the instance ID.

**Response:**
```json
{
  "ok": true,
  "instanceId": "abc-123"
}
```

### `GET /debug/help`

Get help text (markdown formatted).

**Response:**
```json
{
  "ok": true,
  "help_text": "# ARCANOS Commands\n\n..."
}
```

### `GET /debug/chat-log`

Get recent conversation log.

**Response:**
```json
{
  "ok": true,
  "chat_log": [
    {
      "role": "user",
      "message": "Hello",
      "timestamp": "2024-01-01T00:00:00Z"
    },
    {
      "role": "assistant",
      "message": "Hi there!",
      "timestamp": "2024-01-01T00:00:01Z"
    }
  ],
  "last_error": null
}
```

### `GET /debug/logs?tail=50`

Get error logs.

**Query Parameters:**
- `tail` (optional): Number of lines to return (default: 50, max: 1000)

**Response:**
```json
{
  "ok": true,
  "path": "/path/to/logs/errors.log",
  "lines": ["2024-01-01 ERROR: ...", "2024-01-01 INFO: ..."],
  "total": 1000,
  "returned": 50
}
```

### `GET /debug/log-files`

List log files in the log directory.

**Response:**
```json
{
  "ok": true,
  "log_dir": "/path/to/logs",
  "files": [
    {
      "name": "errors.log",
      "mtime": 1234567890.123,
      "size": 1024
    }
  ]
}
```

### `GET /debug/audit?limit=50&filter=error&order=desc`

Get audit trail (activity log).

**Query Parameters:**
- `limit` (optional): Number of entries to return (default: 50, max: 500)
- `filter` (optional): Filter by activity kind (e.g., "error", "ask", "run", "see")
- `order` (optional): Sort order - "asc" (oldest first) or "desc" (newest first, default)

**Response:**
```json
{
  "ok": true,
  "entries": [
    {
      "ts": "2024-01-01T00:00:00Z",
      "kind": "ask",
      "detail": "test message"
    }
  ],
  "total": 200,
  "returned": 50,
  "limit": 50
}
```

### `GET /debug/crash-reports`

Get crash reports.

**Response:**
```json
{
  "ok": true,
  "files": [
    {
      "name": "crash_20240101_000000.txt",
      "mtime": 1234567890.123,
      "size": 2048
    }
  ],
  "latest_content": "Crash report content..."
}
```

## POST Endpoints

### `POST /debug/ask`

Send a message to the AI.

**Request Body:**
```json
{
  "message": "What is the weather?",
  "route_override": "backend"
}
```

**Parameters:**
- `message` (required): The message to send
- `route_override` (optional): Force routing ("backend" or "local")

**Response:**
```json
{
  "ok": true,
  "response_text": "The weather is sunny...",
  "tokens_used": 150,
  "cost_usd": 0.001,
  "model": "gpt-4o-mini",
  "source": "local"
}
```

**Status Codes:**
- `200` - Success
- `400` - Missing or invalid request body
- `500` - Failed to handle command

### `POST /debug/run`

Execute a shell command.

**Request Body:**
```json
{
  "command": "ls -la"
}
```

**Parameters:**
- `command` (required): Shell command to execute

**Response:**
```json
{
  "ok": true,
  "output": "total 16\ndrwxr-xr-x ...",
  "exit_code": 0
}
```

**Status Codes:**
- `200` - Success
- `400` - Missing or invalid request body

### `POST /debug/see`

Analyze screenshot or webcam image.

**Request Body:**
```json
{
  "use_camera": false
}
```

**Parameters:**
- `use_camera` (optional): If true, use webcam; if false, use screenshot (default: false)

**Response:**
```json
{
  "ok": true,
  "analysis": "The image shows a desktop with..."
}
```

**Status Codes:**
- `200` - Success
- `500` - Failed to handle command

## Error Codes

- `DEBUG_ERROR_NOT_FOUND` - Endpoint not found (404)
- `DEBUG_ERROR_INVALID_REQUEST` - Invalid request body or parameters (400)
- `DEBUG_ERROR_INTERNAL` - Internal server error (500)

## Rate Limiting

Rate limiting is configured via `DEBUG_SERVER_RATE_LIMIT` (default: 60 requests per minute per endpoint). When rate limited, endpoints return `429 Too Many Requests`.

## Logging

All requests are logged to `logs/debug_server.log` in JSON format with:
- Timestamp
- Log level
- Request method and path
- Status code
- Duration (ms)
- Request ID

## Metrics

Metrics are exported in Prometheus format at `/debug/metrics`:
- `arcanos_debug_requests_total` - Total requests per endpoint
- `arcanos_debug_errors_total` - Total errors per endpoint
- `arcanos_debug_request_duration_ms_*` - Request duration statistics
- `arcanos_debug_uptime_seconds` - Server uptime

## Security

- Server only binds to `127.0.0.1` (localhost-only)
- No authentication required (intended for local development/debugging)
- CORS can be enabled via `DEBUG_SERVER_CORS_ENABLED` for web UI development
