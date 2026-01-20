# Arcanos OpenAI API & Railway Compatibility

> **Last Updated:** 2025-02-14 | **Version:** 1.0.0 | **OpenAI SDK:** v6.16.0

## Overview

This document provides implementation-level details that explain why the current Arcanos
codebase is compatible with Railway deployments and the OpenAI SDK. For step-by-step
Railway deployment instructions, see the Railway deployment guide.

## Prerequisites

- Familiarity with the core backend architecture in `docs/README.md`.
- Access to the repository configuration files (`railway.json`, `Procfile`).
- OpenAI API key (`OPENAI_API_KEY`) for live API usage.

## Setup

Review the following files before making compatibility changes:

1. `railway.json` - build/start commands and Railway defaults.
2. `Procfile` - Railway process fallback entrypoint.
3. `docs/RAILWAY_DEPLOYMENT.md` - deployment workflow and rollback steps.

## Configuration

### OpenAI SDK alignment (Node.js + Python)

Arcanos uses OpenAI Node.js SDK v6.16.0 with the standard `chat.completions.create()` API.
Use these examples when testing or validating SDK changes.

**Node.js (openai v6)**
```js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" }
  ]
});

console.log(response.choices[0].message.content);
```

**Python (openai)**
```python
from openai import OpenAI
import os

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

response = client.chat.completions.create(
    model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)
```

### Centralized completion entry point

All AI requests route through `createCentralizedCompletion()` (see `src/services/openai.ts`), which:
- Selects the model based on `OPENAI_MODEL` / `AI_MODEL` / fine-tuned overrides.
- Injects the Arcanos routing system message.
- Supports model overrides via `options.model`.
- Records telemetry and contextual reinforcement data.

```js
import { createCentralizedCompletion } from "./src/services/openai.js";

const response = await createCentralizedCompletion([
  { role: "user", content: "Hello ARCANOS" }
]);
```

### Railway deployment features

**RESTful API structure (selected endpoints):**
```
/ask            - Core prompt execution
/api/ask        - API-compatible prompt execution
/api/memory     - Memory management with JSON responses
/api/sim        - Simulation scenarios
/health         - Health monitoring
/healthz        - Liveness probe
/readyz         - Readiness probe
```

**Environment configuration:**

Railway automatically provides:
- `PORT` - Service port binding.
- `RAILWAY_ENVIRONMENT` - Environment identifier.
- `DATABASE_URL` - PostgreSQL connection (if attached).

Required configuration:
- `OPENAI_API_KEY` - OpenAI API authentication.

Recommended configuration:
- `OPENAI_MODEL` or `AI_MODEL` - Model selection.
- `RUN_WORKERS` - Worker process control (default: `false` on Railway).

**Build process (railway.json):**
```bash
npm ci --include=dev && npm run build
```

**Start process (railway.json):**
```bash
node --max-old-space-size=7168 dist/start-server.js
```

**Health monitoring:**
- **Path:** `GET /health`
- **Timeout:** 300 seconds
- **Restart policy:** `ON_FAILURE` with max 10 retries

### Security & resilience considerations

Production features in the current codebase include:
- Rate limiting (60 requests per 15 minutes on `/ask`).
- Input validation and sanitization.
- Circuit breaker pattern for API calls.
- Exponential backoff retry logic.
- Graceful degradation (mock responses when OpenAI is unavailable).
- Confirmation gates for mutating operations.

## Run locally

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
npm run build
npm start
```

Validate health:

```bash
curl http://localhost:8080/health
```

## Deploy (Railway)

Follow the Railway deployment guide for the full workflow:

- [`docs/RAILWAY_DEPLOYMENT.md`](docs/RAILWAY_DEPLOYMENT.md)

## Troubleshooting

- Run `npm run validate:railway` to confirm Railway compatibility before deployment.
- If `/health` is degraded, verify `OPENAI_API_KEY` and database connectivity.
- Use `/railway/healthcheck` for a deeper diagnostic snapshot.

## References

**Deployment Guide:**
- [`docs/RAILWAY_DEPLOYMENT.md`](docs/RAILWAY_DEPLOYMENT.md) - Complete deployment instructions

**Configuration:**
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) - Environment variables reference
- [`railway.json`](railway.json) - Railway build/deploy configuration
- [`Procfile`](Procfile) - Process definition

**API Documentation:**
- [`docs/api/README.md`](docs/api/README.md) - API endpoint reference

**External Resources:**
- [Railway Documentation](https://docs.railway.app/)
- [OpenAI Node.js SDK](https://github.com/openai/openai-node)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
