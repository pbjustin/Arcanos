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
npm ci
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
- Build: `npm ci --include=dev && npm run build`
- Start: `node --max-old-space-size=7168 dist/start-server.js`
- Health check path: `/health`
- Health check timeout: `300`
- Restart policy: `ON_FAILURE` (`restartPolicyMaxRetries=10`)

Environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Required for live AI behavior. |
| `PORT` | Railway-managed | Automatically injected. |
| `NODE_ENV` | Railway-managed | Set to `production` by config. |
| `RUN_WORKERS` | Recommended `false` | Defaults to `false` in deploy config. |
| `DATABASE_URL` | Optional | Attach Railway PostgreSQL for persistence. |
| `ARC_LOG_PATH` | Optional | Defaults to `/tmp/arc/log`. |

Environment separation:
- `railway.json` defines `production` and `development` variable blocks.
- Keep secrets per environment in Railway Variables.

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

Rollback:
1. Open Railway Deployments tab.
2. Select last known-good deployment.
3. Redeploy that version.

## Troubleshooting
- Build fails: run `npm ci --include=dev && npm run build` locally first.
- Repeated restarts: inspect `/health` output and Railway logs.
- App boots without AI output: validate `OPENAI_API_KEY` is present and valid.
- Persistence degraded: attach PostgreSQL or set valid `DATABASE_URL`.

## References
- `../railway.json`
- `../Procfile`
- `CONFIGURATION.md`
- `CI_CD.md`
- Railway docs: https://docs.railway.app/
