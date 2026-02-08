# Contributing to Arcanos

## Overview
This guide covers contribution workflow for:
- TypeScript backend/runtime in `src/`
- TypeScript workers in `workers/`
- Python daemon in `daemon-python/`

OpenAI integrations are adapter-first and centralized. New runtime code should not instantiate SDK clients outside the canonical constructor modules.

## Prerequisites
- Git
- Node.js 18+, npm 8+
- Optional: Python 3.10+ for daemon changes

## Setup
```bash
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos
npm install
cp .env.example .env
```

Optional daemon setup:
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
cp .env.example .env
```

## Configuration
- Backend minimum:
  - `PORT=3000`
  - `OPENAI_API_KEY=your-openai-api-key-here` (optional for mock-mode tests)
- Daemon minimum:
  - `OPENAI_API_KEY=your-openai-api-key-here`
- Keep secrets out of git. Use placeholders in all `*.env.example` files.

## Required Local Validation
Backend and worker checks:
```bash
npm run guard:commit
npm run type-check
npm run lint
npm run build
npm test
npm run validate:railway
npm run validate:backend-cli:offline
```

Daemon checks:
```bash
python daemon-python/validate_backend_cli_offline.py
pytest daemon-python/tests/test_debug_server.py -q
pytest daemon-python/tests/test_openai_adapter.py -q
pytest daemon-python/tests/test_openai_unified_client.py -q
pytest daemon-python/tests/test_telemetry_sanitization.py -q
python daemon-python/scripts/continuous_audit.py --max-depth=1 --no-recursive --no-railway-check
```

## Deploy (Railway)
Contributors must keep Railway build/start behavior unchanged:
- Build in build phase (`npm ci --include=dev && npm run build`)
- Start only runs compiled output (`node --max-old-space-size=7168 dist/start-server.js`)

Validate Railway compatibility before merge:
```bash
npm run validate:railway
```

Production deploy process is documented in `docs/RAILWAY_DEPLOYMENT.md`.

## CI Expectations
Authoritative branch-protection workflow:
- `.github/workflows/ci-cd.yml`

Required CI behavior:
- Mock-only OpenAI required checks (`OPENAI_API_KEY=mock-api-key`)
- `npm run guard:commit` gate
- Windows Python CLI unit/offline validation job

## OpenAI and Env Rules
- TypeScript OpenAI constructor boundary: `src/adapters/openai.adapter.ts`
- Worker OpenAI constructor boundary: `workers/src/infrastructure/sdk/openai.ts`
- Python OpenAI constructor boundary: `daemon-python/arcanos/openai/unified_client.py`
- TypeScript env access boundary: `src/config/env.ts`
- Python env access boundary: `daemon-python/arcanos/env.py`

Escape hatch usage:
- TypeScript runtime may use `getClient()` only where adapter surface does not yet cover the API.
- New chat/image/embed/audio integrations should use adapter methods first.

## Troubleshooting
- Missing npm script errors: run `npm run` and align commands with `package.json`.
- Failing daemon tests: ensure daemon dependencies installed in active venv.
- Route/documentation drift: update `docs/API.md` in the same PR.

## References
- Code of conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
- Docs standards: `docs/README.md`
- PR templates: `.github/PULL_REQUEST_TEMPLATE.md`
- Adapter migration map: `OPENAI_ADAPTER_MIGRATION.md`
