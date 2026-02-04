# Codebase Index

## Overview
This index maps active runtime entry points and high-value directories for contributors and operators.

## Prerequisites
- Repository checked out locally.
- Familiarity with TypeScript and optional Python daemon components.

## Setup
Use this file with:
- `README.md` for startup and deployment
- `docs/ARCHITECTURE.md` for component boundaries
- `docs/API.md` for endpoint inventory

## Configuration
Primary runtime/config files:
- `src/config/index.ts`
- `src/config/unifiedConfig.ts`
- `src/config/env.ts`
- `.env.example`
- `railway.json`

## Run locally
Key executable entry points:
- Backend startup: `src/start-server.ts`
- Route registry: `src/routes/register.ts`
- Python daemon entry: `daemon-python/arcanos/cli.py`

## Deploy (Railway)
Deployment sources of truth:
- `railway.json`
- `Procfile`
- `docs/RAILWAY_DEPLOYMENT.md`

## Troubleshooting
If a path in this index becomes stale, update this file in the same PR as the moved/renamed code.

## References
- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/CI_CD.md`
