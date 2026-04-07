# Architecture

## Overview
Arcanos is split into a TypeScript backend and an optional Python daemon client. The backend is the source of truth for API, confirmation gating, and Railway deployment.

## Prerequisites
- Read `README.md` and `CODEBASE_INDEX.md` first.
- Familiarity with Express routing and OpenAI SDK usage.

## Setup
Primary backend flow:
1. `src/start-server.ts` validates env and starts server.
2. `src/server.ts` builds app, starts workers, and binds port.
3. `src/routes/register.ts` mounts all route groups.
4. `src/services/openai/*` handles OpenAI client and request flows.

## Configuration
Main config layers:
- `src/config/env.ts` (validated env access)
- `src/config/unifiedConfig.ts` (fallback and precedence logic)
- `src/config/index.ts` (runtime defaults and derived values)

## Run locally
Build and run backend:
```bash
npm run build
npm start
```

## Deploy (Railway)
Deployment control lives in:
- `railway.json`
- `Procfile`
- `docs/RAILWAY_DEPLOYMENT.md`

## Troubleshooting
- Routing ambiguity: inspect `src/routes/register.ts` mount order first.
- Unexpected model selection: inspect `src/config/unifiedConfig.ts` precedence chain.

## References
- `../src/start-server.ts`
- `../src/routes/register.ts`
- `API.md`
- `CONFIGURATION.md`

## GPT Job Architecture
Long-running GPT requests are handled through the DB-backed `job_data` queue instead of blocking the request thread until full completion.

Execution model:
1. `POST /gpt/:gptId` normalizes the request and decides whether to use the GPT job path.
2. Job-backed requests persist a canonical GPT job row with hashed idempotency metadata.
3. The route either returns `202` with `jobId` immediately or waits briefly for inline completion.
4. `src/workers/jobRunner.ts` claims `job_type='gpt'` rows and executes them in background mode.
5. `GET /jobs/:id` and `GET /jobs/:id/stream` expose the canonical job lifecycle and terminal result.

Persistence and dedupe:
- Durable dedupe metadata lives on `job_data`, not in process memory.
- Stored fields include caller-scope hash, request fingerprint hash, explicit idempotency-key hash, cancel metadata, idempotency reuse deadline, retention deadline, and expiry timestamp.
- Duplicate prevention is serialized with PostgreSQL transaction-scoped advisory locks so concurrent identical requests collapse onto one canonical job safely.

Lifecycle semantics:
- Storage statuses: `pending`, `running`, `completed`, `failed`, `cancelled`, `expired`
- API alias: `pending` is exposed as `lifecycle_status: queued`
- `cancel_requested_at` marks best-effort cancellation for running GPT jobs
- `retention_until` controls how long a completed/failed/cancelled job stays pollable
- `idempotency_until` controls how long the same request can reuse that terminal job
- `expires_at` marks when lifecycle maintenance has converted a retained row into `expired`

Operational maintenance:
- Worker inspection already recovers stale running leases
- GPT lifecycle maintenance also expires over-retained terminal jobs and compacts old expired rows
- Structured logs and metrics emit dedupe decisions, retryability, cancellation, expiry, queue wait time, execution time, and end-to-end completion time without logging prompt contents
