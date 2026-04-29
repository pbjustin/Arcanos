# Arcanos Refactor Audit

Last updated: 2026-04-29

This audit is the starting point for the incremental Arcanos refactor. It records verified repository facts, risk findings, and the safe PR order for consolidating AI access, OpenAI SDK usage, job lifecycle, worker health, diagnostics, auth/operator gates, configuration, error handling, Railway startup, and Python parity.

No code deletion is authorized by this document. Every deletion still requires import, route, runtime, test, or owner evidence and a matching entry in `DEPRECATION.md`.

## Executive Summary

Verified repository state:

- The repo already has Railway deployment config in `railway.json`, `Dockerfile`, `Procfile`, and `scripts/start-railway-service.mjs`.
- The API exposes `/health` and `/readyz`; `/ready` was not found during the audit and remains later Railway startup work.
- OpenAI guardrails exist in `tests/openai-sdk-guardrails.test.ts`, and no production `_thenUnwrap` usage was found.
- OpenAI access is partially centralized, but runtime escape hatches, scripts, workers, and Python still need stricter coverage.
- Queue, worker, diagnostics, auth, GPT access, and Python OpenAI/config components already exist, but several overlap or bypass the intended boundaries.
- `DEPRECATION.md` did not exist before this audit step.

Primary conclusion: start with documentation, guardrails, and P1 safety fixes. Do not begin with broad deletions, route removals, dependency upgrades, or worker/OpenAI rewrites.

## Verified Maps

### Railway and Startup

- Active Railway config: `railway.json`.
- Active Railway launcher: `scripts/start-railway-service.mjs`.
- Web bootstrap: `src/start-server.ts` imports `src/server.ts`.
- Health/readiness routes include `/health`, `/healthz`, and `/readyz`.
- `src/server.ts` currently reads `process.env.PORT || 3000` and calls `app.listen(PORT)` without explicitly binding the configured host.
- The web runtime does not retain the HTTP server handle or register graceful `SIGTERM`/`SIGINT` handling in `src/server.ts`.

### OpenAI and AI Access

- Root package uses `openai@^6.25.0`.
- Canonical TypeScript construction points include `packages/arcanos-openai/src/client.ts` and `src/core/adapters/openai.adapter.ts`.
- Existing migration guidance names `src/core/adapters/openai.adapter.ts`, `workers/src/infrastructure/sdk/openai.ts`, and `daemon-python/arcanos/openai/*` as canonical areas.
- Direct OpenAI construction and raw SDK calls still exist in scripts such as `scripts/assistants-sync.ts`, `scripts/compare-finetune-checkpoints.ts`, and `scripts/migration-repair.js`.
- `tests/openai-sdk-guardrails.test.ts` does not yet cover all relevant roots: `scripts`, `workers`, `arcanos-ai-runtime`, and `daemon-python`.

### GPT Access and Control Plane

- `src/routes/register.ts` mounts GPT access routes, control-plane routes, jobs routes, and `/gpt`.
- `/gpt-access` routes are gated by `gptAccessAuthMiddleware` and scope checks.
- Reviewer audit found that `src/routes/jobs.ts` exposes job status/result routes without an ownership/tenant authorization contract.
- `/gpt/:gptId` still contains job-result/status compatibility behavior; it must be deprecated only after canonical job-result routes are authenticated and owner-scoped.
- Control-plane planning can call Trinity/OpenAI before approval checks; approval must happen before any writing-pipeline or model-backed planning call.

### Queue, Job, and Worker Lifecycle

- DB-backed job repository: `src/core/db/repositories/jobRepository.ts`.
- Shared GPT job lifecycle: `src/shared/gpt/gptJobLifecycle.ts`.
- Worker autonomy/control services: `src/services/workerAutonomyService.ts` and `src/services/workerControlService.ts`.
- Audit found P1 lifecycle risks:
  - Heartbeat and terminal writes are not fenced by worker ownership.
  - Retry scheduling can clear cancellation fields.
  - Job status is schema-open in places where lifecycle behavior expects a closed status set.

### Config and Environment

- Existing runtime env/config modules live under `src/platform/runtime/*`.
- `src/platform/runtime/env.ts` claims direct env ownership, but direct `process.env` access remains widespread outside allowed config modules.
- `src/config/openai.ts` still contains direct env reads and hardcoded model/fine-tune defaults.
- The requested long-term public TypeScript config facade is `src/config/env.ts`, `src/config/index.ts`, and `src/config/featureFlags.ts`.

### Python Runtime

- Python package lives under `daemon-python/arcanos`.
- Python config/env modules include `daemon-python/arcanos/config.py` and `daemon-python/arcanos/env.py`.
- Python OpenAI wrappers exist in `daemon-python/arcanos/openai/unified_client.py` and `daemon-python/arcanos/openai/openai_adapter.py`.
- Audit found P1 Python risks:
  - `OPENAI_STORE` is read directly from `os.environ` in the adapter.
  - `GPTClient` erases explicit zero values with `or` defaults.
  - Protocol runtime subprocesses pass full `os.environ` to git commands.

## Implementation Status

Completed in the PR 2 audit-tooling slice:

- Added `scripts/continuous-audit.js` and restored `daemon-python/scripts/continuous_audit.py`.
- Added deterministic audit reporting for npm script targets, OpenAI constructor drift, Railway readiness observations, and Python audit status.
- Added classification metadata for each missing npm script target.
- Kept known raw OpenAI script constructors visible as explicit migration exceptions tied to `DEPRECATION.md`.
- No runtime behavior changes are authorized by this audit document.

Current PR 2 audit warning baseline:

- Missing npm script targets:
  - `db:init` -> `scripts/db-init.js`: rename expectation.
  - `db:patch` -> `scripts/schema-sync.js`: needs human decision.
  - `guide:generate` -> `scripts/generate-tagged-guide.js`: remove stale expectation.
  - `sync:auto` -> `scripts/auto-sync-watcher.js`: rename expectation.
  - `test:doc-workflow` -> `scripts/test-doc-workflow.js`: remove stale expectation.
- Known OpenAI migration exceptions:
  - `scripts/assistants-sync.ts`
  - `scripts/compare-finetune-checkpoints.ts`
  - `scripts/migration-repair.js`
- Current Python audit direct-env warnings:
  - `arcanos/cli/cli.py`
  - `arcanos/config_paths.py`
  - `arcanos/credential_bootstrap/env_utils.py`
  - `arcanos/openai/openai_adapter.py`
  - `arcanos/protocol_runtime/audit.py`
  - `arcanos/protocol_runtime/tools/repository_tools.py`
  - `arcanos/uninstall.py`
  - `arcanos/utils/config.py`

Still open after PR 2:

- Route ownership, legacy import, and generated/runtime artifact audit checks are not yet implemented in tooling.
- Python audit output is JSON only.
- Railway startup, TypeScript config facade, Python OpenAI fixes, job-result ownership, worker-helper gating, control-plane routing, worker lifecycle, retry policy, and failure classification remain unimplemented.

### Legacy and Generated Artifacts

- `legacy/**` is documented as read-only in existing docs and protected by boundary rules, but it is not safe to delete without owner sign-off and smoke tests.
- Some Python compatibility shims and generated/runtime artifacts have stronger deletion evidence, but deletion must still happen in isolated cleanup PRs after replacement tests.

## P1 Findings That Change PR Order

1. Job-result routes need auth/ownership before route migration.
   - Do not promote `/jobs/:id/result` or `/gpt-access/jobs/result` as canonical replacements until unauthorized, wrong-actor, and wrong-scope reads are rejected by tests.

2. OpenAI consolidation must be split.
   - First add modeled adapter methods and migrate broken scripts.
   - Then expand SDK guardrails to scripts, workers, runtime, and Python.
   - Do not remove raw SDK escape hatches until every current use has a tested adapter equivalent.

3. Railway startup must land before deploy.
   - Include validated port, explicit `0.0.0.0` host, `/ready` alias, `/readyz` compatibility, graceful shutdown, and web launcher alias-repair parity.

4. Worker lifecycle changes must be split.
   - First add invariant tests and compare-and-set repository APIs.
   - Then change terminal writes, lease recovery, cancellation, and retry semantics.

5. Python cleanup must wait for subprocess env sanitization.
   - Sanitize protocol runtime subprocess env before deleting Python shims or legacy files.

## Refactor Roadmap

### M0: Audit and Guardrails

- Add this audit report.
- Add `DEPRECATION.md`.
- Add deterministic read-only audit tooling with JSON and Markdown output for the TypeScript/Node side.
- Add static checks for missing npm script targets and raw OpenAI usage.
- Keep direct env access, route ownership, legacy imports, generated/runtime artifact scans, and Python Markdown output as future audit-tool work.

### M1: Startup, Config, and Route Safety

- Add a TypeScript config facade at `src/config/*` over the existing runtime config.
- Move web startup to validated config values for port and host.
- Add `/ready` as an alias over existing readiness behavior while preserving `/readyz`.
- Add web graceful shutdown and launcher parity tests.
- Add job-result auth/ownership tests before route migration.

### M2: Error, Retry, Job, and Worker Foundations

- Add canonical failure categories:
  - `auth`
  - `sdk_version_mismatch`
  - `control_plane_misroute`
  - `provider_error`
  - `timeout`
  - `rate_limit`
  - `network`
  - `validation`
  - `circuit_breaker`
  - `unknown`
- Add shared retry policy tests before changing worker scheduling behavior.
- Add job lifecycle state/transition invariants.
- Add lease fencing and terminal-write compare-and-set APIs after tests exist.

### M3: OpenAI and Control-Plane Consolidation

- Add missing modeled OpenAI adapter methods.
- Migrate scripts and runtime escape-hatch consumers one group at a time.
- Expand SDK guardrails only after current violations are migrated or explicitly allowlisted.
- Move control-plane approval checks before any Trinity/OpenAI planning.
- Redact public diagnostic model/config details and move detailed values behind authenticated control-plane diagnostics.

### M4: Python Parity and Evidence-Backed Cleanup

- Move Python env reads into config/env modules.
- Add `OPENAI_STORE` to Python config.
- Fix zero-value handling in `GPTClient`.
- Sanitize subprocess env in protocol runtime.
- Migrate stale Python tests into active `daemon-python/tests`.
- Delete only entries that have `DEPRECATION.md` evidence, tests, and owner sign-off.

## First 10 PRs

1. Audit artifacts: add `docs/refactor-audit.md` and `DEPRECATION.md`.
2. Audit tooling: add deterministic report schema, script-target existence checks, and dry-run-only audit output.
3. Railway startup foundation: validated host/port, `/ready` alias, graceful shutdown, launcher parity, and tests.
4. Job-result safety: lock down or document public `/jobs` policy, add ownership/scope checks and tests.
5. TypeScript config facade: introduce `src/config/*` over existing runtime config and migrate startup only.
6. Failure classifier: add canonical categories and mapping tests.
7. Retry policy: add shared retry policy and tests before worker behavior changes.
8. Job lifecycle tests and APIs: add invariant tests and compare-and-set repository APIs without broad schema migration.
9. OpenAI adapter coverage: add modeled adapter methods and migrate broken scripts/runtime calls.
10. OpenAI/control-plane guardrails: expand SDK guardrails, require explicit raw SDK allowlists, and enforce approval before model-backed control-plane planning.

## Required Safety Tests

- Job result access:
  - unauthenticated read denied
  - wrong actor denied
  - wrong tenant denied
  - missing GPT access result scope denied
  - matching actor/idempotency scope allowed
- Worker lifecycle:
  - stale worker completion rejected
  - old worker heartbeat rejected
  - terminal jobs immutable
  - cancellation plus retry does not requeue
  - retry exhaustion is terminal
  - dead-letter jobs have terminal reason
- Railway:
  - invalid `PORT`
  - bind host
  - `/health`
  - `/ready`
  - `/readyz`
  - `SIGTERM` close
  - web and worker launcher roles
- OpenAI:
  - no `_thenUnwrap`
  - no private parse helpers
  - Responses payload shape
  - model-from-config only
  - SDK mismatch classification
  - bad key classified as `auth`
- Python:
  - sanitized subprocess env excludes keys/tokens
  - `OPENAI_STORE` uses config
  - explicit zero generation values preserved
  - CLI/import smoke tests pass before deletion

## Validation Commands

Use focused validation per PR:

```powershell
node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false
npm run build:packages
npm run test:unit
npm run type-check
npm run lint
npm run validate:railway
```

Before release:

```powershell
railway status
```

Do not run `railway up` until validation and service role checks pass.
