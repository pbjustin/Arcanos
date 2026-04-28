# Arcanos Quickstart

## Overview
This quickstart gets the backend running first, then optionally starts the Python daemon CLI.

## Prerequisites
- Node.js 18+ and npm 8+
- Optional: Python 3.10+ for `daemon-python/`
- OpenAI API key for live AI calls; tests can use mock-mode configuration

## Setup
Backend:
```bash
npm install
cp .env.example .env
```

Daemon (optional, local coding assistant):
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
# For daemon contributors/testers:
# python -m pip install -e ".[dev]"
cp .env.example .env
```

Recommended `.env` (backend-routed agent):
```env
BACKEND_URL=http://localhost:3000
BACKEND_GPT_ID=arcanos-daemon
BACKEND_ALLOW_GPT_ID_AUTH=true

AGENTIC_ENABLED=true
REPO_INDEX_ENABLED=true
HISTORY_DB_PATH=history.db
PATCH_BACKUP_DIR=patch_backups
AUTOMATIONS_FILE=automations.toml
```

Run:
```bash
arcanos
```

Tip: when the backend proposes a patch (inline diff), the CLI will prompt **Apply patch? [y/N]**.



## Configuration
Minimum backend config (`.env`):
```env
PORT=3000
OPENAI_API_KEY=sk-...
# Optional: persist Responses on OpenAI side (default false)
OPENAI_STORE=false
```

Minimum daemon config (`daemon-python/.env`):
```env
# Required only for direct local OpenAI routing:
OPENAI_API_KEY=sk-...
# Recommended backend routing:
# BACKEND_URL=http://localhost:3000
```

Optional daemon result-wait knobs (backend `.env`):
```env
DAEMON_RESULT_WAIT_MS=8000
DAEMON_RESULT_POLL_MS=250
```

## Run locally
Backend:
```bash
npm run build
npm start
```

Development rebuild + run:
```bash
npm run dev
```

Daemon (optional):
```bash
cd daemon-python
arcanos
```

## Quick checks
```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/health
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
```

Run `npm run build:packages` before full backend validation when package contracts changed.

Next:
- API catalog: `docs/API.md`
- OpenAI tooling/continuation: `docs/OPENAI_RESPONSES_TOOLS.md`
- Full local runbook: `docs/RUN_LOCAL.md`
