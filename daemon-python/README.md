# Arcanos Python CLI

## Overview
The daemon CLI is an optional companion client that supports local chat, voice, vision, terminal execution, and optional backend routing.

## Prerequisites
- Python 3.10+
- OpenAI API key
- Optional backend URL/token if using backend or hybrid routing

## Setup
From repository root:
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
cp .env.example .env
```

## Configuration
Minimum:
```env
OPENAI_API_KEY=sk-...
```

Optional backend routing:
```env
BACKEND_URL=http://localhost:3000
BACKEND_ROUTING_MODE=hybrid
```

Optional debug server hardening:
```env
DEBUG_SERVER_ENABLED=true
DEBUG_SERVER_TOKEN=<strong-random-token>
```

## Run locally
```bash
arcanos
# or
python -m arcanos.cli
```

## Deploy (Railway)
The daemon itself is local/client software. Deploy only the backend to Railway using `../docs/RAILWAY_DEPLOYMENT.md`.

## Troubleshooting
- Immediate exit with config error: ensure `OPENAI_API_KEY` is set.
- Backend route failures: verify `BACKEND_URL` and backend health.
- Debug server auth errors: verify `DEBUG_SERVER_TOKEN` and request headers.

## References
- `../README.md`
- `../docs/RUN_LOCAL.md`
- `../docs/API.md`
- `DEBUG_SERVER_README.md`
