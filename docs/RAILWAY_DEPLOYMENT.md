# Arcanos Railway Deployment Guide

> **Last Updated:** 2026-01-10 | **Version:** 1.0.0 | **OpenAI SDK:** v6.16.0

## Overview

This guide describes how to deploy the Arcanos backend to Railway using the repository’s
`railway.json` and `Procfile` configuration. It reflects the current build/start commands
and health checks defined in the repo.

## Prerequisites

- Railway account with access to the target GitHub repository.
- OpenAI API key (`OPENAI_API_KEY`).
- Optional: Railway PostgreSQL service for persistence.
- Local Node.js 18+ for pre-deploy validation (optional but recommended).

## Setup

### 1) Prepare the repository

```bash
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos
npm install
npm run build
```

### 2) Create a Railway project

**Via Railway dashboard (recommended):**

1. Create a new Railway project.
2. Choose **Deploy from GitHub repo**.
3. Select the Arcanos repository and deploy.

**Via Railway CLI (optional):**

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

The `Procfile` mirrors the start command for compatibility.

### Environment variables

**Required:**

- `OPENAI_API_KEY`

**Recommended:**

- `OPENAI_MODEL`, `FINETUNED_MODEL_ID`, or `AI_MODEL` (model selection)
- `GPT51_MODEL` / `GPT5_MODEL` (reasoning model override)
- `DATABASE_URL` (if not auto-provisioned)
- `ARC_LOG_PATH` / `ARC_MEMORY_PATH` (filesystem paths)

**Railway defaults (from `railway.json`):**

- `NODE_ENV=production`
- `RUN_WORKERS=false`
- `WORKER_API_TIMEOUT_MS=60000`
- `PORT=$PORT` (injected by Railway)

If you attach PostgreSQL, Railway injects `DATABASE_URL` (or `PG*` values). The backend
constructs `DATABASE_URL` from `PG*` if needed.

### Environment separation

- Use Railway environments (development, production) to isolate secrets and database
  instances.
- Mirror critical variables between environments via Railway’s **Variables** UI.

## Run locally

```bash
cp .env.example .env
# Set OPENAI_API_KEY and any optional values
npm run build
npm start
```

Validate health before deploying:

```bash
curl http://localhost:8080/health
```

## Deploy (Railway)

1. Push changes to your GitHub repo.
2. Railway triggers a build using `railway.json`.
3. Confirm `/health` passes after deploy.
4. (Optional) Run `npm run validate:railway` locally to pre-check Railway readiness.

### Rollback

- Use the Railway dashboard **Deployments** view to redeploy a previous deployment.
- TODO: Confirm whether the Railway CLI exposes a stable rollback command for this repo.

## Troubleshooting

- **Build fails on Railway**: ensure `npm ci --include=dev` succeeds locally and
  `package-lock.json` is committed.
- **Service fails health check**: verify `OPENAI_API_KEY` and database connectivity.
- **Workers starting unexpectedly**: ensure `RUN_WORKERS=false` is set in Railway variables.
- **Database not connected**: confirm Railway PostgreSQL is attached and `DATABASE_URL` exists.

## References

- `../railway.json`
- `../Procfile`
- `CONFIGURATION.md`
- `../README.md`
