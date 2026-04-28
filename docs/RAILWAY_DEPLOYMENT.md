# Railway Deployment Guide

## Overview
This runbook documents the active Railway deployment workflow for Arcanos using `railway.json` and `Procfile`.

## Prerequisites
- Railway account and project access.
- Repository connected to Railway.
- Required secrets available (`OPENAI_API_KEY`; optionally `DATABASE_URL` if external DB).

## Setup
Pre-deploy checks:
```bash
npm ci --include=dev --no-audit --no-fund
npm run build
npm test
npm run validate:railway
```

Railway project setup:
1. Create/select a Railway project.
2. Connect this GitHub repository.
3. Confirm Railway detected `railway.json`.

## Configuration
Active Railway config (source: `railway.json`):
- Build: `npm ci --include=dev --no-audit --no-fund && npm run build`
- Start: `node scripts/start-railway-service.mjs`
- Deploy health check path: `/health`
- Health check timeout: `300`
- Restart policy: `ON_FAILURE` (`restartPolicyMaxRetries=10`)

Launcher behavior:
- `scripts/start-railway-service.mjs` is the only supported Railway start command.
- Web services start the compiled API runtime with `ARCANOS_PROCESS_KIND=web` and `RUN_WORKERS=false`.
- Worker services expose a minimal health server and then start `dist/workers/jobRunner.js` with `ARCANOS_PROCESS_KIND=worker` and `RUN_WORKERS=true`.
- The application keeps `/health`, `/healthz`, and `/readyz` available; Railway should probe `/health`.

Environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Required for live AI behavior. |
| `PORT` | Railway-managed | Automatically injected. |
| `NODE_ENV` | Railway-managed | Set to `production` by config. |
| `ARCANOS_PROCESS_KIND` | Yes | `web` for the API service, `worker` for the async worker service. The launcher exits if missing or invalid. |
| `RUN_WORKERS` | Launcher-managed | Set by `scripts/start-railway-service.mjs` from `ARCANOS_PROCESS_KIND`. |
| `DATABASE_URL` | Optional | Attach Railway PostgreSQL for persistence. |
| `ARC_LOG_PATH` | Optional | Defaults to `/tmp/arc/log`. |
| `GPT_FAST_PATH_ENABLED` | Optional | Defaults to `true`; disables inline prompt-generation fast path when set to `false`. |
| `GPT_FAST_PATH_MODEL` | Optional | Defaults to `gpt-4.1-mini`; use a low-latency model for inline fast-path requests. |
| `GPT_FAST_PATH_TIMEOUT_MS` | Optional | Defaults to `8000`; inline model timeout for fast-path requests. |
| `GPT_FAST_PATH_GPT_ALLOWLIST` | Optional | Comma-separated GPT IDs allowed to use fast path; empty means all GPT IDs. |

Environment separation:
- `railway.json` defines `production` and `development` variable blocks.
- Keep secrets per environment in Railway Variables.
- Configure separate Railway services for web and worker when async GPT jobs must complete in the background.
- Confirm each service role with `railway variable list --service <service> --environment production` before release.

## Run locally
Mirror Railway locally before deploy:
```bash
cp .env.example .env
# set PORT and OPENAI_API_KEY
npm run build
npm start
curl http://localhost:3000/health
```

## Deploy (Railway)
1. Push to the tracked branch.
2. Watch deployment logs in Railway.
3. Confirm health endpoint:
```bash
curl https://<your-service>.up.railway.app/health
```

Railway CLI workflow:
```bash
railway login
railway link
railway status
railway env production
railway variable list --service <web-service> --environment production
railway variable set ARCANOS_PROCESS_KIND=web --service <web-service> --environment production
railway variable set ARCANOS_PROCESS_KIND=worker --service <worker-service> --environment production
railway variable set GPT_FAST_PATH_ENABLED=true --service <web-service> --environment production
railway variable set GPT_FAST_PATH_MODEL=gpt-4.1-mini --service <web-service> --environment production
railway run --service <web-service> --environment production npm run dev
railway up --service <web-service> --environment production
railway logs --service <web-service> --environment production
```

Railway CLI 4.x supports `railway env` for environment linking, `railway run` for local commands with Railway variables, `railway up` for local-code deployments, `--service` / `--environment` targeting, `railway logs` for deployment/runtime logs, and `railway variable` for environment variables (`variables`, `vars`, and `var` are aliases). See the official Railway references:
- https://docs.railway.com/cli
- https://docs.railway.com/cli/deploying
- https://docs.railway.com/cli/up
- https://docs.railway.com/cli/variable

Post-deploy fast-path smoke test:
```bash
railway run --service <web-service> --environment production npm run railway:probe:fast-path
npm run railway:probe:fast-path -- --base-url https://<your-service>.up.railway.app --gpt-id arcanos-core
npm run railway:probe:async -- --base-url https://<your-service>.up.railway.app --gpt-id arcanos-core
```

Rollback:
1. Open Railway Deployments tab.
2. Select last known-good deployment.
3. Redeploy that version.

## Troubleshooting
- Build fails: run `npm ci --include=dev --no-audit --no-fund && npm run build` locally first.
- Launcher fails with `ARCANOS_PROCESS_KIND is required`: set `ARCANOS_PROCESS_KIND=web` on the API service or `ARCANOS_PROCESS_KIND=worker` on the worker service.
- Repeated restarts: inspect `/health`, `/healthz`, and `/readyz` along with Railway logs.
- App boots without AI output: validate `OPENAI_API_KEY` is present and valid.
- Persistence degraded: attach PostgreSQL or set valid `DATABASE_URL`.
- Async jobs stay queued: verify the worker service is deployed, has `ARCANOS_PROCESS_KIND=worker`, can reach `DATABASE_URL`, and has `OPENAI_API_KEY`.

## References
- `../railway.json`
- `../Procfile`
- `CONFIGURATION.md`
- `CI_CD.md`
- `RAILWAY_RATIONALE.md`
- Railway docs: https://docs.railway.com/
