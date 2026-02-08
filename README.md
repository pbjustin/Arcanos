# Arcanos Backend

[![CI/CD Pipeline](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml)
[![codecov](https://codecov.io/gh/pbjustin/Arcanos/branch/main/graph/badge.svg)](https://codecov.io/gh/pbjustin/Arcanos)

## Overview
Arcanos is a TypeScript/Express backend with optional workers and an optional Python CLI daemon (`daemon-python/`).

OpenAI usage is adapter-first across stacks:
- TypeScript runtime constructor boundary: `src/adapters/openai.adapter.ts`
- TypeScript lifecycle bridge: `src/services/openai/unifiedClient.ts`
- Worker constructor boundary: `workers/src/infrastructure/sdk/openai.ts`
- Worker env/config boundary: `workers/src/infrastructure/sdk/openaiConfig.ts`
- Python daemon constructor boundary: `daemon-python/arcanos/openai/unified_client.py`
- Python daemon adapter boundary: `daemon-python/arcanos/openai/openai_adapter.py`

## Quick Start

**Backend (TypeScript):**
```bash
npm install
cp .env.example .env        # set PORT=3000 and OPENAI_API_KEY
npm run build
npm test                     # run tests
npm start                    # http://localhost:3000/health
```

**CLI Daemon (Python):**
```bash
cd daemon-python
pip install -r requirements.txt
cp .env.example .env         # set OPENAI_API_KEY
pytest tests/ -q             # run tests
python -m arcanos.cli        # start daemon
```

See [docs/RUN_LOCAL.md](docs/RUN_LOCAL.md) for detailed setup, or use `make install && make test` with the root [Makefile](Makefile).

## Prerequisites
- Node.js 18+ and npm 8+
- `PORT` set in runtime env (required at startup; Railway injects this)
- `OPENAI_API_KEY` for live calls (mock responses are used when absent)
- Optional PostgreSQL `DATABASE_URL`
- Optional Python 3.10+ for daemon work

## Setup
```bash
npm install
cp .env.example .env
```

Minimum local `.env` values:
- `PORT=3000`
- `OPENAI_API_KEY=your-openai-api-key-here`

## Configuration
Primary backend runtime variables:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | Yes | none | Fail-fast startup validation in `src/config/env.ts`. |
| `OPENAI_API_KEY` | No* | none | Missing key keeps OpenAI routes in mock/degraded mode. |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Default chat model override. |
| `OPENAI_BASE_URL` | No | none | Optional custom provider endpoint. |
| `OPENAI_MAX_RETRIES` | No | `2` | Retry count for transient failures. |
| `DATABASE_URL` | No | none | Enables PostgreSQL persistence. |
| `RUN_WORKERS` | No | `true` (non-test) | Set `false` for API-only runtime. |
| `ARC_LOG_PATH` | No | `/tmp/arc/log` | Runtime logs (ephemeral on Railway). |
| `ARC_MEMORY_PATH` | No | `/tmp/arc/memory` | Runtime memory/cache path. |

*Operationally required for non-mock responses.

## Run Locally
```bash
npm run build
npm start
```

Health checks:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

## Validation Commands
Required local validation for this refactor:
```bash
npm run build
npm test
npm run validate:railway
npm run guard:commit
npm run validate:backend-cli:offline
python daemon-python/tests/test_telemetry_sanitization.py
python daemon-python/scripts/continuous_audit.py --max-depth=1 --no-recursive --no-railway-check
```

## CI and Branch Protection
The authoritative required workflow is `.github/workflows/ci-cd.yml`.

Required CI behavior:
- Uses mock-only OpenAI execution (`OPENAI_API_KEY=mock-api-key`) for required checks.
- Runs `npm run guard:commit`.
- Runs offline daemon validation (`daemon-python/validate_backend_cli_offline.py`).

## Deploy (Railway)
Railway settings are source-controlled in `railway.json`:
- Build: `npm ci --include=dev && npm run build`
- Start: `node --max-old-space-size=7168 dist/start-server.js`
- Health check: `GET /health`

Railway remains build-phase-first. Start does not run a build.

## Adapter-First Usage Examples
TypeScript:
```ts
import { createOpenAIAdapter } from "./src/adapters/openai.adapter.js";

const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  defaultModel: "gpt-4o-mini",
});

const response = await adapter.chat.completions.create(
  {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Summarize Arcanos health status." }],
  },
  { headers: { "x-trace-id": "local-demo" } },
);
```

Python daemon:
```python
from arcanos.openai import chat_completion

response = chat_completion(
    user_message="Summarize Arcanos health status.",
    model="gpt-4o-mini",
)
print(response.choices[0].message.content)
```

## Security and Logging
- Runtime env access is centralized (`src/config/env.ts`, `daemon-python/arcanos/env.py`).
- Structured logs redact secret-like keys and token-like values.
- Commit guardrails block staged artifacts and obvious secret literals.

## References
- `docs/README.md`
- `docs/RUN_LOCAL.md`
- `docs/API.md`
- `docs/RAILWAY_DEPLOYMENT.md`
- `RAILWAY_COMPATIBILITY_GUIDE.md`
- `OPENAI_ADAPTER_MIGRATION.md`
