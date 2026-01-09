# Arcanos Configuration Guide

> **Last Updated:** 2026-01-09 | **Version:** 1.0.0

## Overview

This guide documents the environment variables used by the Arcanos backend. Defaults are
sourced from `src/utils/env.ts`, `src/config/index.ts`, and the OpenAI client helpers in
`src/services/openai/*`.

## Prerequisites

- Access to `.env.example` and the repository root README.

## Setup

1. Copy `.env.example` to `.env`.
2. Populate required variables (minimum: `OPENAI_API_KEY`).
3. Keep the final values in sync with Railway variables when deploying.

## Configuration

### Core runtime

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | – | Required for live OpenAI calls. Missing keys yield mock responses. |
| `PORT` | `8080` | Preferred HTTP port; the server falls back to the next available port. |
| `HOST` | `0.0.0.0` | Bind address for the HTTP server. |
| `SERVER_URL` | `http://127.0.0.1:<port>` | Used for internal callbacks and self-tests. |
| `NODE_ENV` | `development` | Controls logging, health checks, and worker defaults. |
| `LOG_LEVEL` | `info` | Logging verbosity for the structured logger. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Directory for logs and audit output. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem cache for memory snapshots. |

### OpenAI model selection

The OpenAI client selects the first non-empty model in this order:

1. `OPENAI_MODEL`
2. `RAILWAY_OPENAI_MODEL`
3. `FINETUNED_MODEL_ID`
4. `FINE_TUNED_MODEL_ID`
5. `AI_MODEL`
6. `gpt-4o` (fallback)

Additional model-related variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `GPT51_MODEL` / `GPT5_MODEL` | `gpt-5.2` | GPT-5.2 reasoning model (checks `GPT51_MODEL` first). |
| `RESEARCH_MODEL_ID` | – | Optional override for the research pipeline model. |
| `IMAGE_MODEL` | `gpt-image-1` | Image generation model. |
| `IMAGE_DEFAULT_SIZE` | `1024x1024` | Default image size if not supplied in requests. |

### OpenAI client behavior

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_BASE_URL` / `OPENAI_API_BASE_URL` | – | Optional API base URL override. |
| `OPENAI_SYSTEM_PROMPT` | – | Optional default system prompt for requests. |
| `OPENAI_CACHE_TTL_MS` | `300000` | Cache TTL for OpenAI responses. |
| `OPENAI_MAX_RETRIES` | `3` | Retry budget for OpenAI calls. |
| `OPENAI_IMAGE_PROMPT_TOKEN_LIMIT` | `256` | Token limit for image prompt expansion. |

### Database & persistence

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | – | PostgreSQL connection string. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | – | Used to build `DATABASE_URL` if absent. |
| `SESSION_PERSISTENCE_URL` | – | Optional override for session persistence connection. |

### Workers & automation

| Variable | Default | Notes |
| --- | --- | --- |
| `RUN_WORKERS` | `true` (disabled in tests) | Controls worker bootstrap. |
| `WORKER_COUNT` | `4` | Worker count for diagnostics and scheduling. |
| `WORKER_MODEL` | `AI_MODEL` | Model used by worker tasks. |
| `WORKER_API_TIMEOUT_MS` | `60000` | Timeout for OpenAI calls from workers. |

### Confirmation gate & security

| Variable | Default | Notes |
| --- | --- | --- |
| `TRUSTED_GPT_IDS` | – | Comma-separated GPT identifiers that bypass confirmation checks. |
| `ARCANOS_AUTOMATION_SECRET` | – | Shared secret for automation bypass. |
| `ARCANOS_AUTOMATION_HEADER` | `x-arcanos-automation` | Header name for automation bypass. |
| `CONFIRMATION_CHALLENGE_TTL_MS` | `120000` | TTL for confirmation challenges. |

### HTTP server tuning

| Variable | Default | Notes |
| --- | --- | --- |
| `JSON_LIMIT` | `10mb` | JSON payload size limit. |
| `REQUEST_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `ALLOWED_ORIGINS` | – | Comma-separated CORS allow list (non-development). |

## Run locally

1. Set `OPENAI_API_KEY` and optional variables in `.env`.
2. Run `npm run build` followed by `npm start`.
3. Validate health endpoints at `/health`, `/healthz`, and `/readyz`.

## Deploy (Railway)

Railway config is codified in `railway.json`. Key notes:

- `PORT` is injected by Railway and mirrored into the environment.
- `RUN_WORKERS` defaults to `false` in the Railway deploy config.
- If you attach PostgreSQL, Railway injects `DATABASE_URL` (or `PG*` variables) automatically.

Keep Railway variables aligned with this document and the `.env.example` template.

## Troubleshooting

- **Mock OpenAI responses**: ensure `OPENAI_API_KEY` is set and valid.
- **Database unavailable**: verify `DATABASE_URL` or `PG*` variables and watch `/health`.
- **CORS errors**: set `ALLOWED_ORIGINS` when `NODE_ENV=production`.
- **Confirmation failures**: confirm `TRUSTED_GPT_IDS` or `ARCANOS_AUTOMATION_SECRET` match the caller.

## References

- `../README.md`
- `RAILWAY_DEPLOYMENT.md`
- `../railway.json`
- `../.env.example`
