# ARCANOS API Reference

Complete API documentation for the ARCANOS backend service.

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
  -H "X-Confirm-Action: yes" \
  -d '{"session": "user123", "data": {"context": "conversation state"}}'
```

### Health check
```bash
curl http://localhost:8080/health
```

## 🛡️ Security & Compliance

### Confirmation Requirements
Certain operations require explicit confirmation via the `X-Confirm-Action: yes` header:
- Memory storage operations (`/api/memory/store`, `/api/memory/clear`)
- Administrative functions (`/admin/*`)
- Worker control operations (`/workers/*`)

### Example Usage with Confirmation
```bash
# Protected operation - requires confirmation header
curl -X POST http://localhost:8080/api/memory/clear \
  -H "X-Confirm-Action: yes" \
  -H "Content-Type: application/json"

# Safe operation - no confirmation needed  
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is the weather like?"}'
```

## Authentication

- **Admin endpoints**: Require `ADMIN_KEY` environment variable
- **Protected operations**: Require `X-Confirm-Action: yes` header
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