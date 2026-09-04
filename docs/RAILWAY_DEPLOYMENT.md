# Railway Deployment Guide

## Overview
This runbook documents the repository-tracked Railway configuration and release safeguards for Arcanos. Tracked files do not prove the current live project linkage, environment state, or service topology.

## Prerequisites
- Approved Railway account and project access.
- A confirmed project, environment, and service target.
- Repository connection or GitHub-side deploy credentials configured through an approved operator workflow.
- Exact Node.js 24.18.1 with its bundled npm 11.16.0 for local validation. Railpack resolves the same exact Node version from root `engines.node`; `.nvmrc`, CI, and Docker use the identical selector.

The root manifest deliberately has no `packageManager` field. Under current
Railpack behavior that field opts into a moving `corepack@latest`, while this
repository's npm contract is the version bundled with the pinned Node release.
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
- The native PR web role starts `dist/start-native-pr-preview.js` directly, without registering runtime loader hooks, and gives it a nine-name child-environment allowlist containing only the version marker, derived PR/commit identity, role, listener, production mode, disabled-worker flag, and UTC timezone. It imports the real dependency-injected generic jobs router with immutable synthetic fixtures, the central `src/shared/researchRequest.ts` validator and storage-component helper, the real Research abort-drain wrapper with its narrow request-abort runtime, the contained Backstage storyline helpers and production-shared saved-storyline excerpt and canon-summary page projectors, Backstage route/Trinity timeout policy, the production-shared Backstage review, compact-retry, output-capacity/presentation, output-admission, and Notion sync Phase-A contracts, the pure managed-auth/continuation/result cores, the pure protected-continuity failure resolver, the pure GPT client registry/provenance core, Trinity direct-answer normalizer, Backstage continuity-query core, GPT route timeout resolver, HRC cache policy, the exact GPT identifier middleware with its pure lane resolver and identifier validator, the config-free core used by the production MCP pre-parser, the exact system-state HTTP boundary and bounded JSON parser, the pure predictive/reactive self-heal approval policy, the canonical Backstage Booker OpenAPI JSON asset, and a local sealed Gaming contract-fixture layer. It does not import the normal Research, Backstage, dispatch, MCP, status, self-heal, or self-improve route, the configured MCP wrapper, state manager, confirmation middleware, hub, provider, fetcher, database connection, memory subsystem, or external persistence/effects integration. Only fixed health/readiness, synthetic status/result/cancellation cases, exact `GET /contracts/backstage_booker.openapi.v1.json`, the exact `POST /research/contract`, `POST /backstage/storyline-contract`, `POST /backstage/generation-contract`, `POST /dispatch/gpt-identifier-contract`, `POST /mcp/body-cap-contract`, `POST /status/auth-before-parser-contract`, and `POST /self-heal/approval-contract` fixture selectors, fixed public Gaming canary/query payloads, and the bounded production-recognized Gaming-source namespace are reachable; external credential carriers, streams, and every unlisted route fail before parsing, while admitted fixture requests also reject content encodings before parsing. Research, storyline, generation, dispatch identifier, MCP, status auth, and self-heal approval selector requests contain only `{ "fixture": "<sealed-name>" }`. The saved-storyline selector executes the production-shared pure projector over 2,500 leading ECMAScript whitespace code points followed by 1,501 meaningful code points and proves a truncated 1,500-code-point excerpt. The summary-pagination selector executes the production-shared canon-summary projector over a server-owned 10,000-code-point mixed BMP/astral value and proves three exact pages, exact reconstruction, version fencing, scope and offset rejection, and distinct null versus empty pages. Both explicitly report `databaseBoundaryReached: false` and `sqlProjectionExecuted: false`; PostgreSQL 18 CI remains authoritative for the real SQL read. The fourteen generation selectors prove the shared Backstage route and model-stage budgets, HRC timeout-result cache isolation, full-review classification, token/style shaping and output normalization, the production-shared exactly-one compact-retry coordinator and strict final-output validator, output-capacity/presentation separation and hierarchy-preserving recovery, alternative-card classification plus fail-closed first-success admission, the 4,096-reader/4,096-writer sync capacity fence, strict 4,097 pre-effect rejection, and late-acquisition cleanup, partition-failure telemetry projection, continuity cursor-shape preflight, sampled/exhaustive and compact-retry policy prompts, prompt assembly, and public response projection, dedicated bearer parsing, stable and legacy ownership, managed-poll projection, bounded synthetic waiting, protected terminal materialization, and authenticated registry identity plus durable provenance through credential-free seams; no model provider or protected effect is reachable; the Notion-authority selector's only external capability is the pinned credential-free edge canary described below. The failure-telemetry selector parses a valid root-ID-alias configuration, invokes the semantic-digest-pinned production-shared failed-shard projector, proves exact composite identities, safe fallback, deterministic order, 512 unique failures in 55,314 bytes, and raw-identifier absence; it explicitly reports that neither a worker nor logger sink ran. The established compact-retry selector also silently executes the production-output assertion, the established production-output and Notion-authority selectors silently execute the output-admission and Notion Phase-A assertions respectively, and the existing review-completion selector silently executes the compact-retry, managed-async, protected-failure-no-fallback, and GPT-client-identity assertions without changing its response, preserving coverage when the trusted lifecycle verifier predates any detailed selector. The managed and identity selectors use server-owned synthetic credentials and injected in-memory dependencies. The protected-failure-no-fallback selector invokes the production-shared continuity failure resolver for protected, quarantined, combined, and unprotected-control cases, proves zero process-fallback reads for every protected or quarantined case and exactly one for the control, then reuses the protected failure-envelope, queued-result protection, and async-result projection cores to prove both `generateBooking` actions remain failed with null results and no draft-like material; it explicitly reports provider, HRC, database, repository, queue, worker, network, and protected-effect boundaries false. The identity selector exercises the shared strict bearer parser, immutable registration resolution, bounded telemetry projection, server-owned provenance merge, and strict absent/valid/invalid parser; it proves credential rotation keeps the stable identity, caller claims cannot replace provenance, unknown clients fail closed, and sensitive values are absent. Neither selector invokes the normal authenticated route, PostgreSQL, an active worker, a provider, or Notion. The six self-heal approval selectors execute the shared semantic-digest-pinned policy for denied outcomes, coherent and incoherent completion, disabled legacy authorization, manual-controller independence, and production debug denial without importing or starting the normal loop or reaching any protected effect. Gaming inputs are fixed closed-schema payloads, and Gaming-source post-auth simulations use only fixed `x-native-preview-fixture` values plus a canonical `.invalid` URL; none carries credentials or a live URL. Ten server-owned Research fixtures exercise exact and over-limit non-BMP topic, URL count, URL item, and aggregate boundaries in JavaScript `String.length` units, a one-read normalized URL descriptor snapshot isolated from later source mutation, and the deterministic ASCII storage component capped at 97 UTF-8 bytes. The eleventh `workflow-cancellation-drain` fixture executes one real wrapper-owned timeout and three deterministic parent-abort scenarios across synthetic DNS, fetch, model, and persistence seams. It observes one active operation at abort, verifies that operation reaches zero before outward settlement, proves later seams never start and the same signal/deadline reaches every admitted seam, and detects post-settlement mutation. The live probe also rejects a response before the bounded 300 ms aggregate drain-proof window. Parent abort is disconnect-equivalent component evidence, not a literal TCP-disconnect test. The descriptor probe is constructed inside the server-owned fixture and does not claim that caller JSON can carry accessors or property descriptors. The storyline `lifecycle-exact` fixture calls the real validator, response selector, and repository transaction helper through a fresh per-request in-memory query adapter; two mutations prove the exact 16,384-byte beat boundary, 100-beat retention, fresh-read response, chronological newest-25 selection, and accepted-beat inclusion. The `payload-over` fixture proves a 16,385-byte beat is rejected before the repository helper. The MCP `effective-limits` fixture executes six server-owned, chunked, no-`Content-Length` JSON streams against the production parser core: exact and one byte over the hard 1 MiB maximum, a downward 512 KiB MCP setting, and a stricter 256 KiB global JSON setting. Exact bodies reach the synthetic downstream sentinel once; over-limit bodies return the fixed 413 `MCP_REQUEST_TOO_LARGE` response with `no-store`/`no-cache` headers and never reach that sentinel. The dispatch identifier selectors invoke the exact production middleware with server-owned 40,000-code-unit action metadata: 256 code units continue exactly once into a no-effect sentinel, while 257 code units return the intact bounded `400 BAD_REQUEST` envelope with zero downstream calls, no truncation, and no attacker-controlled reflection. The status auth selector executes the exact production system-state boundary and 64 KiB parser over six server-owned streamed bodies: unavailable, missing, invalid, and read-only-scope cases consume zero body bytes; an internal synthetic `mcp:invoke` operator admits exactly 65,536 bytes once and rejects 65,537 bytes with 413 before the no-effect sentinel. The contract GET emits no synthetic fixture marker; the live verifier compares it to the bounded JSON blob read from the revalidated exact commit and requires the exact-head numeric 1.x.y version plus the managed bearer/result contract while the passive worker returns 404. The queue-wait and managed-async proof headers admit only the reviewed v1/v2 transition values; missing or unknown values fail closed. These are component E2Es: the contract GET uses a contained handler rather than the normal introspection router; the storyline surface does not reach PostgreSQL or prove SQL-engine locking or atomicity, for which the PostgreSQL 18 CI suite remains authoritative; the summary selector does not invoke the normal protected GET or bearer authentication; the compact-retry, production-output, output-admission, and Notion Phase-A surfaces do not invoke the canonical route, a real model provider, HRC, RAG, or persistence; the managed-async, protected-failure-no-fallback, and GPT-client-identity surfaces do not invoke the normal authenticated route, a live external bearer, PostgreSQL, an active worker, a provider, or Notion; the failure-telemetry surface does not execute the worker loop, structured logger sink, Railway log transport, PostgreSQL, or Notion; the MCP surface is not a literal oversized public upload and does not prove normal `/mcp` composition, authentication, compression, or slow-upload behavior; the dispatch surface does not prove normal `/dispatch` composition, authentication, a real admission/quota store, or provider work; and the status surface does not invoke the normal `/status` route, a live Railway bearer, confirmation, the state manager, or filesystem persistence. Focused assembled-app tests remain authoritative for those properties. No caller fixture supplies credentials, providers, memory, confirmation, or protected effects. The status fixture uses only a frozen server-owned synthetic credential internally and never mutates `process.env` or returns that value. Successful Research validation is reported only as eligible for confirmation; confirmation is never attempted and no effects boundary is crossed. The import graph is build-gated against database connections, unreviewed database modules, provider, worker, metrics, confirmation, broad route registry, and other production side-effect modules. Its fail-closed syntax gate also rejects ambient capability aliases, dynamic/rest namespace access, listener aliases, unreviewed external bindings, mutable `process` state (including scalar-member writes) and whole-object escapes, unreviewed process effects, sensitive-helper extraction/export/reassignment, pre-validation local runtime import/re-export edges, and launcher declaration or spawn-spec drift. Whole-process-object calls are tied to unique declarations, containing functions, exact counts, and full-call AST digests; direct mutable-object receiver calls are conservative, the child `Object.keys` receiver is identity-constrained, the launcher-relative repository root is immutable, and the normal-runtime environment spread plus critical resolver/environment/listener/output helpers remain digest-pinned reviewed exceptions. The complete launcher and contained-child entry files, the central Research helper, the exact request-abort runtime and Research drain wrapper, the exact storyline shared/repository and saved-storyline/summary projection seams, the Backstage action/Trinity timeout policy, Backstage review, compact-output, output-budget, and Notion-sync Phase-A contracts plus their static constants, pure managed-auth/continuation/result cores and queued-result protection, the pure protected-continuity failure resolver, the pure GPT client registry/provenance core, Trinity direct-answer normalizer and instruction helper, Backstage continuity-query core, the partition-failure telemetry projector, GPT route timeout resolver, HRC cache policy, pure public Gaming dispatcher/canary/fixture seam, pure self-heal approval policy, exact dispatch GPT identifier middleware and its lane/identifier dependencies, config-free production MCP pre-parser core, and exact status HTTP boundary/auth/parser seam are additionally pinned by comment/format-normalized semantic digests: any semantic edit anywhere in those reviewed files requires a digest and focused-test update, while comment-only and format-only edits do not. A tracked checker-only resolver targets the reviewed request-abort source without requiring ignored `dist` output. The gate pins the public package export and build path, then a content-pinned post-alias check verifies the emitted preview imports and bindings resolve to `packages/arcanos-runtime/dist/requestAbort.js` and its comment-normalized semantic digest matches the reviewed compiled runtime. The Research and partition-telemetry helpers admit only their exact `createHash` bindings, and Research additionally admits one pure `Reflect.ownKeys(descriptors)` read.
- Every successful Backstage generation selector executes the semantic-digest-pinned pure CLEAR composer used by production, assembles its server-owned authority/CLEAR ordering through the Trinity direct-answer message helper, and forces one synthetic length-exhaustion retry. Both attempts must contain exactly one fixed CLEAR marker/version and all five dimensions, reuse the same composed system policy, and keep caller and untrusted override sentinels outside that policy. Successful responses carry `x-arcanos-preview-backstage-clear-policy-version`; the PR-head verifier requires the fixed value while response bodies remain unchanged for the trusted base-pinned lifecycle verifier. This is contained construction, placement, and retry-reuse evidence, not canonical-route, live-provider, model-compliance, or booking-quality proof.
- The existing `route-budget-provider-delay` selector also executes the production-shared heavy-wait selector, queued Backstage execution budget, and dependency-injected polling engine before its real 13,250 ms delay. The allowlist and semantic digests pin `src/shared/gpt/gptAsyncWaitPolicy.ts`, `src/shared/backstage/backstageExecutionBudget.ts`, and `src/services/queuedJobCompletionPolling.ts`; the database-backed queued-completion wrapper remains excluded. With virtual time the selector proves the protected 30,000 ms window, 250 ms default interval, 121-read derived bound, 50 ms minimum interval, and 601-read hard cap; one reused running job completes on its second read after one interval, while an always-running generic job remains pending at the generic 500 ms deadline. A successful response carries `x-arcanos-preview-backstage-queue-wait-policy-version`; its body remains compatible with the trusted base-pinned verifier, and the exact-head verifier requires the marker and reports `queueWaitPolicyVerified: true`. This is component evidence only: no literal 30-second delay, repository, database, queue integration, worker claim, canonical route, or HTTP 202 mapping runs.
- The same `route-budget-provider-delay` request executes the semantic-digest-pinned `src/shared/gpt/trinityReasoningPolicy.ts` core that the outbound Trinity structured-reasoning stage consumes. Server-owned cases prove exact and dated GPT-5 maps disabled reasoning to `minimal`, GPT-5.1 and GPT-5.6 Terra preserve `none`, non-disabled effort passes through, direct-answer disabled-effort support remains model-family specific, and strict output-token configuration defaults or clamps to 16–8,000. A successful response carries `x-arcanos-preview-trinity-reasoning-policy-version`; its body stays compatible with the trusted base-pinned verifier, and the exact-head verifier requires the marker and reports `trinityReasoningPolicyVerified: true`. This is credential-free served production-core evidence only: it does not invoke `runReasoningStage`, the normal route, OpenAI, a provider, a live model, database, queue, memory, or worker execution, and it cannot attest runtime model identity or provider acceptance.
- The Backstage `phase-one-universe-binding` selector routes independent mutations through two universe-aware in-memory adapters and uses the pure confirmation-envelope builder shared with the production gate to prove that changing only `universeId` changes the fingerprint input. It does not issue or verify a confirmation token, connect to PostgreSQL, claim durable persistence, or cross an effects boundary.
- The Backstage `continuity-query-contract` selector executes the production-shared cursor-shape preflight, sampled/exhaustive and compact-retry policy prompts, prompt assembly, and exact-page public response projection over server-owned sealed input. The additive `continuity-subtree-contract` selector executes the same production-shared prompt/response core over sealed relevant, first-page, and final-page subtree projections. It proves subtree-only scope/page fields stay coupled, coverage totals and source paths remain bounded, incomplete subtree coverage fails closed, and the continuation request passes only shape/mode preflight. A paired worker request proves that the passive worker denies the generation-contract path with the contained 404. This is component evidence only: it does not invoke the canonical authenticated route, select or diversify live chunks, resolve hierarchy or execute recursive SQL, sign or verify a cursor MAC, read live PostgreSQL or Notion data, or call OpenAI or any other model provider.
- The Gaming fixtures intentionally do not import the exact production route handlers: that graph reaches configured authentication, source repositories, jobs, providers/fetching, and persistence capabilities excluded by the containment gate. The canary instead executes the semantic-digest-pinned pure production dispatcher, bundled-fixture validator/grounding runner, and response guard, so its `passed` checks represent work actually performed while network/provider stages remain `skipped`. Contract-faithful synthetic responses cover guide/build/meta queries, closed validation, operational guarding, and exact source-route unauthorized, unsafe, outage, idempotency, and queued/running/completed lifecycle semantics. A missing preview selector returns the production-shaped 401 before JSON parsing, including for malformed and over-limit bodies. The fixed `x-native-preview-fixture` selector is a noncredential simulation of post-auth behavior, not bearer-auth evidence, and each validation selector requires its exact server-owned invalid body. Every newly enabled Gaming response carries `X-Arcanos-Preview-Fixture: sealed-synthetic`; source responses also carry `Pragma: no-cache`. The strict canary body stays identical to the public schema and production guard, which allow no preview-only field, so the response header is its machine-readable provenance. These fixtures do not invoke a provider, fetch, database, queue, worker, repository, or persistence mutation.
- The native PR worker role remains the passive health-only server. Each exact worker `/readyz` read runs a sealed, capability-free self-check through the launcher's production readiness reducer before it returns 200. The check proves two-slot admission, budget-pause 503 plus `retryAt`, stale-sequence rejection, recovery, dependency-failure priority, and shutdown/late-output rejection; successful responses carry `x-arcanos-preview-worker-budget-readiness-version: worker-budget-readiness/v1`, which the exact-head verifier requires and reports as `workerBudgetReadinessVerified`. It does not import or start the job runner and explicitly does not prove PostgreSQL ledger atomicity, advisory locking, provider dispatch, or active queue claiming; PostgreSQL 18 CI remains authoritative for those behaviors. The historical `--pr-preview-safe` flag remains available as an explicit passive fallback for both roles.
- Native application readiness reports `trustScope: trusted-pr-accidental-effects`, `protectsMaliciousPr: false`, and `requiresPlatformSecretIsolationForUntrustedCode: true`. Repository code cannot prevent a malicious PR from reading an inherited parent environment or removing its own guard. Do not enable native application previews for forks or untrusted contributors unless Railway prevents production/provider/database/Redis credentials and data from reaching the PR container before code starts.
- `npm run railway:probe:native-pr -- --pr-number <N> --commit-sha <SHA> --web-base-url https://<confirmed-web-pr-host> --worker-base-url https://<confirmed-worker-pr-host>` performs a no-network dry run. It fails unless the canonical Arcanos `origin`, local HEAD, and an entirely clean tracked/untracked worktree match the supplied commit evidence. Add both `--execute --allow-network` only after independently confirming those two hosts. The exact-PR-head live runner makes 137 bounded, sequential, credential-free, no-redirect requests: the prior 136-request matrix plus the protected-failure-no-fallback selector. The contract response is deep-compared with bounded JSON read from the revalidated exact commit and independently checked for OpenAPI 3.1.0, the exact-head numeric 1.x.y version, the exact five paths, managed result operation, UUID parameter, 30-second wait bounds/default, bearer security, and absence of legacy token/result/stream fields. The queue-wait and managed-async proof headers admit only the reviewed v1/v2 transition values; missing or unknown values fail closed. The original matrix retains 69 core requests, seven public Gaming requests, 28 Gaming-source requests (eight true unauthenticated checks, including auth-first `OPTIONS` and encoded-status cases, and 20 explicitly labeled `simulatedAuth` fixtures), two worker-role Gaming denials, six sealed self-heal approval cases, one worker-role approval-contract denial, fourteen sealed Backstage generation cases (including the managed-async, protected-failure-no-fallback, and GPT-client-identity cases as the twenty-second, twenty-third, and twenty-fourth `simulatedAuth` requests), one worker-role generation-contract denial, one saved-storyline projection case, one canon-summary pagination case, two sealed dispatch GPT identifier cases, one worker-role dispatch selector denial, one sealed status auth-before-parser case (the twenty-first `simulatedAuth` request), and one worker-role status selector denial. The saved projection trims 2,500 leading ECMAScript whitespace code points before returning exactly 1,500 of 1,501 meaningful code points. The pagination case proves exact 4,000/4,000/2,000 Unicode-code-point pages across BMP/astral boundaries, exact reconstruction, version fencing, scope and offset rejection, and null-versus-empty preservation. Both explicitly report that neither SQL nor a database boundary ran. The route-budget case runs a 13,250 ms synthetic provider seam under the production-shared Trinity run options and 40-second provider/60-second route policy, and the runner independently requires at least 13,000 ms of wall-clock response time; its sealed 20-second request timeout is exposed as `effectivePerCaseMaxRequestTimeoutMs` separately from the caller default. The HRC case proves a classified timed-out fallback is not cached before one retry succeeds and the next read is cached. The review-completion case exercises the production-shared full-review classifier, Trinity list normalizer, 1,600-token/style policy, and Booker output contract against fixed named-event and narrow-event scopes, mixed and state-field directives, balanced and unmatched quotes, astral-letter apostrophes, quoted contractions, Markdown markers, inline/collapsed honesty caveats, and spaced/single initials. It also silently executes the compact-retry, managed-async, protected-failure-no-fallback, and GPT-client-identity assertions without changing its response so an older trusted lifecycle verifier still covers all listed deployed PR-head seams. The detailed compact-retry case derives the exact contract and recovery instruction from a sealed prompt, runs the production-shared one-retry coordinator and strict final validator, and proves valid, malformed, under-count, over-count, word-overflow, second-length, and non-length behavior with no third call. The production-output case executes the semantic-digest-pinned compact parser plus the production-shared capacity, presentation, and recovery resolvers over HRC-exact, Notion-authoritative at-most, and complete-card nested-component scenarios. It proves a 6,000-token structured capacity can retain compact exact/maximum presentation, while complete-card component counts retain structured hierarchy and structured recovery. The established compact-retry request executes this proof fail-closed without changing its legacy body; the dedicated selector and versioned header provide inspectable exact-head evidence. The output-admission case replays eight alternative-card container, lexical-quantity, delimiter, compact-list, and supersession classifications, then runs the production-shared final gate over valid and malformed first-success results. It proves every synthetic provider call stops after one attempt, malformed output is rejected cause-free without exposure, and no length retry is started. The Notion Phase-A case executes semantic-digest-pinned production cores for the 4,096-reader/4,096-writer fence, 2,307/4,096 acceptance, strict 4,097 pre-effect rejection, a readable 2,117-chunk unchanged disposition, and exact late-acquisition lease cleanup after cancellation. It uses only injected deferred promises and reports that no database, Notion API, embedding, provider, or worker boundary ran. The established production-output and Notion-authority selectors execute these new assertions fail-closed without changing their legacy bodies. The managed-async case executes production-shared bearer parsing, stable principal and legacy cutover identity, exact owned-job filtering, managed poll projection, virtual-time pending-to-completed polling, terminal state projection, and AES-GCM result materialization through injected in-memory dependencies; its versioned proof header and response scan reject returned credentials, capabilities, key material, ciphertext, and stream links. The protected-failure-no-fallback case invokes the production-shared continuity failure resolver and proves zero process-fallback reads for protected, quarantined, and combined failures versus exactly one for an unprotected control. It reuses the protected failure-envelope, queued-result protection, and managed result projection cores to prove `generateBooking` and `generateBookingWithHRC` remain failed with null results and no draft-like material, requires an additive exact-head proof header, and reports every provider, HRC, database, repository, queue, worker, network, and protected-effect boundary false. The GPT-client-identity case executes the production-shared strict bearer parser, immutable registry lookup, authenticated identity resolution, bounded telemetry projection, server-owned queued-job provenance merge, and strict provenance parser; its versioned proof header and response scan reject returned credentials and untrusted model claims. The failure-telemetry case proves the exact production-shared pure projection over root-ID alias, duplicate-key, fallback-reason, deterministic-order, and maximum-512 inputs; it never runs a worker or logger sink. The two continuity cases execute the production-shared cursor-shape preflight, sampled/exhaustive and compact-retry policy prompts, prompt assembly, and exact-page/subtree public response projections over sealed input. All fourteen generation cases remain credential-free and do not call a model provider or cross a protected effect; only the Notion-authority case performs the fixed Notion edge canary below. The unauthenticated set includes malformed and 16,385-byte bodies to prove auth-before-parser behavior. After the selector, the source fixtures mirror the production 16 KiB limit, closed 413/415 parser errors, and one-decode status-path containment. The runner verifies correlation, security, `no-store`, source, dispatch, and status `no-cache`, bounded-body, and synthetic-provenance headers. It reports served-public-identity and effect-free component evidence; it does not assert Railway control-plane ownership or a live bearer credential, normal Backstage or `/status` composition, confirmation, filesystem mutation, PostgreSQL, provider, storage, queue, admission/quota-store behavior, structured logger transport, normal self-heal loop, actuator, or worker execution.
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
- Before returning its byte-compatible body, the same selector sends
  server-owned synthetic `409` error envelopes through the production-shared
  page readers. It proves official `conflict_error` is classified as
  `transient_provider`, an identifier-like unknown provider code is reduced to
  `null` with an invalid schema, exact-allowlists the errors' enumerable
  diagnostic keys, and scans that serialized projection plus the fixed error
  message for the credential, page ID, raw message, extra body data, and rejected
  code. Raw error objects are never returned; `Error.stack` and other
  non-enumerable or symbol-keyed own values are outside this proof. The exact-head verifier requires
  `x-arcanos-preview-backstage-notion-read-diagnostics-version:
  backstage-notion-read-diagnostics/v1`; the response body remains compatible
  with the trusted base verifier. This is shared-reader policy evidence only: it
  does not execute the production sync retry loop, candidate repository/SQL,
  PostgreSQL migration or activation fencing, or backfill.
- Before returning that same byte-compatible body, the selector also executes a
  server-owned database-authority transport fixture through the
  production-shared Notion context core. It proves the exact structured
  `400 validation_error` page response needed for database fallback, bounded
  database metadata with two data sources, fixed-origin data-source queries with
  a valid opaque continuation cursor, and rejection of an oversized provider
  cursor on the first response with no follow-up request. A database-row page
  response containing exactly 25 inline references is treated as incomplete;
  two fixed-origin title-property pages are assembled into the complete title in
  both capture and verification passes without following the provider's
  `next_url`. The exact-head verifier requires
  `x-arcanos-preview-backstage-notion-database-authority-version:
  backstage-notion-database-authority/v1`. This is credential-free shared-reader
  component evidence only: it does not execute the production sync coordinator,
  the 512/513 capacity fence, candidate activation, PostgreSQL, embeddings, a
  live Notion credential, or the normal authenticated route.
- The same sealed Notion-authority selector executes the production-shared pure
  partition configuration, page-material classification, routing,
  manifest-membership, reconciliation-planning, and sync request/job/result
  contract cores before returning its existing byte-compatible response body.
  Its
  server-owned scenario accepts three independently bounded 2,048-chunk shards
  with 6,144 aggregate capacity, retains the stable `raw/2026` key across a
  display-name change, rejects a required archive tier, plans hot/cold/archive
  reconciliation independently, retains a compatible last-known-good shared
  snapshot, omits one optional archive capacity failure, and still resolves the
  unrelated current-canon shard. It also classifies one added, changed, moved,
  deleted, and unchanged page; moved and unchanged material retain the same
  content hash, and the parsed sync result reports both page-version reuse and
  fewer newly embedded chunks than total chunks. A successful exact-head
  response carries
  `x-arcanos-preview-backstage-partition-contract-version:
  backstage-notion-partitioned-authority/v1`; the PR-head verifier requires the
  exact value. The same sealed selector executes the production-shared
  exact-shadow writer-admission and cutover scope predicates plus the pure
  rollback gate. Its additive
  `x-arcanos-preview-backstage-partition-cutover-repair-version:
  backstage-notion-partition-cutover-repair/v1` header proves that only exact
  `shadow` admits partition writes, scoped sampled-relevant validation is
  rejected, and same-snapshot rollback verification accepts monotonic freshness
  while closing regression, future, and expiry-extension cases. The base-pinned
  trusted lifecycle verifier still executes these fail-closed assertions through
  the unchanged response body; run the exact-PR-head verifier separately to
  require the additive repair header. This remains credential-free component E2E
  evidence. It does not import the partition repository, sync or retrieval
  services, queue, provider, database connection, or environment-backed
  partition configuration, and does not prove live PostgreSQL, worker scheduling,
  canonical route races, operator authentication, evidence sealing, embedding,
  retrieval-query, or Notion-sync behavior. The hosted PostgreSQL 18 suites
  remain authoritative for partition SQL atomicity and query behavior.
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
  current 137-request probe with both network flags from a separate, clean
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
- Worker `/readyz` remains `503` until database bootstrap,
  autonomy/module-registry bootstrap, every configured consumer slot's
  dispatcher-start write, and a supported OpenAI key setting are present.
  Absent, invalid, or exact `monolith` partition policy also retains the strict
  Backstage Notion format-readiness gate. With no configured Notion authorities
  that gate is a no-op. With authorities configured, it first verifies every
  active monolith snapshot from PostgreSQL has the current page-level
  heading/index marker. An already-current set makes no Notion request;
  otherwise one synchronous full sync must return only `activated`/`unchanged`,
  after which PostgreSQL is reloaded and rechecked. Invalid configuration,
  `lease-busy`, `failed`, an omitted root, or still-old metadata prevents the
  child readiness signal in that policy. Exact valid `shadow` and `partitioned`
  skip only this universe-wide legacy gate. Protected shard jobs can run and
  repair partition state only in exact `shadow`; exact `partitioned` freezes
  partition writers. Legacy reads keep their existing fail-closed behavior.
  Each child communicates ordered queue-acceptance transitions through an exact
  newline-delimited protocol independent of `LOG_LEVEL`; stderr, malformed or
  stale records, and embedded marker-like text cannot activate readiness. The
  launcher aggregates every configured slot with fail-closed precedence:
  `dependency_failure`, `paused_rss`, `paused_budget`, then `accepting_claims`.
  `/readyz` returns `503` whenever any slot cannot accept its configured queue
  role. Rolling job/AI-budget pauses and RSS pressure are degraded, recoverable
  states; dependency failure is unhealthy. `/healthz` remains process liveness.
  Window expiry, RSS reduction, or a successful dependency probe produces a new
  `accepting_claims` transition and can restore readiness once all other gates pass.
  When a final allowed claim or provider attempt consumes the last rolling-window
  unit, the child reports `paused_budget` before that admitted work continues, so
  readiness does not remain green until a later denied admission.
  The normal OpenAI startup readiness check does not perform a paid probe,
  though a required monolith format rebuild necessarily performs configured
  Notion and embedding work under the same worker AI-call budget. If that
  pre-readiness rebuild exhausts the rolling limit or observes a recoverable
  provider dependency outage, every configured slot publishes the matching
  non-ready state and the child retries the gate after the database retry time
  or dependency recovery; it does not require a process restart. Deterministic
  Notion configuration/index-contract failures remain fatal. After a real
  job observes provider failure, the slot publishes `dependency_failure`, stops
  new claims, and probes with backoff until recovery rather than repeatedly
  claiming and deferring jobs while reporting ready.
- The additive partition writer starts only after consumer readiness and only
  for exact `shadow` plus a valid partition envelope. Partition
  manifests and shard freshness never participate in `/readyz` or weaken the
  durable authority latch. Exact `shadow` keeps the monolith as the sole returned
  read while executing web requests and protected queued relevant worker requests
  may run bounded partition comparisons. The worker never receives cursor keys, so
  complete-scope and cursor flows stay web-only. Exact `partitioned` serves only
  manifest-scoped partition reads and fails closed without a monolith read
  fallback. It freezes scheduled, manual, and queued partition writers while
  the scheduled partition loop continues evidence and telemetry refreshes. The
  legacy monolith crawl remains active in every valid mode. When the partition
  writer is enabled in `shadow`, both crawls share one process-local coordinator,
  so they cannot overlap inside one worker replica.
  This is not a cross-replica lease for the legacy crawler, so keep one active
  worker replica during validation. Partition synchronization starts after one
  configured interval and retains bounded full Notion source scans because the
  provider has no authoritative hierarchy delta feed. Immutable material reuse
  begins only after capture. Cycle logs expose only safe mode/status metadata and
  aggregate results.
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
| `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` | Optional; required for protected Backstage Booker Custom GPT operations and private Notion-derived generation on the web service | Exact 32–4096-character visible-ASCII non-placeholder Bearer credential, distinct from every other canonical application credential. It authenticates one shared purpose-bound managed principal for all Builder operations, including queued-result polling; it is not per-user, per-session, or per-universe identity. Configure it only on the web service and in the existing Backstage Booker Custom GPT Action's API Key/Bearer field; do not copy it to a worker, schema, GPT instructions, chat, source, or logs. Legacy supplement remains optional, but mapped Notion-authority generation requires the credential and fails closed when it is missing or invalid. |
| `ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED` | Optional web automatic-routing flag; defaults false | Only exact `true` promotes workload-classified heavy generation, and malformed values fail to the false routing default. Explicit async and idempotent generation remain protected queue jobs under either setting. Enable automatic promotion only after the current payload-protection key is present on both web and worker. Enabled heavy generation fails closed rather than executing in web if the queue or protection boundary is unavailable. Set exact `false` for automatic-routing rollback. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY` | Required on both web and worker for any job-backed Booker generation | Canonical base64 for exactly 32 random bytes, distinct from all other credentials. It seals private queue input and output; never put it in Builder, requests, logs, or source. Rotate in worker-first deployment order: both roles K1 current/K2 previous, then worker K2 current/K1 previous, then web K2 current/K1 previous. |
| `ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY` | Optional on web and worker during key rotation | Decryption-only previous 32-byte base64 key. Retain through the maximum protected-job retention window, then remove. |
| `BOOKER_CONTINUITY_STAGE_TIMEOUT_MS` | Optional; defaults 20000 | Lightweight synchronous continuity provider stage, clamped to 1000-25000 ms. |
| `BOOKER_WORKER_TOKEN_LIMIT` | Optional on worker; defaults 6000 | Protected queued production-generation output budget, clamped to 4000-8000 and further constrained by the compatible GPT-5.1/GPT-5.6 request contract and remaining finite primary-stage tier. Review, continuity, unsupported-model, synchronous rollback, and genuinely small compact calls retain smaller caps. Explicit compact presentation remains enforced when other workload signals require production capacity. |
| `BOOKER_WORKER_JOB_TIMEOUT_MS` | Optional on worker; defaults 180000 | Finite protected-generation deadline anchored to durable first execution start, clamped to 120000-180000 ms, with 30000 ms orchestration headroom and 10000 ms reserved for terminal result persistence, including a finite 2000 ms cooperative abort drain. |
| `BOOKER_WORKER_GENERATION_STAGE_TIMEOUT_MS` | Optional on worker; defaults 80000 | Protected-generation primary provider stage, clamped to 45000-90000 ms and shortened to fit the job plan. |
| `BOOKER_REPAIR_STAGE_TIMEOUT_MS` | Optional on worker; defaults 45000 | One bounded protected-generation recovery stage, clamped to 10000-45000 ms and skipped when time or output budget is insufficient. |
| `ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` | Optional; configure where the selected Notion mode executes | Outbound 16–4096-character visible-ASCII token for a dedicated read-content-only Notion integration. Synchronous legacy supplement uses web; authority sync and queued legacy generation use worker. It must differ from every ARCANOS application credential and never appears in Builder. |
| `ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` | Optional; configure with the Notion token on every service that can execute legacy supplement generation | Sensitive JSON mapping from at most 32 exact universe IDs to one to three unique raw Notion page UUIDs each. Before enabling queued heavy generation for a legacy-supplement universe, copy the identical mapping to worker through the approved secret workflow. URLs and partial/invalid configuration disable enrichment before provider work. Selected excerpts enter the existing OpenAI generation request. |
| `ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` | Optional; identical closed mapping on web and worker | Selects exact Notion-authoritative universes and their fixed recursive page or database-container roots. Database resolution is gated by the exact root page-type error, queries every declared data source, and fails closed on nested databases or incomplete membership. Web uses the mapping to block/quarantine legacy state and require RAG; worker uses it to build full immutable snapshots. A malformed present value fails writes closed. After first activation, the PostgreSQL authority head is a durable one-way latch: deleting this variable does not restore legacy authority, and an unreadable/conflicting authority state fails closed with `BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE`. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON` | Optional; identical closed version-1 envelope on web and worker during partition validation | Declares bounded shards using stable keys, normal Notion page roots unique within each universe, retrieval tiers, required policy, scope/category tags, and finite capacity. Database containers remain supported only as monolithic authority roots; their synthetic zero-content records are excluded from shadow identity and page-count parity. Archive-tier shards are structurally optional and must declare `required:false`; a required archive invalidates the envelope so archive failure cannot fence unrelated current canon. Distinct universe namespaces may reuse one provider page ID. The canonical semantic digest is independent of its operator generation. This additive configuration does not replace the monolithic authority latch. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE` | Optional; identical rollout control on web and worker; defaults to `monolith` | Accepts only exact `monolith`, `shadow`, or `partitioned`. Absent or invalid values resolve to `monolith`. `shadow` is the only partition-writer mode and keeps monolith as the sole returned read while synchronizing and comparing partitions. `partitioned` freezes scheduled, manual, and queued partition writes, keeps evidence monitoring and legacy monolith synchronization active, and serves only manifest-scoped partition reads with no silent monolith fallback. Return to exact `shadow` to refresh and reseal partitions; restore exact `monolith` for read rollback. This release does not mutate any deployed value. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET` | Required on web for exact `shadow` or `partitioned` | Exact 32–4096 UTF-8-byte unpadded/non-placeholder server-only credential with no whitespace, distinct from every other purpose-bound credential. It seals new partition complete-scope cursors and must never be placed on workers, in Builder/client configuration, requests, logs, or source. |
| `ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET` | Optional on web during cursor-key rotation | Prior cursor credential accepted only for unsealing. It must satisfy the current-secret rules and remain distinct from the current key and every other registered credential. Retain it until cursors pinned to still-fresh manifests drain; removing it rejects remaining cursors sealed by the prior value. |
| `ARCANOS_BACKSTAGE_NOTION_SYNC_INTERVAL_MS` | Optional; worker only | Full-hierarchy sync cadence; default 900,000 ms, clamped to 60,000–86,400,000 ms. Partition synchronization uses the same cadence, delays its first run by one interval, and schedules again only after terminal cleanup. |
| `QUEUE_BACKSTAGE_NOTION_PARTITION_SYNC_TERMINAL_RETENTION_MS` | Optional on worker; defaults to 604800000 | Retains only completed/cancelled protected manual partition-sync job rows for 1 hour-30 days. Cleanup remains positively allowlisted and preserves active idempotency and observation windows. |
| `ARCANOS_BACKSTAGE_NOTION_RAG_MAX_STALENESS_MS` | Optional; web only | Maximum last-complete-verification age; default 86,400,000 ms, clamped to 300,000–604,800,000 ms. |
| `ARCANOS_GAMING_SOURCE_ACCESS_TOKEN` | Optional; required only for Arcanos Gaming source ingestion, refresh, and status Actions on the web service | Exact 32–4096-character visible-ASCII non-placeholder Bearer credential, distinct from every other canonical application credential. Configure it only on the web service and in the Arcanos Gaming Custom GPT Action authentication field; do not copy it to the worker service. It grants access only to the three `/gpt-access/gaming/sources/*` lifecycle routes. Generic GPT Access routes reject it, and the generic GPT Access token is rejected on the Gaming source routes. |
| `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN` | Required on the web service when HTTP control-plane, AFOL decision/inspection, reinforcement feedback/inspection, Backstage state mutation, protected DevOps/PR diagnostic execution, legacy SDK/orchestration control, `/api/self-heal/*`, `/api/self-improve/*`, detailed self-heal status, or CLI self-heal inspection is used | Exact purpose-bound bearer credential stored only in Railway Variables. It must remain distinct from approval, GPT Access, daemon, memory, worker-helper, automation, and other application credentials. Backstage mutation paths include direct, canonical GPT, GPT-selected `/dispatch`, and legacy module aliases; missing or invalid control-plane configuration fails them closed with 503. |
| `ARCANOS_CONTROL_PLANE_PRINCIPAL_ID` | Required with the control-plane access token | Server-owned operator identifier used for HTTP control-plane attribution. Do not derive it from request fields. |
| `ARCANOS_CONTROL_PLANE_SCOPES` | Required with the control-plane access token | Grant only intended operations. Manual partition shard enqueue, its actor-scoped status reads, and the bounded universe diagnostics read require `backstage:notion-sync`; enqueue also consumes a one-use challenge bound to actor, target, idempotency hash, and exact configuration. AFOL health/log/analytics and root `/memory`, `/memory/digest`, and `/reinforcement/metrics` reads require `arcanos:read`; `/api/afol/decide` requires `mcp:invoke` plus its issued one-use challenge; `/reinforce`, `/audit`, and `/reinforcement/judge` require `mcp:invoke`. Backstage `bookEvent`, `updateRoster`, `trackStoryline`, `saveStoryline`, `upsertStoryline`, and `appendCanonBeat` require `mcp:invoke` plus confirmation across every public HTTP alias; `/backstage/book-gpt` is included because it saves, while generation and simulation stay public. `/api/codebase/*` requires `repo:read`; direct PR analysis requires `repo:verify`; DevOps self-test/daily-summary execution requires `diagnostics:execute`; legacy SDK/orchestration reads require `arcanos:read`, while SDK mutations and orchestration reset/purge require `mcp:invoke` plus confirmation; prompt and AI-routing debug reads, self-heal reads, and detailed safety diagnostics also require `arcanos:read`; an active provider probe adds `self-heal:probe`; decisions require `self-heal:decide`; and `execute: true` adds `self-heal:execute`. Manual self-improve runs require both decision and execution scopes. Freeze, unfreeze, autonomy changes, and integrity-quarantine release require `self-improve:control`. Omit active grants unless the operator workflow explicitly needs them. |
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

Native PR previews keep the worker passive and run a credential-empty sealed
web application that does not mount the manual partition-sync control plane.
Preview success therefore proves the exact-SHA build, integrity gate, and
contained startup only. It does not prove control-plane authentication,
PostgreSQL admission/claiming, live Notion capture, embedding calls, or manual job
execution; focused mocked suites and PostgreSQL 18 CI are authoritative for
those effects.

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

### Disposable Backstage durable heavy-flow proof

`scripts/railway-backstage-heavy-proof-supervisor.mjs` is a non-production,
one-shot start command for proving the Backstage durable queue boundary. It is
not the canonical Railway start command and must never be configured on the
canonical project. The supervisor validates the disposable target, performs a
role-ordered read-only database preflight, then starts the unchanged
`scripts/start-railway-service-with-integrity.mjs` wrapper. The worker also
starts the credential-free loopback OpenAI fixture. A fixed fictional SDK key
exists only in the supervised application children: the worker points to that
fixture, while the web child remains pinned to a dead loopback. After the
parent binds the
PostgreSQL URL to the exact private host, port, database, credentials, and an
empty query string, it derives `sslmode=no-verify` only for the application
child because the disposable Railway PostgreSQL template uses a self-signed
TLS chain. That child connection is encrypted without authenticating the
server certificate; the parent preflight and later attestor retain the raw
query-free private-network URL. This is a disposable compatibility measure,
not authenticated-TLS proof, and it never sets a process-wide TLS bypass.

The approved target is a new disposable project in the approved workspace,
named `arc-pr<PR>-heavy-<suffix>` with a 1-14 character lowercase
alphanumeric/hyphen suffix and no more than 32 total characters, with one
isolated environment named `backstage-heavy-pr-<PR>-e2e`, exactly the services
`Postgres`, `Redis`, `arcanos-worker-pr<PR>-heavy`, and
`arcanos-web-pr<PR>-heavy`, and exactly two READY volumes mounted at
`/var/lib/postgresql/data` and `/data`. Both application services use one
replica and pin the absolute custom config-as-code path
`/railway.backstage-heavy-proof.json`. That file intentionally defines only the
exact start command
`node scripts/railway-backstage-heavy-proof-supervisor.mjs`; do not let the
repository's native ephemeral-PR config override the proof supervisor or the
role-specific pre-deploy checks below. Set a 60-second drain interval and
restart policy to `NEVER` with zero retries: the fresh-database preflights
deliberately make this proof non-restartable. Only the web service receives an
HTTP domain. PostgreSQL, Redis, and the worker receive neither an HTTP domain
nor a TCP proxy.

Configure each Railway `preDeployCommand` as an exact one-element array. The
worker value is
`["node scripts/railway-backstage-heavy-db-preflight.mjs --mode empty"]`; the
web value is
`["node scripts/railway-backstage-heavy-db-preflight.mjs --mode schema"]`.
Railway runs that command in a separate container, so deployment instance
history may temporarily retain one `EXITED` or cleaned `REMOVED` historical
record beside the one `RUNNING` application instance. The proof validates
exactly one running instance, at most one such terminal record, matching
latest/active instance identity, and the independent one-replica manifest and
region settings; it does not use the id/status-only historical record to claim
per-container attribution or equate history length with replica count.
These sealed checks run from the application images, which contain Node and the
exact tracked source. They bind the mode to the Railway role and revision, use
only the exact private PostgreSQL reference, and emit a fixed success sentinel,
an exact allowlisted nonsecret failure code, or one generic error sentinel for
every unclassified failure. They do not run inside the PostgreSQL template
container or initialize schema.

Both application roles require the exact marker
`ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET=dedicated-backstage-heavy-preview-v1`,
one shared bounded `ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID`, exact Postgres and
Redis service ID/name/private-host markers, the exact lowercase revision in
`ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA`, `ARCANOS_PREVIEW_ISOLATION=true`,
`FORCE_MOCK=true`, `ALLOW_MOCK_OPENAI=true`, and
`OPENAI_API_KEY_REQUIRED=false`. They share one fresh payload-protection key
and have no previous key. Neither role's service configuration or supervisor
parent contains a provider key. Each validated application child derives the
same fixed fictional SDK key so the adapter can initialize for readiness. The
worker alone receives
`ARCANOS_PREVIEW_OPENAI_FIXTURE=backstage-heavy-compact-retry-v1` and the
loopback base URL; it has no Booker access token or job-read secret. The web
alone receives the dedicated Booker access token, a distinct job-read secret,
`ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED=true`, and the dead
loopback base URL, so any unexpected provider call fails closed. Do not
configure any real provider key, alternate provider base, database/Redis alias,
proxy/preload option, or external Notion variable on either role.

The proof source marker is required because the authorized runner removes
automatic GitHub triggers and deploys an explicit commit through Railway's
control plane. `RAILWAY_GIT_COMMIT_SHA` is therefore optional; if Railway
provides it, it must exactly match the proof marker. The runner separately
supplies the same revision in the deploy request and verifies it in each
deployment manifest, so the application variable is not the sole provenance
authority.

The authorized run order is:

1. Before application deployment, attest the exact project, environment,
   four-service/two-volume topology, private data hosts, absence of public data
   exposure, exact source revision, one replica per app, and fresh disposable
   data-service ownership. Do not run an initializer or migration command;
   database emptiness is established by the worker pre-deploy check in step 2.
2. Deploy the worker at the exact revision first. Its sealed pre-deploy check
   requires exactly zero non-system PostgreSQL tables, and the supervisor's
   read-only startup preflight then requires `public.job_data` and
   `public.job_events` to be absent. Normal worker bootstrap may create them
   only after the integrity wrapper passes.
3. After worker readiness, deploy the web at the same revision. Its sealed
   pre-deploy check and supervisor startup preflight both require the two job
   tables to exist and both to contain zero rows.
4. Run `scripts/railway-backstage-heavy-e2e-probe.mjs` only with both
   `--execute` and `--allow-network`. The dry-run default makes no network
   request. The executable re-attests the Railway control plane before the two
   identical authenticated submissions and never supplies an explicit
   idempotency key.
5. Run `scripts/railway-backstage-heavy-at-rest-attestor.mjs` inside the exact
   worker only with both `--execute` and `--allow-database-read`. It uses a
   read-only transaction and bounded loopback attestation; it neither decrypts
   payloads nor changes database state.
6. Preserve only bounded, secret-free output, then delete the whole disposable
   project. Verify the project and web domain are gone and separately confirm
   the canonical services/deployments were unchanged.

A passing run proves the authenticated route selected the heavy queued policy,
two actor-and-semantic-identical requests produced one derived-idempotency job,
the worker renewed its lease, the fixture observed exactly one provider-health
model-list check, an incomplete 6,000-token Responses attempt, and one
fresh compact retry, and the capability-protected terminal read returned the
encrypted-at-rest result. It is proof-supervised normal application/worker
evidence, not canonical top-level start-command parity, a real OpenAI or Notion
credential test, model-quality evidence, a production deployment, or rollback
proof. A local operator orchestration file under `.codex-local/` may coordinate
the disposable run, but it remains untracked and is never release evidence.

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
Custom GPT. The tracked `contracts/backstage_booker.openapi.v1.json` is the
canonical Builder `1.7.0` contract, and the no-store endpoint serves it
directly. This source-of-truth convergence preserves the existing managed
result route, stable ownership, queue, and storage behavior; it does not require
credential rotation or a separate job-system migration. After deployment,
verify the live contract and then have a human operator refresh or re-import it
in the existing Builder Action. Repository changes do not update an already
configured Custom GPT Action automatically. The web service alone receives a distinct
`ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN`; the worker does not. Builder schema
`1.7.0` declares that credential for every operation: continuity queries,
generation, simulation, the managed
`/gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result` poll, the
exact universe and storyline-summary reads, and the canon write. All three
reads are non-consequential. Managed result continuation requires only the
saved bearer plus `jobId`, returns no dynamic job token, and exposes no bearer
SSE stream. The domain reads return a bounded repeatable-read PostgreSQL
projection or one fixed 4,000-code-point, version-fenced summary page without a
list/display-name surface or in-memory fallback. Each database statement has a
3.5-second transaction-local PostgreSQL timeout. The generic GPT Access token
and `capabilities.read` scope do not authorize them. The exact canon route may bypass
generic `ARCANOS_GPT_ACCESS_SCOPES` authorization, but the
server-side `MCP_ALLOW_MODULE_ACTIONS` allowlist must still include
`BACKSTAGE:BOOKER:upsertStoryline` and
`BACKSTAGE:BOOKER:appendCanonBeat`. Every other action fails closed on the
dedicated credential.

Heavy-generation rollout additionally requires the same distinct
`ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY` on web and worker before enabling
`ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED` on web. The existing
PostgreSQL queue remains the only job system: web encrypts private input,
deduplicates by its authenticated managed principal and semantic fingerprint,
and returns the managed bearer poll URL; worker decrypts, dispatches, encrypts
the terminal result, and never receives the Action bearer. New `1.6.0` jobs use
one stable server-owned principal, so a future Action-token rotation does not
change their owner. Payload/protection or queue unavailability fails closed
while enabled. Setting the flag to `false` restores the previous synchronous
routing policy. For payload-key rotation,
first configure both roles with K1 current/K2 previous, deploy the worker with
K2 current/K1 previous, and only then deploy the web role with K2 current/K1
previous. Keep K1 configured as previous until every K1-sealed retained job
has drained.

Before the first worker-first promotion of the Phase-A compatibility release,
deploy a producer-neutral cancellation-sanitizer precursor through the same
exact-SHA paired workflow. Its web boundary must replace the reason for every
publicly cancellable `job_type = 'gpt'` row with the reviewed server literal
`GPT job cancellation requested during rollout compatibility.` independently
of input shape, alias, or producer marker. Do not begin the Phase-A worker
upload until the exact precursor web is active and ready on every replica and
alias, every older web deployment is terminated rather than merely
superseded, no restart source can revive the older SHA, and the later of the
tracked 60-second replica drain and the bounded cancellation-route/database
transaction window has elapsed. Then run a read-only, all-status GPT inventory
that proves zero non-fixed values in `cancel_reason`,
`autonomy_state.cancellation.reason`, and `error_message` for cancelled rows,
plus zero nonterminal raw cancellation requests and zero unexpected
`producerContract` or `protectedBackstage` rows. Repeat that inventory after
another quiet window covering route completion, commit visibility, and worker
cancellation/recovery. Preserve the query digest, timestamps, counts, exact
target, and deployment IDs as rollout evidence.

Those repeated inventories establish that no unsafe retained cancellation
data exists at the Phase-A cutover; they do not prove that an older running web
request never wrote a transient value that was sanitized between snapshots.
If the acceptance criterion is zero new plaintext ever, hold
`/jobs/:id/cancel` at the edge while the old web drains. If either the endpoint
hold or the retained-state cutover evidence required by the chosen criterion
is unavailable, do not promote this release. Setting
`ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED=false` is not an ingress
hold because explicit async, query-and-wait, fallback, and idempotent GPT paths
can still enqueue work.

This release uses a temporary Phase-A compatibility drain for the
worker-first/web-second overlap. Standard unprotected GPT queue inputs emitted
by the current producers carry the exact internal marker
`producerContract: { version: 1, source: "queued-gpt-runtime" }`; current
protected Booker inputs remain separately identified by their sealed
`protectedBackstage` envelope. A new worker may treat only a marker-absent
pre-contract row that resolves to `generateBooking` or
`generateBookingWithHRC` as a legacy Booker generation. It runs that row in a
worker-only compatibility context with Notion authorization fixed false and
with optional enrichment, prompt-debug logging, transcript persistence,
content-bearing audit persistence, and cache persistence suppressed. A
marker-absent row is not sufficient by itself to authorize another module or
action, and an unprotected row carrying the current producer marker is rejected
rather than grandfathered.

The compatibility worker persists a bounded plaintext terminal envelope for a
legacy row because the old web revision that submitted it cannot decrypt the
new sealed result format. This is a deliberate, finite interoperability
exception: it does not retroactively encrypt the already-persisted legacy input
and it must not be represented as encrypted-at-rest proof. Remove the Phase-A
lane in a reviewed Phase-B follow-up only after every web replica runs the new
producer revision, no older web replica can restart, the tracked 60-second
replica-drain window has elapsed, and a conservative database inventory shows
zero rows matching `job_type = 'gpt'`, `status IN ('pending', 'running')`, and
neither an input `producerContract` nor `protectedBackstage` key. Counting all
nonterminal marker-absent GPT rows is intentional because configured aliases
and automatic intent routing cannot be reproduced safely by a standalone JSON
predicate. Until Phase B, every forward deployment must retain a worker
revision that can consume both the sealed current format and the bounded legacy
format. Phase B removes only marker-absent legacy admission; it does not make a
pre-protection worker capable of consuming sealed `protectedBackstage` rows.
After any sealed-producing web revision has been active, do not deploy or
redeploy a pre-protection worker directly and do not run the normal
worker-first workflow against an old-code revert. A raw code downgrade first
requires an enforced edge hold on every GPT write path (including Core and
configured aliases that can resolve to Booker), while leaving job-result reads
available; setting the automatic-routing flag false or removing the optional
Booker bearer is not an ingress hold. If an edge hold is unavailable, stop or
scale web to zero and accept the approved downtime. Keep the sealed-capable web
and worker plus payload key in place, wait the tracked 60-second replica-drain
window, prove no pre-hold replica can restart, and let the current worker drain.
Before downgrading the worker, the database must contain zero rows matching
`job_type = 'gpt'`, `status IN ('pending', 'running')`, and an input
`protectedBackstage` key. Before downgrading the web while preserving result
compatibility, conservatively require zero retained GPT rows with an input
`protectedBackstage` key across every status: the old web cannot unseal a
terminal result and the queue has no durable client-consumed marker. After
those gates, restore and verify every web replica and alias on the exact old
producer revision first, wait its 60-second drain/no-restart window, then
restore the matching old worker. Release ingress only after the old pair is
exact and healthy. If either inventory or replica proof is unavailable, retain
or forward-fix the sealed-capable revision; an emergency raw rollback cannot
claim result compatibility. Terminal legacy rows remain plaintext until normal
retention removes them, so at-rest evidence must continue to qualify those
grandfathered rows even after Phase B removes new legacy admission.

Queued production generation selects a finite workload-aware output allowance
from `BOOKER_WORKER_TOKEN_LIMIT` (default `6000`, clamped to `4000`-`8000`),
then reduces it when the compatible provider-stage budget is shorter. Review,
continuity, unsupported-model, synchronous rollback, and genuinely small compact
paths do not receive the extended cap. Capacity selection does not replace an
explicit exact or maximum compact-list presentation contract. Provider `incomplete` or `max_output_tokens` output
never becomes a successful job result. The exact routing rollback remains
`ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED=false`; no worker token value
re-enables the unsafe synchronous heavy path.

In ChatGPT Builder configure that value as API Key/Bearer authentication, not
OAuth or a user password. All three imported read operations are
non-consequential; the write operation is consequential, and
the backend deliberately trusts ChatGPT's Allow/Deny banner instead of issuing
a second confirmation challenge. This is one shared managed Action principal,
not per-user identity; anyone holding the credential and a known valid job UUID
can poll that protected Booker result, and anyone holding it can read any valid
exact universe ID and exact storyline key within that scope. `jobId` and
`universeId` select resources; neither authorizes access.
Phase One
mutations are unavailable on this lane and retain the existing backend
challenge on established generic/direct/control-plane/legacy paths. The
ordinary challenge default remains 2 minutes; do not lengthen it as a setup
workaround. See
[BACKSTAGE_BOOKER_CUSTOM_GPT.md](BACKSTAGE_BOOKER_CUSTOM_GPT.md) for the full
Builder and security contract.

Optional Notion enrichment is configured wherever generation executes: web for
synchronous rollback and worker for queued heavy generation. Schema `1.7.0`
uses the managed-bearer result namespace while retaining bearer provenance and
the nested public payload. Re-import it after the deployed contract changes.
Create a dedicated Notion integration
with read-content access, share only the approved pages, and configure both
`ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` and
`ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON` on each executing service. Never reuse
an ARCANOS bearer or copy the Notion token to Builder configuration. After
`1.7.0` is active on both sides, call
`generateBooking` for a mapped disposable scope through the existing private
GPT and verify the sanitized
`backstage.notion_context.loaded` event. Repeat without the dedicated Backstage
bearer and verify generation stays available but no Notion event/request occurs.
After importing `1.7.0`, verify Builder attaches its saved API-key
authentication to every operation, including `runBackstageBooker` and
`getBackstageBookerJobResult`. Verify result polling returns no dynamic job
token or stream. If Builder does not attach the credential, enrichment and the
managed continuation must remain disabled; do not remove the server-side gate.

Every Notion attempt is fixed to `api.notion.com`, rejects redirects, shares a
four-second deadline across at most three reads, caps each response at 256 KiB,
and caps prompt material at 4,000 Unicode code points per page/12,000 total.
PostgreSQL remains authoritative and Notion failures fall back to its already
loaded context. This path does not mirror, migrate, or write data. Ensure the
mapped page content is approved for the existing OpenAI provider data path.

The monolithic Notion candidate-search sidecar requires a staged Railway
rollout; deployment alone does not backfill the currently active immutable
snapshot. Apply the reviewed additive
`20260902_backstage_notion_rag_candidate_search_v1` schema first. Keep the old
web and legacy worker deployment active and healthy because the canonical
paired promotion preflights both baseline services. Do not select the backfill
target until the migration has committed; its installed `BN003` activation
fence then rejects every later canonical-only active-head change. Re-read the
exact active target, run the bounded idempotent backfill, require its final
active-head lock plus exact canonical/search/valid-search parity report,
independently recompute and match its `targetDigest`, and verify that the same
snapshot remains active. Only after those database preparations pass may the
canonical paired Railway promotion run: it deploys the compatible dual-writing
worker first and the native-reader web second. Do not dispatch the paired
promotion before completeness verification. Its general
coordinated-writer confirmation does not establish candidate-sidecar
completeness or validate `targetDigest`. Before the schema exists the new reader
can use its whole-query SQLSTATE `42P01` compatibility path, but a present and
incomplete sidecar fails closed. The design uses PostgreSQL-native arrays and a
precomputed `TSVECTOR`; it does not assume `pgvector` or an ANN extension.

The pre-promotion `targetDigest` proves the backfilled legacy active target. If
the compatible worker safely activates a successor before the web step, the
digest is historical evidence rather than proof of the new current head. The
compatible writer transaction and `BN003` fence protect that successor. After
the paired promotion, use the read-only checks below to establish the current
head and native-query outcome; do not relabel the earlier digest as current.

No production migration, backfill, deployment, restart, sync, probe, or variable
change is authorized merely by this procedure. After a separately authorized
rollout, use only read-only service, deployment, database, and sanitized-log
inspection to verify all of the following:

- the worker and web run the exact reviewed revision and both services remain
  healthy;
- a read-only database check identifies the exact current active snapshot and
  establishes declared chunk count = canonical chunk count = sidecar count =
  recomputed valid-sidecar count. If this identifier differs from the backfill
  target, record it as a compatible-worker successor and do not associate the
  pre-promotion `targetDigest` with it;
- `backstage.notion_rag.candidate_query` reports `outcome:success` with
  `queryStrategy:native_sidecar_v1`, bounded `queryDurationMs` and
  `queryTimeoutMs`, and internally consistent `scopeChunkCount`,
  `semanticCandidateCount`, `lexicalCandidateCount`, `mergedCandidateCount`,
  and `returnedCandidateCount`;
- no new candidate query reports `outcome:timeout`; if one does, retain its safe
  `timeoutClassification` (`budget_exhausted`, `lock_timeout`,
  `statement_timeout`, or `query_cancelled`) and the
  bounded timing/count fields, and correlate only against aggregate PostgreSQL
  cancellation frequency, not raw SQL parameters or content;
- server lock and statement timeouts bound admitted PostgreSQL work, but there
  is no independent transport/client-settlement deadline if `node-postgres`
  itself never settles;
- `backstage.notion_rag.snapshot_status` preserves `snapshotStatus`,
  `activeSnapshotReadable`, `freshnessSatisfied`, `activeSnapshotChunkCount`,
  `latestSyncOutcome`, `latestSyncFailurePhase`, `latestSyncFailureReason`, and
  `newerRefreshIncomplete` without relabeling `last_known_good` as current; and
- `backstage.notion_rag.sync_root_failed`, when present, exposes only the safe
  `notionHttpStatus`, `notionProviderCode`, `notionFailureCategory`,
  `notionResponseContentType`, `notionResponseSchemaValid`, and
  `notionEndpointKind` classification fields. It must not expose tokens, root or
  page IDs, URLs, response bodies, page content, raw provider messages, prompts,
  embeddings, or SQL parameters.

Rollback is old-reader/old-writer first. Drain the new web and worker, deploy the
old compatible pair, and only then apply the reviewed sidecar compensation. The
compensation removes derived search material and helper functions while keeping
canonical snapshots/chunks and the active authority head intact. Never drop the
sidecar while any new reader or dual writer can still use it.

Partition shadow validation is a separate non-cutover procedure. This release
does not change any deployed variable; preserve the current production mode
until a separate cutover is reviewed and authorized. First deploy the compatible
schema and code with exact `monolith`. Keep exactly one active worker replica,
install the reviewed identical partition envelope on web and worker, configure
the current partition cursor secret on web only, and leave all current authority
roots in place. Then set exact `shadow` on the compatible worker/web pair through
the approved variable workflow. The worker continues its legacy synchronization
and begins the additive writer only after readiness and one sync interval.
Executing web requests and protected queued relevant worker requests may
perform bounded partition comparisons, but the exact monolithic result remains
the sole authority. Cursor and complete-scope requests stay on web because
cursor keys are never distributed to workers. Inspect aggregate
published/blocked/deferred,
shard outcome, reuse, embedding, and coverage-difference telemetry. Do not infer
parity from chunk totals because the two bounded chunkers may differ. Ordinary
logs must not contain configuration JSON, roots, page IDs, titles, paths,
generation IDs, content, embeddings, cursors, credentials, or provider errors.

To stop shadow validation, first establish a controlled maintenance freeze that
prevents every principal with `backstage:notion-sync` from submitting new manual
partition syncs. Do not treat an actor-scoped status read as global queue proof.
While the compatible web/worker pair still uses exact `shadow`, let the
compatible worker finish queued and running partition-sync jobs, drain its
cooperative shadow cycle, and then stop it gracefully. In exact `partitioned`,
new partition work is already frozen and a claimed old queued job completes with
a bounded disabled result. Still require the same zero-aggregate check. With the
compatible web still partition-enabled, inspect protected diagnostics for every configured
universe and require `activeLeases`, `queuedJobs`, `runningJobs`, and
`unconfiguredActiveJobs` all to be zero. Actor-scoped status may supplement this
check for known sync IDs only. If any aggregate is nonzero, restart the same
compatible worker and reconcile it before repeating the stop-and-inspect gate.
Only after the admission freeze is in force, the compatible worker has stopped,
and every aggregate is zero should the web be restored to exact `monolith` and
its old replicas allowed to drain. Then deploy the downgraded worker with exact
`monolith`; never allow it to claim an unsupported partition-sync job type.
This rollback stops future partition writes; it does not delete immutable shard
snapshots/manifests, alter the monolithic active head, downgrade the durable
Notion authority latch, or restore legacy writes. A stalled database operation
can outlive the cooperative abort until Railway's outer drain bound, so confirm
the old worker is stopped before treating rollback as complete.

Exact `partitioned` is a controlled read cutover, not an automatic promotion.
The rollout target's five shard identities and required set must be read from the
reviewed identical configuration on web and worker; do not hard-code names or
infer membership from display labels. One full source-generation capture must
bind every required shard to the same source digest and exact source coverage.
Do not select partitioned mode until the exact compatible web/worker SHA, current
configuration digest, required-shard manifest membership, freshness, failure
isolation, bounded candidate queries, memory bounds, and shadow comparisons have
all been reviewed. The web must have the current partition cursor secret before
mode activation. Before changing modes, freeze manual partition admission, let
queued/running jobs and the scheduled cycle drain, stop the compatible `shadow`
worker, and require zero active leases and zero queued/running/unconfigured
active jobs in protected diagnostics. Then run the explicit validator from the
exact reviewed checkout and compatible operator environment:

```bash
npm run backstage:notion:partition:cutover:validate -- --cases-file <path> --seal-current
```

The regular file is capped at 256 KiB and must bind its representative cases to
the exact current universe, configuration generation, and semantic digest.
Representative queries are read only from that file, not directly from argv or
an environment variable. Keep it private. The reviewed database migrations must
already be applied; this command does not apply schema changes or change the
deployed mode. It fails closed if the live mode is not exact `shadow`, the
authority/manifest anchor moves, the environment and durable active
configuration generation/digest diverge, work becomes active, representative
parity fails, or its inputs are stale. A successful bounded report means
only that one universe evidence set was sealed. Run the command separately for
every universe in the reviewed configuration and require every bounded result to
succeed before cutover; evidence for one universe never covers another. Normal
build output precedes each validator result. If a nonzero bounded result says
`evidenceSealed:true`, the evidence commit occurred and only a post-commit report
or database-cleanup step failed. Treat it as a committed effect, resolve the
bounded failure, and inspect the durable gate before considering another run.

When the separate cutover is authorized, change the compatible pair through the
approved worker-first/web-second workflow so the web cutover is last. Exact
`partitioned` rechecks the durable gate, freezes all partition writers, and keeps
only its evidence monitor plus the legacy monolith synchronization path active.
Partition reads are manifest-scoped and fail closed; they never silently retry
the monolith. A later partition content refresh requires returning the compatible
pair to exact `shadow`, reconciling and draining it, and sealing new evidence
before another worker-first/web-second cutover. Restore exact
`monolith` only through the preceding controlled admission-freeze,
compatible-worker drain/stop, and zero-aggregate diagnostics gate. Then drain
the old web replicas before deploying the downgraded worker with exact
`monolith`. A mode change invalidates an in-flight complete-scope cursor from the
other index format; clients must restart at the first page.

The code-level gate additionally requires durable evidence sealed to the exact
configuration, source generation/digest, active manifest, current and published
reconciliation epoch, supported embedding model and index format, and a fresh
readable `current_complete` monolith for rollback. It must record representative
relevant comparisons, exact-scope parity, complete-scope coverage through the
final cursor, and cursor stability. Registration advances the epoch before shard
work; a failed or incomplete reconciliation therefore makes older evidence
ineligible without touching the active manifest. Missing, expired, mixed, stale,
or failed evidence keeps `cutoverAvailable` false, keeps partitioned reads
disabled, and leaves the effective mode monolithic. The sealed rollback
verification time is immutable. A newer verification may corroborate only the
same rollback snapshot and must be monotonic, nonfuture, fresh, and within the
original evidence-expiry and rollback-validity windows; it never extends either
window. A new snapshot or timestamp regression closes the gate. Synchronization
and startup cannot seal evidence or change the deployed mode automatically.

Manifest publication is one transaction: every configured shard must be sealed,
readable, complete, on the same generation, and covered by the one manifest before
the active pointer and published epoch advance. A failed shard or activation
transaction leaves the previous complete manifest active. Controlled rollback
atomically reactivates that prior complete manifest and advances/publishes a new
epoch; it never reconstructs a partial set. Every request and complete-scope
cursor remains pinned to one manifest version, and a cursor from another version
fails closed instead of mixing generations.

Before shadow validation, audit routing tags as a closed contract. Current lanes
use `brand:raw`, `brand:smackdown`, `brand:nxt`, or `lane:ples`; year lanes use
`year:YYYY`; and shared current canon requires the exact scope tag `shared`.
The PLE lane is selected only by `PLE`, `premium live event`, `pay-per-view`/`PPV`,
or the closed built-in named-event set. Names and shard keys do not imply tags.
More than eight distinct years or more than 32 derived selectors in one request
fails closed. Exact `archive`, `archives`, or `archived` wording
selects only the `archive` tier; without that wording, only `hot` and `cold` are
eligible. Confirm that omitted optional archives are unrelated to current-canon
requests and that any omitted selected shard still fails the read closed.

Cursor-key rotation must prime acceptance before minting K2 on rolling or
multi-replica web deployments. Phase 1 deploys K1 as current and K2 in
`ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET` to every replica;
drain every K1-only replica before continuing. Phase 2 deploys K2 as current and
K1 in the previous slot to every replica. Both phases can unseal either key, so
a new cursor and a rollback remain valid across the rolling boundary; new
cursors are always sealed by that phase's current key. Remove K1 only after its
still-fresh cursors and the approved rollback window drain. The two values must
be exact 32–4096 UTF-8-byte unpadded, non-placeholder, whitespace-free
credentials, distinct from each other and every other purpose-bound credential.

Notion-authority/RAG is an incompatible, two-phase cutover. Do not let the
normal worker-first deployment activate authority while any old web replica or
alias can still serve legacy canon. In phase one, keep
`ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON` absent (or keep the target
universe out of it) and keep the authority-mode Notion token off the worker.
Deploy the exact code and additive migration through the normal
worker-first/web-second pair, then prove every active web and worker replica is
running that compatible exact SHA. No worker sync may activate a head during
this phase.

The V3 snapshot-capacity rollout remains reader-first. Its precursor installed
the 4,096-chunk database constraint and read path while retaining a 2,048-chunk
writer fence. This bounded follow-up advances the writer ceiling to the proven
4,096 reader ceiling; 4,097 or more still fails before embedding or candidate
creation. Before permitting synchronization, prove every active web and worker
replica is on a 4,096-capable reader revision and no older reader can restart.
Promote the compatible worker/web pair through the separately authorized normal
workflow. This repository release does not deploy that pair, change variables,
change partition mode, or trigger synchronization.

Deployment verification must inspect active-snapshot state separately from the
latest synchronization attempt. A failed or interrupted refresh leaves the
previous complete active pointer and its metadata unchanged. Continuity can
report that readable state only as `last_known_good`, with its verification time
and bounded failed-refresh metadata; it is never current-workspace proof.
Protected booking generation continues to require `current_complete` and fails
closed for `last_known_good`, unavailable, incompatible, or expired state.

Activation is one-way and intentionally quarantines old canon. Before phase
two, drain/cancel queued mutations for the exact universe, reconcile
commit-unknown results, and take the approved recovery export of the existing
revision-6 legacy state. Put the reviewed authority root mapping on the already
compatible web service first, without a web Notion token, and verify its exact
universe guard is active. Then put the identical mapping plus the read-content
Notion token on the already compatible worker and enable its sync loop. Keep
the authoritative universe out of the legacy page supplement. For each initial
cutover, set `initialMinimumPageCount` to the independently reviewed reachable
real Notion-page count, excluding a synthetic database container (for example,
`18` for a reviewed 18-page hierarchy). Verify one
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
exercise the sealed max-output seam: only eligible max-output exhaustion gets
one bounded output-length recovery attempt over the same retrieval and budget,
and a second exhaustion returns the sanitized incomplete-output error. Compact
requests retain their numbered item contract; structured complete-container
requests retain component hierarchy. Confirm each response used one snapshot, no
Notion request originated from web, no legacy repository/fallback was called,
and OpenAI storage/transcript/cache suppression remained active.
Only after the backend serves schema `1.7.0`, re-import that contract into the
existing Builder Action, preserve its saved bearer and visibility, and repeat
one page and one subtree request through the GPT. Then remove any
authority-only Notion token left on web. A failed new crawl
must leave the prior active snapshot unchanged; once its verification age
exceeds the configured limit, generation must stop rather than use old canon.
Restoring PostgreSQL authority is a separate emergency governance operation,
not an automatic rollback or GPT action.

The lane has no previous-token overlap setting. The `1.6.0` deployment maps the
exact current credential to one stable managed principal for new jobs and also
checks the exact-current-token-derived legacy owner for pre-cutover jobs. That
check is result-read compatibility only and does not alias the old idempotency
scope. Keep K1 current, preserve returned job IDs, never resubmit legacy work as
a lookup, and drain both the result-retention and idempotency windows; the
compatibility check cannot read an undrained K1 legacy job after K2 becomes
current. Once the legacy windows are clear, a K1-to-K2 rotation preserves reads
for stable-principal jobs but still
requires a coordinated web-service variable change/deploy and existing-GPT
authentication update, with a brief expected authentication gap. Verify one
retained `1.6.0` result through K2 without printing either credential. To revoke
or roll back, remove the web-service credential, restore the last reviewed
Builder configuration, and deploy the approved backend revision. Those actions
do not erase previously committed canon; any data correction remains a separate
authorized mutation.

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
production deployment job can enter its concurrency group. The current
`ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD` value is the active
`20260830-job-events-worker-budget-v1` ID for the incompatible worker
hard-budget evidence rollout. Automatic `workflow_run` promotion is skipped
without starting or cancelling a deployment. A manual dispatch fails unless
the operator types the exact confirmation
`COORDINATED WRITERS DRAINED: 20260830-job-events-worker-budget-v1`.

The repository policy cannot suppress Railway's separate GitHub-source
auto-deploy trigger. Keep native auto-deploy disabled on both `ARCANOS V2` and
`ARCANOS Worker` while the GitHub paired workflow is canonical. Enabling either
trigger would permit a source push to bypass worker-first ordering, exact-ID
observation, and the shared production concurrency lock.

The typed phrase does not stop a process, apply a migration, validate a target,
or authorize production work. Before using it:

1. Obtain the normal target-specific deployment and database authorization.
2. Inventory every legacy queue claimer and worker-originated provider path,
   including every web/worker replica and separately operated process.
3. Verify Railway-native auto-deploy remains disabled on every production
   writer so a source push cannot bypass the repository hold.
4. Drain or stop every legacy path, allow already admitted work to finish, and
   verify that an older binary cannot restart.
5. Keep every legacy claim/provider path continuously quiet for one complete
   one-hour budget window.
6. Apply and verify all six worker-budget migration phases in documented order,
   then run all six again to prove idempotence.
7. Confirm the compatible revision, identical hard limits for every replica in
   each stats group, and the migration are the approved rollout pair.
8. Dispatch the workflow only for that approved revision. The workflow deploys
   the explicitly configured worker first and web second; inventory and
   coordinate any additional writer through its separately approved mechanism.
9. Verify the installed schema and indexes, exact revision on every writer,
   absence of old replicas, deployment health/readiness, and bounded application
   diagnostics. Keep the hold active through any rollback decision.

Return the hold to the inactive `none` sentinel only in a separately reviewed
repository change after all of those checks pass. The change introducing this
rollout cannot remove its own hold. Missing, blank, whitespace-padded, or
malformed hold values fail closed rather than restoring automatic promotion.

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
3. If a sealed-producing Backstage web revision has become active, the generic
   worker-baseline option is unsafe until the heavy-generation rollback gate
   above is satisfied. Enforce the approved GPT-write ingress hold, keep the
   sealed-capable web/worker and payload key through the drain and inventory,
   require zero retained protected rows before a result-compatible web
   downgrade, then restore web first and worker second with both replica-drain
   checks. Do not use the normal worker-first workflow for that old-code revert.
   If the gate cannot be proved, forward-complete or retain the sealed-capable
   revision.
4. In each confirmed target's deployment history, identify the exact approved
   deployment for that recovery decision.
5. Redeploy only those approved versions, then repeat exact web/worker role,
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
