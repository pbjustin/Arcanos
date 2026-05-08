# ARCANOS GPT Access Gateway

The GPT access gateway exposes scoped, authenticated backend/control-plane access under `/gpt-access/*`. It is intentionally separate from `/gpt/:gptId` so protected job creation, job result lookup, runtime inspection, worker status, queue inspection, MCP diagnostics, and sanitized log reads do not enter the public writing route as prompt-shaped requests.

Use environment-specific base URLs in examples:

```bash
export ARCANOS_BASE_URL="http://localhost:3000"
```

PowerShell:

```powershell
$env:ARCANOS_BASE_URL = "http://localhost:3000"
```

For deployed environments, set `ARCANOS_BASE_URL` to that service's HTTPS origin. Do not hard-code production URLs into reusable docs or scripts.

For Custom GPT OpenAPI metadata, the gateway derives the server URL from `ARCANOS_GPT_ACCESS_BASE_URL` first, then `ARCANOS_BASE_URL`, `ARCANOS_BACKEND_URL`, `SERVER_URL`, `BACKEND_URL`, public Railway URL/domain variables, or a local development request origin. Railway PR previews advertise their Railway preview URL variables before inherited production URLs. Non-local request hosts are ignored so public metadata cannot be poisoned by spoofed headers. Set `ARCANOS_GPT_ACCESS_BASE_URL` in stable deployments when the gateway is reached through a public origin.

## Authentication
Protected `/gpt-access/*` operations require bearer auth. `/gpt-access/openapi.json` is public metadata so GPT Action import can retrieve the schema, but every protected operation in that schema still declares bearer auth:

```bash
Authorization: Bearer <ARCANOS_GPT_ACCESS_TOKEN>
```

`ARCANOS_GPT_ACCESS_TOKEN` must be set out of band in the runtime environment or in the Custom GPT Action authentication field. Do not paste the token into chat, source, docs, logs, or shell history.

`ARCANOS_GPT_ACCESS_SCOPES` is a comma-separated allowlist. `jobs.create`, `capabilities.read`, and `capabilities.run` are special: they must be listed explicitly before `/gpt-access/jobs/create` can enqueue work, capability discovery can enumerate modules, or `/gpt-access/capabilities/v1/{id}/run` can execute a module action. Capability runs also require the existing `MCP_ALLOW_MODULE_ACTIONS` module-action allowlist and the confirmation gate (`x-confirmed: yes` or a confirmation challenge token).

Recommended scopes for the protected Trinity async flow:

```bash
ARCANOS_GPT_ACCESS_SCOPES=runtime.read,workers.read,queue.read,jobs.create,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read
```

Optional capability discovery and direct action execution:

```bash
ARCANOS_GPT_ACCESS_SCOPES=capabilities.read,capabilities.run
MCP_ALLOW_MODULE_ACTIONS=ARCANOS:CORE:query
```

## Optional ARCANOS:CLI Capability
`ARCANOS:CLI` is disabled by default but remains visible in `GET /gpt-access/capabilities/v1` with `enabled:false` when `ARCANOS_CLI_BRIDGE_ENABLED` is not `true`. It is a control-plane capability under `/gpt-access/capabilities/v1`, not a `/gpt/:gptId` writing-plane route.

Actions:

| Action | Confirmation | Behavior |
| --- | --- | --- |
| `status` | No | Reports `enabled`, `daemonReachable`, `mode`, `policyLoaded`, `sandboxRoot`, and `version`. |
| `policy` | No | Returns safe policy metadata only. |
| `repoContext` | No | Calls read-only Python protocol repo tools such as `repo.getStatus`, `repo.search`, and `doctor.implementation`. |
| `proposeCommand` | No | Validates command intent and returns a proposal; it never executes. |
| `runApprovedCommand` | Yes | Executes only after the confirmation challenge retry, policy approval, and matching `proposalId`. |
| `proposePatch` | No | Validates patch intent and returns a proposal; it never applies. |
| `applyApprovedPatch` | Yes | Applies only after the confirmation challenge retry, patch policy approval, and matching `proposalId`. |
| `tailAudit` | No | Reserved for bounded sanitized audit metadata; current implementation returns an unavailable placeholder. |

The bridge uses the local Python daemon HTTP bridge at `ARCANOS_CLI_BRIDGE_URL` and expects it to bind to `127.0.0.1` by default. Production Railway attaches the daemon only inside the web service container when `ARCANOS_CLI_BRIDGE_ENABLED=true`; the launcher starts `python3 -m arcanos.cli.local_bridge` as a loopback-only child process and does not expose it as a public Railway service. If the daemon is unavailable, `status` can report `enabled:true`, `daemonReachable:false`, and `mode:"localhost-http-python-daemon"` without crashing the backend. Command and patch POSTs require `ARCANOS_CLI_BRIDGE_TOKEN` between the TypeScript gateway and local daemon; confirmation tokens still belong only at the top level of the GPT Access request, never inside action payloads. Command and patch operations are constrained by the shared `config/cli-policy.json` allowlists, deny patterns, cwd sandboxing under `ARCANOS_CLI_SANDBOX_ROOT`, timeouts, output caps, redaction, patch safety rules, and audit records. Secrets, authorization headers, cookies, private keys, OpenAI keys, Railway tokens, database URLs, and `.env` contents must not be emitted in logs or outputs.

Daemon-side execution also validates the same `proposalId` against the exact command or patch and resolved cwd before running. The local bridge accepts only loopback hosts, token-authenticated `application/json` POSTs, bounded body sizes, and sanitized deterministic JSON errors. Patch history stores hashes, file summaries, approval state, timestamps, backups metadata, and redacted previews; raw patch text is not stored.

On `CONFIRMATION_REQUIRED`, retry the same `/gpt-access/capabilities/v1/ARCANOS:CLI/run` request once with the same `action` and `payload` plus top-level `confirmation_token`. Do not put confirmation tokens inside `payload`. Approval payloads for `runApprovedCommand` and `applyApprovedPatch` must include the `proposalId` returned by the matching proposal action.

Production Railway setup:

| Variable | Safe setting |
| --- | --- |
| `ARCANOS_CLI_BRIDGE_ENABLED` | `true` to attach the daemon, `false` to disable it. |
| `ARCANOS_CLI_BRIDGE_URL` | `http://127.0.0.1:8765`; never use public, private-network, or `0.0.0.0` URLs. |
| `ARCANOS_CLI_BRIDGE_TOKEN` | Required secret value; set through Railway variables and never print it. |
| `ARCANOS_CLI_SANDBOX_ROOT` | `/app` or a narrower workspace path inside the container. |
| `ARCANOS_WORKSPACE_ROOT` | `/app` or the same narrower workspace path. |
| `ARCANOS_CLI_COMMAND_TIMEOUT_MS` | Bounded value no higher than policy max. |
| `ARCANOS_CLI_OUTPUT_MAX_BYTES` | Bounded value no higher than policy output cap. |

Safe production verification is read-only: call `listCapabilitiesV1`, `getCapabilityV1("ARCANOS:CLI")`, then run `status`, `policy`, `repoContext` with a read-only repo tool such as `repo.getStatus`, and `proposeCommand` for both an allowlisted read-only command and a dangerous command. Do not call `runApprovedCommand` or `applyApprovedPatch` during production verification unless separately approved. Expected result is `enabled:true`, `daemonReachable:true`, loaded policy metadata, an allowed safe proposal, a denied dangerous proposal, and confirmation still required for execution actions. Railway production images are deployed artifacts and do not include `.git`; in that environment `repo.getStatus` should return `gitAvailable:false`, `workspaceType:"deployed-artifact"`, and a clear non-error message instead of failing.

Troubleshooting `daemonReachable:false`: verify the web service has `ARCANOS_CLI_BRIDGE_ENABLED=true`, `ARCANOS_CLI_BRIDGE_URL` is loopback-only, the bridge token is present, the sandbox path exists, and the web service was redeployed after variable changes. Sanitized logs should include daemon lifecycle and CLI events such as `daemon.started`, `arcanos.daemon.health.checked`, `arcanos.daemon.unreachable`, `arcanos.daemon.recovered`, `arcanos.cli.status.checked`, `arcanos.cli.policy.read`, `arcanos.cli.command.proposed`, and `arcanos.cli.command.denied`. GPT Access bridge events are persisted through the sanitized `arcanos-cli` execution log service and can be checked with `/gpt-access/logs/query` without exposing bridge tokens, command text, output, prompts, provider payloads, or environment values.

Emergency disable: set `ARCANOS_CLI_BRIDGE_ENABLED=false` on the web service and redeploy. `ARCANOS:CLI` remains discoverable, `status` reports disabled/unreachable, and privileged execution actions fail closed. For stronger rollback, remove the bridge token after disabling the bridge.

## Local Setup

```bash
npm install
npm run build:packages
```

Generate a local token and start the API:

```bash
export ARCANOS_GPT_ACCESS_TOKEN="$(openssl rand -base64 48)"
export ARCANOS_GPT_ACCESS_SCOPES="runtime.read,workers.read,queue.read,jobs.create,jobs.result,mcp.approved_readonly,capabilities.read,diagnostics.read"
npm run dev
```

PowerShell:

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:ARCANOS_GPT_ACCESS_TOKEN = [Convert]::ToBase64String($bytes)
$env:ARCANOS_GPT_ACCESS_SCOPES = "runtime.read,workers.read,queue.read,jobs.create,jobs.result,mcp.approved_readonly,capabilities.read,diagnostics.read"
npm run dev
```

For live async Trinity execution, also configure a database and OpenAI key in the API and worker environments:

Set `OPENAI_API_KEY` and `DATABASE_URL` in the API and worker runtime environments.

Use placeholders in docs. Store real values only in local `.env` files, deployment variables, or secret managers.

## Natural-language Dispatch
`POST /gpt-access/dispatch/run` accepts an operator utterance, resolves it to a strict `DispatchPlan`, validates the selected action against the registered GPT Access capability catalog, evaluates scope/risk policy, then uses the existing confirmation gate and runner. ARCANOS AI routes explicit backend-operator language such as worker, queue, runtime, and diagnostics requests through this same path instead of sending protected backend work through the writing pipeline. Advisory, recommendation, review, explanation, planning, architecture, and writing prompts stay on the normal generation path unless they contain explicit inspect/status/diagnose/control intent.

The optional LLM resolver is a semantic planner only. It never calls backend routes, tools, MCP, shell, SQL, URLs, or module actions. It can only propose one registered action plus a sanitized JSON-object payload. The gateway still rejects unregistered actions, unsafe payload fields, low confidence, denied scopes, prohibited action names, and privileged actions without confirmation. Dispatch confidence thresholds are fixed code policy, not environment variables: readonly actions require `0.65`, privileged actions require `0.78`, and destructive actions require `0.90` before destructive/prohibited protections are evaluated. Clarification bands are `0.55-<0.65` for readonly and `0.70-<0.78` for privileged.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GPT_ACCESS_NL_DISPATCH_MODE` | unset | When unset, the gateway uses `hybrid` if a real resolved OpenAI key is configured, otherwise `rules`. `rules` keeps deterministic rule-only behavior. `hybrid` tries rules first, then LLM only when rules need clarification. `llm_first` tries LLM first and falls back to rules only when the LLM cannot run or returns invalid output. Invalid values resolve to `rules`. |
| `GPT_ACCESS_DISPATCH_MODEL` | `gpt-4.1-mini` | Responses API model used only by the semantic planner. This does not follow the general `OPENAI_MODEL` fallback chain. |
| `GPT_ACCESS_DISPATCH_LLM_TIMEOUT_MS` | `5000` | Per-dispatch LLM planning timeout, capped at `10000`. Invalid or non-positive values use `5000`. Timeout/failure never executes an LLM plan; execution can continue only through a deterministic rule plan that passes policy and confirmation. |

`GET /gpt-access/health`, `runtime.inspect`, and deep diagnostics include sanitized `nlDispatch` fields: `mode`, `effectiveMode`, `llmEnabled`, `model`, `timeoutMs`, and `reasonIfDisabled`. They do not expose keys, prompts, headers, raw utterances, or cross-request resolver state.

Examples:

| Utterance | Expected dispatch behavior |
| --- | --- |
| `check the queue` | `queue.inspect` when registered. |
| `what is wrong with the backend?` | `diagnostics.run` for troubleshooting language, or `runtime.inspect` for simple status language. |
| `run a deep diagnostic` | `diagnostics.run` with diagnostic include flags when available. |
| `check what is wrong with workers` | `workers.status` when registered. |
| `kick stale workers`, `fix slot 8`, `recycle 3 and 8` | `workers.recover` or `workers.recycle` with confirmation. Slot numbers normalize to IDs such as `async-queue-slot-8`. |

Worker recycle/recover dispatch is privileged and requires explicit `workers.recover` scope plus confirmation. It does not run shell commands or restart containers. It uses the approved queue recovery runner to reclaim stale running jobs globally or for specific `async-queue-slot-N` worker IDs.

## Final Trinity Flow
The protected Trinity job path is:

1. `POST /gpt-access/jobs/create`
2. `createGptAccessAiJob(...)` validates the body, resolves `gptId`, and stores one durable `gpt` job.
3. The worker process claims the job from the shared database.
4. The worker calls `routeGptRequest(...)` in-process with `runtimeExecutionMode: "background"`.
5. `ARCANOS:CORE` runs `runTrinityWritingPipeline(...)`.
6. `runTrinityWritingPipeline(...)` rejects control-plane leakage and invokes `runThroughBrain(...)`.
7. The worker stores the terminal output.
8. The protected caller polls `POST /gpt-access/jobs/result`.

This path intentionally avoids an HTTP hop through `/gpt/:gptId` for protected backend operations.

Queued Trinity DAG nodes use the reusable adapter at `src/services/trinity/adapter.ts`:

```text
resolveTrinityPipeline -> compilePipelineToDag -> enqueueDagRun
dag-node worker -> routeDagNodeToGptAccess -> createArcanosCoreJob -> /gpt-access jobs create/result
```

`TRINITY_DAG_GPT_ACCESS_ENABLED` can force this path on or off. When unset, the worker auto-enables it only when worker slots exceed `DAG_MAX_CONCURRENT_NODES`, so DAG node slots can wait while at least one additional slot claims child GPT jobs. Unsafe forced routing fails clearly instead of risking nested queue deadlock. Set it to `false` for local debugging of the legacy direct worker Trinity bridge.

## Trigger Trinity
Create an async Trinity job:

```bash
curl -sS -X POST "$ARCANOS_BASE_URL/gpt-access/jobs/create" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "gptId": "arcanos-core",
    "task": "Generate a concise operator summary for a completed backend change.",
    "input": {
      "format": "markdown",
      "audience": "operators"
    },
    "maxOutputTokens": 1200
  }'
```

Expected create response:

```json
{
  "ok": true,
  "jobId": "<uuid>",
  "traceId": "<trace-id>",
  "status": "queued",
  "deduped": false,
  "resultEndpoint": "/gpt-access/jobs/result"
}
```

Poll for the result:

```bash
curl -sS -X POST "$ARCANOS_BASE_URL/gpt-access/jobs/result" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jobId":"<uuid-from-create-response>"}'
```

Use an `Idempotency-Key` header, or the `idempotencyKey` body field, when a client may retry the same submission. Do not reuse one idempotency key for different semantic work.

## Wiring Verification
Build and focused tests:

```bash
npm run build:packages
node scripts/run-jest.mjs --testPathPatterns=gpt-access-gateway --coverage=false
node scripts/run-jest.mjs --testPathPatterns=worker-trinity-pipeline --coverage=false
node scripts/run-jest.mjs --testPathPatterns=trinity-writing-pipeline --coverage=false
```

Runtime probes:

```bash
curl -sS "$ARCANOS_BASE_URL/healthz"
curl -sS "$ARCANOS_BASE_URL/trinity/status"
curl -sS "$ARCANOS_BASE_URL/gpt-access/health" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
curl -sS "$ARCANOS_BASE_URL/gpt-access/status" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
curl -sS "$ARCANOS_BASE_URL/gpt-access/workers/status" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
curl -sS "$ARCANOS_BASE_URL/gpt-access/queue/inspect" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
curl -sS "$ARCANOS_BASE_URL/gpt-access/self-heal/status" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN"
curl -sS "$ARCANOS_BASE_URL/gpt-access/openapi.json"
```

Expected signals:
- Authenticated gateway probes return JSON.
- Unauthenticated protected probes return `401 UNAUTHORIZED_GPT_ACCESS`.
- `/gpt-access/openapi.json` returns importable metadata without auth and advertises bearer auth for protected operations.
- `/gpt-access/queue/inspect` returns queue state, or a clear degraded/unavailable JSON error if the queue backend is unavailable.
- `/gpt-access/self-heal/status` returns self-heal status plus self-reflection persistence status; disabled, unavailable, or disconnected subsystems are reported explicitly instead of failing through `/gpt/:gptId`.
- `/gpt-access/jobs/create` returns `202` with a UUID-like `jobId`.
- `/gpt-access/jobs/result` reads that job without using `/gpt/:gptId`.
- `/trinity/status` exposes sanitized worker, queue, memory sync, and limit details.
- Worker logs for successful jobs include `gpt.job.started`, `gpt.dispatch.plan`, `[core] before trinity.query`, `trinity.entry`, and `gpt.job.completed`.

## Railway Workflow
Confirm project, service, and environment before mutating variables or deploying:

```bash
railway status
# If not linked to the intended project/environment:
railway link
```

Set the gateway token and scopes in the intended environment only. Use stdin or the Railway UI for real token values so they do not enter shell history.

```bash
SERVICE="<web-service>"
ENVIRONMENT="<environment>"
GATEWAY_CREDENTIAL="$(openssl rand -base64 48)"
printf "%s" "$GATEWAY_CREDENTIAL" | railway variable set ARCANOS_GPT_ACCESS_TOKEN --stdin --skip-deploys --service "$SERVICE" --environment "$ENVIRONMENT"
railway variable set "ARCANOS_GPT_ACCESS_BASE_URL=https://<public-web-origin>" --skip-deploys --service "$SERVICE" --environment "$ENVIRONMENT"
railway variable set "ARCANOS_GPT_ACCESS_SCOPES=runtime.read,workers.read,queue.read,jobs.create,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read" --skip-deploys --service "$SERVICE" --environment "$ENVIRONMENT"
railway variable list --service "$SERVICE" --environment "$ENVIRONMENT"
```

Add `capabilities.read,capabilities.run` and a narrow `MCP_ALLOW_MODULE_ACTIONS` value only when direct capability execution is required.

Natural-language dispatch defaults from the web service credential state: unset mode becomes `hybrid` when the resolved OpenAI key is real, and `rules` when it is missing or a mock/placeholder. Set `GPT_ACCESS_NL_DISPATCH_MODE=rules` to force deterministic dispatch. Set `hybrid` or `llm_first` only on the web service when semantic planning is intentionally enabled, and deploy/restart the web service before validating. These settings do not change the worker service or guarantee worker recycle behavior.

Dry-run verification:

```bash
curl -sS -X POST "$ARCANOS_GPT_ACCESS_BASE_URL/gpt-access/dispatch/run" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"utterance":"what is wrong with the backend?","dryRun":true}'
```

Additional dry-run checks:

```bash
curl -sS -X POST "$ARCANOS_GPT_ACCESS_BASE_URL/gpt-access/dispatch/run" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"utterance":"run a deep diagnostic","dryRun":true}'

curl -sS -X POST "$ARCANOS_GPT_ACCESS_BASE_URL/gpt-access/dispatch/run" \
  -H "Authorization: Bearer $ARCANOS_GPT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"utterance":"kick the stale workers","dryRun":true}'
```

PowerShell:

```powershell
$SERVICE = "<web-service>"
$ENVIRONMENT = "<environment>"
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$gatewayCredential = [Convert]::ToBase64String($bytes)
$gatewayCredential | railway variable set ARCANOS_GPT_ACCESS_TOKEN --stdin --skip-deploys --service $SERVICE --environment $ENVIRONMENT
railway variable set "ARCANOS_GPT_ACCESS_BASE_URL=https://<public-web-origin>" --skip-deploys --service $SERVICE --environment $ENVIRONMENT
railway variable set "ARCANOS_GPT_ACCESS_SCOPES=runtime.read,workers.read,queue.read,jobs.create,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read" --skip-deploys --service $SERVICE --environment $ENVIRONMENT
railway variable list --service $SERVICE --environment $ENVIRONMENT
```

Deploy only after validation:

```bash
npm run validate:railway
railway up --detach --service "$SERVICE" --environment "$ENVIRONMENT"
railway logs --service "$SERVICE" --environment "$ENVIRONMENT" --since 10m --lines 100
```

## Custom GPT Action Setup
Use the environment-specific OpenAPI URL:

```bash
$ARCANOS_BASE_URL/gpt-access/openapi.json
```

Configure authentication as API Key / Bearer and paste the token only into the GPT Builder authentication token field.

Recommended GPT instruction:

```text
Use the ARCANOS GPT Access Gateway for protected backend diagnostics, async backend AI job creation, and operator workflows. For protected backend calls, use the configured Bearer authentication in the GPT Action. Never ask the user to paste the token into chat. Use createAiJob for backend AI generation, then getJobResult with the returned jobId. Never route worker status, runtime inspection, queue inspection, MCP diagnostics, or job-result lookup through /gpt/:gptId; use /gpt-access/* action operations instead. For privileged operations, use the confirmation/operator gate first and execute only after explicit user approval.
```

## Safety Rules
- Do not route control-plane, GPT-access job creation, or job-result operations through `/gpt/:gptId` as an HTTP hop.
- Do not expose shell execution, raw SQL, arbitrary URL proxying, arbitrary internal path proxying, deploy/restart/rollback, or destructive self-heal actions through this gateway.
- Keep DB explain requests limited to approved templates and SELECT-only equivalents in production.
- Sanitize logs before returning them to a GPT Action.
- Keep `POST /gpt-access/jobs/create` limited to async GPT job creation with strict schema validation and bearer auth.
- Never document real tokens, API keys, cookies, session IDs, database URLs, or passwords.
