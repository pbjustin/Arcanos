# Arcanos Backend

[![CI/CD Pipeline](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml)
[![codecov](https://codecov.io/gh/pbjustin/Arcanos/branch/main/graph/badge.svg)](https://codecov.io/gh/pbjustin/Arcanos)

## Overview
Arcanos is a TypeScript/Express backend with optional workers and an optional Python CLI daemon (`daemon-python/`).

Key characteristics:
- **Responses-first OpenAI integration** (tool calling + continuation via `previous_response_id`)
- **Adapter-boundary construction** (centralized client creation, headers, resilience)
- **Shared HTTP toolkit** (`src/shared/http/`) for request context, validation, and errors
- **DB-backed async jobs** for durable GPT and worker execution
- **Schema-first protocol surface** in `packages/protocol/`
- **Railway-ready** web/worker launcher and health configuration


### Optional local daemon (Python)
The repository includes an **optional local daemon CLI** in `daemon-python/` that turns Arcanos into a personal coding assistant on your machine:
- routes module-bound daemon chat through `/gpt/arcanos-daemon`
- detects inline unified diffs in AI responses and prompts **Apply patch? [y/N]**
- detects command proposals and prompts **Run? [y/N]** (allowlisted)
- injects lightweight **repo indexing context** into backend requests
- keeps **SQLite audit/history** with backups + `/rollback`

See: `daemon-python/README.md`


## Prerequisites
- Node.js 18+ and npm 8+
- Optional: Python 3.10+ for daemon work in `daemon-python/`
- Optional: OpenAI API key for non-mock model calls

## Setup
```bash
npm install
cp .env.example .env
```

## Configuration
- Backend minimum:
  - `PORT=3000` for local `.env` usage; Railway injects `PORT`
  - `OPENAI_API_KEY=sk-...` (optional for mock-mode tests)
- Optional OpenAI request persistence:
  - `OPENAI_STORE=false`
- Railway service role:
  - `ARCANOS_PROCESS_KIND=web` on the API service
  - `ARCANOS_PROCESS_KIND=worker` on the async worker service

## Run locally
Use the runbook docs for exact commands:
- `QUICKSTART.md`
- `docs/RUN_LOCAL.md`

## Deploy (Railway)
- `docs/RAILWAY_DEPLOYMENT.md`
- `docs/CI_CD.md`

## Custom GPT + GPT ID API Bridge
Custom GPT Actions should call the HTTP bridge, not Railway CLI. The runtime path is:
`Custom GPT Action -> POST /api/bridge/gpt -> direct or queued GPT execution -> /jobs/* for async polling`.

`POST /gpt/:gptId` remains the writing plane for module-bound generative work. Job-result lookups, runtime diagnostics, queue inspection, worker status, and MCP diagnostics must use direct control endpoints or `/gpt-access/*`, not prompt-shaped requests through `/gpt/:gptId`.

Required environment:
- `OPENAI_ACTION_SHARED_SECRET` for inbound bridge auth.
- `DEFAULT_GPT_ID` as the fallback GPT ID when callers omit `gptId`.

Bridge endpoints:
- `POST /api/bridge/gpt` accepts `{ "gptId": "arcanos-core", "prompt": "...", "action": "query" | "query_and_wait", "metadata": {} }`.
- `GET /api/bridge/health` reports bridge env sanity, default GPT route reachability, database state, worker health when available, and bridge failure counters.
- Async job retrieval stays on `GET /jobs/{id}` and `GET /jobs/{id}/result`.

The Custom GPT Action OpenAPI document is `openapi/custom-gpt-bridge.yaml`.

## Troubleshooting
- `docs/TROUBLESHOOTING.md`
- Health checks: `GET /healthz` (liveness), `GET /readyz` (readiness), `GET /health` (dependency summary and Railway probe)

## References
- API catalog: `docs/API.md`
- Memory backend guide: `docs/MEMORY_BACKEND_USAGE.md`
- Workspace packages: `docs/WORKSPACE_PACKAGES.md`
- Schema/protocol changes: `docs/SCHEMA_PROTOCOL_GUIDE.md`
- Database and migrations: `docs/DATABASE_MIGRATIONS.md`
- OpenAI tooling: `docs/OPENAI_RESPONSES_TOOLS.md`
- Solo operator runtime guide: `docs/SOLO_OPERATOR_RUNTIME_GUIDE.md`
- Configuration details: `docs/CONFIGURATION.md`
- Documentation index: `docs/README.md`

## OpenAI integration map (current)
Canonical boundaries / pipelines:
- TypeScript OpenAI adapter boundary: `src/core/adapters/openai.adapter.ts`
- TypeScript request builders (staged): `src/services/openai/requestBuilders/`
  - `build → normalize → convert → validate`
- TypeScript call pipeline (staged): `src/services/openai/chatFlow/`
  - `prepare → execute → parse → trace`
- Shared parsing utilities: `packages/arcanos-openai/src/responseParsing.ts`
- Worker OpenAI boundary: `workers/src/infrastructure/sdk/openai.ts`
- Python daemon OpenAI adapter: `daemon-python/arcanos/openai/openai_adapter.py`

## Health endpoints
- Liveness: `GET /healthz`
- Readiness: `GET /readyz` (critical dependencies ready for traffic)
- Detailed dependency view: `GET /health` (Railway healthcheck path; includes Redis and other dependency state)

## Custom GPT bridge smoke test
Use `POST /api/bridge/gpt` with `action: "health_echo"` to verify bridge auth, request handling, queueing, worker execution, and canonical `/jobs/{id}/result` retrieval without invoking the Trinity reasoning pipeline. Use `action: "query"` or `action: "query_and_wait"` when the request must exercise real model behavior.

## OpenAI data retention
Responses requests default to **stateless** (`store: false`). You can enable storage via:
- `OPENAI_STORE=true`

More details:
- `docs/OPENAI_RESPONSES_TOOLS.md`
