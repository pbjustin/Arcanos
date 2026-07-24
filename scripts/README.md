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
- `npm run docs:check` (cross-platform documentation audit)
- `./scripts/doc_audit.sh` (Bash compatibility wrapper)
- `node scripts/validate-railway-compatibility.js`
- `node scripts/check-railway-timeout-regressions.js --since 30m --lines 400`
- `npm run validate:gpt:job-hardening` (safe dry run; reports `executed: false` and never reads ambient URL variables)
- `ARCANOS_GPT_ACCESS_TOKEN=<token> npm run validate:gpt:job-hardening -- --execute --allow-network --target preview --base-url "https://<service>-arcanos-pr-<N>.up.railway.app" --environment "Arcanos-pr-<N>" --service "ARCANOS V2" --worker-service "ARCANOS Worker"`

The live GPT job hardening validator requires both network flags and an explicit target triple. Preview environment and hostname PR numbers must match. Production additionally requires `--target production`, `--environment production`, `--allow-production`, and the repository-known production origin; never use that opt-in during PR validation.

`npm run job-events:timeline` invokes the shared database initializer before
querying. It can apply built-in schema DDL and write an initialization
heartbeat, so it is not a read-only validation command. Run it only with
explicit authorization and exact database-target confirmation.

- `npm run railway:alert:timeouts`
- `npm run railway:alert:budget-abort` (fails on any BUDGET_ABORT signal in the last 15 minutes)

Post-deploy behavior:
- `scripts/deploy-backend.ps1` now runs `npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort` automatically after `railway up`.

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

Do not run `npm run probe`: its current implementation prints a prefix of
`OPENAI_API_KEY` and depends on a missing test file. Use the focused validation
commands documented for the subsystem you changed.

`self-test` and `daily-summary` point at incorrect compiled command paths.
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
