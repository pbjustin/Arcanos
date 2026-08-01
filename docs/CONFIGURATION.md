# Configuration Guide

## Overview
This document captures active backend and daemon configuration used by current code. Defaults and precedence are derived from `src/platform/runtime/unifiedConfig.ts`, `src/platform/runtime/env.ts`, compatibility re-exports under `src/config/`, and daemon config modules.

## Prerequisites
- Copy `.env.example` to `.env` for backend.
- Copy `daemon-python/.env.example` to `daemon-python/.env` for daemon usage.

## Setup
Backend:
```bash
cp .env.example .env
```

Daemon:
```bash
cd daemon-python
cp .env.example .env
```

## Configuration
### Backend required and core variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | No locally; Railway-managed in deploys | direct server `3000`; validation fallback `8080` | `.env.example` sets `3000`. Railway injects `PORT`; do not hard-code it in Railway Variables. |
| `NODE_ENV` | No | `development` | Affects host binding and runtime behavior. |
| `OPENAI_API_KEY` | No for explicit local/test mock paths; yes by default in production/Railway and for live AI | none | Default production/Railway startup validation rejects a missing or placeholder key. |
| `OPENAI_BASE_URL` | No | none | Optional OpenAI endpoint override. |
| `OPENAI_MODEL` | No | fallback chain | Participates in default model resolution chain. |
| `DATABASE_URL` | No | none | Enables PostgreSQL persistence. |
| `REDIS_URL` | No | none | Preferred `redis://` or TLS `rediss://` connection string; discrete `REDISHOST`/`REDISPORT`/`REDISUSER`/`REDISPASSWORD` are fallback inputs. Without a valid discrete fallback, a malformed non-empty value is treated as configured but unavailable. |
| `ARCANOS_JOB_READ_CAPABILITY_SECRET` | Yes for generic async job creation and reads | none | Dedicated 32–4096 character HMAC signing secret for job-specific read capabilities. It must contain no whitespace or placeholder text and must remain distinct from every other purpose-bound application credential. |
| `ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET` | No; rotation overlap only | none | Optional prior signing key accepted only for capability verification. It must satisfy the current-key credential rules and differ from the current key and every other purpose-bound credential. New tokens are never issued from it. |
| `ARCANOS_JOB_READ_TOKEN` | Client-only for standalone generic job lookups | none | Optional transient CLI/daemon fallback containing the `jobReadToken` returned by one job-creation response. The backend does not use this as a signing secret; do not put it in shared server configuration. |
| `ARCANOS_GPT_ACCESS_TOKEN` | Yes for protected `/gpt-access/*` operations | none | Bearer token for the protected GPT access gateway. `GET /gpt-access/openapi.json` is public. Store real values only in runtime variables or GPT Action auth. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | Yes for deployed GPT Action import | configured public base URL variables, local request origin, then `http://localhost:3000` | Public HTTPS origin advertised by `/gpt-access/openapi.json`; set this in Railway so public metadata is deterministic and never derived from spoofable request headers. Railway PR previews prefer Railway preview URL variables before inherited production URLs. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Yes for `/gpt-access/jobs/create`, capability discovery, capability runs, and worker recovery | all recognized read/control scopes are granted when unset, except `jobs.create`, `capabilities.read`, `capabilities.run`, and `workers.recover` remain denied unless explicitly listed | Comma-separated gateway scope allowlist. Include `jobs.create` and `jobs.result` for protected async Trinity execution; include `workers.recover` only for confirmed worker recovery dispatch; include `capabilities.read` for discovery and `capabilities.run` only with a matching `MCP_ALLOW_MODULE_ACTIONS` allowlist and confirmation. |
| `ARCANOS_GPT_ACCESS_PRINCIPAL_ID` | Yes for GPT Access-only tenant-scoped capabilities | none | Server-controlled principal for capabilities such as `ARCANOS:PRODUCTIVITY`; never source it from action payloads. |
| `ARCANOS_GPT_ACCESS_WORKSPACE_ID` | Yes for GPT Access-only tenant-scoped capabilities | none | Server-controlled workspace paired with the configured principal; missing identity fails closed. |
| `ARCANOS_PROCESS_KIND` | Yes for Railway launcher | none | Must be `web` or `worker` when using `scripts/start-railway-service.mjs`; omit for direct local `npm start`. |
| `ARCANOS_NATIVE_PR_APPLICATION_PREVIEW` | Launcher-owned native PR child only | none | Exact internal version marker (`v1`) projected by the reviewed launcher. Do not configure or forward it manually. |
| `ARCANOS_PREVIEW_PR_NUMBER` | Launcher-owned native PR child only | none | Validated positive PR number derived from Railway's native environment name. The launcher, not an operator or request, owns this value. |
| `ARCANOS_PREVIEW_SOURCE_COMMIT` | Launcher-owned native PR child only | none | Validated lowercase 40-hex source commit projected into the contained preview child. It is identity evidence, not authorization. |
| `RUN_WORKERS` | No | `true` (non-test) | Local/direct in-process worker toggle. The explicit API startup lifecycle boots it when enabled; importing worker configuration never starts execution. Railway role selection remains authoritative when `ARCANOS_PROCESS_KIND` is set. |
| `WORKER_API_TIMEOUT_MS` | No | `30000` | Unified config default; some worker adapters fallback to `60000` if unset. |
| `ARC_LOG_PATH` | No | `/tmp/arc/log` | Runtime log path. |
| `ARC_MEMORY_PATH` | No | `/tmp/arc/memory` | Runtime memory path. |
| `RAILWAY_ENVIRONMENT` | No | none | Set by Railway and used for environment detection. |
| `RAILWAY_API_TOKEN` | No | none | Only required for Railway management/API tooling, not normal app runtime. |

Explicit local/test mock paths can run without a real OpenAI credential. Normal production startup fails validation when the resolved key is missing, empty, or a placeholder; live AI behavior and the dedicated worker also require a valid key.

### Generic async job-read capabilities

The root backend's generic `GET /jobs/:id`, `GET /jobs/:id/result`, and
`GET /jobs/:id/stream` routes, plus `POST /jobs/:id/cancel`, expose only `gpt`
and `ask` job types. Every request must send exactly one
`x-arcanos-job-read-token` header containing the job-specific `jobReadToken`
returned by the creating async response. The token is bound to the path job
id; query parameters, cookies, and request-body values do not carry this
authority. Treat the token as a bearer secret. Cancellation also requires
confirmation and the creation surface's authenticated owner; possessing the
read capability alone cannot mutate a job. Public GPT jobs created without a
server-established principal are intentionally non-cancellable.

`ARCANOS_JOB_READ_CAPABILITY_SECRET` is a server-side signing key, not a client
token. The backend derives deterministic `v1` HMAC capabilities so idempotent
creation responses can return the same token without storing bearer material
in `job_data`. Startup validation requires a valid current key in production
and Railway runtimes; local and test processes may omit it, but job-backed
creation then remains route-locally unavailable. Missing, malformed,
duplicated, incorrect, and cross-job tokens
are non-disclosing: status, stream, and cancellation return the same `404` as
an absent job, while the compatibility result route returns HTTP `200` with
`status: "not_found"`. If the current signing key is absent, malformed, or
collides with another purpose-bound credential, creation fails before
enqueueing. Reads and cancellation return HTTP `503` with
`JOB_READ_AUTH_UNAVAILABLE` only when neither the current nor optional previous
verification key is valid. All affected JSON responses are `no-store`; the SSE
response is also `no-cache` and `no-transform`.

The TypeScript query client preserves `jobReadToken` for its automatic polling,
and the Python daemon response model retains it for an explicit subsequent
read. For an independent `job-status`/`job-result` invocation, pass the token
through the client API or set `ARCANOS_JOB_READ_TOKEN` only for that
invocation. Never place a job token in a URL, log, committed file, or
long-lived shared server environment.

New tokens are issued only with `ARCANOS_JOB_READ_CAPABILITY_SECRET`, while
verification accepts the valid current key and the optional valid
`ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET`. For a rotation, deploy the new
key as current and the old key as previous in one coordinated configuration
change. Keep the previous key only through the maximum retained-job window,
then remove it after those jobs drain or expire. Rotating the current key
without that overlap immediately invalidates outstanding generic tokens.
Setting the two variables to the same value, reusing either value for another
purpose-bound credential, or leaving only an invalid current key makes new
job-backed creation unavailable.

GPT idempotency scopes are separately namespaced for the public GPT route, the
custom GPT bridge, and GPT Access. This prevents cross-surface reuse from
turning a protected job into a generic continuation. The first deployment of
the namespace change deliberately stops deduping against older unnamespaced
rows; allow one idempotency/retention window for those rows to drain.
Anonymous public GPT submissions also receive a fresh server-random scope per
request, so caller-selected sessions, IPs, raw authorization headers, bodies,
and idempotency keys cannot remint a prior job's read capability. Reusable
public deduplication and cancellation require a principal already established
by trusted server middleware. Custom bridge and GPT Access scopes use canonical
fingerprints of the credential that actually passed their route authentication,
independent of bearer casing/spacing or caller session values.

Treat this actor/provenance change as a coordinated web-process cutover, not a
mixed-version rolling state: drain or replace every older web instance before
relying on the containment boundary. Older instances can still create legacy
unnamespaced or caller-derived ownership rows. Rotating the Custom GPT bridge or
GPT Access credential also changes that surface's actor fingerprint; if retry
deduplication or cancellation continuity matters for retained jobs, let those
jobs drain before rotating the authenticating credential.

### Standalone BullMQ/Redis AI runtime

`arcanos-ai-runtime/` is an opt-in workspace with a separate HTTP process and
worker. The root backend, root build, and canonical Railway web/worker launcher
do not start it. Do not infer deployment or internet exposure from its presence
in the repository.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `ARCANOS_AI_RUNTIME_ACCESS_TOKEN` | Yes for every `/jobs` request | none | Purpose-bound Bearer credential read once at the start of each request. It must be an exact 32–4096 visible-ASCII character value with no whitespace or placeholder form and must remain distinct from every other ARCANOS application credential. `x-api-key`, cookies, query values, and body fields are not accepted. |
| `ARCANOS_AI_RUNTIME_PRINCIPAL_ID` | Yes | none | Server-owned principal written into new jobs and compared exactly on reads. The historical owner ID `anonymous` is reserved and makes authentication unavailable. Keep the configured ID stable across replicas and token rotations; changing it intentionally makes existing jobs unreadable. |
| `ARCANOS_AI_RUNTIME_SCOPES` | Yes | none | Comma-separated allowlist containing `runtime:enqueue`, `runtime:read`, or both. Unknown or malformed scopes make authentication unavailable. |
| `AI_RUNTIME_ALLOWED_MODELS` | Yes for `POST /jobs` and the worker | none | Comma-separated exact model allowlist. Configure 1–32 distinct visible-ASCII names, each at most 120 characters. No repository evidence identifies the correct deployed models, so there is intentionally no permissive default. |
| `AI_RUNTIME_DEFAULT_MAX_TOKENS` | Yes for `POST /jobs` and the worker | none | Server-owned output-token value materialized when the caller omits `maxTokens`; integer 1–32768 and no greater than `AI_RUNTIME_MAX_TOKENS`. |
| `AI_RUNTIME_MAX_TOKENS` | Yes for `POST /jobs` and the worker | none | Hard server-owned maximum for caller `maxTokens`; integer 1–32768. Choose the deployment value from its cost and latency budget. |
| `AI_RUNTIME_ADMISSION_MAX_OUTSTANDING` | Yes for `POST /jobs` and the worker | none | Shared Redis reservation ceiling across cooperating API replicas; integer 1–100000. It bounds admitted executable work, not retained terminal jobs. |
| `AI_RUNTIME_ADMISSION_RATE_MAX` | Yes for `POST /jobs` and the worker | none | Maximum enqueue attempts in the shared sliding window; integer 1–100000. The current single configured principal is one trust domain, so this is not per-end-user fairness. |
| `AI_RUNTIME_ADMISSION_RATE_WINDOW_MS` | Yes for `POST /jobs` and the worker | none | Redis-time sliding-window duration; integer 1000–3600000 ms. A rejected request receives fixed `429` JSON and a bounded `Retry-After`. |
| `AI_RUNTIME_ADMISSION_PENDING_GRACE_MS` | Yes for `POST /jobs` and the worker | none | Age before the reconciler inspects an unconfirmed reservation; integer 1–3600000 ms and at least the reconciliation interval. |
| `AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS` | Yes for `POST /jobs` and the worker | none | Confirmation delay between two observations of a missing BullMQ job before its reservation is released; integer 1–3600000 ms and at least the reconciliation interval. |
| `AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS` | Yes for `POST /jobs` and the worker | none | Server-side bounded reconciliation interval; integer 1000–600000 ms. |
| `AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE` | Yes for `POST /jobs` and the worker | none | Maximum stale reservations inspected per pass; integer 1–1000. |
| `AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS` | Yes for `POST /jobs` and the worker | none | Age before a claimed/live reservation may be reconciled; integer 1–3600000 ms and at least `WATCHDOG_LIMIT_MS + AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS`. This prevents a lost-lock replacement attempt from releasing an earlier provider call that is still inside its watchdog horizon. |
| `PORT` | No | `3000` | Standalone HTTP listener port. This workspace currently relies on the platform/default listener host unless separately isolated. |
| `AI_RUNTIME_QUEUE_NAME` | Yes for the standalone API and worker | none | Stable environment/version namespace used by both BullMQ and the admission ledger. It must match `^[a-z0-9][a-z0-9_-]{0,63}$` and must be identical across cooperating API and worker replicas. Use a new value for a coordinated versioned cutover; never point two environments at the same queue name and Redis database. |
| `AI_RUNTIME_REDIS_URL` | Yes unless `REDIS_HOST` is set | none | Preferred standalone BullMQ target. Only `redis://` and `rediss://` URLs with an optional numeric database path are accepted; query strings and fragments are rejected. The URL takes precedence over the legacy host/port pair and may carry Redis ACL credentials. Keep the complete value secret. Use `redis://` only for loopback or an independently verified trusted private channel; use `rediss://` when the deployment trust boundary requires TLS. |
| `REDIS_HOST` | Yes unless `AI_RUNTIME_REDIS_URL` is set | none | Legacy standalone BullMQ Redis host. This is not the root backend's `REDIS_URL` lifecycle. |
| `REDIS_PORT` | No | `6379` | Legacy standalone BullMQ Redis port; ignored when `AI_RUNTIME_REDIS_URL` is set. |
| `OPENAI_API_KEY` | Yes for the standalone worker; not read by the HTTP process | none | Worker-owned provider credential. Worker startup fails before creating Redis/BullMQ resources when it is missing. Do not configure it on the standalone HTTP process. |
| `AI_RUNTIME_SHUTDOWN_TIMEOUT_MS` | No | `10000` | Shared graceful-shutdown deadline for the standalone HTTP and worker processes; integer 1000–300000 ms. Size the worker value against the provider watchdog and the deployment platform's termination grace. A deadline force-closes owned connections and terminates with a nonzero exit. |
| `AI_RUNTIME_WORKER_STARTUP_TIMEOUT_MS` | No | `30000` | Deadline for the standalone worker to establish both Queue and Worker Redis readiness before processing begins; integer 1000–300000 ms. Expiry emits only the fixed startup-failure event, closes owned BullMQ/Redis resources through the shutdown coordinator, and exits nonzero so the process cannot remain live but inert. |
| `AI_RUNTIME_JOB_RETENTION_SECONDS` | No | `3600` | Age limit for completed and failed jobs; 60–604800 seconds. It does not bound queued backlog. |
| `AI_RUNTIME_MAX_COMPLETED_JOBS` | No | `1000` | Completed-job count retained by BullMQ; 1–100000. |
| `AI_RUNTIME_MAX_FAILED_JOBS` | No | `1000` | Failed-job count retained by BullMQ; 1–100000. |

Authentication and the endpoint-specific scope run before the 256 KiB JSON
parser. New jobs receive only the configured principal, and
`GET|HEAD /jobs/:id` returns the same 404 for absent, legacy-unowned, and
cross-principal jobs. All responses are `no-store`. Historical jobs written
with principal `anonymous` are intentionally unreadable; if a separately
deployed runtime is discovered, drain or expire them through an approved
operational procedure before rollout rather than adding an anonymous fallback.
The admission ledger is also a coordinated-cutover boundary. The runtime now
requires an explicit `AI_RUNTIME_QUEUE_NAME` instead of silently sharing the
historical `ai-jobs` namespace. Drain the existing queue or move both API and
worker to one new versioned name before enabling it. A new worker intentionally
fails jobs that lack reservations, while an old worker cannot perform the new
claim-bound release. Repository evidence does not show whether this standalone
runtime is deployed or has an existing backlog.
Validated message JSON is reconstructed under explicit depth, node, array,
object-key, and aggregate-string budgets, then revalidated by the worker. An
authenticated enqueue request fails closed before JSON parsing when the model
or token policy is missing or malformed. The worker binds to the exact
configured principal, model allowlist, default output limit, and hard output
limit before it accepts persisted queue data.
Completed results are reduced before persistence and again on read to bounded
output text or the existing timeout envelope; raw provider response metadata,
encrypted reasoning, errors, and unknown future fields are not public API.
The HTTP queue/admission connection uses a three-second connect timeout,
two-second command timeout, disabled offline queue, one retry per command, and
an availability gate in front of every Queue or admission operation. Requests
fail closed without waiting on BullMQ initialization while Redis is unavailable;
reconnects continue with a delay capped at five seconds so the gate can recover.
The BullMQ worker uses the same target with its required long-lived
blocking-command profile and does not apply a command timeout to blocking reads.
Queue initialization is owned by an explicit factory rather than module import,
and Queue error logs contain only a stable event name, not the Redis error or
configured URL.
`SIGTERM` and `SIGINT` are idempotent and bounded. The HTTP process first stops
accepting requests, stops reconciliation, drains accepted requests, and then
closes its Queue. The worker starts fetching only after both its admission Queue
and blocking Worker connection are ready; shutdown stops fetching, waits for
active work and terminal reservation releases, and then closes the admission
Queue. If the configured deadline expires, both processes force-disconnect and
terminate with a nonzero exit without logging raw shutdown errors. A worker
readiness or run-loop failure uses the same coordinated cleanup and nonzero
termination path instead of leaving an idle process alive.

Enqueue rate is consumed before body parsing. A reservation is created before
`Queue.add`, confirmed afterward, claimed with the BullMQ worker token before
provider execution, and held until BullMQ reports a terminal transition.
Ambiguous enqueue outcomes remain reserved and are recovered by bounded,
idempotent reconciliation; a missing job must be observed twice. There is no
single transaction spanning the custom admission ledger and BullMQ's high-level
`Queue.add`, so an ambiguous physical queue entry can temporarily exist, but an
unreserved or replayed entry fails worker preflight before reaching the provider.
The source tests cover fail-closed adapter responses and lifecycle behavior with
mocked Redis results. The required `runtime-redis-admission` CI job additionally
runs the standalone runtime regression suite, then executes every admission Lua
lifecycle plus concurrent shared-cap and rate-window invariants through
independent Redis connections against a disposable loopback service. It also
drives a real BullMQ Queue/Worker pair to prove that unreserved jobs cannot reach
the executor and that completed/failed jobs release their token-bound
reservations. Its test command refuses non-loopback endpoints, requires database
15 and an explicit disposable-service confirmation, uses unique key namespaces,
and never calls `FLUSHDB`. That job must pass before activation.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Controls logging and worker defaults. |
| `PORT` | `3000` direct server / `8080` validation fallback | `src/server.ts` binds `process.env.PORT || 3000`; `environmentValidation.ts` backfills missing `PORT` with `8080` during startup validation. Prefer setting `PORT=3000` locally. Railway supplies the live port. |
| `HOST` | `127.0.0.1` (dev) / `0.0.0.0` (prod) | Bind address for the HTTP server. In development, defaults to localhost for security. Set to `0.0.0.0` to allow network access (e.g., Docker, WSL2, testing from other devices). |
| `SERVER_URL` | `http://127.0.0.1:<port>` | Base URL used for internal callbacks. |
| `BACKEND_STATUS_ENDPOINT` | `/status` | Status endpoint path for internal checks. |
| `LOG_LEVEL` | `info` | Logging verbosity for the structured logger. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Directory for logs and audit output. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem cache for memory snapshots. |
| `JSON_LIMIT` | `10mb` | JSON payload size limit. |
| `REQUEST_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `PUBLIC_PROVIDER_RATE_LIMIT_MAX` | `100` | Integer HTTP admissions allowed across all public provider-capable routes in one backend process during the shared window. Valid range: `1` through `1000000`. Invalid or out-of-range values fall back to `100`; there is no disable value. |
| `PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS` | `900000` | Shared public-provider admission window in milliseconds. Valid range: `1000` through `2592000000` (30 days). Invalid or out-of-range values fall back to 15 minutes. |
| `ALLOWED_ORIGINS` | — | Optional comma-separated exact HTTP(S) browser origins. Outside development, missing or blank configuration disables cross-origin access. |

The public-provider limit uses one caller-independent, constant-key counter per
Node backend process. Rotating session, authorization, or forwarding metadata
does not create a new bucket, and existing route/user fairness limiters remain
in force. After canonical ingress validation, each provider-capable admission
attempt consumes one unit before downstream route validation or route/user
fairness, while provider-free diagnostics and control lanes consume none. One
HTTP request consumes only one unit even if it crosses the canonical GPT
compatibility seam or the selected pipeline makes several provider calls.
`ASK_ROUTE_MODE=compat` brings `GET /brain`, implicit
`HEAD /brain`, and `POST /brain` under this ceiling; GET uses query input while
POST and HEAD use body input. The default `gone` response is not charged.
This is intentionally not a cross-replica, token, cost, or downstream-SDK-call
budget; a shared-store ceiling requires a separately coordinated rollout.

### Browser CORS policy

- Development preserves reflected request origins for local browser tooling.
- Every other environment emits CORS headers only for an exact configured
  origin. Same-origin and server-to-server requests do not require CORS.
- Entries are trimmed, canonicalized, and deduplicated. Wildcards, URL
  credentials, paths, queries, fragments, and non-HTTP(S) schemes are rejected.
- An absent, blank, or malformed allowlist disables browser CORS without
  preventing same-origin or server-to-server traffic.

### OpenAI API key resolution

Mock responses are limited to explicit non-production/test paths. Do not rely on a missing key to enable mock behavior in production.

The OpenAI client resolves keys in this order:

### OpenAI key resolution order
1. `OPENAI_API_KEY`
2. `RAILWAY_OPENAI_API_KEY`
3. `API_KEY`
4. `OPENAI_KEY`

### Default model resolution order
1. `FINETUNED_MODEL_ID`
2. `FINE_TUNED_MODEL_ID`
3. `AI_MODEL`
4. `OPENAI_MODEL`
5. `RAILWAY_OPENAI_MODEL`
6. `gpt-4.1-mini`

### Fallback model resolution order
1. `FALLBACK_MODEL`
2. `AI_FALLBACK_MODEL`
3. `RAILWAY_OPENAI_FALLBACK_MODEL`
4. `FINETUNED_MODEL_ID`
5. `FINE_TUNED_MODEL_ID`
6. `gpt-4.1`

### Confirmation and automation
| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_GPT_IDS` | empty | GPT IDs eligible for the trusted confirmation path. Membership alone does not bypass confirmation; the request must also present a non-empty `x-arcanos-confirm-token`. For a trusted ID, the current middleware treats that header as a presence marker rather than consuming or validating it against the one-time-token store. This setting is not caller authentication because request metadata can supply the ID; use it only behind middleware that authenticates the caller and binds the permitted identity. |
| `ARCANOS_AUTOMATION_SECRET` | empty | Shared secret for automation bypass. |
| `ARCANOS_AUTOMATION_HEADER` | `x-arcanos-automation` | Header carrying automation secret. |
| `ASK_ROUTE_MODE` | `gone` | Legacy ask-style migration switch. Set `compat` only while temporarily supporting old `/brain` callers. |

### HTTP control-plane authentication

Both `POST /api/control-plane` routes, `/api/afol/*`, `/api/assistants/*`,
reinforcement feedback and inspection routes, `/api/self-heal/*`,
`/api/self-improve/*`, detailed
`GET /status/safety/self-heal`, and integrity quarantine release require a
purpose-bound bearer identity before scope authorization, confirmation,
capability checks, provider probes, or execution. The self-healing surfaces
share an ingress-derived client limiter before the broad JSON parser; decisions,
active provider probes, self-improve control mutations, and quarantine release
also use tighter
authenticated-principal buckets. Authenticated mutation JSON is capped at
256 KiB. The access token is not interchangeable with
the separate control-plane approval token used by approval-gated protocol
operations.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN` | none | Dedicated bearer credential for HTTP control-plane operations, direct `/system-state`, `/api/afol/*`, `/api/assistants/*`, `/rag/*`, reinforcement feedback and root-memory inspection, `/api/arcanos/dag/*`, `/api/commands*`, and `/api/agent/execute` access, protected DevOps/PR diagnostic execution, legacy SDK/orchestration control, `/api/self-heal/*`, `/api/self-improve/*`, detailed `GET /status/safety/self-heal`, and integrity-quarantine release. It must be 32–4096 visible ASCII characters with no whitespace and must not equal another configured purpose-bound credential. Missing or invalid server configuration fails closed at request time; the optional routes return 503 rather than blocking application startup. |
| `ARCANOS_CONTROL_PLANE_PRINCIPAL_ID` | none | Server-bound operator identifier used for control-plane caller and approval attribution. Caller-supplied `context.caller` and `approval.approvedBy` never establish identity. |
| `ARCANOS_CONTROL_PLANE_SCOPES` | empty | Comma-separated server-owned scope grant. Empty grants no operations. Every scope declared by the selected operation must be present. `GET /system-state`, AFOL health/log/analytics reads, assistant-registry list/detail reads, `POST /rag/query`, DAG run reads under `/api/arcanos/dag/*`, `GET`/`HEAD` command registry reads, and root `/memory`, `/memory/digest`, and `/reinforcement/metrics` reads require `arcanos:read`; `POST /system-state`, `/api/afol/decide`, `/api/assistants/sync`, `/rag/fetch`, `/rag/save`, and command/agent CEF execution require `mcp:invoke` plus an issued, principal- and request-bound one-use confirmation challenge (manual, allow-all, trusted-mode, one-time-token, and automation bypasses do not apply). Agent execution confirms one frozen plan and derives a single-use CEF permit for each step. DAG run creation/cancellation, `/reinforce`, `/audit`, and `/reinforcement/judge` require `mcp:invoke` without this additional CEF challenge. The reinforcement machine-feedback routes do not add a confirmation challenge, while the current legacy `/audit` owner retains its existing confirmation gate. Repository-file inspection under `/api/codebase/*` requires `repo:read`; direct `/api/pr-analysis/analyze` execution requires `repo:verify`; `/devops/self-test` and `/devops/daily-summary` require `diagnostics:execute`; legacy SDK/orchestration reads require `arcanos:read`, while SDK mutations and orchestration reset/purge require `mcp:invoke` plus confirmation; prompt and AI-routing debug reads and direct self-heal/detailed safety reads also require `arcanos:read`; active provider probes add `self-heal:probe`; decisions require `self-heal:decide`; `execute: true` adds `self-heal:execute`; manual self-improve runs require both decision and execution scopes; freeze, unfreeze, autonomy changes, and integrity-quarantine release require `self-improve:control`. |
| `ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN` | none | Separate approval credential for approval-gated `POST /api/control-plane/operations` protocol requests. It is action approval, not HTTP caller authentication. |
| `CODEBASE_ROOT` | auto-detected repository root | Optional root for `/api/codebase/*`. An explicit value must canonicalize to a directory containing `package.json`; invalid configuration fails closed instead of falling back to a broader working directory. |

Direct `/rag/*` limits are fixed security boundaries rather than environment
settings: fetch JSON is capped at 8 KiB, query JSON at 16 KiB, and save JSON at
256 KiB. The corresponding URL, question, content, identifier, source, and
metadata bounds are documented in [API.md](API.md#research-rag-and-command-routing).
These routes expose one operator-controlled deployment corpus; control-plane
identity does not add tenant or workspace isolation.

Reinforcement HTTP limits are also fixed rather than environment settings.
`POST /reinforce` accepts a strict object JSON body up to 32 KiB;
`POST /audit` and `POST /reinforcement/judge` accept up to 128 KiB. Read bodies
are rejected. Feedback mutations share a 30-per-15-minute authenticated
principal budget, inspection reads share 120 per 5 minutes, and invalid
credentials share 60 per 15 minutes by ingress socket/Express address.

AFOL HTTP limits are fixed as well. `POST /api/afol/decide` accepts a strict,
uncompressed object JSON body up to 64 KiB and depth 32 and requires a one-use
challenge. AFOL reads reject bodies. Execution shares a 30-per-15-minute authenticated
principal budget, inspection shares 120 per 5 minutes, and invalid credentials
share 60 per 15 minutes by ingress socket/Express address.

AFOL persistence stores metadata rather than request or provider content.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AFOL_ANALYTICS_PATH` | `logs/afol-analytics.json` | Atomic analytics snapshot target. The parent is canonicalized and validated; an existing target must be a regular non-symlink file. |
| `AFOL_ANALYTICS_RECENT_LIMIT` | `50` | Number of metadata-only decisions retained in the analytics snapshot, clamped to 1–1,000. |
| `AFOL_LOG_PATH` | `logs/afol-decisions.log` | Bounded metadata-only JSONL target with the same path checks and same-directory atomic replacement. |
| `AFOL_LOG_RETENTION_LIMIT` | `100` | Number of projected decision/error records retained in the JSONL file, clamped to 1–1,000. |
| `AFOL_LOG_TAIL_BYTES` | `524288` | Maximum tail window read from an existing JSONL file, clamped to 1,024–4,194,304 bytes. |

AFOL writes use an exclusive mode-`0600` temporary file in the validated target
directory, flush it, and rename it over the regular target. Writes and
configuration/reset transitions are serialized per persistence surface.
Analytics memory state advances only after its file replacement succeeds.
Legacy JSONL lines are reprojected to the fixed metadata union on reads and
bounded rewrites; malformed lines are skipped. Reset helpers use atomic empty
replacement rather than deletion. Older files are not proactively removed and
may require a separately approved operator rotation if they predate metadata-
only persistence.

Assistant-registry HTTP limits are fixed. Reads reject bodies, require
`arcanos:read`, and allow 120 starts per authenticated principal per 5 minutes.
`POST /api/assistants/sync` requires `mcp:invoke`, accepts only an uncompressed
empty JSON object up to 1 KiB, and allows five starts per principal per
15 minutes. Invalid credentials share a separate 60-per-15-minute ingress
address budget. The sync is challenge-only and bound to the authenticated
principal plus fixed `assistant-registry` workspace. Only that confirmed
operation enumerates provider assistants; reads and misses stay local, and the
historical startup/cron provider sync is retired.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASSISTANT_REGISTRY_PATH` | `config/assistants.json` under the process working directory | Internal registry cache. The resolved target must not be a filesystem root; its parent must canonicalize to an existing directory, and an existing target must be a regular non-symlink file. |
| `ASSISTANTS_BACKEND_URL` | `SERVER_URL`, then `http://127.0.0.1:3000` | Base origin used only by the one-shot `npm run assistants-sync` client. Credentials, paths, query strings, and fragments are rejected. Non-loopback origins require HTTPS. |
| `ASSISTANTS_SYNC_TIMEOUT_MS` | `10000` | One-shot backend request deadline; valid range 1,000–30,000 ms. |
| `ASSISTANTS_SYNC_CONFIRMATION_CHALLENGE` | none | Optional alternative to the script's `--challenge` argument after explicit operator approval. It must be the exact issued UUID and is never an automatic approval bypass. |

Provider listing is capped at 50 pages, 20 records per page, and 1,000 records
in total. Cursor progress, provider IDs, names, models, record bytes, and
duplicate IDs/names are validated before a candidate is built. Installation is
serialized and uses an exclusive mode-`0600` same-directory temporary file,
file flush, and atomic rename. A failed fetch or install retains the prior live
registry and returns a fixed failure. `ASSISTANT_SYNC_ENABLED` and
`ASSISTANT_SYNC_CRON` are retired and no longer schedule provider work.

`SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY`, when set, remains an immutable
deployment pin: a changed sync candidate is rejected and quarantined until the
expected hash is coordinated. Without an explicit pin, a challenge-confirmed
successful atomic replacement rotates only the process-owned
trust-on-first-load baseline after installation; normal reads continue to
verify the complete registry.

Command and agent CEF execution JSON is capped at 256 KiB. If
`SAFETY_EXPECTED_HASH_DISPATCH_PATTERNS` is pinned, deploying this version also
requires a separately coordinated update to that protected digest because the
agent execution route, AFOL decision route, and optional-trailing-slash command
route are sensitive `strict_block` bindings. Do not disable the integrity
check as a rollout shortcut.

CEF execution confirmation uses the existing
`CONFIRMATION_CHALLENGE_TTL_MS` setting and the in-memory challenge store. A
retry must reach the same replica, use the same bearer actor and configured
principal, and preserve the validated command payload or stable agent-plan
intent and dispatch state. A successful retry consumes the challenge. The
command center then consumes a separate non-serializable execution permit, so
copying confirmation headers into an internal command call does not authorize
handler or provider execution.

### Prompt and AI-routing trace containment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROMPT_DEBUG_TRACE_MODE` | `metadata` | Exact `off`, `metadata`, or `full`. `metadata` keeps bounded categorical routing evidence but removes prompts, executor payloads, responses, session values, and raw failure details. `off` collects nothing. Invalid non-empty values resolve to `off`. `full` is an explicit sensitive-debug mode with bounded cloning and credential redaction; it is not an anonymization guarantee. |
| `PROMPT_DEBUG_TRACE_PERSIST` | `false` | Only exact `true` permits prompt-debug disk hydration and append. Persistence remains disabled when the byte cap is missing or invalid. |
| `PROMPT_DEBUG_TRACE_MAX_BYTES` | none | Required only for persistence. Accepts an integer from 1,024 through 104,857,600 bytes. Complete JSONL events are dropped at the cap; the service never truncates or rotates the file automatically. |
| `PROMPT_DEBUG_EVENTS_PATH` | `logs/prompt-debug-events.jsonl` | Selects the optional JSONL path but never enables persistence by itself. |

The metadata policy also covers the bounded in-memory AI-routing debug store.
Both read APIs require the control-plane operator identity and `arcanos:read`.
Self-heal consumes categorical intent/tool evidence and does not require prompt
text. Switching from `full` to `metadata` purges retained in-memory content.
Previously created JSONL files remain sensitive and require an explicitly
approved operator rotation or deletion procedure; the application does not
remove them during rollout.

For HTTP predictive decisions, server feature flags remain authoritative.
`simulate` is accepted only with explicit `dryRun: true` and without
`execute: true`. Live execution returns 409 while predictive healing is
disabled or server dry-run is enabled; the request body cannot lower either
server guard.

### Daemon transport authentication

Every `/api/daemon/*` route requires one deployment-wide, purpose-bound
credential before heartbeat, command, result, confirmation, registry, or daemon
store work. The daemon router is mounted outside the writing-plane consistency
and reroute flow. Authenticated unknown paths terminate inside the daemon
namespace instead of falling through to GPT dispatch.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_DAEMON_ACCESS_TOKEN` | none | Dedicated daemon transport credential shared by the backend and bundled Python daemon. Configure an exact, case-sensitive 32–4096 character value with no whitespace or placeholder text, distinct from every credential in `src/shared/security/purposeBoundCredential.ts`. The only accepted carrier is exactly one `x-arcanos-daemon-token`; Bearer authorization, `x-gpt-id`, cookies, query parameters, and body fields are ignored. Missing or invalid server configuration returns `503 DAEMON_AUTH_UNAVAILABLE`; missing, malformed, duplicate, or incorrect request credentials return `401 DAEMON_AUTH_REQUIRED`. The backend reads configuration per request; the Python daemon loads it at process start and fails locally before network access when it is missing or malformed. |

This boundary prevents anonymous transport callers but does not establish
per-instance identity. Any credential holder can address any known
`instanceId`. The backend persists only internal store partitions—not the
access credential—and preserves historical opaque partition values for
compatibility. Coordinate backend and daemon token rollout because all daemon
routes, including registry startup reads, fail closed without it.

### Memory-plane authentication

The production mounts for `/api/memory/*`, `/api/save-conversation*`, and
`/api/sessions*`, plus the exact natural-language memory-interception branch of
`POST /gpt/:gptId`, require one deployment-wide, purpose-bound credential. The
three HTTP prefixes authenticate before broad body parsing, writing-plane
consistency checks, confirmation gates, or persistence. Exact GPT interception
authenticates after parsing but before fast-path execution, job creation, or
memory execution. Requests that do not enter that GPT branch are unchanged.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_MEMORY_ACCESS_TOKEN` | none | Dedicated memory/session-plane credential for `/api/memory/*`, `/api/save-conversation*`, `/api/sessions*`, and exact GPT memory interception. Configure an exact, case-sensitive 32–4096 character value with no whitespace or placeholder text, distinct from every credential in `src/shared/security/purposeBoundCredential.ts`. Send it only through `x-arcanos-memory-token`; Bearer authorization, cookies, query parameters, and body fields are not accepted. Missing or invalid server configuration returns `503 MEMORY_AUTH_UNAVAILABLE`; missing, malformed, duplicate, or incorrect request credentials return `401 MEMORY_AUTH_REQUIRED`. Configuration is resolved per request so rotation is immediate. |

This is access containment, not tenant authentication. Any token holder can
still choose `sessionId`, use global-list/search behavior where supported, and
address records available to this deployment. Tenant ownership requires a
separate schema and principal-binding change.

### Worker operator authentication

Privileged worker-helper routes, `POST /workers/heal`, and `POST /workers/run/:workerId` share the existing worker-helper credential verifier. The two direct routes accept the configured token or an already established full `admin`/`operator`/`owner` identity, but do not treat legacy daemon markers or operator audit labels as authority. They check authentication before action confirmation; `x-confirmed` and automation confirmation cannot authenticate a caller. Both heal entry points share a 10-per-15-minute authenticated-principal budget.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_WORKER_HELPER_TOKEN` | none | Privileged worker-control credential accepted through exactly one non-empty `x-arcanos-worker-helper-token` or Bearer carrier. Configure an exact 32–4096 character value with no whitespace or placeholder text, distinct from every credential in the canonical ARCANOS application-auth registry in `src/shared/security/purposeBoundCredential.ts`. Duplicate headers, simultaneous carriers, and values requiring trimming fail closed. Existing `/worker-helper/*` routes retain their documented internal-context alternatives; direct `/workers/heal` and `/workers/run/:workerId` accept only this token or an established full `admin`/`operator`/`owner` identity. `operator-light` is denied. The bundled helper and remote repair actuator read this variable only from their environment and send it only through `x-arcanos-worker-helper-token`; configure the identical value on the calling process and target service. |
| `SELF_HEAL_WORKER_SERVICE_URL` | none | Preferred remote worker-helper actuator origin. It must be an explicit, exact HTTPS origin with no credentials, path, query, or fragment. An exact HTTP loopback origin is accepted for local use only. |
| `WORKER_HELPER_BASE_URL`, `RAILWAY_SERVICE_ARCANOS_WORKER_URL`, `ARCANOS_WORKER_PUBLIC_URL` | none | Compatibility aliases for the remote worker-helper actuator origin. If more than one URL variable is configured, all configured values must normalize to the same exact origin. An invalid or conflicting alias makes remote actuation unavailable. |

`node scripts/worker-helper.mjs status` remains credential-free. Every protected
helper command requires a valid `ARCANOS_WORKER_HELPER_TOKEN`, fails locally
before fetch when the value is missing, invalid, placeholder-like, or collides
with another canonical application credential, and rejects token,
worker-helper-token, or Authorization CLI flags. Protected script and actuator
requests use only the custom worker-helper header, never an outbound
Authorization carrier, and reject redirects.

Remote worker-helper actuation is reported unavailable unless its URL aliases
resolve to one permitted origin and the caller has a valid token. The actuator
re-resolves the token immediately before fetch so rotation and collision changes
fail closed. The helper script accepts at most 1 MiB of JSON response data and
redacts exact credential reflections. The remote actuator accepts at most 64
KiB of JSON and returns only the requested-force value plus the allowlisted
`restart.started`, `restart.alreadyRunning`, and `restart.runWorkers` values. It
validates but discards target-controlled message text and generates a local
`restart.message` from those booleans.

### Railway service role
| Variable | Required | Purpose |
| --- | --- | --- |
| `ARCANOS_PROCESS_KIND=web` | Railway web service | Starts the compiled API runtime with `RUN_WORKERS=false` through `scripts/start-railway-service.mjs`. |
| `ARCANOS_PROCESS_KIND=worker` | Railway worker service | Starts `dist/workers/jobRunner.js` and exposes a minimal health server on `/health`, `/healthz`, and `/readyz`. |

If `ARCANOS_PROCESS_KIND` is missing or not `web`/`worker`, the Railway launcher exits with a fatal startup error by design.

The tracked Railway deployment gate is `/readyz` for both roles. When
`NODE_ENV=production` and `ARCANOS_PROCESS_KIND=web`, web readiness requires
configured and connected PostgreSQL and Redis dependencies plus completed
startup; PostgreSQL schema initialization must also be complete. Database
configuration may use `DATABASE_URL` or the complete
`PGUSER`/`PGPASSWORD`/`PGHOST`/`PGPORT`/`PGDATABASE` set; Redis may use
`REDIS_URL`, `REDISHOST`, or `REDIS_HOST`. Missing configuration returns
`503` without changing `/healthz` liveness or `/health` diagnostics. Worker
readiness remains `503` until database/autonomy/module-registry bootstrap and
every configured consumer slot's dispatcher-start write have completed, and a
supported OpenAI key setting is present. Provider readiness here means
configured, not a paid upstream request; provider outages are handled by the
worker's bounded probe/backoff and job-deferral path after activation. The
worker child reports this transition through an exact, newline-delimited
launcher protocol that is independent of `LOG_LEVEL`; arbitrary log text and
filtered info logs cannot satisfy or suppress the readiness transition.

`railway.json` also sets numeric `deploy.drainingSeconds` to `60`, the
repository-owned outer SIGTERM-to-SIGKILL ceiling. The web process retains its
shorter 10-second internal graceful-shutdown deadline; the worker cooperatively
aborts provider work, leaves active claims for lease recovery, and flushes
runtime snapshots before exit. The 60-second platform ceiling prevents
Railway's zero-second default from bypassing those handlers, but it is not a
claim that stalled external I/O has been measured in production.
The local Railway validator rejects
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` in `deploy.env` or any tracked
environment-variable map so the provider-native string setting cannot compete
with the canonical numeric field. Independently configured live service
variables still require effective-setting readback before promotion.

### GPT access and Trinity async execution
Protected GPT Action and operator calls must use `/gpt-access/*` for backend operations. Do not ask `/gpt/:gptId` to inspect runtime state, read queue/job results, call MCP tools, or proxy protected backend actions.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ARCANOS_GPT_ACCESS_TOKEN` | Yes for protected `/gpt-access/*` operations | none | Gateway bearer token. The gateway returns an auth/config error when this is missing. `GET /gpt-access/openapi.json` remains public. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | Yes for deployed GPT Action import | first valid configured public URL/domain, local request origin, then `http://localhost:3000` | Public origin for GPT Action OpenAPI metadata. Supported configured fallbacks include `ARCANOS_BASE_URL`, `ARCANOS_BACKEND_URL`, `SERVER_URL`, `BACKEND_URL`, `PUBLIC_BASE_URL`, `RAILWAY_PUBLIC_URL`, `RAILWAY_PUBLIC_DOMAIN`, and `RAILWAY_STATIC_URL`. Non-local request hosts are ignored. Railway PR previews advertise `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_PUBLIC_URL`, or `RAILWAY_STATIC_URL` before inherited production URLs. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Yes for job creation, capability discovery, capability runs, and worker recovery | all recognized scopes are granted when unset, except `jobs.create`, `capabilities.read`, `capabilities.run`, and `workers.recover` remain denied unless explicitly listed | Scope allowlist. Use `runtime.read,workers.read,queue.read,jobs.create,jobs.result,diagnostics.read` for the minimal protected async Trinity flow; add `workers.recover` only for confirmed worker recovery dispatch; add `capabilities.read` for discovery and `capabilities.run` only with `MCP_ALLOW_MODULE_ACTIONS` and confirmation. |
| `OPENAI_API_KEY` | Yes for live worker execution | none | Preferred OpenAI key setting. The config layer also supports the fallback key names listed above. |
| `DATABASE_URL` or complete `PG*` set | Yes for durable async jobs | none | Required by `/gpt-access/jobs/create` persistence and by the worker queue. Web and worker services must share the same database. |
| `JOB_WORKER_ID` | No | `async-queue` | Base worker identity for queue claims, logs, and heartbeat state. |
| `JOB_WORKER_STATS_ID` | No | `JOB_WORKER_ID` | Stable aggregate identity for worker inspection. |
| `JOB_WORKER_CONCURRENCY` | No | `WORKER_COUNT` or `1` | Number of queue-consumer slots in one worker process. |
| `WORKER_TRINITY_RUNTIME_BUDGET_MS` | No | `420000` | Max worker Trinity runtime budget. |
| `WORKER_TRINITY_STAGE_TIMEOUT_MS` | No | `180000` | Per-stage/model timeout passed from worker-originated Trinity calls. |
| `PLANNER_TIMEOUT_MS` | No | `WORKER_TRINITY_STAGE_TIMEOUT_MS` | Planner DAG node timeout. |
| `PLANNER_MAX_RETRIES` | No | `2` | Planner retry count after the first attempt. |
| `PLANNER_RETRY_BACKOFF_MS` | No | `1000` | Planner retry backoff base. |
| `DAG_MAX_ACTIVE_RUNS` | No | `4` | Maximum admitted DAG runs whose execution has not settled in one web process. Reservations are acquired before the first asynchronous admission write and remain held through cancellation requests until execution settles. |
| `DAG_TERMINAL_RETENTION_MS` | No | `900000` | Age threshold for expiry-based lazy eviction of settled terminal DAG snapshots; the retained-run cap can evict the oldest eligible record earlier. |
| `DAG_MAX_RETAINED_RUNS` | No | `100` | Maximum locally retained DAG run records per web process; the oldest safely settled terminal records are evicted first. |
| `DAG_OVERLOAD_RETRY_AFTER_SECONDS` | No | `5` | Stable `Retry-After` value returned for DAG capacity and temporarily unavailable cancellation decisions. |
| `ARCANOS_CORE_BACKGROUND_HANDLER_TIMEOUT_MS` | No | background profile default | Handler timeout for background `ARCANOS:CORE` execution. |
| `ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS` | No | `120000` | Primary Trinity timeout for background `ARCANOS:CORE` execution, clamped by code. |
| `ARCANOS_CORE_BACKGROUND_DEGRADED_HEADROOM_MS` | No | background profile default | Time reserved for degraded fallback after a background pipeline timeout. |
| `TRINITY_DAG_GPT_ACCESS_ENABLED` | No | auto-enabled only when worker slots are greater than `DAG_MAX_CONCURRENT_NODES` | Routes queued DAG node execution through `/gpt-access/jobs/create` and `/gpt-access/jobs/result`. Set `true` only with `JOB_WORKER_CONCURRENCY` or `WORKER_COUNT` at least `DAG_MAX_CONCURRENT_NODES + 1`; unsafe forced routing fails clearly instead of risking nested queue deadlock. Set `false` for local legacy direct-worker debugging. |
| `GPT_MODULE_MAP` | No | definitions from the explicit module catalog | JSON override/extension for GPT ID bindings; each target must match an exact registered public module/route pair, so it cannot register service files, target absent or mismatched definitions, or expose GPT Access-only modules. |

Protected async Trinity flow:
1. `POST /gpt-access/jobs/create` validates bearer auth and the `jobs.create` scope.
2. The gateway writes one durable `gpt` job and returns `jobId`.
3. The worker claims the job, calls the GPT dispatcher in-process, and routes `arcanos-core` to `ARCANOS:CORE`.
4. `ARCANOS:CORE` calls `runTrinityWritingPipeline(...)`, which rejects control-plane leakage before `runThroughBrain(...)`.
5. The worker stores terminal output and protected clients poll `POST /gpt-access/jobs/result`.

Queued Trinity DAG nodes use `src/services/trinity/adapter.ts` to create and poll Arcanos core GPT jobs through the same GPT Access job path. The adapter accepts injected config/dependencies for tests and non-Railway runtimes; production code reads the role toggle from `TRINITY_DAG_GPT_ACCESS_ENABLED` and otherwise only auto-enables when worker slots exceed `DAG_MAX_CONCURRENT_NODES`, preserving at least one slot for child GPT jobs.

DAG admission and retention are process-local safeguards, so `DAG_MAX_ACTIVE_RUNS` and `DAG_MAX_RETAINED_RUNS` apply independently to each web replica rather than forming a deployment-wide quota. Terminal eviction is lazy and removes only locally settled records after their execution, cancellation-control write, and queued snapshot persistence have all finished; durable PostgreSQL snapshots are not deleted by this cleanup.

Use `docs/TRINITY_PIPELINE.md` for the full execution flow and `docs/gpt-access-gateway.md` for curl examples.

### Local-agent capability bridge

`ARCANOS:LOCAL_AGENT` is an opt-in outbound Python executor behind the existing
GPT Access capability and `job_data` paths. It does not expose a Python API or
accept principal, workspace, device, root, authorization, or confirmation
fields from capability payloads. See
`docs/LOCAL_AGENT_CAPABILITY_BRIDGE.md` for setup, contracts, and the
Railway deployment plan.

| Variable | Runtime | Required when enabled | Purpose |
| --- | --- | --- | --- |
| `ARCANOS_LOCAL_AGENT_WORKSPACES` | Backend | Yes | Comma-separated server workspace ID allowlist. |
| `ARCANOS_LOCAL_AGENT_JOB_TTL_MS` | Backend | No | Durable assignment lifetime; clamped to exceed the action timeout and to at most 24 hours. |
| `ARCANOS_LOCAL_AGENT_LEASE_MS` | Backend | No | Device claim lease, clamped to 10-60 seconds. |
| `ARCANOS_LOCAL_AGENT_HEARTBEAT_TTL_MS` | Backend | No; default `90000` | Maximum age of the registered device heartbeat before capability enqueue fails as offline; clamped to 10 seconds-15 minutes. |
| `ENABLE_ACTION_PLANS` | Backend | Yes | Enables the existing authoritative Agent registration and executor identity infrastructure. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN` | Backend and daemon | Yes | Dedicated bearer credential accepted only by the `local-agent-protocol` audience. It must be distinct from GPT Access and every ActionPlan role token. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID` | Backend and daemon | Yes | Pinned local-agent executor principal. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID` | Backend and daemon | Yes | Pinned local-agent executor instance. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID` | Backend and daemon | Yes | Authoritative registered executor Agent/device UUID. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN` | Backend only | No | Previous dedicated token accepted only during a configured rotation overlap. Configure together with its expiry. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT` | Backend only | No | ISO-8601 UTC expiry for the previous token; it may be no more than 24 hours in the future. Expired values are not accepted. |
| `ARCANOS_LOCAL_AGENT_ENABLED` | Daemon | No; default `false` | Starts the outbound polling thread. |
| `ARCANOS_LOCAL_AGENT_ACTIONS` | Daemon | Yes | Local action allowlist, restricted to the seven catalog actions. |
| `ARCANOS_LOCAL_AGENT_DEVICE_SCOPES` | Daemon | Yes | Local device-scope allowlist, which must also be granted to the authoritative Agent. |
| `ARCANOS_LOCAL_AGENT_TEST_EXECUTION_MODE` | Daemon | No; default `disabled` | `disabled`, `sandboxed`, or `unsandboxed-development-only`. Production-capable configuration requires `sandboxed`; there is no automatic fallback to host execution. |
| `ARCANOS_LOCAL_AGENT_SANDBOX_RUNTIME` | Daemon | Required for `sandboxed` | `docker` or `podman`. The runtime must successfully execute the baked-in sandbox self-test. |
| `ARCANOS_LOCAL_AGENT_SANDBOX_IMAGE` | Daemon | Required for `sandboxed` | Immutable registry RepoDigest (`name@sha256:...`) or local image ID (`sha256:...`). Mutable tags are rejected. |
| `ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS` | Daemon | No; default `false` | Second opt-in required only with `unsandboxed-development-only`. That mode is rejected when `NODE_ENV=production` or Railway runtime markers are present. |
| `ARCANOS_LOCAL_AGENT_WORKSPACES_JSON` | Daemon | Yes | Bounded JSON map from server workspace IDs to existing absolute local roots. |
| `ARCANOS_LOCAL_AGENT_POLL_INTERVAL_SECONDS` | Daemon | No; default `5` | Outbound poll delay. |
| `ARCANOS_LOCAL_AGENT_HEARTBEAT_SECONDS` | Daemon | No; default `10` | Active-job heartbeat interval. |

Backend capability use also requires `capabilities.read`, `capabilities.run`,
and `jobs.result` as appropriate, a narrow
`MCP_ALLOW_MODULE_ACTIONS=ARCANOS:LOCAL_AGENT:*` entry, configured GPT Access
principal and workspace IDs, PostgreSQL, and a matching authoritative executor
Agent record. An ActionPlan operator credential is required to register or
manage that Agent; a requester credential is not required by the bridge. Any
configured ActionPlan role credentials and principal IDs must remain complete
and distinct. Local-agent HTTP routes require the dedicated audience and only
the heartbeat, claim, job-heartbeat, and result scopes; the credential cannot
authenticate as an ActionPlan executor.

The hardened job path requires
`migrations/20260724_local_agent_job_hardening_v1`. The migration adds the
database-authoritative idempotency binding and its expiry index; job state and
each lifecycle event are persisted in the same transaction. The migration
runner intentionally ignores ambient `DATABASE_URL`. First validate the
reviewed artifacts without a database:

```powershell
npm run db:local-agent-hardening:plan
```

For the newly provisioned isolated preview PostgreSQL service, set
`LOCAL_AGENT_HARDENING_PREVIEW_TARGET=true` on that service. Run the migration
only through Railway's variable injection with explicit project, environment,
and PostgreSQL service IDs:

```powershell
railway run --no-local --project <preview-project-id> --environment <preview-environment-id> --service <preview-postgres-service-id> -- npm run db:local-agent-hardening:apply-preview -- --confirm-preview --expected-project-id <preview-project-id> --expected-environment-id <preview-environment-id> --expected-postgres-service-id <preview-postgres-service-id>
railway run --no-local --project <preview-project-id> --environment <preview-environment-id> --service <preview-postgres-service-id> -- npm run db:local-agent-hardening:verify-preview -- --confirm-preview --expected-project-id <preview-project-id> --expected-environment-id <preview-environment-id> --expected-postgres-service-id <preview-postgres-service-id>
```

The runner rejects production-like environments and the known Phase 2E Redis
validation environment/service. It connects only through the selected
service's injected `DATABASE_PUBLIC_URL` and verifies that URL against the same
service's generated PostgreSQL identity fields. Never print or pass the preview
database URL as a command-line argument.

### Dedicated job runner
| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_WORKER_ID` | `async-queue` | Base worker identity used in logs, heartbeats, and queue claiming. |
| `JOB_WORKER_STATS_ID` | `JOB_WORKER_ID` | Stable stats/inspection identity. |
| `JOB_WORKER_CONCURRENCY` | `WORKER_COUNT` or `1` | Number of queue-consumer slots in one worker process. |
| `JOB_WORKER_POLL_MS` | `250` | Poll delay after a claimed job cycle. |
| `JOB_WORKER_IDLE_BACKOFF_MS` | `1000` | Sleep interval when no job is available. |
| `JOB_WORKER_DB_BOOTSTRAP_RETRY_MS` | `5000` | Initial retry delay while waiting for database connectivity. |
| `JOB_WORKER_DB_BOOTSTRAP_MAX_RETRY_MS` | `30000` | Max DB bootstrap retry delay. |
| `JOB_WORKER_DB_BOOTSTRAP_MAX_ATTEMPTS` | `0` | `0` means retry indefinitely. |
| `JOB_EVENTS_CLEANUP_ENABLED` | `true` | Enables best-effort `job_events` retention cleanup during worker inspection. Legacy `JOB_EVENT_CLEANUP_ENABLED` is also accepted. |
| `JOB_EVENTS_RETENTION_DAYS` | `30` | Retains recent job timeline events for operational forensics. Values are bounded to 1-365 days. Legacy `JOB_EVENT_RETENTION_DAYS` is also accepted. |
| `JOB_EVENTS_CLEANUP_BATCH_SIZE` | `1000` | Maximum `job_events` rows matched or deleted per cleanup run. Values are bounded to 1-10000 to avoid long table locks. Legacy `JOB_EVENT_CLEANUP_BATCH_SIZE` is also accepted. |
| `JOB_EVENTS_CLEANUP_DRY_RUN` | `true` | When true, cleanup counts eligible old events without deleting them. Set to `false` after reviewing cleanup metrics/logs. Legacy `JOB_EVENT_CLEANUP_DRY_RUN` is also accepted. |
| `JOB_EVENT_RECORD_HEARTBEATS` | `false` | When true, records high-frequency `worker.heartbeat` timeline events. Leave false unless debugging a specific lease issue because `job_data.last_heartbeat_at` already tracks liveness. |

Use `npm run build` before `npm run job-events:timeline -- --job-id <uuid> --output text` to reconstruct a redacted chronological job timeline from the compiled backend. The script first invokes the shared database initializer, which can apply built-in schema DDL and write an initialization heartbeat; treat it as a configured-database operation and run it only with explicit authorization and exact target confirmation.

### Self reflections and judged feedback
| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_CONTEXT_MODE` | `reinforcement` | Enables/disables contextual reinforcement recording (`off` disables storage in memory context window). |
| `ARCANOS_CONTEXT_WINDOW` | `50` | Maximum in-memory reinforcement entries retained. |
| `ARCANOS_MEMORY_DIGEST_SIZE` | `8` | Context digest length used in system prompt reinforcement section. |
| `ARCANOS_CLEAR_MIN_SCORE` | `0.85` | Minimum normalized score threshold for judged acceptance. |
| `TRINITY_JUDGED_FEEDBACK_ENABLED` | `true` | Enables automatic judged feedback writes from Trinity CLEAR audit output. |
| `TRINITY_JUDGED_ALLOWED_ENDPOINTS` | `*` | Comma-separated source-endpoint allowlist for auto-judged feedback (`*` allows all). |
| `JUDGED_FEEDBACK_CACHE_MAX_ENTRIES` | `2000` | Maximum entries retained in judged idempotency cache. |

### MCP server
| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_BEARER_TOKEN` | none | Required bearer token for `POST /mcp`. |
| `ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID` | none | Required, alongside a valid `MCP_BEARER_TOKEN` and valid ActionPlan auth configuration, to expose requester-owned ActionPlan tools on HTTP MCP. Binds the authenticated MCP credential to one fixed requester principal; invalid, conflicting, or already-configured principal IDs leave those tools unexposed. |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated browser origin allowlist for MCP HTTP requests. |
| `MCP_HTTP_BODY_LIMIT` | `1mb` | JSON body size limit for MCP transport route. |
| `MCP_REQUIRE_CONFIRMATION` | `true` | Require nonce confirmation for gated MCP tools. |
| `MCP_CONFIRM_TTL_MS` | `60000` | Nonce expiration window for MCP confirmation flow. |
| `MCP_EXPOSE_DESTRUCTIVE` | `false` | Expose destructive MCP tools when set to true. |
| `MCP_ENABLE_SESSIONS` | `false` | Enable transport session ID generation in MCP HTTP transport. |
| `MCP_ALLOW_MODULE_ACTIONS` | empty | CSV allowlist controlling `modules.invoke` and GPT Access capability runs (`module:action` or `module:*`; the final colon separates module from action). |

### GPT Access natural-language dispatch
| Variable | Default | Purpose |
| --- | --- | --- |
| `GPT_ACCESS_NL_DISPATCH_MODE` | unset | When unset, effective mode is `hybrid` if a real resolved OpenAI key is configured, using the OpenAI key resolution order above, and `rules` otherwise. `rules` never calls the LLM; `hybrid` runs rules first and calls the LLM only when rules require clarification; `llm_first` calls the LLM first and returns semantic LLM clarification as-is, falling back to deterministic rules only when the LLM is unavailable, fails, times out, or returns invalid output. Invalid values resolve to `rules`. |
| `GPT_ACCESS_DISPATCH_MODEL` | `gpt-4.1-mini` | OpenAI Responses API model for the semantic planner only; it does not follow the general `OPENAI_MODEL` precedence chain. |
| `GPT_ACCESS_DISPATCH_LLM_TIMEOUT_MS` | `5000` | Per-dispatch LLM planning timeout. Invalid or non-positive values use the default and positive values are capped at `10000`. Timeout/failure never executes an LLM plan; execution can continue only through a deterministic rule plan that still passes policy and confirmation. |

The semantic planner can only propose one registered action plus a JSON-object payload. The gateway still enforces registry lookup, GPT Access scopes, `MCP_ALLOW_MODULE_ACTIONS`, risk-aware confidence policy, unsafe payload-field rejection, prohibited action names, and confirmation. Confidence thresholds are fixed in code, not environment-configured: readonly `0.65`, privileged `0.78`, and destructive `0.90`; clarification bands are readonly `0.55-<0.65` and privileged `0.70-<0.78`. Worker recycle/recover dispatch is registered as privileged `workers.recycle` / `workers.recover`, requires explicit `workers.recover` scope and confirmation, and only reclaims stale queue jobs through the approved recovery runner. `GET /gpt-access/health` exposes sanitized `nlDispatch` configuration for deployment verification.

### Metrics
| Variable | Default | Purpose |
| --- | --- | --- |
| `METRICS_ENABLED` | enabled unless `false` | Controls `GET /metrics`. |
| `METRICS_AUTH_TOKEN` | none | Optional bearer or `x-metrics-token` secret for `GET /metrics`; no token means the metrics endpoint is public. |

### Daemon-specific core variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Required by the current daemon startup validator, including backend and hybrid routing modes. |
| `BACKEND_URL` | none | Backend routing target (recommended for `arcanos-daemon`). |
| `BACKEND_TOKEN` | none | Optional generic bearer token for non-daemon backend routes. It is never sent to `/api/daemon/*`. |
| `ARCANOS_DAEMON_ACCESS_TOKEN` | none | Required for generic daemon heartbeat and command threads and every `/api/daemon/*` request. The Python client sends it only as `x-arcanos-daemon-token`, with no `BACKEND_TOKEN`/API-key/admin-key fallback. |
| `BACKEND_GPT_ID` | `arcanos-daemon` | Identifies the daemon to the backend for `/gpt/:gptId` routing and optional `x-gpt-id` auth metadata. |
| `BACKEND_ALLOW_GPT_ID_AUTH` | `false` | If true, daemon may authenticate via `x-gpt-id` without a bearer token (backend must allow). |
| `BACKEND_ROUTING_MODE` | `hybrid` | `local`, `backend`, or `hybrid`. |
| `AGENTIC_ENABLED` | `true` | Enables multi-step reasoning loop (ask → propose → approve → apply/run → continue). |
| `AGENT_MAX_STEPS` | `6` | Max loop iterations per user request. |
| `REPO_INDEX_ENABLED` | `true` | Enables lightweight repo indexing context injection. |
| `REPO_INDEX_MAX_FILES` | `800` | Upper bound for indexed file count. |
| `REPO_INDEX_MAX_CHARS` | `50000` | Upper bound for serialized context payload size. |
| `HISTORY_DB_PATH` | `history.db` | SQLite file for messages/patch/command history and audit. |
| `PATCH_BACKUP_DIR` | `patch_backups` | Directory used for backup snapshots (rollback support). |
| `PATCH_TOKEN_START` | `---patch.start---` | Optional explicit patch block delimiter recognized by the CLI. |
| `PATCH_TOKEN_END` | `---patch.end---` | Optional explicit patch block delimiter recognized by the CLI. |
| `AUTOMATIONS_FILE` | `automations.toml` | TOML file containing local automation recipes (`/auto`). |
| `DEBUG_SERVER_TOKEN` | none | Strongly recommended when debug server enabled. |
| `IDE_AGENT_DEBUG` / `DEBUG_SERVER_ENABLED` | `false` | Enables local debug server. |

## Run locally
Backend config validation is implicit at startup. Use:
```bash
npm run build
npm start
```

Daemon config validation occurs on daemon startup:
```bash
cd daemon-python
arcanos
```

## Deploy (Railway)
- Keep required runtime values in Railway Variables.
- Keep production and development variables separated.
- Railway injects `PORT` and optionally `DATABASE_URL` when PostgreSQL is attached.
- Set `ARCANOS_PROCESS_KIND=web` on the web service and `ARCANOS_PROCESS_KIND=worker` on the worker service.
- Configure optional `GPT_ACCESS_*` dispatch variables on the web service only when enabling `hybrid` or `llm_first`; verify `OPENAI_API_KEY` is present there and deploy/restart the web service before validation. These variables do not recycle worker processes.

## Troubleshooting
- Local server uses an unexpected port: set `PORT=3000` in `.env` explicitly.
- Railway launcher fatal startup error: set `ARCANOS_PROCESS_KIND` to `web` or `worker` on that service.
- Unexpected model in use: verify model precedence chain and remove conflicting variables.
- Confirmation bypass not working: verify header name and secret match exactly.

## Generated Directories

These directories are created at runtime or during builds and must **not** be committed. All are listed in `.gitignore`.

| Directory | Generated by | Purpose |
| --- | --- | --- |
| `dist/` | `npm run build` | Compiled TypeScript output |
| `node_modules/` | `npm install` | Node.js dependencies |
| `coverage/` | `npm test` / `pytest --cov` | Test coverage reports |
| `logs/` | Runtime | Application and audit logs |
| `converge-artifacts/` | `npm run converge:ci` | CI convergence gate output |
| `**/.pytest_cache/` | pytest | Python test cache |

## References
- `../.env.example`
- `../config/env/core.env.example`
- `../src/platform/runtime/unifiedConfig.ts`
- `../src/platform/runtime/env.ts`
- `../daemon-python/.env.example`


## OpenAI data retention
- `OPENAI_STORE` (default: `false`)
  - When `true`, Responses requests will be created with `store: true`.
  - When `false`, Responses requests use `store: false` (stateless / no retention).

## Daemon tool result continuation
These control how long the backend waits for the daemon to report tool results before continuing the model response:
- `DAEMON_RESULT_WAIT_MS` (default: `8000`)
- `DAEMON_RESULT_POLL_MS` (default: `250`)

## Selected environment variable reference
This table mirrors high-impact runtime keys and active operator controls in `.env.example`; it is not an exhaustive schema. Earlier sections group variables by runtime area. Use `.env.example` as the full template and executable configuration as the source of truth for code defaults.
| Variable | Default (example) | Purpose |
|---|---:|---|
| `PORT` | `3000` | HTTP port the server binds to. |
| `NODE_ENV` | `development` | Runtime mode. |
| `OPENAI_API_KEY` | `your-openai-api-key-here` | OpenAI API key used by server/runtime. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Default model name from `.env.example`; the runtime can still fall back to its built-in model when unset. |
| `ARCANOS_BACKEND_URL` | `http://127.0.0.1:3000` (commented) | Backend base URL used by CLI/scripts before fallback variables. |
| `OPENAI_ACTION_SHARED_SECRET` | `replace-with-a-strong-shared-secret` | Shared secret for `/api/bridge/gpt`, its compatibility alias, and `/api/bridge/health`. |
| `ARCANOS_JOB_READ_CAPABILITY_SECRET` | commented empty | Required current server-side HMAC key for job-specific generic read capabilities; new tokens use only this key. |
| `ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET` | commented empty | Optional verification-only old key for a bounded retained-job rotation overlap. |
| `ARCANOS_JOB_READ_TOKEN` | commented empty | Client-only transient token for one standalone generic job lookup; never a shared backend signing key. |
| `ARCANOS_GPT_ACCESS_TOKEN` | commented placeholder | Bearer token for `/gpt-access/*`; real values must not be committed or logged. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | commented HTTPS placeholder | Public origin advertised by `/gpt-access/openapi.json`; set this in deployed environments. |
| `ARCANOS_GPT_ACCESS_SCOPES` | commented scope list | Gateway scope allowlist. `jobs.create`, `capabilities.read`, `capabilities.run`, and `workers.recover` must be explicit before they enqueue, discover, execute capability work, or recover workers. |
| `ARCANOS_CLI_BRIDGE_ENABLED` | `false` | Enables the optional local ARCANOS:CLI bridge capability. |
| `ARCANOS_CLI_BRIDGE_URL` | `http://127.0.0.1:8765` | Local daemon bridge URL used by the capability. |
| `ARCANOS_CLI_BRIDGE_TOKEN` | empty | Shared bridge token; keep the real value out of GPT payloads and source control. |
| `ARCANOS_CLI_SANDBOX_ROOT` | empty | Optional filesystem sandbox root for CLI bridge operations. |
| `ARCANOS_WORKSPACE_ROOT` | empty | Optional explicit workspace root used by local CLI integration. |
| `ARCANOS_CLI_COMMAND_TIMEOUT_MS` | `30000` | CLI bridge command timeout. |
| `ARCANOS_CLI_OUTPUT_MAX_BYTES` | `20000` | Maximum captured CLI bridge output. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN` | commented placeholder | Dedicated `local-agent-protocol` bearer credential; it must not match GPT Access or any ActionPlan role credential. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID` | commented UUID placeholder | Authoritative registered local-agent device/Agent UUID. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN` | commented empty | Optional previous dedicated credential for one bounded rotation overlap. |
| `ARCANOS_LOCAL_AGENT_EXECUTOR_PREVIOUS_TOKEN_EXPIRES_AT` | commented ISO-8601 placeholder | Previous-token expiry, limited to at most 24 hours from validation time. |
| `ARCANOS_LOCAL_AGENT_HEARTBEAT_TTL_MS` | `90000` (commented) | Fresh-device window before local-agent enqueue fails closed; clamped to 10 seconds-15 minutes. |
| `GPT_ACCESS_NL_DISPATCH_MODE` | unset (commented) | Optional `/gpt-access/dispatch/run` resolver mode: `rules`, `hybrid`, or `llm_first`; unset defaults from real OpenAI credential availability. |
| `GPT_ACCESS_DISPATCH_MODEL` | `gpt-4.1-mini` (commented) | Model used only by the optional semantic dispatcher. |
| `GPT_ACCESS_DISPATCH_LLM_TIMEOUT_MS` | `5000` (commented) | Optional semantic dispatcher timeout, capped at `10000`; failures fall back only through deterministic rules and policy checks. |
| `DEFAULT_GPT_ID` | `arcanos-core` | Default GPT id for bridge requests that omit `gptId`. |
| `ARCANOS_PROCESS_KIND` | `web` (commented) | Explicit Railway launcher role: `web` or `worker`. |
| `ALLOW_MOCK_FALLBACK` | `false` | Allow fallback to mocked providers in non-prod. |
| `BUDGET_DISABLED` | `false` | Disable runtime budget enforcement (not recommended in prod). |
| `ARCANOS_OWNER_EMAIL` | `you@example.com` | Optional identity-module owner bootstrap email; replace the example only in runtime configuration. |
| `DEBUG_WATCHDOG` | `false` (commented) | Registers the optional `GET /debug/watchdog` route only when exactly `true`; changing this flag requires route re-registration or process restart. Leave disabled in production. |
| `DEBUG_WATCHDOG_KEY` | commented placeholder | Required whenever `DEBUG_WATCHDOG=true`. Use a distinct 32–4096 character purpose-bound credential with no surrounding whitespace or placeholder form. The route reads it per request so rotation/revocation is immediate; unavailable configuration returns generic `503`, while missing or wrong `x-debug-key` returns generic `403`. |
| `WATCHDOG_LIMIT_MS` | `120000` | Hard watchdog limit for long-running operations. |
| `SAFETY_BUFFER_MS` | `2000` | Safety buffer subtracted from watchdog to stop early. |
| `TRINITY_BASE_SOFT_CAP_MS` | `60000` | Base soft cap for Trinity-mode calls. |
| `TRINITY_MULT_SIMPLE` | `1.0` | Multiplier for simple Trinity calls. |
| `TRINITY_MULT_COMPLEX` | `1.4` | Multiplier for complex Trinity calls. |
| `TRINITY_MULT_CRITICAL` | `1.8` | Multiplier for critical Trinity calls. |
| `ARCANOS_GAMING_MODULE_TIMEOUT_MS` | `60000` (commented) | ARCANOS:GAMING module dispatch timeout. Raising it can expand provider pipeline defaults while preserving normal mode defaults at the documented 60s budget. |
| `ARCANOS_GAMING_PIPELINE_TIMEOUT_MS` | `35000` (commented) | Generic Gaming provider pipeline timeout for guide/build/meta when a mode-specific override is not set. |
| `ARCANOS_GAMING_GUIDE_PIPELINE_TIMEOUT_MS` | `50000` (commented) | Guide-mode Gaming provider pipeline timeout; kept below the module dispatch timeout so provider stalls become controlled generation timeouts. |
| `ARCANOS_GAMING_STAGE_TIMEOUT_MS` | `12000` (commented) | Generic Gaming provider stage/model timeout for guide/build/meta when a mode-specific override is not set. |
| `ARCANOS_GAMING_GUIDE_STAGE_TIMEOUT_MS` | `24000` (commented) | Guide-mode Gaming provider stage/model timeout; clamped below the guide pipeline timeout with request headroom. |
| `ARCANOS_GAMING_WEB_CONTEXT_CHARS` | `5000` (commented) | Per-guide snippet size used by Gaming guide URL enrichment. |
| `ARCANOS_GAMING_WEB_CONTEXT_MAX_URLS` | `15` (commented) | Maximum user-provided guide URLs fetched concurrently for Gaming guide enrichment. |
| `WEB_FETCH_MAX_LINKS` | `15` (commented) | Maximum discovered page links included by the shared web fetch path. |
| `RAILWAY_API_TOKEN` | `` | Railway API token used by optional automation/ops routes. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Filesystem path for logs (if file logging enabled). |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem path for memory persistence. |
| `RUN_WORKERS` | `true` | Whether the explicit local/direct API startup lifecycle boots the in-process worker runtime. The Railway launcher sets this by role; the dedicated `jobRunner` owns its own PostgreSQL queue lifecycle. |
| `WORKER_API_TIMEOUT_MS` | `60000` template override; `30000` unified-config default when unset | Timeout for worker-to-server API calls. |
| `JOB_WORKER_ID` | `async-queue` (commented) | Dedicated worker identity. |
| `JOB_WORKER_CONCURRENCY` | `1` (commented) | Queue-consumer slots per worker process. |
| `JOB_WORKER_POLL_MS` | `250` (commented) | Worker polling delay after claim cycles. |
| `JOB_WORKER_HEARTBEAT_MS` | `5000` | Worker heartbeat interval. |
| `JOB_WORKER_STALE_AFTER_MS` | `45000` | Age after which a worker heartbeat is considered stale. |
| `JOB_WORKER_WATCHDOG_MS` | `10000` | Worker watchdog inspection interval. |
| `JOB_WORKER_WATCHDOG_IDLE_MS` | `120000` | Idle threshold used by the worker watchdog. |
| `WORKER_TRINITY_RUNTIME_BUDGET_MS` | `420000` (code default) | Worker Trinity runtime budget. |
| `WORKER_TRINITY_STAGE_TIMEOUT_MS` | `180000` (code default) | Worker Trinity stage/model timeout. |
| `TRINITY_DAG_GPT_ACCESS_ENABLED` | unset in `.env.example`; code auto-enables only when worker slots exceed `DAG_MAX_CONCURRENT_NODES` if unset | Queue DAG node prompts through GPT Access job creation/result polling. |
| `GPT_FAST_PATH_ENABLED` | `true` | Enables eligible inline GPT prompt-generation requests. |
| `PRIORITY_QUEUE_ENABLED` | `true` | Enables the priority GPT queue lane. |
| `PRIORITY_QUEUE_WEIGHT` | `5` | Weight assigned to priority queue scheduling. |
| `GPT_DIRECT_EXECUTION_THRESHOLD_MS` | `8000` | Direct-execution threshold for eligible GPT requests. |
| `GPT_WAIT_TIMEOUT_MS` | `24000` | Maximum inline wait for a queued GPT result. |
| `GPT_JOB_MAX_RETRIES` | `1` | Retry limit for GPT jobs. |
| `REDIS_URL` | `redis://localhost:6379` (commented) | Preferred `redis://` or TLS `rediss://` connection string. |
| `SAFETY_HEARTBEAT_TIMEOUT_MS` | `15000` | Worker heartbeat timeout window. |
| `SAFETY_HEARTBEAT_MISS_THRESHOLD` | `3` | Missed heartbeats before marking unhealthy. |
| `SAFETY_HEALTHY_CYCLES_TO_RECOVER` | `3` | Healthy cycles required to recover from unhealthy state. |
| `SAFETY_QUARANTINE_COOLDOWN_MS` | `120000` | Cooldown after quarantining before recovery. |
| `SAFETY_WORKER_RESTART_THRESHOLD` | `5` | Restart threshold within the restart window. |
| `SAFETY_WORKER_RESTART_WINDOW_MS` | `300000` | Window for counting worker restarts. |
| `DISPATCH_V9_POLICY_TIMEOUT_MS` | `5000` | Timeout for dispatch policy evaluation. |
| `SAFETY_FAIL_CLOSED_INTEGRITY` | `true` | Fail closed when integrity checks cannot be satisfied. |
| `OPENAI_STORE` | `false` | If true, allow OpenAI to store Responses; default false (stateless). |
| `MCP_BEARER_TOKEN` | commented placeholder | Required for `POST /mcp`. |
| `ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID` | unset | Fixed requester identity required to expose requester-owned ActionPlan tools through authenticated HTTP MCP. |
| `METRICS_AUTH_TOKEN` | commented empty | Optional token for `GET /metrics`. |
| `ADMIN_DB_PREVIEW_MAX_ROWS` | `100` | Maximum rows returned by approved database preview operations. |
| `ADMIN_DB_TABLE_LIST_LIMIT` | `40` | Maximum tables returned by approved database table listing. |
| `ASK_ROUTE_MODE` | `gone` (commented) | Legacy `/brain` migration switch. |
| `DAEMON_RESULT_WAIT_MS` | `8000` | How long (ms) to poll for daemon command results before continuing without them. |
| `DAEMON_RESULT_POLL_MS` | `250` | Poll interval (ms) when waiting for daemon results. |
| `WEB_SEARCH_PROVIDER` | `auto` | Provider selector for `POST /api/web/search`; supported values are `auto`, `duckduckgo-lite`, `brave`, `tavily`, `serpapi`, and `searxng`. |
| `WEB_SEARCH_TIMEOUT_MS` | `10000` | Overall web-search timeout. |
| `WEB_SEARCH_RATE_LIMIT_MAX` | `30` | Web-search rate-limit request count. |
| `WEB_SEARCH_RATE_LIMIT_WINDOW_MS` | `600000` | Web-search rate-limit window. |
| `WEB_SEARCH_SNAPSHOT_CHARS` | `2000` | Maximum response snapshot characters per result. |
| `TRAVERSE_LINKS_DEFAULT` | `false` | Default link traversal setting for web search. |
| `WEB_SEARCH_TRAVERSAL_DEPTH` | `1` | Link traversal depth. |
| `WEB_SEARCH_MAX_TRAVERSAL_PAGES` | `2` | Maximum pages traversed. |
| `WEB_SEARCH_SAME_DOMAIN_ONLY` | `true` | Restrict traversal to the result domain. |
| `WEB_SEARCH_TRAVERSAL_LINK_LIMIT` | `3` | Maximum links followed per traversal step. |
| `BRAVE_SEARCH_API_KEY` | empty | Optional Brave Search provider key. |
| `TAVILY_API_KEY` | empty | Optional Tavily provider key. |
| `SERPAPI_API_KEY` | empty | Optional SerpAPI provider key. |
| `SEARXNG_BASE_URL` | empty | Optional SearXNG instance URL. |
