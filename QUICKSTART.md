# Arcanos Quickstart

## Overview
This quickstart gets the backend running first, then optionally starts the Python daemon CLI.

## Prerequisites
- Node.js 18+ and npm 8+
- Optional: Python 3.10+ for `daemon-python/`
- OpenAI API key

## Setup
Backend:
```bash
npm install
cp .env.example .env
```

Daemon (optional):
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
cp .env.example .env
```

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
OPENAI_API_KEY=sk-...
# Optional backend routing:
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

Daemon (optional):
```bash
cd daemon-python
arcanos
```

## Quick checks
```bash
curl http://localhost:3000/healthz
```

Next:
- API catalog: `docs/API.md`
- OpenAI tooling/continuation: `docs/OPENAI_RESPONSES_TOOLS.md`
