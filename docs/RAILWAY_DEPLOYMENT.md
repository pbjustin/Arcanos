# Railway Deployment Guide

## Overview
This runbook documents the repository-tracked Railway configuration and release safeguards for Arcanos. Tracked files do not prove the current live project linkage, environment state, or service topology.

## Prerequisites
- Approved Railway account and project access.
- A confirmed project, environment, and service target.
- Repository connection or GitHub-side deploy credentials configured through an approved operator workflow.
- Required secrets available (`OPENAI_API_KEY`; `DATABASE_URL` for durable async jobs; GPT Access variables when Custom GPT diagnostics are enabled).

## Setup
Run repository commands from the repository root. The install step recreates dependency state and invokes `postinstall`; outside CI/production, that hook may update local Git hooks, `.vscode/`, and `.workspace/`.

Pre-deploy checks, when their local side effects are acceptable:
```bash
npm ci --include=dev --no-audit --no-fund
npm run build
npm test
npm run validate:railway
```

`npm run validate:railway` validates tracked configuration locally. It does not inspect or validate a live Railway environment.

Railway project setup is an operator-only remote configuration change:
1. Create/select a Railway project.
2. Connect this GitHub repository.
3. Confirm Railway detected `railway.json`.

Apply the operational approval gate below before changing project or repository linkage.

## Configuration
Tracked Railway config (source: `railway.json`):
- Build: `npm ci --include=dev --no-audit --no-fund && npm run build`
- Start: `node scripts/start-railway-service.mjs`
- Deploy health check path: `/health`
- Health check timeout: `300`
- Restart policy: `ON_FAILURE` (`restartPolicyMaxRetries=10`)

Launcher behavior:
- `node scripts/start-railway-service.mjs` is the canonical normal Railway start command.
- Native PR environments use the configured `node scripts/start-railway-service.mjs --pr-preview-safe` override. It starts a passive health-only server without importing application, worker, provider, database, Redis, migration, or scheduler modules.
- Web services start the compiled API runtime with `ARCANOS_PROCESS_KIND=web` and `RUN_WORKERS=false`.
- Worker services expose a minimal health server and then start `dist/workers/jobRunner.js` with `ARCANOS_PROCESS_KIND=worker` and `RUN_WORKERS=true`.
- The application keeps `/health`, `/healthz`, and `/readyz` available; Railway should probe `/health`.
- The web listener binds before Redis initialization. `/health` and `/healthz` remain live during a Redis outage, while `/readyz` returns `503` until Redis reconnects; see `STARTUP_RESILIENCE.md`.
- `Procfile` remains in the repository as a historical fallback artifact and must not be treated as the canonical Railway start path.

Environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Required for live AI behavior. |
| `PORT` | Railway-managed | Automatically injected. |
| `NODE_ENV` | Railway-managed | Set to `production` by config. |
| `ARCANOS_PROCESS_KIND` | Yes | `web` for the API service, `worker` for the async worker service. The launcher exits if missing or invalid. |
| `RUN_WORKERS` | Launcher-managed | Set by `scripts/start-railway-service.mjs` from `ARCANOS_PROCESS_KIND`. |
| `DATABASE_URL` | Required for async GPT jobs | Attach Railway PostgreSQL for persistence; web and worker services must share it. |
| `ARCANOS_GPT_ACCESS_TOKEN` | Required for protected `/gpt-access/*` routes | Strong bearer token stored only in Railway Variables and GPT Action auth. `/gpt-access/openapi.json` is public. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | Required for GPT Action import | Public HTTPS origin advertised by `/gpt-access/openapi.json`; do not rely on request headers in production. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Required for protected GPT access | Grant only the scopes needed by the intended operations. Async job submission and result retrieval use `jobs.create,jobs.result`; add other read, recovery, or capability scopes only when intentionally enabled. |
| `GPT_ACCESS_NL_DISPATCH_MODE` | Optional, web service only | When unset, `/gpt-access/dispatch/run` uses `hybrid` if the web service has a real resolved OpenAI key and `rules` otherwise. Valid values are `rules`, `hybrid`, and `llm_first`; invalid values resolve to `rules`. Set `rules` to force deterministic dispatch. |
| `GPT_ACCESS_DISPATCH_MODEL` | Optional | Defaults to `gpt-4.1-mini`; used only by the semantic dispatch planner. |
| `GPT_ACCESS_DISPATCH_LLM_TIMEOUT_MS` | Optional | Defaults to `5000` and caps at `10000`; timeout/failure never executes an LLM plan and can only fall back through deterministic rules and policy checks. |
| `ARC_LOG_PATH` | Optional | Defaults to `/tmp/arc/log`. |
| `GPT_FAST_PATH_ENABLED` | Optional | Defaults to `true`; disables inline prompt-generation fast path when set to `false`. |
| `GPT_FAST_PATH_MODEL` | Optional | Defaults to `gpt-4.1-mini`; use a low-latency model for inline fast-path requests. |
| `GPT_FAST_PATH_TIMEOUT_MS` | Optional | Defaults to `8000`; inline model timeout for fast-path requests. |
| `GPT_FAST_PATH_GPT_ALLOWLIST` | Optional | Comma-separated GPT IDs allowed to use fast path; empty means all GPT IDs. |

Environment separation:
- `railway.json` defines `production` and `development` variable blocks.
- Keep secrets per environment in Railway Variables.
- Configure separate Railway services for web and worker when async GPT jobs must complete in the background.
- `GPT_ACCESS_*` natural-language dispatch variables do not change or recycle the worker service. Worker recycle/recover dispatch uses registered privileged actions, requires explicit `workers.recover` scope plus confirmation, and reclaims stale queue jobs through the approved recovery runner.
- Dispatch confidence thresholds are fixed code policy, not Railway variables: readonly `0.65`, privileged `0.78`, and destructive `0.90`.
- Confirm each service role through an approved control plane against the exact project, environment, and service. Do not reproduce raw variable output in reports.

## Run locally

Use the build, test, and `validate:railway` checks above for non-deploying validation. Do not start the application with Railway or production variables as a deployment check.

A separately approved local runtime check must use a deliberately isolated effective environment with no inherited Railway-management, provider, Redis, queue, or remote-database credentials. Database resolution accepts `DATABASE_PRIVATE_URL`, `DATABASE_URL`, `DATABASE_PUBLIC_URL`, or a complete `PGUSER`/`PGPASSWORD`/`PGHOST`/`PGPORT`/`PGDATABASE` set. When any candidate resolves successfully, startup can execute DDL and write a heartbeat.

## Deploy (Railway)

The tracked `.github/workflows/railway-auto-deploy.yml` can deploy one configured service after successful CI on `main` or by manual dispatch. It skips automatic CLI deployment when its Railway credentials or identifiers are absent. Repository-connected Railway deployment and current web/worker service coverage are environment-dependent and must be confirmed separately.

A push or manual workflow dispatch can therefore be deployment-affecting. Before triggering either:

1. Confirm the approved release mechanism, exact revision, project, environment, and every web/worker service in scope.
2. Review the expected deployment effect and rollback.
3. Obtain explicit operator approval.
4. After deployment, confirm the targeted deployment status and the configured `/health` endpoint. A manual health request is read-only but still requires a confirmed target:

```bash
curl https://<your-service>.up.railway.app/health
```

### Railway command safety

- Local static validation: `npm run validate:railway` reads tracked configuration and does not contact Railway. Builds and tests may create local artifacts.
- Remote observation: status, targeted variable inspection, targeted logs, and health requests do not intentionally change Railway state, but depend on the current target and can expose identifiers, variable values, request data, or other sensitive output. Confirm the exact project, environment, and service; minimize output and report only sanitized evidence.
- Local CLI state: authentication, project linking, and environment selection change local credential or target state. Do not perform them as routine validation.
- Operational actions: variable changes, deployments, restarts, redeployments, rollbacks, database attachment, remote runtime commands, and live probes can change Railway, application, provider, queue, or database state.

Before any operational action, obtain explicit approval recording:

- Exact command or operator action.
- Project.
- Environment.
- Service.
- Expected effect.
- Rollback plan.

Use `not applicable` rather than omitting a field. Never use `railway run ... npm run dev` as validation: it starts the backend with Railway variables and can execute DDL or write a heartbeat against the configured database.

The `railway:probe:fast-path` and `railway:probe:async` scripts are live operations, not routine post-deploy checks. The fast-path probe invokes the live provider path; the async probe can create and process a durable job. Bare invocation is forbidden because both scripts default to a hard-coded production origin. Each requires separate, target-specific approval and an explicit `--base-url` matching the approved target.

Rollback:
1. Treat rollback as a state-changing production operation and satisfy the approval gate.
2. In the confirmed target's deployment history, identify the last known-good deployment.
3. Redeploy only the approved version, then observe the targeted health and deployment status.

## Troubleshooting
- Build fails: run `npm ci --include=dev --no-audit --no-fund && npm run build` locally first.
- Launcher fails with `ARCANOS_PROCESS_KIND is required`: verify that the exact API service is configured as `web` or the exact worker service as `worker`. Changing the value requires operational approval.
- Repeated restarts: inspect the exact target's `/health`, `/healthz`, and `/readyz` responses and only the minimum sanitized Railway logs needed.
- App boots without AI output: verify through an approved control plane that `OPENAI_API_KEY` is present without printing its value. Changing it requires operational approval.
- Persistence degraded: verify the approved database attachment and `DATABASE_URL` target. Attaching a database or changing the variable requires operational approval.
- Async jobs stay queued: verify the approved worker deployment, role, shared database target, provider key presence, and the web service scopes `jobs.create,jobs.result`. Deployment or variable changes require operational approval.
- Custom GPT cannot import or calls the wrong host: verify the public web-service origin. Changing `ARCANOS_GPT_ACCESS_BASE_URL` or redeploying requires operational approval.

## References
- `../railway.json`
- `CONFIGURATION.md`
- `CI_CD.md`
- `RAILWAY_RATIONALE.md`
- Railway docs: https://docs.railway.com/
