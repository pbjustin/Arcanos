# Arcanos Railway Deployment Guide

> **Last Updated:** 2025-02-14 | **Version:** 1.0.0 | **OpenAI SDK:** v6.16.0

## Overview

This guide describes how to deploy the Arcanos backend to Railway using the repository's
`railway.json` and `Procfile` configuration. It reflects the build/start commands, health
checks, and environment defaults currently defined in the repo.

Railway deployment provides automated builds, environment management, PostgreSQL provisioning,
and health monitoring for the Arcanos AI backend service.

## Prerequisites

- Railway account with access to the target GitHub repository.
- OpenAI API key (`OPENAI_API_KEY`).
- Optional: Railway PostgreSQL service for persistence.
- Local Node.js 18+ for pre-deploy validation (recommended).

**Pre-deployment validation checklist:**
- [ ] OpenAI SDK v6.16.0 installed (`npm list openai`).
- [ ] TypeScript builds successfully (`npm run build`).
- [ ] Tests pass (`npm test`).
- [ ] Railway compatibility validated (`npm run validate:railway`).
- [ ] Environment variables prepared.

## Setup

### 1) Prepare the repository

```bash
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos
npm install
npm run build
npm test
```

Validate Railway compatibility before deploying:

```bash
npm run validate:railway
```

### 2) Create a Railway project

**Via Railway dashboard (recommended):**

1. Navigate to [railway.app](https://railway.app).
2. Create a new project.
3. Choose **Deploy from GitHub repo**.
4. Select the Arcanos repository.
5. Railway will detect `railway.json` and configure automatically.

**Via Railway CLI (alternative):**

```bash
npm install -g @railway/cli
railway login
railway init
railway link
railway up
```

## Configuration

### Build & start commands

Railway uses `railway.json` as the source of truth:

- **Build:** `npm ci --include=dev && npm run build`
- **Start:** `node --max-old-space-size=7168 dist/start-server.js`
- **Health check path:** `/health`
- **Health check timeout:** `300s`
- **Restart policy:** `ON_FAILURE` with `restartPolicyMaxRetries=10`
- **Build-time memory tuning:** `NODE_OPTIONS=--max_old_space_size=2048`

The `Procfile` mirrors the start command for compatibility.

### Environment variables

**Required:**

| Variable | Description | Example |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI API key for AI completions | `sk-...` |

**Recommended:**

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-4o` | Primary model selection (first in chain) |
| `AI_MODEL` | - | Alternative model variable (legacy support) |
| `FINETUNED_MODEL_ID` | - | Fine-tuned model override |
| `GPT5_MODEL` | `gpt-5.1` | GPT-5.1 reasoning model |
| `DATABASE_URL` | - | PostgreSQL connection string (auto-injected by Railway) |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Log file directory |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Memory cache directory |

**Railway defaults (from `railway.json`):**

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Set automatically |
| `PORT` | `$PORT` | Injected by Railway |
| `RAILWAY_ENVIRONMENT` | `production` | Set automatically |
| `RUN_WORKERS` | `false` | Workers disabled in Railway by default |
| `WORKER_API_TIMEOUT_MS` | `60000` | 60-second timeout for worker operations |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Railway default log path |

**Railway Management API (optional):**

```bash
# Enables automated deployment and rollback via GraphQL API
RAILWAY_API_TOKEN=your-railway-api-token
RAILWAY_GRAPHQL_TIMEOUT_MS=20000
```

### Environment separation

- Use Railway environments (development, production) to isolate secrets and database instances.
- Mirror critical variables between environments via Railway's **Variables** UI.
- Use Railway's **Variable References** feature to share common values.

If you attach PostgreSQL, Railway injects `DATABASE_URL` (or `PG*` variables) automatically. The backend
constructs `DATABASE_URL` from `PG*` if needed.

## Run locally

Test your configuration locally before deploying:

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY and any optional values
npm run build
npm start
```

Validate health before deploying:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

Expected health response shape (values abbreviated for clarity):

```json
{
  "status": "healthy",
  "timestamp": "2025-02-14T00:00:00.000Z",
  "services": {
    "openai": {
      "apiKey": { "configured": true, "status": "valid" },
      "client": { "initialized": true, "model": "gpt-4o" },
      "circuitBreaker": { "state": "CLOSED", "healthy": true },
      "cache": { "hits": 0, "misses": 0, "enabled": true }
    },
    "database": { "status": "connected" },
    "cache": {
      "query": { "hits": 0, "misses": 0, "size": 0 },
      "config": { "hits": 0, "misses": 0, "size": 0 }
    }
  },
  "system": {
    "uptime": 123.45,
    "memoryUsage": { "rss": 0, "heapTotal": 0, "heapUsed": 0 },
    "nodeVersion": "v18.x",
    "environment": "development"
  }
}
```

## Deploy (Railway)

### Deployment process

1. **Push changes** to your GitHub repository (main branch).
2. **Railway auto-deploys** using the `railway.json` configuration.
3. **Monitor build** in the Railway dashboard (Deployments tab).
4. **Verify health** after deployment completes.

```bash
curl https://your-app.railway.app/health
```

Railway will automatically:
- Install dependencies (`npm ci --include=dev`).
- Build TypeScript (`npm run build`).
- Start the server (`node --max-old-space-size=7168 dist/start-server.js`).
- Bind to the correct PORT.
- Monitor health via `/health` endpoint.
- Restart on failure (up to 10 times).

### Health checks

Railway health monitoring:
- **Path:** `GET /health`
- **Timeout:** 300 seconds
- **Action:** Restart on consecutive failures

Additional health endpoints for diagnostics:
- `/healthz` - Liveness probe
- `/readyz` - Readiness probe (checks dependencies)
- `/railway/healthcheck` - Railway-specific diagnostic report

### Deployment validation

After deployment:
1. Check `/health` endpoint returns 200 OK.
2. Verify logs show successful OpenAI client initialization.
3. Test a basic API call: `POST /api/ask` with a sample prompt.
4. Confirm environment variables are set correctly.

```bash
# Test deployment health
curl -f https://your-app.railway.app/health || echo "Health check failed"

# Test API functionality
curl -X POST https://your-app.railway.app/api/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, Arcanos!"}'
```

### Rollback

If deployment fails or introduces issues:

**Via Railway dashboard:**
1. Navigate to **Deployments** tab.
2. Find the last working deployment.
3. Click **Redeploy** to roll back.

**Via Railway CLI:**
```bash
railway status
railway redeploy <deployment-id>
```

## Troubleshooting

### Build fails on Railway

**Symptom:** Build fails during `npm ci` or `npm run build`.

**Solutions:**
- Ensure `package-lock.json` is committed and up to date.
- Verify `npm ci --include=dev` succeeds locally.
- Check Railway build logs for specific error messages.
- Confirm TypeScript compiles without errors (`npm run build`).

### Service fails health check

**Symptom:** Railway shows unhealthy status, restarts loop.

**Solutions:**
- Verify `OPENAI_API_KEY` is set and valid (starts with `sk-`).
- Check database connectivity if `DATABASE_URL` is configured.
- Review application logs in Railway dashboard.
- Ensure PORT binding is correct (Railway sets automatically).
- Verify health endpoint returns 200: `curl https://your-app.railway.app/health`.

### Workers starting unexpectedly

**Symptom:** Workers cause issues or errors in logs.

**Solutions:**
- Confirm `RUN_WORKERS=false` is set in Railway environment variables.
- Workers are disabled by default in `railway.json` for Railway deployments.
- Only enable workers if you need background processing.

### Database not connected

**Symptom:** Health check shows degraded database status.

**Solutions:**
- Verify Railway PostgreSQL service is attached to your project.
- Confirm `DATABASE_URL` environment variable exists.
- Check database credentials in Railway **Variables** tab.
- Service will use in-memory storage as fallback if database unavailable.

### Mock responses instead of AI

**Symptom:** API returns mock/placeholder responses.

**Solutions:**
- Verify `OPENAI_API_KEY` is set (not the placeholder from `.env.example`).
- Check API key format: must start with `sk-`.
- Review logs for API key configuration messages.
- Test key validity: `curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"`.

### Environment validation failures

**Symptom:** Startup fails with validation errors.

**Solutions:**
- Run `npm run validate:railway` locally to identify issues.
- Review validation error messages for specific missing variables.
- Ensure required variables are set in Railway dashboard.
- Check variable names match exactly (case-sensitive).

### Monitoring & logs

- Railway captures structured JSON logs in the **Logs** tab.
- Use `railway logs` for CLI streaming.
- Health endpoints for diagnostics: `/health`, `/healthz`, `/readyz`, `/railway/healthcheck`.

## References

**Configuration files:**
- `../railway.json` - Railway deployment configuration
- `../Procfile` - Process entrypoint (backup)
- `../package.json` - Build scripts and dependencies
- `../.env.example` - Environment variable template

**Related documentation:**
- `CONFIGURATION.md` - Complete environment variable reference
- `../README.md` - Main project overview and quick start
- `api/README.md` - API endpoint reference
- `../RAILWAY_COMPATIBILITY_GUIDE.md` - Implementation details

**External resources:**
- [Railway Documentation](https://docs.railway.app/)
- [Railway CLI Reference](https://docs.railway.app/develop/cli)
- [OpenAI API Documentation](https://platform.openai.com/docs)
- [OpenAI Node.js SDK](https://github.com/openai/openai-node)
