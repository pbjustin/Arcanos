# Arcanos Backend API Reference

Complete API documentation for the Arcanos AI-controlled backend system.

## Base URL
- **Development**: `http://localhost:8080`
- **Production**: `https://your-app.railway.app`

## Authentication & Headers

### Required Headers for Protected Endpoints
```http
Content-Type: application/json
x-confirmed: yes
```

### Optional Headers
```http
X-Container-Id: optional-container-name  # For memory operations
```

## Core AI Endpoints

### GET /health
System health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-09-10T03:55:32.983Z",
  "uptime": 1234567,
  "memory": {
    "heapUsed": 45.2,
    "rss": 78.5
  }
}
```

### GET /
API status and information endpoint.

**Response:**
```json
{
  "message": "ARCANOS is live",
  "version": "1.0.0",
  "status": "operational"
}
```

### POST /ask
Primary AI chat endpoint - no confirmation required.

**Request:**
```json
{
  "prompt": "Your question or request here",
  "tokenLimit": 200
}
```

**Response:**
```json
{
  "result": "AI response content",
  "meta": {
    "id": "req_123456789",
    "created": 1694321123,
    "tokens": {
      "prompt_tokens": 15,
      "completion_tokens": 45,
      "total_tokens": 60
    }
  },
  "activeModel": "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH",
  "fallbackFlag": false
}
```

### POST /brain
Advanced AI processing endpoint - requires confirmation.

**Headers:** `x-confirmed: yes`

**Request:**
```json
{
  "prompt": "Complex reasoning request",
  "tokenLimit": 500
}
```

### POST /arcanos
Main AI interface with intent routing - requires confirmation.

**Headers:** `x-confirmed: yes`

**Request:**
```json
{
  "query": "Your request",
  "context": "Optional context",
  "tokenLimit": 300
}
```

**Response:**
```json
{
  "result": "Response content",
  "componentStatus": "operational",
  "suggestedFixes": "",
  "coreLogicTrace": "trace information",
  "meta": { ... },
  "activeModel": "model-id",
  "fallbackFlag": false,
  "gpt5Used": true
}
```

### POST /arcanos-query
Direct query to Arcanos AI model.

**Request:**
```json
{
  "prompt": "Direct model query",
  "model": "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH"
}
```

## AI Processing Tools

### POST /write
AI writing assistance - requires confirmation.

**Headers:** `x-confirmed: yes`

**Request:**
```json
{
  "prompt": "Writing task description",
  "tokenLimit": 400
}
```

### POST /guide
AI-generated guides - requires confirmation.

**Headers:** `x-confirmed: yes`

### POST /audit
Code audit functionality - requires confirmation.

**Headers:** `x-confirmed: yes`

### POST /sim
Simulation endpoints - requires confirmation.

**Headers:** `x-confirmed: yes`

### POST /image
DALL·E image generation.

**Request:**
```json
{
  "prompt": "Image description",
  "size": "1024x1024",
  "n": 1
}
```

**Response:**
```json
{
  "data": [
    {
      "url": "https://oaidalleapiprodscus.blob.core.windows.net/...",
      "revised_prompt": "Enhanced prompt used for generation"
    }
  ]
}
```

### POST /api/ask-hrc
Hallucination-Resistant Core queries with reliability scoring.

**Request:**
```json
{
  "prompt": "Query for HRC analysis",
  "tokenLimit": 300
}
```

**Response:**
```json
{
  "result": "HRC processed response",
  "hrcScore": {
    "reliability": 0.95,
    "confidence": 0.88,
    "coherence": 0.92
  },
  "meta": { ... }
}
```

## Memory Management

### GET /memory/health
Memory system status check.

**Response:**
```json
{
  "status": "healthy",
  "memoryType": "postgresql",
  "connectionStatus": "connected",
  "entryCount": 42
}
```

### POST /memory/save
Store memory entries - requires confirmation.

**Headers:** `x-confirmed: yes`

**Request:**
```json
{
  "key": "user_preference",
  "value": {
    "theme": "dark",
    "language": "en"
  },
  "includeMeta": true
}
```

**Response:**
```json
{
  "success": true,
  "key": "user_preference",
  "timestamp": "2024-09-10T03:55:32.983Z"
}
```

### GET /memory/load
Retrieve memory value by key.

**Query Parameters:**
- `key`: Memory key to retrieve
- `includeMeta`: Include metadata (true/false)

**Response:**
```json
{
  "value": {
    "theme": "dark",
    "language": "en"
  },
  "key": "user_preference",
  "timestamp": "2024-09-10T03:55:32.983Z"
}
```

### DELETE /memory/delete
Remove memory entries - requires confirmation.

**Headers:** `x-confirmed: yes`

### GET /memory/list
List all memory keys and values.

**Query Parameters:**
- `includeMeta`: Include metadata (true/false)

### GET /memory/view
View memory system overview.

### Dual-Mode Conversation Storage

### POST /memory/dual/save
Store conversation + metadata.

**Request:**
```json
{
  "sessionId": "session_123",
  "message": {
    "role": "user",
    "content": "Hello there"
  }
}
```

### GET /memory/dual/:sessionId
Retrieve conversation messages for session.

### GET /memory/dual/:sessionId/meta
Retrieve session metadata.

### POST /memory/resolve
Session memory resolution.

## System Control & Monitoring

### GET /status
Backend state information.

**Response:**
```json
{
  "status": "running",
  "version": "1.0.0",
  "startTime": "2024-09-10T03:55:32.983Z",
  "port": 8080,
  "environment": "development",
  "workers": {
    "running": 4,
    "scheduled": 3
  }
}
```

### POST /status
Update system status - requires confirmation.

**Headers:** `x-confirmed: yes`

### POST /heartbeat
System heartbeat - requires confirmation.

**Headers:** `x-confirmed: yes`

**Request:**
```json
{
  "timestamp": "2024-09-10T03:55:32.983Z",
  "source": "client"
}
```

### GET /workers/status
Worker system status and health.

**Response:**
```json
{
  "status": "operational",
  "workers": {
    "total": 4,
    "active": 3,
    "idle": 1,
    "failed": 0
  },
  "nextScheduled": "2024-09-10T04:00:00.000Z"
}
```

### POST /workers/run/*
Execute specific workers - requires confirmation.

**Headers:** `x-confirmed: yes`

## RAG & Research

### POST /rag/fetch
Fetch content for RAG processing.

**Request:**
```json
{
  "url": "https://example.com/content",
  "maxLength": 5000
}
```

### POST /rag/query
Query against fetched content.

**Request:**
```json
{
  "query": "What is the main topic?",
  "context": "previously fetched content"
}
```

## Orchestration & Admin

### GET /orchestration/status
GPT-5 orchestration shell status.

**Response:**
```json
{
  "status": "active",
  "gpt5Available": true,
  "queueLength": 2,
  "processingRate": "15 req/min"
}
```

### POST /orchestration/reset
Reset orchestration state - requires confirmation.

**Headers:** `x-confirmed: yes`

### POST /orchestration/purge
Purge orchestration data - requires confirmation.

**Headers:** `x-confirmed: yes`

## Development & Testing

### GET /api/test
Basic health test endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-09-10T03:55:32.983Z",
  "service": "ARCANOS",
  "version": "1.0.0"
}
```

### GET /api/fallback/test
Fallback system test endpoint.

### POST /siri
Siri integration endpoint - requires confirmation.

**Headers:** `x-confirmed: yes`

### POST /modules/<module>
Module dispatcher for specialized functionality.

**Available Modules:**
- `tutor` - Educational assistance
- `gaming` - Game-related processing
- `research` - Research assistance

**Request:**
```json
{
  "action": "process",
  "input": "module-specific input",
  "config": {}
}
```

### POST /queryroute
Dynamic module routing.

**Request:**
```json
{
  "module": "tutor",
  "action": "explain",
  "query": "Explain quantum computing"
}
```

## Error Responses

### Standard Error Format
```json
{
  "error": "Error type",
  "message": "Detailed error message",
  "code": 400,
  "timestamp": "2024-09-10T03:55:32.983Z"
}
```

### Common HTTP Status Codes
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized (missing confirmation header)
- `404` - Endpoint not found
- `429` - Rate limit exceeded
- `500` - Internal server error
- `503` - Service unavailable (AI service down)

## Rate Limiting

Default rate limits apply to all endpoints:
- **AI Endpoints**: 100 requests per minute per IP
- **Memory Operations**: 200 requests per minute per IP
- **System Endpoints**: 50 requests per minute per IP

## SDK Integration

### JavaScript/TypeScript
```typescript
// Example using fetch
const response = await fetch('http://localhost:8080/ask', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    prompt: 'Hello, AI!',
    tokenLimit: 100
  })
});

const result = await response.json();
console.log(result.result);
```

### cURL Examples
```bash
# Simple AI query
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain quantum computing", "tokenLimit": 200}'

# Memory storage (requires confirmation)
curl -X POST http://localhost:8080/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"key": "test", "value": "data"}'

# Health check
curl http://localhost:8080/health
```

---

For more information, see the main [README.md](../../README.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md).