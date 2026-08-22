# Railway Deployment Guide

## Overview
This runbook documents the repository-tracked Railway configuration and release safeguards for Arcanos. Tracked files do not prove the current live project linkage, environment state, or service topology.

## Prerequisites
- Approved Railway account and project access.
- A confirmed project, environment, and service target.
- Repository connection or GitHub-side deploy credentials configured through an approved operator workflow.
- Required secrets available (`OPENAI_API_KEY`; `DATABASE_URL` for durable async jobs; GPT Access variables when Custom GPT diagnostics are enabled).

## Setup
Run repository commands from the repository root. The install step recreates dependency state and invokes `postinstall`; outside CI/production, that hook may update local Git hooks, `.vscode/`, and `.workspace/`.

Pre-deploy checks, when their local side effects are acceptable:
```bash
npm ci --include=dev --no-audit --no-fund
npm run build
npm test
npm run validate:railway
```

`npm run validate:railway` validates tracked configuration locally. It does not inspect or validate a live Railway environment.
The ordinary local list also does not prove PostgreSQL-backed migrations,
locking, or atomicity: broad Jest runs may intentionally skip those suites when
their dedicated disposable-database URLs are absent. The authoritative tracked
proof is the required PostgreSQL 18 CI job under
`ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1`, followed by the fail-closed
`All Checks Complete` aggregate.

If any of the six runtime-owned `SAFETY_EXPECTED_HASH_*` pins is set on a
target service, the protected digest comparison is a required pre-cutover
gate. The tracked startup wrapper is authoritative because it evaluates the
already-built artifact inside the resolved service environment after real
candidate files are mounted. For a bounded manual readback inside that same
identified runtime, use
`npm run integrity:protected-digest:check:compiled`; do not run the self-building
source-workspace entrypoint in a pruned or live candidate runtime.
Runtime-owned candidates derive their exact application path and reject source
substitution; only the reserved `protected_json_file` manifest entry accepts an
explicit mapped source in a complete manual comparison. That tooling-only
entry has no runtime caller and is deliberately outside the automatic startup
gate; setting it requires a separate manual `--check-pinned` comparison and
does not create runtime enforcement. Proceed only when the
command exits zero and emits
`preCutoverComplete: true`. The digest evaluation never rotates pins or runtime
trust state. A GitHub checkout, ordinary CI, raw file checksum, or comparison
against copied sample files cannot attest provider variables or live volume
contents. See [Protected configuration digests](CONFIGURATION.md#protected-configuration-digests)
for the complete source and failure contract.

The tracked normal start command enforces the same comparison through
`scripts/start-railway-service-with-integrity.mjs` after service volumes are
mounted and before the web/worker role launcher runs. Its conditional
`--precutover` mode evaluates the six runtime-owned entries and skips only when
none of those pins is configured. Do not move this to a
Railway pre-deploy command: pre-deploy containers receive variables but do not
mount service volumes, so they cannot attest volume-backed candidates. Native
PR previews run this wrapper before the sealed preview launcher. Automatic gate output
omits candidate and expected digests from service logs while preserving fixed
per-entry statuses, error codes, and aggregate counts.

Railway project setup is an operator-only remote configuration change:
1. Create/select a Railway project.
2. Connect this GitHub repository.
3. Confirm Railway detected `railway.json`.

Apply the operational approval gate below before changing project or repository linkage.

## Configuration
Tracked Railway config (source: `railway.json`):
- Build: `npm ci --include=dev --no-audit --no-fund && npm run build`
- Start: `node scripts/start-railway-service-with-integrity.mjs`
- Deploy activation path: `/readyz`
- Health check timeout: `300`
- SIGTERM-to-SIGKILL drain ceiling: `60` seconds
- Restart policy: `ON_FAILURE` (`restartPolicyMaxRetries=10`)

Launcher behavior:
- `node scripts/start-railway-service-with-integrity.mjs` is the canonical normal Railway start command. It completes the read-only configured-pin gate before invoking the role launcher.
- `node scripts/start-railway-service.mjs` remains the canonical role launcher behind that gate.
- Native PR environments use the configured `node scripts/start-railway-service-with-integrity.mjs --pr-preview-app-safe-v1` override. The wrapper evaluates configured runtime-owned pins in the parent service environment and only then forwards the versioned argument to the role launcher. The launcher accepts only the exact `Arcanos-pr-<positive integer>` or `pr-<six hexadecimal characters>-<positive integer>` environment names and validates Railway project, environment, service, deployment, source-commit, role, and public-domain identity before creating the credential-empty contained child and importing application code. The gate is read-only and digest-redacted, but this ordering does not strengthen the separate malicious-PR boundary; untrusted code still requires provider-level secret isolation.
- The native PR web role starts `dist/start-native-pr-preview.js` directly, without registering runtime loader hooks, and gives it a nine-name child-environment allowlist containing only the version marker, derived PR/commit identity, role, listener, production mode, disabled-worker flag, and UTC timezone. It imports the real dependency-injected generic jobs router with immutable synthetic fixtures, the central `src/shared/researchRequest.ts` validator and storage-component helper, the real Research abort-drain wrapper with its narrow request-abort runtime, the contained Backstage storyline helpers and production-shared saved-storyline excerpt and canon-summary page projectors, Backstage route/Trinity timeout policy, the production-shared Backstage review and compact-retry contracts, Trinity direct-answer normalizer, Backstage continuity-query core, GPT route timeout resolver, HRC cache policy, the exact GPT identifier middleware with its pure lane resolver and identifier validator, and the config-free core used by the production MCP pre-parser, the pure predictive/reactive self-heal approval policy, and a local sealed Gaming contract-fixture layer. It does not import the normal Research, Backstage, dispatch, MCP, self-heal, or self-improve route, the configured MCP wrapper, confirmation middleware, hub, provider, fetcher, database connection, memory subsystem, or external persistence/effects integration. Only fixed health/readiness, synthetic status/result/cancellation cases, the exact `POST /research/contract`, `POST /backstage/storyline-contract`, `POST /backstage/generation-contract`, `POST /dispatch/gpt-identifier-contract`, `POST /mcp/body-cap-contract`, and `POST /self-heal/approval-contract` fixture selectors, fixed public Gaming canary/query payloads, and the bounded production-recognized Gaming-source namespace are reachable; external credential carriers, streams, and every unlisted route fail before parsing, while admitted fixture requests also reject content encodings before parsing. Research, storyline, generation, dispatch identifier, MCP, and self-heal approval selector requests contain only `{ "fixture": "<sealed-name>" }`. The saved-storyline selector executes the production-shared pure projector over 2,500 leading ECMAScript whitespace code points followed by 1,501 meaningful code points and proves a truncated 1,500-code-point excerpt. The summary-pagination selector executes the production-shared canon-summary projector over a server-owned 10,000-code-point mixed BMP/astral value and proves three exact pages, exact reconstruction, version fencing, scope and offset rejection, and distinct null versus empty pages. Both explicitly report `databaseBoundaryReached: false` and `sqlProjectionExecuted: false`; PostgreSQL 18 CI remains authoritative for the real SQL read. The seven generation selectors prove the shared Backstage route and model-stage budgets, HRC timeout-result cache isolation, full-review classification, token/style shaping and output normalization, the production-shared exactly-one compact-retry coordinator and strict final-output validator, plus continuity cursor-shape preflight, sampled/exhaustive and compact-retry policy prompts, prompt assembly, and public response projection through synthetic, credential-free seams; no model provider or protected effect is reachable; the Notion-authority selector's only external capability is the pinned credential-free edge canary described below. The existing review-completion selector silently executes the compact-retry assertion without changing its response, preserving coverage when the trusted lifecycle verifier predates the new detailed selector. The six self-heal approval selectors execute the shared semantic-digest-pinned policy for denied outcomes, coherent and incoherent completion, disabled legacy authorization, manual-controller independence, and production debug denial without importing or starting the normal loop or reaching any protected effect. Gaming inputs are fixed closed-schema payloads, and Gaming-source post-auth simulations use only fixed `x-native-preview-fixture` values plus a canonical `.invalid` URL; none carries credentials or a live URL. Ten server-owned Research fixtures exercise exact and over-limit non-BMP topic, URL count, URL item, and aggregate boundaries in JavaScript `String.length` units, a one-read normalized URL descriptor snapshot isolated from later source mutation, and the deterministic ASCII storage component capped at 97 UTF-8 bytes. The eleventh `workflow-cancellation-drain` fixture executes one real wrapper-owned timeout and three deterministic parent-abort scenarios across synthetic DNS, fetch, model, and persistence seams. It observes one active operation at abort, verifies that operation reaches zero before outward settlement, proves later seams never start and the same signal/deadline reaches every admitted seam, and detects post-settlement mutation. The live probe also rejects a response before the bounded 300 ms aggregate drain-proof window. Parent abort is disconnect-equivalent component evidence, not a literal TCP-disconnect test. The descriptor probe is constructed inside the server-owned fixture and does not claim that caller JSON can carry accessors or property descriptors. The storyline `lifecycle-exact` fixture calls the real validator, response selector, and repository transaction helper through a fresh per-request in-memory query adapter; two mutations prove the exact 16,384-byte beat boundary, 100-beat retention, fresh-read response, chronological newest-25 selection, and accepted-beat inclusion. The `payload-over` fixture proves a 16,385-byte beat is rejected before the repository helper. The MCP `effective-limits` fixture executes six server-owned, chunked, no-`Content-Length` JSON streams against the production parser core: exact and one byte over the hard 1 MiB maximum, a downward 512 KiB MCP setting, and a stricter 256 KiB global JSON setting. Exact bodies reach the synthetic downstream sentinel once; over-limit bodies return the fixed 413 `MCP_REQUEST_TOO_LARGE` response with `no-store`/`no-cache` headers and never reach that sentinel. The dispatch identifier selectors invoke the exact production middleware with server-owned 40,000-code-unit action metadata: 256 code units continue exactly once into a no-effect sentinel, while 257 code units return the intact bounded `400 BAD_REQUEST` envelope with zero downstream calls, no truncation, and no attacker-controlled reflection. These are component E2Es: the storyline surface does not reach PostgreSQL or prove SQL-engine locking or atomicity, for which the PostgreSQL 18 CI suite remains authoritative; the summary selector does not invoke the normal protected GET or bearer authentication; the compact-retry surface does not invoke the canonical route, a real model provider, HRC, RAG, or persistence; the MCP surface is not a literal oversized public upload and does not prove normal `/mcp` composition, authentication, compression, or slow-upload behavior; and the dispatch surface does not prove normal `/dispatch` composition, authentication, a real admission/quota store, or provider work. Focused assembled-app tests remain authoritative for those properties. No fixture uses credentials, providers, memory, confirmation, or protected effects. Successful Research validation is reported only as eligible for confirmation; confirmation is never attempted and no effects boundary is crossed. The import graph is build-gated against database connections, unreviewed database modules, provider, worker, metrics, confirmation, broad route registry, and other production side-effect modules. Its fail-closed syntax gate also rejects ambient capability aliases, dynamic/rest namespace access, listener aliases, unreviewed external bindings, mutable `process` state (including scalar-member writes) and whole-object escapes, unreviewed process effects, sensitive-helper extraction/export/reassignment, pre-validation local runtime import/re-export edges, and launcher declaration or spawn-spec drift. Whole-process-object calls are tied to unique declarations, containing functions, exact counts, and full-call AST digests; direct mutable-object receiver calls are conservative, the child `Object.keys` receiver is identity-constrained, the launcher-relative repository root is immutable, and the normal-runtime environment spread plus critical resolver/environment/listener/output helpers remain digest-pinned reviewed exceptions. The complete launcher and contained-child entry files, the central Research helper, the exact request-abort runtime and Research drain wrapper, the exact storyline shared/repository and saved-storyline/summary projection seams, the Backstage action/Trinity timeout policy, Backstage review and compact-output contracts, Trinity direct-answer normalizer and instruction helper, Backstage continuity-query core, GPT route timeout resolver, HRC cache policy, pure public Gaming dispatcher/canary/fixture seam, pure self-heal approval policy, exact dispatch GPT identifier middleware and its lane/identifier dependencies, and config-free production MCP pre-parser core are additionally pinned by comment/format-normalized semantic digests: any semantic edit anywhere in those reviewed files requires a digest and focused-test update, while comment-only and format-only edits do not. A tracked checker-only resolver targets the reviewed request-abort source without requiring ignored `dist` output. The gate pins the public package export and build path, then a content-pinned post-alias check verifies the emitted preview imports and bindings resolve to `packages/arcanos-runtime/dist/requestAbort.js` and its comment-normalized semantic digest matches the reviewed compiled runtime. The Research helper admits only its exact `createHash` binding and pure `Reflect.ownKeys(descriptors)` read.
- Every successful Backstage generation selector executes the semantic-digest-pinned pure CLEAR composer used by production, assembles its server-owned authority/CLEAR ordering through the Trinity direct-answer message helper, and forces one synthetic length-exhaustion retry. Both attempts must contain exactly one fixed CLEAR marker/version and all five dimensions, reuse the same composed system policy, and keep caller and untrusted override sentinels outside that policy. Successful responses carry `x-arcanos-preview-backstage-clear-policy-version`; the PR-head verifier requires the fixed value while response bodies remain unchanged for the trusted base-pinned lifecycle verifier. This is contained construction, placement, and retry-reuse evidence, not canonical-route, live-provider, model-compliance, or booking-quality proof.
- The Backstage `phase-one-universe-binding` selector routes independent mutations through two universe-aware in-memory adapters and uses the pure confirmation-envelope builder shared with the production gate to prove that changing only `universeId` changes the fingerprint input. It does not issue or verify a confirmation token, connect to PostgreSQL, claim durable persistence, or cross an effects boundary.
- The Backstage `continuity-query-contract` selector executes the production-shared cursor-shape preflight, sampled/exhaustive and compact-retry policy prompts, prompt assembly, and exact-page public response projection over server-owned sealed input. The additive `continuity-subtree-contract` selector executes the same production-shared prompt/response core over sealed relevant, first-page, and final-page subtree projections. It proves subtree-only scope/page fields stay coupled, coverage totals and source paths remain bounded, incomplete subtree coverage fails closed, and the continuation request passes only shape/mode preflight. A paired worker request proves that the passive worker denies the generation-contract path with the contained 404. This is component evidence only: it does not invoke the canonical authenticated route, select or diversify live chunks, resolve hierarchy or execute recursive SQL, sign or verify a cursor MAC, read live PostgreSQL or Notion data, or call OpenAI or any other model provider.
- The Gaming fixtures intentionally do not import the exact production route handlers: that graph reaches configured authentication, source repositories, jobs, providers/fetching, and persistence capabilities excluded by the containment gate. The canary instead executes the semantic-digest-pinned pure production dispatcher, bundled-fixture validator/grounding runner, and response guard, so its `passed` checks represent work actually performed while network/provider stages remain `skipped`. Contract-faithful synthetic responses cover guide/build/meta queries, closed validation, operational guarding, and exact source-route unauthorized, unsafe, outage, idempotency, and queued/running/completed lifecycle semantics. A missing preview selector returns the production-shaped 401 before JSON parsing, including for malformed and over-limit bodies. The fixed `x-native-preview-fixture` selector is a noncredential simulation of post-auth behavior, not bearer-auth evidence, and each validation selector requires its exact server-owned invalid body. Every newly enabled Gaming response carries `X-Arcanos-Preview-Fixture: sealed-synthetic`; source responses also carry `Pragma: no-cache`. The strict canary body stays identical to the public schema and production guard, which allow no preview-only field, so the response header is its machine-readable provenance. These fixtures do not invoke a provider, fetch, database, queue, worker, repository, or persistence mutation.
- The native PR worker role remains the passive health-only server. The historical `--pr-preview-safe` flag remains available as an explicit passive fallback for both roles.
- Native application readiness reports `trustScope: trusted-pr-accidental-effects`, `protectsMaliciousPr: false`, and `requiresPlatformSecretIsolationForUntrustedCode: true`. Repository code cannot prevent a malicious PR from reading an inherited parent environment or removing its own guard. Do not enable native application previews for forks or untrusted contributors unless Railway prevents production/provider/database/Redis credentials and data from reaching the PR container before code starts.
- `npm run railway:probe:native-pr -- --pr-number <N> --commit-sha <SHA> --web-base-url https://<confirmed-web-pr-host> --worker-base-url https://<confirmed-worker-pr-host>` performs a no-network dry run. It fails unless the canonical Arcanos `origin`, local HEAD, and an entirely clean tracked/untracked worktree match the supplied commit evidence. Add both `--execute --allow-network` only after independently confirming those two hosts. The exact-PR-head live runner makes 126 bounded, sequential, credential-free, no-redirect requests: the original 69-request matrix plus seven public Gaming requests, 28 Gaming-source requests (eight true unauthenticated checks, including auth-first `OPTIONS` and encoded-status cases, and 20 explicitly labeled `simulatedAuth` fixtures), two worker-role Gaming denials, six sealed self-heal approval cases, one worker-role approval-contract denial, seven sealed Backstage generation cases, one worker-role generation-contract denial, one saved-storyline projection case, one canon-summary pagination case, two sealed dispatch GPT identifier cases, and one worker-role dispatch selector denial. The saved projection trims 2,500 leading ECMAScript whitespace code points before returning exactly 1,500 of 1,501 meaningful code points. The pagination case proves exact 4,000/4,000/2,000 Unicode-code-point pages across BMP/astral boundaries, exact reconstruction, version fencing, scope and offset rejection, and null-versus-empty preservation. Both explicitly report that neither SQL nor a database boundary ran. The route-budget case runs a 13,250 ms synthetic provider seam under the production-shared Trinity run options and 40-second provider/60-second route policy, and the runner independently requires at least 13,000 ms of wall-clock response time; its sealed 20-second request timeout is exposed as `effectivePerCaseMaxRequestTimeoutMs` separately from the caller default. The HRC case proves a classified timed-out fallback is not cached before one retry succeeds and the next read is cached. The review-completion case exercises the production-shared full-review classifier, Trinity list normalizer, 1,600-token/style policy, and Booker output contract against fixed named-event and narrow-event scopes, mixed and state-field directives, balanced and unmatched quotes, astral-letter apostrophes, quoted contractions, Markdown markers, inline/collapsed honesty caveats, and spaced/single initials. It also silently executes the compact-retry assertion without changing its response so an older trusted lifecycle verifier still covers the deployed PR-head seam. The detailed compact-retry case derives the exact contract and recovery instruction from a sealed prompt, runs the production-shared one-retry coordinator and strict final validator, and proves valid, malformed, under-count, over-count, word-overflow, second-length, and non-length behavior with no third call. The two continuity cases execute the production-shared cursor-shape preflight, sampled/exhaustive and compact-retry policy prompts, prompt assembly, and exact-page/subtree public response projections over sealed input. All seven generation cases remain credential-free and do not call a model provider or cross a protected effect; only the Notion-authority case performs the fixed Notion edge canary below. The unauthenticated set includes malformed and 16,385-byte bodies to prove auth-before-parser behavior. After the selector, the source fixtures mirror the production 16 KiB limit, closed 413/415 parser errors, and one-decode status-path containment. The runner verifies correlation, security, `no-store`, source and dispatch `no-cache`, bounded-body, and synthetic-provenance headers. It reports served-public-identity and effect-free component evidence; it does not assert Railway control-plane ownership or real bearer-auth, provider, storage, queue, admission/quota-store behavior, normal self-heal loop, actuator, or worker execution.
- The `notion-authority-rag-contract` selector makes one cached, fixed-origin
  `GET https://api.notion.com/v1/users/me` from the deployed web process with a
  hard-coded invalid non-secret bearer and an absolute four-second
  DNS/TLS/header deadline. It accepts only the expected JSON `401`, follows no
  redirect, retries zero times, and cancels without reading, parsing,
  or returning the response body. It then executes the production-shared Notion
  page/RAG core over sealed content. This proves Railway-to-Notion API edge
  reachability and the contained request/parsing/sanitization/chunking/prompt
  path. It does not prove a valid Notion credential or page share, PostgreSQL
  activation, worker scheduling, the normal authenticated route, or an OpenAI
  request.
- The trusted
  [Railway PR preview lifecycle workflow](../.github/workflows/railway-pr-preview-lifecycle.yml)
  owns preview creation and teardown for PRs carrying the exact
  `railway-preview` label. The opt-in prevents repository-wide preview creation
  for unrelated Gaming, GPT-OSS, or other work. It accepts only a
  same-repository PR targeting `main`, skips drafts until `ready_for_review`,
  and treats every admitted PR event as a wakeup to converge current state.
  Retargeting an owned preview away from `main` is an explicit teardown wakeup.
  A fixed `repository_dispatch` event provides an on-demand default-branch
  recovery path, while a six-hour sweep covers missed creation and teardown
  events using only open opt-in PRs and controller-owned environment names.
  Dispatch recovery with a numeric payload, for example `gh api --method POST
  repos/pbjustin/Arcanos/dispatches -f
  event_type=railway_pr_preview_reconcile -F
  client_payload[pr_number]=1435`; quoted or non-canonical PR numbers are
  rejected.
- The lifecycle controller checks out only trusted default-branch workflow
  code while its dedicated workspace token is present. It never installs or
  executes PR-head code in that job. The token is Railway workspace-scoped; the
  controller additionally pins every operation to the exact project, base, and
  service IDs. Store the token only as a secret on the
  `railway-pr-preview-lifecycle` GitHub Environment and restrict that
  environment to protected branch `main`; event and scheduled calls use the
  same trusted reusable workflow. It attests the exact credential-empty base, creates only the
  reserved `pr-676861-<N>` namespace with `ephemeral=true`, skipped initial deploys,
  and disabled staged/background apply, removes and twice verifies cloned
  GitHub triggers, then deploys the exact PR SHA worker-first through Railway's
  API. Each returned deployment ID must become the sole active non-stopped
  `SUCCESS` for its exact role and pass repository, commit, manifest, domain,
  and readiness checks. A newer failed latest record does not mask the sole
  active success. Ambiguity, pagination truncation, trigger recreation,
  deployment races, or provider-schema drift fails closed.
- Only the separate credential-free job checks out the opted-in PR head, and it
  uses that checkout solely as clean exact-SHA Git evidence. The executed
  harness and contract come from the trusted default-branch checkout. A PR that
  adds a selector must therefore execute its exact-head verifier separately
  against the lifecycle-created hosts until that verifier reaches the default
  branch. After the lifecycle reports the exact preview hosts, execute the
  current 126-request probe with both network flags from a separate, clean
  checkout of the revalidated exact PR head. This supplemental run is
  credential-free and explicitly covers all PR-head selectors and worker
  denials; it has no Railway create, ownership, or cleanup authority.
  A final trusted job writes the
  `Railway PR Preview E2E` commit status against the revalidated exact head; it
  has no Railway authority and never checks out the head. Configure
  `RAILWAY_PR_PREVIEW_LIFECYCLE_API_TOKEN` with a token scoped only to the
  pinned Railway workspace. Account-wide and project-environment tokens are
  rejected. Configure the protected GitHub Environment and the
  `railway-preview` label before rehearsal. The commit
  status is informational for this opt-in policy; do not configure it as a
  global required check because unrelated unlabeled PRs are intentionally out
  of preview scope.
- Cutover is deliberately fail closed. Railway-native PR environment creation
  must be disabled before the controller will create a custom preview, because
  both mechanisms can create competing environments and deployments for the
  same PR even though their reserved names differ. Keep production
  GitHub triggers disabled; this workflow does not change production promotion.
  Install the dedicated secret and label before disabling the native lifecycle,
  then separately inventory and explicitly dispose of legacy `Arcanos-pr-*`
  children only after exact ownership review; the controller deliberately never
  adopts or deletes that older namespace. Finally, prove one disposable labeled
  PR through open/ready, synchronize, and close. The PR that introduces the
  workflow cannot exercise its own trusted
  lifecycle because unmerged `pull_request_target` code is not present on the
  default branch.
- A production-shaped worker-diagnostics E2E must not activate or reuse that
  native environment. Use an empty custom
  `worker-diagnostics-pr-<PR_NUMBER>-e2e` environment with environment-scoped
  web, worker, PostgreSQL, and Redis instances; fresh database and Redis
  volumes; preview-only purpose-bound credentials; `NODE_ENV=production`; and
  the normal launcher. Set `ARCANOS_PREVIEW_ISOLATION=true`, `FORCE_MOCK=true`,
  `ALLOW_MOCK_OPENAI=true`, `OPENAI_API_KEY_REQUIRED=false`, and a
  credential-free loopback `OPENAI_BASE_URL`. Prove every OpenAI key alias is
  absent before a live dispatch. Deploy web and worker from the connected
  GitHub branch, then independently attest the exact repository, branch,
  commit, deployment IDs, service IDs, environment ID, and temporary web
  domain through Railway before sending any purpose-bound credential. A
  `railway up` artifact upload is not sufficient for this proof because it does
  not supply Railway's Git-trigger provenance variables. Keep both data
  services private, give only the web service a temporary HTTPS domain, and
  delete the environment immediately after the bounded proof.
- The trusted
  [worker-diagnostics cleanup workflow](../.github/workflows/railway-worker-diagnostics-preview-cleanup.yml)
  is a merge/close backstop for that exact custom name. It never checks out PR
  code and deletes only after project, environment, and allowed-service
  validation. Configure its dedicated
  `RAILWAY_WORKER_DIAGNOSTICS_CLEANUP_API_TOKEN` secret with a token scoped only
  to the pinned Railway workspace. The workflow calls Railway's GraphQL API
  directly, requires account identity access to be denied, validates the exact
  workspace and project, and does not use Railway CLI linking; account-wide
  tokens and production environment project tokens are rejected. The
  introducing PR
  still requires exact-ID manual cleanup if it closes unmerged because its
  workflow is not yet on the default branch.
- Web services start the compiled API runtime with `ARCANOS_PROCESS_KIND=web` and `RUN_WORKERS=false`.
- Worker services expose a minimal health server and then start `dist/workers/jobRunner.js` with `ARCANOS_PROCESS_KIND=worker` and `RUN_WORKERS=true`.
- Database-backed startup passively inspects the configured and actual
  collation versions with one read-only catalog query. A mismatch is warning
  telemetry only: Railway startup does not run collation maintenance. Schedule
  any required maintenance separately against an explicitly confirmed
  database target under the operational approval gate.
- Importing shared GPT dispatch or worker configuration code does not start the separate in-process EventEmitter runtime. That runtime is bootstrapped only by the explicit local/direct API lifecycle when configured.
- The application keeps `/health`, `/healthz`, and `/readyz` available; Railway uses `/readyz` for deployment activation, `/healthz` remains liveness, and `/health` remains dependency diagnostics. Public readiness responses are a sanitized, no-store dependency projection with stable status and failure codes. The credential-free `/railway/healthcheck` compatibility diagnostic is also a no-store bounded projection and omits worker filenames, checked filesystem paths, free-form reasons, and exception text; it is not the configured Railway deployment probe.
- The web listener binds before Redis initialization. `/health` and `/healthz` remain live during a Redis outage, missing backend configuration, or incomplete database schema initialization, while production web `/readyz` returns `503` unless PostgreSQL is configured, connected, and schema-ready, Redis is configured and connected, and that Redis ready generation has passed the isolated public-provider Lua/write capability probe; a new revision therefore cannot activate in an in-memory/no-Redis, schema-incomplete, or command-incompatible fallback. Local, test, development, and non-web modes preserve optional unconfigured dependencies. Railway does not continuously monitor the activation path after the first successful response; see `STARTUP_RESILIENCE.md`.
- Worker `/readyz` remains `503` until database bootstrap, the Backstage Notion
  format-readiness gate, autonomy/module-registry bootstrap, and every configured
  consumer slot's dispatcher-start write complete, and a supported OpenAI key
  setting is present. With no configured Notion authorities the format gate is
  a no-op. With authorities configured, it first verifies every active snapshot
  from PostgreSQL has the current page-level heading/index marker. An
  already-current set makes no Notion request; otherwise one synchronous full
  sync must return only `activated`/`unchanged`, after which PostgreSQL is
  reloaded and rechecked. Invalid configuration, `lease-busy`, `failed`, an
  omitted root, or still-old metadata prevents the child readiness signal and
  fails the revision closed. The child communicates the final transition through
  an exact newline-delimited protocol independent of `LOG_LEVEL`; stderr and
  embedded marker-like text cannot activate readiness. The normal OpenAI
  readiness check does not perform a paid probe, though a required format rebuild
  necessarily performs the configured Notion and embedding work. Transient
  provider failure after activation remains handled through the worker's
  probe/backoff and job-deferral path.
- Numeric `deploy.drainingSeconds=60` is the shared platform outer bound. The web runtime has a 10-second internal shutdown deadline. On a worker shutdown signal, the launcher immediately returns readiness `503` before forwarding the signal; the child then aborts provider work, leaves live claims for lease recovery, stops polling/heartbeats, and flushes runtime snapshots. The default 45-second lease-recovery horizon begins as old heartbeats cease and may complete in the new revision; the drain value does not itself guarantee that recovery. Sixty seconds gives the cooperative handlers a nonzero cleanup envelope, but stalled database I/O and real claim recovery still require a measured deployment rehearsal before promotion.
- `Procfile` remains in the repository as a historical fallback artifact and must not be treated as the canonical Railway start path.

Environment variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Required for live AI behavior. |
| `PORT` | Railway-managed | Automatically injected. |
| `NODE_ENV` | Railway-managed | Set to `production` by config. |
| `ALLOWED_ORIGINS` | Optional | Comma-separated exact HTTP(S) browser origins permitted to call the web service. Inventory every browser API and SSE caller before rollout. Omit to disable cross-origin browser access; same-origin and server-to-server requests remain available. |
| `ARCANOS_PROCESS_KIND` | Yes | `web` for the API service, `worker` for the async worker service. The launcher exits if missing or invalid. |
| `RUN_WORKERS` | Launcher-managed | Set by the role launcher from `ARCANOS_PROCESS_KIND` after the protected-digest gate passes. |
| `DATABASE_URL` or complete `PG*` set | Required for production web activation and async GPT jobs | Attach Railway PostgreSQL for persistence; web and worker services must share it. The complete fallback is `PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, and `PGDATABASE`. |
| `REDIS_URL`, `REDISHOST`, or `REDIS_HOST` | Required for production web activation | Configure the shared Redis lifecycle. The URL is preferred; either host name enables the runtime-supported discrete form. |
| `PUBLIC_PROVIDER_RATE_LIMIT_MAX`, `PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX`, `PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS` | Recommended explicit production policy | Deployment ceiling (default `100`), lower caller/cohort ceiling (default `20`), and shared window (default `900000` ms). A compatibility global ceiling of `1` uses a caller ceiling of `1`; otherwise the caller ceiling must be strictly lower. Production atomically stores both counters in Redis. |
| `PUBLIC_PROVIDER_RATE_LIMIT_STORE` | No production override | Production always resolves this policy to `redis`, fails closed during Redis loss, and never falls back to process memory. |
| `PUBLIC_PROVIDER_RATE_LIMIT_NAMESPACE` | Required only for non-Railway production Redis | Railway derives a stable namespace from project, environment, and service IDs. Other production deployments must configure a stable lowercase namespace; never use deploy or commit identity because that resets the window on rollout. Missing/invalid isolation keeps `/readyz` unavailable. |
| `PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP` | Optional; default `false` | Set exact `true` only after verifying public-edge-only provenance for provider routes. Even then, the app accepts `X-Real-IP` only with a valid Railway edge marker and an immediate peer in `100.0.0.0/8`; direct/private traffic remains socket-cohorted. |
| `ARCANOS_GPT_ACCESS_TOKEN` | Required for generic protected `/gpt-access/*` routes | Strong generic gateway bearer token stored only in Railway Variables and authorized generic GPT Access client authentication. `/gpt-access/openapi.json` is public. The generic token remains accepted on the Backstage canon route under the existing `capabilities.run` scope and backend-confirmation policy, but do not configure it in the dedicated Backstage Booker Custom GPT; use `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` there. It cannot authorize the exact Backstage universe or storyline-summary reads and is not accepted by Gaming source lifecycle routes. |
| `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` | Optional; required for protected Backstage Booker Custom GPT operations and private Notion-derived generation on the web service | Exact 32–4096-character visible-ASCII non-placeholder Bearer credential, distinct from every other canonical application credential. Configure it only on the web service and in the existing Backstage Booker Custom GPT Action's API Key/Bearer field; do not copy it to a worker, schema, GPT instructions, chat, source, or logs. Legacy supplement remains optional, but mapped Notion-authority generation requires the credential and fails closed when it is missing or invalid. |
| `ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` | Optional; configure on web for legacy supplement or worker for authority sync | Outbound 16–4096-character visible-ASCII token for a dedicated read-content-only Notion integration. Authority-only rollout moves it off web and onto worker. It must differ from every ARCANOS application credential and never appears in Builder. |
| `ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` | Optional; configure with the Notion token on the web service only | Sensitive JSON mapping from at most 32 exact universe IDs to one to three unique raw Notion page UUIDs each. URLs and partial/invalid configuration disable enrichment before provider work. Selected excerpts enter the existing OpenAI generation request. |
| `ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` | Optional; identical closed mapping on web and worker | Selects exact Notion-authoritative universes and their fixed recursive roots. Web uses it to block/quarantine legacy state and require RAG; worker uses it to build full immutable snapshots. A malformed present value fails writes closed. After first activation, the PostgreSQL authority head is a durable one-way latch: deleting this variable does not restore legacy authority, and an unreadable/conflicting authority state fails closed with `BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE`. |
| `ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS` | Optional; worker only | Full-hierarchy sync cadence; default 900,000 ms, clamped to 60,000–86,400,000 ms. |
| `ARCANOS_BACKSTAGE_NOTION_RAG_MAX_STALENESS_MS` | Optional; web only | Maximum last-complete-verification age; default 86,400,000 ms, clamped to 300,000–604,800,000 ms. |
| `ARCANOS_GAMING_SOURCE_ACCESS_TOKEN` | Optional; required only for Arcanos Gaming source ingestion, refresh, and status Actions on the web service | Exact 32–4096-character visible-ASCII non-placeholder Bearer credential, distinct from every other canonical application credential. Configure it only on the web service and in the Arcanos Gaming Custom GPT Action authentication field; do not copy it to the worker service. It grants access only to the three `/gpt-access/gaming/sources/*` lifecycle routes. Generic GPT Access routes reject it, and the generic GPT Access token is rejected on the Gaming source routes. |
| `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN` | Required on the web service when HTTP control-plane, AFOL decision/inspection, reinforcement feedback/inspection, Backstage state mutation, protected DevOps/PR diagnostic execution, legacy SDK/orchestration control, `/api/self-heal/*`, `/api/self-improve/*`, detailed self-heal status, or CLI self-heal inspection is used | Exact purpose-bound bearer credential stored only in Railway Variables. It must remain distinct from approval, GPT Access, daemon, memory, worker-helper, automation, and other application credentials. Backstage mutation paths include direct, canonical GPT, GPT-selected `/dispatch`, and legacy module aliases; missing or invalid control-plane configuration fails them closed with 503. |
| `ARCANOS_CONTROL_PLANE_PRINCIPAL_ID` | Required with the control-plane access token | Server-owned operator identifier used for HTTP control-plane attribution. Do not derive it from request fields. |
| `ARCANOS_CONTROL_PLANE_SCOPES` | Required with the control-plane access token | Grant only intended operations. AFOL health/log/analytics and root `/memory`, `/memory/digest`, and `/reinforcement/metrics` reads require `arcanos:read`; `/api/afol/decide` requires `mcp:invoke` plus its issued one-use challenge; `/reinforce`, `/audit`, and `/reinforcement/judge` require `mcp:invoke`. Backstage `bookEvent`, `updateRoster`, `trackStoryline`, `saveStoryline`, `upsertStoryline`, and `appendCanonBeat` require `mcp:invoke` plus confirmation across every public HTTP alias; `/backstage/book-gpt` is included because it saves, while generation and simulation stay public. `/api/codebase/*` requires `repo:read`; direct PR analysis requires `repo:verify`; DevOps self-test/daily-summary execution requires `diagnostics:execute`; legacy SDK/orchestration reads require `arcanos:read`, while SDK mutations and orchestration reset/purge require `mcp:invoke` plus confirmation; prompt and AI-routing debug reads, self-heal reads, and detailed safety diagnostics also require `arcanos:read`; an active provider probe adds `self-heal:probe`; decisions require `self-heal:decide`; and `execute: true` adds `self-heal:execute`. Manual self-improve runs require both decision and execution scopes. Freeze, unfreeze, autonomy changes, and integrity-quarantine release require `self-improve:control`. Omit active grants unless the operator workflow explicitly needs them. |
| `PROMPT_DEBUG_TRACE_MODE` | Optional; defaults to `metadata` | Keep `metadata` in normal deployments. Use `off` to collect nothing. `full` can retain sensitive prompt and response prose after bounded redaction and should be enabled only for a short, approved diagnostic window. Invalid values fail closed to `off`. |
| `PROMPT_DEBUG_TRACE_PERSIST` | Optional; defaults to `false` | Only exact `true`, together with a valid byte cap, enables JSONL reads and writes. |
| `PROMPT_DEBUG_TRACE_MAX_BYTES` | Required only when persistence is enabled | Integer from 1,024 through 104,857,600. At capacity, new disk events are dropped without automatic truncation or rotation. |
| `PROMPT_DEBUG_EVENTS_PATH` | Optional | Selects the JSONL path only. Existing files can contain historical sensitive content and require separately approved operator cleanup. |
| `ARCANOS_DAEMON_ACCESS_TOKEN` | Required on the web service when `/api/daemon/*` is used | Exact 32–4096 character credential with no whitespace or placeholder text, distinct from every credential in the canonical ARCANOS application-auth registry. Store it only in Railway Variables and configure the identical value on the bundled Python daemon. Daemon requests send only `x-arcanos-daemon-token`; missing or invalid web configuration intentionally returns `503 DAEMON_AUTH_UNAVAILABLE`. Roll out the web and daemon settings together because registry, heartbeat, command, result, and confirmation requests all fail closed. This shared token blocks anonymous transport access but does not identify individual daemon instances. |
| `ARCANOS_MEMORY_ACCESS_TOKEN` | Required on the web service for protected memory/session APIs and exact GPT memory interception | Exact 32–4096 character credential with no whitespace or placeholder text, distinct from every credential in the canonical ARCANOS application-auth registry. Store it only in Railway Variables and deliver it to memory and `/api/sessions*` clients through the `x-arcanos-memory-token` header. Missing or invalid configuration intentionally returns `503 MEMORY_AUTH_UNAVAILABLE`; configure clients and the web service together during rollout. This deployment-wide token does not establish tenant ownership or per-session authorization. |
| `ARCANOS_WORKER_HELPER_TOKEN` | Optional; required for token-authenticated direct worker control and remote worker-helper repair | Exact 32–4096 character credential with no whitespace or placeholder text, distinct from every credential in the canonical ARCANOS application-auth registry. Store it only in Railway Variables. Inbound requests may use one custom-header or Bearer carrier; bundled-script and remote-actuator requests use only `x-arcanos-worker-helper-token`. Configure the identical value on both the calling service and target service. Direct worker run and direct worker heal also require separate action confirmation; both heal HTTP entry points share an authenticated-principal rate limit. |
| `SELF_HEAL_WORKER_SERVICE_URL` | Optional remote repair actuator origin | Explicit exact HTTPS origin for the target worker-helper HTTP service. Exact HTTP is accepted only for loopback, so deployed Railway targets must use HTTPS. Compatibility aliases are `WORKER_HELPER_BASE_URL`, `RAILWAY_SERVICE_ARCANOS_WORKER_URL`, and `ARCANOS_WORKER_PUBLIC_URL`; every configured alias must resolve to the same origin. |
| `ARCANOS_GPT_ACCESS_BASE_URL` | Required for GPT Action import | Public HTTPS origin advertised by `/gpt-access/openapi.json`; do not rely on request headers in production. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Required for generic protected GPT access | Grant only the scopes needed by generic gateway operations. Async job submission and result retrieval use `jobs.create,jobs.result`; add other read, recovery, or capability scopes only when intentionally enabled. The dedicated Backstage read/canon and Gaming source lifecycle credentials do not use generic GPT Access scopes. A generic token can still reach the Backstage canon route only with `capabilities.run`, backend confirmation, and the exact server-side module-action allowlist; it cannot reach either exact Backstage read. |
| `GPT_ACCESS_NL_DISPATCH_MODE` | Optional, web service only | When unset, `/gpt-access/dispatch/run` uses `hybrid` if the web service has a real resolved OpenAI key and `rules` otherwise. Valid values are `rules`, `hybrid`, and `llm_first`; invalid values resolve to `rules`. Set `rules` to force deterministic dispatch. |
| `GPT_ACCESS_DISPATCH_MODEL` | Optional | Defaults to `gpt-4.1-mini`; used only by the semantic dispatch planner. |
| `GPT_ACCESS_DISPATCH_LLM_TIMEOUT_MS` | Optional | Defaults to `5000` and caps at `10000`; timeout/failure never executes an LLM plan and can only fall back through deterministic rules and policy checks. |
| `ARC_LOG_PATH` | Optional | Defaults to `/tmp/arc/log`. |
| `GPT_FAST_PATH_ENABLED` | Optional | Defaults to `true`; disables inline prompt-generation fast path when set to `false`. |
| `GPT_FAST_PATH_MODEL` | Optional | Defaults to `gpt-4.1-mini`; use a low-latency model for inline fast-path requests. |
| `GPT_FAST_PATH_TIMEOUT_MS` | Optional | Defaults to `8000`; inline model timeout for fast-path requests. |
| `GPT_FAST_PATH_GPT_ALLOWLIST` | Optional | Comma-separated GPT IDs allowed to use fast path; empty means all GPT IDs. |

The public worker-helper status command does not carry the worker-control token.
Protected helper commands fail locally when the caller's env-only credential is
missing, invalid, or colliding; there is no credential CLI flag. Credentialed
script and actuator requests reject redirects. Remote actuator status remains
unavailable for a missing token or any invalid/conflicting URL alias, and the
token is re-resolved immediately before fetch. Remote repair responses are
limited to 64 KiB of JSON and projected into an allowlisted result with a
locally generated message rather than forwarding target-controlled text or the
target response wholesale.

Environment separation:
- `railway.json` defines `production` and `development` variable blocks.
- Keep secrets per environment in Railway Variables.
- Configure separate Railway services for web and worker when async GPT jobs must complete in the background.
- `GPT_ACCESS_*` natural-language dispatch variables do not change or recycle the worker service. Worker recycle/recover dispatch uses registered privileged actions, requires explicit `workers.recover` scope plus confirmation, and reclaims stale queue jobs through the approved recovery runner.
- Dispatch confidence thresholds are fixed code policy, not Railway variables: readonly `0.65`, privileged `0.78`, and destructive `0.90`.
- Confirm each service role through an approved control plane against the exact project, environment, and service. Do not reproduce raw variable output in reports.

## Run locally

Use the build, test, and `validate:railway` checks above for non-deploying validation. Do not start the application with Railway or production variables as a deployment check.

A separately approved local runtime check must use a deliberately isolated effective environment with no inherited Railway-management, provider, Redis, queue, or remote-database credentials. Database resolution accepts `DATABASE_PRIVATE_URL`, `DATABASE_URL`, `DATABASE_PUBLIC_URL`, or a complete `PGUSER`/`PGPASSWORD`/`PGHOST`/`PGPORT`/`PGDATABASE` set. When any candidate resolves successfully, startup can execute DDL and write a heartbeat.

## Deploy (Railway)

The tracked `.github/workflows/railway-auto-deploy.yml` promotes one explicit
web/worker pair after successful CI on `main` or by manual dispatch. It requires
`RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_NAME`, and distinct
`RAILWAY_WEB_SERVICE_ID` and `RAILWAY_WORKER_SERVICE_ID` repository variables.
Missing credentials or identifiers fail the promotion; there is no green skip
or implicit environment default. Railway-native GitHub triggers remain disabled
so an independent single-service deploy cannot bypass the pair.

Successful CI means the aggregate verifier observed the exact required job set
with every result equal to `success`, including the nine-suite PostgreSQL job.
It is not proof of current production topology, deployed revision, live database
schema, writer compatibility, or drain readiness; those remain separately
verified promotion conditions.

GitHub must provide `RAILWAY_PRODUCTION_PROJECT_TOKEN` as a Railway project
token dedicated to the exact production project/environment; an
account/workspace API token is not an acceptable substitute. The workflow
exposes that secret as `RAILWAY_TOKEN` only to its access probe, deployment,
status polling, and post-deploy log-check steps. All reusable Actions are
commit-pinned. Railway CLI `4.30.2` is downloaded from the exact upstream GNU
release archive, verified against SHA-256
`e8bd57fd6517b5cf387a9c072ce79fdc069fc0b877c171b58e325b22e96c9000`
before extraction, and checked for exact version output before use.

The application Docker image has a distinct musl CLI artifact contract. It
downloads `railway-v4.30.2-x86_64-unknown-linux-musl.tar.gz` with at most five
attempts, verifies SHA-256
`7dd6633ced5c0ac579cbeb1842bc7e4bc14cfd2d43ea2e3a00b376320f80d1ce`
before extraction, checks exact `railway 4.30.2` output, and links the verified
binary to both `/usr/local/bin/railway-native` and the bare `railway` command.
Do not restore the `@railway/cli` npm global installer: its postinstall repeats
the network fetch without this repository's checksum and retry gates.

Provider-side token scope must be verified independently before this path is
enabled or dispatched; tracked workflow code cannot inspect that scope safely.
The deploy checkout's persisted read-only GitHub credential and a feasible
protected GitHub environment/approval topology are separate defense-in-depth
and repository-settings decisions, not guarantees provided by these workflow
controls.

The production job is limited to 130 minutes and serializes through the
`railway-auto-deploy-production` concurrency group without cancelling a run
that has already started. A newer run waits while the active observer finishes;
GitHub may still coalesce older runs that remain pending.

Static Railway compatibility validation runs before any remote mutation. The
token preflight then reads a bounded Railway project inventory. It attests the
exact project, the single accessible non-deleted environment with the configured
name, and one matching service instance per role. Each target must expose
exactly one active `SUCCESS` deployment, whose ID becomes its baseline; a newer
failed latest deployment cannot mask that active deployment. Missing, duplicate,
malformed, or mismatched inventory fails before upload. The preflight also
validates the resolved identity and expected role for each target. It requires a
direct current web readiness response; a private worker retains current Railway
active-`SUCCESS` platform evidence instead of acquiring a public domain solely
for this check. Promotion deploys and verifies the worker first, then uploads
the same exact SHA to the web service. Worker-first ordering avoids a new web
producer activating against an old queue consumer; ordinary releases must still
preserve old/new interoperability, while incompatible migrations use the
separate rollout hold and stopped/drained procedure. Because Railway activation
uses worker `/readyz`, a configured Backstage Notion heading/index upgrade must
also pass the repository-owned format gate before this workflow can observe
worker `SUCCESS` and begin the web upload.

Backstage Booker Phase 2A is an additive-schema rollout, not a second
universe-scope cutover. The release adds canon head/revision, typed storyline,
participant, and immutable beat tables that older replicas do not access.
Confirm that `20260814_backstage_universe_scope_v1.sql` is already active before
admitting the new explicit-universe mutations, then deploy the normal
worker-first/web-second compatible pair. Runtime startup mirrors the additive
table definitions; never run the hand-written migration merely as a readiness
probe. A commit-unknown canon response must be reconciled with the same
universe, mutation ID, and normalized payload rather than routed to replica-local
memory.

The Backstage Booker protected Action is a separate, purpose-bound ingress
rollout on top of that canon substrate. Deploy and verify the exact backend
revision and its served
`/contracts/backstage_booker.openapi.v1.json` before changing the existing
Custom GPT. The web service alone receives a distinct
`ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN`; the worker does not. Builder schema
`1.4.0` declares that credential for continuity queries, generation, and
simulation as well as the exact
universe and storyline-summary reads, which are
non-consequential, and return a bounded repeatable-read PostgreSQL projection
or one fixed 4,000-code-point, version-fenced summary page without a
list/display-name surface or in-memory fallback. Each database statement has a
3.5-second transaction-local PostgreSQL timeout. The generic GPT Access token and
`capabilities.read` scope do not authorize them. The exact canon route may bypass
generic `ARCANOS_GPT_ACCESS_SCOPES` authorization, but the
server-side `MCP_ALLOW_MODULE_ACTIONS` allowlist must still include
`BACKSTAGE:BOOKER:upsertStoryline` and
`BACKSTAGE:BOOKER:appendCanonBeat`. Every other action fails closed on the
dedicated credential.

In ChatGPT Builder configure that value as API Key/Bearer authentication, not
OAuth or a user password. Both imported read operations are non-consequential;
the write operation is consequential, and
the backend deliberately trusts ChatGPT's Allow/Deny banner instead of issuing
a second confirmation challenge. This is shared Action authentication, not
per-user identity; anyone holding it can read any valid exact universe ID and
exact storyline key within that scope. `universeId` does not authorize access.
Phase One
mutations are unavailable on this lane and retain the existing backend
challenge on established generic/direct/control-plane/legacy paths. The
ordinary challenge default remains 2 minutes; do not lengthen it as a setup
workaround. See
[BACKSTAGE_BOOKER_CUSTOM_GPT.md](BACKSTAGE_BOOKER_CUSTOM_GPT.md) for the full
Builder and security contract.

Optional Notion enrichment is a web-only configuration rollout and does not
add a Builder operation. Schema `1.4.0` must still be re-imported because it
declares bearer provenance and materializes the nested public payload. Create a dedicated Notion integration
with read-content access, share only the approved pages, and configure both
`ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` and
`ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` on the web service. Never reuse
an ARCANOS bearer or copy the Notion token to Builder/worker configuration.
Deploy the backend first. Then call `generateBooking` for a mapped disposable
scope through the existing private GPT and verify the sanitized
`backstage.notion_context.loaded` event. Repeat without the dedicated Backstage
bearer and verify generation stays available but no Notion event/request occurs.
After importing `1.4.0`, verify Builder attaches its saved API-key
authentication to `runBackstageBooker`. If it does not, enrichment must remain
disabled; do not remove the server-side gate.

Every Notion attempt is fixed to `api.notion.com`, rejects redirects, shares a
four-second deadline across at most three reads, caps each response at 256 KiB,
and caps prompt material at 4,000 Unicode code points per page/12,000 total.
PostgreSQL remains authoritative and Notion failures fall back to its already
loaded context. This path does not mirror, migrate, or write data. Ensure the
mapped page content is approved for the existing OpenAI provider data path.

Notion-authority/RAG is an incompatible, two-phase cutover. Do not let the
normal worker-first deployment activate authority while any old web replica or
alias can still serve legacy canon. In phase one, keep
`ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` absent (or keep the target
universe out of it) and keep the authority-mode Notion token off the worker.
Deploy the exact code and additive migration through the normal
worker-first/web-second pair, then prove every active web and worker replica is
running that compatible exact SHA. No worker sync may activate a head during
this phase.

Activation is one-way and intentionally quarantines old canon. Before phase
two, drain/cancel queued mutations for the exact universe, reconcile
commit-unknown results, and take the approved recovery export of the existing
revision-6 legacy state. Put the reviewed authority root mapping on the already
compatible web service first, without a web Notion token, and verify its exact
universe guard is active. Then put the identical mapping plus the read-content
Notion token on the already compatible worker and enable its sync loop. Keep
the authoritative universe out of the legacy page supplement. For each initial
cutover, set `initialMinimumPageCount` to the independently reviewed reachable
page count (for example, `18` for a reviewed 18-page hierarchy). Verify one
worker cycle activates a complete snapshot that meets that floor, reports zero
unsupported blocks and zero errors, uses the current heading-index format, and
has a fresh verification timestamp.
Existing heading-empty snapshots from before this format intentionally fail
closed until the worker rebuilds and activates a compatible snapshot; do not
patch them or relax the reader. Do not use the ordinary paired
deployment as the phase-two activation mechanism, and do not proceed if any
old web replica or alias remains reachable.

The first activation drains all nine legacy tables, atomically flips the active
RAG head, and installs trigger-enforced write denial. The compatible web
continuity-query/generation path then requires its saved Backstage bearer and a
fresh active snapshot; missing/stale RAG fails closed. The legacy GET operations
and all six mutations return nonretryable 409 errors for that universe.
The activated root is immutable: changing the mapping to another page is a
configuration error, not a migration mechanism. Removing the mapping also does
not downgrade the durable authority head.

After worker proof, smoke-test the already deployed compatible web revision
with `queryContinuity`. First verify omitted/default `scopeKind: "page"` reads
only one exact `pageTitle`, with optional `pagePath` and `sectionPath`. Then use
explicit `scopeKind: "subtree"` for a parent with descendants, including a
blank navigation parent when available. Confirm it includes the exact parent
and descendants, excludes a sibling, rejects `sectionPath`, and diversifies a
`relevant` sample across pages. Exercise `complete_scope` from a cursor-free
first request and, when `hasMore` is true, continue with the opaque
`nextCursor` and the exact unchanged query, scope kind, and mode. Verify the
action stays request-local and synchronous and creates no worker job.

Confirm a tampered cursor, a changed query/scope/kind/mode, a version-2 cursor,
and a cursor from a superseded snapshot each return nonretryable
`409 BACKSTAGE_NOTION_CURSOR_INVALID`; the safe recovery is to discard the
paged result and restart without a cursor. Confirm all responses report chunk
coverage, while only subtree responses set
`resolvedScope.scopeKind: "subtree"` and add `scopePages`, `selectedPages`, and
`omittedPages`. Confirm omission/truncation fields are truthful and public
sources contain only sanitized paths/categories and opaque hashes—no excerpts
or raw page IDs. Also
exercise the sealed max-output seam: only max-output exhaustion gets one compact
retry over the same retrieval and budget, and a second exhaustion returns the
sanitized incomplete-output error. Confirm each response used one snapshot, no
Notion request originated from web, no legacy repository/fallback was called,
and OpenAI storage/transcript/cache suppression remained active.
Only after the backend serves schema `1.4.0`, re-import that contract into the
existing Builder Action, preserve its saved bearer and visibility, and repeat
one page and one subtree request through the GPT. Then remove any
authority-only Notion token left on web. A failed new crawl
must leave the prior active snapshot unchanged; once its verification age
exceeds the configured limit, generation must stop rather than use old canon.
Restoring PostgreSQL authority is a separate emergency governance operation,
not an automatic rollback or GPT action.

The lane has no previous-token overlap setting. A rotation therefore requires
a coordinated web-service variable change/deploy and existing-GPT auth update,
with a brief expected authentication gap. To revoke or roll back, remove the
web-service credential, restore the last reviewed Builder configuration, and
deploy the approved backend revision. Those actions do not erase previously
committed canon; any data correction remains a separate authorized mutation.

Each upload is bounded to 10 minutes, each exact-deployment observation to 45
elapsed minutes with ten-second polling, and every Railway status or variable
subprocess has an explicit timeout and output cap. Each returned ID must reach
Railway `SUCCESS`, remain the active successful and non-stopped deployment, and
pass exact identity/role/readiness checks. After web activation the workflow
re-verifies both new deployment IDs together. A private worker retains
Railway's first-200 activation result instead of being exposed solely for the
workflow. Post-deploy web log retrieval is limited to 30 seconds and 4 MiB.
This is one-time activation evidence, not continuous health monitoring or
effective provider-setting readback.

Each detached upload remains a remote mutation, and the pair is coordinated
rather than provider-atomic. If upload times out before an ID is returned, the
workflow is manually cancelled, the runner is lost, worker promotion succeeds
but web promotion fails, or an exact deployment remains nonterminal past the
observer budget, it may continue remotely without the remaining activation
checks. Reconcile that residual manually against the logged baseline/attempt
IDs and exact project, environment, service, and revision. The workflow does
not guess a prior revision, use generic `railway redeploy`, or automatically
roll application code across a potentially incompatible schema.

The workflow also runs a repository-owned coordinated-writer policy before the
production deployment job can enter its concurrency group. The completed DAG
snapshot-generation rollout now uses the inactive `none` sentinel, which admits
normal paired promotion. If
`ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD` is changed back to the active
`20260727-dag-snapshot-generation-v1` ID, automatic `workflow_run` promotion is
skipped without starting or cancelling a deployment. A manual dispatch then
fails unless the operator types the exact confirmation
`DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1`.

The repository policy cannot suppress Railway's separate GitHub-source
auto-deploy trigger. Keep native auto-deploy disabled on both `ARCANOS V2` and
`ARCANOS Worker` while the GitHub paired workflow is canonical. Enabling either
trigger would permit a source push to bypass worker-first ordering, exact-ID
observation, and the shared production concurrency lock.

The typed phrase does not stop a process, apply a migration, validate a target,
or authorize production work. Before using it:

1. Obtain the normal target-specific deployment and database authorization.
2. Inventory every process capable of writing DAG snapshots, including all web
   replicas and any separately operated service.
3. Verify Railway-native auto-deploy remains disabled on every production
   writer so a source push cannot bypass the repository hold.
4. Drain or stop every writer and verify that an older binary cannot restart.
5. Confirm the compatible revision and migration are the approved rollout pair.
6. Dispatch the workflow only for the approved revision. The workflow deploys
   the explicitly configured worker first and web second; inventory and
   coordinate any additional writer through its separately approved mechanism.
7. Verify the installed schema, exact revision on every writer, absence of old
   replicas, deployment health, and bounded application diagnostics.

Keep the hold active if rollout or verification fails. Rollback also requires
all writers to remain stopped or compatible with the rolled-back schema. Only
after the coordinated rollout is accepted should a reviewed follow-up set the
workflow marker to the exact sentinel `none`. Missing, blank, or malformed
markers fail closed; `none` restores normal future automatic promotion.

A push or manual workflow dispatch can therefore be deployment-affecting. Before triggering either:

1. Confirm the approved release mechanism, exact revision, project, environment, and every web/worker service in scope.
2. Review the expected deployment effect and rollback.
3. Obtain explicit operator approval.
4. Before deployment, read the exact web and worker service settings or
   deployment details. Each role must resolve `healthcheckPath=/readyz`,
   `healthcheckTimeout=300`, and `drainingSeconds=60`. Config-as-code overrides
   dashboard settings for a deployment without rewriting the dashboard value,
   so use the effective deployment details rather than assuming an old
   dashboard value is authoritative.
5. After deployment, confirm the fresh targeted deployment ID and `SUCCESS`
   status. For a confirmed public web target, make the bounded readiness
   request below. A manual request is read-only but still requires a confirmed
   target:

```bash
curl --fail --max-time 15 https://<your-service>.up.railway.app/readyz
```

The production smoke helper uses this same fixed path and rejects the
non-readiness `/health` dependency-diagnostic response schema:

```bash
npm run railway:smoke:production -- --app-url https://<confirmed-web-service>.up.railway.app
```

That helper reads Railway topology, variables, and logs and makes a live network
request. It is not routine local validation; run it only with exact-target
read-only authorization after confirming the checkout's linked Railway project.
Its topology audit is intentionally stricter than runtime admission: it expects
both resolved URL variables and discrete PostgreSQL/Redis host projections so
it can compare the web and worker services' private-network targets.
The explicit `--app-url` is required and must match a Railway-owned domain from
the selected app service. The helper does not change the locally selected
environment; it selects the named environment explicitly for service-scoped
reads. The automatic workflow separately invokes
`scripts/verify-railway-readiness-activation.mjs` with the exact target's
resolved Railway variable projection. It rejects a conflicting
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` value when present. Before requesting web
readiness it also requires `NODE_ENV=production` plus the runtime-supported
database and Redis configuration alternatives, preventing a production
identity from bypassing the application policy through a non-production
runtime mode or missing backend reference. A private worker needs
no public domain solely for this check, but its exact Railway `SUCCESS` and the
tracked contract do not replace the effective `/readyz`/timeout/drain readback
required above.

### Railway command safety

- Local static validation: `npm run validate:railway` reads tracked configuration and does not contact Railway. Builds and tests may create local artifacts.
- Remote observation: status, targeted variable inspection, targeted logs, and health requests do not intentionally change Railway state, but depend on the current target and can expose identifiers, variable values, request data, or other sensitive output. Confirm the exact project, environment, and service; minimize output and report only sanitized evidence.
- Local CLI state: authentication, project linking, and environment selection change local credential or target state. Do not perform them as routine validation.
- Operational actions: variable changes, deployments, restarts, redeployments, rollbacks, database attachment, remote runtime commands, and live probes can change Railway, application, provider, queue, or database state.

Before any operational action, obtain explicit approval recording:

- Exact command or operator action.
- Project.
- Environment.
- Service.
- Expected effect.
- Rollback plan.

Use `not applicable` rather than omitting a field. Never use `railway run ... npm run dev` as validation: it starts the backend with Railway variables and can execute DDL or write a heartbeat against the configured database.

The `railway:probe:fast-path` and `railway:probe:async` scripts are live operations, not routine post-deploy checks. The fast-path probe invokes the live provider path; the async probe can create and process a durable job. Bare invocation is forbidden because both scripts default to a hard-coded production origin. Each requires separate, target-specific approval and an explicit `--base-url` matching the approved target.

Rollback:
1. Treat rollback as a state-changing production operation and satisfy the approval gate.
2. For a paired-promotion failure, first decide whether the approved recovery
   is to forward-complete the web role onto the verified worker revision or to
   restore the worker's captured baseline. Confirm schema compatibility and any
   coordinated-writer hold before either action; do not guess from `HEAD^` or
   use a generic latest-deployment redeploy as a substitute.
3. In each confirmed target's deployment history, identify the exact approved
   deployment for that recovery decision.
4. Redeploy only those approved versions, then repeat exact web/worker role,
   readiness, active-deployment, and shared-revision verification.

## Troubleshooting
- Build fails: run `npm ci --include=dev --no-audit --no-fund && npm run build` locally first.
- Launcher fails with `ARCANOS_PROCESS_KIND is required`: verify that the exact API service is configured as `web` or the exact worker service as `worker`. Changing the value requires operational approval.
- Repeated restarts: inspect the exact target's `/health`, `/healthz`, and `/readyz` responses and only the minimum sanitized Railway logs needed. `/readyz` intentionally omits raw root-cause text; correlate its stable codes with approved sanitized logs or authenticated control-plane evidence.
- App boots without AI output: verify through an approved control plane that `OPENAI_API_KEY` is present without printing its value. Changing it requires operational approval.
- Persistence degraded: verify the approved database attachment and `DATABASE_URL` target. Attaching a database or changing the variable requires operational approval.
- Async jobs stay queued: verify the approved worker deployment, role, shared database target, provider key presence, and the web service scopes `jobs.create,jobs.result`. Deployment or variable changes require operational approval.
- Custom GPT cannot import or calls the wrong host: verify the public web-service origin. Changing `ARCANOS_GPT_ACCESS_BASE_URL` or redeploying requires operational approval.

## References
- `../railway.json`
- `CONFIGURATION.md`
- `CI_CD.md`
- `RAILWAY_RATIONALE.md`
- Railway docs: https://docs.railway.com/
- Railway CLI docs: https://docs.railway.com/develop/cli
