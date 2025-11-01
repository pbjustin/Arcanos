# Arcanos Backend API Reference

This document expands on the endpoint catalogue with request/response examples.
Refer to [`docs/api/README.md`](README.md) for a high-level overview.

## Base URL
- **Development:** `http://localhost:8080`
- **Production:** e.g. `https://your-app.railway.app`

All examples assume JSON requests unless noted.

---

## Core Conversational APIs

### `POST /ask`
Primary chat endpoint. No confirmation header required.

**Request**
```json
{
  "prompt": "Summarise the current system status.",
  "sessionId": "demo-session"
}
```

**Response (abridged)**
```json
{
  "result": "System is healthy and running on port 8080.",
  "meta": {
    "id": "ask_1729988700",
    "created": 1729988700,
    "tokens": {
      "prompt_tokens": 45,
      "completion_tokens": 128,
      "total_tokens": 173
    }
  },
  "activeModel": "gpt-4o"
}
```

### `POST /brain`
Alias for `/ask` that requires confirmation.

```bash
curl -X POST http://localhost:8080/brain \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"prompt":"Run diagnostics"}'
```

### `POST /arcanos`
Diagnostic orchestration endpoint. Requires confirmation.

**Request**
```json
{
  "userInput": "Audit system health and report degraded services.",
  "sessionId": "ops-001"
}
```

**Response highlights**
- `result` – Rich diagnostic summary.
- `componentStatus` – Service-level status message.
- `taskLineage` – Request ID and logging flag.
- `gpt5Delegation` – Indicates whether GPT‑5 reasoning was used.

### `POST /api/arcanos/ask`
Programmatic JSON API (confirmation required).
Supports optional streaming via `options.stream`.

```bash
curl -X POST http://localhost:8080/api/arcanos/ask \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"prompt":"Ping"}'
```

Response:
```json
{
  "success": true,
  "result": "pong",
  "metadata": {
    "service": "ARCANOS API",
    "version": "1.0.0",
    "timestamp": "2024-10-30T12:00:00.000Z"
  }
}
```

### `POST /arcanos-pipeline`
Executes the four-stage pipeline (ARCANOS → GPT‑3.5 sub-agent → GPT‑5 →
ARCANOS). Requires confirmation.

**Request**
```json
{
  "messages": [
    { "role": "user", "content": "Provide a remediation plan for a failed deployment." }
  ]
}
```

**Response**
```json
{
  "result": {
    "role": "assistant",
    "content": "Step-by-step remediation plan..."
  },
  "stages": {
    "arcFirst": { "content": "Initial ARCANOS output" },
    "subAgent": { "content": "GPT-3.5 refinement" },
    "gpt5Reasoning": { "content": "GPT-5 oversight summary" }
  }
}
```

---

## AI Utility Routes

### `POST /write`
Generates long-form content. Requires confirmation.

```bash
curl -X POST http://localhost:8080/write \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"prompt":"Create a release announcement"}'
```

Other utility endpoints (`/guide`, `/audit`, `/sim`) follow the same request
shape and require the confirmation header.

### `POST /image`
Creates images using the OpenAI Images API.

```bash
curl -X POST http://localhost:8080/image \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A futuristic AI assistant","size":"1024x1024"}'
```

**Response** – JSON payload containing the generated image URL or base64
encoded data depending on OpenAI SDK configuration.

### `POST /api/sim`
Simulation API (confirmation not required by default).

**Request**
```json
{
  "scenario": "Model the impact of increased memory latency.",
  "context": "Assume 20% higher latency across cache levels.",
  "parameters": {
    "temperature": 0.6,
    "stream": false
  }
}
```

**Response**
```json
{
  "status": "success",
  "message": "Simulation completed successfully",
  "data": {
    "scenario": "Model the impact of increased memory latency.",
    "result": "Detailed narrative...",
    "metadata": {
      "model": "gpt-4o",
      "tokensUsed": 742,
      "timestamp": "2024-10-30T12:05:00.000Z",
      "simulationId": "sim_1729988700123"
    }
  }
}
```

---

## Memory & State APIs

### `POST /api/memory/save`
Confirmation required.

```bash
curl -X POST http://localhost:8080/api/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"key":"incident:1234","value":{"summary":"Database failover executed"}}'
```

### `GET /api/memory/load`
```bash
curl "http://localhost:8080/api/memory/load?key=incident:1234"
```

**Response**
```json
{
  "status": "success",
  "message": "Memory loaded successfully",
  "data": {
    "key": "incident:1234",
    "value": {
      "summary": "Database failover executed"
    }
  }
}
```

### `POST /api/memory/bulk`
Execute multiple operations in a single call.

```json
{
  "operations": [
    { "type": "save", "key": "deployment:latest", "value": { "status": "ok" } },
    { "type": "delete", "key": "incident:old" }
  ]
}
```

### `/status`
- `GET /status` – Returns the entire state document.
- `POST /status` – Updates the state (confirmation required). Example payload:
  ```json
  { "status": "running", "environment": "production" }
  ```

---

## Workers & Automation

### `GET /workers/status`
Lists worker files and the runtime configuration.

```json
{
  "timestamp": "2024-10-30T12:15:00.000Z",
  "workersDirectory": "/app/workers",
  "totalWorkers": 0,
  "availableWorkers": 0,
  "workers": [],
  "arcanosWorkers": {
    "enabled": true,
    "count": 4,
    "model": "gpt-4o",
    "status": "Active"
  },
  "system": {
    "model": "gpt-4o",
    "environment": "development"
  }
}
```

### `POST /workers/run/:workerId`
Confirmation required. Example for `demoWorker.js`:

```bash
curl -X POST http://localhost:8080/workers/run/demoWorker \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"payload":"value"}'
```

**Response**
```json
{
  "success": true,
  "workerId": "demoWorker",
  "result": { "output": "Worker result" },
  "executionTime": "185ms",
  "timestamp": "2024-10-30T12:16:05.000Z"
}
```

### `POST /heartbeat`
Confirmation required. Writes to `logs/heartbeat.log`.

```bash
curl -X POST http://localhost:8080/heartbeat \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "timestamp":"2024-10-30T12:20:00.000Z",
        "mode":"normal",
        "payload":{
          "write_override":false,
          "db_write_enable":true,
          "suppression_level":"low",
          "confirmation":"manual"
        }
      }'
```

---

## Research, RAG, and HRC

### `POST /commands/research`
Requires confirmation.

```json
{
  "topic": "Hallucination resistant prompting",
  "urls": ["https://example.com/article"]
}
```

**Response** includes `summary`, `sources`, and `timestamp` fields from the
research module.

### RAG Endpoints
- `POST /rag/fetch` – Fetch a document by URL.
- `POST /rag/save` – Save raw content.
- `POST /rag/query` – Query stored documents.

All RAG requests return metadata including document IDs, character counts, and
normalized source information.

### `POST /api/ask-hrc`
Hallucination Resistant Core evaluation. Requires confirmation.

```json
{
  "message": "Explain the safeguards used by the API."
}
```

**Response**
```json
{
  "success": true,
  "result": {
    "score": 0.92,
    "explanation": "Detailed safety assessment..."
  }
}
```

---

## Command Execution API

Endpoints under `/api/commands` are documented in
[`docs/api/COMMAND_EXECUTION.md`](COMMAND_EXECUTION.md). Key routes:

- `GET /api/commands/` – List registered commands.
- `GET /api/commands/health` – Lightweight health payload.
- `POST /api/commands/execute` – Execute a command (requires confirmation).

---

## Health & Readiness

| Endpoint | Description |
| --- | --- |
| `GET /` | Plain-text heartbeat (`ARCANOS is live`). |
| `GET /railway/healthcheck` | Railway-compatible health check. |
| `GET /health` | Aggregated service status including OpenAI, database, and caches. |
| `GET /healthz` | Liveness probe. |
| `GET /readyz` | Readiness probe (returns 503 when dependencies are unavailable). |
| `GET /api/test` | JSON smoke test payload used for platform diagnostics. |

---

## Error Handling Patterns

- Validation errors respond with a `status: "error"` payload and descriptive
  `message` / `details` fields.
- Confirmation failures return HTTP 403 with
  `{ "error": "Confirmation required" }`.
- Upstream OpenAI issues surface as HTTP 503 with user-friendly messages while
  logging the original error.
- Worker execution failures include the worker ID and a timestamp for auditing.

---

## Troubleshooting Checklist

1. **401/403 responses** – Ensure `x-confirmed: yes` is present or the caller is
   listed in `TRUSTED_GPT_IDS`.
2. **503 readiness failures** – Verify PostgreSQL (`DATABASE_URL`) and the
   OpenAI API key are configured.
3. **Streaming APIs** – Ensure the client consumes `text/event-stream` responses
   when `stream: true` is used.
4. **Mock mode** – When `OPENAI_API_KEY` is absent, expect deterministic mock
   payloads for AI endpoints.

For further assistance see [`docs/backend.md`](../backend.md) and
[`docs/CONFIGURATION.md`](../CONFIGURATION.md).
