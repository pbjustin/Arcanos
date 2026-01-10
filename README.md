# Arcanos Backend

> **Last Updated:** 2026-01-10 | **Version:** 1.0.0 | **OpenAI SDK:** v6.16.0

## Overview

Arcanos is a TypeScript/Express backend that centralizes OpenAI access, provides AI-oriented
HTTP APIs, and persists state to disk or PostgreSQL. The runtime boots from
`src/start-server.ts`, registers routes in `src/routes/register.ts`, and uses a shared OpenAI
client from `src/services/openai.ts` for chat, reasoning, and image generation.

## Prerequisites

- Node.js 18+ and npm 8+ (see `package.json` engines).
- An OpenAI API key for live responses (`OPENAI_API_KEY`).
- Optional: PostgreSQL for persistent memory (`DATABASE_URL` or `PG*` variables).

## Setup

```bash
npm install
cp .env.example .env
```

Populate at least `OPENAI_API_KEY` in `.env` before running locally.

## Configuration

Key environment variables (see `docs/CONFIGURATION.md` for the full matrix):

- `OPENAI_API_KEY` – required for live OpenAI calls (missing keys return mock responses).
- `OPENAI_MODEL`, `FINETUNED_MODEL_ID`, `FINE_TUNED_MODEL_ID`, `AI_MODEL` – model selection
  chain used by the OpenAI client.
- `GPT51_MODEL` / `GPT5_MODEL` – GPT-5.2 reasoning model override (defaults to `gpt-5.2`).
- `DATABASE_URL` or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` – database connection.
- `RUN_WORKERS`, `WORKER_COUNT`, `WORKER_MODEL`, `WORKER_API_TIMEOUT_MS` – background workers.
- `ARC_LOG_PATH`, `ARC_MEMORY_PATH`, `LOG_LEVEL` – filesystem paths and logging.

## Run locally

```bash
npm run build
npm start
```

Common scripts:

```bash
npm run dev        # Compile TypeScript and start the compiled server (no watch mode)
npm run dev:watch  # Rebuild TypeScript incrementally; run "npm start" in another shell
npm test           # Run Jest test suites
npm run lint       # Lint TypeScript sources
```

Health checks:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

## Deploy (Railway)

Railway deployment is configured via `railway.json` and `Procfile`:

- Build: `npm ci --include=dev && npm run build`
- Start: `node --max-old-space-size=7168 dist/start-server.js`
- Health check: `GET /health`
- `RUN_WORKERS` is set to `false` by default in Railway deploy config.

High-level steps:

1. Create a Railway project and connect the GitHub repository.
2. Add required environment variables (`OPENAI_API_KEY`, optional model overrides).
3. (Optional) Provision PostgreSQL and set `DATABASE_URL` if not auto-injected.
4. Deploy and confirm health checks pass.

See `docs/RAILWAY_DEPLOYMENT.md` for a detailed, step-by-step guide.

## Troubleshooting

- **Mock responses**: ensure `OPENAI_API_KEY` is set and not the `.env.example` placeholder.
- **Database fallback**: without `DATABASE_URL`, the service uses in-memory storage and
  `/health` reports degraded database status.
- **Worker boot disabled**: set `RUN_WORKERS=true` (or leave `false` on Railway).
- **Confirmation gate**: send `x-confirmed: yes` for manual runs or configure
  `TRUSTED_GPT_IDS` / `ARCANOS_AUTOMATION_SECRET` for automation.

## References

- Configuration matrix: `docs/CONFIGURATION.md`
- Railway deployment: `docs/RAILWAY_DEPLOYMENT.md`
- API overview: `docs/api/README.md`

OpenAI SDK usage examples (current, idiomatic):

**Node.js (openai v6)**
```js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await client.responses.create({
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  input: "Summarize the Arcanos health status."
});

console.log(response.output_text);
```

**Python (openai)**
```python
from openai import OpenAI
import os

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

response = client.responses.create(
    model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
    input="Summarize the Arcanos health status."
)

print(response.output_text)
```
