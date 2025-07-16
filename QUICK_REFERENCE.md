# Arcanos Quick Reference

## API Endpoints

### Core Functionality
- `POST /api/ask` - Main AI query endpoint with RAG
- `GET /api/status` - System status and health
- `GET /api/config` - Current configuration

### Memory Management
- `GET /api/memory` - Retrieve stored memories
- `POST /api/memory` - Store new memory

### Permission Management
- `GET /api/permission/status` - Check permission status
- `POST /api/permission/grant` - Grant fallback permission
- `POST /api/permission/revoke` - Revoke permission

## Environment Variables

```bash
# Required
OPENAI_API_KEY=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
OPENAI_FINE_TUNE_MODEL=ft:gpt-3.5-turbo-0125:personal:arc_v1-1106:BpYtP0ox

# Model Selection
USE_FINE_TUNED=true  # Use fine-tuned model
USE_FINE_TUNED=false # Use base gpt-3.5-turbo
```

## Model Hierarchy

1. **Primary**: Fine-tuned model (`ft:gpt-3.5-turbo-0125:personal:arc_v1-1106:BpYtP0ox`)
2. **Fallback**: GPT-4 Turbo (with permission)
3. **Error**: No fallback without permission

## Quick Start Commands

```bash
# Development
npm install
npm run dev

# Production
npm run build
npm start

# Health Check
curl https://your-server.com/health
```

## Sample API Calls

### Ask Question
```bash
curl -X POST https://your-server.com/api/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "Hello Arcanos", "options": {"useRAG": true}}'
```

### Store Memory
```bash
curl -X POST https://your-server.com/api/memory \
  -H "Content-Type: application/json" \
  -d '{"content": "Important information", "priority": "high"}'
```

### Check Status
```bash
curl https://your-server.com/api/status
```

## Custom GPT Actions Schema

Use this OpenAPI schema in your Custom GPT:

```yaml
openapi: 3.0.0
info:
  title: Arcanos API
  version: 1.0.0
servers:
  - url: https://your-server.com
paths:
  /api/ask:
    post:
      operationId: askArcanos
      summary: Query Arcanos AI
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                query:
                  type: string
                options:
                  type: object
                  properties:
                    useRAG:
                      type: boolean
                      default: true
              required: [query]
```

See [CUSTOM_GPT_INTEGRATION.md](./CUSTOM_GPT_INTEGRATION.md) for complete integration guide.