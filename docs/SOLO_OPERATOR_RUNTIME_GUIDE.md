# Solo Operator Runtime Guide

## Overview
This document explains the current Arcanos production runtime as one system.

It covers two views:
- the technical view for backend maintenance
- the end-user view for understanding what behavior changed

## What This System Is
Arcanos is a Railway-hosted backend with four practical runtime pieces:
- the main Express app
- a dedicated async worker service
- a Postgres database
- a Redis instance

The main app is the public API surface. It handles canonical GPT writing routes under `/gpt/:gptId`, health routes, and the operator helper routes under `/worker-helper/*`.

The dedicated worker service is a separate process that pulls queued jobs from Postgres and executes them in the background.

Postgres is the durable system of record for queued worker jobs and normal persisted application data.

Redis is infrastructure support. It is used for fast shared state and coordination, not as the primary end-user record store.

## Technical Model
### Main app vs worker
There are two worker execution modes:

1. In-process worker runtime
The main app can execute work immediately through the in-process runtime. That path is used by direct worker dispatch and is bootstrapped explicitly by the application startup lifecycle when configured; importing shared worker modules does not start it.

Relevant code:
- `src/services/workerControlService.ts`
- `src/platform/runtime/workerConfig.ts`

2. Dedicated async worker service
The app can also enqueue a job into Postgres for the separate worker service to process later.

Relevant code:
- `src/services/workerControlService.ts`
- `src/core/db/repositories/jobRepository.ts`
- `src/workers/jobRunner.ts`

This split matters because "worker connected" does not mean only one thing:
- the main app worker runtime must be booted for direct dispatch
- the dedicated worker service must be alive and polling the queue for async work

### Why the queue is in Postgres, not Redis
The async worker queue is database-backed. Jobs are created, read, and summarized from Postgres.

That means:
- queued jobs survive restarts
- job history can be inspected later
- latest job and queue summaries come from database reads

Redis does not replace that queue in the current design. Redis is used where fast shared state is more important than durable user-visible history.

### What Redis is doing
Redis is now resolved through one shared runtime resolver so the app and health probes use the same connection rules.

Relevant code:
- `src/platform/runtime/redis.ts`
- `src/services/incidentResponse/killSwitch.ts`
- `src/services/safety/v2/config.ts`

Current Redis responsibilities are infrastructure-facing:
- shared kill-switch state
- fast coordination and safety/runtime support
- dependency health visibility

Redis is intentionally optional in some paths. If it is not configured, the app can still run in reduced mode. If it is configured and unhealthy, health routes now surface that failure explicitly.

### What changed in health checks
Health reporting is now explicit about Redis.

Endpoints:
- `GET /healthz`: liveness only
- `GET /readyz`: readiness for OpenAI, database, Redis, and application runtime
- `GET /health`: comprehensive dependency view, including Redis details

Relevant code:
- `src/platform/resilience/unifiedHealth.ts`
- `src/routes/health.ts`
- `src/core/diagnostics.ts`

Behavior:
- `/readyz` fails when a configured critical dependency is unhealthy
- `/health` includes `dependencies.redis`
- live `/health` and router-based health handling now agree about Redis status

### What changed in ask-style routing
The legacy ask-style implementation now lives behind `/brain` and defaults to `ASK_ROUTE_MODE=gone`. Canonical daemon and GPT traffic should use `/gpt/:gptId`; operator control reads should use direct endpoints such as `/jobs/*`, `/workers/status`, and `/worker-helper/*`.

Relevant code:
- `src/routes/ask/workerTools.ts`
- `src/routes/ask/daemonTools.ts`
- `src/services/openai/functionTools.ts`

The important fix was tool schema normalization.

Before this fix, the backend could send Chat Completions style function tools into the Responses API. That breaks because the Responses API expects top-level tool fields like `name`, not nested `function.name`.

That mismatch caused errors like:
- `400 Missing required parameter: 'tools[0].name'`

Now Arcanos builds one canonical tool definition and emits:
- Chat Completions format when using `chat.completions.create`
- Responses API format when using `responses.create`

This is why the remaining ask-style compatibility code builds tool payloads correctly when temporarily enabled, while new callers should use canonical GPT and control-plane routes.

### Worker/operator auth boundaries
Worker privilege requirements are assigned per route, while credential verification is shared.

These bounded summary routes do not apply the worker-helper privileged-auth middleware:
- `GET /worker-helper/status`
- `GET /worker-helper/health`
- `GET /worker-helper/jobs/failed`

The bundled helper's `status` command intentionally sends no worker-helper
credential. Configuring `ARCANOS_WORKER_HELPER_TOKEN` does not add it to that
public request.

These job-detail and mutation routes require authenticated operator or trusted internal access:
- `GET /worker-helper/jobs/latest`
- `GET /worker-helper/jobs/:id`
- `POST /worker-helper/queue/ask`
- `POST /worker-helper/dispatch`
- `POST /worker-helper/heal`

Privileged access accepts a daemon context, a configured `ARCANOS_WORKER_HELPER_TOKEN` supplied through `x-arcanos-worker-helper-token` or Bearer authentication, an authenticated `admin`/`operator`/`owner` role, or an established operator actor. The `operator-light` role is explicitly denied. These checks supplement deployment-level access controls; they are not removed for a solo-operator deployment.

The worker-helper token must be an exact 32–4096 character value with no whitespace or placeholder text and must be distinct from every credential in the canonical ARCANOS application-auth registry. Send it through one non-empty carrier only. Duplicate token or Authorization headers, simultaneous custom and Bearer credentials, and values that require trimming are rejected with the generic authentication response.

The direct `POST /workers/heal` and `POST /workers/run/:workerId` routes are
stricter: they accept the configured worker-helper token or an established full
`admin`/`operator`/`owner` identity, then separately require action
confirmation. A daemon marker, operator audit label, automation confirmation,
or `x-confirmed` alone does not authorize direct worker control. Direct and
worker-helper heal requests share a 10-per-15-minute principal budget.

### Safety quarantine recovery

`GET /status/safety` is a public, allowlisted summary and does not reveal
quarantine IDs, reasons, metadata, or entity-keyed counters. For an integrity
quarantine:

1. Read authenticated `GET /status/safety/self-heal` with the control-plane
   bearer and `arcanos:read`.
2. Read the quarantine ID from `safetyState`.
3. Call `POST /status/safety/quarantine/:id/release` with the same bearer,
   `self-improve:control`, and exact deterministic confirmation.
4. Recheck the public summary.

The release route remains reachable during unsafe state only after the
pre-parser boundary authenticates the operator. `ADMIN_KEY`, `x-api-key`,
`x-operator-id`, or confirmation alone do not authorize it.

Relevant code:
- `src/routes/worker-helper.ts`
- `src/routes/workers.ts`
- `src/routes/safety.ts`
- `src/transport/http/middleware/workerHelperPrivilegedAuth.ts`
- `scripts/worker-helper.mjs`

## What This Means For The End User
For the end user, the main visible changes are operational, not UI-facing.

### 1. Worker-backed requests are more reliable
When a prompt needs worker inspection or worker actions, canonical GPT and compatibility routes can reach the tool layer instead of failing early on malformed tool payloads.

### 2. Background jobs are observable
The system can report:
- worker runtime state
- queue totals
- latest job
- individual job details

That makes async behavior explainable instead of opaque.

### 3. Health routes are more honest
If Redis is configured but broken, the app now says so through health endpoints. The user gets a truer picture of system health instead of a false green state.

### 4. Redis is still not the user-facing source of truth
A user generally "sees" Postgres-backed application state because the app reads durable records from the database and returns them through normal APIs.

Redis does not usually "pop up" directly on the user side unless the app explicitly reads Redis and sends that value back in a response. In this runtime, Redis mostly changes backend behavior:
- feature gating
- shared safety state
- coordination
- health reporting

So the short version is:
- Postgres stores durable user-visible records
- Redis supports fast backend state

## Operator Surface
### Health checks
Use:
- `GET /healthz`
- `GET /readyz`
- `GET /health`

Read them as:
- `/healthz`: process alive
- `/readyz`: safe to receive traffic
- `/health`: detailed dependency report

### Worker helper routes
Use the bounded status routes for summary inspection:
- `GET /worker-helper/status`
- `GET /worker-helper/health`
- `GET /worker-helper/jobs/failed`

Use an authenticated operator or trusted internal context for:
- `GET /worker-helper/jobs/latest`
- `GET /worker-helper/jobs/:id`
- `POST /worker-helper/queue/ask`
- `POST /worker-helper/dispatch`
- `POST /worker-helper/heal`

The summary routes intentionally expose bounded runtime and queue health. Job detail and mutation routes do not bypass authentication merely because the deployment has one operator.

### CLI helper
Use:
- `node scripts/worker-helper.mjs status`
- `node scripts/worker-helper.mjs latest-job`
- `node scripts/worker-helper.mjs queue-ask "your prompt"`
- `node scripts/worker-helper.mjs dispatch "your input"`
- `node scripts/worker-helper.mjs heal`

Only `status` is credential-free. Every protected command requires
`ARCANOS_WORKER_HELPER_TOKEN` in the script environment and fails locally before
network access when it is absent, malformed, placeholder-like, or equal to
another canonical application credential. The script accepts no token,
worker-helper-token, or Authorization CLI flag and sends the credential only as
`x-arcanos-worker-helper-token`, never as outbound Authorization. Configure the
same exact token on the caller and target.

For a protected command, `ARCANOS_BASE_URL` or `--base-url` must be an exact
explicit HTTPS origin without user information, path, query, or fragment. Exact
HTTP origins are accepted only for `localhost`, `127.0.0.1`, or IPv6 loopback.
Redirects are rejected. The script accepts at most 1 MiB of JSON response data
and removes exact credential reflections before printing the result.

### Remote worker repair actuator

Remote self-healing uses `SELF_HEAL_WORKER_SERVICE_URL`; compatibility aliases
are `WORKER_HELPER_BASE_URL`, `RAILWAY_SERVICE_ARCANOS_WORKER_URL`, and
`ARCANOS_WORKER_PUBLIC_URL`. Every configured alias must be valid and normalize
to the same exact HTTPS origin, with exact loopback HTTP as the only exception.
The actuator reports itself unavailable when URL aliases are invalid or
conflicting, or when the caller lacks a valid `ARCANOS_WORKER_HELPER_TOKEN`.

The caller and target must hold the identical token. The actuator re-resolves it
immediately before fetch, sends only the custom worker-helper header, and rejects
redirects. A successful target response must be a JSON object no larger than 64
KiB with matching `requestedForce` and the bounded restart fields. The actuator
returns only `requestedForce`, `restart.started`, `restart.alreadyRunning`,
`restart.runWorkers`, and a locally generated `restart.message`. It validates
but discards the target-controlled message so arbitrary remote text, fields, and
unrelated secrets do not reach logs or telemetry.

### Queue and GPT job observability

The Prometheus endpoint exposes queue, worker, provider, and job-event metrics
for an operator dashboard. Never use raw prompts, completions, headers,
cookies, bearer tokens, API keys, database URLs, or `job_events.metadata`
values as metric labels.

The thresholds below are starting points, not deployment-independent
guarantees. Tune them against observed traffic and the configured worker
budgets.

| Panel | Prometheus metric | Suggested alert |
| --- | --- | --- |
| Queue depth | `worker_queue_depth{state="pending"}` | Warn above 25 for 10m; critical above 100 for 5m. |
| Oldest pending age | `worker_queue_latency_ms{scope="oldest_pending"}` | Warn above 60000ms for 10m; critical above 300000ms for 5m. |
| Worker health | `worker_health_status`, `worker_heartbeat_age_ms`, `worker_stale_workers` | Alert when heartbeat age exceeds `2 * JOB_WORKER_STALE_AFTER_MS`; stale workers should remain zero. |
| Worker recommendations | `worker_alert_recommendations{recommendation="operational_alerts"}`, `worker_alert_recommendations{recommendation="diagnostic_alerts"}`, `worker_alert_recommendations{recommendation="restart_recommended_workers"}` | Alert on sustained non-zero values; page only after validating restart recommendations against current state. |
| Stale recovery | `worker_stale_total`, `worker_stalled_jobs_total`, `worker_recovery_actions_total` | Alert on a sustained increase for 10m. |
| Provider latency | `ai_call_duration_ms` by provider, model, and operation | Warn when p95 exceeds 30000ms for 10m. |
| Provider and dependency failures | `ai_calls_total{outcome!="ok"}`, `ai_timeouts_total`, `dependency_failures_total`, `dependency_timeouts_total` | Warn when the error ratio exceeds 5% for 10m or timeouts spike. |
| AI circuit breaker | `ai_circuit_breaker_state`, `ai_circuit_breaker_failures` | Alert when the state remains open for two checks. |
| Retry exhaustion | `worker_failures_total`, `worker_retries_total`, `gpt_job_events_total{event="job.failed"}` | Alert when dead-letter growth exceeds three jobs in 15m. |
| Event throughput | `gpt_job_events_total`, `job_event_insert_failures_total`, `job_events_cleanup_rows_total` | Alert on zero event rate while jobs are active or any insert failure. |
| Retention cleanup | `job_events_cleanup_runs_total`, `job_events_cleanup_duration_ms`, `job_events_cleanup_rows_total` | Alert on cleanup failures or p95 duration above 10000ms. |

Recommended initial service objectives:

| SLO | Target |
| --- | --- |
| Async GPT queue admission | 99% of accepted jobs emit `job.created` and `job.queued` within 5s. |
| Queue wait | 95% of jobs are claimed within 60s. |
| Worker execution | 95% of non-retried jobs complete or fail terminally within the configured worker budget. |
| Provider latency | 95% of OpenAI calls complete within 30s, excluding upstream incidents. |
| Stale recovery | 99% of stale running jobs are recovered, cancelled, or dead-lettered within two inspection intervals. |
| Retention cleanup | Cleanup completes within 10s and deletes no more than `JOB_EVENT_CLEANUP_BATCH_SIZE` rows per run. |

`gpt_job_timing_ms{phase="queue_wait"}` measures created-to-claimed latency,
`phase="execution"` measures started-to-terminal latency, and
`phase="end_to_end"` measures created-to-terminal latency. Claim-to-start
should be near zero because the claim update also sets `started_at`.

Build before using the bounded timeline utility:

```bash
npm run build
npm run job-events:timeline -- --job-id <uuid> --output text
npm run job-events:timeline -- --trace-id <trace-id> --limit 200
```

This is a configured-database operation, not a read-only verification command.
Before querying, the script runs the shared database initializer, which can
apply built-in schema DDL and write an initialization heartbeat. Run it only
with explicit authorization and exact database-target confirmation. The
timeline query itself returns redacted chronological events, trace and worker
summaries, queue wait, execution, and provider latency, bounded by
`MAX_JOB_EVENT_TIMELINE_LIMIT`. High-frequency `worker.heartbeat` events are
disabled by default; use `job_data.last_heartbeat_at` and worker heartbeat
metrics for normal liveness, and enable `JOB_EVENT_RECORD_HEARTBEATS=true` only
for short debugging windows.

## Failure Modes To Remember
### Postgres failure
If Postgres is down:
- queued worker jobs cannot be created or observed correctly
- latest job and queue summaries can become unavailable
- the dedicated worker service loses its queue backend

### Redis failure
If Redis is configured but down:
- shared kill-switch and related distributed state lose their shared backend
- health routes report the failure
- the app may still run, depending on which feature needs Redis at that moment

### Main app worker runtime failure
If the in-process runtime is down:
- direct dispatch fails or degrades
- async queue processing may still work if the dedicated worker service is healthy

### Dedicated worker service failure
If the queue worker is down:
- new async jobs can still be enqueued
- queued jobs remain pending instead of completing
- direct dispatch from the main app may still work

## Minimal Verification Checklist
- `GET /healthz` returns 200
- `GET /readyz` includes a Redis check
- `GET /health` includes `dependencies.redis`
- `GET /worker-helper/status` returns queue and runtime state
- canonical GPT/compatibility worker prompts no longer fail with `tools[0].name`
- queued jobs appear in Postgres-backed worker job inspection routes

## Summary
Technically, this work turned the runtime into a clearer split between:
- durable queue and data in Postgres
- fast shared state in Redis
- immediate execution in the main app worker runtime
- background execution in the dedicated worker service

For the end user, it mostly means the system is more reliable and easier to trust:
- background work actually routes
- health checks reflect real dependency state
- bounded worker summaries remain simple while job detail and mutations require operator authentication
