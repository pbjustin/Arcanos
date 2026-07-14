# Scripts Guide

## Overview
This directory contains operational scripts for sync, diagnostics, migration, docs audit, and deployment helpers.

## Prerequisites
- Node.js and npm for `.js`/`.ts` scripts.
- PowerShell for `.ps1` scripts on Windows.
- Bash for `.sh` scripts in Unix-like environments.

## Setup
Run scripts from repository root unless script comments specify otherwise.

## Configuration
Backend URL precedence used by scripts that call backend APIs:
1. `ARCANOS_BACKEND_URL`
2. `SERVER_URL`
3. `BACKEND_URL`

Automation token flows require backend `ARCANOS_AUTOMATION_SECRET`.

## Run locally
Common scripts:
- `node scripts/probe.js`
- `./scripts/doc_audit.sh`
- `node scripts/validate-railway-compatibility.js`
- `node scripts/check-railway-timeout-regressions.js --since 30m --lines 400`
- `npm run validate:gpt:job-hardening` (safe dry run; reports `executed: false` and never reads ambient URL variables)
- `ARCANOS_GPT_ACCESS_TOKEN=<token> npm run validate:gpt:job-hardening -- --execute --allow-network --target preview --base-url "https://<service>-arcanos-pr-<N>.up.railway.app" --environment "Arcanos-pr-<N>" --service "ARCANOS V2" --worker-service "ARCANOS Worker"`

The live GPT job hardening validator requires both network flags and an explicit target triple. Preview environment and hostname PR numbers must match. Production additionally requires `--target production`, `--environment production`, `--allow-production`, and the repository-known production origin; never use that opt-in during PR validation.
- `npm run railway:alert:timeouts`
- `npm run railway:alert:budget-abort` (fails on any BUDGET_ABORT signal in the last 15 minutes)

Post-deploy behavior:
- `scripts/deploy-backend.ps1` now runs `npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort` automatically after `railway up`.

## Deploy (Railway)
- `scripts/deploy-backend.ps1` is available for manual PowerShell deployment workflows.

The older `scripts/continuous-audit.js` and `scripts/railway-set-secret.sh` command references are historical; those files are not present in this checkout.

## Known unavailable package-script targets
The root `package.json` still lists several scripts whose target files are missing in this checkout. Treat these as unavailable until their targets are restored or the package scripts are replaced:
- `db:patch` -> `scripts/schema-sync.js`
- `guide:generate` -> `scripts/generate-tagged-guide.js`
- `test:doc-workflow` -> `scripts/test-doc-workflow.js`
- `audit`, `audit:continuous`, `audit:sdk-compliance`, `audit:fix`, `audit:recursive`, `audit:railway`, `audit:full` -> `scripts/continuous-audit.js`
- `audit:python`, `audit:python:fix` -> `daemon-python/scripts/continuous_audit.py`
- `sync:auto` -> `scripts/auto-sync-watcher.js`

## Troubleshooting
- Script not found: confirm exact script name in this folder.
- Permission issues: run PowerShell/Bash with appropriate execution policy and permissions.
- Backend script failures: verify backend URL and auth secret env variables.

## References
- `../package.json`
- `../docs/RAILWAY_DEPLOYMENT.md`
- `../docs/CI_CD.md`
