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
- Local backend defaults to port `3000` if `PORT` is unset; set `PORT=3000` in `.env` for deterministic local runs.
- Railway injects `PORT`; do not hard-code it in Railway variables.
- Railway launcher requires `ARCANOS_PROCESS_KIND=web` or `ARCANOS_PROCESS_KIND=worker`.
- Live AI requires `OPENAI_API_KEY`.
- PostgreSQL persistence requires `DATABASE_URL`.
- Daemon debug server should have `DEBUG_SERVER_TOKEN` when enabled.

## Run locally
Helpful probes:
```bash
npm run build
npm start
curl http://localhost:3000/healthz
```

Daemon probe:
```bash
cd daemon-python
python validate_backend_cli.py
```

## Deploy (Railway)
Post-deploy checks:
```bash
railway status
railway logs --service <web-service> --environment production
curl https://<your-service>.up.railway.app/healthz
curl https://<your-service>.up.railway.app/health
curl https://<your-service>.up.railway.app/readyz
```

If failing, inspect Railway build/deploy logs first.

## Troubleshooting
- `ARCANOS_PROCESS_KIND is required`: set `ARCANOS_PROCESS_KIND=web` on the API service or `ARCANOS_PROCESS_KIND=worker` on the worker service, then redeploy.
- Web service starts as the wrong role: run `railway variable list --service <service> --environment production` and verify `ARCANOS_PROCESS_KIND`.
- Worker health is green but jobs stay queued: confirm `DATABASE_URL`, `OPENAI_API_KEY`, worker logs, and `GET /worker-helper/health`.
- Local port confusion: use `PORT=3000` in `.env`; Railway probes the injected `PORT` and `/health`.
- Mock responses in production: `OPENAI_API_KEY` missing/invalid.
- Confirmation-required 403: include `x-confirmed` or trusted automation headers.
- Daemon auth errors: validate backend token/bootstrap settings.
- Health degraded for database: attach/configure PostgreSQL or accept in-memory mode.
- `MCP_BEARER_TOKEN not configured`: set `MCP_BEARER_TOKEN` before calling `POST /mcp`.
- `/brain` returns `410 Gone`: migrate the caller to `/gpt/:gptId`; set `ASK_ROUTE_MODE=compat` only as a temporary migration bridge.

## References
- `RUN_LOCAL.md`
- `RAILWAY_DEPLOYMENT.md`
- `CONFIGURATION.md`
- `API.md`
