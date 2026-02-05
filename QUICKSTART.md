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
```

Minimum daemon config (`daemon-python/.env`):
```env
OPENAI_API_KEY=sk-...
# Optional backend routing:
# BACKEND_URL=http://localhost:3000
```

## Run locally
Backend:
```bash
npm run build
npm start
```

Daemon (optional, in `daemon-python/` venv):
```bash
arcanos
# or
python -m arcanos.cli
```

## Deploy (Railway)
Use `docs/RAILWAY_DEPLOYMENT.md` for production deployment and rollback steps.

## Troubleshooting
- `OPENAI_API_KEY is required`: update the correct `.env` file.
- Daemon cannot reach backend: confirm `BACKEND_URL` and backend port.
- `PORT is required`: backend startup enforces `PORT`; set it in `.env`.

## References
- Root guide: `README.md`
- Local runbook: `docs/RUN_LOCAL.md`
- Daemon guide: `daemon-python/README.md`
- Railway deployment: `docs/RAILWAY_DEPLOYMENT.md`
