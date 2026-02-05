# Contributing to Arcanos

## Overview
This guide covers the current contribution workflow for the TypeScript backend and optional Python daemon.

## Prerequisites
- Git
- Node.js 18+, npm 8+
- Optional: Python 3.10+ for daemon changes

## Setup
```bash
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos
npm install
cp .env.example .env
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
- Backend contributors should set `PORT` and `OPENAI_API_KEY` in root `.env`.
- Daemon contributors should set `OPENAI_API_KEY` in `daemon-python/.env`.
- Keep secrets out of git; use `.env.example` placeholders only.

## Run locally
Backend quality checks:
```bash
npm run type-check
npm run lint
npm test
npm run build
```

Daemon debug tests (from `daemon-python/` with venv active):
```bash
pytest tests/test_debug_server.py -q
```

## Deploy (Railway)
Contributors should validate Railway readiness before merge:
```bash
npm run validate:railway
```

Production deploy process is documented in `docs/RAILWAY_DEPLOYMENT.md`.

## Troubleshooting
- Missing npm script errors: run `npm run` and align commands with `package.json`.
- Failing daemon tests: ensure daemon dependencies installed in active venv.
- Route/documentation drift: update `docs/API.md` in the same PR.

## References
- Code of conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
- Docs standards: `docs/README.md`
- PR templates: `.github/PULL_REQUEST_TEMPLATE.md`
