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
- Native PR environments use the configured `node scripts/start-railway-service.mjs --pr-preview-safe` override. The launcher accepts only the legacy exact `Arcanos-pr-<positive integer>` name or Railway's exact current `pr-<six hexadecimal characters>-<positive integer>` name, together with non-empty Railway project and environment IDs. It starts a passive health-only server without importing application, worker, provider, database, Redis, migration, or scheduler modules.
- A production-shaped worker-diagnostics E2E must not activate or reuse that
  native environment. Use an empty custom
  `worker-diagnostics-pr-<PR_NUMBER>-e2e` environment with environment-scoped
  web, worker, PostgreSQL, and Redis instances; fresh database and Redis
  volumes; preview-only purpose-bound credentials; `NODE_ENV=production`; and
  the normal launcher. Set `ARCANOS_PREVIEW_ISOLATION=true`, `FORCE_MOCK=true`,
  `ALLOW_MOCK_OPENAI=true`, `OPENAI_API_KEY_REQUIRED=false`, and a
  credential-free loopback `OPENAI_BASE_URL`. Prove every OpenAI key alias is
  absent before a live dispatch. Deploy web and worker from the connected
  GitHub branch, then independently attest the exact repository, branch,
  commit, deployment IDs, service IDs, environment ID, and temporary web
  domain through Railway before sending any purpose-bound credential. A
  `railway up` artifact upload is not sufficient for this proof because it does
  not supply Railway's Git-trigger provenance variables. Keep both data
  services private, give only the web service a temporary HTTPS domain, and
  delete the environment immediately after the bounded proof.
- The trusted
  [worker-diagnostics cleanup workflow](../.github/workflows/railway-worker-diagnostics-preview-cleanup.yml)
  is a merge/close backstop for that exact custom name. It never checks out PR
  code and deletes only after project, environment, and allowed-service
  validation. Configure its dedicated
  `RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN` secret with a token scoped only
  to the pinned Railway workspace. The workflow calls Railway's GraphQL API
  directly, requires account identity access to be denied, validates the exact
  workspace and project, and does not use Railway CLI linking; account-wide
  tokens and production environment project tokens are rejected. The
  introducing PR
  still requires exact-ID manual cleanup if it closes unmerged because its
  workflow is not yet on the default branch.
- Web services start the compiled API runtime with `ARCANOS_PROCESS_KIND=web` and `RUN_WORKERS=false`.
- Worker services expose a minimal health server and then start `dist/workers/jobRunner.js` with `ARCANOS_PROCESS_KIND=worker` and `RUN_WORKERS=true`.
- Database-backed startup passively inspects the configured and actual
  collation versions with one read-only catalog query. A mismatch is warning
  telemetry only: Railway startup does not run collation maintenance. Schedule
  any required maintenance separately against an explicitly confirmed
  database target under the operational approval gate.
- Importing shared GPT dispatch or worker configuration code does not start the separate in-process EventEmitter runtime. That runtime is bootstrapped only by the explicit local/direct API lifecycle when configured.
- The application keeps `/health`, `/healthz`, and `/readyz` available; Railway should probe `/health`. Public readiness responses are a sanitized, no-store dependency projection with stable status and failure codes. The credential-free `/railway/healthcheck` compatibility diagnostic is also a no-store bounded projection and omits worker filenames, checked filesystem paths, free-form reasons, and exception text; it is not the configured Railway deployment probe.
- The web listener binds before Redis initialization. `/health` and `/healthz` remain live during a Redis outage, while `/readyz` returns `503` until Redis reconnects; see `STARTUP_RESILIENCE.md`.
- `Procfile` remains in the repository as a historical fallback artifact and must not be treated as the canonical Railway start path.

Environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Required for live AI behavior. |
| `PORT` | Railway-managed | Automatically injected. |
| `NODE_ENV` | Railway-managed | Set to `production` by config. |
| `ALLOWED_ORIGINS` | Optional | Comma-separated exact HTTP(S) browser origins permitted to call the web service. Inventory every browser API and SSE caller before rollout. Omit to disable cross-origin browser access; same-origin and server-to-server requests remain available. |
| `ARCANOS_PROCESS_KIND` | Yes | `web` for the API service, `worker` for the async worker service. The launcher exits if missing or invalid. |
| `RUN_WORKERS` | Launcher-managed | Set by `scripts/start-railway-service.mjs` from `ARCANOS_PROCESS_KIND`. |
| `DATABASE_URL` | Required for async GPT jobs | Attach Railway PostgreSQL for persistence; web and worker services must share it. |
| `ARCANOS_GPT_ACCESS_TOKEN` | Required for protected `/gpt-access/*` routes | Strong bearer token stored only in Railway Variables and GPT Action auth. `/gpt-access/openapi.json` is public. |
| `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN` | Required on the web service when HTTP control-plane, AFOL decision/inspection, reinforcement feedback/inspection, protected DevOps/PR diagnostic execution, legacy SDK/orchestration control, `/api/self-heal/*`, `/api/self-improve/*`, detailed self-heal status, or CLI self-heal inspection is used | Exact purpose-bound bearer credential stored only in Railway Variables. It must remain distinct from approval, GPT Access, daemon, memory, worker-helper, automation, and other application credentials. Missing or invalid control-plane configuration fails closed with 503. |
| `ARCANOS_CONTROL_PLANE_PRINCIPAL_ID` | Required with the control-plane access token | Server-owned operator identifier used for HTTP control-plane attribution. Do not derive it from request fields. |
| `ARCANOS_CONTROL_PLANE_SCOPES` | Required with the control-plane access token | Grant only intended operations. AFOL health/log/analytics and root `/memory`, `/memory/digest`, and `/reinforcement/metrics` reads require `arcanos:read`; `/api/afol/decide` requires `mcp:invoke` plus its issued one-use challenge; `/reinforce`, `/audit`, and `/reinforcement/judge` require `mcp:invoke`. `/api/codebase/*` requires `repo:read`; direct PR analysis requires `repo:verify`; DevOps self-test/daily-summary execution requires `diagnostics:execute`; legacy SDK/orchestration reads require `arcanos:read`, while SDK mutations and orchestration reset/purge require `mcp:invoke` plus confirmation; prompt and AI-routing debug reads, self-heal reads, and detailed safety diagnostics also require `arcanos:read`; an active provider probe adds `self-heal:probe`; decisions require `self-heal:decide`; and `execute: true` adds `self-heal:execute`. Manual self-improve runs require both decision and execution scopes. Freeze, unfreeze, autonomy changes, and integrity-quarantine release require `self-improve:control`. Omit active grants unless the operator workflow explicitly needs them. |
| `PROMPT_DEBUG_TRACE_MODE` | Optional; defaults to `metadata` | Keep `metadata` in normal deployments. Use `off` to collect nothing. `full` can retain sensitive prompt and response prose after bounded redaction and should be enabled only for a short, approved diagnostic window. Invalid values fail closed to `off`. |
| `PROMPT_DEBUG_TRACE_PERSIST` | Optional; defaults to `false` | Only exact `true`, together with a valid byte cap, enables JSONL reads and writes. |
| `PROMPT_DEBUG_TRACE_MAX_BYTES` | Required only when persistence is enabled | Integer from 1,024 through 104,857,600. At capacity, new disk events are dropped without automatic truncation or rotation. |
| `PROMPT_DEBUG_EVENTS_PATH` | Optional | Selects the JSONL path only. Existing files can contain historical sensitive content and require separately approved operator cleanup. |
| `ARCANOS_DAEMON_ACCESS_TOKEN` | Required on the web service when `/api/daemon/*` is used | Exact 32–4096 character credential with no whitespace or placeholder text, distinct from every credential in the canonical ARCANOS application-auth registry. Store it only in Railway Variables and configure the identical value on the bundled Python daemon. Daemon requests send only `x-arcanos-daemon-token`; missing or invalid web configuration intentionally returns `503 DAEMON_AUTH_UNAVAILABLE`. Roll out the web and daemon settings together because registry, heartbeat, command, result, and confirmation requests all fail closed. This shared token blocks anonymous transport access but does not identify individual daemon instances. |
| `ARCANOS_MEMORY_ACCESS_TOKEN` | Required on the web service for protected memory/session APIs and exact GPT memory interception | Exact 32–4096 character credential with no whitespace or placeholder text, distinct from every credential in the canonical ARCANOS application-auth registry. Store it only in Railway Variables and deliver it to memory and `/api/sessions*` clients through the `x-arcanos-memory-token` header. Missing or invalid configuration intentionally returns `503 MEMORY_AUTH_UNAVAILABLE`; configure clients and the web service together during rollout. This deployment-wide token does not establish tenant ownership or per-session authorization. |
| `ARCANOS_WORKER_HELPER_TOKEN` | Optional; required for token-authenticated direct worker control and remote worker-helper repair | Exact 32–4096 character credential with no whitespace or placeholder text, distinct from every credential in the canonical ARCANOS application-auth registry. Store it only in Railway Variables. Inbound requests may use one custom-header or Bearer carrier; bundled-script and remote-actuator requests use only `x-arcanos-worker-helper-token`. Configure the identical value on both the calling service and target service. Direct worker run and direct worker heal also require separate action confirmation; both heal HTTP entry points share an authenticated-principal rate limit. |
| `SELF_HEAL_WORKER_SERVICE_URL` | Optional remote repair actuator origin | Explicit exact HTTPS origin for the target worker-helper HTTP service. Exact HTTP is accepted only for loopback, so deployed Railway targets must use HTTPS. Compatibility aliases are `WORKER_HELPER_BASE_URL`, `RAILWAY_SERVICE_ARCANOS_WORKER_URL`, and `ARCANOS_WORKER_PUBLIC_URL`; every configured alias must resolve to the same origin. |
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

The public worker-helper status command does not carry the worker-control token.
Protected helper commands fail locally when the caller's env-only credential is
missing, invalid, or colliding; there is no credential CLI flag. Credentialed
script and actuator requests reject redirects. Remote actuator status remains
unavailable for a missing token or any invalid/conflicting URL alias, and the
token is re-resolved immediately before fetch. Remote repair responses are
limited to 64 KiB of JSON and projected into an allowlisted result with a
locally generated message rather than forwarding target-controlled text or the
target response wholesale.

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

The tracked `.github/workflows/railway-auto-deploy.yml` can deploy one configured
service after successful CI on `main` or by manual dispatch. It skips automatic
CLI deployment when its Railway credentials or identifiers are absent.
Repository-connected Railway deployment and current web/worker service coverage
are environment-dependent and must be confirmed separately.

The workflow also runs a repository-owned coordinated-writer policy before the
production deployment job can enter its concurrency group. While
`ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD` contains the active
`20260727-dag-snapshot-generation-v1` ID, automatic `workflow_run` promotion is
skipped without starting or cancelling a deployment. A manual dispatch fails
unless the operator types the exact confirmation
`DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1`.

The repository policy cannot suppress Railway's separate GitHub-source
auto-deploy trigger. Before a coordinated migration reaches `main`, disable
native auto-deploy on every production DAG writer and verify the setting from
each service. For the current topology, that means both `ARCANOS V2` and
`ARCANOS Worker` must show **Auto deploy is disabled** while their running
deployments remain unchanged. Re-enable those triggers only after the
coordinated revision is accepted on every writer and the reviewed `none`
follow-up has restored the normal repository policy.

The typed phrase does not stop a process, apply a migration, validate a target,
or authorize production work. Before using it:

1. Obtain the normal target-specific deployment and database authorization.
2. Inventory every process capable of writing DAG snapshots, including all web
   replicas and any separately operated service.
3. Verify Railway-native auto-deploy remains disabled on every production
   writer so a source push cannot bypass the repository hold.
4. Drain or stop every writer and verify that an older binary cannot restart.
5. Confirm the compatible revision and migration are the approved rollout pair.
6. Dispatch the workflow only for the approved revision. The workflow deploys
   one configured `RAILWAY_SERVICE_ID`; coordinate every other writer through
   its separately approved mechanism.
7. Verify the installed schema, exact revision on every writer, absence of old
   replicas, deployment health, and bounded application diagnostics.

Keep the hold active if rollout or verification fails. Rollback also requires
all writers to remain stopped or compatible with the rolled-back schema. Only
after the coordinated rollout is accepted should a reviewed follow-up set the
workflow marker to the exact sentinel `none`. Missing, blank, or malformed
markers fail closed; `none` restores normal future automatic promotion.

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
- Repeated restarts: inspect the exact target's `/health`, `/healthz`, and `/readyz` responses and only the minimum sanitized Railway logs needed. `/readyz` intentionally omits raw root-cause text; correlate its stable codes with approved sanitized logs or authenticated control-plane evidence.
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
- Railway CLI docs: https://docs.railway.com/develop/cli
