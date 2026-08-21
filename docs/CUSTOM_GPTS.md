# Custom GPTs and Backend Integration

## Overview
Arcanos routes Custom GPT requests through the `/gpt/:gptId` gateway. This gateway is the writing plane: it resolves a GPT ID to a backend module, forwards generative work to the matched module, and returns route metadata describing the matched module/action set. The routing table is built from definitions in the explicit module catalog (including their `gptIds`), with optional overrides via environment configuration. The canonical Custom GPT contract is path-based: call `/gpt/<gpt-id>` with either a prompt-first generative request or the typed GPT bridge actions `query` and `query_and_wait`. The fixed `/gpt/arcanos-gaming/canary` route is a narrow public-protocol exception that never enters the writing plane. Use direct control endpoints for job status/results, DAG traces, runtime diagnostics, and MCP tools. Legacy `get_status` and `get_result` aliases are reserved and rejected by `/gpt/:gptId` so control-plane reads do not enter the writing route. (`src/routes/gptRouter.ts`) (`src/platform/runtime/gptRouterConfig.ts`) (`src/services/moduleCatalog.ts`) (`src/services/moduleLoader.ts`) (`src/services/moduleRegistry.ts`)

## Why We Use Custom GPTs
Custom GPTs let Arcanos ship specialized assistants (Backstage Booker, Arcanos Gaming, Tutor) that:
- **Map cleanly to backend modules** so each assistant uses its own action surface (book events, run tutoring flows, etc.). The GPT router and service-level module registry enforce this boundary and keep action lists explicit per module. (`src/routes/gptRouter.ts`) (`src/services/moduleRegistry.ts`)
- **Provide traceable acknowledgements** back to the caller, including matched module, action inventory, and routing metadata for auditability and debugging. (`src/routes/gptRouter.ts`)
- **Support explicit confirmation flows.** A GPT ID in `TRUSTED_GPT_IDS` is eligible for the trusted path only when the request also presents a non-empty `x-arcanos-confirm-token`; membership alone does not bypass confirmation. The current trusted path treats that header as a presence marker rather than validating it against the one-time-token store. Because request metadata can supply the ID, this setting is not caller authentication; deploy it only behind middleware that authenticates the caller and binds the permitted identity. (`src/transport/http/middleware/confirmGate.ts`)

## How Custom GPT Routing Works
1. The GPT calls `POST /gpt/:gptId` with a request body that contains `prompt` and optional `gptVersion`, `action`, `payload`, and `context`.
2. Async job status/results must be fetched explicitly through `GET /jobs/:id`, `GET /jobs/:id/result`, or the authenticated GPT Access job-result endpoint. Generic reads require the job-specific `jobReadToken` returned by the creating response in exactly one `x-arcanos-job-read-token` header.
3. Prompt-based control requests are rejected: job lookup prompts, DAG execution/tracing prompts, runtime inspection prompts, and explicit MCP tool calls must use their canonical control-plane endpoints.
4. Explicit control actions are also rejected before writing dispatch, with guidance to the corresponding direct endpoint.
5. Simple prompt-generation requests may be handled by the inline GPT fast path. These return directly with `routeDecision.path: "fast_path"` and do not create a job.
6. Complex requests continue through the existing orchestrated path. The GPT router resolves the incoming GPT ID to a module route using the module map and fuzzy matching strategy if needed.
7. The router invokes the resolved module action in process through `dispatchModuleAction(...)`; it does not make an internal HTTP request to `/modules/:route`.
8. The response is returned as JSON with a `_route` metadata block. (`src/routes/gptRouter.ts`) (`src/services/moduleRegistry.ts`)

## Setup: Connect a Custom GPT to the Backend

### 1) Confirm the target module and GPT IDs
Each module declares a name, description, and optional `gptIds`. A module becomes executable only when its source, route, and expected name are registered in `MODULE_CATALOG`; the router binds GPT IDs from the validated definitions unless an allowed override applies. Confirm the catalog route, module name, and GPT ID you plan to use. The catalog currently contains 15 definitions. `ARCANOS:CLI`, `ARCANOS:LOCAL_AGENT`, and `ARCANOS:PRODUCTIVITY` remain protected GPT Access-only capabilities, leaving 12 definitions in public GPT and legacy projections.
- Module inventory and routes: `src/services/moduleCatalog.ts`.
- Catalog loading and validation: `src/services/moduleLoader.ts`.
- Immutable registry, metadata lookup, and action dispatch: `src/services/moduleRegistry.ts`.
- GPT ID routing map: `src/platform/runtime/gptRouterConfig.ts`.
- Module definitions: `src/services/*.ts` with compatibility shims in `src/modules/*.ts` where needed.
(`src/services/moduleCatalog.ts`) (`src/services/moduleLoader.ts`) (`src/services/moduleRegistry.ts`) (`src/platform/runtime/gptRouterConfig.ts`)

Protected module routes, source stems, and normalized module-name variants are
reserved before public substring, token, or fuzzy GPT matching. For example,
`cli`, `arcanos-cli`, and `ARCANOS:CLI` all fail as unknown on
`/gpt/:gptId`; they never fall through to Arcanos Core or another writing
module.

### 2) (Optional) Override GPT ID routing
If you want a custom GPT ID that is not in the module’s `gptIds`, set `GPT_MODULE_MAP` to a JSON mapping of GPT IDs to `{ route, module }`. Each target must be the exact route/name pair of a registered public definition. This setting changes ID bindings only: it cannot register an arbitrary service file, target an absent or mismatched definition, or expose a GPT Access-only catalog definition. Legacy environment variables (`GPTID_*`) are still supported for Backstage Booker, Arcanos Gaming, and Tutor if required. (`src/platform/runtime/gptRouterConfig.ts`)

### 3) Keep writing-plane and control-plane access separate
`/gpt/:gptId` module traffic does not grant control-plane privileges. Sensitive direct endpoints require their own approved auth and confirmation flow. Do not add non-core module GPTs such as `arcanos-gaming` or `gaming` to control-plane trust lists just to make writing requests work; Gaming should remain a non-privileged module client. (`src/routes/_core/gptPlaneClassification.ts`) (`src/services/controlPlane/gptPolicy.ts`)

### 4) Configure the Custom GPT action
Use a single HTTP action in your Custom GPT definition:
- **Method:** `POST`
- **URL:** `https://<your-backend>/gpt/{gptId}`
- **Headers:**
  - `Content-Type: application/json`
  - `x-gpt-id: <gpt-id>` (optional caller metadata; a trusted ID still needs a non-empty `x-arcanos-confirm-token` presence marker on confirmation-gated endpoints)
- **Body schema:**
```json
{
  "prompt": "Describe the request for this GPT/module route.",
  "gptVersion": "optional-version",
  "action": "optional-supported-action",
  "payload": { "...": "optional-structured-input..." },
  "context": { "...": "optional-caller-context..." }
}
```
Rules:
- `gptId` belongs in the path, not the JSON body.
- Omit `action` by default so the backend can infer intent from the GPT/module binding.
- Use `executionMode: "fast"` for small prompt-generation requests that should return inline without queueing.
- Use `executionMode: "async"` or `executionMode: "orchestrated"` when the caller wants durable/orchestrated behavior even for prompt-generation text.
- Use `action: "query"` with a non-empty `prompt` when the caller wants a durable writing job immediately and will poll later.
- Use `action: "query_and_wait"` with a non-empty `prompt` when the caller wants the core GPT to complete synchronously through the lightweight direct action lane. The route returns a typed error if direct execution fails or times out; it does not synthesize bounded fallback content for latency guard events. Non-core GPT IDs keep the durable job plus bounded wait behavior.
- Body `action` is canonical. The router also accepts `?action=query_and_wait` and operation-style aliases such as `operationId: "requestQueryAndWait"` for generated GPT Action clients that separate operation metadata from body arguments.
- Use `GET /jobs/:id`, `GET /jobs/:id/result`, or `POST /gpt-access/jobs/result` when you need to fetch canonical async GPT job state without creating new work. For a generic job read, retain `jobReadToken` from creation and send it only in the returned `jobReadTokenHeader` (`x-arcanos-job-read-token`).
- Use direct control endpoints instead of `/gpt/:gptId` for runtime inspection, DAG tracing/execution, and MCP tool calls.
- Retrieval by natural-language prompt is intentionally blocked. Do not ask the GPT route to “look up job 123” in `prompt`; use the direct jobs API or the protected GPT Access result operation.
- Do **not** inject a default action like `"ask"`; only send `action` when the caller explicitly selects a supported backend action.

The router injects the module name server-side, so your Custom GPT does not need to specify `module` in the payload. (`src/routes/gptRouter.ts`)

### Canonical OpenAPI Contract
The machine-readable contract lives at [contracts/custom_gpt_route.openapi.v1.json](../contracts/custom_gpt_route.openapi.v1.json).

For live integrations, prefer the backend-served contract URL instead of a manually copied local file:
- `https://<your-backend>/contracts/custom_gpt_route.openapi.v1.json`

The Arcanos Gaming builder uses the dedicated `1.5.0` fixed-path schema with five Action operations while retaining one gameplay call per gameplay request:

- `https://<your-backend>/contracts/arcanos_gaming.openapi.v1.json`
- [ARCANOS_GAMING_CUSTOM_GPT.md](ARCANOS_GAMING_CUSTOM_GPT.md)

The Backstage Booker builder uses its own fixed-path schema. It exposes one
Builder-authenticated continuity-query/generation/simulation operation, two
protected non-consequential exact reads, and one consequential canon-write operation without
exposing generic GPT Access or control-plane tools:

- `https://<your-backend>/contracts/backstage_booker.openapi.v1.json`
- [BACKSTAGE_BOOKER_CUSTOM_GPT.md](BACKSTAGE_BOOKER_CUSTOM_GPT.md)

Important:
- Updating the repo file alone does not update an already-configured Custom GPT action.
- Replace `<your-backend>` with the selected public HTTPS origin. For GPT Access, keep that origin aligned with `ARCANOS_GPT_ACCESS_BASE_URL`.
- After changing the contract or public hostname, refresh or re-import the action schema in the Custom GPT builder so its server target remains aligned with that configured origin.
- `arcanos-core` is the built-in GPT ID for the main `ARCANOS:CORE` route.
- `arcanos-tutor` and `tutor` remain separate tutor-only GPT IDs for `ARCANOS:TUTOR`.
- Use `GPT_MODULE_MAP` only when you need additional custom GPT IDs beyond the built-in routes.

## Canonical Async Bridge
Use these request shapes for agent-safe async GPT work:

Inline fast-path prompt generation:
```json
{
  "prompt": "Generate a prompt for a launch email.",
  "executionMode": "fast"
}
```

Create a durable writing job:
```json
{
  "action": "query",
  "prompt": "Draft the release summary."
}
```

Execute a core GPT action synchronously:
```json
{
  "action": "query_and_wait",
  "prompt": "Draft the release summary.",
  "timeoutMs": 25000,
  "pollIntervalMs": 500
}
```

Canonical response guidance:
- Queued write: `{ "ok": true, "action": "query", "jobId": "job_123", "status": "queued", "jobReadToken": "v1.<job-specific-signature>", "jobReadTokenHeader": "x-arcanos-job-read-token" }`
- Completed job-backed `query_and_wait`: `{ "ok": true, "action": "query_and_wait", "jobId": "job_123", "status": "completed", "jobReadToken": "v1.<job-specific-signature>", "jobReadTokenHeader": "x-arcanos-job-read-token", "result": "..." }`
- Completed synchronous core `query_and_wait`: `{ "ok": true, "action": "query_and_wait", "status": "completed", "result": "..." }` (no job or read capability is created).
- Status/result read: use the canonical direct job endpoints; `/gpt/:gptId` rejects `get_status` and `get_result`.
- Generic status, result, and stream reads expose only `gpt` and `ask` jobs, require the matching token header, and are `no-store`. Missing or invalid capabilities are non-disclosing; they appear as not found.
- Repository unavailable after job acceptance: HTTP `503` with `error.code: "ASYNC_GPT_JOBS_UNAVAILABLE"` and canonical `jobId`, `poll`, `stream`, `jobReadToken`, and `jobReadTokenHeader` recovery fields. Keep the job ID and token and retry polling; do not submit replacement work.
- The authenticated `/api/bridge/gpt` surface reports queue-persistence outages as HTTP `503` with `status: "queue_error"`, `error.source: "queue"`, and the stable message `Durable GPT job persistence is unavailable.` A wait-phase failure includes the accepted job id and its read capability.
- Job-backed creation requires a distinct valid `ARCANOS_JOB_READ_CAPABILITY_SECRET`. Missing or invalid current configuration fails before enqueueing with HTTP `503` and `JOB_READ_AUTH_UNAVAILABLE`. During rotation, new tokens use the current key while verification may also accept the distinct optional `ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET`; remove the previous key after the retained-job window drains. Rotating without that overlap invalidates outstanding generic read tokens immediately.
- Authenticated `/api/bridge/health` reports only whether the current and
  optional previous signing keys are configured and lists the required current
  environment name in `missing_required_env` when unavailable; it never
  returns either key or a derived job token.
- Treat `jobReadToken` as a bearer secret. Never place it in a URL, prompt, log, or persistent Custom GPT instruction; send it only in the fixed header for the matching job.
- The token alone cannot cancel work. `POST /jobs/:id/cancel` also requires the
  route's confirmation and authenticated actor-ownership checks.
- Error: `{ "ok": false, "action": "...", "error": { "code": "...", "message": "..." } }`

For a full architecture and operations runbook, see [GPT_FAST_PATH.md](GPT_FAST_PATH.md).

## Spec Sheet Template (for Custom GPT Actions)
Use this format when defining or documenting a Custom GPT:

```yaml
name: <Custom GPT name>
gpt_id: <gpt-id>
base_url: https://<your-backend>
endpoint: /gpt/{gptId}
method: POST
headers:
  Content-Type: application/json
body:
  prompt: <required natural-language request>
  gptVersion: <optional version string>
  action: <optional supported backend action>
  payload: <optional structured JSON>
  context: <optional caller context JSON>
success_response:
  description: JSON payload from the module, plus _route metadata.
```

For async bridge callers, prefer the generated OpenAPI schema instead of hand-written examples so the action discriminator stays aligned with the backend.

## Migration Note
- What was broken: older integrations still modeled GPT requests as `/ask` plus body-level `gptId`, and some wrappers injected an implicit `"action": "ask"` even though GPT routes are module-specific.
- What changed: the canonical contract is now `POST /gpt/{gptId}` with `gptId` as a required path parameter and `action` omitted unless the caller explicitly sets a backend-supported value.
- How to call it now: send `prompt` in the JSON body, optionally add `gptVersion`, `action`, `payload`, or `context`, and never duplicate `gptId` in the body.
- Legacy ask-style responses advertise migration state with `Deprecation`, `Sunset`, `x-canonical-route`, and `x-ask-route-mode` headers.
- Safe migration path: the default `ASK_ROUTE_MODE` is `gone`, which returns `410 Gone` for `/brain`. Set `ASK_ROUTE_MODE=compat` only as a temporary migration bridge for older callers, then remove the override.

## Custom GPT Catalog

### Backstage Booker
**What it is:** A pro wrestling booking assistant that handles event scheduling, roster updates, storyline tracking, match simulation, and GPT-generated booking narratives. It is implemented as the `BACKSTAGE:BOOKER` module and exposes multiple actions for booking workflows. (`src/services/backstage-booker.ts`) (`src/routes/backstage.ts`)

**Known GPT IDs:** `backstage-booker`, `backstage`. The catalog registers `backstage-booker.ts` at route `backstage-booker`, and both declared GPT IDs map to that route. (`src/services/backstage-booker.ts`) (`src/services/moduleCatalog.ts`)

**Available actions (via `/gpt/<gpt-id>`):**
- Public continuity/generation/simulation: `queryContinuity`, `simulateMatch`,
  `generateBooking`, `generateBookingWithHRC`
- Operator mutations: `bookEvent`, `updateRoster`, `trackStoryline`,
  `saveStoryline`, `upsertStoryline`, `appendCanonBeat`
(`src/services/backstage-booker.ts`)

The Builder-only `getBackstageUniverse` and
`getBackstageStoryline` HTTP operations are not module actions. They
read one bounded exact-universe snapshot or one exact storyline summary page
through the protected GPT Access boundary and never enter module dispatch.

The original seven Backstage Booker actions accept an optional `universeId`. Omitted scope
uses the backward-compatible `legacy` universe; explicit IDs are bounded to
128 characters and use the portable `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, and
`-` character set. Roster, event, storyline, and story-beat reads and writes
stay within that universe. `legacy` is a compatibility scope, not a canon or
storyline-domain model. `universeId` is also not an authorization or tenant
boundary; callers must be authorized separately.
The Phase 2A canon mutations require `universeId` explicitly and never infer
`legacy`, because canon must be attached to a deliberate durable scope.
`queryContinuity` also requires an explicit `universeId`; it never substitutes
the compatibility `legacy` scope for an authoritative lookup.

The ten action request and response contracts live under
`packages/protocol/schemas/v1/backstage-booker/` and are exposed through
`getProtocolSchemaCatalog().backstageBooker.actions`. Dedicated Backstage
Booker validators enforce these contracts at the module boundary. They are a
module-action schema family, not Arcanos protocol command IDs, so they do not
add entries to either protocol command-ID list. The raw-string
`generateBooking` response remains accepted for existing callers while the
structured response shape carries `universeId` when used.

`upsertStoryline` provides version-fenced typed storyline aggregates;
`appendCanonBeat` records immutable beats, append-only retcons, and atomic
lifecycle transitions. Both require a UUID mutation ID. An identical retry
replays the exact PostgreSQL result without advancing the universe revision,
while a reused ID with changed input conflicts. Canon mutations never use the
Phase One process-memory or convenience-memory fallback: known pre-commit
outages fail with `BACKSTAGE_CANON_UNAVAILABLE`, and a lost commit
acknowledgement returns null result fields plus the `unknown` receipt for
same-ID reconciliation. Legacy saved prose and retained story beats are not
promoted or dual-written into this model.

Mutation results (`bookEvent`, `updateRoster`, `trackStoryline`, and
`saveStoryline`) report persistence explicitly: `durable` confirms a
PostgreSQL commit, `non_durable` identifies a process-memory fallback after a
known database availability or pre-commit write failure, and `unknown` means
the PostgreSQL commit outcome could not be established. Unknown outcomes do
not mutate the fallback or any convenience-memory key, and callers must not
retry them as though they were confirmed failures. `saveStoryline` makes that
distinction explicit with `saved: null` for `unknown` and `saved: true` for the
other two receipts.

One `updateRoster` request may contain at most 100 wrestlers, but that is not a
cap on the total stored roster. The `legacy` roster retains its original fixed
PostgreSQL advisory lock for mixed-version compatibility; activated non-legacy
universes use deterministic hashed lock resources. Classified pre-commit
failures use a per-universe fallback. The Booker service, rather than generic
conversation persistence, owns structured convenience snapshots. Named
storyline recall uses a SHA-256 by-key suffix so it cannot collide with the
`storyline:latest` alias or exceed exact-memory key limits.

Existing-database rollout is expand/contract. Startup adds and backfills the
scope columns and scoped constraints but retains legacy global uniqueness. A
non-`legacy` mutation therefore reports `non_durable` until every older
Backstage replica has been drained and the explicit universe-scope migration
removes those global constraints. `legacy` durable writes remain available
while staged. Fresh databases also retain the global constraints, so the same
explicit migration is required to activate non-`legacy` durability; see
`DATABASE_MIGRATIONS.md` for the rollout boundary.

Outside the dedicated Builder lane, operator mutations require the existing
control-plane bearer, configured operator principal, `mcp:invoke` scope, and
explicit backend confirmation. That rule continues to apply to configured
Backstage GPT IDs and GPT-selected `/dispatch`, `/modules/backstage-booker`,
and `/queryroute` compatibility calls. Direct `/backstage/book-gpt` is also an
operator mutation because it saves the generated storyline. Confirmation
metadata or `x-confirmed` alone does not establish caller identity.

**Existing direct/operator spec sheet example:**

```yaml
name: Backstage Booker
gpt_id: backstage-booker
base_url: https://<your-backend>
endpoint: /gpt/backstage-booker
method: POST
headers:
  Content-Type: application/json
  Authorization: Bearer <ARCANOS_CONTROL_PLANE_ACCESS_TOKEN>
  X-Confirmed: "yes"
body:
  action: bookEvent
  payload:
    universeId: "aew-2024"
    event:
      name: "AEW Daily's Place"
      date: "2024-09-20"
success_response:
  description: Universe-scoped booking result plus _route metadata.
```

The dedicated Builder configuration instead imports
`contracts/backstage_booker.openapi.v1.json`. Its non-consequential
`getBackstageUniverse` operation reads one exact ID at
`GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}`. The
read is bounded, returns `hasPersistedData: false` when that scope has no stored
rows, and exposes neither a universe list nor display-name lookup. Its
`getBackstageStoryline` operation reads one exact canon key through the
fixed `.../universes/{universeId}/storyline-summary` leaf. It returns the
unmodified summary in 4,000-code-point pages and requires the page-zero version
on every continuation. Its
`writeBackstageCanon` operation accepts only `upsertStoryline` and
`appendCanonBeat` at the exact
`POST /gpt-access/capabilities/v1/backstage-booker/run` path. ChatGPT Builder
stores the distinct `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` as API Key/Bearer
authentication; it is not OAuth or a user password. Only the write operation
is marked consequential, and that narrow lane relies on ChatGPT's Allow/Deny
banner as its one approval step rather than issuing a second backend challenge.
The Builder contract declares the same saved Action bearer on
`runBackstageBooker` so private Notion continuity queries and generation always
have verified request-local provenance. The legacy one-to-three-page supplement adds no
operation and remains subordinate to PostgreSQL; non-authoritative direct
backend clients retain the existing public generation behavior without it.
Phase One mutations, generic GPT Access credentials, and
direct/control-plane/legacy aliases retain their existing challenge flow. The
dedicated bearer never grants generic or control-plane access. The write lane
may bypass generic `ARCANOS_GPT_ACCESS_SCOPES` `capabilities.run`
authorization, but the exact `MCP_ALLOW_MODULE_ACTIONS` allowlist remains
mandatory. Phase One mutations are unavailable on the dedicated lane, and
`universeId` remains data scope, not authorization: any holder of the shared
dedicated bearer can read any valid exact universe ID and any exact storyline
key within that scope. If Notion enrichment is configured, it can also invoke
generation for any universe present in the server-owned page mapping; keep this
GPT private within one trust domain.

A separately configured Notion-authority mode keeps the same four Builder
operations but changes the server-owned source policy for an exact universe.
`queryContinuity` performs bounded RAG over one fresh immutable Notion snapshot
and requires the saved bearer. Its optional `retrievalScope` requires the exact
`pageTitle`, with optional `pagePath` to disambiguate duplicate titles.
`scopeKind` defaults to `"page"`, which may use `sectionPath` for an exact
heading subtree. Explicit `scopeKind: "subtree"` includes the exact parent and
all descendant pages but no siblings, can anchor on a blank navigation parent,
and rejects `sectionPath`. The default `relevant` mode is a bounded sample;
subtree samples are diversified across pages. `complete_scope` continues with
only the opaque `nextCursor` returned for the unchanged query, scope, kind, and
mode. That cursor is tamper-resistant and bound to the active snapshot and
request; nonretryable `BACKSTAGE_NOTION_CURSOR_INVALID` requires a new
cursor-free first page. Version-2 cursors are invalid after the 1.4.0 rollout.
The action stays synchronous and request-local and is never queued.

All responses report chunk coverage. Only subtree responses additionally set
`resolvedScope.scopeKind: "subtree"` and report `scopePages`, `selectedPages`,
and `omittedPages`. Callers must honor sampled status, positive omitted counts,
`promptTruncated`, `exhaustive`, and `hasMore` rather than present a bounded
response as complete. `sources` contain sanitized titles, paths, categories,
and opaque hashes only—no raw excerpts or Notion page IDs.
The two legacy PostgreSQL reads and all canon writes return explicit
nonretryable quarantine/read-only errors. Notion is one-way authority, while
the backend database stores only the derived AI index and retained recovery
history. The GPT must never treat retrieved Notion text as instructions or
bypass a missing/stale index through legacy state. Answer generation performs
one compact retry only when the provider reports max-output exhaustion; it does
not retry other provider failures. A second length exhaustion or an enforceable
exact/maximum compact-contract violation returns the sanitized incomplete-output
error without a third generation attempt. Schema `1.4.0` materializes these public
payload/result fields and declares the bearer and authority-specific errors;
deploy it first, then re-import it into the existing Builder Action before
validating this mode.

See [BACKSTAGE_BOOKER_CUSTOM_GPT.md](BACKSTAGE_BOOKER_CUSTOM_GPT.md) for exact
Builder, instruction, security-tradeoff, rotation, and rollback guidance. Never
put the credential in the imported schema, GPT instructions, chat, source, or
logs.

### Arcanos Gaming
**What it is:** A Core-managed, non-privileged Custom GPT module for gameplay guides, builds, and meta advice. The `ARCANOS:GAMING` module exposes only the `query` action, validates `mode` as `guide`, `build`, or `meta`, and forwards the validated request to the Gaming pipelines without exposing Core control-plane capabilities. (`src/services/arcanos-gaming.ts`) (`src/services/gamingModes.ts`)

**Known GPT IDs:** `arcanos-gaming`, `gaming`. The catalog registers `arcanos-gaming.ts` at route `gaming`, and both GPT IDs are pinned to `ARCANOS:GAMING` in direct dispatch so environment overrides cannot route them to Core. (`src/services/arcanos-gaming.ts`) (`src/services/moduleCatalog.ts`) (`src/routes/_core/gptDispatch.ts`)

**Available actions (via `/gpt/<gpt-id>`):**
- `query`
(`src/services/arcanos-gaming.ts`)

**Dedicated builder operations:**

- `queryArcanosGaming` → `POST /gpt/arcanos-gaming` for gameplay.
- `canaryArcanosGaming` → `POST /gpt/arcanos-gaming/canary` for bounded public-pipeline verification.
- `ingestGamingSources` → `POST /gpt-access/gaming/sources/ingestions` for authenticated asynchronous ingestion of one to four public HTTPS URLs.
- `refreshGamingSources` → `POST /gpt-access/gaming/sources/refreshes` for authenticated refresh of one to four known source IDs.
- `getGamingSourceIngestionStatus` → `GET /gpt-access/gaming/sources/ingestions/{ingestionId}` for authenticated sanitized source-level status.

The module itself still exposes only `query`. The canary is a route-level public protocol and never invokes the Gaming module, writing pipeline, provider, persistence, or control-plane code. The three source lifecycle operations are separate narrow GPT Access capabilities protected by Bearer authentication; they do not expose generic job, queue, worker, database, or control-plane inspection.

**Spec sheet example:**
```yaml
name: Arcanos Gaming
gpt_id: arcanos-gaming
base_url: https://<your-backend>
endpoint: /gpt/arcanos-gaming
method: POST
headers:
  Content-Type: application/json
body:
  action: "query"
  payload:
    mode: "guide"
    prompt: "Give me beginner tips for surviving the first night."
    game: "Minecraft"
success_response:
  description: Direct Gaming module response envelope plus _route metadata for `ARCANOS:GAMING`.
```

**Payload contract:** Public gameplay calls require body `action: "query"`; the Gaming dispatcher does not select an action from a query parameter, header, or operation alias. `mode: "guide"` needs a prompt and may include `game`; `mode: "build"` and `mode: "meta"` require both `prompt` and `game`. Optional `url`, `urls`, `guideUrl`, `guideUrls`, `audit` / `enableAudit`, and `hrc` / `enableHrc` fields are validated by `gamingModes` before any pipeline runs. Candidate URLs can be supplied on the initial query and are always untrusted: ARCANOS must fetch and validate a page before it can become evidence. When callers send a partial explicit `payload`, top-level Gaming fields are merged only where the explicit payload omits them; explicit `payload` fields keep precedence.

**Dispatcher boundary:** Classification uses only the validated public envelope and original user prompt. It never uses fetched source text, search snippets, translated prompts, enriched context, guide titles, retrieved HTML, or provider output. An obviously operational prompt under any gameplay mode is rejected with `OPERATIONAL_REQUEST_NOT_GAMEPLAY` and an instruction to invoke the public canary; it is not silently rewritten. For example, `Reach my backend and see if this has been implemented correctly.` is operational, while `How do dedicated server settings affect Pal spawning?` and `Is this early-game base build working correctly?` remain gameplay.

**Public canary:** `canaryArcanosGaming` accepts exactly `{ "action": "canary", "payload": { "scope": "public_pipeline" } }`. It verifies request validation, deterministic dispatch, the fixed public route, bundled fixture marker `ARCANOS_PUBLIC_CANARY_7F31`, deterministic grounding/projection, response construction, and the response guard. Network retrieval and provider execution are explicitly `skipped`. The canary is not administrative health and exposes no logs, secrets, credentials, environment values, infrastructure or deployment details, filesystem paths, job, queue, database, worker, or control-plane data. See [ARCANOS_GAMING_CUSTOM_GPT.md](ARCANOS_GAMING_CUSTOM_GPT.md) for the disposable PR-preview Action procedure; direct preview HTTPS tests are not full ChatGPT Action end-to-end proof.

**Frontend candidate discovery:** The dedicated builder schema exposes all five operations, but each gameplay workflow still makes one `queryArcanosGaming` call. For current or source-sensitive gameplay requests, Web Search may discover two to four URL candidates before that gameplay call, but its text never supplies evidence or route selection directly; ARCANOS must fetch, validate, and return every citable source. Durable ingestion is used only when the user explicitly asks to ingest, add, store, or remember sources. In that flow, the GPT sends one to four public HTTPS URLs—not snippets or page contents—to `ingestGamingSources`, then polls only the returned ingestion ID. See [ARCANOS_GAMING_CUSTOM_GPT.md](ARCANOS_GAMING_CUSTOM_GPT.md) for the exact builder instructions and examples.

**Source lifecycle contract:** Ingest requires `game`, one to four unique `sourceUrls`, and `idempotencyKey`; optional `sourceTypeHint`, `patchVersion`, and `origin` fields are closed and bounded. Refresh requires one to four UUID `sourceIds` plus `idempotencyKey` and never accepts a replacement URL. Both writes return `202` with an `ingestionId`; `getGamingSourceIngestionStatus` exposes bounded overall and per-source states, record counts, safe error codes, provenance, and timestamps. Stored query results may include optional `sourceId`, `sourceType`, `patchVersion`, `fetchedAt`, `title`, and `origin: "stored"` alongside the compatible `url`, `snippet`, and `error` fields.

**Boundary:** Gaming can call its own module action through `/gpt/arcanos-gaming` or `/gpt/gaming`. The separate canary path performs only its closed public checks. Source mutation and status are fixed authenticated `/gpt-access/gaming/sources/*` capabilities, not module actions or generic control-plane access. None of these operations can run `runtime.inspect`, `workers.status`, `queue.inspect`, `self_heal.status`, `system_state`, generic job results, MCP control actions, DAG control actions, Core diagnostics, raw database reads, or source deletion/approval.

### Arcanos Core
**What it is:** The primary ARCANOS entryway for the main custom GPT. The `ARCANOS:CORE` module sends prompt-first requests through the Trinity brain so the main GPT can use the general ARCANOS pipeline without being coupled to tutor-specific logic.

**Canonical GPT ID:** `arcanos-core`. The protected GPT Access job endpoint accepts the exact case-insensitive compatibility alias `arcanos` and canonicalizes it to `arcanos-core`. Registered compatibility IDs `core` and `arcanos-daemon` also resolve. `default` is not a built-in ARCANOS alias. The catalog registers `arcanos-core.ts` at route `core`.

**Protected Custom GPT workflow:** Import `/gpt-access/openapi.json`, keep Bearer authentication in the GPT Action configuration, call `createAiJob` with `gptId: "arcanos-core"` and the complete user request in `task`, then poll `getJobResult` with the returned `jobId`. Runtime, worker, queue, MCP, diagnostics, and job-result operations must use their dedicated `/gpt-access/*` operations, never `/gpt/<gpt-id>`.

The direct `/gpt/<gpt-id>` `query` action remains the canonical writing-plane integration for module-bound and non-protected callers; it is not the main Custom GPT's protected backend job path.

**Direct-answer output contract:** Trinity direct-answer mode returns a user-visible text string inside the route JSON envelope. Plain strings such as `OK` or `OBSERVABILITY_SMOKE_TEST_OK` are valid inner `result` values when the caller requested an exact literal, but callers should not expect the entire HTTP response body to be raw text. Exact-literal smoke prompts should use compact phrasing such as `Return exactly OBSERVABILITY_SMOKE_TEST_OK.` so the deterministic literal shortcut can bypass generative formatting while preserving the normal route envelope.

**Observability smoke:** Use `action: "health_echo"` through `/api/bridge/gpt` when the goal is to exercise request handling, queueing, worker execution, and job-result retrieval without invoking Trinity. Use `action: "query"` only when the smoke must exercise the AI module itself.

**Spec sheet example:**
```yaml
name: Arcanos Core
gpt_id: arcanos-core
base_url: https://<your-backend>
openapi: /gpt-access/openapi.json
create_operation: createAiJob
result_operation: getJobResult
authentication: Bearer credential configured in the GPT Action
create_body:
  gptId: arcanos-core
  task: "Give me a direct answer using the main ARCANOS pipeline."
success_response:
  description: A queued job followed by a completed result from the protected GPT Access job-result operation.
```

### Arcanos Tutor
**What it is:** A professional tutoring kernel with modular learning flows, research augmentation, and auditing traces. The `ARCANOS:TUTOR` module accepts a `TutorQuery` that selects a domain/module pipeline and returns a structured response with audit traces. (`src/services/arcanos-tutor.ts`) (`src/core/logic/tutor-logic.ts`)

**Known GPT IDs:** `arcanos-tutor`, `tutor`. The catalog registers `arcanos-tutor.ts` at route `tutor`. (`src/services/arcanos-tutor.ts`) (`src/services/moduleCatalog.ts`)

**Available actions (via `/gpt/<gpt-id>`):**
- `query`
(`src/services/arcanos-tutor.ts`)

**Spec sheet example:**
```yaml
name: Arcanos Tutor
gpt_id: arcanos-tutor
base_url: https://<your-backend>
endpoint: /gpt/arcanos-tutor
method: POST
headers:
  Content-Type: application/json
body:
  prompt: "Explain session memory round-trips in under 250 tokens."
success_response:
  description: Tutor response with audit_trace and _route metadata.
```

## Validation Checklist (Minimal Test Plan)
- **Happy path:** Call `/gpt/<gpt-id>` with a valid `action` and `payload` and confirm `_route` metadata returns for the matched module. (`src/routes/gptRouter.ts`)
- **Edge case:** Use an unknown GPT ID and confirm a `404` typed error with code `UNKNOWN_GPT`. (`src/routes/gptRouter.ts`)
- **Failure mode:** Call a valid GPT ID with an invalid action and confirm a typed module error (normally `MODULE_ERROR` with safe action/module guidance). (`src/services/moduleRegistry.ts`)
- **Async bridge:** Confirm `query` creates one job, core `query_and_wait` completes through the direct action lane without bounded fallback text, non-core durable writes still use jobs, and `get_status` / `get_result` are rejected with direct endpoint guidance.
- **Failed async job inspection:** Query `/gpt-access/jobs/timeline` with the job id to inspect lifecycle events, and `/gpt-access/logs/query` for sanitized operational logs. `MODULE_ERROR` validation failures should expose safe fields such as validator name and issue codes, not prompts, completions, provider payloads, headers, or secrets.
- **Fast path:** Confirm `executionMode: "fast"` for a prompt-generation request returns `200`, `routeDecision.path: "fast_path"`, `x-gpt-fast-path-queue-bypassed: true`, and `x-gpt-queue-bypassed: true`.
- **Guardrail:** Confirm prompt-based and action-shaped job retrieval is rejected and callers are pointed at direct `/jobs/*` or protected GPT Access result operations.
