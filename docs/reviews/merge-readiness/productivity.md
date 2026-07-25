# Productivity Review — PR 1408

## Review identity

- Review round: 2
- Reviewer: independent productivity-domain reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed PR head: `87788342f862d59c60fa3ea830da47c39950dabf`
- Candidate reviewed: the PR head plus the uncommitted, architecture-preserving
  Round 2 remediations in the shared review worktree
- Scope: all 111 changed files, including TypeScript and Python source,
  protocol artifacts, tests, migrations, documentation, CI, Railway
  configuration, preview tooling, and deployment evidence
- Verdict: **APPROVE WITH CONDITIONS**
- Confidence: **high (0.91)**
- Open Critical findings: **0**
- Open High findings: **0**

This verdict approves the productivity design and candidate implementation for
continued merge-readiness processing. It does not approve a production
deployment. The final integrated commit still needs the exact-head preview and
broad validation gates described below.

## Executive assessment

`ARCANOS:PRODUCTIVITY` fits the existing ARCANOS architecture without adding a
parallel application or authority plane:

```text
ChatGPT / Custom GPT
  -> /gpt-access/*
  -> TypeScript authentication, scopes, policy, confirmation, and tracing
  -> protected ARCANOS:PRODUCTIVITY module
  -> productivity service and deterministic domain rules
  -> tenant-scoped repository transactions
  -> PostgreSQL canonical state, command receipts, and outbox events
  -> structured result for conversational presentation
```

TypeScript remains authoritative for identity, tenancy, public contracts,
confirmation, lifecycle rules, persistence, idempotency, and execution. The
module does not depend on Python, create a Python public API, use
`/gpt/:gptId`, expose a legacy module route, add a second queue, or introduce a
second workflow engine.

The implementation provides the intended 24 actions across intent resolution,
reference resolution, current state, tasks, projects, inbox, focus, knowledge,
and reviews. Read-only actions are explicitly classified. Every mutation is
privileged, confirmation-gated, tenant-scoped, transactional, event-producing,
and idempotent.

## Review method and complete-PR coverage

I independently:

- inventoried and read every changed file in the complete PR diff;
- reviewed all productivity source, schemas, types, repository queries,
  migration DDL, startup DDL, Prisma representation, tests, maintained
  documentation, OpenAPI/catalog changes, gateway routing, confirmation,
  natural-language dispatch, preview verification, CI, and deployment evidence;
- inspected overlapping local-agent, generic job, security, and release changes
  instead of assuming another reviewer covered the boundary;
- traced all 24 actions from capability metadata through validation, domain
  execution, repository behavior, events/receipts, and response envelopes;
- checked lifecycle transitions, reference ambiguity, optimistic concurrency,
  idempotency replay/conflict, tenancy rejection, current-state consistency,
  project health, focus ranking, review status, route isolation, audit/trace
  propagation, and failure envelopes;
- ran the focused and broad validation commands listed below.

The complete PR diff contained 111 changed files and 32,867 additions at the
reviewed head. `git diff --check` passed for the committed PR diff and for the
shared Round 2 candidate worktree.

## Findings and dispositions

### PROD-R2-001 — Natural-language confirmation was not bound to the resolved execution plan

- Original severity: **High**
- Confidence: high
- Status: **resolved in the candidate worktree**

The original `/gpt-access/dispatch/run` flow resolved a plan, issued a
confirmation challenge over the request body, and resolved the plan again on a
retry. An LLM-sourced plan could therefore change its privileged productivity
action or payload while the same utterance and context still matched the
approved body.

The remediation is fail-closed:

- `src/routes/gpt-access.ts:1091` builds a versioned confirmation fingerprint
  containing the original request, resolved action, resolved payload, and
  registry action/risk/runner;
- `src/routes/gpt-access.ts:1123` binds the challenge to the authenticated
  actor and server-configured principal/workspace;
- `src/transport/http/middleware/confirmGate.ts:188` uses challenge-only mode,
  so manual headers, automation secrets, trusted-GPT metadata, one-time tokens,
  and allow-all configuration cannot bypass this gate;
- `src/transport/http/middleware/confirmationChallengeStore.ts:202` rejects and
  consumes a challenge when the canonical execution fingerprint differs;
- the retry token is stripped before request fingerprinting, so adding only the
  approved top-level token does not alter the intended request.

Independent focused tests passed for:

- initial privileged dispatch challenge;
- manual-confirmation fail-closed behavior;
- one-use exact retry;
- changed LLM payload rejection without execution;
- confirmed worker-recovery dispatch.

The remediation preserves the existing gateway and confirmation architecture.

### PROD-R2-002 — Weekly review status became due before seven complete UTC calendar days

- Original severity: **Low**
- Confidence: high
- Status: **resolved in the candidate worktree**

The prior calculation compared a date-only review at UTC midnight with an
instant six days before `now`. A Friday review could therefore become due on
Thursday rather than after seven calendar days.

`src/services/productivity/productivityService.ts:458` now compares the review
date with the UTC date exactly seven days earlier. A regression test verifies
that six days is not due and seven days is due. The independently rerun
productivity-service suite passed all 47 tests.

### PROD-R2-003 — Canonical current-state projections are intentionally uncapped

- Severity: **Medium operational condition**
- Confidence: high
- Status: open, documented

`src/core/db/repositories/productivityRepository.ts:874` reads every scoped task
and project in one repeatable-read transaction.
`src/services/productivity/productivityService.ts:1206` then derives health for
every project and returns that complete health array, warnings, focus, and
review state. `docs/PRODUCTIVITY_SYSTEM.md:136` and focused tests explicitly
document and enforce the uncapped snapshot.

This guarantees one internally consistent committed view, which is valuable for
the initial single-operator workspace. It also means latency, memory use, and
response size grow with all retained tasks and projects. Project descriptions
and note search results can be large, and `knowledge.find` uses a bounded result
count but an unindexed case-insensitive content search.

**Condition:** before materially increasing tenant volume, introduce bounded
projection inputs or rebuildable aggregate/read models and a bounded response
contract. Preserve snapshot consistency, tenant scoping, deterministic focus
evidence, and the existing repository boundary. Add query-plan and response-size
tests for representative large workspaces.

### PROD-R2-004 — Productivity OpenAPI catalog metadata is less complete than local-agent metadata

- Severity: **Low interoperability condition**
- Confidence: high
- Status: open

`src/services/gptAccessGateway.ts:2250` exposes the productivity action IDs in
the dynamic OpenAPI extension, while local-agent actions additionally publish
execution target, input/output schemas, timeout, device scopes, read-only
status, and file-mutation status. Productivity action detail metadata does
publish description, risk, confirmation, input schema, and idempotency through
the module registry, so a client can inspect the capability before execution.
The gap is primarily discoverability and generated-client precision, not an
authorization or runtime correctness flaw.

**Condition:** before treating the OpenAPI extension as a fully self-describing
stable SDK contract, publish versioned productivity output schemas and the
applicable read-only/side-effect fields, then add schema-parity tests. Continue
to keep TypeScript authoritative.

### PROD-R2-005 — Confirmation identity and workspace configuration remain single-operator oriented

- Severity: **Low documented product limit**
- Confidence: medium-high
- Status: accepted for the current scope

The module correctly derives principal and workspace from server-controlled GPT
Access configuration and recursively rejects caller-supplied tenancy aliases.
Direct capability confirmation fingerprints the exact action and payload.
Natural-language privileged dispatch is now also bound to the authenticated
actor, principal, and workspace.

The configured principal/workspace model is appropriate for the current
single-operator deployment. It is not yet a general multi-user workspace
selection design. Do not infer team/delegation support from this PR. Any future
multi-tenant interface must use authenticated per-request tenant context and
bind every privileged direct-capability challenge to that same identity.

### PROD-R2-006 — Exact-head preview evidence remains a release gate

- Severity: **Cross-domain release condition**
- Confidence: high
- Status: pending final integrated candidate validation

`docs/PREVIEW_E2E_REPORT.md:13` records
`b2821e8053610fd983c024d81b82e9b781a828f4` as the latest complete runtime
validation commit, while the reviewed PR head and Round 2 candidate include
later behavior changes. The report contains strong historical evidence for all
24 productivity actions, tenancy rejection, lifecycle behavior, ambiguity,
staleness, idempotency, events, audit, and traces, but it is not exact-head
evidence for the final candidate.

**Condition before Ready for Review:** commit the approved Round 2 remediations,
deploy that exact commit to the isolated preview, rerun the complete
productivity discovery/read/write/confirmation/idempotency/audit matrix, and
update `docs/PREVIEW_E2E_REPORT.md` with the exact commit and deployment
identities. Repeat if runtime code changes afterward.

## Productivity-domain assessment

### Capability and route boundary

- The module declares `gptAccessOnly: true` and `exposeLegacyRoute: false`.
- It is omitted from legacy module execution, public GPT routing,
  `/queryroute`, and public introspection.
- Read-only action metadata is explicit; unknown or metadata-missing actions
  fail closed as privileged.
- All writes pass through the existing GPT Access confirmation and module
  dispatch boundary.
- No productivity repository or command capability was placed in
  `ARCANOS:LOCAL_AGENT`, and no local-agent filesystem/process capability was
  placed in `ARCANOS:PRODUCTIVITY`.

### Tenancy, validation, and errors

- Principal and workspace come from trusted module-handler context, never the
  model payload.
- Scope identifiers are validated, and caller-supplied owner/principal/workspace
  aliases are rejected recursively after normalization.
- Zod schemas are strict and bound field lengths, collection sizes, timestamp
  formats, UUIDs, priorities, and list limits.
- Structured errors distinguish validation, missing/ambiguous references,
  conflict, stale plan, invalid transition, idempotency conflict, permission,
  dependency, and internal failures with recovery guidance.
- Error envelopes avoid raw persistence errors and do not expose SQL.

### Canonical domain behavior

- Task states and transitions are closed and deterministic:
  `inbox -> next/scheduled/waiting/cancelled`, then controlled movement to
  `done` or `cancelled`; terminal states cannot reopen.
- Project states and transitions are closed and deterministic across active,
  blocked, on-hold, completed, and archived states; archived is terminal.
- Reference resolution is tenant-scoped, deterministic, and returns bounded
  ambiguity candidates instead of guessing.
- Optimistic versions reject stale mutations.
- Focus excludes completed, archived, and on-hold project work, excludes
  future-deferred tasks, treats earlier-today deadlines as overdue, and returns
  deterministic reason codes.
- Project health uses deterministic task/project evidence and identifies
  blocked, stalled, at-risk, paused, complete, and archived states.
- Read-only review generation does not persist; review recording rejects future
  dates and reports explicit persistence effects.

### Persistence, idempotency, and auditability

- All repository reads and writes include principal and workspace predicates.
- Composite foreign keys prevent cross-tenant project links.
- Task/project rows are locked before transition and version checks.
- Mutations atomically write canonical state, one or more domain/outbox events,
  and the deterministic command receipt.
- Command receipts have database uniqueness across tenant, action, and key
  hash. Same semantic requests replay the stored result; changed semantics
  return `IDEMPOTENCY_CONFLICT`.
- Reference-based commands check durable receipts before re-resolving titles,
  so later ambiguity does not break a successful replay.
- Events carry actor, request, and trace correlation when available.
- Read envelopes state `persisted: false`; mutation envelopes state
  `persisted: true`, replay/change status, effect wording, and affected entity
  IDs without falsely claiming that a no-op changed state.

### Migration and documentation

- The additive migration, startup DDL, domain status constants, constraints,
  indexes, and focused parity tests agree on the six productivity tables.
- Constraints bound tenant IDs, text size, lifecycle enums, priorities,
  versions, JSON shape, event sequences, receipt hashes, and expiry.
- The migration is additive and preview evidence records isolated application;
  no production migration is authorized by this review.
- The maintained productivity guide accurately describes the protected module,
  24-action catalog, trust boundary, lifecycles, persistence, idempotency,
  events, errors, and deliberate non-goals.
- The reversible migration has no conventional rollback artifact. Before
  production migration approval, either document it as forward-only or add a
  guarded compensation that refuses to drop non-empty tables.

## Independent validation

Commands actually executed by this reviewer:

```text
git diff --check
git diff --check 59989445b6bf206c0f73bc9fb11f6d47f3494214...HEAD
```

Passed.

```text
node scripts/run-jest.mjs --testPathPatterns=productivity \
  --coverage=false --runInBand
```

Passed after the Round 2 weekly-review remediation: 5 suites, 77 tests.

```text
node scripts/run-jest.mjs \
  --testPathPatterns=gpt-access-gateway \
  --testPathPatterns=dispatcher-natural-language \
  --testPathPatterns=gpt-access-natural-language-dispatch \
  --testPathPatterns=gpt-access-openapi-capability-catalog \
  --testPathPatterns=gpt-router-config.gpt-access-only \
  --coverage=false --runInBand
```

Passed at the reviewed baseline: 6 suites, 277 tests.

```text
node scripts/run-jest.mjs --testPathPatterns=gpt-access-gateway \
  --coverage=false --runInBand \
  --testNamePattern="privileged dispatch|confirmation retry|existing confirmation retry|confirmed worker recovery"
```

Passed after the Round 2 confirmation remediation: 1 suite, 5 tests selected.

```text
node scripts/run-jest.mjs --testPathPatterns=productivity-service \
  --coverage=false --runInBand
```

Passed after the weekly-review remediation: 1 suite, 47 tests.

```text
npm run type-check
```

Passed, including boundary checks and all shared package builds.

```text
npm run lint
```

Passed with 0 errors and 84 existing warnings.

```text
npm run validate:railway
```

Passed.

```text
node --test scripts/preview-e2e.test.mjs
```

Passed: 18 tests.

```text
npm run docs:check
```

Passed: 272 checks, 0 failures, 0 warnings.

```text
npm run sync:check
```

Passed with 0 errors and 0 warnings; five informational recommendations were
unrelated to this PR.

A full gateway-suite rerun was attempted while other independent reviewers
were actively modifying the same shared worktree. It produced 141 passes and
seven failures in concurrently changing local-agent response-shape, rate-limit,
log-mock, and OpenAPI tests; the five confirmation-remediation tests passed in
that same run. This is not counted as a stable-candidate pass or as a
productivity defect. The lead must rerun the complete broad suite from the
settled final tree before Ready for Review.

## Residual risks and human acceptance conditions

1. Accept the current single-operator principal/workspace configuration as a
   deliberate first-version limit; do not market team tenancy or delegation.
2. Accept uncapped consistent snapshots only for bounded initial workspace
   sizes and track a projection/response-bounding milestone before scale-up.
3. Keep AI use advisory. Do not move lifecycle, authorization, confirmation,
   tenancy, or persistence decisions out of TypeScript.
4. Do not enable productivity on production until the additive migration has a
   separately approved target-verification, backup, rollback/forward-fix, and
   post-migration verification procedure.
5. Commit all Round 2 fixes, run broad tests on the settled tree, and complete
   exact-commit isolated preview validation before changing the PR from Draft.

## Final verdict

**APPROVE WITH CONDITIONS**

No Critical or High productivity finding remains in the candidate worktree.
The two concrete correctness/security findings discovered in this review were
fixed without architectural expansion and independently retested. The remaining
items are bounded scale, interoperability, migration-operability, and exact-head
release conditions.

The productivity reviewer approves conversion to Ready for Review only after:

- all Round 2 remediations are committed;
- the settled full build/lint/typecheck/test matrix passes;
- the exact final commit passes the isolated preview E2E matrix;
- `docs/PREVIEW_E2E_REPORT.md` records that exact evidence; and
- no later runtime change invalidates the review.
