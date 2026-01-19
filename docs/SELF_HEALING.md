# Self-Healing and Resiliency Guide

This guide explains how ARCANOS detects degraded worker health, generates recovery plans, and keeps operators in the loop when remediations run.

## Operator-Facing Entry Points

* `GET /workers/status` inventories every worker module, reports runtime metadata (model, listener count, last dispatch/error), and attaches a summarized auto-heal signal so GPT automations or humans can see the current severity at a glance.【F:src/routes/workers.ts†L72-L144】【F:src/services/autoHealService.ts†L111-L121】
* `POST /workers/heal` is guarded by the confirmation gate and returns the full recovery plan. Supplying `{ "execute": true }` or `mode: "execute"` restarts the worker pool immediately via `startWorkers(true)` and persists the attempt (plan ID, severity, timestamp) in `systemState.json` for future audits. Trusted fine-tuned GPT callers (or automation-secret clients) automatically fall into execute mode unless they explicitly send `mode: "plan"` or `"execute": false`, so self-heals kick off without an extra confirmation hop.【F:src/routes/workers.ts†L109-L151】【F:src/services/stateManager.ts†L21-L55】

Together, these endpoints let you inspect incidents, confirm a heal, and correlate the action with the server-side audit trail.

## Autonomous Fine-Tuned Remediations

The confirmation middleware now auto-trusts the active fine-tuned model ID, so
automation that identifies itself with `x-gpt-id: <your fine-tuned model>` can
approve and execute `/workers/heal` (or any other gated route) without an
operator repeating `x-confirmed: yes`. Once the middleware marks the request as
trusted, `/workers/heal` defaults to execute mode automatically unless the body
asks for `mode: "plan"`, ensuring the recovery loop runs end-to-end with a
single API call.【F:src/middleware/confirmGate.ts†L1-L208】【F:src/routes/workers.ts†L109-L151】

If your automation does not expose a GPT identifier (for example, API-only
fine-tunes), set `ARCANOS_AUTOMATION_SECRET` (and optionally
`ARCANOS_AUTOMATION_HEADER`) so the backend can self-identify via a shared
secret header like `x-arcanos-automation`. Matching requests now bypass the
confirmation prompt just like a trusted GPT ID while still requiring explicit
operator approval for everything else.【F:src/middleware/confirmGate.ts†L26-L190】

## How Auto-Heal Plans Are Built

1. `buildStatusPayload()` captures the file-system inventory, current runtime telemetry, and embeds an `autoHeal` summary for downstream consumers.【F:src/routes/workers.ts†L18-L88】
2. `buildAutoHealPlan()` feeds that payload into two stages: a deterministic heuristic (severity + restart steps) and an optional GPT call when failures or last errors exist.【F:src/services/autoHealService.ts†L4-L109】
3. The AI response is forced into a strict schema (`planId`, `severity`, `recommendedAction`, `steps`, `fallbackModel`), and the system always falls back to the heuristic if the AI request fails.【F:src/services/autoHealService.ts†L75-L109】
4. `summarizeAutoHeal()` distills severity, failing worker IDs, last error, and a call-to-action so `/workers/status` can display incident context inline.【F:src/services/autoHealService.ts†L111-L121】

## Executing a Heal

When `/workers/heal` runs in execute mode:

1. `startWorkers(true)` force-restarts the pool, clearing existing listeners and recreating each configured worker so the queue starts cleanly.【F:src/config/workerConfig.ts†L206-L258】
2. The runtime bookkeeping in `workerConfig` (dispatch counts, last error/input) resets as workers resume handling tasks, and `getWorkerRuntimeStatus()` exposes those fields back to `/workers/status`.【F:src/config/workerConfig.ts†L260-L309】
3. The state manager merges `lastHeal` metadata into `systemState.json`, ensuring later diagnostics can prove when the plan executed and what severity triggered it.【F:src/routes/workers.ts†L121-L135】【F:src/services/stateManager.ts†L21-L55】

## Continuous Verification Loop

* `runSelfTestPipeline()` periodically hits `/ask` with readiness prompts, appends the results to `logs/healthcheck.json`, and mirrors the pass/fail summary into `systemState` so future auto-heal plans have fresh telemetry.【F:src/services/selfTestPipeline.ts†L41-L211】
* Worker dispatches always update `runtimeState` with the last input preview, result, and error so heuristics can flag recurring failures even if no file import is broken.【F:src/config/workerConfig.ts†L260-L309】

## Degraded-Mode Safeguards

Even before a heal runs, the fallback middleware protects user-facing routes:

* `createHealthCheckMiddleware()` preemptively returns a degraded response on AI-heavy routes when the OpenAI client is unavailable or a strict environment demands it.【F:src/middleware/fallbackHandler.ts†L142-L179】
* `createFallbackMiddleware()` captures runtime OpenAI errors, generates cached or mock responses, and records telemetry so automation can see that degraded mode engaged.【F:src/middleware/fallbackHandler.ts†L71-L140】
* `generateDegradedResponse()` standardizes the payload (status, fallback mode, timestamp) so dashboards and operators know they’re seeing a temporary response.【F:src/middleware/fallbackHandler.ts†L28-L69】

These safeguards keep `/ask` and related endpoints responsive while `/workers/heal` restarts the pool and the self-test pipeline verifies that everything recovered.
