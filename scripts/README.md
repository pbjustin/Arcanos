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
- `node scripts/continuous-audit.js`
- `./scripts/doc_audit.sh`
- `node scripts/validate-railway-compatibility.js`

## Deploy (Railway)
- `scripts/railway-set-secret.sh` can help set Railway variables.
- `scripts/deploy-backend.ps1` is available for manual PowerShell deployment workflows.

## Troubleshooting
- Script not found: confirm exact script name in this folder.
- Permission issues: run PowerShell/Bash with appropriate execution policy and permissions.
- Backend script failures: verify backend URL and auth secret env variables.

## References
- `../package.json`
- `../docs/RAILWAY_DEPLOYMENT.md`
- `../docs/CI_CD.md`
