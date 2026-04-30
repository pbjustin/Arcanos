# Architecture

## Overview
Arcanos is split into a TypeScript backend and an optional Python daemon client. The backend is the source of truth for API, confirmation gating, and Railway deployment.

## Dual-Lane Routing
ARCANOS now enforces two planes before any module dispatch occurs:

- Writing plane: `POST /gpt/:gptId` for generative work only. This lane is limited to prompt generation, assistant responses, and other true write/query actions.
- Control plane: direct handlers and explicit control endpoints for system operations. This includes `GET /jobs/:id`, `GET /jobs/:id/result`, `GET /workers/status`, `GET /worker-helper/health`, `GET /status`, `GET /status/safety/self-heal`, `GET /gpt-access/diagnostics/deep`, `POST /brain` with `mode:"system_state"`, `POST /mcp`, and `GET /api/arcanos/dag/*`.

Implementation rules:
- `src/routes/gptRouter.ts` runs pre-dispatch classification through `src/routes/_core/gptPlaneClassification.ts`.
- `src/routes/_core/gptDispatch.ts` is write-plane only and rejects leaked control requests with a fail-fast `write_guard`.
- `POST /gpt/:gptId` has no public control actions; `get_status`, `get_result`, `diagnostics`, `system_state`, runtime inspection, worker status, queue inspection, self-heal status, and MCP calls are rejected before write dispatch.
- Canonical durable write actions are `query` and non-core `query_and_wait`. Core `query_and_wait` is synchronous direct action. Canonical async reads use `GET /jobs/:id` and `GET /jobs/:id/result`.
- Prompt-shaped control requests for job lookup, DAG execution/tracing, runtime inspection, or MCP tool calls are rejected with canonical control endpoints.

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
1. `POST /gpt/:gptId` classifies the request as writing-plane or control-plane before dispatch.
2. Control-plane reads use direct endpoints (`GET /jobs/:id`, `GET /jobs/:id/result`, `GET /gpt-access/diagnostics/deep`, `POST /brain` with `mode:"system_state"`) and never create GPT jobs.
3. Writing-plane durable requests (`query`, non-core `query_and_wait`, or prompt-first async compatibility mode) persist a canonical GPT job row with hashed idempotency metadata.
4. `query` returns the canonical `jobId` without inline waiting. On core GPT IDs, `query_and_wait` uses the lightweight synchronous direct action lane and returns the final result inline.
5. `src/workers/jobRunner.ts` claims `job_type='gpt'` rows and executes them in background mode.
6. `GET /jobs/:id` and `GET /jobs/:id/stream` expose the canonical job lifecycle and terminal result.

Agent-safe retrieval rules:
- Retrieval must remain structured-only through direct `/jobs/*` endpoints.
- Natural-language job retrieval through `prompt` text remains blocked on `/gpt/:gptId`.
- MCP follows the same lane split: writing tools create work, while `jobs.status` and `jobs.result` stay on the control plane.

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

## Railway Topology
Production remains split into dedicated Railway services:

- Web service: request ingress, direct control endpoints, write-plane classification, and MCP HTTP transport.
- Worker service: queued GPT execution and background job processing.

Environment separation must remain explicit:
- Web processes use `ARCANOS_PROCESS_KIND=web`, and the launcher sets `RUN_WORKERS=false`.
- Worker processes use `ARCANOS_PROCESS_KIND=worker`.
- Logging must make the selected plane visible (`gpt.request.classified`, `gpt.write.entry`, `gpt.dispatch.write_guard_rejected`).
