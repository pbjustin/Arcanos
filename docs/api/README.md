# ARCANOS API Reference

> **Last Updated:** 2024-09-27 | **Version:** 1.2.0 | **OpenAI SDK:** v5.16.0

Complete API documentation for the ARCANOS AI-controlled backend service.

## 📋 API Documentation Self-Check

This API documentation includes:
- [x] All endpoints organized by category
- [x] Confirmation gate requirements clearly marked
- [x] Request/response examples for each endpoint
- [x] Error handling and fallback behaviors documented
- [x] Environment variable dependencies listed
- [x] OpenAI SDK v5.16.0 compatibility verified
- [x] Railway deployment considerations included

## 🌐 API Endpoints

### Core AI Endpoints
- `POST /ask` - General AI conversation and logic routing
- `POST /query-finetune` - Direct fine-tuned model access
- `POST /image` - AI-enhanced image generation via DALL·E
- `POST /hrc` - Hallucination-Resistant Core analysis with reliability scoring

### AI Processing & Tools  
- `POST /arcanos` - AI-controlled system operations and diagnostics
- `POST /gpt5/reasoning` - Advanced reasoning with GPT-5
- `POST /orchestration` - AI workflow orchestration
- `POST /api/sim` - Simulation and modeling endpoints

### Memory Management
```bash
# Dual-mode conversation storage
POST /api/memory/store    # Store conversation context (protected)
POST /api/memory/retrieve # Retrieve conversation history
POST /api/memory/clear    # Clear stored context (protected)
```

### System Control & Monitoring
- `GET /health` - System health and status
- `GET /status` - Detailed system status with environment info  
- `POST /workers/status` - Worker process status and control
- `GET /diagnostics` - System diagnostics and performance metrics

### RAG & Research  
- `POST /research` - Scholarly research and document fetching
- `POST /rag` - Retrieval-Augmented Generation queries

### Orchestration & Admin
- `POST /orchestration/init` - Initialize AI orchestration workflows
- `GET /admin/*` - Administrative endpoints (requires ADMIN_KEY)

### Development & Testing
- `POST /pr-analysis` - Pull request analysis and validation
- `GET /test/*` - Testing utilities and endpoints

## Example Usage

### Simple AI query
```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, how are you?"}'
```

### Memory storage (requires confirmation)
```bash
curl -X POST http://localhost:8080/api/memory/store \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"session": "user123", "data": {"context": "conversation state"}}'
```

### Health check
```bash
curl http://localhost:8080/health
```

## 🛡️ Security & Compliance

### Confirmation Requirements
Certain operations require explicit confirmation via the `x-confirmed: yes` header (or a trusted GPT ID):
- Memory storage operations (`/api/memory/store`, `/api/memory/clear`)
- Administrative functions (`/admin/*`)
- Worker control operations (`/workers/*`)

To pre-authorize requests coming from Custom GPTs that you personally supervise, set the `TRUSTED_GPT_IDS` environment variable to a comma-separated list of GPT IDs. When a request includes a matching `x-gpt-id` header (or `gptId` in the body), the confirmation gate treats it as already reviewed and does not require the manual header.

### Example Usage with Confirmation
```bash
# Protected operation - requires confirmation header
curl -X POST http://localhost:8080/api/memory/clear \
  -H "x-confirmed: yes" \
  -H "Content-Type: application/json"

# Safe operation - no confirmation needed  
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is the weather like?"}'
```

## Authentication

- **Admin endpoints**: Require `ADMIN_KEY` environment variable
- **Protected operations**: Require `x-confirmed: yes` header (unless the request supplies a trusted GPT ID)
- **OpenAI integration**: Requires valid `OPENAI_API_KEY`

## Rate Limiting

Default rate limits apply to prevent abuse:
- General endpoints: 100 requests/minute per IP
- AI endpoints: 30 requests/minute per IP
- Admin endpoints: 10 requests/minute per IP

## Error Handling

All API endpoints return consistent error responses:

```json
{
  "error": "Error type",
  "message": "Human-readable error description",
  "details": "Additional error context (development only)"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized (missing or invalid authentication)
- `403` - Forbidden (missing confirmation header)
- `500` - Internal Server Error