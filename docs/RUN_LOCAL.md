# Local Runbook

## Overview
This runbook covers local backend startup, optional daemon startup, and quick validation checks.

## Prerequisites
- Node.js 18+, npm 8+
- Optional Python 3.10+ for daemon
- OpenAI API key

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

Optional daemon:
```bash
cd daemon-python
arcanos
```

Validation:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/test
```

## Deploy (Railway)
Local workflow should pass before Railway deploy:
```bash
npm run validate:railway
```
Then follow `RAILWAY_DEPLOYMENT.md`.

## Troubleshooting
- Backend won't start: ensure `PORT` is set.
- Daemon exits immediately: ensure daemon `.env` has `OPENAI_API_KEY`.
- Backend calls from daemon fail: verify `BACKEND_URL` and backend health endpoint.

## References
- `../README.md`
- `CONFIGURATION.md`
- `RAILWAY_DEPLOYMENT.md`
- `../daemon-python/README.md`
