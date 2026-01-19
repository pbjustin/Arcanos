# Arcanos Backend

> **Last Updated:** 2026-01-14 | **Version:** 1.0.0 | **OpenAI SDK:** v6.16.0

## Overview

Arcanos is a TypeScript/Express backend that centralizes OpenAI access, provides AI-focused
HTTP APIs, and persists state to disk or PostgreSQL. The server boots from
`src/start-server.ts`, registers routes in `src/routes/register.ts`, and initializes the
OpenAI client via `src/services/openai.ts` and `src/services/openai/*`.

## Upcoming (WIP)

- Demon: Work in progress and an upcoming feature.

## Prerequisites

- Node.js 18+ and npm 8+ (see `package.json` engines).
- An OpenAI API key for live responses (`OPENAI_API_KEY`).
- Optional: PostgreSQL for persistence (`DATABASE_URL` or `PG*` variables).

## Setup

```bash
npm install
cp .env.example .env
```

Populate at least `OPENAI_API_KEY` in `.env` before running locally.

## Configuration

Key environment variables (see `docs/CONFIGURATION.md` for the complete matrix):

- `OPENAI_API_KEY` – required for live OpenAI calls (missing keys return mock responses).
- `OPENAI_MODEL`, `RAILWAY_OPENAI_MODEL`, `FINETUNED_MODEL_ID`, `FINE_TUNED_MODEL_ID`, `AI_MODEL`
  – model selection chain used by the OpenAI client (default: `gpt-4o`).
- `FALLBACK_MODEL`, `AI_FALLBACK_MODEL`, `RAILWAY_OPENAI_FALLBACK_MODEL` – fallback model
  chain used when the primary model fails (default: `gpt-4`).
- `GPT51_MODEL` / `GPT5_MODEL` – GPT-5.1 reasoning model override (defaults to `gpt-5.1`).
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
npm run dev        # Build workers + TypeScript, then start the compiled server
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
- `RUN_WORKERS` defaults to `false` in Railway deploy config.

High-level steps:

1. Create a Railway project and connect the GitHub repository.
2. Add required environment variables (`OPENAI_API_KEY`, optional model overrides).
3. (Optional) Provision PostgreSQL and confirm `DATABASE_URL` is injected.
4. Deploy and confirm the `/health` check passes.
5. Roll back from the Railway **Deployments** view if needed.

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

const response = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  messages: [
    { role: "user", content: "Summarize the Arcanos health status." }
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
        {"role": "user", "content": "Summarize the Arcanos health status."}
    ]
)

print(response.choices[0].message.content)
```
