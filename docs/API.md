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

Public provider-capable HTTP ingress uses one atomic caller-plus-deployment
admission ceiling. Production counters live in shared Redis, so replicas and
rolling restarts use the same window. This covers canonical GPT writing requests,
prompt, pipeline, code-generation, public media/search/simulation, enabled
legacy GPT aliases, and `GET`, implicit `HEAD`, and `POST` `/brain` only when `ASK_ROUTE_MODE` is
`compat`. Health/status probes, provider-free diagnostics, authenticated
control-plane paths, canonical GPT control/DAG/MCP/job actions, and the
DAG/MCP/tool lanes of `/dispatch` do not consume it. Research diagnostics with
an explicit `action`, `mode`, or direct prompt signal remain provider-free;
message-only diagnostic intent is conservatively admitted before bounded
message inspection. Accepted and rejected provider admissions use
`Cache-Control: no-store`. The shared middleware sets
`X-RateLimit-*` headers plus the stable
`X-Public-Provider-Client-Remaining` and
`X-Public-Provider-Global-Remaining` counters; an admitted response may report a
later route/user fairness bucket instead. Caller exhaustion returns HTTP `429`
with `X-RateLimit-Bucket: public-provider-client` without spending global
capacity. Deployment exhaustion uses the compatibility bucket
`public-provider-instance`. Neither denial enters the downstream route handler.
At most 16 Redis admission decisions run concurrently per process (or fewer
when the deployment maximum is lower); excess bursts fail immediately with
bucket `public-provider-admission-concurrency` and never queue or touch Redis.
A second process-local token bucket permits a burst of 100 Redis admission
operation starts and then refills at 100 starts per second; cache-miss traffic above that ceiling receives
bucket `public-provider-admission-redis-start-rate`. Client and global Redis
denials are cached locally within a bounded map for at most one second and
never beyond Redis's reported TTL. The cache preserves Redis's full
`Retry-After`, is used only for the current READY lifecycle generation, and is
cleared or bypassed across outages and generation changes. It absorbs short
denial bursts without becoming an admission source of truth.
Configure the finite ceilings with `PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX`,
`PUBLIC_PROVIDER_RATE_LIMIT_MAX`, and `PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS`;
they supplement, rather than replace, route/user fairness limits. Production
Redis loss fails closed with no-store `503 REDIS_DEPENDENCY_UNAVAILABLE`.
If a limiter command fails while the lifecycle remains READY, a generation-scoped
process circuit opens immediately: later admissions return the same `503`
without consuming Redis-start tokens or issuing Redis commands until the
background capability probe succeeds or Redis advances to a new generation.

## Run locally
Quick probes:
```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/health
curl -X POST http://localhost:3000/gpt/arcanos-core -H "Content-Type: application/json" -d '{"action":"query","prompt":"hello"}'
```

## Deploy (Railway)
No API path changes are required for Railway. Validate liveness (`/healthz`),
dependency diagnostics (`/health`), the Railway activation probe (`/readyz`),
and confirmation-gated flows after deploy.

## Troubleshooting
- 403 with `CONFIRMATION_REQUIRED`: use confirmation flow headers.
- 429 with bucket `public-provider-client`: wait for the caller/cohort window shown by `Retry-After`; changing session, body/query, authorization, cookie, or forwarding metadata does not create a new bucket.
- 429 with bucket `public-provider-instance`: wait for the deployment-wide Redis window shown by `Retry-After`.
- 429 with bucket `public-provider-admission-concurrency`: retry after the fixed two-second load-shed interval; no Redis counter was read or spent.
- 429 with bucket `public-provider-admission-redis-start-rate`: retry after the reported interval; the per-process Redis-start token bucket rejected the cache miss without reading or spending either shared counter.
- 503 with `REDIS_DEPENDENCY_UNAVAILABLE` from a provider-capable route: restore the production Redis lifecycle; provider admission never falls back to process memory.
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
- Direct control plane: capability-bound `GET /jobs/:id` and `GET /jobs/:id/result`, aggregate `GET /workers/status` and `GET /worker-helper/health`, `GET /status`, `GET /status/safety/self-heal`, `POST /gpt-access/diagnostics/deep`, `GET|POST /system-state`, AFOL `GET|HEAD` inspection routes, `POST /rag/*`, `POST /mcp`, and `/api/arcanos/dag/*`.
- No public control actions are served by `POST /gpt/:gptId`; `get_status`, `get_result`, `diagnostics`, `system_state`, runtime inspection, worker status, queue inspection, self-heal status, MCP calls, and prompt-based job lookups are rejected with canonical control endpoints.

Request guidance:
- GPT identifiers are trimmed, must be non-empty, and may contain at most 256
  UTF-16 code units. The canonical route returns deterministic HTTP
  `400` with `BAD_REQUEST` before registry lookup, GPT-specific logging, GPT
  metrics, job creation, or provider work when that inclusive maximum is
  exceeded. Its structured request-log path and response metadata use
  `gptId: "invalid"` instead of the rejected caller value. Short unregistered
  identifiers retain the existing `404 UNKNOWN_GPT` behavior.
- Authenticated bridge, GPT Access, and server-established public GPT principals
  may send `Idempotency-Key` when retrying the same submission. The backend
  hashes the key before storage.
- Anonymous public GPT requests receive a fresh server-random scope for every
  submission. Replaying a caller-selected session, raw authorization header,
  request body, or `Idempotency-Key` cannot reuse a prior job or remint its read
  capability.
- If `Idempotency-Key` is absent on a reusable authenticated scope, the backend
  derives a stable semantic fingerprint from `gptId`, `action`, normalized
  prompt/input fields, and that established principal.
- Prompt/result contents are not stored in the idempotency mapping. Only hashed scope, key, and fingerprint values are persisted.

Deduplication rules:
- Reuses in-flight GPT jobs for the same authenticated caller scope and semantic request.
- Reuses recently completed GPT jobs for the same authenticated caller scope and semantic request.
- Reuses failed or cancelled GPT jobs only when an authenticated caller supplied the same explicit `Idempotency-Key`.
- Transport-only retry hints such as `async`, `executionMode`, `responseMode`, `waitForResultMs`, and polling intervals do not create a new GPT job.
- Reusing an explicit `Idempotency-Key` for a different semantic GPT request
  within the same reusable authenticated scope returns
  `409 IDEMPOTENCY_KEY_CONFLICT`.

Canonical GPT bridge:
- `query`: `POST /gpt/:gptId` with `{ "action": "query", "prompt": "..." }`
  creates one durable GPT writing job and returns its `jobId` without inline
  waiting; reuse is limited to a server-established authenticated principal.
- `query_and_wait`: `POST /gpt/:gptId` with `{ "action": "query_and_wait", "prompt": "...", "timeoutMs": 25000 }` executes core GPT requests synchronously through the lightweight direct action lane and returns the final result inline. If direct execution fails or times out, the route returns a typed error instead of synthetic bounded fallback content. Non-core GPTs keep the durable job path.
- Job status: capability-bound `GET /jobs/:id` returns structured status from the control plane without creating GPT work.
- Job result: capability-bound `GET /jobs/:id/result` returns structured job result state from the control plane without creating GPT work.
- Generated-client compatibility: body `action` is authoritative, but the router also accepts `?action=query_and_wait` and operation-style aliases such as `{ "operationId": "requestQueryAndWait" }` for clients that place GPT Action metadata outside the canonical body field.

Legacy compatibility:
- `POST /gpt/:gptId` with `{"prompt":"...","executionMode":"async","waitForResultMs":20000}` still supports one queue-backed request that either returns the final GPT result inline or times out safely with the canonical `jobId`.
- Prefer the explicit `query` and `query_and_wait` action contract for agent and tool clients because it is typed, discoverable, and easier to validate.
- Optional `pollIntervalMs` adjusts the internal polling cadence while the backend waits.
- Direct-return timeouts never enqueue a second job; they return the same canonical `jobId` and point callers to `GET /jobs/:id/result`.

Job-backed `POST /gpt/:gptId` response shapes:
- `202 Accepted` pending write: `{ ok:true, action:"query", jobId, status:"queued"|"running"|"timeout", poll:"/jobs/:id/result", stream:"/jobs/:id/stream", jobReadToken, jobReadTokenHeader:"x-arcanos-job-read-token", timedOut?, jobStatus, lifecycleStatus, deduped?, idempotencyKey, idempotencySource, _route }`
- `200 OK` completed direct action: `{ ok:true, action:"query_and_wait", status:"completed", result:"...", directAction:{ inline:true, queueBypassed:true }, _route }`
- `200 OK` completed async write for non-core durable jobs: `{ ok:true, action:"query_and_wait", jobId, status:"completed", result:{ text }, poll, stream, jobReadToken, jobReadTokenHeader:"x-arcanos-job-read-token", jobStatus, lifecycleStatus, deduped?, idempotencyKey, idempotencySource, _route }`
- Error shape: `{ ok:false, action, error:{ code, message } }`
- A repository outage after a job is accepted returns HTTP `503` with `error.code: "ASYNC_GPT_JOBS_UNAVAILABLE"` and the stable message `Async GPT job status is temporarily unavailable because durable job persistence is unavailable.` The response keeps the accepted `jobId`, `poll`, `stream`, `jobReadToken`, and `jobReadTokenHeader`; creation-stage outages cannot include job coordinates.
- If the dedicated current job-read signing key is absent or invalid, job-backed creation fails before enqueueing with HTTP `503`, `error.code: "JOB_READ_AUTH_UNAVAILABLE"`, and `Async job reads are temporarily unavailable.`
- Duplicate submissions on reusable authenticated scopes set `deduped: true`
  and return the canonical `jobId`; anonymous public submissions never do.
- Job-backed creation responses use `Cache-Control: no-store`.
- `200 OK` system-state retrieval/update: authenticated `POST /system-state`
  with `{ "sessionId": "...", "expectedVersion": 1, "patch": { ... } }` is
  handled directly on the control plane and never enters the GPT writing
  dispatcher. It requires the control-plane operator bearer, `mcp:invoke`, and
  the issued one-use confirmation challenge.
- `400 Bad Request` control rejection: prompt-based job lookups, explicit job lookup actions, diagnostics, system_state, runtime inspection, DAG control, and MCP tool calls return deterministic JSON with `canonical` control routes.

Canonical client-facing async acknowledgement:
```json
{
  "ok": true,
  "status": "completed | queued | running | timeout",
  "jobId": "job-id",
  "poll": "/jobs/job-id/result",
  "stream": "/jobs/job-id/stream",
  "jobReadToken": "v1.<job-specific-signature>",
  "jobReadTokenHeader": "x-arcanos-job-read-token",
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
- `GET /jobs/:id`: requires `x-arcanos-job-read-token` and returns `{ id, jobId, job_type, status, lifecycle_status, created_at, updated_at, completed_at, cancel_requested_at, cancel_reason, retention_until, idempotency_until, expires_at, poll, stream, error_message, output, result }`.
- `GET /jobs/:id/result`: requires `x-arcanos-job-read-token` and returns the canonical result lookup envelope, including `jobId`, job/lifecycle status, polling links, result, and a typed error when applicable. A missing job returns HTTP `200` with `status: "not_found"` for compatibility.
- `GET /jobs/:id/stream`: requires `x-arcanos-job-read-token` and emits an SSE stream of status changes. The event name is `terminal` when the payload status is `completed`, `failed`, `cancelled`, or `expired`; nonterminal changes use the `status` event.
- `POST /jobs/:id/cancel`: requires the matching
  `x-arcanos-job-read-token`, confirmation, and the creation surface's
  authenticated owner. Public GPT jobs require the same server-established
  principal, bridge jobs revalidate the configured bridge credential, and Ask
  jobs retain their existing session/internal actor check. Anonymous public GPT
  jobs are intentionally non-cancellable. The read capability is verified
  before storage work but is not cancellation authority by itself.
  A queued `gpt` or `ask` job cancels immediately; a running one receives a
  best-effort cancellation request. Other job types are concealed as missing.
- The three generic reads and cancellation accept exactly one header value. The bearer capability is bound to the path job id and is never accepted from a query parameter, cookie, or request body.
- A missing, malformed, duplicated, incorrect, or cross-job token is concealed like a missing job: status, stream, and cancellation return HTTP `404`, while result returns HTTP `200` with `status: "not_found"`.
- If neither the current `ARCANOS_JOB_READ_CAPABILITY_SECRET` nor the optional
  previous verification key resolves validly, these routes return HTTP `503`
  with `JOB_READ_AUTH_UNAVAILABLE` and a fixed public message, without querying
  job storage. Job-backed creation always requires the valid current key.
- New tokens are issued from the current key only. During rotation, configure
  the old key as `ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET` for verification
  until retained jobs drain, then remove it.
- When job persistence is unavailable, the status, result, and cancellation routes return HTTP `503` with `{ "error": "JOB_REPOSITORY_UNAVAILABLE" }`. This is distinct from a successful missing-job lookup.
- If persistence is unavailable before an SSE stream opens, `/jobs/:id/stream` returns the same JSON `503`. If it becomes unavailable after streaming begins, the route emits `event: error` with `{ "code": "JOB_REPOSITORY_UNAVAILABLE", "jobId": "..." }` and closes.
- These generic reads and cancellation expose `ask` jobs plus only those `gpt`
  jobs whose persisted server-owned provenance identifies `/gpt/:gptId` or the
  custom GPT bridge. GPT Access-created jobs and every other job type are
  returned exactly like missing jobs, even if a caller presents a
  mathematically valid generic capability; intended operator detail remains
  available through authenticated, protected deployment surfaces such as
  `POST /gpt-access/jobs/result`.
- GPT idempotency scopes are creation-surface namespaced. Public GPT, custom
  bridge, and GPT Access requests cannot dedupe onto one another. The first
  deployment of this isolation intentionally does not reuse pre-deployment
  unnamespaced rows, so one bounded retry window may create replacement work.
- Within the public GPT namespace, requests without a server-established
  principal receive non-reusable random scopes. Caller-selected sessions, IPs,
  cookies, and raw authorization headers are not ownership identities.
- The generic job SSE route uses `Cache-Control: no-store, no-cache, no-transform`,
  including JSON failures returned before a stream opens.

GPT job lifecycle:
- Storage states: `pending`, `running`, `completed`, `failed`, `cancelled`, `expired`
- API alias: `lifecycle_status: "queued"` is emitted for stored `pending`
- Running-job cancellation is best effort; queued jobs cancel synchronously
- Running stale jobs are recovered through oldest-first, server-bounded worker
  lease-inspector passes. Overlapping passes skip rows already locked by another
  recovery transaction; overflow remains eligible for later passes.
- Old terminal GPT jobs transition to `expired`, then are compacted after an additional grace window

Retention defaults:
- Completed GPT jobs: 24h retention
- Failed GPT jobs: 6h retention
- Cancelled GPT jobs: 1h retention
- Idempotency reuse window: 24h, capped by the terminal state retention window
- Pending GPT jobs that sit unclaimed for too long are expired by lifecycle maintenance

Generic queue result retention:
- Completed and cancelled `ask` jobs remain readable for 24h by default.
- Completed and cancelled internal `dag-node` rows are retained for 1h by default; durable DAG run snapshots and artifacts have separate ownership.
- `QUEUE_ASK_TERMINAL_RETENTION_MS` and `QUEUE_DAG_NODE_TERMINAL_RETENTION_MS` are independently configurable from 1h through 30 days.
- Cleanup is bounded and positively allowlisted to those two types and two statuses. It never deletes GPT, local-agent, failed, pending, running, unknown-type, active-idempotency, or null-deadline legacy rows.
- Cleanup also preserves rows throughout the one-hour worker-budget accounting window and any longer configured queue-diagnostics window. After the result deadline, active idempotency window, and observation protection have all elapsed, generic reads return the existing `not_found` contract. Lifetime queue totals describe currently retained rows.

Client retry guidance:
- Reuse the same `Idempotency-Key` only on authenticated bridge, GPT Access, or
  server-established public GPT requests. An anonymous public GPT retry creates
  independent work; retain and continue the first returned job instead.
- Retain the `jobReadToken` returned with the `jobId`; poll `GET /jobs/:id` or subscribe to `GET /jobs/:id/stream` after any `202` with that token in exactly one `x-arcanos-job-read-token` header.
- Use the canonical direct jobs API or the protected GPT Access result operation for job reads; `/gpt/:gptId` does not provide a job-read compatibility action.
- ARCANOS CLI follows the same split: `arcanos query` and `arcanos query-and-wait` use the writing plane and preserve the returned capability for automatic polling, while independent `arcanos job-status` and `arcanos job-result` calls require the matching token through `ARCANOS_JOB_READ_TOKEN`.
- Natural-language retrieval through `prompt` text is intentionally blocked. Retrieval must use `GET /jobs/:id`, `GET /jobs/:id/result`, or `POST /gpt-access/jobs/result`.
- Do not send prompts that ask the GPT route to inspect runtime state, trigger DAGs, or call MCP tools. Use the direct control endpoints instead.
- Treat `cancelled` and `expired` as terminal and submit a fresh request if more work is needed.
- Treat repository-unavailable `503` responses as temporary: retain any returned `jobId` and `jobReadToken`, then retry the same result lookup with bounded backoff. Never reinterpret `503` as `not_found` or create replacement work solely because status storage is temporarily unavailable.
- Unexpected failures after persistence return a safe `202` continuation when
  the response is still open, so clients retain the accepted job ID and bearer
  instead of submitting duplicate work.

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
  timestamp but replace persisted failure text with fixed category labels;
  aggregate last-job status/completion time remain available without a job ID
  or reusable lookup locator)
- `GET /status` (deprecated no-store alias for the public health response;
  unexpected failures retain the deprecation headers and return a fixed
  `500` message without exception text)
- `POST /status` (confirmation required; confirmation challenges and handler
  responses are no-store, and persistence failures return fixed text)
- `POST /heartbeat` (confirmation required)
- `GET /api/test`
- `GET /api/fallback/test`

The root backend's credential-free `/readyz` checks OpenAI, database, Redis,
public-provider admission capability, and startup readiness in that order. It
returns `200` only when every critical
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
correlation. Railway deployments use `GET /readyz` for activation; retain
`GET /healthz` for liveness and `GET /health` for dependency diagnostics.

### Core AI interaction
- `POST /gpt/:gptId` (canonical GPT writing plane; valid Backstage mutation
  actions additionally require the control-plane operator boundary described
  below)
- `POST /dispatch` (universal GPT/DAG compatibility dispatcher; requests that
  select DAG execution use the canonical DAG client-admission, control-plane
  operator, `mcp:invoke`, principal-admission, and `no-store` policy before a
  run can be created; GPT-selected Backstage mutations use the separate shared
  Backstage operator boundary; other GPT-selected requests retain compatibility
  behavior. On the GPT lane, an explicit body `gptId` after trimming may contain
  at most 256 UTF-16 code units. An oversized value returns a bounded,
  deterministic HTTP `400` response with `error.code: "BAD_REQUEST"` and
  `gptId: "invalid"` before provider admission, registry resolution, or GPT
  work, so it consumes no public-provider quota. When the existing selector
  precedence resolves a request to the DAG or MCP/tool control lane, that lane
  remains authoritative and any unused `gptId` is not validated; omitted or
  blank GPT-lane values use the `arcanos-core` default. Asynchronous branch
  failures return the stable `500 DISPATCH_FAILED` envelope without internal
  exception text)
- `GET|HEAD|POST /brain` (legacy ask-compatible route; returns `410 Gone` by default; `ASK_ROUTE_MODE=compat` enables the compatibility handler and then requires confirmation; GET uses query input while POST and implicit HEAD use body input)
- `GET /trinity/status` (public aggregate worker-health projection; `no-store`)
- `POST /arcanos` (confirmation required)
- `POST /arcanos-pipeline`
- `POST /siri` (confirmation required)
- `POST /api/ask-hrc`
- `POST /api/arcanos/ask` (deprecated compatibility route; prefer `/gpt/:gptId`)
- `POST /api/arcanos/dag/runs` (control-plane operator and `mcp:invoke`
  required)
- `GET|HEAD /api/arcanos/dag/runs/:runId/admission` (exact-run admission
  monitor; control-plane operator and `mcp:invoke` required)
- Other `GET|HEAD /api/arcanos/dag/runs/*` inspection routes
  (control-plane operator and `arcanos:read` required)
- `POST /api/arcanos/dag/runs/:runId/cancel` (control-plane operator and
  `mcp:invoke` required)

The exact `/api/arcanos/dag/*` boundary authenticates before broad request
parsing, marks responses `no-store`, and assigns read versus execution scopes
by method and canonical path. Both the boundary and the existing per-route
limits use the authenticated control-plane principal, so rotating caller-owned
session IDs does not create fresh DAG execution buckets.

DAG run creation also has a per-web-process active-run limit. When that
capacity is full, `POST /api/arcanos/dag/runs` returns `429` with
`DAG_RUN_CAPACITY_EXCEEDED` and a `Retry-After` header. If the initial durable
snapshot commit cannot be confirmed, creation remains an accepted request: it
returns `202` with `Retry-After`, a `Location` under
`/api/arcanos/dag/runs/:runId/admission`, and a stable admission identity
containing the `runId` and snapshot generation. The admission monitor requires
the same `mcp:invoke` scope as creation and reports distinct `pending`,
`admitted`, and `rejected` states. `pending` and `admitted` always set
`createNewRun: false`; only a definitive `rejected` state sets
`createNewRun: true`. A temporarily unavailable monitor returns `503` for the
idempotent `GET`, preserves `createNewRun: false`, and directs the caller to poll
the same URL. Clients must never repeat the create `POST` while admission is
pending or unavailable, and full run inspection remains separately protected by
`arcanos:read`. An accepted cancellation first persists cooperative
cancellation intent, then returns `202` with
`status: "cancellation_requested"`; a repeated request or an already-cancelled
run returns `200`. A confirmed absent run returns `404 RUN_NOT_FOUND`, a
complete or failed run returns `409 RUN_NOT_CANCELLABLE`, and an active run
owned by another replica or unavailable/corrupt control persistence returns
`503` with `DAG_RUN_OWNED_ELSEWHERE` or `DAG_RUN_CANCELLATION_UNAVAILABLE` plus
`Retry-After`. Cancellation does not release the admitting replica's capacity
reservation until the background execution promise settles.

### State and Custom GPT bridge
- `GET /system-state` (control-plane operator and `arcanos:read` required)
- `POST /system-state` (control-plane operator, `mcp:invoke`, and an issued
  one-use confirmation challenge required)
- `POST /backstage/book-event` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `POST /backstage/book-gpt` (control-plane operator, `mcp:invoke`, and
  confirmation required because the generated storyline is saved)
- `POST /backstage/update-roster` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `POST /backstage/track-storyline` (control-plane operator, `mcp:invoke`, and
  confirmation required)
- `POST /backstage/simulate-match` (public caller identity; existing
  confirmation requirement retained)
- `POST /api/bridge/gpt`
- `POST /api/openai/gpt-action` (bridge compatibility alias)
- `GET /api/bridge/health` (requires the bridge shared secret; returns a
  no-store operational payload with fixed database and worker failure text)

System-state authentication and method-specific authorization run before broad
request parsing. Mutation JSON is strict and capped at 64 KiB; every response
is marked `no-store`, and unknown protected subpaths terminate within the
control-plane boundary. A rejected mutation returns
`x-confirmation-challenge`; retry the same authenticated request body with
`x-confirmed: token:<challenge-id-placeholder>`. The token is one-use and bound to the
authenticated principal and request body; manual `yes`, trusted-client, and
automation bypasses are not accepted. The server accepts caller-selected
`sessionId` values up to 100 characters for compatibility. This is
deployment-wide operator containment, not tenant or per-session ownership
enforcement.

Backstage generation and simulation actions remain public through the
canonical GPT and compatibility writing routes: `generateBooking`,
`generateBookingWithHRC`, and `simulateMatch`. `queryContinuity` is registered
on the module surfaces, but Notion-authoritative execution requires the
dedicated bearer provenance established only by canonical
`POST /gpt/backstage-booker`; compatibility aliases fail closed instead of
falling back to legacy state. The state-changing module actions
`bookEvent`, `updateRoster`, `trackStoryline`, `saveStoryline`,
`upsertStoryline`, and `appendCanonBeat` require
`Authorization: Bearer <ARCANOS_CONTROL_PLANE_ACCESS_TOKEN>`, the configured
operator principal, the server-owned `mcp:invoke` scope, and the existing
confirmation contract through `/gpt/:gptId`, GPT-selected `/dispatch`,
`/modules/backstage-booker`, and `/queryroute`. The same control-plane principal
has one shared 10-attempts-per-15-minute Backstage mutation budget across these
aliases; invalid credentials use a separate 120-per-15-minute ingress-address
budget. Protected responses are `no-store`. Direct mutation paths establish
identity before broad body parsing; action-selecting aliases parse first so the
server can preserve public continuity queries, generation, and simulation.
Confirmation is approval,
not authentication. Issued confirmation challenges are bound to the authenticated
principal, request path, canonical mutation action, and normalized mutation
payload, so a token cannot be replayed across Backstage actions or equivalent
envelope shapes. GPT Access and HTTP MCP retain their
own existing bearer, scope, and allowlist boundaries rather than requiring two
bearer credentials on one request.

The Builder-specific schema `1.4.0` at
`GET /contracts/backstage_booker.openapi.v1.json` defines four operations. Its
saved dedicated bearer is declared on all four so Notion-authoritative
continuity queries and generation have verified provenance. The underlying
generation and simulation route remains publicly compatible for
non-authoritative direct clients; `queryContinuity` has no non-authoritative or
legacy fallback.
`getBackstageUniverse`
calls exactly
`GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}`. It
requires the purpose-bound `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN`, is marked
`x-openai-isConsequential: false`, and reads one repeatable PostgreSQL snapshot
without module dispatch, generation, confirmation, persistence, or an in-memory
fallback. Each of the snapshot's seven bounded data statements has a 3.5-second
transaction-local PostgreSQL timeout so an unavailable read becomes a retryable
`503` rather than an empty result. The read-specific SQL bounds legacy names,
event fields, story-beat payload transfer, and saved-storyline fields before
Node materializes them. It exposes no collection listing or display-name
lookup. The response is a closed projection: at most 25 roster entries, 5
recent events, 5 recent story beats, 5 saved storylines, 8 typed canon
storylines, and 12 active canon beats; strings, participant arrays, and the
serialized response are also bounded. `truncation` reports trimming and
omissions after those source queries. It does not count older rows beyond
`sourceQueryLimits`; a collection equal to its source limit may therefore be a
recent window rather than complete history. Because there is no
universe registry, an ID with no stored rows returns an empty `200` snapshot
with `hasPersistedData: false`. A Notion-authoritative universe instead returns
nonretryable `409 BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED` without reading
the legacy snapshot.

When that snapshot truncates a canon storyline summary, the non-consequential
`getBackstageStoryline` operation calls
`GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary`
with the exact `storylineKey`. It performs a direct indexed PostgreSQL lookup
inside a repeatable-read, read-only transaction and returns the unmodified
stored summary in fixed 4,000-Unicode-code-point pages. Page zero may omit
`expectedVersion`; every nonzero `offset` must carry the version returned by
page zero. A changed version returns `409 BACKSTAGE_STORYLINE_VERSION_CONFLICT`
so callers cannot combine two revisions. An absent exact universe/key pair is
`404 BACKSTAGE_STORYLINE_NOT_FOUND`; a database outage is retryable `503`.
This path has no list, generation, mutation, confirmation, or memory fallback.
A Notion-authoritative universe returns the same nonretryable authority
quarantine `409` without reading legacy canon.

`generateBooking` and `generateBookingWithHRC` can optionally enrich their
existing PostgreSQL-derived model request with explicitly mapped Notion pages.
This legacy supplement adds no endpoint or module action. It runs only on
canonical synchronous Backstage generation when the request carries the valid dedicated Backstage
bearer and both `ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` and
`ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` are valid on the web service.
Missing/invalid authentication, incomplete configuration, an unmapped universe,
or a PostgreSQL-context failure preserves the existing database/process-memory
behavior and makes no Notion request. Exact-literal responses and match
simulation do not load Notion.

The backend calls only Notion's fixed page-Markdown read endpoint for one to
three configured raw page UUIDs, never a caller URL. Redirects are rejected;
all page reads share one four-second deadline and each response is capped at
256 KiB. Sanitized, quoted excerpts are capped at 4,000 Unicode code points per
page and 12,000 total. Unknown child blocks are reported as partial but never
followed. The backend places the Notion data in its own delimited user message
before the primary booking request and adds a server-owned system policy that
instructs the model to treat PostgreSQL state as authoritative, ignore
instructions in Notion, and limit use to nonconflicting background. This
role/order boundary reduces prompt-injection risk, but model adherence and
semantic conflict detection are not deterministic; the generated answer is not
automatically checked against PostgreSQL or the source excerpt. Notion has no
write or database-mirroring path. Enriched runs disable optional internal
judged feedback/self-improvement, replace lineage input/output summaries with
fixed redaction markers, suppress response content from prompt-debug traces,
and skip generic module-conversation transcript persistence. Non-content audit
metadata and token counts remain observable. Enriched HRC reviews bypass the
shared result cache and sanitize provider-failure verdicts. Both enriched
generation and its sensitive HRC follow-up force OpenAI Responses `store: false`
regardless of the global `OPENAI_STORE` value. The selected excerpts are still
sent to the configured OpenAI generation provider and the generated answer is
returned to the authenticated caller. Notion provider/configuration failures
are sanitized and fail open to PostgreSQL-only generation; an ambient request
abort still stops the operation.

When an exact universe is instead present in
`ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON`, that legacy supplement and its
fail-open semantics are bypassed. A worker recursively captures the complete
configured root hierarchy, rejects incomplete/truncated/unknown or unsupported
media candidates, builds an immutable chunk-and-embedding snapshot, and
atomically advances one universe-scoped active head. `relevant` continuity
queries and generation embed the caller query and rank only chunks from that
active snapshot; `complete_scope` continuity reads instead page through the
resolved scope in deterministic source order without a query embedding. Both
paths supply provenance-framed excerpts as facts with zero instruction
authority and require the valid dedicated Backstage bearer and a recently
verified snapshot. No request-time Notion call occurs on web, and missing auth,
stale/missing index, model mismatch, or retrieval failure returns
`BACKSTAGE_NOTION_INDEX_UNAVAILABLE` without consulting legacy PostgreSQL or
process memory.

`queryContinuity` is read-only and requires `payload.universeId` plus
`payload.query`; it never substitutes the compatibility `legacy` universe. An
optional `payload.retrievalScope` requires an exact `pageTitle` and may add
`pagePath` to disambiguate duplicate titles. `scopeKind` defaults to `"page"`:
that scope selects only the exact page and may add `sectionPath` for one exact
heading and its descendant headings. Explicit `scopeKind: "subtree"` selects
the exact parent plus all descendant pages, never a sibling. A blank navigation
parent can anchor a subtree when its descendants contain indexed content.
`sectionPath` and `scopeKind: "subtree"` are mutually exclusive. The request
accepts no caller page ID or URL. Repeated normalized full heading paths remain
distinct internal occurrences; an exact `sectionPath` that matches more than
one returns a nonretryable ambiguous-scope `409` instead of conflating them.

The default `retrievalMode: "relevant"` returns a bounded relevance sample and
diversifies a subtree sample across its pages. `"complete_scope"` orders the
resolved page or subtree deterministically and returns an opaque
`coverage.nextCursor` while `coverage.hasMore` is true. A continuation must
preserve the exact universe, query, scope (including `scopeKind`), and mode;
cursors are request- and snapshot-bound and integrity-protected. A malformed,
tampered, stale, or differently bound cursor returns nonretryable
`409 BACKSTAGE_NOTION_CURSOR_INVALID`; restart the complete scoped read without
that cursor. Cursor version 2 is intentionally invalid after the 1.4.0 rollout,
so an in-progress older read must also restart cursor-free. The action is
request-local and synchronous-only and never creates or resumes a worker job.

The structured result contains `authority: "notion"`, the synthesized answer,
an optional normalized `resolvedScope`, explicit `coverage`, and sanitized
`sources`. Every result reports `coverage.status`, `scopeChunks`,
`selectedChunks`, `omittedChunks`, `promptTruncated`, `exhaustive`, and
`hasMore`. Only a subtree result additionally reports
`resolvedScope.scopeKind: "subtree"` plus `coverage.scopePages`,
`selectedPages`, and `omittedPages`; page, section, and unscoped responses omit
those four subtree-only fields. Page counts include only pages with indexed
chunks, so a blank anchor can resolve without increasing them. These fields
prevent a bounded sample or page from being represented as complete. Sources
expose only opaque chunk/content
hashes plus bounded page titles, page paths, heading paths, and categories; raw
excerpts and Notion page IDs remain server-side. Deploy schema 1.4.0 before
re-importing it into the existing Builder Action. Answer
generation performs one compact retry only when the provider reports
max-output exhaustion, reusing the same retrieval and runtime budget. Other
provider failures are not retried; a second length exhaustion or an enforceable
exact/maximum compact-contract violation becomes the sanitized
`BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE` error without partial output or a third attempt.
Other internal continuity-answer failures become the cause-free,
nonretryable `BACKSTAGE_CONTINUITY_QUERY_FAILED` error.
Readers also reject snapshots from before the current heading-aware index
format with `BACKSTAGE_NOTION_INDEX_UNAVAILABLE`; the worker must rebuild and
activate a compatible snapshot before continuity reads resume.

Authority mode is one-way: Notion is the source of truth and PostgreSQL stores
only the derived retrieval snapshots for AI use. The six legacy mutation
actions fail with nonretryable `409 BACKSTAGE_NOTION_AUTHORITY_READ_ONLY` before
any counter, repository, fallback, audit, or generation-and-save side effect.
Database triggers independently reject legacy table writes after the first
snapshot activation. Existing `getBackstageUniverse` and
`getBackstageStoryline` PostgreSQL reads fail with nonretryable
`409 BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED`; they never relabel old canon
as Notion data. Match simulation accepts an explicitly supplied numeric roster
but does not infer ratings from retrieved prose or fall back to the old roster.
The current text/table-only 18-page WWE hierarchy is supported. A later file,
image, audio, video, PDF, database, unknown block, or inaccessible descendant
prevents replacement activation until an explicit extractor exists.

The first successful activation also stores a durable PostgreSQL authority
head. Removing the environment mapping cannot downgrade that head or reopen
legacy reads, writes, process-memory fallback, or old canon. A configured root
and persisted root must match exactly; later snapshots may rotate only within
that same root hierarchy. Cutover drains in-flight legacy reads and writes
before the head flip, and database fencing makes stale transactions fail
closed. If the backend cannot determine the effective authority state, it
returns retryable
`503 BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE` with a fixed message instead of
assuming PostgreSQL authority.

The `writeBackstageCanon` operation calls exactly
`POST /gpt-access/capabilities/v1/backstage-booker/run`, uses the same dedicated
credential, and accepts only `upsertStoryline` or `appendCanonBeat`. The
operation is marked `x-openai-isConsequential: true`; on this dedicated lane the
backend relies on ChatGPT's Allow/Deny banner and does not issue its own
confirmation challenge. The fixed write lane may bypass generic
`ARCANOS_GPT_ACCESS_SCOPES` `capabilities.run` authorization, but the exact
`MCP_ALLOW_MODULE_ACTIONS` allowlist entries still apply. The Builder projection
requires the dedicated bearer for continuity queries, generation, simulation,
exact reads, and writes. At the backend boundary it gates private Notion
retrieval but cannot
authorize another action; non-authoritative direct generation retains public
compatibility. It is distinct from both
`ARCANOS_GPT_ACCESS_TOKEN` and `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN`. The generic
GPT Access credential is not accepted for either Backstage read; its existing
confirmation path for the canon capability run remains unchanged. All four
Phase One mutations and every direct/control-plane/dispatch/legacy alias retain
the existing confirmation contract. Authenticated canon bodies use strict
UTF-8 JSON with a 256 KiB transport ceiling; malformed, oversized, and
unsupported representations return bounded no-store error envelopes.
`universeId` selects data scope and never supplies authorization.

This single-banner design trades an independently verified backend approval
for trust in ChatGPT's consequential-action enforcement. The backend proves
possession of the shared Action credential but not per-user identity or that a
specific person saw the banner. The write route remains restricted to the
version-fenced, mutation-ID-idempotent canon writes; do not place the bearer in
the schema, GPT instructions, chat, source, or logs. Builder configuration and
rotation guidance are in
[BACKSTAGE_BOOKER_CUSTOM_GPT.md](BACKSTAGE_BOOKER_CUSTOM_GPT.md).

#### Backstage Booker Phase 1 contract

The Phase One action set on `POST /gpt/backstage-booker` and its `backstage`
GPT-ID alias consists of `bookEvent`, `updateRoster`, `trackStoryline`,
`simulateMatch`, `generateBooking`, `generateBookingWithHRC`, and
`saveStoryline`. Their canonical payloads are closed JSON objects and accept an
optional `universeId`; omitting it selects `legacy` for compatibility. An
explicit ID must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
`universeId` is a caller-selected data scope, not authentication, ownership,
or tenant isolation; deployment middleware must authorize the caller before
exposing another universe's data.

On an upgraded database, accepting a non-`legacy` ID does not by itself mean
that durable universe writes are activated. Runtime startup performs only the
expand step and retains the two legacy global uniqueness constraints. Until
all older Backstage replicas are drained and
`20260814_backstage_universe_scope_v1.sql` removes those constraints, the
repository rejects every non-`legacy` database mutation before its domain
write; the structured action reports `non_durable` with
`reason: "database_write_failed"` and uses its scoped process-memory fallback.
`legacy` writes remain eligible for durable storage throughout that window.
Fresh databases created by this version also retain the two legacy constraints,
so the reviewed explicit migration remains the only activation boundary.

The direct `/backstage` compatibility routes continue accepting their
established request shapes while also accepting the universe scope used by
the module-action schemas. Their existing `success`, `eventID`, `storyline`,
`roster`, and `result` fields stay in place as applicable; `universeId`,
canonical result aliases, and `persistence` are additive. `generateBooking`
may likewise return its legacy raw storyline string through the module action
for compatibility. Explicit full-show, card, or booking-state review-only
directives (including requests to review, critique, assess, evaluate, analyze,
rate, grade, or provide an evaluation) use an internal bounded synthesis mode:
six concise evaluation bullets, no exhaustive show-state recap, no invented
result for a match identified as unfinished, and at most 1,600 output tokens.
Classification uses a quote-aware scan of directive-shaped request clauses
throughout the prompt. An explicit mixed request to book, rebook, rewrite,
draft, or continue vetoes the bounded mode and retains the ordinary creative
booking mode and its configured output budget. Quoted or attributed dialogue
inside supplied show state is inert, while narrow decision analysis or
recommendations also stay in ordinary mode. This response shaping changes
neither action payloads nor response schemas.

Mutation results expose one of these persistence receipts:

| `status` | Meaning | Retry guidance |
| --- | --- | --- |
| `durable` | The PostgreSQL transaction committed. | No persistence retry is needed. |
| `non_durable` | PostgreSQL was unavailable or a known write failure occurred before commit; the accepted result exists only in the universe-scoped process-memory fallback. | Reconcile or deliberately repeat after durable storage recovers. |
| `unknown` | A commit was attempted, but its outcome could not be confirmed. The uncertain write is not published to fallback or convenience memory; roster and beat responses expose only the last known local view. | Do not blindly retry; reconcile by the returned universe and record identity. |

The structured mutation responses carry this receipt alongside their canonical
result fields. In particular, `saveStoryline` returns `saved: true` for
`durable` and `non_durable` outcomes, but `saved: null` when persistence is
`unknown`; it never claims that an indeterminate commit saved or failed.

Generation context is read from one universe in a read-only repeatable-read
snapshot. Each durable mutation is a transaction. Legacy roster updates retain
the original fixed lock, while activated non-legacy rosters serialize by
universe before their read-after-write response. This phase establishes
scope and persistence correctness only; it does not define a canon graph,
storyline lifecycle engine, or visual booking workspace.

`bookEvent` accepts one JSON object whose compact serialized UTF-8 form is at
most 65,536 bytes; oversized events are rejected before database, fallback, or
audit effects. Process-memory continuity retains immutable JSON snapshots and
shares one per-universe budget across durable event cache entries and pending
events: at most 25 entries and 262,144 serialized bytes total. Durable cache
entries are discarded before accepted pending continuity when that budget is
full. The process fallback retains at most 32 universe states, never evicts a
state with pending continuity or an active roster, story-beat, or saved-storyline
mutation, and removes completed storyline-version and convenience-publication
fences once no older operation can still publish through them.

`trackStoryline` accepts one JSON object whose compact serialized UTF-8 form is
at most 16,384 bytes. A successful database mutation serializes insert, cleanup,
retention, and read under the original fixed storyline advisory lock plus a
relation writer fence, with every row operation still filtered by universe. The
fixed lock and relation fence preserve ordering and containment with legacy
replicas during a mixed-version drain; storyline writes across different
universes therefore remain serialized. The transaction retains the
newest 100 beats and returns the newest 25 in oldest-to-newest order, always
including the beat just accepted. Canonical and direct responses are structured
as `{ universeId, beats, persistence }`; the direct route also preserves
`storyline` as an alias of `beats`. A classified availability or known write
failure before commit uses the replica-local, per-universe fallback with the
same 100-retained/25-returned limits and reports `non_durable`. An indeterminate
commit reports `unknown`, returns only the last known fallback beats (or an empty
array), and never appends the uncertain beat or writes its convenience mirror.
Integrity and other unclassified failures remain server errors. Recent booking
context reads bypass the process-local SQL cache, and fallback prompt context is
limited to the newest five beats.

Named `saveStoryline` entries remain scoped by `(universe_id, story_key)` and
have no automatic expiry. For `durable` and `non_durable` structured results,
the Booker service is the authoritative convenience writer: it writes
`storyline:latest` and a collision-resistant
`storyline:by-key:<sha256-of-trimmed-key>` mirror under the universe prefix.
Durable saves serialize per universe, obtain their revision after taking the
transaction lock, and fence both per-key and latest mirrors by commit order so
delayed acknowledgements cannot regress either view.
The hash keeps exact-memory keys distinct and under the 255-character storage
limit even for a maximum-length universe ID and storyline key. Dispatcher-level
conversation persistence detects the structured receipt and does not duplicate
or overwrite those mirrors. An `unknown` save returns `saved: null` and performs
no fallback, audit, latest, or by-key mirror mutation.

PostgreSQL-bound text is validated before effects. `saveStoryline` keys and
storylines, plus every string value and property name nested in `bookEvent`
event JSON, reject U+0000 and unpaired UTF-16 surrogate code units. Valid
surrogate pairs and astral characters remain accepted. Storyline keys are
bounded to 240 Unicode code points after trimming; storyline content is
bounded to 100,000 Unicode code points.

The `updateRoster` payload is an array of at most 100 supplied items per
request. Each item must be a plain JSON object whose `name` is a string and
whose `overall` is an integer from 0 through 100. The server trims each name;
the result must contain 1 through 120 Unicode code points. Duplicate trimmed
names within one request are rejected using exact, case-sensitive comparison,
while names that differ only by case remain distinct. Accepted items are
normalized to exactly `{ name, overall }`, so additional properties are
discarded. Names containing U+0000 or unpaired UTF-16 surrogates are rejected
before database work because PostgreSQL `TEXT` cannot store them. An empty
array remains a valid refresh request: it performs no upserts and returns the
current roster. The 100-item limit applies to supplied
items in one request; it does not delete existing wrestlers or impose a total
stored-roster limit. Canonical GPT, dispatch, and legacy compatibility
preflights preserve `BACKSTAGE_ROSTER_INVALID` and
`BACKSTAGE_STORYLINE_INVALID` for their respective invalid payloads. The direct
`/backstage` routes also return HTTP `400` with
`{ success: false, error: { code, message } }` for those established validation
failures; `error.code` is the corresponding `BACKSTAGE_ROSTER_INVALID` or
`BACKSTAGE_STORYLINE_INVALID` value. Other contract-schema failures retain the
canonical action and validation `issues`. GPT Access exposes validation as
`GPT_ACCESS_VALIDATION_ERROR`; MCP `modules.invoke` exposes `ERR_BAD_REQUEST`
with the corresponding Backstage validation code as its error category.

Accepted roster mutations use one PostgreSQL transaction containing a
cluster-wide transaction-scoped advisory lock, a bulk upsert, and the fresh
post-write roster read. The `legacy` universe deliberately retains the original
fixed advisory-lock identity so new replicas serialize with older ones during
the drain. Activated non-legacy universes derive deterministic hashed lock
resources from their universe IDs, allowing independent universe snapshots to
proceed without changing legacy lock compatibility. A successful commit updates
the process-local known view,
and a monotonic database revision fences both that view and the conditional
`backstage-universe:{universeId}:roster:latest` convenience write so a delayed
older commit acknowledgement cannot regress either snapshot. The service is the
authoritative writer for this structured mirror.

A classified database-unavailable or known pre-commit write failure merges the
request into the same per-universe process-memory view, writes a convenience
snapshot carrying the `non_durable` receipt, and returns that structured roster.
A lost commit acknowledgement instead returns `unknown` with the last known
local roster (or an empty array) and performs no fallback or convenience
mutation. Unclassified integrity and programming failures still fail closed as
server errors. These persistence rules do not change the request limit: at most
100 wrestlers may be supplied in one update, while the stored roster has no
100-item total cap.

The one-argument `updateRoster` and `trackStoryline` service overloads retain
their pre-Phase-1 raw-array behavior and typed compatibility errors, including
`BACKSTAGE_ROSTER_PERSISTENCE_FAILED` and
`BACKSTAGE_STORYLINE_PERSISTENCE_FAILED`. Existing transport and queued-result
adapters continue to recognize those codes. Classified failures on the new
structured action path use persistence receipts instead; an `unknown` receipt
is never rewritten as a legacy persistence error.

Match simulation accepts the ratified `0` through `100` ratings. When both
wrestlers have rating `0`, the base matchup is explicitly `0.50`/`0.50` before
the existing bounded modifier and interference rules are applied.

Canonical async Backstage mutations persist a server-generated admission record
binding the admitted operator principal to the resolved Backstage module and
action. Both the normal worker and priority direct executor require that record
and fail closed if it is absent or no longer matches current routing; queued
rows created before this policy cannot newly execute a Backstage mutation.
The established control-plane principal also supplies the idempotency actor, so
an operator retry with the same idempotency key stays in one authenticated
scope instead of creating a new anonymous scope.

#### Backstage Booker Phase 2A canon contract

Phase 2A adds the `upsertStoryline` and `appendCanonBeat` module actions. They
are module-action schemas, not top-level Arcanos command IDs, and do not change
the seven Phase One request/response schemas. Both actions require an explicit
`universeId`, a UUID `mutationId`, and an exact `expectedVersion`; canon writes
never default to the `legacy` universe implicitly. Through the existing
direct, canonical GPT, dispatch, module, queryroute, and legacy aliases they
use the same control-plane `mcp:invoke` and one-use confirmation boundary as
the Phase One mutations. The purpose-bound Backstage Booker Custom GPT lane
may call only these two actions at the exact capability route with its
dedicated bearer and ChatGPT consequential-action approval; it does not issue
the second backend challenge. No new direct `/backstage` compatibility route
is introduced.

`upsertStoryline` creates or replaces one typed storyline aggregate. Creation
uses `expectedVersion: 0`; updates must supply the current positive version.
The closed `storyline` object contains `key`, `title`, nullable `summary`,
`status`, and an ordered, exact-case-unique `participantNames` array. Participant
names must already exist in the same universe's roster, and the complete array
must fit the 16,384-byte PostgreSQL JSONB text representation. This aggregate
storage bound is checked during action normalization before database work. New
storylines may start in `draft` or `active`. Allowed lifecycle moves are
`draft -> active|cancelled`, `active -> paused|cancelled`, and
`paused -> active|cancelled`; terminal `completed` and `cancelled` storylines
cannot reopen. Completion is deliberately excluded from the aggregate-only
upsert path.

`appendCanonBeat` appends immutable, storyline-local history. Its closed beat
contains a bounded typed `kind`, summary, normalized UTC `occurredAt`, and
participant names that must be a subset of the storyline participants. An
optional `eventId` must identify an event in the same universe. An optional
`supersedesBeatId` performs an append-only retcon: the original row remains,
only one replacement may supersede it, and booking context omits superseded
beats from the current projection. The optional `nextStatus` changes lifecycle
state in the same transaction. Moving to `completed` requires a `payoff` or
`resolution` beat.

Each mutation locks the per-universe canon head, compares the storyline
version, increments one gapless semantic universe revision, changes the
storyline/participant/beat projections, and records the exact result under
`(universeId, mutationId)` in one PostgreSQL transaction. Reusing a mutation ID
with the identical normalized payload replays the stored result without a new
revision. Reusing it with different input returns
`BACKSTAGE_MUTATION_ID_CONFLICT`. Missing storylines return
`BACKSTAGE_STORYLINE_NOT_FOUND`; stale versions and lifecycle/reference/retcon
conflicts return their bounded `BACKSTAGE_*` conflict code.

Canon has no process-memory or exact-memory persistence fallback. A classified
pre-commit database outage returns `BACKSTAGE_CANON_UNAVAILABLE` with HTTP 503.
If a commit was attempted but its acknowledgement was lost, the action returns
HTTP 200 with `applied: null`, `universeRevision: null`, null storyline/beat
fields, and the existing `unknown` PostgreSQL receipt. Reconcile that outcome by
repeating the identical normalized payload with the same mutation ID; do not
invent a new ID or assert that the requested canon exists. Confirmed outcomes
return `applied: true`, a decimal-string `universeRevision`, the updated typed
storyline, and (for `appendCanonBeat`) the appended beat.

Legacy `saveStoryline` prose and bounded `trackStoryline` continuity notes are
not imported, dual-written, or silently promoted into canon. Generation reads
the typed storyline and non-superseded beat projection ahead of those legacy
blocks inside the same bounded repeatable-read snapshot. Phase 2A intentionally
does not add a public canon read endpoint or visual workspace; those build on
this authoritative mutation and revision substrate in a later slice.

### AFOL decision and inspection
- `POST /api/afol/decide` (control-plane operator, `mcp:invoke`, and an issued
  one-use confirmation challenge required)
- `GET|HEAD /api/afol/health` (control-plane operator and `arcanos:read`
  required)
- `GET|HEAD /api/afol/logs` (control-plane operator and `arcanos:read`
  required)
- `GET|HEAD /api/afol/analytics` (control-plane operator and `arcanos:read`
  required)

The exact AFOL boundary authenticates and authorizes before its dedicated body
parser. Inspection reads run before writing-plane consistency, reject bodies,
and project existing in-memory or historical records at response time.
`POST /decide` remains behind writing-plane consistency, accepts one strict,
uncompressed object JSON body of at most 64 KiB and depth 32, and requires the
issued principal-, actor-, dispatch-, and body-bound challenge. Manual, trusted,
one-time-token, and automation compatibility paths do not authorize execution.
Unknown methods, extra path segments, and more than one trailing slash
terminate inside the protected namespace.

All responses are `no-store`. Decision responses replace the submitted prompt
and intent with fixed redaction markers and never return provider exception
text; the current model answer is retained only after shared credential
redaction. New AFOL files contain only decision metadata
(`kind`, `id`, `timestamp`, `ok`, `route`, `latencyMs`, `cached`, and
`degraded`) or a fixed error category; prompts, completions, intents, policy
prose, and provider error text are never written. Log reads reproject legacy
JSONL records into that same metadata union and skip malformed lines without
loading the whole file. Analytics and log writes are serialized and atomically
replace bounded snapshots. A persistence failure does not convert a successful
model decision into an HTTP failure.

Existing files created by an older release may still contain sensitive fields
until the next successful bounded rewrite or a separately approved operator
rotation. Runtime reset helpers replace content atomically and do not delete
files. Execution uses a 30-request-per-15-minute authenticated-principal
budget, reads use 120 per 5 minutes, and invalid credentials use a separate
60-per-15-minute ingress-address budget.

### Reinforcement and reflection feedback
- `POST /reinforce` (control-plane operator and `mcp:invoke` required)
- `POST /audit` (control-plane operator and `mcp:invoke` required)
- `POST /reinforcement/judge` (control-plane operator and `mcp:invoke`
  required)
- `GET`/`HEAD /reinforcement/metrics` (control-plane operator and
  `arcanos:read` required)
- `GET`/`HEAD /memory/digest` (control-plane operator and `arcanos:read`
  required)
- `GET`/`HEAD /memory` (control-plane operator and `arcanos:read` required)
- `POST /api/web/search`
- `GET /metrics` (Prometheus metrics; enabled unless `METRICS_ENABLED=false`)

The six reinforcement and root-memory routes above authenticate before CORS
and broad body parsing, return `no-store`, and terminate unsupported methods or
subpaths inside their exact namespaces. `/reinforce` accepts only an object
JSON or `application/*+json` body up to 32 KiB. `/audit` and
`/reinforcement/judge` use the same strict media-type rules with a 128 KiB
ceiling. Read requests reject bodies. Authenticated principals share a
30-request-per-15-minute feedback budget and a
120-request-per-5-minute inspection budget; invalid credentials use a separate
60-request-per-15-minute ingress-address budget.

These machine-feedback routes do not gain a new confirmation challenge. The
current legacy `ai-endpoints.ts` owner of `POST /audit` retains its existing
confirmation requirement; when legacy GPT routes are disabled, the CLEAR
feedback owner remains confirmation-free. Public `GET /health` is unchanged
and continues to be owned by the earlier health-group router.

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
broad body parsing, the writing-plane consistency gate, and any listed
confirmation requirement. Authenticated responses and denials use
`Cache-Control: no-store`. The credential grants deployment-wide access only;
it does not bind caller-controlled `sessionId` values to a tenant.

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
- `GET /workers/status` (public aggregate worker-health projection; `no-store`)
- `POST /workers/heal` (strict privileged worker authentication, shared
  worker-heal rate limit, and confirmation required)
- `POST /workers/run/:workerId` (privileged worker authentication and confirmation required)
  - File-backed `workerId` values are limited to 1–128 ASCII letters, digits, dots, underscores, or hyphens, beginning with a letter or digit. The resolved regular `.js` file must remain canonically inside the selected workers directory; path separators, absolute paths, traversal, escaping symlinks, the executable job runner, and shared helper modules are rejected before import.
- `GET /worker-helper/status` (public aggregate worker-health projection; `no-store`)
- `GET /worker-helper/health` (public aggregate worker-health projection; `no-store`)
- `GET /worker-helper/jobs/latest` (privileged auth required)
- `GET /worker-helper/jobs/failed` (privileged auth required; `no-store`)
- `GET /worker-helper/jobs/:id` (privileged auth required)
- `POST /worker-helper/queue/ask` (privileged auth required; successful
  `no-store` acknowledgement includes `jobReadToken` and
  `jobReadTokenHeader` for later generic reads)
- `POST /worker-helper/dispatch` (privileged auth required)
- `POST /worker-helper/heal` (privileged auth and shared worker-heal rate limit
  required)
- `GET /jobs/:id` (job-specific capability required; `no-store`)
- `GET /jobs/:id/result` (job-specific capability required; `no-store`)
- `GET /jobs/:id/stream` (job-specific capability required; `no-store`,
  `no-cache`, and `no-transform`)
- `POST /jobs/:id/cancel` (job-specific capability, confirmation, and
  authenticated actor ownership required; `no-store`)
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

The public worker-health projection used by `/workers/status`,
`/worker-helper/status`, `/worker-helper/health`, and `/trinity/status`
contains only normalized `status` values, aggregate `runtime`, `workers`,
`queue`, and `memory` counts/states/timestamps, the response timestamp, and the
safe `overallStatus`, `totalWorkers`, and `availableWorkers` compatibility
aliases consumed by the CLI.
It does not serialize worker or job identifiers, worker inventories, job
snapshots, prompts, results, errors, alerts, runtime bindings, model names, or
filesystem paths. Unavailable aggregate values are represented as `null`.

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
- `GET /api/commands` (control-plane operator and `arcanos:read` required)
- `GET /api/commands/health` (control-plane operator and `arcanos:read`
  required)
- `POST /api/commands/execute` (control-plane operator, `mcp:invoke`, and
  issued one-use confirmation challenge required)
- `POST /api/agent/execute` (control-plane operator, `mcp:invoke`, and issued
  one-use whole-plan confirmation challenge required)
- `GET /api/control-plane/capabilities`
- `POST /api/control-plane` (dedicated bearer authentication and server-owned operation scopes required; confirmation additionally required for gated operations)
- `GET /api/control-plane/allowlist`
- `GET /api/control-plane/deep-diagnostics`
- `POST /api/control-plane/operations` (dedicated bearer authentication and server-owned operation scopes required; confirmation additionally required)
- `POST /commands/research` (confirmation required)
- `POST /sdk/research` (confirmation required)
- `POST /rag/fetch` (control-plane operator, `mcp:invoke`, and issued
  one-use confirmation challenge required)
- `POST /rag/save` (control-plane operator, `mcp:invoke`, and issued
  one-use confirmation challenge required)
- `POST /rag/query` (control-plane operator and `arcanos:read` required;
  confirmation is not required)

All research ingress paths share the same inclusive bounds, applied to the
supplied values before trimming or filtering: `topic` may have at most 500
JavaScript `String.length` units; `urls` may contain at most 10 supplied
entries; each raw URL string may have at most 2,048 JavaScript `String.length`
units; and the raw URL strings together may have at most 16,384 such units.
Blank, duplicate, and syntactically invalid URL entries still count toward the
entry and aggregate ceilings; metadata is excluded from the URL aggregate.
Stable validation completes before confirmation challenges, request events,
outbound fetches, Research execution-provider calls, or persistence work.
Hybrid or LLM-first `POST /gpt-access/dispatch/run` resolution may make one
semantic-planner provider call before the generated plan can be identified as
Research. Any resulting Research payload is validated immediately after that
planning call and before confirmation or Research execution work; deterministic
rule-resolved Research dispatch makes no planner call. Direct HTTP and SDK
failures use their existing HTTP 400 validation envelopes, canonical GPT
aliases report `RESEARCH_REQUEST_INVALID` with HTTP 400, and GPT Access
capability or natural-dispatch runs report `GPT_ACCESS_VALIDATION_ERROR` with
HTTP 400.

URL syntax handling remains ingress-specific. MCP `research.run` validates URL
syntax at its tool boundary, while the HTTP, SDK, and module paths preserve
their existing per-source failure handling for syntactically invalid URL
strings. The shared count and length ceilings apply in either case.

Research persistence derives its topic directory component deterministically
as portable ASCII: a readable slug followed by the full SHA-256 hexadecimal
digest. The component is capped at 97 UTF-8 bytes. New writes use this bounded
component; the storage contract does not promise a dual write to legacy topic
paths.

Each accepted Research execution is governed by one service-owned aggregate
deadline (`RESEARCH_WORKFLOW_TIMEOUT_MS`, default 60 seconds), capped by any
shorter caller deadline. The same runtime budget and cooperative cancellation
signal span DNS resolution, HTTP fetches, all source-summary, synthesis, and
audit model calls, and persistence. Direct HTTP, SDK, GPT/module aliases,
dispatch, GPT Access, and MCP callers propagate disconnect or protocol
cancellation into that scope. Once cancelled, the workflow admits no new URL,
model, or write stage and waits for already-started cooperative work to settle
before its own promise completes; ordinary non-cancellation source failures
remain recorded in `failedUrls` and do not abort later sources.

Successful Research `run` dispatches own their deterministic
`research/<topic-component>/...` persistence inside that aggregate scope. They
do not also create generic module-conversation transcript/history writes, even
when a caller supplies `sessionId`; natural-language memory interception remains
a separate dispatcher path with the behavior documented in
`docs/MEMORY_BACKEND_USAGE.md`.

The exact command/agent CEF boundary authenticates before body allocation,
returns `Cache-Control: no-store`, and uses separate authenticated-principal
budgets for registry reads and execution. `GET` and `HEAD` command registry
reads accept one optional trailing slash, reject request bodies, and run outside
writing-plane consistency rerouting. The two execution routes accept strict,
uncompressed JSON objects of at most 256 KiB and retain writing-plane
consistency checks;
their sensitive bindings block conflicts instead of rerouting to a GPT route.
Unknown methods and paths under `/api/commands` or `/api/agent` terminate with a
fixed 404. Both execution routes require the issued challenge token; manual
`x-confirmed: yes`, allow-all mode, trusted-GPT metadata, one-time-token
compatibility, and automation-secret bypasses do not authorize CEF execution.
Challenges bind the authenticated actor, control-plane principal, fixed CEF
workspace, dispatch state, and exact validated command or stable plan intent.
Changing the command, payload, goal, plan intent, principal, or relevant
dispatch state requires a new challenge.

After confirmation, the command center still fails closed unless it receives an
opaque, single-use execution permit for the exact command and canonical
validated payload. Direct command requests receive one permit. Agent requests
freeze the confirmed plan and derive one independently bound permit for each
step from the single whole-plan challenge; DAG nodes do not issue their own
challenges. Unsupported commands and invalid command or planner payloads return
their existing 400-class response before a challenge is issued. The CEF ingress
boundary does not treat confirmation as caller identity, and challenges remain
local to the replica that issued them.

The exact `/rag/*` boundary authenticates and principal-throttles requests before
allocating their bodies. It accepts strict JSON objects only, rejects compressed
or ambiguous content types, and returns `Cache-Control: no-store`.
`/rag/fetch` accepts at most 8 KiB of JSON with one HTTP(S) URL no longer than
2,048 characters; the fetcher additionally denies URL credentials, private or
reserved destinations, redirects, proxying, and unbounded response work.
`/rag/query` accepts at most 16 KiB with a non-empty question no longer than
4,000 characters. `/rag/save` accepts at most 256 KiB; content is capped at
200,000 characters, identifiers at 200 characters, sources at 2,048 characters,
and JSON-safe metadata at 16 KiB with bounded depth and fan-out. Unknown fields
and unsafe metadata keys are rejected.

Fetch, save, and query share a process-local HTTP concurrency cap of two.
Excess work is not queued: it returns HTTP `429` with
`error.code: "RAG_OPERATION_BUSY"` and `Retry-After: 5`. Fetch and save
challenges are bound to the authenticated actor, configured principal, exact
path, and exact parsed request body; manual, trusted-GPT, automation, and
one-time-token shortcuts do not replace the issued challenge. Successful
ingestion still performs outbound/provider and persistent database work. This
boundary provides deployment-wide operator containment, not tenant or workspace
ownership: all three routes address the same configured RAG corpus.

For either `/api/control-plane` POST route, send
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
- `POST /mcp` (MCP Streamable HTTP, bearer token required, origin-restricted when configured; decoded `application/json` is capped before the broad parser at the strictest of `JSON_LIMIT`, `MCP_HTTP_BODY_LIMIT`, and the non-widenable 1 MiB maximum, with oversized bodies returning fixed HTTP `413` `MCP_REQUEST_TOO_LARGE` JSON)
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
- `POST /gpt-access/gaming/sources/ingestions`
- `POST /gpt-access/gaming/sources/refreshes`
- `GET /gpt-access/gaming/sources/ingestions/:ingestionId`
- `POST /gpt-access/local-agent/heartbeat`, `/jobs/claim`, `/jobs/:jobId/heartbeat`, and `/jobs/:jobId/result` are private executor-protocol operations. They use the dedicated local-agent credential and a separate bounded rate-limit budget, not the Custom GPT bearer or shared GPT Access budget.
- Privileged `ARCANOS:LOCAL_AGENT` actions `tests.run` and `patch.apply` require a consumed one-time confirmation challenge bound to the authenticated actor, principal, workspace, exact action, and exact payload. Manual, trusted-GPT, automation-secret, or allow-all confirmation modes do not satisfy this stricter execution condition.
- `GET /gpt-access/modules` and `GET /gpt-access/modules/:id` (capability compatibility aliases)
- `POST /gpt-access/dispatch/run`

The two protected worker-diagnostics reads require `workers.read`, use
`Cache-Control: no-store`, and retain the sanitized operator detail removed
from the credential-free worker-health projection.

The Gaming source routes are narrow authenticated capabilities declared in
`contracts/arcanos_gaming.openapi.v1.json`; they are not Gaming module actions
or generic job-control endpoints. Ingestion accepts a closed body with
`action: "ingest"`, a game, one to four public HTTPS `sourceUrls`, and a required
`idempotencyKey`. Optional `sourceTypeHint`, `patchVersion`, and `origin` values
remain hints or bounded context; callers cannot supply page contents, fetch
headers, credentials, trust state, source priority, or storage instructions.
Refresh accepts only one to four previously returned UUID `sourceIds`, a required
`idempotencyKey`, and an optional bounded reason. Both writes return `202` and an
UUID `ingestionId`. The status route accepts only that identifier and returns a
sanitized lifecycle projection with source-level states, safe errors, record
counts, provenance, and timestamps—never generic job payloads, queue state,
worker state, raw database records, or provider diagnostics.

They require the dedicated, web-service-only
`ARCANOS_GAMING_SOURCE_ACCESS_TOKEN` Bearer credential. It is an exact
32–4096-character visible-ASCII non-placeholder secret with no whitespace and
must be distinct from every other purpose-bound application credential. The
credential is accepted only on these three routes; generic
`ARCANOS_GPT_ACCESS_TOKEN` credentials and scopes are rejected here, and the
Gaming source credential is rejected on other `/gpt-access/*` routes. Configure
the dedicated value only on the web service and in the Arcanos Gaming Custom
GPT Action authentication field, never on the worker service.

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
- `GET /contracts/backstage_booker.openapi.v1.json`
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
- `GET|HEAD /api/assistants` (control-plane operator and `arcanos:read`)
- `GET|HEAD /api/assistants/:name` (control-plane operator and
  `arcanos:read`)
- `POST /api/assistants/sync` (control-plane operator, `mcp:invoke`, and an
  issued one-use confirmation challenge)
- `POST /api/sim`
- `GET /api/sim/health`
- `GET /api/sim/examples`
- `POST /api/pr-analysis/webhook`
- `POST /api/pr-analysis/analyze` (control-plane operator and `repo:verify`
  required)
- `GET /api/pr-analysis/health`
- `GET /api/pr-analysis/schema`

Assistant-registry traffic is direct control-plane work and bypasses the
writing-plane memory-consistency gate. Reads reject request bodies and return
only a count plus sorted normalized names, or `name`, `normalizedName`, and
`model` for one record. Provider IDs, instructions, and tools are never
returned. A missing name is a local 404 and neither list nor detail reads call
the provider.

Sync accepts only an uncompressed, strict empty JSON object (`{}`) up to 1 KiB.
Manual, trusted-GPT, automation, allow-all, and one-time-token confirmation
bypasses do not apply: the caller must consume the issued challenge bound to
the authenticated principal and the fixed `assistant-registry` workspace.
There may be one sync per process; overlap returns 409 with a bounded
`Retry-After`. Sync starts are limited to five per principal per 15 minutes,
reads to 120 per principal per 5 minutes, and invalid credentials to 60 per
ingress address per 15 minutes.

One confirmed sync may enumerate at most 50 provider pages and 1,000 records.
It rejects malformed or non-progressing cursors, duplicates, and oversized
records before installing a complete candidate. The registry replacement uses
an exclusive mode-`0600` same-directory temporary file, file flush, and atomic
rename under a process-local persistence mutex. Missing or invalid cache files
never overwrite an existing live snapshot, and sync failures return a fixed
error rather than stale success.

`npm run assistants-sync` is a one-shot backend client, not an OpenAI poller.
Its first invocation requests a challenge and exits without consuming it.
After operator approval, rerun
`npm run assistants-sync -- --challenge <challenge-id>`. The client accepts
HTTPS backends or exact HTTP loopback, refuses redirects, caps response bytes,
and never reads `OPENAI_API_KEY`.

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
