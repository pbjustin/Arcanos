# Contributing to Arcanos

## Overview
This guide covers contribution workflow for:
- TypeScript backend/runtime in `src/`
- TypeScript workers in `workers/`
- Python daemon in `daemon-python/`

OpenAI integrations are adapter-first and centralized. New runtime code should not instantiate SDK clients outside the canonical constructor modules.

## Prerequisites
- Git
- Node.js 20.19.0 recommended; current dependencies require Node 20.18.1+ despite the older root `engines` floor. npm 8+.
- Optional: Python 3.10+ for daemon changes

## Quick Start (Full Stack)
```bash
# Clone and install everything
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos
npm install
cp .env.example .env

# Python daemon (optional — needed for CLI work)
cd daemon-python
python -m venv venv
# Windows PowerShell:  .\venv\Scripts\Activate.ps1
# macOS/Linux:         source venv/bin/activate
python -m pip install -e ".[dev]"
cp .env.example .env
cd ..

# Build and verify
npm run build
npm test
```

If you only work on the TypeScript backend, skip the Python steps above.

Use `npm install` for local development. CI and Railway use reproducible `npm ci` installs. The Docker image uses the install sequence declared in `Dockerfile`, which currently combines `npm ci --omit=dev` with a later development-dependency install for the build stage.

## Setup (Step by Step)
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
python -m pip install -e ".[dev]"
cp .env.example .env
```

## Run locally
Backend:
```bash
npm run build
npm start
```

Daemon (optional):
```bash
cd daemon-python
arcanos
```

## Configuration
- Backend minimum:
  - `PORT=3000`
  - `OPENAI_API_KEY=your-openai-api-key-here` (optional for mock-mode tests)
- Daemon minimum:
  - `OPENAI_API_KEY=your-openai-api-key-here`
- Keep secrets out of git. Use placeholders in all `*.env.example` files.

## Required Local Validation
Choose the smallest check set that covers the change, then expand for cross-cutting or release-sensitive work:

| Change area | Minimum relevant checks |
| --- | --- |
| Root TypeScript/backend | `npm run type-check`, `npm run lint`, and focused Jest via `node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false` |
| Broad root behavior | `npm run build` and `npm test` (or the split `npm run test:all`) |
| Protocol/CLI or TypeScript-Python boundary | `npm run type-check`, `npm run lint`, protocol-focused Jest, `npm run validate:backend-cli:contract`, `npm run validate:backend-cli:offline`, and `npm run sync:check` |
| `workers/` | `npm run build:workers`, `npm run lint`, and focused Jest where applicable |
| Root job runner or `src/workers/` | `npm run build`, `npm run lint`, and focused Jest |
| `arcanos-ai-runtime/` | `npm run test:runtime-integration` and `npm run lint` |
| Python daemon | Relevant `python -m pytest daemon-python/tests/<test_file>.py -q`; add `npm run validate:backend-cli:offline` for contract changes |
| Railway configuration/startup | `npm run build` and the local, non-deploying `npm run validate:railway` |
| Database/schema code | `npm run type-check`, focused database/route Jest, and `npm run validate:railway`; do not apply a migration as routine validation |

Run `npm run guard:commit` before committing. The expensive broad readiness sweep is `npm run validate:all`; it does not include the Python pytest suite or `arcanos-ai-runtime` tests.

## Deploy (Railway)
Contributors must keep Railway build/start behavior unchanged:
- Build in build phase (`npm ci --include=dev --no-audit --no-fund && npm run build`)
- Start runs the shared launcher only (`node scripts/start-railway-service.mjs`)
- Railway services must set `ARCANOS_PROCESS_KIND=web` or `ARCANOS_PROCESS_KIND=worker`

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
- Shared TypeScript OpenAI constructor helper: `packages/arcanos-openai/src/client.ts`
- Backend OpenAI adapter/constructor boundary: `src/core/adapters/openai.adapter.ts`
- Worker OpenAI adapter (which consumes the shared constructor helper): `workers/src/infrastructure/sdk/openai.ts`
- Python OpenAI constructor boundary: `daemon-python/arcanos/openai/unified_client.py`
- TypeScript env access boundary: `src/platform/runtime/env.ts` (`src/config/env.ts` is a compatibility re-export)
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
- OpenAI behavior and migration guidance: `docs/OPENAI_RESPONSES_TOOLS.md`
- Shared package boundaries: `docs/WORKSPACE_PACKAGES.md`
