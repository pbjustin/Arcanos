# Scripts Guide

## Overview
This directory contains operational scripts for sync, diagnostics, migration, docs audit, and deployment helpers.

## Prerequisites
- Node.js 20.19.0 and npm for JavaScript scripts and package-managed
  TypeScript entry points.
- PowerShell for `.ps1` scripts on Windows.
- Bash for `.sh` scripts in Unix-like environments.

## Setup
Run scripts from repository root unless script comments specify otherwise.

## Configuration
Scripts that call a backend do not share one universal URL or credential
precedence. Read the selected script's help and source before setting a target,
and always pass an explicit approved target for network-enabled operations.

Automation-token flows require the backend's `ARCANOS_AUTOMATION_SECRET`.

## Run locally
Common scripts:
- `npm run check:boundaries` (CEF layer-access policy plus TypeScript dependency-cycle gate)
- `npm run docs:check` (cross-platform documentation audit)
- `npm run docs:links -- --local-only` (maintained-document links without network access)
- `npm run docs:links` (bounded external-link audit; network access required)
- `./scripts/doc_audit.sh` (Bash compatibility wrapper)
- `node scripts/validate-railway-compatibility.js`
- `npm run check:native-pr-preview-imports` (build-blocking contained-preview import graph)
- `npm run test:native-pr-preview-e2e` (mocked, no-network runner contract)
- `npm run railway:probe:native-pr -- --pr-number <N> --commit-sha <LOCAL_HEAD_SHA> --web-base-url "https://<confirmed-web-pr-host>.up.railway.app" --worker-base-url "https://<confirmed-worker-pr-host>.up.railway.app"` (dry run)
- `node scripts/check-railway-timeout-regressions.js --since 30m --lines 400`
- `npm run validate:gpt:job-hardening` (safe dry run; reports `executed: false` and never reads ambient URL variables)
- `ARCANOS_GPT_ACCESS_TOKEN=<token> npm run validate:gpt:job-hardening -- --execute --allow-network --target preview --base-url "https://<service>-arcanos-pr-<N>.up.railway.app" --environment "Arcanos-pr-<N>" --service "ARCANOS V2" --worker-service "ARCANOS Worker"`

The live GPT job hardening validator requires both network flags and an explicit target triple. Preview environment and hostname PR numbers must match. Production additionally requires `--target production`, `--environment production`, `--allow-production`, and the repository-known production origin; never use that opt-in during PR validation.

The native PR probe is credential-free and never reads target URLs, tokens, or
fixture IDs from environment variables. Its dry run validates local HEAD, exact
HTTPS PR origins, the canonical Arcanos `origin`, a fully clean tracked and
untracked worktree, limits, and the fixed 65-request plan without network access.
For an authorized live preview, append both `--execute --allow-network`. The
runner performs sequential no-redirect requests with per-response, aggregate,
request-count, and time limits; it sends no bearer, capability, confirmation,
cookie, or session credential. Its attestation scope is the identity served by
the two pre-confirmed public hosts. It does not independently prove Railway
project/service/deployment ownership.

The 65 checks retain the original 50 health/readiness and synthetic generic-job
cases, add ten server-owned Research web contract fixtures and three Backstage
storyline web requests (two `lifecycle-exact` requests plus `payload-over`), and
prove the worker role denies both contract paths. Each fixture request body
contains only
`{ "fixture": "<sealed-name>" }`; no raw URL or credential is
sent. For the Research fixtures, the contained application imports only the
central `src/shared/researchRequest.ts` validator/storage-component helper, not
the normal Research route, confirmation middleware, hub, provider, fetcher,
database, memory, or persistence code. The fixtures cover inclusive and
over-limit non-BMP topic, URL count, URL item, and aggregate bounds, a normalized
URL snapshot isolated from later source mutation, and a deterministic ASCII
storage component of at most 97 UTF-8 bytes. They do not attempt confirmation or
effects. The descriptor probe is constructed inside the server-owned fixture and
does not claim that caller JSON can carry accessors or property descriptors.

The sealed `POST /backstage/storyline-contract` selectors are
`lifecycle-exact` and `payload-over`. `lifecycle-exact` calls the real storyline
validator, response selector, and repository transaction helper against a fresh
per-request in-memory query adapter. Its two mutations prove the exact
16,384-byte beat boundary, 100-beat retention, a fresh read, chronological
newest-25 selection, and accepted-beat inclusion. `payload-over` proves a
16,385-byte beat is rejected before the repository helper. This is a component
E2E only: it does not reach PostgreSQL or prove SQL-engine locking or atomicity;
the PostgreSQL 18 CI suite remains authoritative. The fixtures use no
credentials, provider, memory, confirmation, persistence effect, or protected
effect.

Native contained application previews protect trusted PRs against accidental
effects. They do not protect inherited secrets from malicious PR code; untrusted
or forked PR execution requires Railway-side secret isolation or trusted-source
gating before deployment.

`npm run job-events:timeline` invokes the shared database initializer before
querying. It can apply built-in schema DDL and write an initialization
heartbeat, so it is not a read-only validation command. Run it only with
explicit authorization and exact database-target confirmation.

- `npm run railway:alert:timeouts`
- `npm run railway:alert:budget-abort` (fails on any BUDGET_ABORT signal in the last 15 minutes)

Post-deploy behavior:
- `scripts/deploy-backend.ps1` now runs `npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort` automatically after `railway up`.
- `npm run railway:smoke:production -- --app-url https://<confirmed-web-service>.up.railway.app` requires the independently confirmed app origin, requests its fixed `/readyz` path, and rejects non-readiness `/health` payloads. It performs live Railway reads and an external request, so it requires exact-target read-only authorization plus a previously confirmed Railway project link. The helper does not change the locally selected environment; it selects the named environment explicitly for service-scoped reads and rejects an app origin that is not owned by the selected service.
- `scripts/verify-railway-readiness-activation.mjs` is the automatic deploy workflow's bounded exact-target verifier. It consumes the selected service's resolved Railway variables on standard input, requires matching project/environment/service identity, rejects a conflicting live `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` override, and directly requests `/readyz` for public roles. A private worker preserves Railway's exact-deployment activation evidence without being exposed solely for the check; effective provider-setting readback remains a separate promotion gate.

## Deploy (Railway)
- `scripts/deploy-backend.ps1` is available for manual PowerShell deployment workflows.
- It changes remote state. Use it only with explicit approval for the exact
  project, environment, service, revision, expected effect, and rollback.

The older `scripts/continuous-audit.js` and `scripts/railway-set-secret.sh` command references are historical; those files are not present in this checkout.

## Known unavailable package-script targets
The root `package.json` still lists several scripts whose target files are missing in this checkout. Treat these as unavailable until their targets are restored or the package scripts are replaced:
- `db:init` -> `scripts/db-init.js`
- `db:patch` -> `scripts/schema-sync.js`
- `guide:generate` -> `scripts/generate-tagged-guide.js`
- `test:doc-workflow` -> `scripts/test-doc-workflow.js`
- `audit`, `audit:continuous`, `audit:sdk-compliance`, `audit:fix`, `audit:recursive`, `audit:railway`, `audit:full` -> `scripts/continuous-audit.js`
- `audit:python`, `audit:python:fix` -> `daemon-python/scripts/continuous_audit.py`
- `sync:auto` -> `scripts/auto-sync-watcher.js`

The legacy root probe command was retired because it exposed credential prefixes
and depended on a missing test file. Use the focused validation commands
documented for the subsystem you changed; use `npm run validate:railway` for the
local, non-deploying Railway configuration check.

`self-test` and `daily-summary` use the compiled command entry points under
`dist/core/commands/` and therefore require a successful build. They execute
application diagnostic or summary behavior and are not substitutes for
read-only build and test validation.
`sync:fix` accepts its flag but does not currently apply a fix. `sync:setup`
writes Git hooks and may create local tooling directories; it is not a read-only
validation command.

## Troubleshooting
- Script not found: confirm exact script name in this folder.
- Permission issues: run PowerShell/Bash with appropriate execution policy and permissions.
- Backend script failures: verify backend URL and auth secret env variables.

## References
- `../package.json`
- `../docs/RAILWAY_DEPLOYMENT.md`
- `../docs/CI_CD.md`
