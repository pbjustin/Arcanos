# Arcanos OpenAI API & Railway Compatibility

> **Last Updated:** 2026-01-14 | **Version:** 1.0.0 | **OpenAI SDK:** v6.16.0

## Overview

This document provides technical implementation details for Arcanos Railway compatibility.
For deployment instructions, see the [Railway Deployment Guide](docs/RAILWAY_DEPLOYMENT.md).

## OpenAI SDK Integration

### Current Implementation

Arcanos uses OpenAI Node.js SDK v6.16.0 with the standard `chat.completions.create()` API:

```javascript
const response = await client.chat.completions.create({
  model: "gpt-4o",  // or configured fine-tuned model
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" }
  ]
});

const content = response.choices[0].message.content;
```

### Centralized Completion Function

All AI requests route through `createCentralizedCompletion()` which:
- Uses fine-tuned model by default (configurable via `OPENAI_MODEL` or `AI_MODEL`)
- Adds ARCANOS routing system message for proper handling
- Supports model override via `options.model`
- Records conversation context in lightweight runtime

```javascript
import { createCentralizedCompletion } from './services/openai.js';

const response = await createCentralizedCompletion([
  { role: 'user', content: 'Hello ARCANOS' }
]);
```

## Railway Deployment Features

### 1. RESTful API Structure
```
/api/arcanos     - Core ARCANOS functionality
/api/memory      - Memory management with JSON responses
/api/sim         - Simulation scenarios
/health          - Health monitoring
/healthz         - Liveness probe
/readyz          - Readiness probe
```

### 2. Environment Configuration

Railway automatically provides:
- `PORT` - Service port binding
- `RAILWAY_ENVIRONMENT` - Environment identifier
- `DATABASE_URL` - PostgreSQL connection (if attached)

Required configuration:
- `OPENAI_API_KEY` - OpenAI API authentication

Recommended configuration:
- `OPENAI_MODEL` or `AI_MODEL` - Model selection
- `RUN_WORKERS` - Worker process control (default: `false` on Railway)

### 3. Build Process

Railway build (via `railway.json`):
```bash
npm ci --include=dev && npm run build
```

This:
1. Installs all dependencies (including dev dependencies for TypeScript)
2. Builds workers (`npm run build:workers`)
3. Compiles TypeScript (`tsc`)
4. Produces `dist/` directory with compiled JavaScript

### 4. Start Process

Railway start command:
```bash
node --max-old-space-size=7168 dist/start-server.js
```

Memory configuration:
- `7168MB` max old space for Railway production environment
- Optimized for Railway's memory allocation

### 5. Health Monitoring

Railway health check configuration:
- **Path:** `GET /health`
- **Timeout:** 300 seconds
- **Restart policy:** `ON_FAILURE` with max 10 retries

Health response includes:
- OpenAI client status
- Database connectivity
- Uptime and timestamp
- Service readiness

### 6. Security & Resilience

Production features:
- Rate limiting (50-100 requests per 15 minutes per endpoint)
- Input validation and sanitization
- Circuit breaker pattern for API calls
- Exponential backoff retry logic
- Graceful degradation (mock responses when API unavailable)
- Confirmation gates for mutating operations

## Compatibility Validation

Run validation before deploying:
```bash
npm run validate:railway
```

This checks:
- Railway configuration validity
- Environment variable setup
- Build process compatibility
- Start command correctness
- Health check endpoints

## References

**Deployment Guide:**
- [docs/RAILWAY_DEPLOYMENT.md](docs/RAILWAY_DEPLOYMENT.md) - Complete deployment instructions

**Configuration:**
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) - Environment variables reference
- [railway.json](railway.json) - Railway build/deploy configuration
- [Procfile](Procfile) - Process definition

**API Documentation:**
- [docs/api/README.md](docs/api/README.md) - API endpoint reference

**External Resources:**
- [Railway Documentation](https://docs.railway.app/)
- [OpenAI Node.js SDK](https://github.com/openai/openai-node)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
