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
The main app can execute work immediately through the in-process runtime. That path is used by direct worker dispatch.

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

### What changed in worker/operator auth
Route-level helper/admin token requirements were removed from the worker helper surface and the lightweight agent capability grant path.

Relevant code:
- `src/routes/worker-helper.ts`
- `scripts/worker-helper.mjs`
- `src/routes/agents.ts`

This means the backend now assumes a trusted solo-operator deployment model instead of requiring extra helper headers such as:
- `x-worker-helper-key`
- `x-admin-api-key`
- `x-register-key`

The practical tradeoff is simple:
- less operator overhead
- less route-level friction
- more reliance on deployment-level access control

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
Use:
- `GET /worker-helper/status`
- `GET /worker-helper/jobs/latest`
- `GET /worker-helper/jobs/:id`
- `POST /worker-helper/queue/ask`
- `POST /worker-helper/dispatch`
- `POST /worker-helper/heal`

These routes are the simplest operator control surface for a solo developer because they expose runtime and queue state without extra helper-token management.

### CLI helper
Use:
- `node scripts/worker-helper.mjs status`
- `node scripts/worker-helper.mjs latest-job`
- `node scripts/worker-helper.mjs queue-ask "your prompt"`
- `node scripts/worker-helper.mjs dispatch "your input"`
- `node scripts/worker-helper.mjs heal`

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
- worker inspection works without extra operator token friction
