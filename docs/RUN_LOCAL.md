# Local Runbook

## Overview
This runbook covers local backend startup, optional daemon startup, and quick validation checks.

## Prerequisites
- Node.js 18+, npm 8+
- Optional Python 3.10+ for daemon
- OpenAI API key for live AI calls; mock-mode tests do not require a real key

## Setup
Backend:
```bash
npm install
cp .env.example .env
```

Set minimum backend values:
```env
PORT=3000
OPENAI_API_KEY=sk-...
```

`PORT=3000` matches `.env.example` and the direct local server default. Railway injects `PORT`, and the Railway launcher also validates `ARCANOS_PROCESS_KIND`.

Optional daemon setup:
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
# For daemon test/development work:
# python -m pip install -e ".[dev]"
cp .env.example .env
```

## Configuration
Backend local defaults are documented in `CONFIGURATION.md`. For daemon routing to backend, set:
```env
BACKEND_URL=http://localhost:3000
BACKEND_ROUTING_MODE=hybrid
```

## Run locally
Backend:
```bash
npm run build
npm start
```

Backend with rebuild on every run:
```bash
npm run dev
```

Dedicated async worker, after `npm run build`, when `DATABASE_URL` and `OPENAI_API_KEY` are configured:
```bash
npm run start:worker
```

Optional daemon:
```bash
cd daemon-python
arcanos
```

Validation:
```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/health
curl http://localhost:3000/api/test
```

## Common commands
```bash
npm run build:packages
npm run build
node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false
npm run test:unit
npm run type-check
npm run lint
npm run validate:railway
npm run validate:backend-cli:offline
```

Use `npm run build:packages` before full backend validation whenever `packages/*`, protocol schemas, or package exports changed.

## Deploy (Railway)
Local workflow should pass before Railway deploy:
```bash
npm run validate:railway
```
Then follow `RAILWAY_DEPLOYMENT.md`.

## Troubleshooting
- Backend won't start: check `PORT`, `.env` loading, and the startup error in the terminal.
- Daemon exits immediately: ensure daemon `.env` has `OPENAI_API_KEY`.
- Backend calls from daemon fail: verify `BACKEND_URL` and backend health endpoint.
- Worker exits with database bootstrap errors: configure `DATABASE_URL`, `DATABASE_PRIVATE_URL`, `DATABASE_PUBLIC_URL`, or the full `PG*` connection set.

## References
- `../README.md`
- `CONFIGURATION.md`
- `RAILWAY_DEPLOYMENT.md`
- `../daemon-python/README.md`
