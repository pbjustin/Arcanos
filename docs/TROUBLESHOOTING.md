# Troubleshooting

## Overview
Common production and local issues for backend, daemon, OpenAI integration, and Railway deployment.

## Prerequisites
- Access to application logs (local terminal or Railway logs).
- Access to environment variables used by the failing environment.

## Setup
Before debugging, collect:
1. Exact command used.
2. Exact error message and timestamp.
3. Current environment (`NODE_ENV`, deployment target, branch).

## Configuration
Quick config checks:
- Local backend defaults to port `3000` if `PORT` is unset; set `PORT=3000` in `.env` for deterministic local runs.
- Railway injects `PORT`; do not hard-code it in Railway variables.
- Railway launcher requires `ARCANOS_PROCESS_KIND=web` or `ARCANOS_PROCESS_KIND=worker`.
- Live AI requires `OPENAI_API_KEY`.
- PostgreSQL persistence requires `DATABASE_URL`.
- Daemon debug server should have `DEBUG_SERVER_TOKEN` when enabled.

## Run locally
Helpful probes:
```bash
npm run build
npm start
curl http://localhost:3000/healthz
```

Daemon probe:
```bash
npm run validate:backend-cli:offline
```

For the daemon-side live contract validator, use `python daemon-python/scripts/validate_backend_cli.py` only against an explicitly selected backend target.

## Deploy (Railway)
Post-deploy checks:
```bash
railway status
railway logs --service <web-service> --environment production
curl https://<your-service>.up.railway.app/healthz
curl https://<your-service>.up.railway.app/health
curl https://<your-service>.up.railway.app/readyz
```

If failing, inspect Railway build/deploy logs first.

## Troubleshooting
- `ARCANOS_PROCESS_KIND is required`: set `ARCANOS_PROCESS_KIND=web` on the API service or `ARCANOS_PROCESS_KIND=worker` on the worker service, then redeploy.
- Web service starts as the wrong role: run `railway variable list --service <service> --environment production` and verify `ARCANOS_PROCESS_KIND`.
- Worker health is green but jobs stay queued: confirm `DATABASE_URL`, `OPENAI_API_KEY`, worker logs, and `GET /worker-helper/health`.
- Local port confusion: use `PORT=3000` in `.env`; Railway probes the injected `PORT` and `/readyz` during deployment activation.
- Production startup fails OpenAI configuration validation: verify that a real `OPENAI_API_KEY` is present without printing its value. Mock fallback is for explicit non-production/test paths and is not the normal production behavior.
- Control-plane 401: send the dedicated `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN` bearer credential; confirmation and approval values are not authentication.
- Backstage Booker `CONFIRMATION_REQUIRED` from `writeBackstageCanon`: the
  request used the unchanged generic GPT Access path instead of the dedicated
  canon lane, or the deployed Builder/backend configuration is stale. Verify
  the exact deployed contract, the saved Action's API Key/Bearer mode, and the
  presence of the distinct `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` without
  printing it. Do not lengthen `CONFIRMATION_CHALLENGE_TTL_MS` or substitute a
  generic/control-plane credential as a workaround.
- Backstage Booker `BACKSTAGE_BOOKER_ACCESS_ACTION_DENIED` 403: the dedicated
  credential reached the exact canon route with an action other than
  `upsertStoryline` or `appendCanonBeat`. Phase One and public actions are
  unavailable on this lane; use only the operations exposed by
  `contracts/backstage_booker.openapi.v1.json`.
- Backstage Booker `getBackstageUniverse` returns `401`: verify the saved Action
  uses the dedicated `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` in API Key/Bearer
  mode. The generic GPT Access token is deliberately rejected. A retryable
  `BACKSTAGE_UNIVERSE_READ_UNAVAILABLE` instead means the bounded PostgreSQL
  snapshot failed; it never means the universe was empty.
- Backstage Booker `getBackstageStoryline` returns `404`: the exact
  universe/key pair did not match a stored durable canon storyline. Preserve
  the key exactly; do not create or rewrite canon as a read workaround. A
  `BACKSTAGE_STORYLINE_VERSION_CONFLICT` means canon changed between pages:
  discard every collected page and restart at offset 0. A retryable
  `BACKSTAGE_STORYLINE_READ_UNAVAILABLE` is a PostgreSQL read failure, not a
  missing or empty summary. A `401` has the same dedicated-Bearer checks as
  `getBackstageUniverse`.
- Backstage Booker canon call has no ChatGPT Allow/Deny banner: re-import the
  deployed `backstage_booker.openapi.v1.json`, verify `writeBackstageCanon` is
  marked consequential, save the existing GPT, and reopen it before testing.
  Do not send the mutation until the banner is present.
- Backstage Booker generation does not use the configured Notion pages: verify
  both Notion variables are present only on the web service, the exact universe
  ID is mapped to raw page UUIDs, and the integration has read-content access
  to each shared page. Then confirm the request carries the existing dedicated
  Backstage Action bearer by looking only for the sanitized
  `backstage.notion_context.loaded` event—never log the header, Notion token,
  mapping, or page body. Missing/invalid bearer or Notion configuration,
  unmapped universes, provider failures, and PostgreSQL-context fallback all
  intentionally keep generation database-only. If Builder omits the bearer on
  `runBackstageBooker`, deploy and re-import schema `1.6.0` from the live
  no-store contract endpoint, verify the operation declares `bearerAuth`, and
  resave the Action. The endpoint serves the tracked canonical `1.6.0` Builder
  contract directly; do not weaken the backend gate.
- Backstage Booker accepted generation asks for `jobReadToken`, follows
  `/jobs/{jobId}/result`, or tries an SSE stream: the Builder is using the
  generic job contract or stale instructions. Re-import the
  live `1.6.0` schema and verify `getBackstageBookerJobResult` uses
  `/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result` with the
  saved bearer, returns no dynamic token or stream, and is called with the exact
  original `jobId`. Do not resubmit the generation while polling.
- Backstage Booker `BACKSTAGE_NOTION_INDEX_UNAVAILABLE`: for an authoritative
  universe this is deliberately fail-closed. Verify the identical authority
  root mapping is present on web and worker, the Notion token is present only
  on worker, the fixed root is shared with read-content access, the worker
  completed a full crawl, and `last_verified_at` is within the configured
  staleness limit. After a heading-index format rollout, this error can also
  mean the active snapshot predates heading indexing. The new worker remains
  unready until all configured inventories expose the current page-level
  index/heading marker; it performs one synchronous rebuild when needed, and a
  `lease-busy`, failed/omitted result, or still-old database reload fails that
  deployment before web promotion. Resolve the competing lease or sanitized
  sync failure and let a fresh worker attempt complete the rebuild. Do not patch
  legacy rows or
  treat missing heading metadata as an empty path. Inspect only sanitized
  counts/status. Do not print page
  bodies, page IDs, embeddings, tokens, or provider errors, and do not remove
  the authority mapping to make legacy fallback work.
- Backstage Booker `BACKSTAGE_NOTION_SCOPE_UNRESOLVED`: a `404` means the exact
  `retrievalScope.pageTitle` or `sectionPath` was not found; a `409` means the
  page title matched more than one page or the exact section path matched
  repeated heading occurrences. Preserve the exact `universeId` and query.
  Correct the title/section or add the full `pagePath` to disambiguate a page.
  Remember that omitted `scopeKind` means one exact page. Use explicit
  `scopeKind: "subtree"` only for that parent plus its descendants; it excludes
  siblings, can resolve a blank navigation parent, and cannot be combined with
  `sectionPath`. A subtree-plus-section request is invalid input, not a missing
  Notion page.
  For repeated headings, query the parent/page scope or distinguish the
  headings in Notion; never silently combine them, substitute a raw Notion page
  ID, broaden to legacy state, or invent an answer.
- Backstage continuity answer looks incomplete without an error: inspect the
  structured `coverage`. `status: "sampled"`, positive `omittedChunks`,
  `promptTruncated: true`, or `hasMore: true` is an explicit limit. Use
  `complete_scope` from the first request and pass only the opaque
  `nextCursor` with the exact unchanged universe, query, scope, kind, and mode
  until `hasMore` is false. A `relevant` request is intentionally a sample;
  subtree samples are diversified across pages, but still are not exhaustive.
  Only subtree results set `resolvedScope.scopeKind: "subtree"` and add
  `scopePages`, `selectedPages`, and `omittedPages`; positive omitted page counts
  are also an explicit limit. Page, section, and unscoped responses omit those
  subtree-only fields. Sources are sanitized opaque metadata, not retrievable
  excerpts or Notion page IDs.
- Backstage Booker `BACKSTAGE_NOTION_CURSOR_INVALID` 409: the opaque
  `complete_scope` cursor was malformed or tampered with, the query/scope/mode
  changed, or the worker activated another snapshot between pages. It is
  nonretryable as supplied. Discard the collected pages and restart the same
  scoped request without a cursor; never decode, edit, or transfer a cursor to
  another request. Cursor version 2 is deliberately invalid after the 1.4.0
  rollout and requires the same cursor-free restart. `queryContinuity` is
  request-local and synchronous-only, so do not enqueue it or look for a worker
  job to resume. If Builder does not expose `scopeKind`, deploy schema 1.6.0
  first, re-import it into the existing Action, and preserve the saved bearer.
- Backstage Booker `BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE`: the original attempt
  exhausted the provider output limit. The backend permits at most one compact
  retry only when its finite runtime and output recovery budgets remain
  available; otherwise telemetry records
  `compact_retry_skipped_insufficient_budget`. An executed retry reuses the same
  retrieval and token budget, and the terminal error can also mean that retry
  exhausted the limit again or failed its enforceable output contract. An
  unambiguous request for one numbered paragraph
  per item with an explicit per-item word maximum receives the same compact
  shape instructions on the first attempt. They request one numbered paragraph
  per requested item, no headings or sub-bullets, explicitly requested fields
  inline, at most 125 words per item without relaxing a tighter caller maximum,
  and a total target that scales down with the existing token cap, the requested
  item count, and the caller maximum and never exceeds 1,000 words. Three items
  at 100 words each are therefore capped at 300 words. Qualified maximums stay
  maximums; ranges, corrections, per-group counts, and conflicting counts
  preserve the caller's constraints instead of inventing an exact count. The
  backend validates final numbered shape, consecutive count, and derived word
  ceilings for unambiguous exact and qualified-maximum policies after the retry;
  the initial attempt remains prompt-guided. Ambiguous
  count semantics and requested-field contents remain prompt-guided. Only a
  prompt with no recognized item-count constraint uses at most eight items. The
  retry stops after the final item. Other provider failures are not retried, and
  a malformed compact retry does not start a third attempt. Report the sanitized failure
  without exposing or presenting partial provider text, and do not
  automatically retry, decompose the request, or fan it out into replacement
  generation calls. A client must send one generation call per requested card
  or booking task unless the user explicitly asks for separate independent
  alternatives; concurrent client calls are separate full provider attempts,
  not parts of the backend retry.
- Backstage Booker `BACKSTAGE_CONTINUITY_QUERY_FAILED`: the backend could not
  safely complete the bounded continuity answer. The nonretryable envelope
  deliberately omits the provider cause. Do not infer or expose that cause,
  substitute legacy canon, or automatically start another query; a later
  user-initiated request may be narrowed and tried again.
- Backstage Booker `BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE`: the backend could
  not safely reconcile the configured root with the durable PostgreSQL
  authority head. Treat it as retryable infrastructure/configuration failure;
  verify the exact web mapping and database availability without printing the
  mapping or connection details. Removing the mapping is not a rollback after
  activation and must never be used to reopen legacy state.
- Backstage Notion sync reports incomplete/source drift: an inaccessible,
  moved, trashed, malformed, truncated, unknown, database, or media/file page
  was observed, or a page changed during the two-pass capture. The prior active
  snapshot remains intact. Correct/share the Notion hierarchy or add a reviewed
  extractor, then let a later full cycle retry. Never classify a transient 404
  as deletion or activate a partial manifest.
- Backstage `BACKSTAGE_NOTION_AUTHORITY_READ_ONLY` or
  `BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED`: this is the expected authority
  boundary, not data loss. Make the requested fact/content change in Notion and
  wait for sync; use authenticated `queryContinuity` through
  `runBackstageBooker` for retrieval. Do not
  bypass through a direct, generic GPT Access, worker, legacy, or raw database
  write/read path.
- Worker-control 401: verify `ARCANOS_WORKER_HELPER_TOKEN` is an exact 32–4096 character non-placeholder value with no whitespace and does not equal another credential in the canonical ARCANOS application-auth registry. Send it through either one `x-arcanos-worker-helper-token` header or one Bearer Authorization header, never both; duplicate or normalized credentials fail closed.
- Worker-heal 429: direct `/workers/heal` and `/worker-helper/heal` share one
  10-request/15-minute budget per server-derived authenticated
  principal/context bucket. Wait for the bounded retry interval instead of
  switching endpoints; credential values are never used as rate keys.
- Worker-helper CLI fails before making a protected request: set a valid, non-colliding `ARCANOS_WORKER_HELPER_TOKEN` in the process environment. Token, worker-helper-token, and Authorization CLI flags are rejected. The public `status` command remains token-free.
- Worker-helper CLI rejects its destination: use an exact explicit HTTPS origin in `ARCANOS_BASE_URL` or `--base-url`, with no user information, path, query, or fragment. Exact HTTP is accepted only for loopback. Protected requests reject redirects.
- Remote worker repair actuator is unavailable: configure the same valid `ARCANOS_WORKER_HELPER_TOKEN` on caller and target, then check `SELF_HEAL_WORKER_SERVICE_URL`, `WORKER_HELPER_BASE_URL`, `RAILWAY_SERVICE_ARCANOS_WORKER_URL`, and `ARCANOS_WORKER_PUBLIC_URL`. Every configured alias must be valid and normalize to the same exact HTTPS origin; exact loopback HTTP is the only exception.
- Remote worker repair reports an invalid response: the target must return at most 64 KiB of JSON with matching `requestedForce` and boolean `restart.started`, `restart.alreadyRunning`, and `restart.runWorkers` fields plus a bounded non-empty `restart.message`. The target message and arbitrary fields are validated but discarded; the actuator generates its own result message.
- Control-plane `CONTROL_PLANE_SCOPE_DENIED` 403: grant the operation's allowlisted scope through `ARCANOS_CONTROL_PLANE_SCOPES`; request-body scopes are ignored.
- Prompt or AI-routing debug 401/403: both read surfaces require the
  control-plane bearer, operator principal, and `arcanos:read`. Missing trace
  content is expected in default `metadata` mode. Disk output additionally
  requires exact `PROMPT_DEBUG_TRACE_PERSIST=true` and a valid
  `PROMPT_DEBUG_TRACE_MAX_BYTES`; setting only `PROMPT_DEBUG_EVENTS_PATH` does
  not enable persistence.
- Prompt-debug persistence stops growing: the configured byte cap was reached.
  The service preserves bounded in-memory evidence and does not rotate,
  truncate, or delete the JSONL file. Rotate or remove that exact file only
  through a separately approved operator procedure.
- Diagnostic-execution 403: `/devops/self-test` and
  `/devops/daily-summary` require `diagnostics:execute`;
  `/api/pr-analysis/analyze` requires `repo:verify`. A 409 means a matching
  operation is already running in that process; wait for it to finish rather
  than switching between the two DevOps aliases.
- Legacy operator 403: SDK/orchestration reads require `arcanos:read`; SDK
  mutations and orchestration reset/purge require `mcp:invoke`, followed by the
  existing confirmation header or challenge. Confirmation without the bearer
  remains a 401. A 409 means the matching SDK or orchestration mutation family
  already has an in-process operation running.
- System-state 401/403/503: configure the purpose-bound control-plane bearer
  and operator principal. GET/HEAD requires `arcanos:read`; POST requires
  `mcp:invoke` and then the one-use challenge returned in
  `x-confirmation-challenge`. Retry the unchanged body with
  `x-confirmed: token:<challenge>`; `x-confirmed: yes`, trusted-client, and
  automation shortcuts do not approve this mutation. Authentication runs
  before the dedicated 64 KiB JSON parser, so an unauthenticated malformed body
  still returns the authentication denial. This boundary is operator
  containment, not tenant or session ownership.
- Direct RAG 401/403/413: configure the same purpose-bound control-plane bearer
  and operator principal, grant `arcanos:read` for `/rag/query` or `mcp:invoke`
  for `/rag/fetch|save`, and retry ingestion with the issued one-use challenge.
  Oversized, compressed, non-object, or schema-invalid JSON is rejected before
  provider or database work; fixed per-operation limits are documented in
  `docs/API.md`. The routes address one shared operator corpus rather than
  tenant-owned data. A `RAG_OPERATION_BUSY` 429 means both HTTP work slots are
  occupied; excess requests are not queued, so retry after the response's
  `Retry-After` interval.
- Self-healing `CONTROL_PLANE_SCOPE_DENIED` 403: passive `/api/self-heal/*`, `/api/self-improve/status`, and detailed safety diagnostics require `arcanos:read`; active provider probes add `self-heal:probe`; decisions require `self-heal:decide`; a decision body with `execute: true` adds `self-heal:execute`; manual self-improve runs require both decision and execution scopes; and freeze, unfreeze, autonomy changes, or integrity-quarantine release require `self-improve:control`. Missing scope names are intentionally omitted from the public response.
- Self-heal decision still returns a capability 401/403 after valid bearer authentication: the route deliberately retains `capabilityGate('self_improve_admin')` as a compatibility prerequisite. Supply an authorized agent identity or the configured automation credential; neither one is identity-bound authorization or replaces the control-plane bearer.
- Confirmation-required 403: include `x-confirmed` or trusted automation headers only after authenticating and satisfying server-owned scope authorization.
- Control-plane 503: configure a valid, purpose-bound access token, principal ID, and scopes; control-plane POST, protected DevOps/PR execution, legacy SDK/orchestration control, `/api/self-heal/*`, `/api/self-improve/*`, detailed self-heal status, and quarantine release fail closed when that optional configuration is absent or invalid.
- Integrity quarantine recovery: read the public summary first, fetch the raw ID from authenticated `GET /status/safety/self-heal` with `arcanos:read`, then call `POST /status/safety/quarantine/:id/release` with `self-improve:control` and exact confirmation. Legacy `ADMIN_KEY`, `x-api-key`, `x-operator-id`, or confirmation alone do not authorize release.
- Daemon `DAEMON_AUTH_REQUIRED` 401: verify the Python process sends exactly one
  `x-arcanos-daemon-token` and that its exact
  `ARCANOS_DAEMON_ACCESS_TOKEN` matches the backend. Bearer, GPT-ID, cookie,
  query, and body values are not accepted.
- Daemon `DAEMON_AUTH_UNAVAILABLE` 503: configure a valid, non-placeholder,
  whitespace-free 32–4096 character `ARCANOS_DAEMON_ACCESS_TOKEN` on the
  backend, distinct from every other purpose-bound credential. Restart the
  Python daemon after changing its value; backend configuration is read per
  request. A daemon 401 does not refresh the unrelated `BACKEND_TOKEN`.
- Health degraded for database: attach/configure PostgreSQL or accept in-memory mode.
- `MCP_BEARER_TOKEN not configured`: set `MCP_BEARER_TOKEN` before calling `POST /mcp`.
- `/brain` returns `410 Gone`: migrate the caller to `/gpt/:gptId`; set `ASK_ROUTE_MODE=compat` only as a temporary migration bridge.

## References
- `RUN_LOCAL.md`
- `RAILWAY_DEPLOYMENT.md`
- `CONFIGURATION.md`
- `API.md`
