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
- `GET /health` - System health check
- `GET /api` - Welcome message with model status
- `POST /api/echo` - Echo test endpoint
- `POST /api/ask` - Main AI query endpoint (requires permission for fallback)
- `POST /api/ask-with-fallback` - AI query with fallback permission granted
- `GET /api/model-status` - Current model configuration
- `GET /api/model/info` - Detailed model information
- `POST /api/ask-hrc` - Message validation using HRCCore
- `POST /api/memory` - Store memory entry
- `GET /api/memory` - Retrieve all memory entries
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT)
- `POST /api/diagnostics` - System diagnostics
- `GET /api/workers/status` - Worker status information
- `GET /api/config/sleep` - Sleep configuration

## Environment Variables

```bash
# Required
OPENAI_API_KEY=your-openai-api-key-here
OPENAI_FINE_TUNED_MODEL=your-fine-tuned-model-id-here

# Server Configuration
PORT=8080
NODE_ENV=production
```

## Model Hierarchy

1. **Primary**: Fine-tuned model (configured via `OPENAI_FINE_TUNED_MODEL` environment variable)
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