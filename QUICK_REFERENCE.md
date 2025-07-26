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

### Available Endpoints

#### Core Endpoints
- `GET /health` - System health check
- `GET /` - API status message
- `POST /` - Main chat with intent routing
- `POST /ask` - Simple query processing
- `POST /webhook` - GitHub webhook integration

#### AI Chat Endpoints
- `GET /api` - Welcome message with model status
- `POST /api/echo` - Echo test endpoint
- `POST /api/ask` - Fine-tuned model chat (no fallback)
- `POST /api/ask-with-fallback` - AI query with fallback permission granted
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT)
- `POST /api/code-interpreter` - Python tool execution via code interpreter
- `GET /api/model-status` - Current model configuration
- `GET /api/model/info` - Detailed model information

#### Validation & Processing
- `POST /api/ask-hrc` - Message validation using HRCCore overlay system

#### Memory & Storage
- `POST /api/memory` - Store memory entry
- `GET /api/memory` - Retrieve all memory entries

#### Canon Management
- `GET /api/canon/files` - List canon files
- `GET /api/canon/files/:filename` - Read canon file
- `POST /api/canon/files/:filename` - Write canon file

#### Container Management
- `GET /api/containers/status` - Container status
- `POST /api/containers/:name/:action` - Container control

#### Diagnostics & Monitoring
- `POST /api/diagnostics` - Natural language diagnostics
- `GET /system/diagnostics` - System diagnostics information
- `GET /system/workers` - Worker status information
- `GET /sync/diagnostics` - System metrics

## Environment Variables

```bash
# Required
OPENAI_API_KEY=your-openai-api-key-here
FINE_TUNED_MODEL=your-fine-tuned-model-id-here

# Server Configuration
PORT=8080
NODE_ENV=development

# Optional
RUN_WORKERS=true
SERVER_URL=https://your-app.railway.app
GPT_TOKEN=your-gpt-diagnostic-token
CODE_INTERPRETER_MODEL=gpt-4o
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
curl http://localhost:8080/health
curl https://your-server.com/health
```

## Sample API Calls

### Health Check
```bash
curl http://localhost:8080/health
```

### Welcome Message
```bash
curl http://localhost:8080/api
```

### Echo Test
```bash
curl -X POST http://localhost:8080/api/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Arcanos", "test": true}'
```

## Further Documentation

For comprehensive API usage, examples, and integration guides, see:

- **[PROMPT_API_GUIDE.md](./PROMPT_API_GUIDE.md)** - Complete API usage guide
- **[PROMPT_API_EXAMPLES.md](./PROMPT_API_EXAMPLES.md)** - Practical examples
- **[SETUP_GUIDE.md](./SETUP_GUIDE.md)** - Quick setup instructions
- **[CUSTOM_GPT_INTEGRATION.md](./CUSTOM_GPT_INTEGRATION.md)** - Custom GPT integration