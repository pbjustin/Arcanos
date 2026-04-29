# Arcanos Refactor Audit

Status: baseline audit, read-only evidence pass
Date: 2026-04-29

This document records verified repository facts and prioritized refactor findings. It is not a deletion approval. Deletions require import, route, runtime, test, or owner evidence and should be tracked in `DEPRECATION.md` first.

## Scope

- TypeScript/Node backend, packages, workers, and protocol surface.
- Python daemon/runtime behind the protocol boundary.
- Railway startup and health/readiness behavior.
- GPT access, control-plane boundaries, queue/job lifecycle, worker health, and OpenAI SDK usage.

## Validation Run

- Passed: `node scripts\validate-railway-compatibility.js`
- Passed: `node scripts\run-jest.mjs --testPathPatterns=openai-sdk-guardrails --coverage=false`

## Repo Map

Verified:

- Root is an npm workspace with `packages/*`, `workers`, and `arcanos-ai-runtime`.
- Main web entrypoint is `src/start-server.ts`, which imports `src/server.ts`.
- Express app construction is centralized in `src/app.ts`.
- Routes are registered from `src/routes/register.ts`.
- Public protocol ownership is TypeScript-first through `packages/protocol`.
- Python lives under `daemon-python/` and loads shared protocol schemas from `packages/protocol/schemas/v1`.
- Existing docs state `legacy/` is read-only after the monorepo refactor.

Needs follow-up:

- Decide whether `arcanos-ai-runtime` is separately owned/deployed or must be part of root validation.
- Generate a route manifest because many routers are mounted at `/`, making path ownership implicit.
- Add an ownership table for route, queue, worker, OpenAI, control-plane, and Python surfaces.

## Route Map

Verified:

- Canonical GPT writing route: `/gpt/:gptId`.
- Authenticated GPT access gateway: `/gpt-access/*`.
- Async job polling routes: `/jobs/*`.
- Worker helper routes: `/worker-helper/*`.
- Health/readiness routes include `/health`, `/healthz`, and `/readyz`.
- Legacy ask routes include `/brain` and `/api/arcanos/ask`; docs state `/brain` defaults to `ASK_ROUTE_MODE=gone`.

Risks:

- Root-mounted routers can collide without a generated inventory.
- Control-plane and job-result reads must not fall back through `/gpt/:gptId`.
- Worker helper mutation routes require explicit gate review before they can remain operator-facing.

## AI and OpenAI Path Map

Verified:

- OpenAI SDK guardrail test passed and found no `_thenUnwrap` source usage.
- Raw `new OpenAI` construction is currently constrained by tests to approved adapter boundaries in the scanned TypeScript roots.
- The TypeScript OpenAI package `@arcanos/openai` and backend adapter are the intended SDK boundary.
- `arcanos-ai-runtime/src/ai/openaiClient.ts` still reads OpenAI-related config directly.
- Python has a canonical OpenAI surface under `daemon-python/arcanos/openai/`.

Risks:

- Direct script-level OpenAI calls need classification as tooling-only or migrated through the canonical adapter.
- Python Responses streaming currently needs explicit Responses event handling.
- Python assistant history request shape needs contract validation against the Responses API schema.

## Worker and Queue Map

Verified:

- Main DB-backed worker entrypoint is `src/workers/jobRunner.ts`.
- Queue persistence and lifecycle mutation are concentrated in `src/core/db/repositories/jobRepository.ts`.
- Worker autonomy and health behavior are spread across `src/services/workerAutonomyService.ts`, `src/services/workerControlService.ts`, worker runtime repositories, and route surfaces.
- Multiple worker systems exist: DB-backed worker, in-process runtime config, `workers/` package, and `arcanos-ai-runtime`.

P1 risks:

- Stale recovery can override persisted per-row retry budgets.
- Retry scheduling can requeue terminal jobs.
- Priority direct GPT execution does not observe cancellation while running.
- Worker mutation routes can bypass explicit auth/operator gates.

P2 risks:

- Queue summary undercounts stale running jobs with null heartbeat/lease.
- Cancelled stale jobs can be reported as failed/dead-letter work.
- Worker health categories do not yet match the target model: alive, idle, busy, stale, degraded, unhealthy, disabled.

## Railway Readiness Map

Verified:

- `railway.json`, `Dockerfile`, `Procfile`, `.railwayignore`, and `railway/cron.yaml` exist.
- `npm run validate:railway` passed.
- `railway.json` starts `node scripts/start-railway-service.mjs`.
- Worker launcher exposes health endpoints.

Risks:

- Web server startup in `src/server.ts` does not retain the HTTP server or register graceful shutdown handlers.
- Listener config is split: runtime config computes a host, but `app.listen` does not pass it.
- Worker `/readyz` is optimistic and can return `200` before worker bootstrap/DB/provider readiness is known.
- `Procfile` starts direct commands that bypass the canonical Railway launcher behavior.
- Railway platform health currently points at `/health`, which can depend on critical provider health.

## Python Map

Verified:

- Python package surface is `daemon-python/`.
- Root `pyproject.toml` and `daemon-python/pyproject.toml` declare different package metadata.
- Python config and OpenAI adapter exist, but backend-only routing can still require a local OpenAI key.
- Python backend client still has public job status/result compatibility methods that post through `/gpt/:gptId`.

P1 risks:

- Placeholder OpenAI keys pass config validation but fail later during client initialization.
- Backend-routed daemon usage can unnecessarily require local OpenAI credentials.
- Responses streaming path does not yet handle Responses event shapes.
- Job status/result compatibility path violates the direct endpoint rule until deprecated or migrated.

## Control-Plane Boundary Map

Verified:

- Control/read routes are documented as direct endpoints such as `/jobs/*`, `/workers/status`, `/worker-helper/health`, `/status`, `/mcp`, and `/gpt-access/*`.
- GPT writing-plane traffic is routed through `/gpt/:gptId`.
- Existing tests cover several GPT access and control-plane guardrails.

Needs follow-up:

- Re-run the AI gateway/control-plane audit before changing GPT or control-plane behavior.
- Add negative tests that job result/status and runtime diagnostics cannot route through generic GPT generation.

## Dependency Report

Verified:

- Root package depends on `openai` `^6.25.0`.
- Python daemon package depends on `openai` `>=2.30.0,<3`.
- Root and daemon Python package metadata differ and need a packaging decision.

Needs follow-up:

- Rerun dependency modernization audit before any dependency upgrade.
- Do not combine dependency upgrades with auth, worker, queue, or OpenAI wrapper refactors.

## Test Gap Report

Required before risky changes:

- Retry scheduling must not requeue terminal jobs.
- Stale recovery must respect `max_retries=0` and `max_retries=1`.
- Priority direct GPT cancellation must terminate as cancelled.
- Worker helper mutation routes must reject unauthenticated/operator-light requests.
- `/health`, `/healthz`, and `/readyz` must separate liveness from readiness.
- Web SIGTERM/SIGINT must stop accepting requests and close resources.
- Python placeholder key and backend-only routing behavior must be tested.
- Python Responses streaming must be tested with fake Responses event streams.

## Recommended Order

1. Preserve this audit and `DEPRECATION.md`.
2. Add deterministic audit tooling for routes, env reads, OpenAI construction, workers, and legacy imports.
3. Fix P1 queue, cancellation, auth, and Railway lifecycle bugs with focused tests.
4. Consolidate config and failure categories.
5. Consolidate OpenAI wrappers.
6. Remove legacy only after evidence, tests, and reviewer approval.
