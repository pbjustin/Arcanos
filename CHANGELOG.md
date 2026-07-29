# Changelog

Notable release-facing changes are recorded here. Detailed implementation and
audit history remains available in Git and under `docs/audits/`. The structure
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) where practical.

## [Unreleased]

### Changed

- Moved executable module registry ownership out of the legacy route adapter
  into an immutable, single-flight service registry shared by writing dispatch,
  GPT Access, daemon, MCP, introspection, and diagnostics consumers.
- Made MCP `modules.list` use the safe public `/registry` projection while
  preserving its bounded client-visible fields, and made the GPT Access CLI
  fallback derive its route, metadata, actions, and handlers from the canonical
  cataloged definition.
- Made public runtime module diagnostics derive from explicit, validated catalog
  keys, filling the Gaming, Tutor, and HRC gaps while omitting protected
  GPT Access-only definitions.
- Made GPT-map rebuilds project the same immutable registry generation used for
  metadata and execution, and reject absent or mismatched environment override
  targets instead of creating map/registry divergence.
- Preloaded the root job worker's module registry before its readiness marker
  and consumer-slot startup, so the first claimed GPT job no longer absorbs the
  sequential catalog cold load.
- Inverted worker-control and OpenAI-health metric refresh behind composition
  providers, keeping the metrics registry a dependency leaf and breaking the
  dominant cross-layer dependency-cycle cluster.
- Moved Trinity honesty contracts and queued bridge-smoke input ownership into
  dependency-neutral type modules, removing three compile-time-only cycles
  without changing their public type exports.
- Inverted both control-plane implementations behind a structurally validated,
  request-scoped ARCANOS MCP port supplied by HTTP, internal, and stdio
  composition, made that port the shared executor-service type authority,
  removed the concrete MCP client back-edges, and failed closed when the port
  is unavailable.
- Replaced Trinity, audit, reflection, and patch-proposal imports of the broad
  OpenAI facade with its existing credential, chat, and reasoning leaves,
  preserving the facade API while removing the image-generation re-entry cycle.
- Inverted ARCANOS:CORE operator-command routing behind an explicitly composed
  provider for web, database-worker, and stdio MCP roots, failing closed when
  unconfigured and eliminating the final GPT Access and self-heal cycles.
- Consolidated Ask and GPT hybrid queue-wait mechanics into one dependency-free
  bounded polling engine while retaining their distinct terminal-state mapping
  and concurrent abort-versus-repository-error policies.
- Moved pure GPT async-job completion recognition, response metadata, and
  direct-wait timeout shaping out of the main GPT router into a focused,
  directly characterized route helper.
- Moved the GPT route's execution-mode precedence tree behind a pure,
  branch-complete policy classifier while keeping request parsing, environment
  thresholds, memory overrides, queueing, and response effects in the router.
- Moved GPT Access string and payload sanitization into a dependency-light,
  directly characterized policy module while preserving gateway re-exports and
  redaction precedence.
- Reduced ActionPlan executor capability reads from one locked Agent query per
  action to one fresh query per transaction, preserving authorization and
  replay error precedence for plans containing up to 100 actions.
- Consolidated duplicate quickstart, compatibility, CLI, refactor, and
  governance documentation into maintained subsystem owners.
- Replaced the flat documentation reading list with a lifecycle-aware index that
  separates canonical guides, docs-as-contract, design-only material, generated
  indexes, and historical evidence.
- Replaced the Bash-only documentation audit logic with one cross-platform Node
  check exposed as `npm run docs:check`.
- Restricted database retries to explicitly audited transient reads, made
  collation inspection passive, and serialized schema initialization so
  concurrent startup cannot interleave DDL or retry mutation-shaped work.
- Added monotonic claim generations to database-backed worker ownership and
  monotonic snapshot generations to persisted DAG runs, with guarded
  PostgreSQL 18 migration, rollback, and concurrency coverage.
- Added per-process DAG admission limits, bounded terminal retention, durable
  cancellation intent, ownership-conflict quarantine, and exact reconciliation
  for initial snapshot outcomes before execution begins.
- Hardened the release path so publication consumes only the validated source
  revision, production promotion can be held for coordinated writer rollouts,
  and startup, coverage, PostgreSQL fencing, and deployment-readiness checks
  remain required CI evidence.

### Security

- Moved direct system-state reads and optimistic updates behind an exact,
  pre-parser control-plane boundary: reads require the operator bearer and
  `arcanos:read`, mutations require `mcp:invoke` plus a principal- and
  body-bound one-use challenge, strict mutation JSON is capped at 64 KiB,
  caller-selected session identifiers are bounded, responses are `no-store`,
  invalid traffic cannot exhaust an authenticated operator's ingress bucket,
  and invalid requests no longer reflect internal exception text.
- Contained direct `/rag/*` HTTP access behind an exact pre-parser operator
  boundary: queries require `arcanos:read`, persistent fetch/save ingestion
  requires `mcp:invoke` plus an actor-, principal-, path-, and body-bound one-use
  challenge, operation-specific strict JSON/schema limits run before broad
  parsing, provider/database work shares a two-slot immediate-admission cap
  with stable retryable busy responses instead of an unbounded queue, public
  failures are stable and non-reflective, and documentation now makes the
  deployment-wide shared-corpus boundary explicit.
- Preserved the deprecated `GET /status` and confirmed `POST /status` success
  contracts while marking their responses—including confirmation
  challenges—`no-store` and replacing raw exception responses and route logs
  with fixed public text and closed failure classification. The shadowed
  detailed-health compatibility handler now applies the same containment if
  route ownership changes.
- Replaced `/railway/healthcheck` filesystem paths, worker filenames,
  free-form reasons, and exception reflection with a stable no-store public
  projection while preserving its healthy/degraded HTTP status behavior.
- Required the existing timing-safe bridge secret for detailed Custom GPT
  bridge health, marked its responses private/no-store, and replaced raw
  database, worker, and route-resolution errors with fixed public messages;
  the bridge OpenAPI contract is now version 1.2.0 and documents the new
  authentication and misconfiguration responses. Both authenticated bridge
  execution aliases now also return fixed unexpected-failure and idempotency
  conflict messages while retaining redacted server diagnostics.
- Replaced persisted worker failure text in the credential-free queue
  diagnostics response with fixed category labels, preserving aggregate
  operational fields and marking the response `no-store`.
- Replaced raw provider and internal exception text in shared AI timeout,
  failure, and mock-fallback responses with stable classification-specific
  messages while retaining redacted structured diagnostics server-side.
- Replaced the public readiness endpoint's raw dependency errors and arbitrary
  metadata with fixed per-check failures and an explicit projection, retained
  only the four Redis lifecycle fields required by the recovery verifier, and
  marked both successful and unavailable readiness responses `no-store`.
- Replaced raw web-search provider failure text with the stable
  `WEB_SEARCH_FAILED` public contract while retaining structured server-side
  diagnostics.
- Kept asynchronous GPT and DAG failures inside the public `/dispatch` error
  boundary and replaced exception reflection with the stable
  `DISPATCH_FAILED` response.
- Removed route-local wildcard CORS headers from both SSE compatibility paths
  and made the global middleware the single policy owner, with exact
  canonical-origin matching and no credential headers for denied origins.
- Unified backend and worker Responses-to-ChatCompletion semantics so refusals
  and callable payloads survive conversion, incomplete outcomes retain their
  terminal metadata, and failed, cancelled, pending, unknown-status, or
  unrepresentable tool-only responses cannot masquerade as successful stops;
  structured JSON parsing now also requires an explicit completed lifecycle
  and rejects valid-looking partial output from incomplete responses.
- Replaced credential-shaped and prototype-sensitive property names with
  collision-safe opaque markers in the shared runtime redactor, preventing
  `__proto__` setter mutation and key-name disclosure across logs, control-plane
  responses, job events, and worker diagnostics.
- Removed the redundant direct `/api/reusables*` mount, leaving the canonical
  API router as the sole owner so its memory-consistency middleware cannot be
  bypassed by a future route-order change.
- Replaced whole-directory service evaluation with a frozen 15-entry module
  catalog, strict name/action/exposure validation, immutable definition
  snapshots, coalesced loading, defensive cache results, and deterministic
  route ownership.
- Confined `ARCANOS:CLI` execution to authenticated GPT Access, reserved
  protected CLI, Local Agent, and Productivity identifiers from public fuzzy
  routing, and removed CLI's unintended default GPT, public registry,
  introspection, `/modules/cli`, and `/queryroute` exposure. Authenticated
  daemon and GPT Access discovery retain the complete catalog.
- Rejected protected identifiers as GPT map keys as well as targets, including
  overrides for protected definitions that fail to load, so environment maps
  cannot advertise unusable or protected public bindings.
- Added dedicated, purpose-bound authentication and server-owned authorization
  context for mutating HTTP control-plane routes.
- Confined direct worker module execution to validated regular files inside the
  worker directory and authenticated it before action confirmation.
- Hardened `ARCANOS_WORKER_HELPER_TOKEN` configuration and request parsing with
  length, placeholder, whitespace, credential-isolation, duplicate-header, and
  single-carrier checks.
- Authenticated the bundled helper's protected commands and remote worker-repair
  actuator with the strict env-only worker-helper credential, exact-origin and
  redirect containment, fail-closed actuator availability, and bounded,
  allowlisted remote responses whose target-controlled text is discarded before
  local result generation. Public worker-helper status remains token-free.
- Authenticated direct `/workers/heal` before confirmation or planning, shared a
  bounded principal rate limit across both worker-heal entry points, and
  replaced raw mutation-failure disclosure with a stable response.
- Added a distinct, custom-header-only memory-plane credential for the
  production memory and save-conversation APIs and exact GPT memory
  interception, with fail-closed configuration, purpose isolation,
  non-storable authenticated responses, direct execution, and defensive
  dispatcher authorization.
- Extended that credential boundary to the complete durable `/api/sessions*`
  prefix and moved all three HTTP memory/session families before broad body
  parsing, closing parser-first anonymous access while keeping API health
  public.
- Made the optional debug watchdog fail closed when its purpose-bound key is
  missing, invalid, or reused, while preserving exact custom-header access and
  request-time credential rotation.
- Replaced anonymous `/api/daemon/*` transport access with a distinct,
  custom-header-only deployment credential; kept daemon control traffic outside
  writing-plane rerouting, preserved historical store partitions without
  persisting the new credential, and updated the Python daemon to suppress
  generic Bearer/GPT-ID credentials on daemon paths.
- Protected the complete direct `/api/self-heal/*` namespace with the existing
  purpose-bound control-plane operator principal before broad body parsing,
  added least-privilege read, provider-probe, decision, and execution scopes,
  retained the agent capability check as a secondary compatibility prerequisite, and moved
  self-heal control traffic ahead of writing-plane consistency routing.
- Extended that boundary to `/api/self-improve/*` and detailed
  `/status/safety/self-heal`, added explicit execution/control scopes and shared
  principal rate limits, preserved capability checks as compatibility prerequisites,
  and authenticated the shipped CLI inspection client.
- Moved repository-file and raw prompt-trace inspection onto authenticated,
  scoped control-plane routes with no-store responses, bounded limiting, and
  terminal namespace handling before writing-plane consistency.
- Canonically confined repository-file inspection to `CODEBASE_ROOT`, rejected
  link/junction and NTFS alternate-stream escapes, replaced whole-file reads
  with bounded file-handle reads, and capped directory enumeration.
- Made prompt and AI-routing traces metadata-only and memory-only by default,
  added explicit off/full modes and byte-capped opt-in JSONL persistence,
  removed raw prompt coupling from self-heal, completed GPT Access content
  suppression, and protected the alternate AI-routing debug read endpoint with
  the control-plane operator boundary.
- Closed anonymous DevOps model execution and direct PR verification behind
  pre-parser control-plane operator scopes, per-principal budgets, and
  single-flight locks; removed caller-selected self-test targets/attribution,
  bounded self-test transport and subprocess output, and rejected PR traversal
  and escaping-symlink file access.
- Reclassified legacy SDK and orchestration endpoints as operator control-plane
  surfaces, requiring scoped bearer identity before parsing or confirmation,
  adding shared mutation budgets and single-flight locks, protecting sensitive
  reads, and replacing raw SDK/orchestration failure disclosure.
- Restored fail-closed authentication to the opt-in BullMQ/Redis runtime with a
  distinct purpose-bound Bearer credential, explicit enqueue/read scopes,
  server-owned job ownership, indistinguishable cross-principal reads,
  pre-parser enforcement, stable failure responses, and mock-queue HTTP
  regression tests that do not initialize Redis or OpenAI.
- Added iterative structural budgets and worker-side revalidation to that
  runtime's untrusted job payloads, and replaced raw provider/BullMQ result
  exposure with a bounded public text-or-timeout projection applied before
  persistence and again on reads.
- Made the standalone runtime's exact model allowlist, default output-token
  limit, and hard output-token ceiling server-owned and fail-closed at both HTTP
  admission and worker execution.
- Added fail-closed Redis-time enqueue limiting, a shared outstanding-job
  reservation ceiling, BullMQ-token execution claims, terminal-state release,
  and bounded stale-reservation reconciliation to the standalone runtime.
- Added a validated standalone Redis URL path for ACL/TLS deployments, separate
  readiness-gated producer and long-lived worker connection profiles,
  import-safe Queue ownership, credential-free error reporting, and worker-only
  provider-secret validation; API and worker now require one explicit,
  deployment-scoped Queue/admission namespace.
- Added Redis-aware readiness probes, a bounded worker Redis-startup deadline,
  and bounded, idempotent HTTP/worker signal shutdown that drains accepted work
  and terminal reservation releases before closing owned BullMQ resources.
- Added a required disposable-loopback Redis CI suite that executes the
  standalone runtime's Lua lifecycle and concurrent cross-replica admission
  invariants plus real BullMQ execution fencing and terminal release without
  flushing or accepting remote Redis targets.
- Bounded authenticated self-healing mutation bodies, constrained retained
  simulation arrays/strings, prohibited simulated live execution, and made
  server enablement/dry-run policy authoritative over HTTP execution requests.
- Protected integrity-quarantine release with the same control-plane operator
  identity, `self-improve:control`, shared mutation limiting, and confirmation;
  attributed release to the server-owned principal and removed raw quarantine
  IDs and metadata from public safety/unsafe responses.
- Removed free-form self-healing reason/action/component fields from public
  safety status and replaced worker diagnostic failure details with stable
  non-disclosing responses and bounded structured events.
- Moved direct DAG inspection and mutation behind the control-plane boundary,
  with scoped reads, confirmation-gated creation/cancellation, bounded bodies,
  no-store responses, and exact pre-parser route ownership.
- Removed shell and path injection from self-improvement execution, and
  hardened CEF ingress with authenticated routing plus principal-, operation-,
  target-, and payload-bound single-use execution permits.
- Protected reinforcement and AFOL ingress with control-plane authorization,
  bounded parsing, prompt-trust isolation, minimized/redacted persistence, and
  canonical-file containment.
- Protected assistant-registry reads and synchronization with scoped
  control-plane authorization, challenge-bound mutation, canonical path
  validation, and integrity-aware atomic replacement.
- Enforced the canonical purpose-bound credential collision policy at every
  listed TypeScript and Python authentication boundary, including ActionPlan
  roles, local-agent rotation, GPT Access, automation, MCP, metrics, bridge,
  approval, root/admin, CLI, and debug credentials.

### Fixed

- Restored the Madge TypeScript dependency-cycle gate to the executable
  `check:boundaries` command while retaining its CEF layer-access checks, and
  removed the obsolete unwired TypeScript script.
- Corrected the `self-test` and `daily-summary` package scripts to use their
  emitted `dist/core/commands/` entry points.
- Allowed the commit guard to inspect large staged diffs with a bounded
  subprocess buffer instead of failing before its artifact and secret checks.
- Corrected stale routing, authentication, environment, CLI, MCP, OpenAI,
  self-healing, Railway, and source-path guidance against current code and
  executable configuration.
- Removed an active recommendation to run the unsafe `npm run probe` command.
- Extended documentation validation to check all tracked Markdown link targets
  and require every top-level `docs/*.md` file to appear in the index.
- Distinguished durable job-repository outages from missing jobs across
  canonical job polling, async Ask/GPT waits, and the Custom GPT bridge;
  affected operations now return sanitized `503` contracts and preserve
  accepted job coordinates where available.
- Patched the vendored brace-expansion dependency and synchronized its declared
  pin with the reproducible lockfile.
- Prevented cancellation from overtaking initial DAG snapshot admission and
  reconciled PostgreSQL commits whose acknowledgement is lost, avoiding
  durable queued snapshots with no executing owner.
- Wired claim-generation and DAG-snapshot PostgreSQL 18 integration suites into
  the isolated CI database job instead of allowing their database cases to
  remain skipped.

### Removed

- Retired the legacy root probe command and implementation because it exposed
  credential prefixes and depended on a missing test artifact; maintained
  build, subsystem validation, Railway validation, and health checks replace it.
- Removed completed migration/refactor notes and the unimplemented async job
  board proposal. The standalone operations dashboard was removed only after
  its implemented metrics, alert, SLO, and replay guidance moved into the
  canonical solo-operator runtime guide.
- Removed standalone micro-guides whose content is now owned by the Python
  daemon or consolidated governance guide.
- Removed the unreachable duplicate `/api/update` handler from the daemon
  router; the canonical public validation route remains unchanged.

## 2026-03-03

### Changed

- Updated Railway deployment and health guidance.
- Added Responses API tool-continuation documentation.
- Refreshed local setup and runbook documentation.

[Unreleased]: https://github.com/pbjustin/Arcanos/compare/v1.0.1...HEAD
