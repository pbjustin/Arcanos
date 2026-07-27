# API Guide

## Overview
This guide documents the primary supported surfaces and notable operator/compatibility routes mounted by `src/routes/register.ts`, `src/routes/healthGroup.ts`, and `src/routes/api/index.ts`. It is a maintained integration guide, not a generated exhaustive route manifest. Route behavior is sensitive to mount order when duplicate paths exist.

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
Confirmation gate behavior (`src/transport/http/middleware/confirmGate.ts`):
- Manual: `x-confirmed: yes`
- Challenge retry: `x-confirmed: token:<challengeId>`
- Trusted GPT presence path: a request GPT ID in configured `TRUSTED_GPT_IDS` plus a non-empty `x-arcanos-confirm-token`. In the current middleware this header is a presence marker for trusted IDs; it is not consumed or validated against the one-time-token store. Because the request path, body, or header can supply the GPT ID, this setting is not caller authentication. Use it only behind deployment middleware that authenticates the caller and binds the permitted identity.
- Automation secret: configured header (default `x-arcanos-automation`)

## Run locally
Quick probes:
```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/health
curl -X POST http://localhost:3000/gpt/arcanos-core -H "Content-Type: application/json" -d '{"action":"query","prompt":"hello"}'
```

## Deploy (Railway)
No API path changes are required for Railway. Validate liveness (`/healthz`), readiness (`/readyz`), the Railway health probe (`/health`), and confirmation-gated flows after deploy.

## Troubleshooting
- 403 with `CONFIRMATION_REQUIRED`: use confirmation flow headers.
- 503 from AI routes: check OpenAI key config and upstream status.
- 404 on expected route: verify method and mounted path prefix.

## References
- Route registry: `../src/routes/register.ts`
- API mount index: `../src/routes/api/index.ts`
- Validation and auth middleware: `../src/transport/http/middleware/confirmGate.ts`

## GPT Async Contract
`POST /gpt/:gptId` is the writing plane. It supports a typed async GPT bridge with idempotent retry handling for job-backed requests, but it must not be used for prompt-shaped control-plane retrieval.

Writing vs control:
- Writing plane: prompt generation, assistant responses, durable `query` jobs, non-core durable `query_and_wait` jobs, and core synchronous `query_and_wait` actions.
- Direct control plane: `GET /jobs/:id`, `GET /jobs/:id/result`, `GET /workers/status`, `GET /worker-helper/health`, `GET /status`, `GET /status/safety/self-heal`, `POST /gpt-access/diagnostics/deep`, `GET|POST /system-state`, `POST /mcp`, and `/api/arcanos/dag/*`.
- No public control actions are served by `POST /gpt/:gptId`; `get_status`, `get_result`, `diagnostics`, `system_state`, runtime inspection, worker status, queue inspection, self-heal status, MCP calls, and prompt-based job lookups are rejected with canonical control endpoints.

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

Canonical GPT bridge:
- `query`: `POST /gpt/:gptId` with `{ "action": "query", "prompt": "..." }` creates or reuses one durable GPT writing job and returns the canonical `jobId` without inline waiting.
- `query_and_wait`: `POST /gpt/:gptId` with `{ "action": "query_and_wait", "prompt": "...", "timeoutMs": 25000 }` executes core GPT requests synchronously through the lightweight direct action lane and returns the final result inline. If direct execution fails or times out, the route returns a typed error instead of synthetic bounded fallback content. Non-core GPTs keep the durable job path.
- Job status: `GET /jobs/:id` returns structured status from the control plane without creating GPT work.
- Job result: `GET /jobs/:id/result` returns structured job result state from the control plane without creating GPT work.
- Generated-client compatibility: body `action` is authoritative, but the router also accepts `?action=query_and_wait` and operation-style aliases such as `{ "operationId": "requestQueryAndWait" }` for clients that place GPT Action metadata outside the canonical body field.

Legacy compatibility:
- `POST /gpt/:gptId` with `{"prompt":"...","executionMode":"async","waitForResultMs":20000}` still supports one queue-backed request that either returns the final GPT result inline or times out safely with the canonical `jobId`.
- Prefer the explicit `query` and `query_and_wait` action contract for agent and tool clients because it is typed, discoverable, and easier to validate.
- Optional `pollIntervalMs` adjusts the internal polling cadence while the backend waits.
- Direct-return timeouts never enqueue a second job; they return the same canonical `jobId` and point callers to `GET /jobs/:id/result`.

Job-backed `POST /gpt/:gptId` response shapes:
- `202 Accepted` pending write: `{ ok:true, action:"query", jobId, status:"queued"|"running"|"timeout", poll:"/jobs/:id/result", stream:"/jobs/:id/stream", timedOut?, jobStatus, lifecycleStatus, deduped?, idempotencyKey, idempotencySource, _route }`
- `200 OK` completed direct action: `{ ok:true, action:"query_and_wait", status:"completed", result:"...", directAction:{ inline:true, queueBypassed:true }, _route }`
- `200 OK` completed async write for non-core durable jobs: `{ ok:true, action:"query_and_wait", jobId, status:"completed", result:{ text }, poll, stream, jobStatus, lifecycleStatus, deduped?, idempotencyKey, idempotencySource, _route }`
- Error shape: `{ ok:false, action, error:{ code, message } }`
- A repository outage after a job is accepted returns HTTP `503` with `error.code: "ASYNC_GPT_JOBS_UNAVAILABLE"` and the stable message `Async GPT job status is temporarily unavailable because durable job persistence is unavailable.` The response keeps the accepted `jobId`, `poll`, and `stream` coordinates; creation-stage outages cannot include job coordinates.
- Duplicate submissions set `deduped: true` and return the canonical `jobId`.
- `200 OK` system-state retrieval/update: `POST /system-state` with `{ "sessionId": "...", "expectedVersion": 1, "patch": { ... } }` is handled directly on the control plane and never enters the GPT writing dispatcher.
- `400 Bad Request` control rejection: prompt-based job lookups, explicit job lookup actions, diagnostics, system_state, runtime inspection, DAG control, and MCP tool calls return deterministic JSON with `canonical` control routes.

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
- `GET /jobs/:id`: returns `{ id, jobId, job_type, status, lifecycle_status, created_at, updated_at, completed_at, cancel_requested_at, cancel_reason, retention_until, idempotency_until, expires_at, poll, stream, error_message, output, result }`
- `GET /jobs/:id/result`: returns the canonical result lookup envelope, including `jobId`, job/lifecycle status, polling links, result, and a typed error when applicable. A missing job returns HTTP `200` with `status: "not_found"` for compatibility.
- `GET /jobs/:id/stream`: SSE stream of status changes. The event name is `terminal` when the payload status is `completed`, `failed`, `cancelled`, or `expired`; nonterminal changes use the `status` event.
- `POST /jobs/:id/cancel`: cancels a queued GPT job immediately or requests best-effort cancellation for a running GPT job.
- When job persistence is unavailable, the status, result, and cancellation routes return HTTP `503` with `{ "error": "JOB_REPOSITORY_UNAVAILABLE" }`. This is distinct from a successful missing-job lookup.
- If persistence is unavailable before an SSE stream opens, `/jobs/:id/stream` returns the same JSON `503`. If it becomes unavailable after streaming begins, the route emits `event: error` with `{ "code": "JOB_REPOSITORY_UNAVAILABLE", "jobId": "..." }` and closes.
- These generic routes expose GPT jobs only. A `local-agent` job is returned exactly like a missing job and its output is available only through the authenticated, tenant-bound `POST /gpt-access/jobs/result` operation.

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
- Use the canonical direct jobs API or the protected GPT Access result operation for job reads; `/gpt/:gptId` does not provide a job-read compatibility action.
- ARCANOS CLI follows the same split: `arcanos query` and `arcanos query-and-wait` use the writing plane, while `arcanos job-status` and `arcanos job-result` call the canonical jobs API.
- Natural-language retrieval through `prompt` text is intentionally blocked. Retrieval must use `GET /jobs/:id`, `GET /jobs/:id/result`, or `POST /gpt-access/jobs/result`.
- Do not send prompts that ask the GPT route to inspect runtime state, trigger DAGs, or call MCP tools. Use the direct control endpoints instead.
- Treat `cancelled` and `expired` as terminal and submit a fresh request if more work is needed.
- Treat repository-unavailable `503` responses as temporary: retain any returned `jobId` and retry the same result lookup with bounded backoff. Never reinterpret `503` as `not_found` or create replacement work solely because status storage is temporarily unavailable.

## Primary Supported Surfaces and Notable Endpoint Groups

The groups below highlight stable public routes, operator/control routes, compatibility routes, and internal diagnostics; they are intentionally curated rather than exhaustive. Treat `/gpt/:gptId`, `/api/bridge/*`, `/jobs/*`, `/gpt-access/*`, `/mcp`, `/metrics`, `/api/web/search`, ActionPlan contract routes, and documented health/status routes as the primary integration surfaces. Test/debug routes such as `/api/test`, `/api/fallback/test`, `/diag/*`, `/debug/*`, bridge/IPC compatibility probes, dynamic `/modules/:moduleRoute`, and `/queryroute` are implementation or operator diagnostics unless a dedicated contract says otherwise.

### Core health and status
- `GET /`
- `GET /health`
- `GET /healthz`
- `GET|HEAD /readyz`
- `GET /railway/healthcheck`
- `GET /diagnostics` (public no-store runtime summary; its module map is
  catalog-backed and includes only the 12 non-protected definitions; `active`
  means the validated definition is loaded in the process registry, not that
  every downstream dependency of that module is ready)
- `GET /api/diagnostics/queues` (credential-free, no-store aggregate queue
  summary; recent failure entries retain category, retryability, count, and
  timestamp but replace persisted failure text with fixed category labels)
- `GET /status` (deprecated no-store alias for the public health response;
  unexpected failures retain the deprecation headers and return a fixed
  `500` message without exception text)
- `POST /status` (confirmation required; confirmation challenges and handler
  responses are no-store, and persistence failures return fixed text)
- `POST /heartbeat` (confirmation required)
- `GET /api/test`
- `GET /api/fallback/test`

The root backend's credential-free `/readyz` checks OpenAI, database, Redis,
and startup readiness in that order. It returns `200` only when every critical
check is healthy and otherwise returns `503`; all responses use
`Cache-Control: no-store`. `GET` returns the top-level fields `ready`, `status`,
`timestamp`, `checks`, and `duration`. Each check exposes only `name`,
`healthy`, `duration`, and, when unhealthy, a stable `code` and fixed public
`error`. The Redis check additionally retains only `recoveryCount`,
`readyGeneration`, `circuitEnabled`, and `circuitState` under `metadata` for
the lifecycle recovery verifier. `HEAD` preserves the same status and headers
without a body. Provider and database exceptions, connection details, OpenAI
configuration metadata, and arbitrary checker metadata are never returned.

`GET /railway/healthcheck` is a credential-free compatibility diagnostic, not
the canonical Railway deployment probe. It returns `200` when its internal
report is healthy and `503` when degraded or unavailable, and all responses
are marked `no-store`. Its bounded payload contains only a stable status code,
fixed summary, worker booleans and file count, normalized aggregate memory
values, and a timestamp. Internal worker filenames, checked filesystem paths,
free-form reasons, and exception messages are not returned. Unexpected
failures are logged only by stable code and error type with request
correlation. Railway deployments should continue probing `GET /health`.

### Core AI interaction
- `POST /gpt/:gptId` (canonical GPT writing plane)
- `POST /dispatch` (universal GPT/DAG compatibility dispatcher; asynchronous
  branch failures return the stable `500 DISPATCH_FAILED` envelope without
  internal exception text)
- `GET|POST /brain` (legacy ask-compatible route; returns `410 Gone` by default; `ASK_ROUTE_MODE=compat` enables the compatibility handler and then requires confirmation)
- `GET /trinity/status`
- `POST /arcanos` (confirmation required)
- `POST /arcanos-pipeline`
- `POST /siri` (confirmation required)
- `POST /api/ask-hrc`
- `POST /api/arcanos/ask` (deprecated compatibility route; prefer `/gpt/:gptId`)

### State and Custom GPT bridge
- `GET /system-state`
- `POST /system-state`
- `POST /api/bridge/gpt`
- `POST /api/openai/gpt-action` (bridge compatibility alias)
- `GET /api/bridge/health` (requires the bridge shared secret; returns a
  no-store operational payload with fixed database and worker failure text)

### Reinforcement and reflection feedback
- `POST /reinforce`
- `POST /audit`
- `POST /reinforcement/judge`
- `GET /reinforcement/metrics`
- `GET /memory/digest`
- `GET /memory`
- `POST /api/web/search`
- `GET /metrics` (Prometheus metrics; enabled unless `METRICS_ENABLED=false`)

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

Every `/api/memory/*`, `/api/save-conversation*`, and `/api/sessions*` route
listed below requires the exact `ARCANOS_MEMORY_ACCESS_TOKEN` in
`x-arcanos-memory-token`.
`Authorization`, cookies, query parameters, and body fields are not memory
credential carriers. Missing or invalid server configuration returns
`503 MEMORY_AUTH_UNAVAILABLE`; missing, malformed, duplicate, or incorrect
request credentials return `401 MEMORY_AUTH_REQUIRED`. Authentication precedes
the writing-plane consistency gate and any listed confirmation requirement.
The credential grants deployment-wide access only; it does not bind
caller-controlled `sessionId` values to a tenant.

- `POST /api/save-conversation`
- `GET /api/save-conversation/:recordId`
- `POST /api/sessions`
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/replay`
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
- `GET /api/codebase/tree` (control-plane bearer and `repo:read` required)
- `GET /api/codebase/file` (control-plane bearer and `repo:read` required)
- `POST /api/reusables`
- `GET /api/reusables/health`

The codebase routes are read-only control-plane inspection, not memory or
writing-plane traffic. They require the purpose-bound control-plane bearer,
server-owned operator principal, and `repo:read`; successful responses are
`Cache-Control: no-store`, and unsupported subpaths terminate with JSON 404.
Paths must resolve canonically inside `CODEBASE_ROOT`; static symbolic-link and
Windows-junction components in a requested path are rejected. Concurrent local
path replacement is detected on a best-effort basis because portable Node does
not expose race-free `openat`-style directory traversal on Windows. File reads
accept positive-integer line bounds and `maxBytes` from 1 through 262,144, read
only the bounded prefix, and reject larger or malformed limits. Directory
reads fail closed above 256 entries rather than materializing an unbounded
listing.

For `POST /gpt/:gptId`, the same custom header is required only when the request
matches the dispatcher’s existing natural-language memory interception
predicate: direct-module routing is not forced, the prompt parses as a memory
command, a memory cue exists or no module action is routable, and the effective
action is absent or `query`. Authenticated interceptions execute directly and
do not enter the fast path or job queue, even when async, fast, or idempotency
hints are present. Explicit `query` and `query_and_wait` requests already bypass
intent interception and retain their existing behavior.

### Workers, orchestration, and DevOps
- `GET /workers/status`
- `POST /workers/heal` (strict privileged worker authentication, shared
  worker-heal rate limit, and confirmation required)
- `POST /workers/run/:workerId` (privileged worker authentication and confirmation required)
  - File-backed `workerId` values are limited to 1–128 ASCII letters, digits, dots, underscores, or hyphens, beginning with a letter or digit. The resolved regular `.js` file must remain canonically inside the selected workers directory; path separators, absolute paths, traversal, escaping symlinks, the executable job runner, and shared helper modules are rejected before import.
- `GET /worker-helper/status`
- `GET /worker-helper/health`
- `GET /worker-helper/jobs/latest` (privileged auth required)
- `GET /worker-helper/jobs/failed`
- `GET /worker-helper/jobs/:id` (privileged auth required)
- `POST /worker-helper/queue/ask` (privileged auth required)
- `POST /worker-helper/dispatch` (privileged auth required)
- `POST /worker-helper/heal` (privileged auth and shared worker-heal rate limit
  required)
- `GET /jobs/:id`
- `GET /jobs/:id/result`
- `GET /jobs/:id/stream`
- `POST /jobs/:id/cancel`
- `POST /orchestration/reset` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `GET /orchestration/status` (control-plane operator and `arcanos:read`
  required)
- `POST /orchestration/purge` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `POST /devops/self-test` (control-plane operator and
  `diagnostics:execute` required)
- `POST /devops/daily-summary` (control-plane operator and
  `diagnostics:execute` required)

Both DevOps execution routes accept only an absent body or `{}`. The self-test
target and both routes' attribution are server-owned; callers cannot select a
base URL or `triggeredBy` value. They share one in-process single-flight lock
and one five-starts-per-15-minutes principal bucket. Self-test outbound
requests reject redirects, time out after 30 seconds per prompt, bound JSON
responses to 256 KiB, and do not retain model-response previews. Daily-summary
sources pass through centralized credential redaction before model submission
or persistence, and responses expose a repository-relative artifact path
rather than an absolute server path.

Orchestration reset and purge share a two-starts-per-15-minutes principal
budget and one process-local single-flight lock. Their strict JSON bodies are
capped at 1 MiB; `agentId` and `sessionId` remain operation context, not caller
identity. Confirmation is checked only after the purpose-bound bearer,
server-owned operator principal, and scope have been established. Internal
orchestration failures return fixed public errors.

`POST /workers/heal` and `POST /workers/run/:workerId` reuse the strict
worker-helper credential verifier:
send `ARCANOS_WORKER_HELPER_TOKEN` through
`x-arcanos-worker-helper-token` or Bearer authentication, or enter through an
already established full `admin`/`operator`/`owner` identity. Token
configuration must be an exact 32–4096 character value with no whitespace or
placeholder text and must not duplicate another credential in the canonical
ARCANOS application-auth registry.
Token requests may use one non-empty carrier only; duplicate headers,
whitespace-normalized values, and simultaneous custom and Authorization
credentials fail closed with the generic authentication response. The
`operator-light` role is denied. Legacy daemon markers and operator audit labels
do not authorize either direct route. Authentication runs before confirmation,
and neither `x-confirmed`, trusted automation, nor a confirmation challenge
establishes caller identity. Direct and worker-helper heal requests share one
10-per-15-minute principal budget whose keys never contain the credential.

### Research, RAG, and command routing
- `GET /api/commands`
- `GET /api/commands/health`
- `POST /api/commands/execute` (confirmation required)
- `GET /api/control-plane/capabilities`
- `POST /api/control-plane` (dedicated bearer authentication and server-owned operation scopes required; confirmation additionally required for gated operations)
- `GET /api/control-plane/allowlist`
- `GET /api/control-plane/deep-diagnostics`
- `POST /api/control-plane/operations` (dedicated bearer authentication and server-owned operation scopes required; confirmation additionally required)
- `POST /commands/research` (confirmation required)
- `POST /sdk/research` (confirmation required)
- `POST /rag/fetch`
- `POST /rag/save`
- `POST /rag/query`

For either control-plane POST route, send
`Authorization: Bearer <ARCANOS_CONTROL_PLANE_ACCESS_TOKEN>`. Authentication,
server-owned scope authorization, and action confirmation are separate checks:
`x-confirmed`, body approval fields, `context.caller`, and caller-supplied scopes
cannot authenticate or authorize a request. The server binds caller identity and
approval attribution to `ARCANOS_CONTROL_PLANE_PRINCIPAL_ID`. The application can
start without this optional HTTP credential configuration, but both POST routes
fail closed with 503 until the access token and principal settings are valid.
Missing or empty server scopes are a valid empty grant and deny operations with 403.
These control-plane routes are mounted outside the writing-plane consistency and
reroute middleware; their own authentication, authorization, and confirmation
checks remain authoritative.

### Daemon, debug, and registry paths
- `POST /mcp` (MCP Streamable HTTP, bearer token required, origin-restricted when configured)
- `GET /mcp` (always `405 Method Not Allowed`)
- `POST /api/daemon/heartbeat` (daemon auth required)
- `GET /api/daemon/commands` (daemon auth required)
- `POST /api/daemon/commands/ack` (daemon auth required)
- `POST /api/daemon/commands/result` (daemon auth required)
- `POST /api/daemon/confirm-actions` (daemon auth required)
- `GET /api/daemon/registry` (daemon auth required)
- `POST /api/update` (separate public validation path)
- `GET /api/prompt-debug/latest` (control-plane bearer and `arcanos:read`
  required; metadata-only by default, with content available only in explicit
  sensitive `full` mode)
- `GET /api/prompt-debug/events` (control-plane bearer and `arcanos:read`
  required; same trace-content policy)
- `GET /api/ai-routing/debug/latest` (control-plane bearer and `arcanos:read`
  required; bounded routing metadata by default)
- `GET /debug/watchdog` (mounted only when `DEBUG_WATCHDOG=true`; requires the
  exact `x-debug-key` purpose-bound credential, returns `503` when server key
  configuration is unavailable and `403` for missing or incorrect request
  credentials, and is always `Cache-Control: no-store`)
- `POST /debug/create-confirmation-token` (automation secret required)
- `POST /debug/consume-confirm-token` (automation secret required)
- `ALL /bridge-status`, `/bridge`, `/bridge/handshake`, `/ipc`, `/ipc/handshake`, `/ipc/status`
- `GET /registry` (legacy public projection of the 12 non-protected catalog definitions)
- `GET /registry/:moduleName` (legacy public detail; protected catalog definitions are indistinguishable from absent)
- `POST /queryroute` (legacy catalog-backed dispatch for exposed definitions only)
- `POST /modules/:moduleRoute` (legacy catalog-backed route for exposed definitions only)
- `POST /gpt/:gptId` (writing plane; control compatibility actions are intercepted before write dispatch)

The source-owned catalog contains 15 definitions. `ARCANOS:CLI`,
`ARCANOS:LOCAL_AGENT`, and `ARCANOS:PRODUCTIVITY` are GPT Access-only and are
excluded from all four legacy/public module projections above and from default
GPT-ID routing. Their route, source-stem, and normalized name variants are
reserved before fuzzy matching and return `UNKNOWN_GPT` on the writing plane.
Catalog membership alone grants no execution authority.

Every `/api/daemon/*` request must send exactly one
`x-arcanos-daemon-token` matching `ARCANOS_DAEMON_ACCESS_TOKEN`. The configured
and presented values must be exact, case-sensitive, 32–4096 character,
whitespace-free, non-placeholder credentials, and the configured value must be
distinct from every other canonical purpose-bound application credential.
Bearer authorization, `x-gpt-id`, cookies, query parameters, and body fields do
not grant daemon access. Missing or invalid server configuration returns
`503 DAEMON_AUTH_UNAVAILABLE`; missing, malformed, duplicate, or incorrect
request credentials return `401 DAEMON_AUTH_REQUIRED`. Both responses use
`Cache-Control: no-store`.

Rate limiting and authentication run before daemon handling. Authenticated
unknown `/api/daemon/*` paths terminate with 404 and never enter writing-plane
consistency or GPT rerouting. This is deployment-wide transport containment,
not per-instance identity: any holder can address any known daemon `instanceId`.
New instance records use the non-secret `anonymous-daemon` store partition.
Historical opaque partitions are preserved locally for compatibility, never
placed on request context, logged, or returned, and the access credential is
never persisted to the daemon token file.

### GPT Access protected gateway
- `GET /gpt-access/openapi.json` (public schema metadata)
- `GET /gpt-access/health`
- `GET /gpt-access/status`
- `GET /gpt-access/workers/status`
- `GET /gpt-access/worker-helper/health`
- `GET /gpt-access/queue/inspect`
- `GET /gpt-access/self-heal/status`
- `POST /gpt-access/jobs/create`
- `POST /gpt-access/jobs/result`
- `POST /gpt-access/jobs/timeline` (local-agent events are restricted to the
  server-configured GPT Access principal/workspace and fail closed when that
  trusted context is unavailable)
- `POST /gpt-access/diagnostics/deep`
- `POST /gpt-access/db/explain`
- `POST /gpt-access/logs/query`
- `POST /gpt-access/mcp`
- `GET /gpt-access/capabilities/v1`
- `GET /gpt-access/capabilities/v1/:id`
- `POST /gpt-access/capabilities/v1/:id/run`
- `POST /gpt-access/local-agent/heartbeat`, `/jobs/claim`, `/jobs/:jobId/heartbeat`, and `/jobs/:jobId/result` are private executor-protocol operations. They use the dedicated local-agent credential and a separate bounded rate-limit budget, not the Custom GPT bearer or shared GPT Access budget.
- Privileged `ARCANOS:LOCAL_AGENT` actions `tests.run` and `patch.apply` require a consumed one-time confirmation challenge bound to the authenticated actor, principal, workspace, exact action, and exact payload. Manual, trusted-GPT, automation-secret, or allow-all confirmation modes do not satisfy this stricter execution condition.
- `GET /gpt-access/modules` and `GET /gpt-access/modules/:id` (capability compatibility aliases)
- `POST /gpt-access/dispatch/run`

### ActionPlan, CLEAR, and agent execution
- `POST|GET /plans`
- `GET /plans/:planId`
- `POST /plans/:planId/approve`
- `POST /plans/:planId/block`
- `POST /plans/:planId/expire`
- `POST /plans/:planId/execute`
- `GET /plans/:planId/results` (disabled legacy view; returns `409 ACTION_PLAN_LEGACY_RESULT_VIEW_UNAVAILABLE`; use `GET /plans/:planId/executions/:runId/result`)
- `GET /action-plan-executions/protocol`
- `POST /action-plan-executions/claim-next`
- `POST /plans/:planId/executions/:runId/claim`
- `POST /plans/:planId/executions/:runId/start`
- `POST /plans/:planId/executions/:runId/result`
- `GET /plans/:planId/executions/:runId`
- `GET /plans/:planId/executions/:runId/result`
- `POST /clear/evaluate`
- `GET /clear/:planId`
- `POST /agents/register`
- `GET /agents`
- `GET /agents/:agentId`
- `POST /agents/:agentId/capabilities/grant`
- `POST /agents/:agentId/heartbeat` (disabled legacy route; returns `403 ACTION_PLAN_LEGACY_AGENT_HEARTBEAT_DISABLED`)

These routes use the ActionPlan role/auth boundary and the separate ActionPlan execution contract family. Consult `SCHEMA_PROTOCOL_GUIDE.md` and `contracts/action_plan_execution.openapi.v1.json` before integrating.

### Self-heal, self-improve, and introspection
- `POST /api/self-heal/decide`
- `GET /api/self-heal/runtime`
- `GET /api/self-heal/events`
- `GET /api/self-heal/inspection`
- `GET /api/self-heal/provider-health`
- `GET /api/self-improve/status`
- `POST /api/self-improve/run`
- `POST /api/self-improve/freeze`
- `POST /api/self-improve/unfreeze`
- `POST /api/self-improve/autonomy`
- `POST /status/safety/quarantine/:quarantineId/release`
- `GET /_introspection`
- `GET /_introspection/gpt/:gptId`
- `GET /contracts/custom_gpt_route.openapi.v1.json`
- `GET /contracts/arcanos_gaming.openapi.v1.json`
- `GET /contracts/job_status.openapi.v1.json`
- `GET /contracts/job_result.openapi.v1.json`
- `GET /contracts/action_plan_execution.openapi.v1.json`
- `GET /openapi/custom-gpt-bridge.yaml`

Every `/api/self-heal/*` and `/api/self-improve/*` request, the detailed
`GET /status/safety/self-heal` compatibility route, and integrity-quarantine
release are direct control-plane operations. These surfaces share an
ingress-client rate limit and require
`Authorization: Bearer <ARCANOS_CONTROL_PLANE_ACCESS_TOKEN>` before the broad
JSON parser or any handler. Authenticated mutation bodies then use a 256 KiB
JSON ceiling before the broad application parser. Requests with a body must use
a JSON media type, and self-improve mutation schemas reject unknown fields. The
configured principal must be an operator and must have these server-owned
scopes:

- Runtime, event, inspection, and passive provider-health reads:
  `arcanos:read`.
- Provider health with `probe=1`, `probe=true`, or `probe=yes`:
  `arcanos:read` plus `self-heal:probe`. The active probe may make upstream
  provider requests and has a separate, tighter rate limit.
- Predictive decision requests: `self-heal:decide`.
- A predictive request whose JSON body contains `execute: true`:
  `self-heal:decide` plus `self-heal:execute`.
- Detailed safety status and self-improve status: `arcanos:read`.
- Manual `POST /api/self-improve/run`: `self-heal:decide` plus
  `self-heal:execute`; it shares the decision rate-limit bucket.
- Freeze, unfreeze, autonomy changes, and integrity-quarantine release:
  `self-improve:control`; these share a tighter control-mutation bucket.
  Autonomy accepts only integer levels 0–3, and control reasons/release notes
  are bounded strings.

`POST /api/self-heal/decide` still applies
`capabilityGate('self_improve_admin')` after control-plane authentication and
scope authorization. All five `/api/self-improve/*` routes retain the same
capability check as a secondary compatibility prerequisite; its caller-supplied
agent ID is not identity-bound authorization. Agent identity or the automation
bypass never substitutes for the bearer principal. The restrictive freeze
operation remains reachable when the global unsafe-execution gate is active;
run, unfreeze, and autonomy changes remain blocked in that state.
The caller-provided `source` field is a compatibility label, not authenticated
identity. Authenticated unknown paths terminate with the standard API 404 and
do not enter writing-plane consistency or GPT routing.

Simulation input is recommendation-only: `simulate` requires explicit
`dryRun: true` and cannot be combined with `execute: true`. A live HTTP
execution request cannot override server policy: it returns 409 while
`PREDICTIVE_HEALING_ENABLED` is false or
`PREDICTIVE_HEALING_DRY_RUN` is true.

The compact `GET /status/safety` route remains public but exposes only
allowlisted condition/quarantine classifications, counts, and aggregate
counters—never raw IDs, reasons, metadata, or entity-keyed counters. Its
detailed `GET /status/safety/self-heal` companion requires the control-plane
bearer and `arcanos:read` and includes raw operator safety state under
`safetyState`; it is not a public health check.

To release an integrity quarantine, first read its ID from the authenticated
detail route, then `POST /status/safety/quarantine/:quarantineId/release` with
the same bearer, `self-improve:control`, and either `x-confirmed: yes` or the
exact JSON confirmation `release:<quarantineId>`. The unsafe-state gate keeps
this recovery path reachable only after the pre-parser boundary has established
the operator principal; that exemption is not authorization. Recheck the public
summary after release. Self-heal/self-improve operations are not writing-plane
GPT actions, and introspection routes expose contracts or sanitized routing
metadata.

### API submodules mounted under `/api`
- `GET /api/assistants`
- `POST /api/assistants/sync`
- `GET /api/assistants/:name`
- `POST /api/sim`
- `GET /api/sim/health`
- `GET /api/sim/examples`
- `POST /api/pr-analysis/webhook`
- `POST /api/pr-analysis/analyze` (control-plane operator and `repo:verify`
  required)
- `GET /api/pr-analysis/health`
- `GET /api/pr-analysis/schema`

Direct PR analysis is repository-verification control-plane work and bypasses
the writing-plane memory-consistency gate. It accepts at most a 1.5 MB UTF-8
diff and 500 unique, normalized repository-relative file paths. Absolute,
drive, UNC, traversal, control-character, and escaping-symlink paths are
rejected. One analysis may run per process, with two starts per principal per
30 minutes. Command names and arguments remain fixed, command output capture is
bounded to 1 MiB, and public failures omit subprocess and internal exception
details. The webhook route remains an inert compatibility stub; it does not
perform the analysis described by its acknowledgement.

### SDK routes mounted under `/sdk`
- `POST /sdk/research` (control-plane operator, `mcp:invoke`, and confirmation
  required)
- `POST /sdk/workers/init` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `GET /sdk/workers/status` (control-plane operator and `arcanos:read`
  required)
- `POST /sdk/routes/register` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `POST /sdk/scheduler/activate` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `POST /sdk/jobs/dispatch` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `POST /sdk/test-job` (control-plane operator, `mcp:invoke`, and confirmation
  required)
- `POST /sdk/init-all` (control-plane operator, `mcp:invoke`, and confirmation
  required)
- `GET /sdk/diagnostics` (control-plane operator and `arcanos:read` required)
- `POST /sdk/system-test` (control-plane operator, `mcp:invoke`, and
  confirmation required)

The complete SDK namespace authenticates before parsing and terminates unknown
subpaths. Mutations share a ten-starts-per-15-minutes principal budget, one
process-local single-flight lock, a strict 1 MiB JSON limit, and the existing
confirmation challenge. Reads share a higher read-only budget. SDK failure
responses omit raw provider, database, filesystem, and worker error text.

### Standalone `arcanos-ai-runtime` API

These routes belong to the separately runnable `arcanos-ai-runtime/` workspace,
not the root backend routes documented above:

- `GET|HEAD /health` and `/healthz` are credential-free process-liveness
  probes and return only `{ "status": "ok" }`.
- `GET|HEAD /readyz` is a credential-free Redis/Queue readiness probe. It
  returns `200 { "status": "ready" }` only while the producer connection is
  ready, otherwise `503 { "status": "unavailable" }`.
- `POST /jobs` requires the purpose-bound runtime Bearer identity and
  `runtime:enqueue`.
- `GET|HEAD /jobs/:id` requires the same identity and `runtime:read`.

Authentication and scope checks precede the route-local 256 KiB JSON parser.
The configured `ARCANOS_AI_RUNTIME_PRINCIPAL_ID` is written into every new job;
caller body fields cannot choose it. Reads return the same `404` response for
an absent job, a historical job without an owner, or a job owned by another
principal. The listener accepts only UUID-v4 job IDs, returns fixed public
failure text rather than BullMQ/provider failure detail, marks responses
`no-store`, and does not accept the former `x-api-key` transport.

`POST /jobs` accepts only an exact name in the required
`AI_RUNTIME_ALLOWED_MODELS` policy, one to 100 message records, and an optional
integer `maxTokens`. The server materializes
`AI_RUNTIME_DEFAULT_MAX_TOKENS` when that field is omitted and rejects values
above the required `AI_RUNTIME_MAX_TOKENS` policy (whose absolute ceiling is
32768). Missing or malformed job policy returns
`503 AI_RUNTIME_JOB_POLICY_UNAVAILABLE` before JSON parsing.
The same path requires explicit shared Redis admission configuration. Enqueue
rate is consumed before JSON parsing; exhausted windows return fixed `429`
responses, and exhausted global reservations return fixed `503` responses, both
with `Retry-After`. Reservations are confirmed after BullMQ enqueue, claimed
with the worker's BullMQ token before provider execution, and released after a
terminal queue transition. Stale pending/live reservations are reconciled in
bounded batches, and missing jobs require two observations before release.
Because the admission ledger and high-level `Queue.add` are not one Redis
transaction, an ambiguous physical queue entry may temporarily remain, but a
job without a valid reservation cannot execute the provider.
Message roles are limited to `system`, `user`, `assistant`, `developer`, `tool`,
and `function`; content may remain a string, array, or object for compatibility.
The boundary reconstructs owned JSON and rejects repeated/cyclic references,
non-plain objects, prototype-relevant keys, nesting beyond 16 containers, more
than 8192 JSON values, arrays over 256 entries, objects over 64 keys, more than
4096 aggregate keys, individual strings over 64 KiB, content strings over
64,000 characters, or more than 192 KiB of aggregate UTF-8 string data. The
separately running worker applies the same validation, configured model/token
policy, and exact server-owned principal again before provider execution.

Completed reads do not expose the stored provider response. The public
`result` is either `{ "output_text": "..." }` (plus
`"truncated": true` when the UTF-8 text was capped at 128 KiB) or the bounded
runtime-budget timeout envelope. Provider response IDs, instructions, raw
output items, encrypted reasoning, metadata, provider error objects, and
unknown fields are omitted. New worker results are projected before BullMQ
persistence, and the read route projects historical return values again.
Resolved provider failures and unrecognized completed values use the same fixed
`"Job execution failed"` response as BullMQ failures.

The canonical Railway launcher does not start this workspace. Its actual
deployment, network ACL, proxy, and caller state cannot be inferred from source
and must be verified separately before activation or rollout. Enabling the
admission ledger requires draining the existing queue or a versioned queue
cutover. Configure the same explicit `AI_RUNTIME_QUEUE_NAME` on the new API and
worker replicas so old deployments cannot share their BullMQ/admission
namespace with the new reservation protocol.

## Verified route ownership and remaining order ambiguities
- `POST /audit` is defined in multiple routers; current mount order means AI utility handling executes first.
- `GET /health` is defined in multiple routers; health-group handler executes first because it is mounted before reinforcement and status routes.

The `/api/reusables*` routes have one canonical owner in `api/index.ts` after
the writing-plane memory-consistency gate; `register.ts` does not mount their
leaf router directly.

## Legacy ask-route mode
`src/routes/ask/index.ts` currently mounts only `/brain` for the old ask-style Trinity route. The default `ASK_ROUTE_MODE` is `gone`, so `/brain` returns `410 Gone` with canonical `/gpt/{gptId}` migration metadata. Set `ASK_ROUTE_MODE=compat` only when temporarily supporting an older caller during migration.

In compatibility mode, an async `/brain` repository outage returns HTTP `503` with `error: "ASYNC_ASK_JOBS_UNAVAILABLE"`. A wait failure after enqueue includes `jobId` and `poll`; a creation-stage failure cannot include job coordinates.


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
- The endpoint requires the same `x-arcanos-daemon-token` as every other
  `/api/daemon/*` route.
- The backend stores results temporarily (in-memory by default).
- `src/routes/ask/daemonTools.ts` will poll for results up to `DAEMON_RESULT_WAIT_MS` and feed them back to OpenAI as `function_call_output`.
