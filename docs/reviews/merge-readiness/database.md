# Database and Job-Semantics Review

## Review scope

- Pull request: `#1408` — `feat: add hardened productivity and local-agent capabilities`
- Base: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed runtime head: `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Diff inventory: 125 changed files, 35,999 additions, 312 deletions
- Review date: 2026-07-24

This was an independent review. I inventoried the complete PR diff and examined
every changed-file category for database or durable-job impact, including
TypeScript routes and services, Python daemon code, protocol schemas, SQL,
migration tooling, tests, CI, Railway configuration, OpenAPI generation, and
maintained documentation. The migrations, database repositories, transaction
boundaries, and database-focused tests were read directly in full. I did not
assume another reviewer covered an overlapping concern.

The review concentrated on:

- schema and migration safety;
- database-enforced idempotency;
- claim, lease, result, expiry, retry, and recovery races;
- state/event/receipt atomicity;
- tenant isolation in persistence and diagnostics;
- optimistic concurrency;
- cleanup, retention, compensation, and rollback;
- preview PostgreSQL evidence and required CI coverage.

No product code was changed by this reviewer.

## Verdict

**APPROVE WITH CONDITIONS**

No Critical or High database or job-semantics finding remains at the reviewed
runtime head. The remaining findings are production-operability work and do not
weaken the isolated preview's fail-closed behavior.

| Severity | Open findings |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 0 |

Reviewer confidence:

- database correctness and concurrency: **0.96**
- tenancy and transactional integrity: **0.95**
- production operations: **0.88**

The lower production-operations confidence reflects intentionally deferred
production migration, retention, and scale-management procedures—not an
observed preview correctness failure.

## Architecture review

The PR preserves the intended authority boundary:

- TypeScript owns public capability contracts, identity, tenancy,
  authorization, confirmation, job creation, persistence, lifecycle rules,
  events, and public result behavior.
- Python has no PostgreSQL access and receives only a server-authorized,
  device-bound job envelope.
- Local-agent work reuses `job_data`, `job_events`, and the existing worker/job
  infrastructure. No second queue, workflow engine, or canonical store was
  introduced.
- `ARCANOS:PRODUCTIVITY` uses the established repository and transaction
  layers.
- Local-agent rows are excluded from generic worker claim, stale recovery,
  requeue, failure inspection, latest-job inspection, generic job detail, MCP
  job tools, worker control, and public system diagnostics.
- GPT Access result reads authorize local-agent rows against the trusted
  principal and workspace before exposing a result.

## Local-agent database review

### Database-enforced idempotency

`local_agent_job_idempotency` is the authoritative logical-job uniqueness
boundary. It enforces:

- unique `(principal_id, workspace_id, device_id, action,
  idempotency_key_hash)`;
- unique `job_id`;
- a deferred foreign key to `job_data(id)` with `ON DELETE CASCADE`;
- bounded, normalized hashes and required tenant/device/action fields;
- explicit expiry metadata.

`findOrCreateLocalAgentJob` creates the binding and job in one transaction.
Identical in-window replays return the original logical job; reuse of the same
key with a different canonical request fingerprint fails with a conflict.
Expired terminal bindings can be replaced transactionally. Jobs requiring
manual reconciliation remain quarantined and cannot silently release their key.

Advisory locks remain useful contention reduction, but correctness no longer
depends on them. The unique index is authoritative.

### Claims, leases, and terminal results

- Claims use a transaction, device and scope predicates, and
  `FOR UPDATE SKIP LOCKED`.
- Claim replay is bound to the same device and claim-key hash.
- A successful claim records `job.claimed` and `job.started` in the same
  transaction as the state transition.
- Result submission locks the job row and verifies the assigned device,
  action envelope, request/trace correlation, active lease, and job expiry.
- Expiry and lease authorization use PostgreSQL `NOW()` and are repeated in
  the terminal `UPDATE`; application-host clock skew cannot authorize a late
  result.
- Exact result replay is idempotent. A different result for a terminal job is
  rejected.
- An uncertain mutation outcome is persisted as failed with
  `manualReconciliationRequired=true`, preventing automatic replay or cleanup.

### Expiry and recovery

Expiry and lost-lease reconciliation preserve per-job observability:

- each candidate is locked separately;
- state transition and lifecycle event are atomic;
- savepoints isolate a candidate whose event write fails;
- a failed candidate rolls back without collapsing the successful candidates
  into an opaque batch event;
- expired pending work becomes expired;
- expired or lost mutating work enters manual reconciliation;
- lost-lease read-only work may return to pending.

This resolves the original per-job expiry-event concern.

## Tenant isolation and audit timeline

The public GPT Access timeline now derives principal/workspace from validated
server context. Its production query joins `job_events` to authoritative
`job_data` and:

- includes a local-agent event only when
  `input.job.principal` and `input.job.workspace` match the trusted context;
- excludes all local-agent events when trusted tenant context is unavailable;
- prevents an exact foreign local-agent `jobId` lookup from returning rows;
- retains the pre-existing generic-job diagnostic behavior;
- uses parameterized values and sanitized metadata.

An inner join also fails closed for orphan event rows. The real PostgreSQL test
imports the production query builder and proves own-tenant visibility,
foreign-tenant denial, exact foreign-ID denial, and missing-context denial.

Correlation is preserved across request, trace, principal, workspace, device,
job, claim, result, and lifecycle events. Authorization evidence is retained
in the canonical envelope while the public projection redacts its sensitive
contents.

## Productivity database review

The productivity implementation is consistently tenant scoped:

- principal and workspace come from trusted execution context;
- model-supplied tenancy fields are rejected recursively;
- reads and writes predicate on both principal and workspace;
- task/note-to-project relationships use tenant-aware composite foreign keys.

Canonical state, domain/outbox events, and idempotency receipts are committed in
one transaction. An event or receipt failure rolls back the domain mutation.
Command receipts enforce the tenant/action/idempotency-key boundary and compare
canonical request fingerprints before replaying a stored result.

Task and project mutation paths lock current state and enforce optimistic
version checks. Terminal-state and transition rules prevent stale writes and
invalid resurrection. Project advancement can update the project, create its
next action, and emit both events atomically.

`state.current`, focus, context, project health, and review evidence use one
`REPEATABLE READ READ ONLY` snapshot, preventing mixed-point-in-time summaries.

## Migration review

### Local-agent hardening migration

The local-agent migration is additive and idempotent. It:

- verifies required `job_data` and `job_events` prerequisites;
- fails when live local-agent jobs lack required authoritative metadata;
- rejects duplicate live logical bindings before installation;
- creates the binding table, constraints, deferred foreign key, and expiry
  index;
- backfills eligible current jobs;
- relies on post-apply verification to detect a missing or mismatched binding.

The guarded runner:

- pins the migration version and SHA-256 checksum;
- requires explicit preview project, environment, and PostgreSQL service IDs;
- rejects production, Phase 2E, or ambiguous targets;
- verifies that the resolved database belongs to the selected preview service;
- applies transaction, advisory migration lock, lock timeout, and statement
  timeout;
- verifies exact columns, all expected constraints and indexes, foreign-key
  actions, duplicate scopes, and job/binding parity.

The previous misleading `exactConstraints`/`exactIndexes` labels are resolved;
the current result correctly reports `expectedConstraintsValid` and
`expectedIndexesValid`.

The compensation script fails closed unless the binding table is empty and no
active local-agent job remains.

### Productivity migration

`migrations/20260724_productivity_core.sql` is additive, repeatable, and creates
six canonical tables:

- `productivity_projects`
- `productivity_tasks`
- `productivity_notes`
- `productivity_reviews`
- `productivity_events`
- `productivity_command_receipts`

It includes tenant indexes, lifecycle checks, optimistic versions, composite
relationship keys, an unpublished-event index, and receipt uniqueness.
Runtime schema definitions and focused parity tests match the SQL contract.

The migration is intentionally forward-only. The documentation now explicitly
prohibits an unconditional table-drop rollback because those tables contain
canonical user data. Preview rollback is disposal of the synthetic isolated
database; any future production compensation requires a separately reviewed
data-preserving procedure.

## Preview and CI evidence

The reviewed preview report identifies the exact runtime commit, isolated
Railway project/environment/services, API and worker deployments, PostgreSQL
service, Redis service, and public preview domain without publishing
credentials.

The preview evidence shows:

- migrations targeted only the isolated preview PostgreSQL service;
- local-agent migration checksum matched the reviewed artifact;
- 30 current bindings, zero missing bindings, zero mismatches, and zero
  duplicate logical scopes;
- the productivity migration applied transactionally and repeatably;
- all six productivity tables and documented indexes exist;
- the preview PostgreSQL concurrency and tenant-isolation suite passed 6/6;
- the exact runtime candidate's timeline contained six correlated lifecycle
  events for the confirmed `tests.run` path.

The required GitHub `Local Agent PostgreSQL Concurrency` job provisions a fresh
PostgreSQL 18 service and sets
`LOCAL_AGENT_HARDENING_REQUIRE_DATABASE=1`, so absent database configuration
fails rather than silently skipping. That required PostgreSQL CI job passed for
the exact `f7f3a2ca` runtime candidate. Its unit and build-test jobs also passed;
at the close of this review only the dependent Deployment Readiness and
aggregate completion jobs were still running.

No migration or Railway mutation was performed by this reviewer.

## Residual findings and conditions

### DB-FINAL-01 — Medium: terminal local-agent retention needs a production policy

Completed, cancelled, and expired local-agent `job_data` rows may contain
repository search, status, test, or diff output. Binding cleanup is bounded, and
failed-job cleanup handles ordinary failed rows, but successful terminal
local-agent rows do not yet have a complete retention/compaction lifecycle.
`job_events` has a separate time-based cleanup path, so job/output and audit
retention can also diverge without an explicit policy.

**Condition before production enablement:** define and implement bounded
retention for terminal local-agent jobs, outputs, bindings, and events. Preserve
manual-reconciliation rows until an explicit audited resolution/archive
operation. Document audit retention and delete in foreign-key-safe order.

### DB-FINAL-02 — Medium: production migration promotion remains intentionally separate

The local-agent runner is deliberately preview-only, and the binding table is
required for database-authoritative idempotency. Productivity startup DDL can
create its additive tables under the repository's existing initialization
model, but that does not replace a controlled production rollout record.

**Condition before production enablement:** keep production local-agent job
creation fail-closed until an operator-approved runbook proves target identity,
backup/recovery, lock expectations, apply command, post-apply schema/binding
verification, and observability. Coordinate productivity startup DDL with that
rollout and record the applied schema version.

### DB-FINAL-03 — Medium: productivity maintenance and projection bounds are scale follow-ups

Expired productivity receipts are removed opportunistically by a later command
for the same tenant. Dormant tenants can therefore retain expired receipts.
The canonical current-state snapshot intentionally reads all tasks/projects to
derive consistent projections, which can become a memory/latency concern for
large tenants.

**Condition before material tenant-volume growth:** add a bounded maintenance
path for expired receipts and establish measured limits or a rebuildable
tenant-scoped projection for `state.current`. Preserve the current
`REPEATABLE READ`, repository, and trusted-tenant boundaries.

## Validation performed by this reviewer

```text
git diff --check 59989445b6bf206c0f73bc9fb11f6d47f3494214..
  f7f3a2caf3f13566a41a8587a1b6e2966d7f6439
```

Passed.

```text
node scripts/run-jest.mjs
  --testPathPatterns=local-agent-job-repository
  --testPathPatterns=local-agent-hardening-migration
  --testPathPatterns=job-event-repository
  --testPathPatterns=job-repository.local-agent-boundary
  --testPathPatterns=job-repository.claimNextPendingJob
  --testPathPatterns=job-repository.cleanupRetainedFailedJobs
  --testPathPatterns=job-repository.lifecycle
  --testPathPatterns=job-repository.requeueFailedJob
  --testPathPatterns=productivity-repository
  --testPathPatterns=productivity-schema-parity
  --testPathPatterns=productivity-service
  --testPathPatterns=worker-control-service
  --testPathPatterns=mcp-job-tools
  --testPathPatterns=system-diagnostics-local-agent-boundary
  --coverage=false --runInBand --silent
```

Passed: **14 suites, 145 tests**.

```text
npm run validate:railway
```

Passed.

The reviewer inspected, but did not rerun against a new database, the exact
PostgreSQL integration suite and preview evidence. The independently recorded
preview result was **6/6 passed**, and the required PostgreSQL CI job passed.

## Merge recommendation

Approve the database and durable-job portion of PR #1408 with the three
production-enablement conditions above. There is no Critical or High
database/job-semantics blocker to converting the PR from Draft after:

1. the final exact-head Deployment Readiness and aggregate required checks
   finish green;
2. the combined merge-readiness report retains these residual risks; and
3. the production rollout does not silently treat preview migration evidence
   as authorization to migrate or enable production.

The PR must not be merged merely on this component approval; the independent
security, architecture, local-agent, productivity, release-engineering, and
devil's-advocate reviews still govern the aggregate recommendation.
