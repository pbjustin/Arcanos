# Configuration Guide

## Overview
This document captures active backend and daemon configuration used by current code. Defaults and precedence are derived from `src/config/unifiedConfig.ts`, `src/config/env.ts`, and daemon config modules.

## Prerequisites
- Copy `.env.example` to `.env` for backend.
- Copy `daemon-python/.env.example` to `daemon-python/.env` for daemon usage.

## Setup
Backend:
```bash
cp .env.example .env
```

Daemon:
```bash
cd daemon-python
cp .env.example .env
```

## Configuration
### Backend required and core variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | Yes | none | Required by `validateRequiredEnv()` at startup. |
| `NODE_ENV` | No | `development` | Affects host binding and runtime behavior. |
| `OPENAI_API_KEY` | No* | none | Needed for live AI responses. |
| `OPENAI_BASE_URL` | No | none | Optional OpenAI endpoint override. |
| `OPENAI_MODEL` | No | fallback chain | Participates in default model resolution chain. |
| `DATABASE_URL` | No | none | Enables PostgreSQL persistence. |
| `RUN_WORKERS` | No | `true` (non-test) | Background workers toggle. |
| `WORKER_API_TIMEOUT_MS` | No | `30000` | Unified config default; some worker adapters fallback to `60000` if unset. |
| `ARC_LOG_PATH` | No | `/tmp/arc/log` | Runtime log path. |
| `ARC_MEMORY_PATH` | No | `/tmp/arc/memory` | Runtime memory path. |
| `RAILWAY_ENVIRONMENT` | No | none | Set by Railway and used for environment detection. |
| `RAILWAY_API_TOKEN` | No | none | Only required for Railway management/API tooling, not normal app runtime. |

<<<<<<< HEAD
| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Controls logging and worker defaults. |
| `PORT` | `8080` | HTTP port (Railway overrides with `PORT`). |
| `HOST` | `127.0.0.1` (dev) / `0.0.0.0` (prod) | Bind address for the HTTP server. In development, defaults to localhost for security. Set to `0.0.0.0` to allow network access (e.g., Docker, WSL2, testing from other devices). |
| `SERVER_URL` | `http://127.0.0.1:<port>` | Base URL used for internal callbacks. |
| `BACKEND_STATUS_ENDPOINT` | `/status` | Status endpoint path for internal checks. |
| `LOG_LEVEL` | `info` | Logging verbosity for the structured logger. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Directory for logs and audit output. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem cache for memory snapshots. |
| `JSON_LIMIT` | `10mb` | JSON payload size limit. |
| `REQUEST_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS allow list (non-development). |

### OpenAI API key resolution

The OpenAI client resolves keys in this order, skipping placeholders:
=======
*Without an API key, AI routes return mock responses by design.
>>>>>>> 7e6de62257e7864cbfdc09916f7ac7bf0063cf21

### OpenAI key resolution order
1. `OPENAI_API_KEY`
2. `RAILWAY_OPENAI_API_KEY`
3. `API_KEY`
4. `OPENAI_KEY`

### Default model resolution order
1. `FINETUNED_MODEL_ID`
2. `FINE_TUNED_MODEL_ID`
3. `AI_MODEL`
4. `OPENAI_MODEL`
5. `RAILWAY_OPENAI_MODEL`
6. `gpt-4o-mini`

### Fallback model resolution order
1. `FALLBACK_MODEL`
2. `AI_FALLBACK_MODEL`
3. `RAILWAY_OPENAI_FALLBACK_MODEL`
4. `gpt-4`

### Confirmation and automation
| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_GPT_IDS` | empty | Trusted GPT IDs that can bypass manual confirmation. |
| `ARCANOS_AUTOMATION_SECRET` | empty | Shared secret for automation bypass. |
| `ARCANOS_AUTOMATION_HEADER` | `x-arcanos-automation` | Header carrying automation secret. |

### Daemon-specific core variables
| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Required by daemon local GPT client. |
| `BACKEND_URL` | none | Optional backend routing target. |
| `BACKEND_ROUTING_MODE` | `hybrid` | `local`, `backend`, or `hybrid`. |
| `DEBUG_SERVER_TOKEN` | none | Strongly recommended when debug server enabled. |
| `IDE_AGENT_DEBUG` / `DEBUG_SERVER_ENABLED` | `false` | Enables local debug server. |

## Run locally
Backend config validation is implicit at startup. Use:
```bash
npm run build
npm start
```

Daemon config validation occurs on daemon startup:
```bash
cd daemon-python
arcanos
```

## Deploy (Railway)
- Keep required runtime values in Railway Variables.
- Keep production and development variables separated.
- Railway injects `PORT` and optionally `DATABASE_URL` when PostgreSQL is attached.

## Troubleshooting
- Startup exits immediately: `PORT` missing or invalid.
- Unexpected model in use: verify model precedence chain and remove conflicting variables.
- Confirmation bypass not working: verify header name and secret match exactly.

## References
- `../.env.example`
- `../config/env/core.env.example`
- `../src/config/unifiedConfig.ts`
- `../src/config/env.ts`
- `../daemon-python/.env.example`
