# Backend Implementation

This directory contains backend implementations for ARCANOS.

## Implementations
### ARCANOS Backend v4.0 (arcanos-v4.js)
**Generalized router with improved cache and health checks:**

- **Generalized router** accepts module aliases and GPT-IDs
- **Hybrid identityMap** (DB + chokidar auto-discovery)
- **Checksum-validated cache** with auto-invalidation
- **Health endpoint** and graceful shutdown
- **Seamless fallback** with GPT-ID-aware audit logs
- **Input validation & sanitization**
- **Security**: rate limiting + API key auth

**Quick Start:**
```bash
npm run v4:start    # Start v4.0 backend
```

**API Endpoints:**
- `GET /health` - Basic health information
- `GET /gpt-routing-meta` - List registered modules
- `POST /query` - Route queries to module or GPT-ID
- `POST /register-module` - Register new modules (requires API key)


### ARCANOS Backend v3.0 (arcanos-v3.js)
**Production-ready unified backend with advanced features:**

- **Master router** for Tutor, Gaming, Booker (scalable for new modules)
- **Hybrid identityMap** (DB + chokidar auto-discovery)
- **Fallback routing** to fine-tuned ARCANOS default
- **Input validation** + sanitization
- **Error handling** + rollback isolation
- **In-memory cache** for performance
- **Postgres pool monitoring**
- **Extended audit logging** (latency, tokens, fallbacks)
- **Security**: rate limiting + API key auth
- **Preloaded modules**: Tutor, Gaming, Booker on startup
- **Railway-ready** deployment

**Quick Start:**
```bash
npm run v3:start    # Start v3.0 backend
npm run v3:test     # Run v3.0 tests
```

**API Endpoints:**
- `GET /health` - System health and status
- `GET /get-identity-map` - List all registered modules
- `POST /query` - Route queries to appropriate ARCANOS persona
- `POST /register-module` - Register new modules (requires API key)

### Original Backend (index.js)
**Simple fine-tuned model integration:**

- **Fine-tuned Model**: Uses `ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote`
- **Express Server**: Simple HTTP server with JSON middleware
- **OpenAI Integration**: Direct integration with OpenAI Chat Completions API
- **Environment Support**: Reads OPENAI_API_KEY from environment variables
- **Chat Log Persistence**: Stores chat conversations in PostgreSQL (Railway-compatible)

#### Assistant API Integration

The original backend now includes a minimal route for calling an OpenAI Assistant.

- **Endpoint**: `POST /assistant/run`
- **Body**:
  ```json
  { "prompt": "Hello", "assistantId": "asst_123" }
  ```
  If `assistantId` is omitted, the server uses the `OPENAI_ASSISTANT_ID` environment variable.
- **Response**:
  ```json
  { "reply": "...", "threadId": "...", "runId": "..." }
  ```

This provides a starting point for integrating the Assistants API into your backend logic.

## Features Comparison

| Feature | v4.0 | v3.0 | Original |
|---------|------|------|----------|
| Module System | ✅ | ✅ | ❌ |
| Database Support | ✅ (PostgreSQL/SQLite) | ✅ (PostgreSQL/SQLite) | ✅ (PostgreSQL) |
| Rate Limiting | ✅ | ✅ | ❌ |
| Audit Logging | ✅ | ✅ | ❌ |
| File Watching | ✅ | ✅ | ❌ |
| Input Validation | ✅ | ✅ | ❌ |
| Health Monitoring | ✅ | ✅ | ✅ |
| Security | ✅ (API Keys) | ✅ (API Keys) | ❌ |
| Fallback Routing | ✅ | ✅ | ✅ |


## Environment Variables

### For v3.0:
```bash
# Database (production)
DATABASE_URL=postgresql://user:pass@host:port/db

# OpenAI Configuration
OPENAI_API_KEY=your-api-key
ARCANOS_FINE_TUNE_ID=your-fine-tuned-model-id

# Security
REGISTER_KEY=your-api-key-for-module-registration

# Server
PORT=3000
NODE_ENV=production
```

### For Original:
```bash
OPENAI_API_KEY=your-api-key-here
PORT=5000
```

## Usage

### ARCANOS Backend v3.0

**Prerequisites:**
1. Set environment variables (see above)
2. For production: Configure PostgreSQL database
3. For development: SQLite auto-initializes

**Running:**
```bash
# From project root
npm run v3:start

# Or directly
cd backend && node arcanos-v3.js
```

**Testing:**
```bash
npm run v3:test
```

**API Examples:**
```bash
# Health check
curl http://localhost:3000/health

# Query with tutor module
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"module": "tutor", "data": "How do I learn JavaScript?"}'

# Query unknown module (fallback)
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"module": "unknown", "data": "Test fallback"}'
```

### Original Backend

**Prerequisites:**

1. Set your OpenAI API key:
   ```bash
   export OPENAI_API_KEY="your-api-key-here"
   ```

2. Ensure you have access to the fine-tuned model `ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote`

**Running:**
```bash
cd backend
node index.js
```
The server will start on port 5000 (or the PORT environment variable).

**API Example:**
```bash
curl -X POST http://localhost:5000/arcanos \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Analyze this logic problem: If all cats are animals, and some animals are pets, what can we conclude about cats?"}'
```

**Chat Log Endpoints:**
```bash
# Store a message
curl -X POST http://localhost:5000/chat/log \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"<uuid>","sender_id":"<uuid>","message_text":"Hello"}'

# Retrieve conversation history
curl http://localhost:5000/chat/log/<conversation_id>
```

**Response Format:**
```json
{
  "reply": "Based on the given premises, we can conclude that all cats are animals (given directly). However, we cannot definitively conclude that cats are pets, as the second premise only states that some animals are pets, not all animals."
}
```

## Database Schema (v3.0)

### identity_map
- `module` (TEXT PRIMARY KEY): Module name
- `identity` (TEXT): ARCANOS persona identifier
- `behavior` (TEXT): Module behavior type
- `description` (TEXT): Module description

### audit_log
- `id` (INTEGER PRIMARY KEY): Auto-increment ID
- `action` (TEXT): Action type (QUERY, REGISTER, etc.)
- `details` (TEXT): JSON details
- `timestamp` (TEXT): ISO timestamp

## Error Handling

Both implementations include error handling for:
- Missing OpenAI API key
- Invalid model access
- Malformed requests
- OpenAI API errors

Errors are returned in the format:
```json
{
  "error": "Error message here"
}
```

## Deployment

### v3.0 Railway Deployment
- Automatic PostgreSQL detection
- Environment-based configuration
- Health check endpoint for monitoring
- Connection pooling and monitoring

### Original Deployment
- Simple standalone deployment
- Direct OpenAI integration
- Environment variable configuration