# Arcanos Deprecation Ledger

Last updated: 2026-04-29

This ledger tracks deprecated, quarantined, and deletion-candidate paths. An entry here is not deletion approval. Deletion requires:

- import, route, runtime, test, or owner evidence
- replacement path
- tests listed in this file
- Reviewer/Critic sign-off for auth, OpenAI/GPT access, worker/queue lifecycle, Railway startup, Python protocol-boundary, or legacy cleanup changes

Status values:

- `Do not touch yet`
- `Needs runtime proof`
- `Deprecate first`
- `Keep but simplify`
- `Delete after evidence`
- `Deleted`

## legacy/**

- Deprecated path/module: `legacy/**`
- Why it exists: historical Python/CLI/agent modules moved out of active paths during monorepo cleanup.
- Replacement: active TypeScript services, `daemon-python/arcanos`, and documented CLI modules.
- Owner: legacy Python / CLI owners.
- Risk: hidden CLI or documentation consumers may still depend on files; broad deletion would erase historical context and break unknown workflows.
- Runtime evidence: existing docs describe `legacy/` as read-only, and production imports are restricted by boundary rules.
- Tests required before deletion: legacy import-boundary scan, active CLI smoke, backend CLI offline validation, docs/index update validation.
- Target removal date: TBD after owner sign-off.
- Status: Do not touch yet.

## /gpt/:gptId job status and result compatibility reads

- Deprecated path/module: job status/result compatibility behavior under `/gpt/:gptId`.
- Why it exists: compatibility path for existing GPT action and CLI clients.
- Replacement: authenticated, owner-scoped job status/result endpoints through approved GPT access or direct job routes.
- Owner: GPT access / job routes.
- Risk: premature removal breaks clients; premature migration to unauthenticated `/jobs/:id/result` risks cross-actor job-result disclosure.
- Runtime evidence: route and test coverage still codify `/gpt/:gptId` job status/result behavior.
- Tests required before deletion: unauthorized result denied, wrong actor denied, wrong tenant denied, missing result scope denied, matching actor/idempotency scope allowed, CLI migration tests.
- Target removal date: TBD after authenticated canonical route contract ships.
- Status: Deprecate first.

## Public or unauthenticated job result reads

- Deprecated path/module: any public job result/status read path without an ownership or tenant contract.
- Why it exists: existing job inspection and compatibility behavior.
- Replacement: authenticated result lookup with explicit scope and actor/idempotency ownership checks.
- Owner: GPT access / job routes.
- Risk: P1 cross-tenant or cross-actor job-result disclosure.
- Runtime evidence: reviewer audit identified `src/routes/jobs.ts` job result/status routes and `src/services/gptAccessGateway.ts` result lookup as needing ownership checks.
- Tests required before deletion or promotion: unauthenticated read denied, wrong actor denied, wrong tenant denied, token without result scope denied, scoped token for matching owner allowed.
- Target removal date: TBD after ownership model is implemented.
- Status: Needs runtime proof.

## Raw OpenAI SDK construction in scripts

- Deprecated path/module: raw `new OpenAI(...)` construction and direct SDK calls in script tooling.
- Why it exists: standalone migration, comparison, and assistant-sync scripts predate stricter adapter-only usage.
- Replacement: canonical `@arcanos/openai` construction or modeled OpenAI adapter methods.
- Owner: OpenAI adapter/tooling.
- Risk: bypasses credential handling, retry policy, telemetry, payload normalization, and SDK guardrails.
- Runtime evidence: read-only audit found direct SDK construction in `scripts/assistants-sync.ts`, `scripts/compare-finetune-checkpoints.ts`, and `scripts/migration-repair.js`.
- Tests required before deletion: script payload-shape tests, response parsing tests, model-from-config tests, raw SDK allowlist tests.
- Target removal date: TBD after modeled adapter methods exist.
- Status: Deprecate first.

## OpenAI adapter escape hatches

- Deprecated path/module: runtime use of raw OpenAI clients through adapter escape hatches.
- Why it exists: temporary compatibility for SDK surfaces not yet modeled by the adapter.
- Replacement: explicit adapter methods for Assistants, streaming, classifier, token/capability probes, and script tooling.
- Owner: OpenAI adapter/runtime.
- Risk: bypasses validation, budget tracking, metrics, response storage policy, and schema normalization.
- Runtime evidence: reviewer audit identified `clientBridge` and downstream raw SDK or `as any` usage.
- Tests required before deletion: adapter method tests for each migrated surface, raw SDK guardrail allowlist tests, no direct raw responses tests outside approved files.
- Target removal date: TBD after adapter surface coverage is complete.
- Status: Deprecate first.

## Broken npm script targets

- Deprecated path/module: stale `package.json` scripts pointing at missing files: `db:init`, `db:patch`, `guide:generate`, `sync:auto`, and `test:doc-workflow`.
- Why it exists: historical script entries outlived their script files or moved to differently named entrypoints.
- Replacement: `db:init` and `sync:auto` need renamed expectations to active targets; `guide:generate` and `test:doc-workflow` should be removed or replaced by documented workflows; `db:patch` needs an owner decision.
- Owner: repo tooling / database tooling / documentation tooling.
- Risk: operators and CI can invoke broken commands and assume validation or migration tooling exists when it does not.
- Runtime evidence: `scripts/continuous-audit.js` reports the five missing targets from `package.json`; the Audit Script Inspector classified each target in PR 2.
- Tests required before deletion or repair: script-target audit, plus command-specific smoke tests if a target is restored or renamed.
- Target removal date: TBD after owner decision for `db:patch`.
- Status: Needs runtime proof.

## Procfile Railway startup divergence

- Deprecated path/module: `Procfile` direct web/worker start commands.
- Why it exists: alternate deployment/startup path.
- Replacement: `scripts/start-railway-service.mjs` as the shared Railway launcher.
- Owner: deploy config.
- Risk: Procfile-based starts bypass role enforcement and worker health-server behavior.
- Runtime evidence: read-only Railway audit found `Procfile` starts `dist/start-server.js` and `dist/workers/jobRunner.js` directly.
- Tests required before deletion: deployment-path inventory, launcher web/worker role tests, Railway compatibility validation.
- Target removal date: TBD after confirming no non-Railway Procfile consumer.
- Status: Needs runtime proof.

## daemon-python/arcanos/utils/config.py

- Deprecated path/module: `daemon-python/arcanos/utils/config.py`.
- Why it exists: deprecated Python config shim with legacy env helper behavior.
- Replacement: `daemon-python/arcanos/config.py` and `daemon-python/arcanos/env.py`.
- Owner: daemon-python config.
- Risk: hidden env precedence can re-enter after Config-only migration.
- Runtime evidence: read-only Python audit found the file labels helpers deprecated and found no callers outside definitions.
- Tests required before deletion: Python import scan, active Python config tests, CLI import smoke.
- Target removal date: TBD after Python subprocess env sanitization and import smoke pass.
- Status: Delete after evidence.

## Python CLI re-export shims

- Deprecated path/module: `daemon-python/arcanos/cli_content.py`, `daemon-python/arcanos/cli_constants.py`, `daemon-python/arcanos/cli_intent_config.py`, `daemon-python/arcanos/cli_presenters.py`.
- Why it exists: backward-compatible re-export modules.
- Replacement: canonical `daemon-python/arcanos/cli/*`, `cli_ui`, or `cli_config` modules.
- Owner: Python CLI.
- Risk: hidden external imports may still exist even if repo imports are absent.
- Runtime evidence: read-only Python audit found these files state they are re-exports and repo search found no imports.
- Tests required before deletion: Python import graph scan, `python -m arcanos.cli` smoke, backend CLI offline validation.
- Target removal date: TBD after owner sign-off.
- Status: Delete after evidence.

## Transitional Python cli_*.py modules

- Deprecated path/module: active transitional `daemon-python/arcanos/cli_*.py` modules.
- Why it exists: CLI consolidation is incomplete.
- Replacement: canonical modules under `daemon-python/arcanos/cli/`.
- Owner: Python CLI.
- Risk: canonical CLI still imports some transitional modules.
- Runtime evidence: read-only Python audit found CLI consolidation docs call these transitional, but active CLI modules still import them.
- Tests required before deletion: move remaining logic under `arcanos/cli/`, CLI unit coverage, `python -m arcanos.cli` smoke.
- Target removal date: TBD after imports are migrated.
- Status: Do not touch yet.

## tests/test_daemon.py

- Deprecated path/module: root Python test `tests/test_daemon.py`.
- Why it exists: stale Python test outside active daemon-python test flow.
- Replacement: active tests under `daemon-python/tests`.
- Owner: Python tests.
- Risk: useful behavior coverage may be lost if not migrated first.
- Runtime evidence: read-only Python audit found CI and npm scripts run `daemon-python/tests`, while this file patches an old `arcanos.gpt_client.OpenAI` surface.
- Tests required before deletion: replacement GPTClient tests in `daemon-python/tests`, Python test run, import smoke.
- Target removal date: TBD after replacement tests land.
- Status: Delete after evidence.

## Tracked runtime and release artifacts

- Deprecated path/module: tracked runtime/release artifacts such as `memory/state.json`, `output/pdf/arcanos-app-summary.pdf`, `release/ARCANOS-Windows.zip`, `pr-comments.json`, and `arcanos_audit_config.json`.
- Why it exists: generated or local-state artifacts were committed historically.
- Replacement: templates, reproducible generation scripts, or ignored local output.
- Owner: repo hygiene.
- Risk: stale local state and generated outputs churn reviews or masquerade as source.
- Runtime evidence: read-only Python/legacy audit identified these tracked artifacts.
- Tests required before deletion: git hygiene check and confirmation that no build/test path requires committed artifacts.
- Target removal date: TBD after artifact ownership review.
- Status: Delete after evidence.

## Generated codebase indexes

- Deprecated path/module: `backend-index.json` and `cli-agent-index.json` as tracked source artifacts.
- Why it exists: generated indexes support codebase navigation.
- Replacement: regenerate via `scripts/reindex-codebase.js` or keep only checked docs with freshness validation.
- Owner: repo indexing.
- Risk: generated data can drift and be mistaken for reviewed source.
- Runtime evidence: read-only audit found `generatedAt` fields and a regeneration script.
- Tests required before deletion: choose retain-with-freshness-check or untrack-with-generation-docs, then validate `npm run reindex` or equivalent.
- Target removal date: TBD after repo indexing decision.
- Status: Needs runtime proof.
