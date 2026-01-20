# Arcanos Deployment Guide (Railway Quick Reference)

> **Last Updated:** 2025-02-14 | **Version:** 1.0.0

## Overview

This is a quick reference for deploying Arcanos to Railway. For the complete Railway
walkthrough, environment variables, health checks, and rollback guidance, see
[`docs/RAILWAY_DEPLOYMENT.md`](docs/RAILWAY_DEPLOYMENT.md).

## Prerequisites

- Railway account.
- OpenAI API key (`OPENAI_API_KEY`).
- Node.js 18+ for local validation (recommended).
- Repository access and a clean `npm install`/`npm run build` on your machine.

## Setup

Optional: install the Railway CLI if you prefer CLI-driven deployments.

```bash
npm install -g @railway/cli
railway login
```

## Configuration

**Required environment variables:**

| Variable | Description |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API key for AI completions |

**Railway build/start commands:**

- Build: `npm ci --include=dev && npm run build`
- Start: `node --max-old-space-size=7168 dist/start-server.js`
- Health check: `GET /health`

For the full variable matrix, see [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

## Run locally

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY
npm run build
npm start
```

Verify health:

```bash
curl http://localhost:8080/health
```

## Deploy (Railway)

```bash
railway init
railway link
railway variables set OPENAI_API_KEY=sk-your-key-here
railway up
```

Verify the deployment:

```bash
curl https://your-app.railway.app/health
```

## Troubleshooting

- **Build failures:** confirm `npm ci --include=dev` and `npm run build` succeed locally.
- **Health check failures:** ensure `OPENAI_API_KEY` is set and `/health` returns 200.
- **Database issues:** attach PostgreSQL in Railway if you expect persistence.

## References

- [Railway Deployment Guide](docs/RAILWAY_DEPLOYMENT.md)
- [Configuration Guide](docs/CONFIGURATION.md)
- [API Reference](docs/api/README.md)
- [Railway Compatibility Guide](RAILWAY_COMPATIBILITY_GUIDE.md)
