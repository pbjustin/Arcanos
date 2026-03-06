# Arcanos Backend

[![CI/CD Pipeline](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml)
[![codecov](https://codecov.io/gh/pbjustin/Arcanos/branch/main/graph/badge.svg)](https://codecov.io/gh/pbjustin/Arcanos)

## Overview
Arcanos is a TypeScript/Express backend with optional workers and an optional Python CLI daemon (`daemon-python/`).

Key characteristics:
- **Responses-first OpenAI integration** (tool calling + continuation via `previous_response_id`)
- **Adapter-boundary construction** (centralized client creation, headers, resilience)
- **Shared HTTP toolkit** (`src/shared/http/`) for request context, validation, and errors
- **Railway-ready** start/health configuration


### Optional local daemon (Python)
The repository includes an **optional local daemon CLI** in `daemon-python/` that turns Arcanos into a personal coding assistant on your machine:
- routes chat to the backend using `gptId=arcanos-daemon`
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
  - `PORT=3000`
  - `OPENAI_API_KEY=sk-...` (optional for mock-mode tests)
- Optional OpenAI request persistence:
  - `OPENAI_STORE=false`

## Run locally
Use the runbook docs for exact commands:
- `QUICKSTART.md`
- `docs/RUN_LOCAL.md`

## Deploy (Railway)
- `docs/RAILWAY_DEPLOYMENT.md`
- `docs/CI_CD.md`

## Troubleshooting
- `docs/TROUBLESHOOTING.md`
- Health checks: `GET /healthz` (liveness), `GET /health` (readiness/dependencies)

## References
- API catalog: `docs/API.md`
- Memory backend guide: `docs/MEMORY_BACKEND_USAGE.md`
- OpenAI tooling: `docs/OPENAI_RESPONSES_TOOLS.md`
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
- Liveness: `GET /healthz` (used by Railway healthchecks)
- Readiness: `GET /health` (may reflect downstream dependencies and can return non-200)

## OpenAI data retention
Responses requests default to **stateless** (`store: false`). You can enable storage via:
- `OPENAI_STORE=true`

More details:
- `docs/OPENAI_RESPONSES_TOOLS.md`
