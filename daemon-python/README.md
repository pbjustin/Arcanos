# Arcanos Python CLI

## Overview
The daemon CLI is an optional companion client for local chat, voice, vision, terminal execution, and optional backend routing.

OpenAI runtime architecture is centralized:
- Canonical client singleton constructor: `arcanos/openai/unified_client.py`
- Adapter-first runtime methods: `arcanos/openai/openai_adapter.py`
- Runtime env access boundary: `arcanos/env.py`

## Prerequisites
- Python 3.10+
- OpenAI API key (live mode)
- Optional backend URL/token if using backend or hybrid routing

## Setup
From repository root:
```bash
cd daemon-python
python -m venv venv
# Windows PowerShell
.\venv\Scripts\Activate.ps1
python -m pip install -e .
cp .env.example .env
```

## Configuration
Minimum:
```env
OPENAI_API_KEY=your-openai-api-key-here
```

Optional backend routing:
```env
BACKEND_URL=http://localhost:3000
BACKEND_ROUTING_MODE=hybrid
```

Optional debug server hardening:
```env
DEBUG_SERVER_ENABLED=true
DEBUG_SERVER_TOKEN=<strong-random-token>
```

## Run locally
```bash
arcanos
# or
python -m arcanos.cli
```

## Validation
CI-safe/offline validation:
```bash
python validate_backend_cli_offline.py
```

Targeted tests:
```bash
pytest tests/test_openai_adapter.py -q
pytest tests/test_openai_unified_client.py -q
pytest tests/test_telemetry_sanitization.py -q
pytest tests/test_debug_server.py -q
```

## Deploy (Railway)
The daemon itself is local/client software. Deploy only the backend to Railway using `../docs/RAILWAY_DEPLOYMENT.md`.

## Troubleshooting
- Immediate exit with config error: ensure `OPENAI_API_KEY` is set.
- Backend route failures: verify `BACKEND_URL` and backend health.
- Debug server auth errors: verify `DEBUG_SERVER_TOKEN` and request headers.
- Unexpected mock-style responses: confirm `OPENAI_API_KEY` is present and not placeholder/blank.

## References
- `../README.md`
- `../docs/RUN_LOCAL.md`
- `../docs/API.md`
- `DEBUG_SERVER_README.md`
- `../OPENAI_ADAPTER_MIGRATION.md`
