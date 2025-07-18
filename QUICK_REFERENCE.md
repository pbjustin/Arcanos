# Arcanos Quick Reference

## New Project Structure

```
/src/
  index.ts         # Main Express server
  routes/
    index.ts       # API routes
package.json       # Dependencies and scripts  
tsconfig.json      # TypeScript configuration
.env.example       # Environment template
dist/              # Compiled output (generated)
```

## API Endpoints

### Currently Available
- `GET /health` - System health check
- `GET /api` - Welcome message  
- `POST /api/echo` - Echo test endpoint

### To Be Implemented
- `POST /api/ask` - Main AI query endpoint with RAG
- `GET /api/status` - System status and health
- `GET /api/config` - Current configuration
- `GET /api/memory` - Retrieve stored memories
- `POST /api/memory` - Store new memory
- `GET /api/permission/status` - Check permission status
- `POST /api/permission/grant` - Grant fallback permission
- `POST /api/permission/revoke` - Revoke permission

## Environment Variables

```bash
# Required
OPENAI_API_KEY=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
FINE_TUNED_MODEL=your-fine-tuned-model-id-here

# Server Configuration
PORT=3000
NODE_ENV=production
```

## Model Hierarchy

1. **Primary**: Fine-tuned model (configured via `FINE_TUNED_MODEL` environment variable)
2. **Fallback**: GPT-4 Turbo (with permission)
3. **Error**: No fallback without permission

## Quick Start Commands

```bash
# Development
npm install
npm run dev      # Starts development server with hot reloading

# Production
npm run build    # Compile TypeScript to JavaScript
npm start        # Start production server

# Health Check
curl http://localhost:3000/health
curl https://your-server.com/health
```

## Sample API Calls

### Health Check
```bash
curl http://localhost:3000/health
```

### Welcome Message
```bash
curl http://localhost:3000/api
```

### Echo Test
```bash
curl -X POST http://localhost:3000/api/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Arcanos", "test": true}'
```

### Future Endpoints (To Be Implemented)

#### Ask Question
```bash
curl -X POST https://your-server.com/api/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "Hello Arcanos", "options": {"useRAG": true}}'
```

#### Store Memory
```bash
curl -X POST https://your-server.com/api/memory \
  -H "Content-Type: application/json" \
  -d '{"content": "Important information", "priority": "high"}'
```

#### Check Status
```bash
curl https://your-server.com/api/status
```

## Custom GPT Actions Schema

Use this OpenAPI schema in your Custom GPT for the current available endpoints:

```yaml
openapi: 3.0.0
info:
  title: Arcanos API
  version: 1.0.0
servers:
  - url: https://your-server.com
paths:
  /health:
    get:
      operationId: getHealth
      summary: Check system health
      responses:
        '200':
          description: Health status
  /api:
    get:
      operationId: getWelcome
      summary: Get welcome message
      responses:
        '200':
          description: Welcome response
  /api/echo:
    post:
      operationId: echoTest
      summary: Echo test endpoint
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
      responses:
        '200':
          description: Echo response
```

### Future Schema (To Be Implemented)

```yaml
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