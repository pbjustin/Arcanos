# Arcanos OpenAI API and Railway Compatibility

> **Last Updated:** 2026-04-28 | **Version:** 1.2.0 | **OpenAI SDK:** Node v6.x, Python v2.30.0+

## Overview
This document captures the deployed architecture and compatibility constraints for Railway.

For step-by-step deployment, use `docs/RAILWAY_DEPLOYMENT.md`.

## OpenAI Integration Architecture
Runtime OpenAI usage is adapter-first:
- TypeScript API constructor boundary: `src/core/adapters/openai.adapter.ts`
- TypeScript lifecycle boundary: `src/services/openai/chatFlow/` (staged pipeline)
- Worker constructor boundary: `workers/src/infrastructure/sdk/openai.ts`
- Worker env/config boundary: `workers/src/infrastructure/sdk/openaiConfig.ts`
- Python daemon constructor boundary: `daemon-python/arcanos/openai/unified_client.py`
- Python daemon adapter boundary: `daemon-python/arcanos/openai/openai_adapter.py`

Constructor policy:
- `new OpenAI(...)` appears only in canonical constructor files above.
- Runtime call sites consume adapters, not ad-hoc local client wrappers.

## API Surface
Core endpoints:
```text
/api/arcanos/ask
/api/vision
/api/transcribe
/api/update
/api/arcanos
/api/memory
/api/sim
/health
/healthz
/readyz
```

## Railway Runtime Model
Railway config source of truth: `railway.json`

Build command:
```bash
npm ci --include=dev --no-audit --no-fund && npm run build
```

Start command:
```bash
node scripts/start-railway-service.mjs
```

Locked behavior:
- Build-phase-first remains enabled.
- Start command does not execute a build.
- Runtime role selection is explicit through `ARCANOS_PROCESS_KIND`.

Health check:
- Path: `GET /health`
- Timeout: `300` seconds
- Restart policy: `ON_FAILURE`, max retries `10`

## Environment Compatibility
Railway-provided variables:
- `PORT`
- `RAILWAY_ENVIRONMENT`
- `DATABASE_URL` (when attached)

Required for live AI responses:
- `OPENAI_API_KEY`

Required for Railway launcher role selection:
- `ARCANOS_PROCESS_KIND=web` on the API service
- `ARCANOS_PROCESS_KIND=worker` on the async worker service

Common optional overrides:
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `AI_MODEL`
- `RUN_WORKERS` (launcher-managed on Railway)

## CI and Validation Compatibility
Authoritative required workflow: `.github/workflows/ci-cd.yml`

Required CI checks use mock-only OpenAI behavior:
- `OPENAI_API_KEY=mock-api-key`
- No required check depends on live OpenAI/network responses.

Recommended local pre-merge checks:
```bash
npm run guard:commit
npm run build
npm test
npm run validate:railway
npm run validate:backend-cli:offline
```

## Security and Resilience Guarantees
- Centralized env access in runtime modules.
- Structured log sanitization redacts secret-like keys and token-like values.
- Commit guard blocks staged artifacts and high-signal secret literals.
- Missing OpenAI key degrades to mock behavior instead of crash for API runtime.

## References
- `docs/RAILWAY_DEPLOYMENT.md`
- `railway.json`
- `scripts/validate-railway-compatibility.js`
- `.github/workflows/ci-cd.yml`
- `OPENAI_ADAPTER_MIGRATION.md`
