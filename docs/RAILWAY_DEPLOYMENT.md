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
- Deploy activation path: `/readyz`
- Health check timeout: `300`
- SIGTERM-to-SIGKILL drain ceiling: `60` seconds
- Restart policy: `ON_FAILURE` (`restartPolicyMaxRetries=10`)

Launcher behavior:
- `node scripts/start-railway-service.mjs` is the canonical normal Railway start command.
- Native PR environments use the configured `node scripts/start-railway-service.mjs --pr-preview-app-safe-v1` override. The launcher accepts only the exact `Arcanos-pr-<positive integer>` or `pr-<six hexadecimal characters>-<positive integer>` environment names and validates Railway project, environment, service, deployment, source-commit, role, and public-domain identity before importing application code.
- The native PR web role starts `dist/start-native-pr-preview.js` directly, without registering runtime loader hooks, and gives it a nine-name child-environment allowlist containing only the version marker, derived PR/commit identity, role, listener, production mode, disabled-worker flag, and UTC timezone. It imports the real dependency-injected generic jobs router with immutable synthetic fixtures. Only fixed health/readiness and synthetic status/result/cancellation cases are reachable; queries, external credential carriers, streams, and every other route fail before parsing. The import graph is build-gated against database, provider, worker, metrics, confirmation, broad route registry, and other production side-effect modules. Its fail-closed syntax gate also rejects ambient capability aliases, dynamic/rest namespace access, listener aliases, unreviewed external bindings, mutable `process` state (including scalar-member writes) and whole-object escapes, unreviewed process effects, sensitive-helper extraction/export/reassignment, pre-validation local runtime import/re-export edges, and launcher declaration or spawn-spec drift. Whole-process-object calls are tied to unique declarations, containing functions, exact counts, and full-call AST digests; direct mutable-object receiver calls are conservative, the child `Object.keys` receiver is identity-constrained, the launcher-relative repository root is immutable, and the normal-runtime environment spread plus critical resolver/environment/listener/output helpers remain digest-pinned reviewed exceptions. The complete launcher and contained-child entry files are additionally pinned by comment/format-normalized semantic digests: any semantic edit anywhere in either privileged entry requires a reviewed digest and focused-test update, while comment-only and format-only edits do not.
- The native PR worker role remains the passive health-only server. The historical `--pr-preview-safe` flag remains available as an explicit passive fallback for both roles.
- Native application readiness reports `trustScope: trusted-pr-accidental-effects`, `protectsMaliciousPr: false`, and `requiresPlatformSecretIsolationForUntrustedCode: true`. Repository code cannot prevent a malicious PR from reading an inherited parent environment or removing its own guard. Do not enable native application previews for forks or untrusted contributors unless Railway prevents production/provider/database/Redis credentials and data from reaching the PR container before code starts.
- `npm run railway:probe:native-pr -- --pr-number <N> --commit-sha <SHA> --web-base-url https://<confirmed-web-pr-host> --worker-base-url https://<confirmed-worker-pr-host>` performs a no-network dry run. It fails unless the canonical Arcanos `origin`, local HEAD, and an entirely clean tracked/untracked worktree match the supplied commit evidence. Add both `--execute --allow-network` only after independently confirming those two hosts. The live runner makes 50 bounded, sequential, credential-free, no-redirect requests and reports served-public-identity evidence; it does not assert Railway control-plane ownership.
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
- The application keeps `/health`, `/healthz`, and `/readyz` available; Railway uses `/readyz` for deployment activation, `/healthz` remains liveness, and `/health` remains dependency diagnostics. Public readiness responses are a sanitized, no-store dependency projection with stable status and failure codes. The credential-free `/railway/healthcheck` compatibility diagnostic is also a no-store bounded projection and omits worker filenames, checked filesystem paths, free-form reasons, and exception text; it is not the configured Railway deployment probe.
- The web listener binds before Redis initialization. `/health` and `/healthz` remain live during a Redis outage, while `/readyz` returns `503` until Redis reconnects; a new revision therefore cannot activate during that outage. Railway does not continuously monitor the activation path after the first successful response; see `STARTUP_RESILIENCE.md`.
- Worker `/readyz` remains `503` until database/autonomy/module-registry bootstrap and every configured consumer slot's dispatcher-start write complete, and a supported OpenAI key setting is present. The child communicates that transition through an exact newline-delimited protocol independent of `LOG_LEVEL`; stderr and embedded marker-like text cannot activate readiness. It does not perform a paid provider request; transient provider failure after activation is handled through the worker's probe/backoff and job-deferral path.
- Numeric `deploy.drainingSeconds=60` is the shared platform outer bound. The web runtime has a 10-second internal shutdown deadline. On a worker shutdown signal, the launcher immediately returns readiness `503` before forwarding the signal; the child then aborts provider work, leaves live claims for lease recovery, stops polling/heartbeats, and flushes runtime snapshots. The default 45-second lease-recovery horizon begins as old heartbeats cease and may complete in the new revision; the drain value does not itself guarantee that recovery. Sixty seconds gives the cooperative handlers a nonzero cleanup envelope, but stalled database I/O and real claim recovery still require a measured deployment rehearsal before promotion.
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

GitHub must provide `RAILWAY_PRODUCTION_PROJECT_TOKEN` as a Railway project
token dedicated to the exact production project/environment; an
account/workspace API token is not an acceptable substitute. The workflow
exposes that secret as `RAILWAY_TOKEN` only to its access probe, deployment,
status polling, and post-deploy log-check steps. All reusable Actions are
commit-pinned. Railway CLI `4.30.2` is downloaded from the exact upstream GNU
release archive, verified against SHA-256
`e8bd57fd6517b5cf387a9c072ce79fdc069fc0b877c171b58e325b22e96c9000`
before extraction, and checked for exact version output before use.

Provider-side token scope must be verified independently before this path is
enabled or dispatched; tracked workflow code cannot inspect that scope safely.
The deploy checkout's persisted read-only GitHub credential and a feasible
protected GitHub environment/approval topology are separate defense-in-depth
and repository-settings decisions, not guarantees provided by these workflow
controls.

The production job is limited to 60 minutes and serializes through the
`railway-auto-deploy-production` concurrency group without cancelling a run
that has already started. A newer run waits while the active observer finishes;
GitHub may still coalesce older runs that remain pending.

The workflow captures the exact deployment ID returned by its own detached
upload and observes deployment history for that ID only. Upload is bounded to
10 minutes, exact-deployment observation to 45 elapsed minutes with ten-second
polling, and every Railway status or variable subprocess has an explicit
timeout and output cap. After that deployment reaches Railway `SUCCESS`, the
workflow reruns the static Railway validator and rereads the same
service/environment status, requiring that exact deployment to remain the
active successful and non-stopped deployment. It also reads the exact target's
resolved identity, rejects identity or live drain-variable drift, and makes a
bounded, no-redirect `/readyz` request when that role has a public domain. A
private worker retains Railway's first-200 activation result instead of being
exposed solely for the workflow. Post-deploy log retrieval is limited to 30
seconds and 4 MiB. This is one-time activation evidence, not continuous health
monitoring or effective provider-setting readback.

The detached upload remains a remote mutation. If upload times out before an ID
is returned, the workflow is manually cancelled, the runner is lost, or an
exact deployment remains nonterminal past the observer budget, it may continue
remotely without the remaining activation checks. Reconcile that residual
manually against the exact project, environment, service, and revision. The
workflow intentionally does not call `railway down`, which cannot safely
contain the captured in-flight deployment by exact ID.

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
4. Before deployment, read the exact web and worker service settings or
   deployment details. Each role must resolve `healthcheckPath=/readyz`,
   `healthcheckTimeout=300`, and `drainingSeconds=60`. Config-as-code overrides
   dashboard settings for a deployment without rewriting the dashboard value,
   so use the effective deployment details rather than assuming an old
   dashboard value is authoritative.
5. After deployment, confirm the fresh targeted deployment ID and `SUCCESS`
   status. For a confirmed public web target, make the bounded readiness
   request below. A manual request is read-only but still requires a confirmed
   target:

```bash
curl --fail --max-time 15 https://<your-service>.up.railway.app/readyz
```

The production smoke helper uses this same fixed path and rejects the
non-readiness `/health` dependency-diagnostic response schema:

```bash
npm run railway:smoke:production -- --app-url https://<confirmed-web-service>.up.railway.app
```

That helper reads Railway topology, variables, and logs and makes a live network
request. It is not routine local validation; run it only with exact-target
read-only authorization after confirming the checkout's linked Railway project.
The explicit `--app-url` is required and must match a Railway-owned domain from
the selected app service. The helper does not change the locally selected
environment; it selects the named environment explicitly for service-scoped
reads. The automatic workflow separately invokes
`scripts/verify-railway-readiness-activation.mjs` with the exact target's
resolved Railway variable projection. It rejects a conflicting
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` value when present. A private worker needs
no public domain solely for this check, but its exact Railway `SUCCESS` and the
tracked contract do not replace the effective `/readyz`/timeout/drain readback
required above.

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
