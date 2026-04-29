# Arcanos Deprecation Register

Status: initial register
Date: 2026-04-29

This file tracks legacy, compatibility, and deletion-candidate code. Nothing listed here is approved for immediate source deletion unless `status` explicitly says `delete approved` and the evidence columns are complete.

## Policy

- Do not delete code based only on appearance, age, or naming.
- Every deletion requires import, route, runtime, test, or owner evidence.
- Prefer deprecate, quarantine, and monitor before removing behavior.
- Protected, privileged, queue, worker, GPT access, and OpenAI paths require reviewer approval before removal or rewrite.

## Register

| Deprecated path/module | Why it exists | Replacement | Owner | Risk | Runtime evidence | Tests required before deletion | Target removal date | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `legacy/` | Historical Python CLI and agent core code moved during monorepo refactor. Existing docs say this tree is read-only. | `daemon-python/`, `packages/cli`, `packages/protocol` | Python/CLI | Medium: possible unpublished local import paths. | Docs mention read-only; production no-import rule is documented but deletion needs fresh import/runtime scan. | Import graph scan, packaging smoke, CLI contract tests, Python daemon tests. | 2026-07-31 | Needs runtime proof |
| `/brain` route in `src/routes/ask/index.ts` | Compatibility route for old ask-style callers. Defaults to gone mode unless `ASK_ROUTE_MODE=compat`. | `/gpt/:gptId` for GPT writing traffic; direct endpoints for control reads. | GPT routing | Medium: old clients may depend on compatibility mode. | Docs and route code identify deprecation and `410 Gone` default. | Legacy route tests, canonical GPT route tests, migration telemetry review. | 2026-06-30 | Deprecate first |
| `/api/arcanos/ask` in `src/routes/api-arcanos.ts` | Deprecated compatibility envelope for historical API callers. | `/gpt/:gptId` or direct control endpoints by operation type. | API/GPT routing | Medium: external callers may still use the old envelope. | Route code emits deprecated endpoint metadata. | API compatibility tests, access logs/telemetry review, owner approval. | 2026-07-31 | Deprecate first |
| Legacy GPT route adapters in `src/routes/_core/legacyGptCompat.ts` and `src/routes/_core/legacyRouteAdapters.ts` | Supports compatibility dispatch for legacy route names. | Canonical route dispatch through `/gpt/:gptId` and direct control endpoints. | GPT routing | Medium: removing too early can break compatibility routes. | Imported by route modules for compatibility behavior. | Route manifest diff, legacy route tests, no production caller evidence. | 2026-08-31 | Keep but simplify |
| `Procfile` | Historical process declaration for web/worker. | `railway.json` + `scripts/start-railway-service.mjs` with explicit `ARCANOS_PROCESS_KIND`. | Deployment | Medium: if any Heroku/Procfile workflow exists, deletion changes startup. | Verified `railway.json` and Dockerfile use the launcher; `Procfile` bypasses it. | Extend `validate:railway`, confirm no Procfile deploy path, deployment owner approval. | 2026-06-15 | Delete candidate after proof |
| `src/middleware/confirmGate.ts` and `src/middleware/capabilityGate.ts` re-export shims | Compatibility imports for older middleware paths. | `src/transport/http/middleware/*` | HTTP transport/auth | Low to medium: imports may remain in source/tests. | Re-export shims exist; no deletion evidence yet. | Import graph scan, route/auth tests. | 2026-07-31 | Keep but simplify |
| Python backend job status/result compatibility methods using `/gpt/:gptId` | Compatibility bridge for older daemon callers. | Canonical `/jobs/:id`, `/jobs/:id/result`, or `/gpt-access/jobs/*`. | Python backend client | High: violates direct endpoint rule if used for job lookup. | Verified methods post `get_status`/`get_result` to GPT route while canonical methods also exist. | Negative test that job lookups never hit `/gpt`; migrate Python tests/callers. | 2026-06-30 | Deprecate first |
| Multiple worker runtimes: DB worker, in-process runtime, `workers/`, `arcanos-ai-runtime` | Historical and experimental worker paths coexist. | One documented active worker lifecycle model. | Worker runtime | High: wrong deletion can break deployment or async jobs. | Verified multiple entrypoints exist; active ownership differs by path. | Runtime entrypoint scan, package script scan, Railway config review, worker test suites. | 2026-09-30 | Needs runtime proof |
| `src/server/bootstrap.ts` GPT5 registration bootstrap | Appears to export startup registration behavior. | Current startup path through `src/server.ts`, `src/app.ts`, and OpenAI initialization. | Server bootstrap | Medium: may be stale, but removal could affect unpublished importers. | Search found export but no active startup invocation in the first audit. | Import graph scan, startup/GPT registry tests. | 2026-07-31 | Needs runtime proof |

## Deletion Evidence Checklist

- No production import or only explicit deprecated imports remain.
- No registered route depends on the module.
- No package script, Railway config, Dockerfile, Procfile, or runtime entrypoint depends on it.
- Tests prove replacement behavior.
- Logs or owner review confirm no active caller where runtime evidence is required.
- Reviewer/Critic approval exists for auth, queue, worker, OpenAI, GPT access, and control-plane changes.
