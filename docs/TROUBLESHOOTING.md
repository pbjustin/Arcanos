# Troubleshooting

## Overview
Common production and local issues for backend, daemon, OpenAI integration, and Railway deployment.

## Prerequisites
- Access to application logs (local terminal or Railway logs).
- Access to environment variables used by the failing environment.

## Setup
Before debugging, collect:
1. Exact command used.
2. Exact error message and timestamp.
3. Current environment (`NODE_ENV`, deployment target, branch).

## Configuration
Quick config checks:
- Backend startup requires `PORT`.
- Live AI requires `OPENAI_API_KEY`.
- PostgreSQL persistence requires `DATABASE_URL`.
- Daemon debug server should have `DEBUG_SERVER_TOKEN` when enabled.

## Run locally
Helpful probes:
```bash
npm run build
npm start
curl http://localhost:3000/health
```

Daemon probe:
```bash
cd daemon-python
python validate_backend_cli.py
```

## Deploy (Railway)
Post-deploy checks:
```bash
curl https://<your-service>.up.railway.app/health
curl https://<your-service>.up.railway.app/readyz
```

If failing, inspect Railway build/deploy logs first.

## Troubleshooting
- `PORT is required`: set `PORT` locally or check Railway variable injection.
- Mock responses in production: `OPENAI_API_KEY` missing/invalid.
- Confirmation-required 403: include `x-confirmed` or trusted automation headers.
- Daemon auth errors: validate backend token/bootstrap settings.
- Health degraded for database: attach/configure PostgreSQL or accept in-memory mode.

## References
- `RUN_LOCAL.md`
- `RAILWAY_DEPLOYMENT.md`
- `CONFIGURATION.md`
- `API.md`
