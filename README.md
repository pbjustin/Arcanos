# Arcanos Backend

## Overview

Arcanos is a TypeScript/Express backend that centralizes OpenAI access, exposes AI-focused
HTTP APIs, and persists state to disk or PostgreSQL. The server boots from
`src/start-server.ts`, registers routes in `src/routes/register.ts`, and initializes the
OpenAI client via `src/services/openai.ts` and `src/services/openai/*`.

This repository also includes a Python daemon client (`daemon-python/`) that provides a
local cross-platform terminal interface. The daemon can run standalone or connect to this
backend for cloud sync and shared services. See `QUICKSTART.md` for daemon setup.

## Prerequisites

- Node.js 18+ and npm 8+ (`package.json` engines).
- OpenAI API key for live responses (`OPENAI_API_KEY`).
- Optional: PostgreSQL for persistence (`DATABASE_URL` or `PG*` variables).
- Optional: Railway account if deploying to Railway.

## Setup

```bash
npm install
cp .env.example .env
```

Populate at least `OPENAI_API_KEY` in `.env` before running locally.

## Configuration

Key environment variables (see `docs/CONFIGURATION.md` for the full matrix):

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required for live OpenAI calls; missing keys return mock responses. |
| `OPENAI_MODEL` | — | Preferred model override for OpenAI calls. |
| `AI_MODEL` | `gpt-4-turbo` | Legacy default used by config and worker bootstrapping. |
| `FALLBACK_MODEL` | — | Override for fallback model selection. |
| `GPT51_MODEL` / `GPT5_MODEL` | `gpt-5.1` | GPT-5 reasoning model override. |
| `DATABASE_URL` | — | PostgreSQL connection string. |
| `RUN_WORKERS` | `true` (local) | Disable on Railway unless you need background tasks. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Log directory for runtime files. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Memory cache directory. |

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
- `RUN_WORKERS` defaults to `false` in Railway deploy config

High-level steps:

1. Create a Railway project and connect the GitHub repository.
2. Add required environment variables (`OPENAI_API_KEY`, optional model overrides).
3. (Optional) Provision PostgreSQL and confirm `DATABASE_URL` is injected.
4. Deploy and confirm the `/health` check passes.
5. Roll back from the Railway **Deployments** view if needed.

See `docs/RAILWAY_DEPLOYMENT.md` for a step-by-step guide.

## Troubleshooting

- **Mock responses**: ensure `OPENAI_API_KEY` is set and not the `.env.example` placeholder.
- **Database fallback**: without `DATABASE_URL`, the service uses in-memory storage and
  `/health` reports degraded database status.
- **Worker boot disabled**: set `RUN_WORKERS=true` locally (keep `false` on Railway unless required).
- **Confirmation gate**: send `x-confirmed: yes` for manual runs or configure
  `TRUSTED_GPT_IDS` / `ARCANOS_AUTOMATION_SECRET` for automation.

## References

- Configuration matrix: `docs/CONFIGURATION.md`
- Railway deployment: `docs/RAILWAY_DEPLOYMENT.md`
- API overview: `docs/api/README.md`
- Python daemon setup: `QUICKSTART.md`

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
