# Trinity Pipeline

## Overview
The Trinity pipeline is the main AI writing path in this codebase. It accepts prompt-shaped writing work, rejects control-plane leakage, runs the multi-stage ARCANOS reasoning flow, and returns a structured `TrinityResult`.

Current entrypoints:
- Protected GPT Action gateway: `POST /gpt-access/jobs/create` in `src/routes/gpt-access.ts`
- Canonical writing plane: `POST /gpt/:gptId` in `src/routes/gptRouter.ts`
- Canonical generation facade: `src/core/logic/trinityGenerationFacade.ts` (`runTrinityGenerationFacade`)
- Backward-compatible writing facade: `src/core/logic/trinityWritingPipeline.ts` (`runTrinityWritingPipeline`)
- Low-level engine: `src/core/logic/trinity.ts` (`runThroughBrain`)

Use `/gpt-access/*` for protected backend calls from Custom GPTs and operator integrations. Do not route job result lookup, worker status, queue inspection, MCP diagnostics, or runtime inspection through `/gpt/:gptId`.

ARCANOS AI treats explicit backend-operator language as control-plane work. When `ARCANOS:CORE` receives commands such as "what is wrong with the backend?", "check on the workers", or "what is going on with the queue?", it routes them through GPT Access natural-language dispatch before Trinity writing. Advisory, recommendation, review, explanation, planning, architecture, design, and "how should I..." prompts remain in the Trinity writing path unless they contain explicit inspect/status/diagnose/control intent. The dispatch path produces a strict `DispatchPlan`, applies registered-action validation, risk-aware confidence policy, scopes, allowlists, and confirmation gates, then runs only existing `/gpt-access/*` runners. Privileged plans return confirmation state instead of executing from the writing path.

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
   - Successful writing results are stamped with `meta.pipeline: "trinity"`, `meta.bypass: false`, `meta.sourceEndpoint`, and `meta.classification: "writing"`.

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
| `ARCANOS_GPT_ACCESS_TOKEN` | Generic protected `/gpt-access/*` operations | Store only in the runtime environment or generic GPT Action auth field. Public OpenAPI metadata needs no bearer; dedicated Booker, Gaming source, and local-agent executor operations use their own credentials. |
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
| `GPT_MODULE_MAP` | Optional registry override | Defaults come from definitions in the explicit module catalog. Overrides cannot register service files or expose GPT Access-only modules. |

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

## Isolated Tutor instructional verification

The isolated ChatGPT Tutor path sets the server-owned `tutor-math-v1` policy in
`tutor-logic.ts`. `deriveTrinityOutputControls` retains it only for
`sourceEndpoint: 'tutor.pipeline'`; prompts and tool arguments cannot select it.
Both the direct-answer and full Trinity paths pass the same policy to the first
honesty filter and the subsequent honesty/minimalism filter.

Within this policy, learner-directed local calculations are instructions, not
claims that the backend performed live verification. The shared classifier
recognizes check/verify imperatives and learner questions, then consumes their
complete mathematical object or method. Mathematical relations, substitution,
arithmetic operands and local learner work can be composed; every additional
clause must also be local. Parsing is bounded, and unknown constructions retain
the normal honesty checks. Completed verification, external/current context and
backend/storage actions remain excluded. This exception suppresses only the
lexical check/verify trigger; it grants no capability or execution authority.

For example, `Can you check the equality by cross-multiplying?` and
`Check your answer by substituting x = 3 into 2x + 3 = 9.` survive both passes.
`I checked the answer.`, `Check the value of my portfolio.` and
`Check your equation by updating your password.` do not qualify. Generic ARCANOS
callers retain their existing honesty rules.

Honesty cleanup transforms segments within existing lines. Replacing or removing
a caveat preserves the remaining numbered lines, bullets and paragraph breaks;
the existing logical grouping of detached numbered markers is retained so an
unsupported item cannot lose its list context. This change adds no sentence
truncation or repair of model prose. Existing explicit word-budget compression is
unchanged and remains outside the layout guarantee. An untouched Tutor answer
retains its presentation through the first pass.

The production motivation is the [post-#1510 acceptance evidence](https://github.com/pbjustin/Arcanos/blob/68bd5eeebf63f637ccd743110d81da5cce1b1991/docs/chatgpt-migration/TUTOR_RUNTIME_ACCEPTANCE.md):
raw A/C/D contained inappropriate honesty limitations, while multiline B passed.
The regression fixtures supply compliant synthetic provider candidates to the
actual isolated Tutor pipeline with mocked provider/storage dependencies. These
fixtures demonstrate deterministic post-processing damage before the repair;
they are not captured production pre-filter provider text or live acceptance.
Fresh authenticated acceptance remains necessary after an approved deployment.

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
- `/trinity/status` returns a `no-store` aggregate worker-health projection with normalized runtime, worker, queue, and memory states, counts, and timestamps. It does not publish worker/job identifiers, recent failures, bindings, or effective timeout limits.

## Tiering and Guardrails
Tier detection is implemented in `src/core/logic/trinityTier.ts`.

Tier detection logic:
- `critical`: prompt length >= 500 and at least 2 complexity keywords
- `complex`: prompt length >= 300 or at least 1 complexity keyword
- `simple`: otherwise

Structured reasoning effort:
- `critical`: `medium`
- `complex`: `low`
- `simple`: requests `none`; exact `gpt-5` and dated GPT-5 snapshots send `minimal` because they do not support disabled reasoning

The structured stage alone defaults to `gpt-5.6-terra`. Model precedence is `TRINITY_REASONING_MODEL`, `GPT5_MODEL`, `GPT51_MODEL`, then Terra; other GPT-5 execution paths keep their existing shared selector and GPT-5.1 default. GPT-5.1 and GPT-5.6 models retain the requested `none` effort.

Injection guard:
- If prompt includes forbidden phrases such as `set tier to`, tier is forced to `simple`.

Core guardrails:
- Per-tier semaphore in `src/core/logic/trinityGuards.ts`
- Watchdog timeout
- Visible/direct-answer hard token cap (`TRINITY_HARD_TOKEN_CAP`)
- Structured reasoning Responses cap (`TRINITY_REASONING_MAX_OUTPUT_TOKENS`, strict positive base-10 integers clamped to `16`-`8000`, default `8000`, including hidden reasoning tokens)
- Structured reasoning stage timeout (`TRINITY_REASONING_STAGE_TIMEOUT_MS`, default `20000`, clamped to remaining request/runtime budget)
- Session token auditor
- Retry lineage guard
- Downgrade and telemetry logging

Structured Responses usage is captured before parsing. Session accounting therefore includes billed reasoning usage even when capped output is incomplete or the result is refused, malformed, or schema-invalid. Successful session/telemetry totals aggregate all three stages, while the public `meta.tokens` field remains final-stage-only for compatibility.

DAG execution uses a separate, attempt-local provider collector. `DAGResult.metrics.attemptTokenUsage` contains the sum of known provider tokens observed during that attempt, including intake, reasoning, final, and any repair or fallback calls. It survives failures and cancellation when usage was received. GPT Access child jobs add `dagAttemptUsage` (aggregate provider tokens) to their existing result envelope; the parent imports it once at terminal observation. A child failure with known usage is returned to the parent before retrying so the DAG budget can govern the next attempt. Usage unavailable before a timeout, cancellation, or provider failure remains unknown.

The orchestrator charges each terminal queue attempt once, before retry or descendant admission. A completed result remains completed even if it exhausts the cap; subsequent work is blocked by the existing budget guard. Invalid provider accounting remains non-retryable across child-job persistence even when no valid token count was observed; unknown usage stays absent. Explicit aggregate zero is valid. Old queue records without the new metric retain the legacy `tokenUsage`/output-metadata fallback; it is never added to an explicit aggregate. Public `meta.tokens`, cumulative session counters, and worker-wide provider reservations keep their existing meanings. The metric and child-envelope additions use existing JSON persistence and require no database migration.

[`dag-accounting-e2e.test.ts`](../tests/dag-accounting-e2e.test.ts) connects synthetic SDK responses through the claimed child worker, terminal persistence, GPT Access projection, parent task runner, and orchestrator. It proves aggregate 107 versus public final-stage 7, retry totals 27 + 43, malformed usage, and retry/descendant budget denial. Normal Jest uses synthetic SQL; the required PostgreSQL job executes the same cases with real child/parent claims and JSONB. The separate [`dag-token-accounting.pg18.integration.test.ts`](../tests/integration/dag-token-accounting.pg18.integration.test.ts) adds real queue polling and cancellation readback. Both use the guarded disposable target documented in [CI/CD](CI_CD.md); provider responses, dispatch, and background lifecycle remain controlled fixtures rather than live-service evidence. The [Railway preview accounting proof](RAILWAY_DEPLOYMENT.md) separately executes the pinned collector and child-envelope components before sealed web readiness succeeds, using the additive `dag-token-accounting/v1` header. It preserves the passive worker and does not replace the real worker/SQL tests.

Failed SDK transport responses are inspected for explicit usage before an internal retry can discard them. Inspection is limited to 64 KiB of JSON and 250 ms, honors cancellation, and does not consume the SDK's response stream. Unavailable or incomplete usage remains unknown. The child wire field `dagAttemptUsage` survives existing GPT Access credential redaction; public token metadata remains subject to that unchanged redaction policy. Existing presentation-based API token projections are not redefined by the new internal budget accounting.

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

Successful writing/generation output must include this invariant in `meta`:

```json
{
  "pipeline": "trinity",
  "bypass": false,
  "sourceEndpoint": "<caller>",
  "classification": "writing"
}
```

The invariant is applied by `applyTrinityGenerationInvariant(...)` in `src/core/logic/trinityGenerationFacade.ts`. Callers should preserve it when adapting older response envelopes.

## Writing and Control Boundaries
Writing/generation requests must enter the generation facade. Current writing-plane callers include:
- `/gpt-access/jobs/create` queued GPT execution via `src/workers/jobRunner.ts`
- `/gpt/:gptId` module dispatch, fast path, and direct `query_and_wait`
- `/brain` legacy ask-compatible generation paths when `ASK_ROUTE_MODE=compat`
- `/arcanos-pipeline`
- `/api/openai/prompt`
- Research/web search/RAG synthesis, secure reasoning, tutor/gaming/booker generation, CEF AI prompt execution, image prompt enhancement, reusable-code generation, AFOL, GPT sync, and simulation completion

These control-plane routes must not enter Trinity:
- `/mcp`
- `/status`
- `/healthz`
- `/workers/status`
- `/worker-helper/health`
- `/gpt-access/status`
- `/gpt-access/jobs/result`
- `/trinity/status`

Legacy ask tool runtimes, daemon tools, DAG tooling, worker status tools, HRC scoring, memory validation, audit-safe mode interpretation, auto-heal planning, daily summaries, self-improve patch proposal generation, idle/provider probes, vision, embeddings, simulation streaming compatibility, and adapter wrappers are intentionally outside the writing facade because they are control/evaluation/infrastructure paths, non-text-generation SDK boundaries, or stream transports Trinity does not yet expose. They must not be exposed as arbitrary user writing routes, and they must not call back through `/gpt/:gptId`.

Raw SDK calls are allowed only at these boundaries:
- OpenAI adapter and shared OpenAI service helpers (`src/core/adapters/openai.adapter.ts`, `src/services/openai/*`, `src/services/openaiClient.ts`)
- Embeddings, vision, and image generation SDK surfaces where the operation is not text writing
- Simulation streaming requests while Trinity exposes only completed `TrinityResult` generation
- Control/evaluation utilities listed above
- Standalone `workers/` package OpenAI handler and SDK wrapper, which are separate worker-package infrastructure; backend GPT jobs use `src/workers/jobRunner.ts` and the Trinity worker path

## Related Routes
- `POST /gpt-access/jobs/create`: protected async Trinity/GPT job creation.
- `POST /gpt-access/jobs/result`: protected job result lookup.
- `GET /gpt-access/workers/status`: protected, detailed worker status.
- `GET /gpt-access/worker-helper/health`: protected, detailed worker helper health.
- `GET /trinity/status`: public `no-store` aggregate worker-health projection.
- `POST /gpt/:gptId`: canonical writing plane.
- `GET /jobs/:id`, `GET /jobs/:id/result`, `GET /jobs/:id/stream`:
  canonical capability-bound, `no-store` reads for public `gpt` and `ask`
  jobs. Send the creation response's `jobReadToken` only as
  `x-arcanos-job-read-token`.

## Legacy Notes
- `GET|POST /brain` is a legacy ask-compatible route and returns `410 Gone` unless `ASK_ROUTE_MODE=compat`.
- `POST /arcanos-pipeline` is a legacy compatibility route, but its text generation now enters the Trinity generation facade.
- System operations must not be sent through the writing pipeline.
