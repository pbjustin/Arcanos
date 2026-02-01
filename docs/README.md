# Arcanos Documentation Index

## Overview

This index maps the current documentation set for the Arcanos backend. Use it to locate
authoritative references for configuration, API surface area, and Railway deployment.

## Prerequisites

- Familiarity with the repository root README and the `docs/` structure.
- Access to `.env.example` for configuration reference.

## Setup

Start with these documents in order:

1. `../README.md` – primary overview and quick start.
2. `CONFIGURATION.md` – environment variables and defaults.
3. `api/README.md` – API reference and confirmation requirements.
4. `RAILWAY_DEPLOYMENT.md` – Railway deployment runbook.

## Configuration

Configuration details live in `CONFIGURATION.md` and the `.env.example` template at the
repository root. Keep environment variables aligned with current runtime defaults and
Railway variables.

Every documentation file in this repo should follow the standard structure:
Overview → Prerequisites → Setup → Configuration → Run locally → Deploy (Railway) →
Troubleshooting → References.

## Run locally

Local run instructions are documented in `../README.md` and validated by the scripts in
`package.json` (`npm run build`, `npm start`, `npm test`).

## Deploy (Railway)

Railway deployment instructions and platform specifics:

- `RAILWAY_DEPLOYMENT.md` – step-by-step deployment guide.
- `../railway.json` – build/start/healthcheck configuration.
- `../Procfile` – process entrypoint used by Railway when configured.

## Troubleshooting

If a document is missing, outdated, or contradictory, log the gap in
`DOCUMENTATION_STATUS.md` and add a TODO in the relevant doc until it is resolved.

## References

**Core references**
- `arcanos-overview.md`
- `backend.md`
- `AFOL_OVERVIEW.md`

**SDK usage**
- `../README.md` (Node + Python OpenAI SDK examples)

**Deployment**
- `RAILWAY_DEPLOYMENT.md`
- `deployment/DEPLOYMENT.md`
- `../RAILWAY_COMPATIBILITY_GUIDE.md`

**API**
- `api/README.md`
- `api/API_REFERENCE.md`
- `ORCHESTRATION_API.md`

**AI modules & memory**
- `ai-guides/README.md`
- `BACKEND_SYNC_IMPLEMENTATION.md`
- `pinned-memory-guide.md`
