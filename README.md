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

## Getting started
See:
- `QUICKSTART.md` (fast local run)
- `docs/RUN_LOCAL.md` (runbook + validation)
- `docs/RAILWAY_DEPLOYMENT.md` (Railway deploy workflow)

## OpenAI data retention
Responses requests default to **stateless** (`store: false`). You can enable storage via:
- `OPENAI_STORE=true`

More details:
- `docs/OPENAI_RESPONSES_TOOLS.md`
