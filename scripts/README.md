# Scripts Overview

This folder contains helper scripts for sync, deployment, debugging, audits, and maintenance.

## Backend URL precedence

When a script needs to call the backend, use this precedence:

1. `ARCANOS_BACKEND_URL`
2. `SERVER_URL`
3. `BACKEND_URL`

For one-time token flows, the backend must have `ARCANOS_AUTOMATION_SECRET` set. Optional header override: `ARCANOS_AUTOMATION_HEADER` (default: `x-arcanos-automation`).

## Sync and automation

- `cross-codebase-sync.js`
- `sync-helper.js`
- `auto-sync-watcher.js`
- `setup-auto-sync.js`
- `sync-github.ps1`
- `sync-with-github-keep-pr-changes.ps1`
- `sync-and-draft-pr-openai-wrapper.ps1`
- `pre-commit-sync-check.js`
- `schema-sync.js`
- `sync-config.json`

## Debug and health

- `daemon-debug.ps1`
- `smoke-dev-debug.ps1`
- `issue-confirm-token.ps1`
- `health_check.ps1`
- `probe.js`

## Deployment and backup

- `deploy-backend.ps1`
- `backup.ps1`
- `backup-workspace-to-d.ps1`
- `daemon-install-staging/` (staging assets and .env template)

## Database and migrations

- `db-init.js`
- `migration-repair.js`

## Docs and audits

- `doc_audit.sh`
- `continuous-audit.js`
- `generate-tagged-guide.js`
- `test-doc-workflow.js`

## OpenAI wrappers

- `arcanos-openai-wrapper.js`
- `assistants-sync.ts`
