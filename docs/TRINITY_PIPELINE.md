# Trinity Pipeline

## Overview
The Trinity pipeline is the main AI writing path in this codebase. It accepts prompt-shaped writing work, rejects control-plane leakage, runs the multi-stage ARCANOS reasoning flow, and returns a structured `TrinityResult`.

Current entrypoints:
- Protected GPT Action gateway: `POST /gpt-access/jobs/create` in `src/routes/gpt-access.ts`
- Canonical writing plane: `POST /gpt/:gptId` in `src/routes/gptRouter.ts`
- Shared writing facade: `src/core/logic/trinityWritingPipeline.ts` (`runTrinityWritingPipeline`)
- Low-level engine: `src/core/logic/trinity.ts` (`runThroughBrain`)

Use `/gpt-access/*` for protected backend calls from Custom GPTs and operator integrations. Do not route job result lookup, worker status, queue inspection, MCP diagnostics, or runtime inspection through `/gpt/:gptId`.

## Final Execution Flow
Protected async Trinity execution follows this path:

1. A protected caller sends `POST /gpt-access/jobs/create` with bearer auth.
   - Required scope: `jobs.create`.
   - Request body fields: `gptId`, `task`, optional `input`, optional `context`, optional `maxOutputTokens`, optional `idempotencyKey`.
   - The gateway rejects unsafe fields such as token, auth, SQL, command, shell, proxy, endpoint, and raw secret-like keys.

2. `createGptAccessAiJob` validates and normalizes the request.
   - It resolves the `gptId` through the GPT module registry.
   - It builds an async GPT body with `action: "query"`, `prompt: task`, `executionMode: "async"`, and a sanitized payload.
   - It stores a `gpt` job with `findOrCreateGptJob`.
   - It returns `202` with `jobId`, `traceId`, `status`, and `resultEndpoint: "/gpt-access/jobs/result"`.

3. The worker process claims the durable job from the database.
   - Entry command: `npm run start:worker` locally, or `ARCANOS_PROCESS_KIND=worker` through the Railway launcher.
   - Worker code: `src/workers/jobRunner.ts`.
   - The worker calls `routeGptRequest(...)` in-process. It does not make an HTTP request back through `/gpt/:gptId`.

4. The GPT dispatcher resolves the module and action.
   - Registry source: `src/platform/runtime/gptRouterConfig.ts`.
   - Core GPT IDs: `arcanos-core`, `core`, and `arcanos-daemon`.
   - Core module: `src/services/arcanos-core.ts` (`ARCANOS:CORE`, default action `query`).

5. `ARCANOS:CORE` invokes the Trinity writing facade.
   - `runArcanosCoreQuery(...)` normalizes prompt/session options, applies route and pipeline timeouts, and calls `runTrinityWritingPipeline(...)`.
   - Background jobs use the background timeout profile and pass `__arcanosExecutionMode: "background"` internally.
   - If the primary pipeline times out, the core module may try a bounded degraded direct-answer path and then a static timeout fallback. Those fallbacks are marked in the returned `TrinityResult`.

6. `runTrinityWritingPipeline(...)` enforces the writing-plane boundary.
   - It classifies input with `classifyWritingPlaneInput(...)`.
   - Non-writing/control requests throw `TrinityControlLeakError` before the low-level engine runs.
   - Valid writing requests are logged with `sourceEndpoint` and passed to `runThroughBrain(...)`.

7. `runThroughBrain(...)` runs the Trinity stages.
   - Pre-flight: request ID, tier detection, audit-safe config, memory context, guardrails, and runtime budget.
   - Stage 1: ARCANOS intake.
   - Stage 2: GPT reasoning.
   - Stage 2.5: critical-tier reflection when applicable.
   - Stage 3: ARCANOS final synthesis.
   - Post-processing: mid-layer cleanup, audit-safe validation, memory pattern storage, lineage logging, token accounting, and telemetry.

8. The worker stores the terminal job output.
   - Protected callers read it with `POST /gpt-access/jobs/result`.
   - Internal/non-protected clients may also use the canonical jobs API when appropriate.

## Required Environment
Use placeholders in docs, scripts, and tickets. Never paste real bearer tokens, OpenAI keys, Railway tokens, cookies, database URLs, or passwords.

| Variable | Required for | Notes |
| --- | --- | --- |
| `ARCANOS_GPT_ACCESS_TOKEN` | Any `/gpt-access/*` call | Strong bearer token. Store only in the runtime environment or GPT Action auth field. |
| `ARCANOS_GPT_ACCESS_SCOPES` | `/gpt-access/jobs/create` | Must explicitly include `jobs.create`; include `jobs.result` for result polling. |
| `OPENAI_API_KEY` | Live Trinity output and worker execution | The config layer also supports fallback key names documented in `CONFIGURATION.md`, but `OPENAI_API_KEY` is the preferred operator setting. |
| `DATABASE_URL` or complete `PG*` set | Durable GPT jobs and worker queue | Web and worker services must point at the same database. |
| `ARCANOS_PROCESS_KIND` | Railway launcher | Set `web` on the API service and `worker` on the worker service. Omit for direct local `npm start` / `npm run start:worker`. |
| `PORT` | Local API process | Railway injects `PORT`; do not hard-code it in Railway Variables. |
| `JOB_WORKER_ID` | Optional worker identity | Defaults to `async-queue`. |
| `JOB_WORKER_CONCURRENCY` | Optional worker parallelism | Defaults to `1`; one process can run multiple queue-consumer slots. |
| `WORKER_TRINITY_RUNTIME_BUDGET_MS` | Optional worker Trinity guardrail | Defaults to `420000`. |
| `WORKER_TRINITY_STAGE_TIMEOUT_MS` | Optional worker Trinity stage guardrail | Defaults to `180000`. |
| `ARCANOS_CORE_BACKGROUND_HANDLER_TIMEOUT_MS` | Optional background core timeout tuning | Defaults to the background profile in `src/services/arcanos-core.ts`. |
| `ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS` | Optional background Trinity timeout tuning | Defaults to `120000`, clamped by code. |
| `TRINITY_DAG_GPT_ACCESS_ENABLED` | Optional DAG worker routing toggle | If unset, auto-enables only when worker slots exceed `DAG_MAX_CONCURRENT_NODES`; unsafe forced routing fails clearly. Queued DAG node prompts use `src/services/trinity/adapter.ts` to create/poll Arcanos core jobs through GPT Access. |
| `GPT_MODULE_MAP` | Optional registry override | Defaults are auto-discovered from module definitions. Use only for explicit registry overrides. |

## Triggering Trinity
Protected GPT Action or operator flow:

```bash
curl -sS -X POST "$ARCANOS_BASE_URL/gpt-access/jobs/create" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "gptId": "arcanos-core",
    "task": "Draft a concise release note for the latest completed backend change.",
    "input": {
      "audience": "operators",
      "format": "markdown"
    },
    "maxOutputTokens": 1200
  }'
```

Then poll through the protected result endpoint:

```bash
curl -sS -X POST "$ARCANOS_BASE_URL/gpt-access/jobs/result" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jobId":"<job-id-from-create-response>"}'
```

Internal writing-plane flow:

```bash
curl -sS -X POST "$ARCANOS_BASE_URL/gpt/arcanos-core" \
  -H "Content-Type: application/json" \
  -d '{"action":"query","prompt":"Draft a concise release note."}'
```

Use the internal flow only for the public writing plane. Protected backend diagnostics, async job creation, worker status, queue inspection, and job-result reads belong under `/gpt-access/*` or direct control endpoints.

## Verification
Focused test suites:

```bash
node scripts/run-jest.mjs --testPathPatterns=gpt-access-gateway --coverage=false
node scripts/run-jest.mjs --testPathPatterns=trinity-writing-pipeline --coverage=false
node scripts/run-jest.mjs --testPathPatterns=worker-trinity-pipeline --coverage=false
node scripts/run-jest.mjs --testPathPatterns=trinity-status-service --coverage=false
```

Runtime wiring checks:

```bash
curl -sS "$ARCANOS_BASE_URL/healthz"
curl -sS "$ARCANOS_BASE_URL/trinity/status"
curl -sS "$ARCANOS_BASE_URL/gpt-access/health" -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
curl -sS "$ARCANOS_BASE_URL/gpt-access/status" -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
curl -sS "$ARCANOS_BASE_URL/gpt-access/workers/status" -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
```

Expected signals:
- `/gpt-access/health` returns `ok: true` when auth is configured and valid.
- `/gpt-access/jobs/create` returns `202` with a UUID-like `jobId`.
- Worker logs show `gpt.job.started`, `gpt.dispatch.plan`, `[core] before trinity.query`, `trinity.entry`, and eventually `gpt.job.completed` for successful jobs.
- `/gpt-access/jobs/result` returns queued/running state until the worker stores a terminal result.
- `/trinity/status` reports queue, worker, memory sync, and effective timeout limits without exposing secrets.

## Tiering and Guardrails
Tier detection is implemented in `src/core/logic/trinityTier.ts`.

Tier detection logic:
- `critical`: prompt length >= 500 and at least 2 complexity keywords
- `complex`: prompt length >= 300 or at least 1 complexity keyword
- `simple`: otherwise

Injection guard:
- If prompt includes forbidden phrases such as `set tier to`, tier is forced to `simple`.

Core guardrails:
- Per-tier semaphore in `src/core/logic/trinityGuards.ts`
- Watchdog timeout
- Hard token cap (`TRINITY_HARD_TOKEN_CAP`)
- Session token auditor
- Retry lineage guard
- Downgrade and telemetry logging

Worker guardrails:
- Runtime budget: `WORKER_TRINITY_RUNTIME_BUDGET_MS`
- Stage timeout: `WORKER_TRINITY_STAGE_TIMEOUT_MS`
- Planner retries and timeout: `PLANNER_MAX_RETRIES`, `PLANNER_RETRY_BACKOFF_MS`, `PLANNER_TIMEOUT_MS`

## Output Contract
`TrinityResult` is defined in `src/core/logic/trinityTypes.ts` and includes:
- `result`
- `activeModel`, `gpt5Model`, `routingStages`
- `fallbackFlag` and `fallbackSummary`
- `auditSafe`
- `memoryContext`
- `taskLineage.requestId`
- `meta`
- optional `dryRunPreview`, `tierInfo`, `guardInfo`, timeout/degraded metadata

Treat completed output as degraded when any of these are present:
- `fallbackFlag === true`
- `timeoutKind === "pipeline_timeout"`
- `activeModel` contains `static-timeout-fallback`
- `auditSafe.auditFlags` contains `CORE_PIPELINE_TIMEOUT_FALLBACK`

## Related Routes
- `POST /gpt-access/jobs/create`: protected async Trinity/GPT job creation.
- `POST /gpt-access/jobs/result`: protected job result lookup.
- `GET /gpt-access/workers/status`: protected worker status.
- `GET /gpt-access/worker-helper/health`: protected worker helper health.
- `GET /trinity/status`: public sanitized Trinity pipeline status.
- `POST /gpt/:gptId`: canonical writing plane.
- `GET /jobs/:id`, `GET /jobs/:id/result`, `GET /jobs/:id/stream`: canonical non-protected job APIs.

## Legacy Notes
- `GET|POST /brain` is a legacy ask-compatible route and returns `410 Gone` unless `ASK_ROUTE_MODE=compat`.
- `POST /arcanos-pipeline` is a separate legacy multi-step route and is not the same as `runThroughBrain`.
- System operations must not be sent through the writing pipeline.
