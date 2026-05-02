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

For Custom GPT OpenAPI metadata, the gateway derives the server URL from `ARCANOS_GPT_ACCESS_BASE_URL` first, then `ARCANOS_BASE_URL`, `ARCANOS_BACKEND_URL`, `SERVER_URL`, `BACKEND_URL`, public Railway URL/domain variables, or the incoming request origin. Set `ARCANOS_GPT_ACCESS_BASE_URL` in deployment when the gateway is reached through a stable public origin.

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

## Local Setup

```bash
npm install
npm run build:packages
```

Generate a local token and start the API:

```bash
export ARCANOS_GPT_ACCESS_TOKEN="$(openssl rand -base64 48)"
export ARCANOS_GPT_ACCESS_SCOPES="runtime.read,workers.read,queue.read,jobs.create,jobs.result,capabilities.read,diagnostics.read"
npm run dev
```

PowerShell:

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:ARCANOS_GPT_ACCESS_TOKEN = [Convert]::ToBase64String($bytes)
$env:ARCANOS_GPT_ACCESS_SCOPES = "runtime.read,workers.read,queue.read,jobs.create,jobs.result,capabilities.read,diagnostics.read"
npm run dev
```

For live async Trinity execution, also configure a database and OpenAI key in the API and worker environments:

Set `OPENAI_API_KEY` and `DATABASE_URL` in the API and worker runtime environments.

Use placeholders in docs. Store real values only in local `.env` files, deployment variables, or secret managers.

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
railway variable set "ARCANOS_GPT_ACCESS_SCOPES=runtime.read,workers.read,queue.read,jobs.create,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read" --skip-deploys --service "$SERVICE" --environment "$ENVIRONMENT"
railway variable list --service "$SERVICE" --environment "$ENVIRONMENT"
```

Add `capabilities.read,capabilities.run` and a narrow `MCP_ALLOW_MODULE_ACTIONS` value only when direct capability execution is required.

PowerShell:

```powershell
$SERVICE = "<web-service>"
$ENVIRONMENT = "<environment>"
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$gatewayCredential = [Convert]::ToBase64String($bytes)
$gatewayCredential | railway variable set ARCANOS_GPT_ACCESS_TOKEN --stdin --skip-deploys --service $SERVICE --environment $ENVIRONMENT
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
