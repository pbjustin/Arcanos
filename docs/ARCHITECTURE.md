# Architecture

## Overview
Arcanos is split into a TypeScript backend and an optional Python daemon client. The backend is the source of truth for API, confirmation gating, and Railway deployment.

## Dual-Lane Routing
ARCANOS now enforces two planes before any module dispatch occurs:

- Writing plane: `POST /gpt/:gptId` for generative work only. This lane is limited to prompt generation, assistant responses, and other true write/query actions.
- Control plane: direct handlers and explicit control endpoints for system operations. This includes `GET /jobs/:id`, `GET /jobs/:id/result`, `GET /workers/status`, `GET /worker-helper/health`, `GET /status`, `GET /status/safety/self-heal`, `POST /gpt-access/diagnostics/deep`, protected DevOps/PR verification execution, `POST /system-state`, `POST /mcp`, and `GET /api/arcanos/dag/*`.

Implementation rules:
- `src/routes/gptRouter.ts` runs pre-dispatch classification through `src/routes/_core/gptPlaneClassification.ts`.
- `src/routes/_core/gptDispatch.ts` is write-plane only and rejects leaked control requests with a fail-fast `write_guard`.
- Pure runtime-inspection prompt classification lives in `src/shared/runtimeInspectionPrompt.ts`; writing-plane contracts must not import the operational runtime-inspection service or its worker/self-heal dependencies.
- Exact GPT memory-interception classification is shared by the HTTP router and dispatcher through `src/services/memoryDispatchInterception.ts`; the router establishes request credential authority, while `gptDispatch.ts` independently requires a server-owned authorization flag at the execution sink.
- Production `/api/memory/*`, `/api/save-conversation*`, and `/api/sessions*` mounts authenticate through `src/transport/http/middleware/memoryPlaneAuth.ts` before consistency, confirmation, or persistence. Session authentication additionally precedes broad body parsing. This deployment-wide boundary does not provide tenant ownership.
- `/api/codebase/*`, `/api/prompt-debug/*`, and
  `/api/ai-routing/debug/*` are sensitive read-only
  control-plane surfaces. Their leaf routers apply security/no-store headers,
  bounded limiting, purpose-bound operator authentication, and `repo:read` or
  `arcanos:read` authorization, terminate unknown subpaths, and mount before
  writing-plane consistency.
- Prompt and AI-routing trace capture shares one fail-closed content policy:
  bounded in-memory metadata is the default, capture can be disabled, and raw
  content requires explicit `full` mode. Prompt-debug disk persistence is a
  separate opt-in with an explicit byte cap; self-heal consumes derived tags
  and tool choices rather than retained prompt text.
- `POST /devops/self-test`, `POST /devops/daily-summary`, and
  `POST /api/pr-analysis/analyze` are active diagnostic-execution control-plane
  leaves. An idempotent exact-path boundary authenticates and authorizes the
  operator before bounded JSON parsing, applies connection and principal
  budgets, and serializes the DevOps and PR families independently. DevOps uses
  `diagnostics:execute`; direct PR verification uses `repo:verify` and mounts
  before writing-plane consistency.
- `/sdk/*` and `/orchestration/*` are legacy operator surfaces, not public
  compatibility APIs. Their idempotent boundary runs before broad parsing,
  requires `arcanos:read` for status/diagnostic reads and `mcp:invoke` for
  mutations, and retains confirmation only as a post-authentication approval.
  SDK mutations and orchestration reset/purge have separate principal budgets
  and process-local single-flight locks.
- `/api/daemon/*` is a separate transport/control-plane namespace. The daemon
  router applies path-scoped security headers, rate limiting, and strict
  purpose-bound authentication before its handlers, terminates unknown paths,
  and mounts before writing-plane consistency so daemon control traffic cannot
  be rerouted into GPT dispatch. Its deployment-wide token is not per-instance
  identity.
- `/api/self-heal/*`, `/api/self-improve/*`, detailed
  `GET /status/safety/self-heal`, and integrity-quarantine release form one
  direct operator control-plane surface. Its idempotent HTTP boundary runs
  before the broad JSON parser, applies an
  ingress-derived client limit, authenticates the purpose-bound control-plane
  bearer principal, and terminates unknown paths. The router mounts before the
  catch-all API consistency gate. Passive inspection, active provider probes,
  decisions, actuator execution, and self-improve control changes use distinct
  server-owned scopes. The existing caller-selected agent capability check is a
  secondary compatibility prerequisite, not identity-bound authorization.
  Restrictive freeze and authenticated quarantine recovery remain reachable
  through the global unsafe-state mutation block. Public safety status is an
  allowlisted summary; raw safety records live only in the authenticated detail
  response.
- `POST /gpt/:gptId` has no public control actions; `get_status`, `get_result`, `diagnostics`, `system_state`, runtime inspection, worker status, queue inspection, self-heal status, and MCP calls are rejected before write dispatch.
- Canonical durable write actions are `query` and non-core `query_and_wait`. Core `query_and_wait` is synchronous direct action. Canonical async reads use `GET /jobs/:id` and `GET /jobs/:id/result`.
- Prompt-shaped control requests for job lookup, DAG execution/tracing, runtime inspection, or MCP tool calls are rejected with canonical control endpoints.

## Prerequisites
- Read `README.md` and this document first.
- Familiarity with Express routing and OpenAI SDK usage.

## Setup
Primary backend flow:
1. `src/start-server.ts` validates env and starts server.
2. `src/server.ts` builds app, starts workers, and binds port.
3. `src/routes/register.ts` mounts all route groups.
4. `src/services/openai/*` handles OpenAI client and request flows.

## Repository Map and Entry Points

| Area | Current entry point or source |
| --- | --- |
| Backend startup | `src/start-server.ts`, `src/server.ts`, and `src/app.ts` |
| HTTP route registry | `src/routes/register.ts` |
| Executable module inventory | `src/services/moduleCatalog.ts`, loaded by `src/services/moduleLoader.ts`, owned by `src/services/moduleRegistry.ts`, and projected to legacy HTTP by `src/routes/modules.ts` |
| Dedicated database-backed worker | `src/workers/jobRunner.ts` |
| Separately compiled worker workspace | `workers/` |
| Public protocol and shared packages | `packages/protocol/`, `packages/cli/`, `packages/arcanos-runtime/`, and `packages/arcanos-openai/` |
| Separate BullMQ/Redis runtime workspace | `arcanos-ai-runtime/` |
| Optional Python daemon CLI | `daemon-python/arcanos/cli/` through the `arcanos` console script |
| Optional local daemon bridge | `daemon-python/arcanos/cli/local_bridge.py` through `arcanos bridge` |
| Optional CLI bridge policy | `config/cli-policy.json` |

`MODULE_CATALOG` is the source-owned executable inventory. It registers exactly
15 definitions in deterministic order; the loader imports only those entries,
validates the expected module name and non-empty function action map, coalesces
concurrent cold loads, and returns immutable definition snapshots in defensive
registry entries. Clearing the loader snapshot does not invalidate Node's ESM
evaluation cache; restart the process after module source changes or evaluation
failures. `moduleRegistry.ts` builds one immutable process-wide registry
generation with coalesced, retryable initialization and owns metadata lookup,
direct action dispatch, and safe public/full projections. Route, MCP, daemon,
diagnostics, and writing-dispatch consumers use that service port;
`routes/modules.ts` only mounts legacy HTTP adapters. The GPT routing map also
projects this same immutable generation. Its runtime rebuild refreshes
environment-derived bindings without invalidating module definitions, and
accepts only exact registered public module/route pairs.

Catalog membership is not authorization. `ARCANOS:CLI`, `ARCANOS:LOCAL_AGENT`, and
`ARCANOS:PRODUCTIVITY` are protected GPT Access-only definitions, so the public
legacy registry, legacy module routes, public introspection, and default GPT map
project the remaining 12 definitions. The public `/diagnostics` module-status
map is generated from the same 12-entry projection and omits protected
definitions; each catalog entry owns its stable diagnostics key, including the
legacy `BOOKING` key for `BACKSTAGE:BOOKER`. An `active` module status means its
validated definition is present in the process registry; capability-specific
health remains responsible for downstream dependency readiness. Protected
route, source-stem, and normalized module-name variants are reserved before
substring, token, or fuzzy GPT matching. Authenticated GPT Access and daemon
capability discovery can project all 15 under their own authorization policy.

The standalone BullMQ/Redis workspace is not imported or launched by the
canonical root web/worker startup. When started independently, its
`createRuntimeApp` HTTP boundary authenticates `/jobs` before parsing, applies
explicit enqueue/read scopes, derives ownership from a server-configured
principal, and makes missing or cross-principal jobs indistinguishable. The
`server.ts` and `worker.ts` own their concrete queue resources through an
import-safe factory; tests inject the narrow queue port without initializing
Redis or OpenAI. Both processes require the same explicit deployment-scoped
queue name. The API exposes separate liveness and Redis-readiness probes, while
the shared admission ledger bounds enqueue rate and outstanding executable work.
Startup is readiness-gated and both processes use bounded, idempotent shutdown
coordination.

The root database-backed worker loads the immutable module registry after its
database and autonomy bootstrap but before emitting
`worker.bootstrap.completed` or starting consumer slots. This moves catalog
initialization out of the first claimed GPT job and records the preload duration
and loaded-definition count without changing per-module readiness semantics.

`platform/observability/appMetrics.ts` owns only metric instruments, aggregation,
and response policy. The application composition root supplies worker-control
and OpenAI-health readers through `services/appMetricsRuntimeProviders.ts`;
observability does not import those higher-level services.

Control-plane execution depends on the narrow
`services/arcanosMcpPort.ts` contract rather than the concrete in-process MCP
client. That port owns the shared invocation option types and is the single
type authority for the executor-facing control-plane service; the concrete MCP
service extends it with narrower result types. The web application installs the
immutable service in
`app.locals.arcanosMcp`; internal and stdio MCP contexts receive the same port
explicitly in their synthetic request locals. HTTP routes and MCP registrars
then pass that port into the two control-plane executors after authentication,
scope, allowlist, and approval checks. An absent or malformed port fails closed,
and the control-plane layer never imports the MCP server that imports it.

Trinity honesty interfaces live in the dependency-neutral
`core/logic/trinityHonestyTypes.ts` contract and retain their existing
re-exports. Queued bridge-smoke fields are owned by `shared/gpt/bridgeSmoke.ts`
and extended by the async-job contract. These ownership directions keep erased
type relationships from recreating circular module dependencies.

Trinity stages, CLEAR audit, AI reflection, and self-improvement patch
generation import focused OpenAI leaves (`credentialProvider`, `chatFlow`,
`chatFallbacks`, and `structuredReasoning`) rather than the broad
`services/openai.ts` compatibility facade. The facade may continue exporting
image generation for callers, but the writing pipeline does not pull that
feature back into its own dependency spine.

ARCANOS:CORE imports only the dependency-neutral operator-dispatch contract in
`services/arcanosCoreOperatorDispatchPort.ts`. Web, database-worker, and stdio
MCP composition roots bind the GPT Access natural-language dispatcher through
`services/arcanosCoreRuntimeProviders.ts` before request or job execution. A
missing binding produces the fixed
`ARCANOS_CORE_OPERATOR_DISPATCH_NOT_CONFIGURED` error instead of silently
treating an operator command as writing-plane content. This direction keeps GPT
Access and self-heal inspection out of the core writing module's dependency
graph.

Run `npm run reindex` after structural moves or deletions. It rewrites `backend-index.json`, `cli-agent-index.json`, `docs/BACKEND_INDEX.md`, and `docs/CLI_AGENT_INDEX.md` together; those generated inventories complement this maintained architecture map.

## Configuration
Main config layers:
- `src/platform/runtime/env.ts` (validated env access)
- `src/platform/runtime/unifiedConfig.ts` (fallback and precedence logic)
- `src/platform/runtime/config.ts` (runtime defaults and derived values)

Compatibility imports under `src/config/` re-export these platform runtime modules; new code should use the platform runtime paths.

## Run locally
Build and run backend:
```bash
npm run build
npm start
```

## Deploy (Railway)
Deployment control lives in:
- `railway.json`
- `scripts/start-railway-service.mjs`
- `docs/RAILWAY_DEPLOYMENT.md`

`Procfile` remains as a historical fallback artifact; it is not the canonical Railway start path.

## Troubleshooting
- Routing ambiguity: inspect `src/routes/register.ts` mount order first.
- Unexpected model selection: inspect `src/platform/runtime/unifiedConfig.ts` precedence chain.

## References
- `../src/start-server.ts`
- `../src/routes/register.ts`
- `API.md`
- `CONFIGURATION.md`

## GPT Job Architecture
Long-running GPT requests are handled through the DB-backed `job_data` queue instead of blocking the request thread until full completion.

Execution model:
1. `POST /gpt/:gptId` classifies the request as writing-plane or control-plane before dispatch.
2. Control-plane reads use direct endpoints (`GET /jobs/:id`, `GET /jobs/:id/result`, `POST /gpt-access/diagnostics/deep`, `GET /system-state`, `POST /system-state`) and never create GPT jobs.
3. Writing-plane durable requests (`query`, non-core `query_and_wait`, or prompt-first async compatibility mode) persist a canonical GPT job row with hashed idempotency metadata.
4. `query` returns the canonical `jobId` without inline waiting. On core GPT IDs, `query_and_wait` uses the lightweight synchronous direct action lane and returns the final result inline.
5. `src/workers/jobRunner.ts` claims `job_type='gpt'` rows and executes them in background mode.
6. `GET /jobs/:id` and `GET /jobs/:id/stream` expose the canonical job lifecycle and terminal result.

The optional Ask and GPT hybrid inline waits share
`services/queuedJobCompletionPolling.ts` for deadline, abort, sleep, and hard
poll-cap behavior. Their public wrappers retain separate environment defaults,
terminal-state mappings, and repository-error versus abort precedence.
Pure GPT async-job response recognition, lifecycle metadata, links, and
direct-wait timeout shaping live in
`routes/_core/gptAsyncJobResponses.ts`; the main router retains request
classification and orchestration.
The router derives request facts and environment thresholds, then delegates
only execution-mode precedence to the pure
`routes/_core/gptRouteExecutionPolicy.ts` classifier. Queue selection,
persistence, logging, and response emission remain in the router.

Agent-safe retrieval rules:
- Retrieval must remain structured-only through direct `/jobs/*` endpoints.
- Natural-language job retrieval through `prompt` text remains blocked on `/gpt/:gptId`.
- MCP follows the same lane split: writing tools create work, while `jobs.status` and `jobs.result` stay on the control plane.

Persistence and dedupe:
- Durable dedupe metadata lives on `job_data`, not in process memory.
- Stored fields include caller-scope hash, request fingerprint hash, explicit idempotency-key hash, cancel metadata, idempotency reuse deadline, retention deadline, and expiry timestamp.
- Duplicate prevention is serialized with PostgreSQL transaction-scoped advisory locks so concurrent identical requests collapse onto one canonical job safely.

Lifecycle semantics:
- Storage statuses: `pending`, `running`, `completed`, `failed`, `cancelled`, `expired`
- API alias: `pending` is exposed as `lifecycle_status: queued`
- `cancel_requested_at` marks best-effort cancellation for running GPT jobs
- `retention_until` controls how long a completed/failed/cancelled job stays pollable
- `idempotency_until` controls how long the same request can reuse that terminal job
- `expires_at` marks when lifecycle maintenance has converted a retained row into `expired`

Operational maintenance:
- Worker inspection already recovers stale running leases
- GPT lifecycle maintenance also expires over-retained terminal jobs and compacts old expired rows
- Structured logs and metrics emit dedupe decisions, retryability, cancellation, expiry, queue wait time, execution time, and end-to-end completion time without logging prompt contents

## Railway Topology
Production remains split into dedicated Railway services:

- Web service: request ingress, direct control endpoints, write-plane classification, and MCP HTTP transport.
- Worker service: queued GPT execution and background job processing.

Environment separation must remain explicit:
- Web processes use `ARCANOS_PROCESS_KIND=web`, and the launcher sets `RUN_WORKERS=false`.
- Worker processes use `ARCANOS_PROCESS_KIND=worker` and run the PostgreSQL-backed `jobRunner` lifecycle.
- The local/direct in-process EventEmitter runtime starts only from the explicit application startup lifecycle when `RUN_WORKERS` resolves true. Importing shared dispatch or worker configuration code never starts it.
- Logging must make the selected plane visible (`gpt.request.classified`, `gpt.write.entry`, `gpt.dispatch.write_guard_rejected`).
