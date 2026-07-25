# Final Productivity Review — PR 1408

## Review identity

- Reviewer: independent productivity-domain reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed runtime head: `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Scope: the complete base-to-head diff of 125 changed files, 35,999
  additions, and 312 deletions, plus the final review-only documentation
  corrections in the shared worktree
- Verdict: **APPROVE WITH CONDITIONS**
- Confidence: **high (0.95)**
- Open Critical findings: **0**
- Open High findings: **0**

No Critical or High finding is waived. This verdict approves the productivity
implementation in the reviewed runtime candidate for Ready for Review. It does
not authorize merge, production deployment, production migration, or
production enablement.

## Executive summary

`ARCANOS:PRODUCTIVITY` is a coherent, protected TypeScript capability module
that fits the existing ARCANOS architecture:

```text
ChatGPT / Custom GPT
  -> /gpt-access/*
  -> TypeScript authentication, scope, policy, confirmation, and tracing
  -> protected ARCANOS:PRODUCTIVITY module
  -> deterministic productivity service
  -> tenant-scoped repository transaction
  -> PostgreSQL canonical state, command receipt, and outbox event
  -> structured result for conversational presentation
```

The module provides the intended 24 actions across intent and reference
resolution, current state, inbox, tasks, projects, focus, knowledge, and
reviews. Read-only actions are explicit. Every mutation is privileged,
confirmation-gated, tenant-scoped, lifecycle-validated, event-producing, and
idempotent.

TypeScript remains authoritative for identity, tenancy, public contracts,
confirmation, domain rules, persistence, and protocol behavior. Productivity
does not depend on Python, create a Python public API, use `/gpt/:gptId`, expose
a legacy module route, place repository/process capabilities in the
productivity module, add a second queue, or introduce a second workflow engine.

## Independent review coverage

I independently inventoried and read every changed file. The review included:

- all TypeScript and Python source changes;
- all tests, generated protocol artifacts, package scripts, and CI changes;
- both migration families, startup DDL, schema parity, indexes, constraints,
  transactions, and compensation/forward-only policy;
- maintained API, configuration, productivity, security, deployment, preview,
  and merge-readiness documentation;
- GPT Access authentication, scopes, confirmation, module discovery, OpenAPI,
  natural-language dispatch, and legacy-route isolation;
- all 24 productivity handlers, schemas, lifecycles, reference resolution,
  optimistic concurrency, idempotency, events, projections, review behavior,
  and structured responses;
- local-agent and generic-job changes where they overlap the gateway,
  confirmation, audit, tenancy, CI, or deployment boundary;
- Railway preview scripts, isolation checks, exact-deployment evidence, and
  the final pull-request checks.

I did not assume another reviewer covered an overlapping area.

## Findings and dispositions

### PROD-FINAL-001 — Natural-language confirmation was not bound to the resolved plan

- Original severity: **High**
- Confidence: high
- Final status: **resolved**

The earlier dispatch flow could resolve a privileged plan, issue a challenge
over only the conversational request, and resolve a changed LLM plan on retry.

The final candidate binds the challenge to:

- the original request;
- the resolved action;
- the exact resolved payload;
- the registered action/risk/runner;
- the authenticated actor;
- the server-controlled principal and workspace.

`src/routes/gpt-access.ts:1096` builds the versioned execution fingerprint, and
`src/routes/gpt-access.ts:1127` supplies the trusted binding.
`src/transport/http/middleware/confirmGate.ts:188` enforces challenge-only mode,
which rejects manual, automation, trusted-GPT, one-time-token, and allow-all
bypasses for this flow. A changed plan invalidates and consumes the old
challenge without execution.

Exact-head gateway tests cover manual fail-closed behavior, exact one-use
retry, changed LLM payload rejection, and confirmed worker-recovery execution.

### PROD-FINAL-002 — Weekly review status became due before seven calendar days

- Original severity: **Low**
- Confidence: high
- Final status: **resolved**

The earlier implementation mixed a date-only review with an instant six days
before `now`. `src/services/productivity/productivityService.ts:462` now
compares UTC date values at a seven-day boundary. The regression test proves
that six days is not due and seven days is due.

### PROD-FINAL-003 — Canonical current-state projections are intentionally uncapped

- Severity: **Medium residual operational risk**
- Confidence: high
- Final status: accepted condition for the initial bounded workspace

`src/core/db/repositories/productivityRepository.ts:874` reads all scoped tasks
and projects in one repeatable-read transaction.
`src/services/productivity/productivityService.ts:1206` derives health,
warnings, focus, and review status from the complete snapshot.
`docs/PRODUCTIVITY_SYSTEM.md:136` explicitly documents this behavior.

The design provides one internally consistent committed view, but CPU, memory,
query latency, and response size grow with retained workspace data. Bounded
list operations do not remove this cost from `state.current`,
`context.summary`, `focus.today`, project-health aggregation, or reviews.

**Condition:** retain this only for bounded single-operator workspaces. Before
material tenant or data-volume growth, introduce aggregate/read projections or
bounded projection inputs and response limits. Preserve tenant scoping,
repeatable consistency, deterministic evidence, and repository ownership. Add
large-workspace query-plan, latency, and response-size tests.

### PROD-FINAL-004 — Productivity OpenAPI metadata is less complete than local-agent metadata

- Severity: **Low interoperability condition**
- Confidence: high
- Final status: accepted follow-up

The dynamic OpenAPI catalog publishes all 24 productivity action IDs. The
module detail metadata publishes descriptions, input schemas, risk,
confirmation, and idempotency. Unlike local-agent contracts, the top-level
catalog does not publish versioned per-action output schemas, execution target,
timeout, or explicit side-effect fields.

This is not an authorization or execution flaw; Custom GPT clients can inspect
the registered module contract before invocation. Before treating this
extension as a fully self-describing generated SDK contract, publish versioned
productivity output schemas and add output-schema parity tests.

### PROD-FINAL-005 — Tenancy is deliberately single-operator oriented

- Severity: **Low documented product limit**
- Confidence: high
- Final status: accepted for current scope

The module derives principal and workspace from server-controlled GPT Access
context, validates those identifiers, recursively rejects caller-supplied
owner/principal/workspace aliases, and scopes every repository operation.

This is a configured single-operator model, not general team or delegated
tenancy. Do not infer multi-user support from this PR. A future multi-tenant
interface must establish authenticated per-request tenant context and bind
every privileged challenge to that same identity.

### PROD-FINAL-006 — Productivity migration is intentionally forward-only

- Severity: **Low operational condition**
- Confidence: high
- Final status: documented

`migrations/20260724_productivity_core.sql` is additive and idempotent.
`docs/DATABASE_MIGRATIONS.md:104` now explicitly declares it forward-only:
automatically dropping the new tables could destroy canonical user data.
Preview rollback discards the isolated database. Production compensation must
be a separately reviewed archival or data-migration procedure.

This is an appropriate fail-safe policy. Production migration remains outside
this review's authorization.

## Domain assessment

### Capability and route boundary

- `src/services/arcanos-productivity.ts:177` disables legacy route exposure,
  and line 178 makes the module GPT-Access-only.
- Legacy module execution, `/queryroute`, public GPT routing, and public
  introspection exclude the protected module.
- The module publishes exactly 24 known actions with strict input schemas.
- Read-only metadata is explicit. Missing or inconsistent metadata fails
  closed as privileged.
- All writes pass through the existing GPT Access confirmation boundary.
- No productivity capability performs filesystem, process, arbitrary SQL, raw
  queue, or Python execution.

### Tenancy, validation, and errors

- Principal and workspace come from trusted handler context, not model fields.
- All repository reads and writes predicate on both principal and workspace.
- Composite foreign keys prevent cross-tenant project associations.
- Strict Zod schemas bound text, collections, priorities, timestamps, UUIDs,
  expected versions, list limits, and nesting.
- Structured errors distinguish validation, not found, ambiguity, conflict,
  stale state, invalid transition, idempotency conflict, permission,
  dependency, and internal failures with recovery guidance.
- Persistence errors and SQL are not exposed to the conversational client.

### Lifecycle and conversational behavior

- Task and project states are closed enums with explicit transition maps.
- Terminal tasks cannot reopen; archived projects are terminal.
- Reference resolution is tenant-scoped, deterministic, and returns bounded
  candidates instead of guessing when ambiguous.
- Expected versions reject stale mutation plans.
- Reference-based retries check durable receipts before resolving a title
  again, preserving a successful replay if later data becomes ambiguous.
- Focus excludes future-deferred tasks and work in completed, archived, or
  on-hold projects; it treats earlier-today deadlines as overdue and returns
  deterministic reason codes.
- Project health reports deterministic evidence for blocked, stalled, at-risk,
  paused, complete, and archived projects.
- Review reads do not persist. Review writes reject future dates and report an
  explicit persistence effect.
- Stable intent resolution is conservative and does not execute negative or
  ambiguous phrases.

### Transactions, idempotency, events, and audit

- Mutations lock scoped state where necessary and apply optimistic versions.
- Canonical state, domain/outbox events, and command receipts commit in one
  transaction.
- Database uniqueness covers tenant, action, and idempotency-key hash.
- Identical commands replay the stored deterministic result; changed semantic
  input returns `IDEMPOTENCY_CONFLICT`.
- Only hashes of caller idempotency keys are retained.
- Events carry aggregate version, actor, request, and trace correlation when
  available.
- Read results state `persisted: false`; mutation results state persistence,
  replay/change status, user-facing effect wording, and affected entity IDs.
- No-op and replay responses no longer claim a new state change.

### Migration and schema parity

- Migration SQL, startup DDL, TypeScript statuses, constraints, indexes, and
  focused parity tests agree on all six productivity tables.
- Constraints bound tenant IDs, content sizes, status enums, priority,
  versions, JSON objects, event sequence, hashes, and receipt expiry.
- Scoped foreign keys protect task/note project relationships.
- Preview PostgreSQL is isolated; no production database was migrated.

## Exact-head deployment and CI evidence

The runtime candidate `f7f3a2ca` was deployed to the isolated preview:

- API deployment: `ce5a974e-a087-4634-9e74-992b4c44144e`
- Worker deployment: `87baaf0a-ac51-42a0-abdc-5044cd71f122`
- Preview environment: `arcanos-preview-bf8ac3bd`

The authenticated exact-deployment verifier passed productivity discovery and
all read-only productivity actions. It also verified the preview service and
dependency identities before HTTP execution. The live OpenAPI document
independently returned OpenAPI 3.1.0, the exact preview server URL,
`ARCANOS:PRODUCTIVITY`, and all 24 productivity actions.

The complete historical preview mutation matrix covered trusted tenant
resolution, caller-supplied tenant rejection, lifecycle transitions,
ambiguity, stale state, idempotent replay/conflict, persisted effects, outbox
events, audit, and trace correlation. Since that matrix, the only productivity
domain code change is the independently tested weekly-review correction.

All required checks on exact head `f7f3a2ca` are complete and green, including:

- Build (Node 20.19.0)
- Lint & Type Check
- Test Suite (unit)
- Test Suite (integration)
- Convergence Gate
- Local Agent PostgreSQL Concurrency
- Local Agent Sandbox (Linux)
- Python CLI (Windows)
- Railway Compatibility
- Deployment Readiness
- Security Audit
- PR build-test
- documentation audit
- API endpoint tests
- Railway API and worker deployments
- aggregate All Checks Complete

The PR remained Draft during this review and GitHub reported the exact head as
mergeable.

## Commands actually executed

```text
git diff --check 59989445b6bf206c0f73bc9fb11f6d47f3494214...f7f3a2caf3f13566a41a8587a1b6e2966d7f6439
```

Passed.

```text
node scripts/run-jest.mjs \
  --testPathPatterns=productivity \
  --testPathPatterns=gpt-access-gateway \
  --testPathPatterns=dispatcher-natural-language \
  --testPathPatterns=gpt-access-natural-language-dispatch \
  --testPathPatterns=gpt-access-openapi-capability-catalog \
  --testPathPatterns=gpt-router-config.gpt-access-only \
  --coverage=false --runInBand
```

Passed: **11 suites, 357 tests**.

```text
npm run build
```

Passed, including architecture/routing boundaries, packages, workers,
TypeScript compilation, alias verification, and assets.

```text
npm run lint
```

Passed with **0 errors** and 84 existing warnings.

```text
npm run validate:railway
```

Passed.

```text
npm run test:preview-e2e
```

Passed: **18 tests**.

```text
npm run docs:check
```

Passed: **272 checks**, 0 failures, 0 warnings.

```text
npm run sync:check
```

Passed with 0 errors and 0 warnings; five informational recommendations were
unrelated to this change.

```text
gh pr checks 1408 --repo pbjustin/Arcanos
gh pr view 1408 --repo pbjustin/Arcanos \
  --json isDraft,headRefOid,mergeable,reviewDecision,statusCheckRollup
```

Confirmed exact head `f7f3a2ca`, Draft state, mergeable status, successful
Railway API/worker deployments, and all required checks green.

Read-only HTTP inspection also confirmed:

- public `/health`: healthy and ready;
- `/gpt-access/openapi.json`: OpenAPI 3.1.0;
- exact preview server URL;
- both protected capability catalogs;
- all 24 productivity action IDs.

## Residual risks and conditions

1. Keep the current uncapped snapshot only within bounded initial workspace
   sizes; add bounded/read-model projections before scale-up.
2. Treat the configured principal/workspace as single-operator scope; do not
   claim team tenancy or delegation.
3. Keep AI recommendations advisory. Authorization, lifecycle, confirmation,
   tenancy, and persistence must remain deterministic TypeScript concerns.
4. Do not enable productivity in production until a separately approved
   migration runbook verifies target identity, backup/forward-fix strategy,
   execution, and post-migration state.
5. Publish versioned productivity output schemas before promising a complete
   generated SDK contract.
6. If runtime code changes after `f7f3a2ca`, repeat the affected review, CI,
   and exact-deployment validation. Review-artifact-only commits do not expand
   the runtime claims.

## Final verdict

**APPROVE WITH CONDITIONS**

The reviewed runtime candidate has no open Critical or High productivity
finding. The earlier High confirmation-integrity flaw and Low review-boundary
defect are resolved and independently tested. Exact-head focused tests, build,
lint, preview safety checks, deployment, read-only productivity verification,
and the complete required CI matrix passed.

The remaining findings are bounded scale, interoperability, single-operator,
and production-migration conditions. They do not block converting this PR from
Draft to Ready for Review, provided the final merge-readiness report preserves
them and no later runtime change invalidates the exact-head evidence.
