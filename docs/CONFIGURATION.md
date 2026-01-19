# Arcanos Configuration Guide

> **Last Updated:** 2026-01-14 | **Version:** 1.0.0

## Overview

This guide documents the environment variables used by the Arcanos backend. Defaults are
sourced from `src/utils/env.ts`, `src/config/index.ts`, `src/services/openai/*`, and
`src/config/workerConfig.ts`.

## Prerequisites

- Access to `.env.example` and the repository root README.

## Setup

1. Copy `.env.example` to `.env`.
2. Populate required variables (minimum: `OPENAI_API_KEY`).
3. Keep final values aligned with Railway variables when deploying.

## Configuration

### Core runtime

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Controls logging, health checks, and worker defaults. |
| `PORT` | `8080` | Preferred HTTP port. |
| `HOST` | `0.0.0.0` | Bind address for the HTTP server. |
| `SERVER_URL` | `http://127.0.0.1:<port>` | Used for internal callbacks and self-tests. |
| `BACKEND_STATUS_ENDPOINT` | `/status` | Status endpoint path used by internal checks. |
| `LOG_LEVEL` | `info` | Logging verbosity for the structured logger. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Directory for logs and audit output. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem cache for memory snapshots. |
| `JSON_LIMIT` | `10mb` | JSON payload size limit. |
| `REQUEST_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `ALLOWED_ORIGINS` | – | Comma-separated CORS allow list (non-development). |

### OpenAI API key resolution

The OpenAI client resolves keys in this order, skipping placeholders:

1. `OPENAI_API_KEY`
2. `RAILWAY_OPENAI_API_KEY`
3. `API_KEY`
4. `OPENAI_KEY`

### OpenAI model selection

The OpenAI client selects the first non-empty model in this order:

1. `OPENAI_MODEL`
2. `RAILWAY_OPENAI_MODEL`
3. `FINETUNED_MODEL_ID`
4. `FINE_TUNED_MODEL_ID`
5. `AI_MODEL`
6. `gpt-4o` (fallback)

Fallback model selection (used when primary calls fail):

1. `FALLBACK_MODEL`
2. `AI_FALLBACK_MODEL`
3. `RAILWAY_OPENAI_FALLBACK_MODEL`
4. `FINETUNED_MODEL_ID`
5. `FINE_TUNED_MODEL_ID`
6. `AI_MODEL`
7. `gpt-4` (fallback)

Additional model-related variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `GPT51_MODEL` / `GPT5_MODEL` | `gpt-5.1` | GPT-5.1 reasoning model override (checks `GPT51_MODEL` first). |
| `RESEARCH_MODEL_ID` | – | Optional override for the research pipeline model. |
| `IMAGE_MODEL` | `gpt-image-1` | Image generation model. |
| `IMAGE_DEFAULT_SIZE` | `1024x1024` | Default image size if not supplied in requests. |
| `ROUTING_MAX_TOKENS` | `4096` | Token ceiling for routing decisions. |

### OpenAI client behavior

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_BASE_URL` / `OPENAI_API_BASE_URL` / `OPENAI_API_BASE` | – | Optional API base URL override. |
| `OPENAI_SYSTEM_PROMPT` | `You are a helpful AI assistant.` | Default system prompt if none supplied. |
| `OPENAI_CACHE_TTL_MS` | `300000` | Cache TTL for OpenAI responses (5 minutes). |
| `OPENAI_MAX_RETRIES` | `3` | Retry budget for OpenAI calls. |
| `OPENAI_IMAGE_PROMPT_TOKEN_LIMIT` | `256` | Token limit for image prompt expansion. |
| `OPENAI_DEFAULT_MAX_TOKENS` | `256` | Default max tokens for responses when not specified. |
| `OPENAI_DEFAULT_TEMPERATURE` | `0.7` | Default temperature for responses. |
| `OPENAI_DEFAULT_TOP_P` | `1` | Default nucleus sampling value. |
| `OPENAI_DEFAULT_FREQUENCY_PENALTY` | `0` | Default frequency penalty. |
| `OPENAI_DEFAULT_PRESENCE_PENALTY` | `0` | Default presence penalty. |

### Database & persistence

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | – | PostgreSQL connection string. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | – | Used to build `DATABASE_URL` if absent. |
| `SESSION_PERSISTENCE_URL` | – | Optional override for session persistence connection. |
| `BACKEND_REGISTRY_URL` | – | Optional registry endpoint for backend discovery. |

### Workers & automation

| Variable | Default | Notes |
| --- | --- | --- |
| `RUN_WORKERS` | `true` (disabled in tests) | Controls worker bootstrap. |
| `WORKER_COUNT` | `4` | Worker count for diagnostics and scheduling. |
| `WORKER_MODEL` | `AI_MODEL` or `gpt-4o` | Model used by worker tasks. |
| `WORKER_API_TIMEOUT_MS` | `60000` | Timeout for OpenAI calls from workers. |

### Confirmation gate & security

| Variable | Default | Notes |
| --- | --- | --- |
| `TRUSTED_GPT_IDS` | – | Comma-separated GPT identifiers that bypass confirmation checks. |
| `ARCANOS_AUTOMATION_SECRET` | – | Shared secret for automation bypass. |
| `ARCANOS_AUTOMATION_HEADER` | `x-arcanos-automation` | Header name for automation bypass. |
| `ADMIN_KEY` | – | Admin API key for protected routes. |
| `REGISTER_KEY` | – | Registration key for protected routes. |
| `CONFIRMATION_CHALLENGE_TTL_MS` | `120000` | TTL for confirmation challenges. |

### Feature flags, telemetry, and audit

| Variable | Default | Notes |
| --- | --- | --- |
| `ENABLE_GITHUB_ACTIONS` | `false` | Enables GitHub actions-related workflows. |
| `ENABLE_GPT_USER_HANDLER` | `true` | Enables GPT user handler endpoints. |
| `ARCANOS_AUDIT_TRACE` | `true` | Enables audit tracing when not set to `false`. |
| `TELEMETRY_RECENT_LOGS_LIMIT` | `100` | Recent log ring buffer size. |
| `TELEMETRY_TRACE_EVENT_LIMIT` | `200` | Trace event buffer size. |

### Assistant sync & reinforcement

| Variable | Default | Notes |
| --- | --- | --- |
| `ASSISTANT_SYNC_ENABLED` | `true` | Enables assistant sync when not set to `false`. |
| `ASSISTANT_SYNC_CRON` | `15,45 * * * *` | Cron schedule for assistant sync. |
| `ASSISTANT_REGISTRY_PATH` | `config/assistants.json` | Path to the assistant registry file. |
| `ARCANOS_CONTEXT_MODE` | `reinforcement` | Context mode for memory reinforcement. |
| `ARCANOS_CONTEXT_WINDOW` | `50` | Reinforcement context window size. |
| `ARCANOS_MEMORY_DIGEST_SIZE` | `8` | Memory digest size for reinforcement. |
| `ARCANOS_CLEAR_MIN_SCORE` | `0.85` | Minimum score threshold for clear operations. |
| `FALLBACK_STRICT_ENVIRONMENTS` | `production,staging` | CSV list for strict fallback handling. |
| `ENABLE_PREEMPTIVE_FALLBACK` | `false` | Enables preemptive fallback when `true`. |

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
