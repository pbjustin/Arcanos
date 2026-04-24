# API Guide

## Overview
This is the current API catalog for routes mounted by `src/routes/register.ts`, `src/routes/healthGroup.ts`, and `src/routes/api/index.ts`. Route behavior is sensitive to mount order when duplicate paths exist.

## Prerequisites
- Backend running locally or on Railway.
- JSON client (curl/Postman/SDK).
- For protected routes, confirmation headers or trusted automation settings.

## Setup
Start the backend:
```bash
npm run build
npm start
```

Base URLs:
- Local: `http://localhost:3000`
- Railway: `https://<your-service>.up.railway.app`

## Configuration
Confirmation gate behavior (`src/middleware/confirmGate.ts`):
- Manual: `x-confirmed: yes`
- Challenge retry: `x-confirmed: token:<challengeId>`
- Trusted GPT: `x-gpt-id` + configured `TRUSTED_GPT_IDS`
- Automation secret: configured header (default `x-arcanos-automation`)

## Run locally
Quick probes:
```bash
curl http://localhost:3000/healthz
curl -X POST http://localhost:3000/api/ask -H "Content-Type: application/json" -d '{"message":"hello"}'
```

## Deploy (Railway)
No API path changes are required for Railway. Ensure liveness (`/healthz`) and readiness (`/health`) and confirmation-gated flows are validated after deploy.

## Troubleshooting
- 403 with `CONFIRMATION_REQUIRED`: use confirmation flow headers.
- 503 from AI routes: check OpenAI key config and upstream status.
- 404 on expected route: verify method and mounted path prefix.

## References
- Route registry: `../src/routes/register.ts`
- API mount index: `../src/routes/api/index.ts`
- Validation and auth middleware: `../src/middleware/confirmGate.ts`

## GPT Async Contract
`POST /gpt/:gptId` is the writing plane. It supports a typed async GPT bridge with idempotent retry handling for job-backed requests, but it must not be used for prompt-shaped control-plane retrieval.

Writing vs control:
- Writing plane: prompt generation, assistant responses, and explicit async write actions `query` and `query_and_wait`.
- Direct control plane: `GET /jobs/:id`, `GET /jobs/:id/result`, `GET /workers/status`, `GET /worker-helper/health`, `GET /status`, `GET /status/safety/self-heal`, `POST /mcp`, and `/api/arcanos/dag/*`.
- Router-handled compatibility control actions on `POST /gpt/:gptId`: `get_status`, `get_result`, `diagnostics`, and `system_state`. These are handled before write dispatch and never enqueue new GPT work.
- Rejected on `POST /gpt/:gptId`: prompt-based job lookups, DAG execution/tracing prompts, runtime inspection prompts, and explicit MCP tool calls. The backend returns canonical control endpoints instead of routing them through generation.

Request guidance:
- Send `Idempotency-Key` when the client may retry the same GPT submission. The backend hashes the key before storage.
- If `Idempotency-Key` is absent and the request is routed onto the GPT job path, the backend derives a stable semantic fingerprint from `gptId`, `action`, normalized prompt/input fields, and caller scope.
- Prompt/result contents are not stored in the idempotency mapping. Only hashed scope, key, and fingerprint values are persisted.

Deduplication rules:
- Reuses in-flight GPT jobs for the same caller scope and semantic request.
- Reuses recently completed GPT jobs for the same caller scope and semantic request.
- Reuses failed or cancelled GPT jobs only when the client supplied the same explicit `Idempotency-Key`.
- Transport-only retry hints such as `async`, `executionMode`, `responseMode`, `waitForResultMs`, and polling intervals do not create a new GPT job.
- Reusing an explicit `Idempotency-Key` for a different semantic GPT request returns `409 IDEMPOTENCY_KEY_CONFLICT`.

Canonical async bridge:
- `query`: `POST /gpt/:gptId` with `{ "action": "query", "prompt": "..." }` creates or reuses one durable GPT writing job and returns the canonical `jobId` without inline waiting.
- `query_and_wait`: `POST /gpt/:gptId` with `{ "action": "query_and_wait", "prompt": "...", "timeoutMs": 25000, "pollIntervalMs": 500 }` creates or reuses one durable GPT writing job and waits briefly for fast completion.
- `get_status`: `POST /gpt/:gptId` with `{ "action": "get_status", "payload": { "jobId": "..." } }` returns structured status from the control plane without creating work.
- `get_result`: `POST /gpt/:gptId` with `{ "action": "get_result", "payload": { "jobId": "..." } }` returns structured job result state from the control plane without creating work.

Legacy compatibility:
- `POST /gpt/:gptId` with `{"prompt":"...","executionMode":"async","waitForResultMs":20000}` still supports one queue-backed request that either returns the final GPT result inline or times out safely with the canonical `jobId`.
- Prefer the explicit `query` and `query_and_wait` action contract for agent and tool clients because it is typed, discoverable, and easier to validate.
- Optional `pollIntervalMs` adjusts the internal polling cadence while the backend waits.
- Direct-return timeouts never enqueue a second job; they return the same canonical `jobId` and point callers to `GET /jobs/:id/result`.

Job-backed `POST /gpt/:gptId` response shapes:
- `202 Accepted` pending write: `{ ok:true, action:"query"|"query_and_wait", jobId, status:"queued"|"running"|"timeout", poll:"/jobs/:id/result", stream:"/jobs/:id/stream", timedOut?, jobStatus, lifecycleStatus, deduped?, idempotencyKey, idempotencySource, _route }`
- `200 OK` completed write: `{ ok:true, action:"query_and_wait", jobId, status:"completed", result:{ text }, poll, stream, jobStatus, lifecycleStatus, deduped?, idempotencyKey, idempotencySource, _route }`
- `200 OK` status retrieval: `{ ok:true, action:"get_status", jobId, status:"queued|running|completed|failed|cancelled|expired", ... }`
- `200 OK` result retrieval: `{ ok:true, action:"get_result", jobId, status, output?, result?, error?, poll?, stream?, ... }`
- Error shape: `{ ok:false, action, error:{ code, message } }`
- Duplicate submissions set `deduped: true` and return the canonical `jobId`.
- `200 OK` system-state retrieval/update: `POST /gpt/:gptId` with `{ "action": "system_state", "payload": { ... } }` is handled directly on the control plane for core GPT ids and never enters the writing dispatcher.
- `400 Bad Request` control rejection: prompt-based job lookups, runtime inspection, DAG control, and MCP tool calls return deterministic JSON with `canonical` control routes.

Canonical client-facing async acknowledgement:
```json
{
  "ok": true,
  "status": "completed | queued | running | timeout",
  "jobId": "job-id",
  "poll": "/jobs/job-id/result",
  "stream": "/jobs/job-id/stream",
  "timedOut": true
}
```

Pipeline timeout fallback detection:
- A completed job is degraded, not successful, when `fallbackFlag` is true.
- It is also degraded when `timeoutKind` is `pipeline_timeout`.
- It is also degraded when `activeModel` contains `static-timeout-fallback`.
- It is also degraded when `auditSafe.auditFlags` contains `CORE_PIPELINE_TIMEOUT_FALLBACK`.
- Documentation clients must retry with a narrower section prompt once, then fail with: `ARCANOS completed in degraded fallback mode; documentation generation must be split into smaller tasks.`

Job status routes:
- `GET /jobs/:id`: returns `{ id, job_type, status, lifecycle_status, created_at, updated_at, completed_at, cancel_requested_at, cancel_reason, retention_until, idempotency_until, expires_at, error_message, output, result }`
- `GET /jobs/:id/stream`: SSE stream of status changes. Terminal events include `completed`, `failed`, `cancelled`, and `expired`.
- `POST /jobs/:id/cancel`: cancels a queued GPT job immediately or requests best-effort cancellation for a running GPT job.

GPT job lifecycle:
- Storage states: `pending`, `running`, `completed`, `failed`, `cancelled`, `expired`
- API alias: `lifecycle_status: "queued"` is emitted for stored `pending`
- Running-job cancellation is best effort; queued jobs cancel synchronously
- Running stale jobs are recovered through the worker lease inspector
- Old terminal GPT jobs transition to `expired`, then are compacted after an additional grace window

Retention defaults:
- Completed GPT jobs: 24h retention
- Failed GPT jobs: 6h retention
- Cancelled GPT jobs: 1h retention
- Idempotency reuse window: 24h, capped by the terminal state retention window
- Pending GPT jobs that sit unclaimed for too long are expired by lifecycle maintenance

Client retry guidance:
- Reuse the same `Idempotency-Key` for safe client retries of the same GPT request body.
- Poll `GET /jobs/:id` or subscribe to `GET /jobs/:id/stream` after any `202`.
- Prefer the canonical jobs API for job reads. Use GPT compatibility actions only when the caller cannot reach `/jobs/*`.
- ARCANOS CLI follows the same split: `arcanos query` and `arcanos query-and-wait` use the writing plane, while `arcanos job-status` and `arcanos job-result` call the canonical jobs API.
- Natural-language retrieval through `prompt` text is intentionally blocked. Retrieval must use structured `action + payload.jobId`.
- Do not send prompts that ask the GPT route to inspect runtime state, trigger DAGs, or call MCP tools. Use the direct control endpoints instead.
- Treat `cancelled` and `expired` as terminal and submit a fresh request if more work is needed.

## Active Endpoint Groups

### Core health and status
- `GET /`
- `GET /health`
- `GET /healthz`
- `GET /readyz`
- `GET /railway/healthcheck`
- `GET /status`
- `POST /status` (confirmation required)
- `POST /heartbeat` (confirmation required)
- `GET /api/test`
- `GET /api/fallback/test`

### Core AI interaction
- `GET|POST /ask`
- `GET|POST /brain` (confirmation required)
- `GET /trinity/status`
- `POST /arcanos` (confirmation required)
- `POST /arcanos-pipeline`
- `POST /arcanos-query`
- `POST /siri` (confirmation required)
- `POST /api/ask`
- `POST /api/arcanos/ask` (confirmation required)
- `POST /api/ask-hrc`

### Reinforcement and reflection feedback
- `POST /reinforce`
- `POST /audit`
- `POST /reinforcement/judge`
- `GET /reinforcement/metrics`
- `GET /memory/digest`
- `GET /memory`

### AI utility and media
- `POST /write` (confirmation required)
- `POST /guide` (confirmation required)
- `POST /audit` (confirmation required, primary handler from `ai-endpoints.ts`)
- `POST /sim` (confirmation required)
- `POST /image`
- `POST /api/vision`
- `POST /api/transcribe`
- `GET /api/openai/status`
- `POST /api/openai/prompt`

### Memory, codebase, and reusable code
- `POST /api/save-conversation`
- `GET /api/save-conversation/:recordId`
- `GET /api/memory/health`
- `POST /api/memory/save` (confirmation required)
- `GET /api/memory/load`
- `DELETE /api/memory/delete` (confirmation required)
- `GET /api/memory/list`
- `GET /api/memory/view`
- `GET /api/memory/table`
- `GET /api/memory/search`
- `POST /api/memory/nl`
- `POST /api/memory/bulk` (confirmation required)
- `POST /memory/resolve`
- `GET /api/codebase/tree`
- `GET /api/codebase/file`
- `POST /api/reusables`
- `GET /api/reusables/health`

### Workers, orchestration, and DevOps
- `GET /workers/status`
- `POST /workers/heal` (confirmation required)
- `POST /workers/run/:workerId` (confirmation required)
- `GET /jobs/:id`
- `GET /jobs/:id/stream`
- `POST /jobs/:id/cancel`
- `POST /orchestration/reset` (confirmation required)
- `GET /orchestration/status`
- `POST /orchestration/purge` (confirmation required)
- `POST /devops/self-test`
- `POST /devops/daily-summary`

### Research, RAG, and command routing
- `GET /api/commands`
- `GET /api/commands/health`
- `POST /api/commands/execute` (confirmation required)
- `POST /commands/research` (confirmation required)
- `POST /sdk/research` (confirmation required)
- `POST /rag/fetch`
- `POST /rag/save`
- `POST /rag/query`

### Daemon, debug, and registry paths
- `POST /mcp` (MCP Streamable HTTP, bearer token required, origin-restricted when configured)
- `GET /mcp` (always `405 Method Not Allowed`)
- `POST /api/daemon/heartbeat` (daemon auth required)
- `GET /api/daemon/commands` (daemon auth required)
- `POST /api/daemon/commands/ack` (daemon auth required)
- `POST /api/daemon/confirm-actions` (daemon auth required)
- `GET /api/daemon/registry` (daemon auth required)
- `POST /api/update` (public validation path; daemon-auth variant also exists)
- `POST /debug/create-confirmation-token` (automation secret required)
- `POST /debug/consume-confirm-token` (automation secret required)
- `ALL /bridge-status`, `/bridge`, `/bridge/handshake`, `/ipc`, `/ipc/handshake`, `/ipc/status`
- `GET /registry`
- `GET /registry/:moduleName`
- `POST /queryroute`
- `POST /modules/:moduleRoute` (dynamic module route from runtime module loader)
- `POST /gpt/:gptId` (writing plane; control compatibility actions are intercepted before write dispatch)

### API submodules mounted under `/api`
- `GET /api/assistants`
- `POST /api/assistants/sync`
- `GET /api/assistants/:name`
- `POST /api/sim`
- `GET /api/sim/health`
- `GET /api/sim/examples`
- `POST /api/pr-analysis/webhook`
- `POST /api/pr-analysis/analyze`
- `GET /api/pr-analysis/health`
- `GET /api/pr-analysis/schema`

### SDK routes mounted under `/sdk`
- `POST /sdk/workers/init` (confirmation required)
- `GET /sdk/workers/status`
- `POST /sdk/routes/register` (confirmation required)
- `POST /sdk/scheduler/activate` (confirmation required)
- `POST /sdk/jobs/dispatch` (confirmation required)
- `POST /sdk/test-job` (confirmation required)
- `POST /sdk/init-all` (confirmation required)
- `GET /sdk/diagnostics`
- `POST /sdk/system-test` (confirmation required)

## TODO (verified route-order ambiguities)
- `POST /audit` is defined in multiple routers; current mount order means AI utility handling executes first.
- `POST /api/update` has a public route and a daemon-authenticated route; current mount order executes the public route first.
- `GET /health` is defined in multiple routers; health-group handler executes first because it is mounted before reinforcement and status routes.
- `/api/reusables*` routes are mounted both through `api/index.ts` and directly in `register.ts`; first matching handler responds and the second mount is effectively redundant.


## Daemon command result reporting
If you run the optional Python daemon, it can report tool results back to the backend so the model can continue after tool calls.

- `POST /api/daemon/commands/result`

Body:
```json
{
  "instanceId": "daemon-instance-id",
  "commandId": "cmd_123",
  "result": { "any": "json payload" }
}
```

Notes:
- The backend stores results temporarily (in-memory by default).
- `src/routes/ask/daemonTools.ts` will poll for results up to `DAEMON_RESULT_WAIT_MS` and feed them back to OpenAI as `function_call_output`.
