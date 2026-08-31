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
| `ARCANOS_GPT_ACCESS_TOKEN` | Yes for generic protected `/gpt-access/*` operations | none | Bearer token for the generic GPT access gateway. `GET /gpt-access/openapi.json` is public. Store real values only in runtime variables or authorized generic GPT Access client configuration; never use it for the separate Backstage Booker protected read/canon or Gaming source lifecycle Actions. It remains compatible with the existing Backstage canon capability run under generic scope and confirmation policy, but it cannot read stored Backstage universe content. |
| `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` | No; only for the protected Backstage Booker Custom GPT operations and authenticated Notion-backed generation on the web service | none | Dedicated exact 32–4096-character visible-ASCII Bearer credential for the protected read/write lane, managed queued-result polling, and request-local authorization of private Notion-derived context on canonical generation. It authenticates one shared purpose-bound managed principal, not an end user, session, tenant, or universe; new `1.6.0` jobs retain that stable principal across future token rotations. For a Notion-authoritative universe, missing/invalid authentication fails generation closed instead of exposing either the private index or quarantined legacy state. Configure it on the web service and as API Key/Bearer authentication in the Backstage Booker Custom GPT Action only; do not set it on workers. |
| `ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED` | No; web-service automatic-routing rollout control | `false` | Only the exact value `true` promotes workload-classified heavy Booker generation to the existing durable GPT queue; every absent or malformed value keeps the false synchronous-routing rollback. Explicit async and idempotent job-backed generation remain queued and protected regardless of this flag. Enabled queue/protection failure never falls back to a web-service model call. Lightweight `queryContinuity` remains synchronous. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY` | Yes on web and worker for any job-backed Booker generation | none | Canonical base64 encoding of exactly 32 random bytes. It encrypts private Booker job inputs and terminal outputs with purpose- and identity-bound AES-256-GCM. Keep it distinct from every other purpose-bound credential and out of Builder/client configuration. Rotate in Railway deployment order: both roles K1 current/K2 previous, then worker K2 current/K1 previous, then web K2 current/K1 previous. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY` | No; retained-job rotation overlap only | none | Optional prior canonical 32-byte base64 key accepted only for decryption. New jobs use only the current key. Remove it only after the maximum retained protected-job window drains. |
| `ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` | No; only with one Notion mode | none | Outbound read-content-only Notion credential. Legacy supplemental enrichment uses it on web; authority/RAG synchronization uses it on the worker and removes it from web. It must remain distinct from every ARCANOS application credential and never appears in Builder, inbound headers, source, prompts, chat, or logs. |
| `ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` | No; only with the Notion access token on the web service | none | Closed JSON object mapping each exact Backstage `universeId` to one to three unique raw Notion page UUIDs. The complete value is capped at 16 KiB and 32 universes; URLs, blank/padded IDs, duplicate pages, unsafe object keys, or partial/invalid configuration disable enrichment without failing booking. Treat the mapping as sensitive deployment configuration. |
| `ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` | No; identical value on web and worker for authority mode | none | Closed mapping from each exact universe ID to `{rootPageId,displayName,initialMinimumPageCount?}`. It makes the entire recursively discovered hierarchy authoritative, blocks all six backend mutations, quarantines legacy PostgreSQL reads, and selects one immutable active RAG snapshot. A present malformed value fails mutation checks closed. `initialMinimumPageCount` is 1–512 and applies only before the first activation. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON` | No; identical value on web and worker when validating the partitioned index | none | Additive closed version-1 envelope containing an operator generation and bounded universe/shard definitions. Stable lowercase `shardKey` values are independent of display names. Each shard declares a root UUID that is unique within its universe, a `hot`/`cold`/`archive` retrieval tier, required/optional behavior, sorted scope/category tags, and explicit finite page, chunk, depth, and content limits. Archive-tier shards are structurally optional and must declare `required:false`, preventing one unavailable archive from fencing unrelated current-canon publication. Unknown fields, duplicate universe/shard/tag identities, duplicate roots within one universe, required archives, malformed values, or excessive cardinality invalidate the complete envelope; distinct universe namespaces may reuse the same provider page ID. Its canonical semantic SHA-256 digest is separate from the operator generation. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE` | No; identical value on web and worker | `monolith` | Exact rollout mode: `monolith`, `shadow`, or `partitioned`. Absent, padded, differently cased, or unknown values resolve to `monolith` with non-sensitive validity metadata. Exact `shadow` keeps the monolith as the sole returned read while executing web reads and protected queued relevant worker reads may perform bounded partition comparisons; it is the only mode that admits scheduled, manual, or queued partition synchronization. Exact `partitioned` serves only manifest-scoped partition reads, fails closed without a monolith read fallback, freezes partition writers, and keeps the evidence monitor plus legacy monolith synchronization active. Return to `shadow` to refresh partitions and reseal evidence; restoring exact `monolith` is the read rollback. This flag does not weaken the durable authority latch. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET` | Yes on web for exact `shadow` or `partitioned` mode | none | Current server-only credential used to seal partition complete-scope cursors. Configure an exact 32–4096 UTF-8-byte unpadded, non-placeholder value with no whitespace, distinct from every other purpose-bound credential. New cursors use only this value. Never place it on workers, in Builder/client configuration, requests, logs, or source. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET` | No; web-only cursor rotation overlap | none | Optional prior partition cursor credential accepted only for unsealing. It must satisfy the current-secret rules and differ from the current key and every other purpose-bound credential. Retain it only until cursors pinned to still-fresh manifests have drained; removing it invalidates any remaining cursor sealed by that prior value. |
| `ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS` | No; worker only | `900000` | Full-manifest synchronization cadence, clamped to 60,000–86,400,000 ms. The worker fetches the fixed configured root and descendants, never a caller URL; unchanged manifests only refresh verification time. |
| `ARCANOS_BACKSTAGE_NOTION_RAG_MAX_STALENESS_MS` | No; web only | `86400000` | Maximum age of the last complete snapshot verification, clamped to 300,000–604,800,000 ms. Missing, stale, truncated, wrong-root, or wrong-model snapshots fail authoritative generation closed; they never reopen legacy fallback. |
| `ARCANOS_GAMING_SOURCE_ACCESS_TOKEN` | No; only for Gaming source lifecycle Actions on the web service | none | Dedicated exact 32–4096-character visible-ASCII Bearer credential for only `POST /gpt-access/gaming/sources/ingestions`, `POST /gpt-access/gaming/sources/refreshes`, and `GET /gpt-access/gaming/sources/ingestions/{ingestionId}`. It must contain no whitespace or placeholder form and remain distinct from every other purpose-bound application credential. Configure it on the web service and in the Arcanos Gaming Custom GPT Action only; do not set it on workers. It never authenticates generic GPT Access routes, and the generic GPT Access token is rejected on these source routes. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | Yes for deployed GPT Action import | configured public base URL variables, local request origin, then `http://localhost:3000` | Public HTTPS origin advertised by `/gpt-access/openapi.json`; set this in Railway so public metadata is deterministic and never derived from spoofable request headers. Railway PR previews prefer Railway preview URL variables before inherited production URLs. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Yes for `/gpt-access/jobs/create`, capability discovery, capability runs, and worker recovery | all recognized read/control scopes are granted when unset, except `jobs.create`, `capabilities.read`, `capabilities.run`, and `workers.recover` remain denied unless explicitly listed | Comma-separated generic gateway scope allowlist. The Backstage Booker exact universe and storyline-summary reads and dedicated canon write, plus Gaming source lifecycle Actions, use their own purpose-bound credentials rather than these scopes. `capabilities.read` covers generic capability metadata, not stored Backstage universe content. Include `jobs.create,jobs.result` for protected async Trinity execution; include `workers.recover` only for confirmed worker recovery dispatch; include `capabilities.run` only with a matching `MCP_ALLOW_MODULE_ACTIONS` allowlist and confirmation. |
| `ARCANOS_GPT_ACCESS_PRINCIPAL_ID` | Yes for GPT Access-only tenant-scoped capabilities | none | Server-controlled principal for capabilities such as `ARCANOS:PRODUCTIVITY`; never source it from action payloads. |
| `ARCANOS_GPT_ACCESS_WORKSPACE_ID` | Yes for GPT Access-only tenant-scoped capabilities | none | Server-controlled workspace paired with the configured principal; missing identity fails closed. |
| `ARCANOS_PROCESS_KIND` | Yes for Railway launcher | none | Must be `web` or `worker` when using the normal protected-digest startup wrapper and role launcher; omit for direct local `npm start`. |
| `ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA` | Disposable Backstage durable proof only | none | Exact lowercase 40-hex revision staged on both isolated proof roles. The authorized runner also binds the deploy request and deployed manifests to this SHA. A Railway-provided `RAILWAY_GIT_COMMIT_SHA` is optional but must exactly match when present. Never configure this proof marker on the canonical project or ordinary PR previews. |
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
including configured `ask`, `dag-node`, and GPT retention plus any longer
queue-diagnostics cleanup protection, then remove it after those jobs drain or
expire. Rotating the current key
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
| `JSON_LIMIT` | `10mb` | Broad JSON payload size limit. Route-specific parsers may impose a stricter bound; exact `POST /mcp` never exceeds this value. |
| `PUBLIC_PROVIDER_RATE_LIMIT_MAX` | `100` | Deployment-wide HTTP admissions allowed across all public provider-capable routes during the shared window. Valid range: `1` through `1000000`. Invalid or out-of-range values fall back to `100`; there is no disable value. The legacy hard ceiling of `1` remains valid. |
| `PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX` | `20` | Maximum admissions for one established actor or network cohort in the shared window. It must be at least `1` and is strictly below the global maximum when the global maximum exceeds `1`; both limits are `1` for the compatibility ceiling of `1`. Invalid values fall back to the smaller of `20` and `max(1, global maximum - 1)`. |
| `PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS` | `900000` | Shared caller/global public-provider admission window in milliseconds. Valid range: `1000` through `2592000000` (30 days). Invalid or out-of-range values fall back to 15 minutes. |
| `PUBLIC_PROVIDER_RATE_LIMIT_STORE` | `redis` in production; `memory` otherwise | Production always selects the lifecycle-owned Redis store and never falls back to memory. Development/test may select exact `redis` for integration work; every other value uses memory. |
| `PUBLIC_PROVIDER_RATE_LIMIT_NAMESPACE` | Railway-derived / local environment | Optional stable lowercase namespace matching `^[a-z0-9][a-z0-9_-]{0,63}$`. Railway derives isolation from project, environment, and service IDs. Set this explicitly for a non-Railway production Redis deployment; missing or invalid production isolation fails `/readyz` and provider admission closed. Never use a deployment or commit ID. |
| `PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP` | `false` | Exact `true` opts a Railway deployment into using a validated `X-Real-IP` cohort only when the request also has a valid Railway edge marker and its immediate socket peer is in Railway's documented `100.0.0.0/8` proxy range. Leave false unless public-edge provenance has been verified for the service. |
| `ALLOWED_ORIGINS` | — | Optional comma-separated exact HTTP(S) browser origins. Outside development, missing or blank configuration disables cross-origin access. |

The public-provider limit makes one atomic hierarchical decision: it checks the
caller/cohort ceiling first, then the deployment ceiling, and increments both
only when both admit. At the compatibility ceiling of `1`, an exhausted global
counter takes precedence so the legacy `public-provider-instance` bucket is
preserved. A caller rejected with bucket `public-provider-client` does not
consume deployment capacity; deployment exhaustion retains bucket
`public-provider-instance` for response compatibility. Caller-selected session,
body/query, raw authorization, cookie, and `X-Forwarded-For` values never select
the caller bucket, even if application code enables Express `trust proxy`. A
server-established actor wins when already present. The default anonymous
cohort is the immediate socket peer. Railway may opt into a strictly validated
`X-Real-IP` cohort only for requests carrying a valid edge marker from the
documented proxy peer range; IPv6 callers then share a `/64`. Direct/private
requests and all other runtimes stay on the socket cohort. NAT/proxy users can
therefore share a bucket, and botnets or rotating source networks still require
an authenticated gateway or WAF.

The Redis decision seam has a fixed non-queuing process guard: no more than the
smaller of 16 and the configured deployment maximum may be in flight at once.
Excess bursts receive no-store `429` with bucket
`public-provider-admission-concurrency` and `Retry-After: 2`; they do not query
or spend either Redis counter. A separate per-process token bucket allows a
burst of 100 Redis admission operation starts and refills at 100 starts per
second. Cache misses above that rate
receive no-store `429` with bucket
`public-provider-admission-redis-start-rate`; aggregate capacity therefore
scales with replica count, a process restart restores a full bucket, and very
high shared ceilings can still be locally under-admitted by this protective
bound. A bounded local denial cache short-circuits repeated client or global
denials for at most one second and never beyond the Redis-reported TTL. It
preserves the Redis retry interval, runs only against the current READY
lifecycle generation, and is cleared or bypassed across outages and generation
changes. Cached denials remain conservative and cannot admit work; the
opposite, unqueried counter header is omitted rather than reported as current.

After canonical ingress validation, each provider-capable admission attempt
consumes one unit before downstream route validation or route/user fairness,
while provider-free diagnostics and control lanes consume none. One HTTP
request consumes only one unit even if it crosses the canonical GPT
compatibility seam or the selected pipeline makes several provider calls.
`ASK_ROUTE_MODE=compat` brings `GET /brain`, implicit
`HEAD /brain`, and `POST /brain` under this ceiling; GET uses query input while
POST and HEAD use body input. The default `gone` response is not charged.
Production uses an atomic Redis script and stable environment/service namespace,
so replicas and rolling process restarts share the same expiring window. Redis
unavailability returns no-store `503 REDIS_DEPENDENCY_UNAVAILABLE` before paid
provider work; there is no production memory fallback. Redis flush/replacement
can still reset the window. This is an HTTP-admission guard, not a provider
token, cost, or downstream-SDK-call budget; retain provider-account spend caps.
Coordinate changes to the two maxima and window across web replicas; mixed
rolling revisions can temporarily apply different policy values to the same
shared counters even though every admission remains atomic.

On each Redis ready generation, startup runs one bounded Lua capability probe
against a dedicated hashed, short-lived key. It exercises `EVAL`, `TIME`,
`GET`, `PTTL`, `INCR`, and `PEXPIRE` without touching caller/global counters.
Production web `/readyz` stays unavailable while that probe is pending or
failed; failures retry with bounded background backoff rather than from health
requests. A limiter operation that fails while the same Redis generation remains
READY invalidates this capability latch and schedules a generation-fenced
reprobe, covering live ACL or command-response drift without reconnect churn.
The same failure opens a generation-scoped request-path circuit, so subsequent
admissions fail fast with `503 REDIS_DEPENDENCY_UNAVAILABLE` without spending
the process Redis-start bucket. A matching successful probe clears the circuit;
a newer Redis ready generation is not blocked by an older generation's failure.

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

### GPT-5 and Backstage Booker generation

`TRINITY_REASONING_MODEL` selects only Trinity's schema-constrained Responses reasoning model. Its precedence is `TRINITY_REASONING_MODEL`, `GPT5_MODEL`, `GPT51_MODEL`, then the built-in `gpt-5.6-terra` default. The shared `GPT5_MODEL` selector used by other GPT-5 execution paths retains its existing `GPT5_MODEL`, `GPT51_MODEL`, then GPT-5.1 behavior, so the Terra migration does not silently move unrelated calls that lack an explicit effort. Trinity structured reasoning requests an explicit effort by tier: `simple` uses `none`, `complex` uses `low`, and `critical` uses `medium`. At the provider boundary, `none` is normalized to `minimal` only for exact `gpt-5` and dated GPT-5 snapshots because that model family does not support disabled reasoning; GPT-5.1 and GPT-5.6 retain `none`. `TRINITY_REASONING_MAX_OUTPUT_TOKENS` defaults to `8000`; strict positive base-10 integers are clamped to `16`-`8000`, while invalid or unset values use `8000`. This Responses limit includes both hidden reasoning tokens and visible structured JSON. `TRINITY_REASONING_STAGE_TIMEOUT_MS` defaults to `20000` and is further clamped to the remaining request and runtime budget.

Responses usage is observed before structured parsing, so the session token audit still records billed reasoning tokens when the provider returns incomplete, refused, malformed, or schema-invalid output. Successful pipeline telemetry and the session audit aggregate intake, structured reasoning, and final-stage usage. For response compatibility, `meta.tokens` remains the final user-visible stage's usage rather than the aggregate pipeline total.

Backstage Booker direct answers remain a separate Chat Completions path. The obsolete exact `gpt-5` alias is normalized to `gpt-5.1`; supported GPT-5.1 and GPT-5.6 Sol/Terra/Luna direct-answer requests explicitly disable reasoning so their bounded output budget remains available for visible text.

`BOOKER_TOKEN_LIMIT` defaults to `2400` for ordinary synchronous generation and remains bounded by the standard Backstage `2400`-token cap. Ordinary Trinity callers retain the global `1200`-token cap, while compact direct-answer prompts may use a smaller prompt-derived budget. Explicit full-show, card, or booking-state review/evaluation prompts use a six-bullet synthesis contract and `min(BOOKER_TOKEN_LIMIT, 1600)` so the review can complete before the provider-stage and HRC deadlines. The classifier uses a quote-aware scan of directive-shaped request clauses throughout the prompt; an explicit mixed request to book, rebook, rewrite, draft, or continue vetoes bounded mode and retains the ordinary generation budget. Quoted or attributed dialogue inside supplied show state is inert, while narrow decision analysis or recommendations also stay in ordinary mode. A deployment retaining an explicit historical value such as `512` or `1200` will continue to use that value; remove or update the variable to adopt the `2400` default.

`BOOKER_WORKER_TOKEN_LIMIT` controls only authenticated protected queued production generation. It defaults to `6000`, clamps to `4000`-`8000`, and is further constrained by the finite primary provider-stage budget: less than 45 seconds retains `2400`, 45-60 seconds permits at most `4000`, 60-75 seconds at most `5000`, and 75 seconds or more permits the configured value. The extended policy is available only for the known GPT-5.1 and GPT-5.6 Sol/Terra/Luna request contracts. Unsupported model identifiers fail safely to `2400`. Bounded-review, query-continuity, synchronous rollback, and genuinely small queued compact workloads keep their smaller established budgets. Capacity and presentation are separate: an explicit top-level exact or maximum compact-list shape remains enforced after HRC, Notion authority, prompt size, or retrieved context promotes capacity. Conversely, match or segment counts nested inside a requested complete card, show, or event do not redefine the whole response as that many compact top-level items. The selected cap is passed through the installed SDK as the compatible Responses `max_output_tokens` field, and provider `incomplete`/`max_output_tokens` metadata remains a failure signal rather than successful booking text. Every attempt receives a server-owned instruction to finish all requested sections within the selected finite budget.

Backstage execution uses finite profile-specific timeout plans. `BOOKER_CONTINUITY_STAGE_TIMEOUT_MS` defaults to `20000` and is capped at `25000`, retaining a low-latency synchronous continuity path. Synchronous generation retains `BOOKER_GENERATION_STAGE_TIMEOUT_MS=40000`; although the compatibility parser accepts values through `45000`, the execution plan caps ordinary generation at `40000` to reserve one 10-second recovery and finalization, and caps HRC generation at `30000` to reserve recovery plus its 10-second review stage below the route's 60-second cap.

Protected queued generation is independent of the originating HTTP connection. `BOOKER_WORKER_JOB_TIMEOUT_MS` defaults to `180000` and is clamped to `120000`-`180000`; `BOOKER_WORKER_GENERATION_STAGE_TIMEOUT_MS` defaults to `80000` and is clamped to `45000`-`90000`; `BOOKER_REPAIR_STAGE_TIMEOUT_MS` defaults to `45000` and is clamped to `10000`-`45000`. The planner shortens stages when necessary, reserves 30 seconds for retrieval, dispatch, validation, and HRC-independent orchestration, reserves another 10 seconds for terminal result persistence, and permits no more than one recovery attempt. The absolute operation deadline is anchored to the durable first execution-start timestamp, which survives lease recovery and provider deferral without charging time spent waiting for the first worker claim. The worker revalidates its claim fence immediately after start bookkeeping, then renews active leases at least three times per normalized lease. Protected model and module stages receive cooperative cancellation and a finite two-second drain ceiling inside the finalization reserve, so an abort-ignoring provider cannot keep a job active indefinitely. Per-request OpenAI SDK timeouts enforce the planned provider stage without changing the singleton worker timeout for unrelated ask, DAG, or GPT jobs. These settings do not change other GPT routes.

### Confirmation and automation
| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_GPT_IDS` | empty | GPT IDs eligible for the trusted confirmation path. Membership alone does not bypass confirmation; the request must also present a non-empty `x-arcanos-confirm-token`. For a trusted ID, the current middleware treats that header as a presence marker rather than consuming or validating it against the one-time-token store. This setting is not caller authentication because request metadata can supply the ID; use it only behind middleware that authenticates the caller and binds the permitted identity. |
| `ARCANOS_AUTOMATION_SECRET` | empty | Shared secret for automation bypass. |
| `ARCANOS_AUTOMATION_HEADER` | `x-arcanos-automation` | Header carrying automation secret. |
| `CONFIRMATION_CHALLENGE_TTL_MS` | `120000` (2 minutes) | Lifetime of ordinary in-memory one-use backend confirmation challenges. It must be positive; invalid values fall back to the 2-minute default. This setting still applies to Phase One Backstage mutations, generic GPT Access credentials, and direct/control-plane/legacy aliases. The dedicated Backstage canon Action lane does not issue this second challenge, so changing this TTL is neither required nor recommended for that Builder flow. |
| `ASK_ROUTE_MODE` | `gone` | Legacy ask-style migration switch. Set `compat` only while temporarily supporting old `/brain` callers. |

### HTTP control-plane authentication

Both `POST /api/control-plane` routes, `/api/afol/*`, `/api/assistants/*`,
reinforcement feedback and inspection routes, legacy `POST /status`,
`/api/self-heal/*`, `/api/self-improve/*`, detailed
`GET /status/safety/self-heal`, and integrity quarantine release require a
purpose-bound bearer identity before scope authorization, confirmation,
capability checks, provider probes, or execution. The self-healing surfaces
share an ingress-derived client limiter before the broad JSON parser; decisions,
active provider probes, self-improve control mutations, and quarantine release
also use tighter
authenticated-principal buckets. Legacy `POST /status` and direct
`/system-state` JSON are capped at 64 KiB before the broad parser; self-healing
mutation JSON is capped at 256 KiB. The access token is not interchangeable with
the separate control-plane approval token used by approval-gated protocol
operations.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN` | none | Dedicated bearer credential for HTTP control-plane operations, direct `/system-state`, legacy `POST /status`, `/api/afol/*`, `/api/assistants/*`, `/rag/*`, reinforcement feedback and root-memory inspection, `/api/arcanos/dag/*`, `/api/commands*`, and `/api/agent/execute` access, Backstage state mutations across direct/GPT/dispatch/legacy aliases, protected DevOps/PR diagnostic execution, legacy SDK/orchestration control, `/api/self-heal/*`, `/api/self-improve/*`, detailed `GET /status/safety/self-heal`, and integrity-quarantine release. It must be 32–4096 visible ASCII characters with no whitespace and must not equal another configured purpose-bound credential. Missing or invalid server configuration fails closed at request time; the optional routes return 503 rather than blocking application startup. |
| `ARCANOS_CONTROL_PLANE_PRINCIPAL_ID` | none | Server-bound operator identifier used for control-plane caller and approval attribution. Caller-supplied `context.caller` and `approval.approvedBy` never establish identity. |
| `ARCANOS_CONTROL_PLANE_SCOPES` | empty | Comma-separated server-owned scope grant. Empty grants no operations. Every scope declared by the selected operation must be present. `GET /system-state`, AFOL health/log/analytics reads, assistant-registry list/detail reads, `POST /rag/query`, DAG run reads under `/api/arcanos/dag/*`, `GET`/`HEAD` command registry reads, and root `/memory`, `/memory/digest`, and `/reinforcement/metrics` reads require `arcanos:read`; manual `POST` and status `GET`/`HEAD` under `/api/backstage/notion-partitions/:universeId/syncs`, plus `GET`/`HEAD /api/backstage/notion-partitions/:universeId/diagnostics`, require `backstage:notion-sync`, with enqueue additionally requiring an issued one-use confirmation bound to the exact configured shard and configuration digest; `POST /system-state`, `/api/afol/decide`, `/api/assistants/sync`, `/rag/fetch`, `/rag/save`, and command/agent CEF execution require `mcp:invoke` plus an issued, principal- and request-bound one-use confirmation challenge (manual, allow-all, trusted-mode, one-time-token, and automation bypasses do not apply). Legacy `POST /status` also requires `mcp:invoke` but retains its existing explicit confirmation modes after authentication. Agent execution confirms one frozen plan and derives a single-use CEF permit for each step. Backstage `bookEvent`, `updateRoster`, `trackStoryline`, `saveStoryline`, `upsertStoryline`, and `appendCanonBeat` require `mcp:invoke` plus the existing confirmation contract through direct, canonical GPT, GPT-selected dispatch, and legacy module aliases; direct `/backstage/book-gpt` is included because it saves. Generation and simulation remain public. DAG run creation/cancellation, `/reinforce`, `/audit`, and `/reinforcement/judge` require `mcp:invoke` without this additional CEF challenge. The reinforcement machine-feedback routes do not add a confirmation challenge, while the current legacy `/audit` owner retains its existing confirmation gate. Repository-file inspection under `/api/codebase/*` requires `repo:read`; direct `/api/pr-analysis/analyze` execution requires `repo:verify`; `/devops/self-test` and `/devops/daily-summary` require `diagnostics:execute`; legacy SDK/orchestration reads require `arcanos:read`, while SDK mutations and orchestration reset/purge require `mcp:invoke` plus confirmation; prompt and AI-routing debug reads and direct self-heal/detailed safety reads also require `arcanos:read`; active provider probes add `self-heal:probe`; decisions require `self-heal:decide`; `execute: true` adds `self-heal:execute`; manual self-improve runs require both decision and execution scopes; freeze, unfreeze, autonomy changes, and integrity-quarantine release require `self-improve:control`. |
| `ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN` | none | Separate approval credential for approval-gated `POST /api/control-plane/operations` protocol requests. It is action approval, not HTTP caller authentication. |
| `CODEBASE_ROOT` | auto-detected repository root | Optional root for `/api/codebase/*`. An explicit value must canonicalize to a directory containing `package.json`; invalid configuration fails closed instead of falling back to a broader working directory. |

Direct `/rag/*` limits are fixed security boundaries rather than environment
settings: fetch JSON is capped at 8 KiB, query JSON at 16 KiB, and save JSON at
256 KiB. The corresponding URL, question, content, identifier, source, and
metadata bounds are documented in [API.md](API.md#research-rag-and-command-routing).
These routes expose one operator-controlled deployment corpus; control-plane
identity does not add tenant or workspace isolation.

Backstage mutation admission also uses fixed limits rather than environment
settings. Authenticated operators share one process-local 10-attempts-per-15-minute
principal budget across direct, canonical GPT, GPT-selected `/dispatch`, and
legacy module aliases. Invalid credentials share a separate process-local
120-per-15-minute ingress-address budget. The boundary marks protected responses
`no-store`; confirmation remains a separate approval check.
Async canonical mutations carry this server-generated admission into the job
payload. Worker-side routing must still resolve to the same Backstage action or
the job fails closed; web and worker GPT routing configuration should therefore
remain synchronized.

The separate Backstage Booker Action lane declares the dedicated
`ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` on every Builder operation and accepts
it exclusively for private Notion provenance, the poll-only
`GET /gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result`, and the exact
`GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}` read,
its fixed `/storyline-summary` exact-key read, and the exact
`POST /gpt-access/capabilities/v1/backstage-booker/run` canon write. All three
reads are non-consequential and skip generation and module dispatch. The result
read returns only the owned protected Booker job envelope and exposes no bearer
SSE stream; the domain reads return either a bounded PostgreSQL projection with
explicit truncation metadata or one fixed 4,000-code-point, version-fenced
summary page.
It exposes neither universe listing nor display-name lookup; an empty scope is
reported as `hasPersistedData: false`. The generic GPT Access credential and
its `capabilities.read` scope do not authorize any of these dedicated reads.

The write path allows only `upsertStoryline` and `appendCanonBeat`. On that
purpose-bound lane, the
imported OpenAPI contract marks the write operation consequential and the
backend treats ChatGPT's Allow/Deny banner as the single approval step; it does
not issue an additional time-limited challenge. This fixed lane may bypass the
generic `ARCANOS_GPT_ACCESS_SCOPES` `capabilities.run` grant, but the exact
server-side `MCP_ALLOW_MODULE_ACTIONS` entries still apply. This deliberately
trusts the ChatGPT Action platform to present and enforce that approval before
sending the credentialed request. The credential is shared Action
authentication rather than per-user identity, and `universeId` is data scope
rather than authorization. Therefore the write lane must remain limited to the
version-fenced, mutation-ID-idempotent canon actions. The four Phase One
mutations are unavailable on the dedicated lane; they, calls made with
`ARCANOS_GPT_ACCESS_TOKEN`, and all direct, control-plane, dispatch, and legacy
aliases retain their existing backend confirmation boundary.

Store the dedicated value only in web-service secret configuration and the
Backstage Booker Action's encrypted API Key/Bearer field. Never copy it into
the schema, GPT instructions, chat, source, logs, or a worker service. The
backend resolves it per request and maps valid credentials to one stable
managed principal, so jobs created under `1.6.0` remain owned by that principal
after a future token rotation. There is no previous-token overlap setting. The
upgrade temporarily recognizes the exact current token-derived owner of a
pre-`1.6.0` job, but changing the current token removes that compatibility.
This is result-read ownership fallback only and does not reconcile the legacy
idempotency scope with the stable principal: preserve `jobId`, never resubmit
legacy work as a lookup, and drain both result-retention and idempotency windows
before the first post-upgrade rotation. A rotation still requires coordinated
web-service and Builder updates and can cause a brief authentication gap
between them. Initial `1.5.0` to `1.6.0` cutover also requires a generation
maintenance window: stop all new generation, including explicit async and
idempotent requests; drain legacy jobs and any terminal re-reads that must be
preserved; terminate every old web replica; deploy and verify the backend; and
immediately re-import the live `1.6.0` schema before reopening generation. The
old Builder cannot continue new-backend jobs, and the new Builder cannot poll
an old backend. Revoke the lane by deleting the web-service variable and
redeploying. Do not restore the prior Builder schema or backend until all
stable-principal jobs whose results must remain readable have drained through
retention; otherwise rollback strands those continuations. Generic GPT Access
and control-plane behavior remain available under their own credentials and
confirmation rules.

Authenticated Backstage generation can optionally add a read-only Notion
supplement. Schema `1.6.0` has five Builder operations, materializes the nested
public payload, and uses the managed-bearer namespace for async-result polling.
The tracked `contracts/backstage_booker.openapi.v1.json` is the canonical
Builder `1.6.0` contract and is served directly by the live no-store endpoint.
After a deployed contract change, a human operator must refresh or re-import
that endpoint in GPT Builder; repository changes do not update the Action.
Configure
`ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` and
`ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` together on the web service;
either value alone, invalid configuration, an unmapped universe, or a missing
valid Backstage bearer produces the existing PostgreSQL-only generation path
and no Notion request. The mapping accepts at most 32 exact universe IDs and
one to three unique raw page UUIDs per universe. It never accepts a URL or a
caller-selected destination. The Notion integration should have read-content
access only, and operators must explicitly share only the intended pages.

The backend reads the fixed Notion page-Markdown endpoint with redirects
disabled, a four-second aggregate deadline, a 256 KiB response ceiling per
page, and a 4,000-Unicode-code-point prompt ceiling per page/12,000 total.
Child/unknown blocks are never followed. Provider/configuration errors fail
open to the already-loaded PostgreSQL context; an ambient request abort still
stops generation. The backend sends quoted Notion text in a separately
delimited user message before the primary booking request and adds a
server-owned system policy directing the model to prefer PostgreSQL canon,
roster, events, and saved continuity and to ignore instructions in Notion.
Trinity derives audit/output policy only from the caller directive, not the
Notion text, and the enrichment has no write path to either system. The
role/order boundary reduces prompt-injection risk, but there is no deterministic
semantic conflict or excerpt-disclosure validator on generated model output.
Enriched runs use fixed lineage content markers and skip generic prompt-debug
response and module-session transcript content persistence; metadata and token
counts remain observable. Enriched HRC reviews bypass the shared result cache
and sanitize provider-failure verdicts. Enriched generation also disables
Trinity's optional judged-feedback/self-improvement side effects so the
composite prompt is not stored by those application paths. The selected
excerpts still enter the existing OpenAI model request, so configure only
content approved for that provider data path, possible generated-answer
disclosure, and its applicable
retention controls. Enriched generation and its sensitive HRC follow-up always
send OpenAI Responses with `store: false`,
overriding `OPENAI_STORE` for that request only.

Backstage CLEAR-guided generation needs no environment setting or feature flag.
Every non-literal `generateBooking` attempt, including generation used by
`generateBookingWithHRC`, receives the fixed server-owned draft-review-revise
system policy. It adds no separate generation call, score, threshold gate, or
ActionPlan CLEAR 2.0 guarantee; existing token/timeout budgets, max-output-only
compact retry, response contracts, and persistence boundaries remain unchanged.

#### Notion-authoritative hierarchy and RAG

Authority mode is separate from the optional one-to-three-page supplement.
Configure `ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` with the same exact
closed mapping on web and worker. The web value establishes the read/write and
generation authority boundary; the worker value selects the fixed recursive
sync root. Configure `ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` on the worker only
for an authority-only deployment. Do not also map that universe through
`ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON`.

The monolithic reader and writer ceilings are both fixed at 4,096 chunks. The
writer-to-reader invariant is asserted in executable code. Counts from 1 through
4,096 are eligible for complete candidate construction; 4,097 or more fails
closed at `chunking/chunk_limit_reached` before embedding, candidate persistence,
validation, or activation. Nothing clamps or prioritizes the corpus. This is the
second half of a reader-first compatibility rollout: every serving web and worker
revision must already contain the 4,096-capable reader before a worker with the
raised writer fence is permitted to synchronize. Partition `maxChunks` remains a
separate per-shard bound of at most 2,048.

The immutable active snapshot and the durable latest synchronization attempt are
separate records. Readers combine them into `current_complete`,
`last_known_good`, or `unavailable`. A failed or in-progress newer refresh cannot
clear, invalidate, detach, or rewrite the readable active snapshot. Continuity
reads may use an older readable snapshot only with explicit `last_known_good`
freshness and failed-refresh metadata; they never call it current. Protected
booking generation requires `current_complete` under the existing strict
authority policy and fails closed for `last_known_good`, missing, incompatible,
or expired state.

The additive `ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON` contract does not
replace that monolithic authority mapping. Its version-1 envelope contains an
operator-owned `generation` plus an array of exact universes and their shards.
Shard identity is the `(universeId, shardKey)` pair; renaming `displayName`
therefore does not create a new identity. `shardKey` and scope/category tags are
lowercase bounded identifiers. Root UUIDs are unique within each universe;
distinct universe namespaces may reuse the same provider page ID. Duplicate
universe IDs, same-universe shard keys, roots, or tags are rejected rather than
silently merged. Ancestor/descendant overlap still requires source-hierarchy
ownership validation during synchronization.

The controlled deployment target uses the existing five shards declared by its
closed configuration. The implementation never hard-codes those shard names or
derives the required set from prose: registration, source capture, publication,
routing, diagnostics, validation, and cutover compare the exact configured
membership and count.

Every shard declares `retrievalTier` (`hot`, `cold`, or `archive`), `required`,
and a complete `capacity` object. Archive-tier shards are structurally optional:
they must declare `required:false`, and a required archive invalidates the whole
closed configuration before synchronization or retrieval. This prevents an
unavailable archive from blocking fresh manifests for unrelated current canon.
Capacity permits 1–512 pages, 1–2,048 chunks, depth 0–16, and 1–4,000,000 total
content code points. The parser sorts
universes, shards, and tags before deriving a semantic SHA-256 digest. That
digest intentionally excludes the separately auditable operator generation, so
reordering fields or publishing identical semantics under a new generation does
not fabricate a content change.

`ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE` accepts only exact lowercase
`monolith`, `shadow`, or `partitioned`. Absent and invalid values both select
`monolith`; the parser returns only bounded validity status, never the raw value,
so operators can warn safely. Exact valid `shadow` and `partitioned` policies
admit worker consumers without waiting for the universe-wide monolith format
gate. Protected shard-repair jobs can run only in exact `shadow`; exact
`partitioned` keeps the compatible worker available for legacy synchronization
and partition evidence monitoring without admitting partition writes. Absent,
invalid, or exact `monolith` policy retains the strict legacy readiness gate.
Exact `shadow` performs bounded dual reads for executing
web requests and protected queued relevant worker requests, but the monolith
remains the sole result returned to the caller and still fails closed under its
existing read rules. The worker does not receive cursor credentials, so
complete-scope and cursor flows remain web-only. Exact `shadow` is the only mode
that admits scheduled cycles, manual enqueue, or claimed queued partition jobs.
Exact `partitioned` freezes those writers and serves only manifest-scoped
partition reads; its scheduled loop refreshes cutover evidence and telemetry
without invoking the partition synchronizer. Missing or invalid partition state
fails closed without a silent monolith read fallback. A partition content refresh
requires returning the compatible web/worker pair to exact `shadow`, reconciling
and draining it, and sealing new evidence before another controlled cutover.
Restoring exact `monolith` is the read rollback and also stops partition writer
cycles without deleting immutable shard or manifest history. The legacy
recurring synchronization path remains intact under all three modes. Partition
writer cycles start only after consumer readiness and share the process-local
coordinator with that legacy loop. No partition manifest or shard state gates
worker `/readyz`. Neither the partition
envelope nor this read-index mode downgrades the durable one-way Notion authority
latch or restores legacy reads and writes. This code change does not set or
change a deployed value. Code readiness and a positive gate decision are not
authorization to change production mode; any later transition to exact
`partitioned` remains a separate controlled cutover.

In exact `shadow`, the web control plane exposes one-shard manual enqueue under
`/api/backstage/notion-partitions/:universeId/syncs`. Actor-scoped status reads
for existing jobs remain available in exact `shadow` or `partitioned` under the
sync resource. The bodyless, query-free bounded diagnostics read is also
available in either mode at
`/api/backstage/notion-partitions/:universeId/diagnostics`. The server resolves
the closed configuration and never accepts or returns roots or raw
configuration. All three operations require `backstage:notion-sync`; enqueue
also requires one strict body, an idempotency key, and a consumed one-use
challenge bound to the exact configuration generation and semantic digest.
Claimed workers revalidate those fields before provider or synchronization
effects, so a deployment configuration change safely stales queued work.
The diagnostics route reads one repeatable, read-only database snapshot and
returns only closed metadata. Its 128-shard and 16-active-job bounds use one
internal overflow probe and fail closed rather than returning partial rows.
Before the first partition registration, operational aggregates are explicitly
unavailable; use the actor-scoped sync-status route for exact queued-job state.

In exact `shadow`, the legacy and partition loops share one worker-process
synchronization coordinator, so their full crawls cannot overlap inside one
replica. The first partition cycle waits one configured interval; each later
interval begins only after the preceding partition cycle reaches terminal
cleanup. The coordinator
does not create a cross-replica lease for the legacy crawler, so operators must
retain the normal single active Railway worker during partition validation. Notion
does not expose an authoritative hierarchy delta feed: every shard still runs a
bounded full hierarchy/content capture and metadata verification pass. Reuse is
incremental only after capture, where unchanged immutable page, chunk, and
embedding material is retained rather than regenerated.

One immutable source-generation record binds the full verified authority capture
to its source digest, page/chunk coverage, verification time, and configuration.
Every configured shard candidate for a manifest must reference that same source
generation. A missing shard, failed shard, mixed source digest/generation,
coverage mismatch, unsupported index or embedding contract, or lost lease blocks
publication. The worker seals all required shards and the complete manifest
before one compare-and-swap transaction advances the active manifest pointer;
no shard can become independently authoritative. A failed build leaves the prior
complete manifest active. Rollback atomically reactivates a prior complete
manifest instead of reconstructing a shard collection.

Each configuration registration advances a reconciliation epoch before shard
work begins. Manifest activation publishes only the exact epoch it reconciled;
rollback advances and republishes a new epoch. Cutover evidence is valid only
while its epoch equals both the active and published reconciliation epochs, so a
new, failed, or incomplete refresh invalidates older evidence without disturbing
the last complete active manifest.

After each partition reconciliation, the worker runs one statement-pinned,
identity-only PostgreSQL comparison per universe. It projects generation IDs,
aggregate page/chunk counts, intersection counts, and constant-size ordered page
ID samples; it never loads legacy snapshot Markdown, chunk content, metadata, or
embeddings. Ordinary logs retain only semantic configuration digests and
aggregate counts, never generation IDs, page IDs, titles, paths, content,
provider errors, configuration JSON, or embeddings. Writer failures retain the
last immutable successful shard and manifest history. In exact `shadow` they
remain nonfatal to the returned monolith read; exact `partitioned` retrieval
independently fails closed when it cannot resolve a valid selected manifest.

The controlled-cutover resolver
pins the durable Notion authority head, one sealed active universe manifest,
and that manifest's exact immutable shard snapshots in one bounded PostgreSQL
statement. Routing uses the definitions attached to that manifest even when a
new desired configuration is waiting for synchronization; mutable shard heads
are never consulted by reads. Exact lowercase scope/category selectors use
AND semantics within one selector and OR semantics across selectors. Archive
tiers require an explicit server-derived opt-in, and `required` controls
manifest publication rather than forcing every shard into every request.

Only the selected manifest members participate in the web freshness fence. A
stale or omitted unselected archive therefore cannot disable an unrelated hot
read, while selecting a stale member fails that request closed. Exact page and
subtree ownership is resolved inside the active manifest with normalized
SHA-256 title/path keys, an exact shard-relative suffix match, and a two-row
ambiguity cap. The routing projection is limited to 128 identity/contract rows
plus one overflow sentinel and contains no Markdown, chunk content, page
versions, or embeddings. The exact read mode remains the authorization point:
`shadow` compares this result without returning it, while `partitioned` returns
it without a monolith fallback.

The cutover gate consumes durable, content-free evidence sealed against that
exact configuration, source generation/digest, manifest, reconciliation epoch,
supported embedding model and index format, and a fresh readable rollback
monolith whose latest synchronization state is `current_complete`. Validation
must include representative relevant queries, exact-scope parity,
complete-scope coverage parity through the final cursor, cursor-version
stability, and accepted bounded relevant-retrieval parity. Missing, expired, or
mismatched evidence keeps `cutoverAvailable` false, keeps partitioned reads
disabled, and leaves the effective authority on the monolith. The sealed rollback
verification time remains the immutable validation anchor. A later verification
of the same rollback snapshot is accepted only when its time advances
monotonically, is not in the future, and remains within the original freshness,
evidence-expiry, and rollback-validity windows; it never extends those windows.
A new rollback snapshot, timestamp regression, failed/latest non-complete sync,
or stale verification closes the gate. Evidence sealing is an explicit
validation action; startup and synchronization do not manufacture or
auto-promote it.

Run the explicit operator validator only after the reviewed migrations are
already applied, exact `shadow` reconciliation is complete, partition admission
is frozen, the compatible worker is drained, and diagnostics report no active
leases or queued/running jobs:

```bash
npm run backstage:notion:partition:cutover:validate -- --cases-file <path> --seal-current
```

The regular cases file is limited to 256 KiB and must contain exactly `version`,
`universeId`, `configurationGeneration`, `configurationSemanticDigest`, and
`cases`. Representative relevant cases must be unscoped; exact- and
complete-scope cases must carry their canonical scope. Keep the file private
because its queries are validation material. The command builds first, rejects a
non-`shadow` mode or stale environment generation/digest before database or
OpenAI work, binds those exact values again to the initial/terminal durable
anchor and final seal transaction, validates and seals one current universe
evidence set, emits a bounded aggregate result, and always attempts to close its
database pool. Run it separately for every
configured universe and require every result to succeed before cutover; one
successful universe does not satisfy the others. Build output precedes the
bounded validator result. A nonzero result with `evidenceSealed:true` means the
seal committed but report normalization or database cleanup failed; do not treat
that outcome as effect-free or rerun blindly. Resolve the named bounded failure
and re-inspect the durable gate. The command does not apply migrations, change
the rollout mode, or authorize a deployment.

Unscoped relevant retrieval uses a closed server-owned routing vocabulary.
Recognized lane tags are `brand:raw`, `brand:smackdown`, `brand:nxt`, and
`lane:ples`, plus four-digit `year:YYYY` tags derived from the bounded query.
The PLE lane is selected only by `PLE`, `premium live event`, `pay-per-view`/`PPV`,
or the closed built-in set of named premium live events; a display name never
acts as a routing signal. When a request names a lane or year, a shared-current
shard participates only when its definition contains the exact scope tag
`shared`; its shard key or display name never grants shared ownership implicitly.
More than eight distinct years or more than 32 derived selectors fails closed.
Without the exact words `archive`, `archives`, or `archived`, routing admits only
`hot` and `cold` tiers and excludes archive shards. With one of those exact
signals, routing admits only `archive`; it never silently mixes archive and
current-canon tiers. An omitted unrelated optional archive shard therefore does
not disable a narrowed current-canon read, while an omitted shard selected by
the request still makes that routing result incomplete and unavailable.

Partition complete-scope cursors are server-sealed with
`ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET`. Exact `shadow` and
`partitioned` web reads require that current, purpose-isolated credential.
Rotation across rolling or multi-replica web deployments requires two acceptance
phases. First deploy K1 as current and K2 in
`ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET` to every replica,
then drain every K1-only replica. Next deploy K2 as current and K1 in the
previous slot to every replica. Both phases accept cursors sealed by either key,
while new cursors always use that phase's current value. Remove K1 only after
its still-fresh cursors and the rollback window have drained. Both values are
exact 32–4096 UTF-8-byte unpadded,
non-placeholder credentials with no whitespace and must differ from every other
registered purpose. Removing the previous value rejects any remaining cursor it
sealed. Monolith and partition cursor formats are intentionally incompatible;
after changing between `monolith`/`shadow` and `partitioned`, restart any
complete-scope pagination from its first page.

Every partition request resolves one manifest before routing. A continuation
cursor carries and must match that exact immutable manifest version for every
page; activation or rollback cannot make it continue against another generation.
Cross-manifest continuation fails closed, while a request already pinned to its
original still-readable manifest may finish without duplicate or omitted chunks.

The worker recursively discovers direct child `<page>` links, fetches every
page separately from fixed `api.notion.com` endpoints, verifies parent IDs and
last-edited timestamps twice, sanitizes only after child discovery, chunks
Unicode text and Markdown tables, and embeds bounded chunks. A candidate with
an inaccessible child, malformed child link, provider truncation, unknown
block, database, or unsupported media/file block is incomplete and is never
activated. A configured tree containing only supported text and Markdown tables
is covered by this extractor. Attachments require an explicit bounded extractor
before a complete replacement snapshot can activate.

Complete pages and chunks are written to immutable, universe-scoped snapshot
tables. One transaction rechecks the sync lease, drains legacy writes, inserts
the full snapshot, and flips the active head; readers therefore never combine
two Notion revisions. A no-change crawl refreshes `last_verified_at` without
creating duplicate snapshots. V1 retains prior successful snapshots and has no
automatic purge. Embedding calls send chunk text to the configured embedding
provider; retrieved generation sends only selected excerpts and forces
provider `store: false` plus existing transcript/debug/cache suppression.
Readers require the current heading-aware index format. A legacy snapshot with
no compatible heading index fails closed until the worker completes and
activates a full rebuild; it is never served with fabricated empty headings.
Each snapshot page records both the index format and heading-index version so
worker startup can prove the entire active inventory is current without calling
Notion on later deployments. If any configured inventory is absent or old, the
worker runs one synchronous sync before readiness, accepts only
`activated`/`unchanged`, reloads PostgreSQL, and requires every marker. Invalid
configuration, a busy lease, a failed/omitted result, or an old reload keeps the
worker unready. With no authority mapping, startup retains the ordinary no-op
path.

The first activation is also a durable one-way authority latch. Removing the
environment mapping later stops that configured worker root but does not make
legacy PostgreSQL authoritative again; the stored head continues to quarantine
legacy reads and writes. A configured root that disagrees with the stored root
is rejected before any Notion fetch, and the database permits later snapshot
rotation only inside the original root hierarchy. An authority-state lookup
that cannot be resolved safely returns retryable
`BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE`. Restoring PostgreSQL authority is a
separate reviewed recovery operation, never an environment-variable rollback.

Once configured, all six legacy Backstage mutations return nonretryable
`409 BACKSTAGE_NOTION_AUTHORITY_READ_ONLY`, and the two PostgreSQL read Actions
return `409 BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED`. `queryContinuity` and
normal generation require the saved Backstage bearer and one fresh, complete
active snapshot; any missing/stale/index/provider condition returns
`BACKSTAGE_NOTION_INDEX_UNAVAILABLE` and never falls back to PostgreSQL or
process memory. Match simulation may use an explicitly supplied numeric roster
but will not infer ratings from prose or read the quarantined roster.

`queryContinuity` always requires the exact `universeId` and a nonblank query.
Its optional scope requires `pageTitle`; use optional `pagePath` to disambiguate
duplicate titles. `scopeKind` defaults to `"page"`, which may use
`sectionPath` for one exact heading subtree. Explicit `scopeKind: "subtree"`
includes the exact parent plus every descendant page and no siblings, supports
a blank navigation parent, and rejects `sectionPath`. The default `relevant`
mode returns a bounded sample and diversifies subtree results across pages.
`complete_scope` pages through the deterministic resolved scope with an opaque
cursor bound to the exact snapshot, query, scope kind, and mode and protected
against tampering. Invalid, stale, or differently bound cursors return
nonretryable `409 BACKSTAGE_NOTION_CURSOR_INVALID`; callers restart without a
cursor. Version-2 cursors are invalid after the 1.4.0 rollout and also require a
cursor-free restart. The action runs synchronously in its request and never
uses the worker queue.

Coverage always reports sampled versus complete status, selected and omitted
chunk counts, prompt truncation, exhaustiveness, and whether another cursor
exists. Only a subtree response additionally sets
`resolvedScope.scopeKind: "subtree"` and reports `scopePages`, `selectedPages`,
and `omittedPages`; other scope kinds omit those fields. Public sources contain
only sanitized path/category metadata and opaque hashes, never source excerpts
or raw Notion page IDs. Use the generation maintenance and legacy-continuation
drain described above before deploying and re-importing schema 1.6.0 into the
existing Builder Action. Continuity and booking answer generation make at most
one bounded output-length recovery attempt only for provider max-output
exhaustion when finite recovery budget remains available, reuse the same
retrieval and budget, do not retry other provider failures, and return a
sanitized incomplete-output error after a second length exhaustion or an
enforceable exact/maximum compact-contract violation. Compact recovery retains
the numbered item contract; structured complete-container recovery retains
component hierarchy.

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

### Protected configuration digests

Six `SAFETY_EXPECTED_HASH_*` variables are optional immutable runtime-owned
deployment pins over canonical semantic JSON. The seventh manifest entry,
`SAFETY_EXPECTED_HASH_PROTECTED_JSON`, is reserved for explicit tooling and has
no maintained runtime caller. These are not raw file SHA-256 values:
formatting and ordinary object-key insertion order do not change the digest,
while array order and semantic values do. The established v1 serializer sorts
keys with JavaScript `localeCompare` and does not Unicode-normalize them, so
canonically equivalent key spellings are not interchangeable. Runtime
enforcement and the operator command share the versioned
`arcanos-semantic-json-v1` serializer and SHA-256 implementation.
`DISPATCH_BINDINGS_VERSION` is a separate bindings-only protocol version and
must not be used as the protected dispatch digest.

The operator-facing npm command first runs the repository build so stale
compiled code cannot attest a newer checkout. That build writes ordinary
compiled/package artifacts; the subsequent digest evaluation is read-only and
never writes candidates, pins, trust state, or provider state:

```bash
# Generate one candidate digest.
npm run integrity:protected-digest -- --id dispatch_patterns

# Compare one candidate with an explicit digest or its ambient pin.
npm run integrity:protected-digest -- \
  --id prompts_config \
  --check \
  --expected-hash <lowercase-64-character-sha256>

# Required immediately before cutover when any runtime-owned pin is set.
npm run integrity:protected-digest:check
```

Those self-building commands are for source workspaces. In an identified,
already-built runtime image, use
`npm run integrity:protected-digest:check:compiled` to compare that deployed
artifact without attempting another build. Do not use the compiled-only entry
in a source workspace unless the artifact's exact build identity has already
been established.

For individual candidate generation or comparison, `--source <path>` can select
an offline file. Complete `--check-pinned` comparisons reject source overrides
for runtime-owned entries: they derive the same search path or path variable as
the runtime so copied known-good bytes cannot attest a different live file.
Only the tooling-only `protected_json_file` accepts
`--source protected_json_file=<path>` in complete manual comparisons.
Because that reserved entry has no runtime-owned source or maintained caller,
the automatic `--precutover` startup gate deliberately excludes it. A generic
pin must be checked manually with `--check-pinned` and its explicit source; it
does not become runtime-enforced merely by being set.

`--check-pinned` derives the pin inventory from the runtime integrity manifest,
evaluates every pin explicitly present in the effective environment, and emits
one complete deterministic JSON report. It exits nonzero for no explicit pins,
an invalid pin, a missing/unsupported/changing candidate, unsafe or oversized
file input, invalid JSON/schema, or any mismatch. A successful pre-cutover gate
has exit code zero and `preCutoverComplete: true`; unpinned manifest entries
remain explicit in the report. Do not treat a sparse hand-written pin list as
the live environment. Manual generation/comparison reports include digest
values for operator use. Automatic `--precutover` reports retain only each
entry's identifier, status, fixed error code, and aggregate counts so service
startup logs do not publish verifier fingerprints.

Run the gate against the exact candidate revision, environment variables, and
mounted files immediately before cutover. Ordinary CI can prove tooling and
tracked-candidate behavior, but it cannot attest provider-owned variables or
volume contents. File-backed candidates use bounded, schema-validated reads
that reject symlinks and detect source replacement; their paths/content are
never included in output. The command does not write candidates, pins,
process-owned trusted hashes,
quarantine/audit state, provider state, databases, or network resources.

Normal Railway web and worker startup uses
`scripts/start-railway-service-with-integrity.mjs`. After Railway mounts the
runtime filesystem, that wrapper runs the already-built protected-digest
command directly in `--precutover` mode before the canonical role launcher. It
skips candidate reads only when no runtime-owned pin is configured; any invalid,
missing, or mismatched runtime-owned pinned candidate prevents startup. The
tooling-only generic pin is outside this automatic gate. Native PR previews use
the same wrapper and then forward the exact `--pr-preview-app-safe-v1` argument
to the sealed role launcher. The digest gate runs read-only in the parent
service environment before that launcher validates preview identity and creates
the credential-empty contained child. Railway pre-deploy commands are not a
substitute because Railway does not mount service volumes in the pre-deploy
container.

| Protected ID | Pin | Candidate used by the command |
| --- | --- | --- |
| `dispatch_patterns` | `SAFETY_EXPECTED_HASH_DISPATCH_PATTERNS` | The complete code-owned bindings plus exempt routes; `--source` is rejected. |
| `prompts_config` | `SAFETY_EXPECTED_HASH_PROMPTS` | The first runtime search-path candidate, beginning with `config/prompts.json`; complete comparisons reject source substitution. |
| `fallback_messages` | `SAFETY_EXPECTED_HASH_FALLBACK_MESSAGES` | The first runtime search-path candidate, beginning with `config/fallbackMessages.json`; complete comparisons reject source substitution. |
| `gpt_router_config` | `SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG` | The declared immutable catalog projection plus effective `GPT_MODULE_MAP` and legacy `GPTID_*` values; `--source` is rejected. When this pin is set, runtime also requires the complete public catalog to register before returning a routing map. Protected-module and broader readiness checks remain independent availability evidence. |
| `assistant_registry` | `SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY` | `ASSISTANT_REGISTRY_PATH`, then `config/assistants.json`, using the exact runtime path and shared runtime validator. |
| `daemon_tokens` | `SAFETY_EXPECTED_HASH_DAEMON_TOKENS` | `DAEMON_TOKENS_FILE`, then `memory/daemon_tokens.json`, preserving the runtime's exact nonblank path value. |
| `protected_json_file` | `SAFETY_EXPECTED_HASH_PROTECTED_JSON` | An explicit source is required. No maintained production caller or canonical source currently exists, so tooling support alone does not make this pin live. |

This gate does not change the separate runtime lifecycle: all current manifest
entries still permit trust on first load when no immutable pin is set, and
daemon-token persistence does not perform pin-aware rotation. Do not describe
the command as closing either residual.

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

The background coordinator evaluates prediction on every tick. When
`PREDICTIVE_HEALING_ENABLED=true`, the predictive disposition owns that tick:
recommendation-only, dry-run, refused, unsupported, cooldown, failed, and
fallback outcomes do not authorize a different reactive action or the
automatic self-improvement controller. A confirmed predictive execution is
not dispatched again. Enabled predictive-call rejection and uncertain
execution also fail closed. When prediction is explicitly disabled, a passive
`recommend_only` result or rejected advisory call cannot have entered automatic
execution, so the legacy reactive action and automatic controller retain their
existing gates. A due successful verification rollback owns and ends its loop
tick before predictive execution is requested; prediction resumes on a later
tick, so rollback and predictive actuation cannot overlap or hide one another.
`SELF_HEAL_DEBUG_FORCE_AI_HEAL_ONCE`
is a development/test-only one-shot validation override; production ignores
it, and it cannot retry a predictive execution whose effect phase may have
started.

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
| `ARCANOS_PROCESS_KIND=web` | Railway web service | Runs the protected-digest startup wrapper, then starts the compiled API runtime with `RUN_WORKERS=false` through the role launcher. |
| `ARCANOS_PROCESS_KIND=worker` | Railway worker service | Runs the protected-digest startup wrapper, then starts `dist/workers/jobRunner.js` and exposes a minimal health server on `/health`, `/healthz`, and `/readyz`. |

If `ARCANOS_PROCESS_KIND` is missing or not `web`/`worker`, the Railway launcher exits with a fatal startup error by design.

The tracked Railway deployment gate is `/readyz` for both roles. When
`NODE_ENV=production` and `ARCANOS_PROCESS_KIND=web`, web readiness requires
configured and connected PostgreSQL and Redis dependencies plus completed
startup; PostgreSQL schema initialization and the generation-matched Redis
public-provider capability probe must also be complete. Database
configuration may use `DATABASE_URL` or the complete
`PGUSER`/`PGPASSWORD`/`PGHOST`/`PGPORT`/`PGDATABASE` set; Redis may use
`REDIS_URL`, `REDISHOST`, or `REDIS_HOST`. Missing configuration returns
`503` without changing `/healthz` liveness or `/health` diagnostics. Worker
readiness remains `503` until database bootstrap, autonomy/module-registry
bootstrap, every configured consumer slot's dispatcher-start write, and a
supported OpenAI key setting are present. Absent, invalid, or exact `monolith`
partition policy additionally retains the Backstage Notion format-readiness
gate. No configured authority passes that gate without repository or provider
work: configured authorities must all have active snapshots with the current
page-level index/heading marker; already-current inventories use PostgreSQL
only, while an old/missing inventory gets one synchronous sync and a mandatory
reload. Invalid configuration, `lease-busy`/`failed`/omitted sync results, or a
still-old reload prevents readiness in that policy. Exact valid `shadow` and
`partitioned` skip only this universe-wide legacy gate so protected shard jobs
can repair partition state; neither partition manifests nor shard freshness gate
`/readyz`, and legacy reads retain their existing fail-closed rules. Provider
readiness itself remains configuration-only rather than a paid probe, although a
required monolith format rebuild performs the real Notion and embedding work.
Later provider outages are handled by the worker's bounded probe/backoff and
job-deferral path. The worker child reports the final transition through an
exact, newline-delimited launcher protocol independent of `LOG_LEVEL`;
arbitrary log text and filtered info logs cannot satisfy or suppress it.

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
| `ARCANOS_GPT_ACCESS_TOKEN` | Yes for generic protected `/gpt-access/*` operations | none | Generic gateway bearer token. The gateway returns an auth/config error when this is missing. `GET /gpt-access/openapi.json` remains public. It remains accepted on the Backstage canon route under the existing `capabilities.run` scope and backend-confirmation policy, but must not be configured in the dedicated Backstage Booker Custom GPT. It cannot authorize the exact Backstage universe or storyline-summary reads and is not accepted by Gaming source lifecycle routes. |
| `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` | No; protected Backstage Booker Custom GPT operations and authenticated private context on web | none | Dedicated purpose-bound Bearer credential for the protected lane, including managed queued-result polling, and Notion-derived continuity queries/generation. It authenticates one shared stable managed principal across future token rotations; the transitional legacy-owner fallback applies only to the exact current token. Legacy supplement remains optional; mapped authority queries and generation require it and fail closed when absent. Configure only on web and in the existing GPT Action. |
| `ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED` | No; web automatic-routing rollout control | `false` | Exact `true` promotes workload-classified heavy Booker generation through the existing durable GPT queue; absent or malformed values resolve to false. Explicit async and idempotent generation remain protected queue jobs under either setting. Queue or payload-protection failure fails closed instead of calling the provider in web. Set exact `false` to restore the prior automatic-routing policy. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY` | Yes on web and worker for any job-backed Booker generation | none | Canonical base64 encoding of exactly 32 random bytes used to seal private queue input and terminal output. Keep it distinct from every other purpose-bound credential. Rotate with both roles K1/K2, then worker K2/K1, then web K2/K1. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY` | No; rotation overlap only | none | Optional prior 32-byte base64 key accepted only for decryption while retained protected jobs drain. New jobs always use the current key. |
| `ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` | No; one Notion mode | none | Outbound read-content token: web for synchronous legacy supplement; worker for authority sync and queued legacy supplement generation. Never place it in Builder or reuse an application credential. |
| `ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` | No; optional authenticated Backstage generation on each executing service | none | Sensitive exact-universe-to-page-UUID mapping. Configure the identical value on worker before queued legacy supplement generation is enabled. One to three unique raw page UUIDs per universe; URLs and partial/invalid configuration are rejected before provider work. |
| `ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` | No; identical on web and worker | none | Exact universe-to-root authority mapping. Blocks/quarantines legacy state and selects recursive immutable RAG snapshots. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON` | No; identical on web and worker for partition shadow/cutover | none | Closed bounded version-1 universe/shard envelope with stable shard keys, retrieval tiers, required policy, scope/category tags, per-shard capacity, operator generation, and a separate canonical semantic digest. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE` | No; identical on web and worker | `monolith` | Exact `monolith`, `shadow`, or `partitioned`; absent or invalid values remain monolithic. `shadow` synchronizes shards and compares bounded partition reads while returning only the monolith result. `partitioned` freezes partition writers, monitors evidence, and serves only manifest-scoped partition reads, with no monolith read fallback; legacy monolith synchronization remains active. Return to exact `shadow` for a partition refresh and reseal before another cutover. Restore exact `monolith` for read rollback. No deployed value is changed by this release. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET` | Yes on web for exact `shadow` or `partitioned` | none | Current server-only, purpose-isolated 32–4096 UTF-8-byte unpadded/non-placeholder credential for sealing partition complete-scope cursors. New cursors use only this value. Never configure it on workers or clients. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET` | No; web-only rotation overlap | none | Optional distinct prior cursor credential accepted only for unsealing while cursors pinned to still-fresh manifests drain. Removing it rejects remaining old cursors. |
| `ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS` | No; worker only | `900000` | Bounded full-hierarchy sync cadence. |
| `ARCANOS_BACKSTAGE_NOTION_RAG_MAX_STALENESS_MS` | No; web only | `86400000` | Bounded maximum age of a successful complete-snapshot verification. |
| `ARCANOS_GAMING_SOURCE_ACCESS_TOKEN` | No; web service source lifecycle only | none | Dedicated purpose-bound Bearer credential for exactly the three `/gpt-access/gaming/sources/*` lifecycle routes. It must be 32–4096 visible ASCII characters with no whitespace or placeholder form, and distinct from every other application credential. Configure it only on the web service and in the Arcanos Gaming Custom GPT Action. Generic GPT Access routes reject it. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | Yes for deployed GPT Action import | first valid configured public URL/domain, local request origin, then `http://localhost:3000` | Public origin for GPT Action OpenAPI metadata. Supported configured fallbacks include `ARCANOS_BASE_URL`, `ARCANOS_BACKEND_URL`, `SERVER_URL`, `BACKEND_URL`, `PUBLIC_BASE_URL`, `RAILWAY_PUBLIC_URL`, `RAILWAY_PUBLIC_DOMAIN`, and `RAILWAY_STATIC_URL`. Non-local request hosts are ignored. Railway PR previews advertise `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_PUBLIC_URL`, or `RAILWAY_STATIC_URL` before inherited production URLs. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Yes for job creation, capability discovery, capability runs, and worker recovery | all recognized scopes are granted when unset, except `jobs.create`, `capabilities.read`, `capabilities.run`, and `workers.recover` remain denied unless explicitly listed | Generic gateway scope allowlist. The dedicated Backstage protected and Gaming source lifecycle credentials do not use these scopes. `capabilities.read` authorizes capability metadata, not stored Backstage universe content. A generic token can still reach the Backstage canon route only with `capabilities.run`, `MCP_ALLOW_MODULE_ACTIONS`, and backend confirmation. Use `runtime.read,workers.read,queue.read,jobs.create,jobs.result,diagnostics.read` for the protected async Trinity flow; add `workers.recover` only for confirmed worker recovery dispatch; add `capabilities.read` for discovery. |
| `OPENAI_API_KEY` | Yes for live worker execution | none | Preferred OpenAI key setting. The config layer also supports the fallback key names listed above. |
| `DATABASE_URL` or complete `PG*` set | Yes for durable async jobs | none | Required by `/gpt-access/jobs/create` persistence and by the worker queue. Web and worker services must share the same database. |
| `JOB_WORKER_ID` | No | `async-queue` | Base worker identity for queue claims, logs, and heartbeat state. Every derived `-slot-N` lease/operational identity must fit the 255-character PostgreSQL/protocol limit; overlong or control-character values fail startup rather than truncating. |
| `JOB_WORKER_STATS_ID` | No | `JOB_WORKER_ID` | Exact worker-group identity shared by inspection, alert cooldowns, and hourly job/AI-call budgets. Every generic queue claim persists this value separately from its slot lease ID. Values longer than 255 characters or containing control characters fail worker startup before readiness. |
| `JOB_WORKER_CONCURRENCY` | No | `WORKER_COUNT` or `1` | Number of queue-consumer slots in one worker process. |
| `JOB_WORKER_MAX_JOBS_PER_HOUR` | No | `120` | Hard maximum generic queue claims admitted for one `JOB_WORKER_STATS_ID` in the shared PostgreSQL rolling window. The decision, reservation, and claim are one transaction. Must be an integer from 1 through 2,147,483,647; zero, malformed, or out-of-range values fail worker startup. |
| `JOB_WORKER_MAX_AI_CALLS_PER_HOUR` | No | `120` | Hard maximum database-admitted worker OpenAI capacity reservations for one `JOB_WORKER_STATS_ID` in the shared PostgreSQL rolling window. Every SDK or higher-level retry and every multi-stage native transport requires a reservation; one batched embedding request requires one. A reservation committed before a later cancellation remains charged even if no network request starts. Must be an integer from 1 through 2,147,483,647. |
| `JOB_WORKER_MAX_RSS_MB` | No | `2048` | Hard per-process resident-memory claim ceiling in MiB. The worker pauses at or above the limit and resumes only after RSS falls below it. Must be a positive safe integer. |
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
| `JOB_WORKER_ID` | `async-queue` | Base worker identity used in logs, heartbeats, and queue claiming. Every derived `-slot-N` identity must fit the exact 255-character persisted/readiness limit; overlong or control-character values fail startup. |
| `JOB_WORKER_STATS_ID` | `JOB_WORKER_ID` | Exact worker-group identity persisted on every generic claim and used for shared slot-level inspection and hourly budget accounting. Groups may span processes only when they use the same configured value. Values longer than 255 characters or containing control characters fail worker startup before readiness. |
| `JOB_WORKER_CONCURRENCY` | `WORKER_COUNT` or `1` | Number of queue-consumer slots in one worker process. |
| `JOB_WORKER_MAX_JOBS_PER_HOUR` | `120` | Hard shared rolling-hour claim maximum. Admission and claim are atomically serialized in PostgreSQL across slots and replicas sharing `JOB_WORKER_STATS_ID`. |
| `JOB_WORKER_MAX_AI_CALLS_PER_HOUR` | `120` | Hard shared rolling-hour worker OpenAI admission maximum. Every native transport requires one committed reservation. Provider failures and cancellations after commit remain charged, so the ledger can conservatively exceed transports that actually started; denied, reservation-store-failed, replayed, and already-aborted-before-admission requests consume no new reservation. |
| `JOB_WORKER_MAX_RSS_MB` | `2048` | Hard per-process RSS claim ceiling in MiB. Claiming pauses at equality and resumes after RSS drops below the ceiling. |
| `JOB_WORKER_POLL_MS` | `250` | Poll delay after a claimed job cycle. |
| `JOB_WORKER_IDLE_BACKOFF_MS` | `1000` | Sleep interval when no job is available. |
| `JOB_WORKER_LEASE_MS` | `15000` | Claimed-job lease duration, clamped to `3000`-`300000` ms. Active execution and terminal persistence renew at one-third of the normalized lease, bounded to `1000`-`10000` ms. |
| `JOB_WORKER_DB_BOOTSTRAP_RETRY_MS` | `5000` | Initial retry delay while waiting for database connectivity. |
| `JOB_WORKER_DB_BOOTSTRAP_MAX_RETRY_MS` | `30000` | Max DB bootstrap retry delay. |
| `JOB_WORKER_DB_BOOTSTRAP_MAX_ATTEMPTS` | `0` | `0` means retry indefinitely. |
| `JOB_WORKER_RECOVERY_BATCH_SIZE` | `100` | Maximum generic stale jobs locked and transitioned in one recovery transaction, clamped to 1-1,000. Global and worker-targeted passes each apply the bound independently; oldest visible unlocked rows are processed first and overflow remains for later passes. |
| `QUEUE_ASK_TERMINAL_RETENTION_MS` | `86400000` | Retains completed/cancelled `ask` results for polling. Values are bounded to 1 hour-30 days. |
| `QUEUE_DAG_NODE_TERMINAL_RETENTION_MS` | `3600000` | Retains completed/cancelled `dag-node` queue rows for polling and reconciliation. Values are bounded to 1 hour-30 days. |
| `QUEUE_BACKSTAGE_NOTION_PARTITION_SYNC_TERMINAL_RETENTION_MS` | `604800000` | Retains completed/cancelled protected manual partition synchronization rows for operator status reads and idempotency forensics. Values are bounded to 1 hour-30 days. |
| `QUEUE_NON_GPT_TERMINAL_CLEANUP_ENABLED` | `true` | Enables one deterministic bounded cleanup batch per worker inspection for expired completed/cancelled `ask`, `dag-node`, and `backstage-notion-partition-sync` rows only. Each enabled pass also reports a bounded aggregate count of protected legacy rows whose deadline is null; it never reports IDs or payloads and never backfills those rows. |
| `QUEUE_NON_GPT_TERMINAL_CLEANUP_BATCH_SIZE` | `100` | Maximum eligible non-GPT terminal rows deleted per inspection and maximum protected legacy-null rows included in the aggregate inventory sample; bounded to 1-1000. |
| `QUEUE_DIAGNOSTICS_FAILURE_WINDOW_MS` | `3600000` | Recent queue terminal/failure observation window, bounded to 1 minute-7 days. Non-GPT terminal cleanup preserves at least this window and the one-hour worker-budget window. |
| `JOB_EVENTS_CLEANUP_ENABLED` | `true` | Enables best-effort `job_events` retention cleanup during worker inspection. Legacy `JOB_EVENT_CLEANUP_ENABLED` is also accepted. |
| `JOB_EVENTS_RETENTION_DAYS` | `30` | Retains recent job timeline events for operational forensics. Values are bounded to 1-365 days. Legacy `JOB_EVENT_RETENTION_DAYS` is also accepted. |
| `JOB_EVENTS_CLEANUP_BATCH_SIZE` | `1000` | Maximum `job_events` rows matched or deleted per cleanup run. Values are bounded to 1-10000 to avoid long table locks. Legacy `JOB_EVENT_CLEANUP_BATCH_SIZE` is also accepted. |
| `JOB_EVENTS_CLEANUP_DRY_RUN` | `true` | When true, cleanup counts eligible old events without deleting them. Set to `false` after reviewing cleanup metrics/logs. Legacy `JOB_EVENT_CLEANUP_DRY_RUN` is also accepted. |
| `JOB_EVENT_RECORD_HEARTBEATS` | `false` | When true, records high-frequency `worker.heartbeat` timeline events. Leave false unless debugging a specific lease issue because `job_data.last_heartbeat_at` already tracks liveness. |

The non-GPT terminal policy is prospective and fail-closed. A completed or
cancelled `ask`/`dag-node` row receives its deadline in the same terminal
write. Cleanup requires that non-null deadline and any active
`idempotency_until` window to have elapsed. It also requires `updated_at` to
be older than the longer of the one-hour worker-budget window and the
configured queue-diagnostics window, so cleanup cannot truncate those active
counters. GPT, local-agent, failed, pending, running, unknown-type, and legacy
null-deadline rows are outside this cleanup. Existing null-deadline rows require
a separately reviewed inventory and cutover; a missing deadline is never
permission to delete.

`JOB_WORKER_STATS_ID` is intentionally independent of `JOB_WORKER_ID`: lease
owners such as `async-queue-slot-1` stay distinct, while all configured slots
can charge one exact worker-group budget. The database column and concurrent
time-window index in `migrations/20260801_job_worker_stats_identity_v1/` must be
applied before a future production cutover. Old workers do not stamp the new
identity, so mixed old/new worker revisions must not overlap during that
cutover. Compatible-worker bootstrap performs stale recovery and GPT lifecycle
cleanup before reading exact stats, so a legacy row can receive a fresh
`updated_at` while `stats_worker_id` remains null. The mutable population
includes recoverable running rows, pending GPT rows, and retained terminal GPT
rows. A quiet-window-only transition is unsupported. Draining workers and
waiting one hour alone is insufficient.

Establish one continuous freeze of all `job_data` mutators before either path.
Every transition, including an exact backfill, must run under the same continuous
freeze. Under it, use a reviewed, bounded exact backfill based on confirmed
slot-to-group evidence or take the no-backfill path. Fail closed if any affected
row cannot be mapped or accounted for exactly.

Both paths must pass the migration README's common post-transition read-only
gate: zero generic running rows, zero recent null budget rows, zero null pending
GPT rows, and zero null retained terminal GPT rows. A one-shot read cannot close
a writer race. The compatible worker must be the first released mutator.
Complete compatible worker activation and bootstrap/readiness verification
before releasing the remaining compatible writers. Existing null rows are never
inferred from producer or lease prefixes.

The hard worker budgets use one PostgreSQL clock and the exact rolling interval
`(T - 1 hour, T]`. `migrations/20260830_job_events_worker_budget_v1/` adds the
strict claim and provider-attempt ledger fields and indexes. Drain every legacy
claim and provider-call path and keep it quiet for one complete window, then
apply and verify all six phases before compatible workers begin claiming. A legacy
provider attempt or retry cannot be reconstructed exactly, so schema
compatibility alone is not sufficient for mixed-version activation. Every
slot and replica sharing a stats group must configure identical hard limits.

A generic job claim consumes one job reservation in the same transaction that
selects, fences, and claims the ordered queue row. Failed, retired, deleted, or
reclaimed jobs do not refund it; a later claim generation consumes a new
reservation. The AI-call budget counts database-admitted capacity for native
OpenAI attempts in worker-owned execution: SDK retries, higher-level retries,
separate multi-stage calls, and each scheduled or startup Notion embedding batch
all require individual reservations. One batched embedding HTTP request requires
one. A provider failure or cancellation after the reservation commits remains
charged even when cancellation prevents transport from starting. Consequently,
the reported `aiCalls` value is a conservative admission count and can exceed
observed network transports. A denied, reservation-store-failed, replayed, or
already-aborted-before-admission request is not sent and consumes no new
reservation. OpenAI service-health recovery probes outside
worker execution, API-process direct execution, the separate `workers/`
workspace, and `arcanos-ai-runtime/` are outside this dedicated queue-worker
budget. The existing logical per-request `AiExecutionBudget.maxCalls` remains a
separate limit. Model metadata requests made inside worker-owned Trinity or
recovery work are ordinary worker provider attempts and consume capacity.

These safety controls are not advisory and have no zero/false disable value.
Unset variables use the documented defaults; blank, zero, negative, fractional,
nonnumeric, or above-setting-maximum values fail worker startup closed. The two
hourly maxima are capped at PostgreSQL integer maximum 2,147,483,647; RSS accepts
positive safe-integer MiB values.
When a rolling budget is exhausted, the worker publishes `paused_budget`, stops
new claims, and reports the database-derived retry time. At or above the RSS
ceiling it publishes `paused_rss`. An observed queue/provider/database failure
publishes `dependency_failure`. Worker `/readyz` is unavailable for all three
states, while `/healthz` remains process liveness; window expiry, RSS reduction,
or successful dependency recovery returns the slot to `accepting_claims` and restores
readiness once every configured slot is accepting claims. A final admitted job
claim or provider attempt that fills its window publishes the budget pause
synchronously before that admitted work continues; best-effort snapshot
persistence starts immediately but cannot hold the claimed lease or provider
transport. The worker does not wait for a later denied admission to revoke
readiness. If the required startup
Notion rebuild reaches the rolling AI limit or observes a provider dependency
outage, every configured slot publishes the matching pause before the child
readiness signal, waits for the database retry time or dependency recovery, and
reruns the gate in-process. Deterministic Notion configuration or index-contract
failures remain fatal.

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
| `MCP_HTTP_BODY_LIMIT` | `1mb` | Downward-only decoded JSON body limit for exact `POST /mcp`, applied before the broad application parser. The effective limit is the strictest of `JSON_LIMIT`, this value, and the hard 1 MiB (1,048,576-byte) maximum. Larger valid MCP values clamp to that maximum, `0` rejects every non-empty JSON entity, and invalid non-empty values fail startup. Supported MCP suffixes are `b`, `kb`/`kib`, `mb`/`mib`, `gb`/`gib`, and `tb`/`tib`; no suffix means bytes. |
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
| `BACKEND_REQUEST_TIMEOUT` | `15` | Python daemon timeout, in seconds, used by its main backend API and protocol clients. |
| `REQUEST_TIMEOUT` | `30` | Python daemon timeout, in seconds, supplied to non-streaming chat, fallback chat streaming, vision, transcription, and inline agentic confirmed command execution. It is not a Node/backend HTTP-server deadline. |
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
| `TRINITY_REASONING_MODEL` | `gpt-5.6-terra` (commented) | Trinity-only structured Responses selector. Precedence: this variable, `GPT5_MODEL`, `GPT51_MODEL`, then Terra. |
| `GPT5_MODEL` | empty (commented) | Shared GPT-5-family override for legacy/non-Trinity paths. When unset, `GPT51_MODEL` and then GPT-5.1 remain the fallback. Backstage normalizes only the obsolete exact `gpt-5` alias to `gpt-5.1`. |
| `TRINITY_REASONING_MAX_OUTPUT_TOKENS` | `8000` (commented) | Structured Responses ceiling for hidden reasoning plus visible JSON. Strict positive base-10 integers are clamped to `16`-`8000`; invalid or unset values use `8000`. |
| `TRINITY_REASONING_STAGE_TIMEOUT_MS` | `20000` (commented) | Structured reasoning timeout, further clamped to the remaining request/runtime budget. |
| `BOOKER_TOKEN_LIMIT` | `2400` (commented) | Standard Backstage Booker output budget, bounded by its `2400`-token cap. Full-show/card review-only prompts use at most `1600`, compact direct-answer prompts can use a smaller derived budget, and ordinary Trinity callers remain capped at `1200`. |
| `BOOKER_WORKER_TOKEN_LIMIT` | `6000` (commented) | Protected queued production-generation budget, clamped to `4000`-`8000` and further limited by the compatible model and remaining finite provider-stage tier. It does not enlarge continuity, review, unsupported-model, synchronous rollback, or genuinely small compact calls. Explicit compact presentation remains enforced when HRC, Notion authority, prompt size, or retrieved context independently requires production capacity. |
| `BOOKER_GENERATION_STAGE_TIMEOUT_MS` | `40000` (commented) | Synchronous Backstage generation stage preference. Values parse through `45000`, while the plan effectively caps ordinary generation at `40000` and HRC generation at `30000` to preserve recovery, review, and response-finalization reserves below the route deadline. |
| `BOOKER_CONTINUITY_STAGE_TIMEOUT_MS` | `20000` (commented) | Lightweight synchronous continuity stage timeout, clamped to `1000`-`25000`. |
| `BOOKER_WORKER_JOB_TIMEOUT_MS` | `180000` (commented) | Protected queued-generation terminal deadline anchored to durable first execution start, clamped to `120000`-`180000`; includes 30 seconds of orchestration headroom plus a reserved 10-second result-finalization window. |
| `BOOKER_WORKER_GENERATION_STAGE_TIMEOUT_MS` | `80000` (commented) | Protected queued-generation primary provider stage, clamped to `45000`-`90000` and shortened when required by the enclosing job plan. |
| `BOOKER_REPAIR_STAGE_TIMEOUT_MS` | `45000` (commented) | Protected queued-generation recovery stage, clamped to `10000`-`45000`; at most one recovery is permitted. |
| `ARCANOS_BACKEND_URL` | `http://127.0.0.1:3000` (commented) | Backend base URL used by CLI/scripts before fallback variables. |
| `OPENAI_ACTION_SHARED_SECRET` | `replace-with-a-strong-shared-secret` | Shared secret for `/api/bridge/gpt`, its compatibility alias, and `/api/bridge/health`. |
| `ARCANOS_JOB_READ_CAPABILITY_SECRET` | commented empty | Required current server-side HMAC key for job-specific generic read capabilities; new tokens use only this key. |
| `ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET` | commented empty | Optional verification-only old key for a bounded retained-job rotation overlap. |
| `ARCANOS_JOB_READ_TOKEN` | commented empty | Client-only transient token for one standalone generic job lookup; never a shared backend signing key. |
| `ARCANOS_GPT_ACCESS_TOKEN` | commented placeholder | Bearer token for `/gpt-access/*`; real values must not be committed or logged. |
| `ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA` | commented empty | Disposable heavy-proof-only exact lowercase revision, corroborated by the runner's deploy request and manifest checks; never configure it on canonical services. |
| `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` | commented placeholder | Web-service-only dedicated API Key/Bearer credential for the managed queued-result read, exact Backstage domain reads/canon write, and request-local authorization of scoped Notion continuity queries plus optional Notion context on canonical generation. It authenticates one shared stable managed principal, is distinct from generic GPT Access and control-plane credentials, and must never appear in the schema, instructions, chat, source, or logs. |
| `ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED` | `false` (commented) | Web automatic-routing flag for durable heavy generation. False preserves the prior default routing; explicit async/idempotent generation remains queued. Exact true requires payload protection on both web and worker. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY` | commented empty | Current canonical 32-byte base64 key required for private Booker queue inputs and outputs on both web and worker. Never reuse the Action bearer or another credential. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY` | commented empty | Optional decryption-only previous payload key retained through a bounded queued-job rotation overlap. |
| `ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` | commented placeholder | Outbound read-content-only token: web for synchronous optional legacy supplement; worker for authority sync and queued legacy supplement generation. It is never a Builder credential. |
| `ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` | commented example | Sensitive exact-universe-to-one-to-three-raw-page-UUID mapping for optional Notion generation context. Configure the identical mapping on worker before enabling queued legacy supplement generation. |
| `ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` | commented example | Identical web/worker exact-universe root map for one-way Notion authority and recursive RAG. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON` | commented example | Identical web/worker closed partition envelope with stable shard identities, bounded capacity, retrieval tiers, required policy, and routing tags. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE` | `monolith` (commented) | Exact read rollout control. `shadow` is the only partition-writer mode and returns only monolith reads while comparing partitions. `partitioned` freezes partition writers, monitors evidence, returns only manifest-scoped partition reads, and never silently falls back; the legacy monolith loop remains active. Return to `shadow` for refresh and resealing; restore `monolith` for read rollback. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET` | commented empty | Current web-only 32–4096 UTF-8-byte purpose-isolated credential used to seal partition complete-scope cursors in exact `shadow` or `partitioned`. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET` | commented empty | Optional distinct prior web-only cursor credential retained solely for a bounded rotation overlap. |
| `ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS` | `900000` (commented) | Worker full-manifest refresh cadence. |
| `ARCANOS_BACKSTAGE_NOTION_RAG_MAX_STALENESS_MS` | `86400000` (commented) | Web-side freshness fence for authoritative retrieval. |
| `ARCANOS_GAMING_SOURCE_ACCESS_TOKEN` | commented placeholder | Web-service-only dedicated Bearer credential for only the Gaming source ingestion, refresh, and status routes. Configure the same value in the Arcanos Gaming Custom GPT Action; do not use the generic GPT Access or bridge credential and do not configure it on workers. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | commented HTTPS placeholder | Public origin advertised by `/gpt-access/openapi.json`; set this in deployed environments. |
| `ARCANOS_GPT_ACCESS_SCOPES` | commented scope list | Generic gateway scope allowlist. `jobs.create`, `capabilities.read`, `capabilities.run`, and `workers.recover` must be explicit before they enqueue, discover, execute capability work, or recover workers. Gaming source lifecycle Actions use the dedicated Gaming credential instead. |
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
| `RESEARCH_WORKFLOW_TIMEOUT_MS` | `60000` (commented) | Service-owned aggregate Research deadline in milliseconds. Missing, blank, nonnumeric, or sub-1 values use the 60,000 ms default; values above 300,000 are capped. One effective deadline and cancellation signal cover DNS/fetch, every Trinity/model stage, and persistence; a shorter caller deadline caps this value. |
| `WEB_FETCH_MAX_LINKS` | `15` (commented) | Maximum discovered page links included by the shared web fetch path. |
| `RAILWAY_API_TOKEN` | `` | Railway API token used by optional automation/ops routes. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Filesystem path for logs (if file logging enabled). |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem path for memory persistence. |
| `RUN_WORKERS` | `true` | Whether the explicit local/direct API startup lifecycle boots the in-process worker runtime. The Railway launcher sets this by role; the dedicated `jobRunner` owns its own PostgreSQL queue lifecycle. |
| `WORKER_API_TIMEOUT_MS` | `60000` template override; `30000` unified-config default when unset | Singleton worker adapter timeout. Protected Booker model calls use a bounded per-request SDK timeout instead, so unrelated ask, DAG, and GPT jobs retain this configured value. |
| `JOB_WORKER_ID` | `async-queue` (commented) | Dedicated worker identity. |
| `JOB_WORKER_STATS_ID` | `JOB_WORKER_ID` (commented) | Exact persisted worker-group identity for shared inspection and hourly budgets; maximum 255 characters. |
| `JOB_WORKER_CONCURRENCY` | `1` (commented) | Queue-consumer slots per worker process. |
| `JOB_WORKER_MAX_JOBS_PER_HOUR` | `120` (commented) | Hard shared rolling-hour queue-claim maximum; integer 1 through 2,147,483,647 only. |
| `JOB_WORKER_MAX_AI_CALLS_PER_HOUR` | `120` (commented) | Hard shared rolling-hour worker OpenAI transport-attempt maximum; integer 1 through 2,147,483,647 only. |
| `JOB_WORKER_MAX_RSS_MB` | `2048` (commented) | Hard per-process RSS claim ceiling in MiB; positive safe integer only. |
| `JOB_WORKER_POLL_MS` | `250` (commented) | Worker polling delay after claim cycles. |
| `JOB_WORKER_HEARTBEAT_MS` | `5000` | Worker heartbeat interval. |
| `JOB_WORKER_LEASE_MS` | `15000` (commented) | Claimed-job lease duration, clamped to `3000`-`300000` ms and renewed through fenced terminal persistence. |
| `JOB_WORKER_STALE_AFTER_MS` | `45000` | Age after which a worker heartbeat is considered stale. |
| `JOB_WORKER_RECOVERY_BATCH_SIZE` | `100` (commented) | Per-transaction stale-recovery lock/transition bound, clamped to 1-1,000. This bounds selected rows and result arrays, not the underlying scan; overlapping passes skip locked rows and may process separate batches. |
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
| `SAFETY_EXPECTED_HASH_DISPATCH_PATTERNS` | unset | Optional lowercase canonical semantic digest pin for complete dispatch bindings and exemptions. |
| `SAFETY_EXPECTED_HASH_PROMPTS` | unset | Optional lowercase canonical semantic digest pin for the selected prompt configuration. |
| `SAFETY_EXPECTED_HASH_FALLBACK_MESSAGES` | unset | Optional lowercase canonical semantic digest pin for the selected fallback-message configuration. |
| `SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG` | unset | Optional lowercase canonical semantic digest pin for the declared catalog/environment GPT route projection; registered-module availability is checked separately. |
| `SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY` | unset | Optional lowercase canonical semantic digest pin for the selected assistant registry. |
| `SAFETY_EXPECTED_HASH_DAEMON_TOKENS` | unset | Optional lowercase canonical semantic digest pin for the selected daemon-token map. |
| `SAFETY_EXPECTED_HASH_PROTECTED_JSON` | unset | Optional lowercase canonical semantic digest pin for an explicitly sourced generic JSON candidate; no production caller currently owns it. |
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
