# Arcanos Backend

## Overview
Arcanos is a TypeScript/Express backend that centralizes OpenAI interactions, API routing, and optional background workers. The backend starts from `src/start-server.ts`, mounts routes in `src/routes/register.ts`, and can be paired with the optional Python CLI daemon in `daemon-python/`.

## Prerequisites
- Node.js 18+ and npm 8+ (`package.json` engines).
- `PORT` set in environment (required at startup; Railway injects this automatically).
- `OPENAI_API_KEY` for live OpenAI responses (otherwise mock responses are used).
- Optional PostgreSQL (`DATABASE_URL`) for persistent storage.
- Optional Python 3.10+ if you also run the daemon CLI.

## Setup
```bash
npm install
cp .env.example .env
```

Edit `.env` and set at minimum:
- `PORT=3000` (or another free local port)
- `OPENAI_API_KEY=...`

## Configuration
Primary runtime variables:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | Yes | none | Process exits on startup if missing. |
| `OPENAI_API_KEY` | No* | none | Needed for real OpenAI calls. Without it, mock mode is used. |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Main model override. |
| `DATABASE_URL` | No | none | Enables PostgreSQL persistence. |
| `RUN_WORKERS` | No | `true` (non-test) | Set `false` if you only want API serving. |
| `ARC_LOG_PATH` | No | `/tmp/arc/log` | Runtime log path (ephemeral on Railway). |
| `ARC_MEMORY_PATH` | No | `/tmp/arc/memory` | Runtime memory/cache path (ephemeral on Railway). |

*Operationally required for production-quality AI responses.

## Run locally
```bash
npm run build
npm start
```

Health checks (default local port shown):
```bash
curl http://localhost:3000/health
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

## Deploy (Railway)
Railway deploy settings are source-controlled in `railway.json`:
- Build: `npm ci --include=dev && npm run build`
- Start: `node --max-old-space-size=7168 dist/start-server.js`
- Health check: `GET /health`

Use the full runbook in `docs/RAILWAY_DEPLOYMENT.md`.

## Troubleshooting
- Startup fails with `PORT is required`: set `PORT` in `.env` locally.
- AI endpoints return mock responses: set a valid `OPENAI_API_KEY`.
- Database shows degraded in `/health`: set `DATABASE_URL` or accept in-memory fallback.
- Protected endpoints return 403: provide `x-confirmed: yes` or a valid confirmation token flow.

## References
- Docs index: `docs/README.md`
- Local runbook: `docs/RUN_LOCAL.md`
- API catalog: `docs/API.md`
- Railway deploy guide: `docs/RAILWAY_DEPLOYMENT.md`
- Configuration matrix: `docs/CONFIGURATION.md`
- CI/CD and secrets: `docs/CI_CD.md`

OpenAI SDK examples matching repository patterns:

```js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await client.chat.completions.create({
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  messages: [{ role: "user", content: "Summarize Arcanos health status." }],
});

console.log(response.choices[0].message.content);
```

```python
from openai import OpenAI
import os

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

response = client.chat.completions.create(
    model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
    messages=[{"role": "user", "content": "Summarize Arcanos health status."}],
)

print(response.choices[0].message.content)
```
