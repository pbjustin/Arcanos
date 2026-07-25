# Database and Job-Semantics Review

## Review scope

- Pull request: `#1408` — `feat: add hardened productivity and local-agent capabilities`
- Base: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed head: `87788342f862d59c60fa3ea830da47c39950dabf`
- Diff inventory: 111 changed files, 32,867 additions, 260 deletions
- Round-2 remediation inspected separately in the shared candidate worktree:
  generic job inspection now excludes `local-agent` rows and public system
  diagnostics no longer serialize raw job input or output.

I independently inventoried the complete PR diff and reviewed every changed-file
category: TypeScript services and routes, Python daemon code, protocol schemas,
tests, SQL migrations and compensation, migration tooling, CI, Railway
configuration, OpenAPI output, and maintained documentation. The detailed
database review covered the complete local-agent job lifecycle, generic job
worker interactions, productivity persistence, tenant boundaries, transactional
events, optimistic concurrency, cleanup, migrations, and preview evidence. This
review did not assume that another reviewer covered an overlapping boundary.

## Verdict

**APPROVE WITH CONDITIONS**

No Critical or High database/job-semantics finding remains in the reviewed
candidate after the Round-2 generic-inspection remediation. The conditions below
are production-operability follow-ups rather than correctness or isolation
blockers for the isolated preview.

Reviewer confidence: **high (0.91)** for database correctness and job semantics;
**medium-high (0.84)** for production operations because the production
migration/promotion procedure is intentionally not part of this PR.

## Architecture and authority boundaries

The implementation preserves the repository's existing boundaries:

- TypeScript owns public capability contracts, tenancy, authorization,
  confirmation, job creation, persistence, and lifecycle decisions.
- Local-agent work uses the existing `job_data` queue and job-event system; no
  second queue, database, or workflow engine was introduced.
- Python receives an already-authorized server-created envelope and has no
  direct PostgreSQL access.
- Local-agent rows are excluded from generic worker claim, stale recovery,
  failed-job inspection, latest-job inspection, job-detail inspection, and
  public diagnostics paths.
- Productivity writes use the existing PostgreSQL transaction/repository layer
  and derive tenancy from trusted execution context rather than capability
  payload fields.

## Local-agent database review

### Idempotency and concurrency

The new `local_agent_job_idempotency` table is the authoritative uniqueness
boundary. Its unique scope contains principal, workspace, device, action, and
idempotency-key hash, while `job_id` is separately unique and linked to
`job_data` with a deferred foreign key. `findOrCreateLocalAgentJob` resolves
identical concurrent requests to one logical job and rejects key reuse with a
different canonical fingerprint. Advisory locks remain an optimization and are
not the only correctness mechanism.

The dedicated PostgreSQL integration suite uses separate database connections
and verifies that a concurrent duplicate binding is rejected with PostgreSQL
unique-violation code `23505`. CI runs this suite fail-closed against a real
PostgreSQL service; the `Local Agent PostgreSQL Concurrency` check passed for the
reviewed head.

### Claim, result, expiry, and recovery semantics

- Claims use `FOR UPDATE SKIP LOCKED`, bind the registered device, and establish
  a lease.
- Result submission locks the row, checks device/job/status/expiry/lease
  predicates against database time, and repeats the predicates in the terminal
  update.
- Exact terminal-result replay is idempotent; conflicting duplicate results
  fail closed.
- Mutating jobs with uncertain outcomes enter manual reconciliation and remain
  quarantined from key reuse and generic failed-job cleanup.
- Expiry reconciliation applies a per-job transition and event atomically.
  Savepoints allow one candidate/event failure to roll back without collapsing
  the lifecycle records of successful candidates.
- Generic job workers, recovery, requeue, inspection, and cleanup do not acquire
  local-agent authority accidentally.

### Round-1 finding dispositions

| Previous finding | Round-2 disposition |
| --- | --- |
| Manual-reconciliation jobs could lose their quarantine after the ordinary idempotency window | Resolved. Key reuse and binding cleanup exclude `manualReconciliationRequired=true`, and generic failed-job cleanup preserves those rows. |
| Result expiry/lease checks relied on application time | Resolved. Locked reads and terminal updates use PostgreSQL `NOW()` predicates. |
| Batched expiry did not guarantee equivalent per-job event treatment | Resolved. Each transition and event is transactional, with per-candidate savepoints and failure isolation. |
| Migration verification did not validate the complete expected shape | Substantially resolved. Columns, named constraints, indexes, foreign-key actions, parity, and required bindings are verified. One precision condition remains below. |
| PostgreSQL concurrency coverage was optional/skipped | Resolved. The required CI job provisions PostgreSQL and fails when its dedicated connection variable is absent. |
| Local-agent terminal output retention was not bounded consistently | Partially resolved. Non-manual failed jobs can be removed by generic failure cleanup; completed/cancelled/expired local-agent rows still need an explicit operational retention policy. |

## Productivity database review

The productivity repository consistently scopes reads and writes by trusted
principal and workspace. Project relationships use tenant-aware composite
foreign keys. Mutations execute canonical state change, outbox/domain event, and
idempotency receipt in one transaction. Repeated identical commands return the
stored result; key reuse with a different canonical request produces a conflict.
Task version and project timestamp checks prevent stale writes.

`state.current`, focus, context, and review projections derive from the same
canonical repository interpretation. Migration/startup-schema parity tests cover
the six productivity tables and their indexes and constraints.

## Migrations

The local-agent hardening migration is additive and idempotent. It creates the
binding table only after the required `job_data` fields exist, backfills eligible
live bindings, and adds named checks, unique constraints, a deferred cascading
foreign key, and an expiry index. Compensation fails closed unless the binding
table is empty and no active local-agent jobs remain.

The runner:

- requires explicit preview project/environment/service identity;
- rejects the Phase 2E validation target and unapproved target metadata;
- validates normalized artifact checksums;
- uses transaction, lock, and statement timeouts;
- verifies the schema and binding/job parity after application.

The production-capable migration path is deliberately absent. This is safe
because production cannot silently receive the preview migration, but production
must keep local-agent execution disabled until an operator-approved production
migration procedure is documented and exercised.

## Round-2 remediation

A cross-boundary inspection found that generic latest-job/system-diagnostics
code could otherwise expose a local-agent job outside its protected GPT Access
result endpoint. The shared candidate now applies defense in depth:

- `getLatestJob` filters `job_type <> 'local-agent'`;
- `listFailedJobs` applies the same filter;
- generic job-by-id inspection returns `null` for a local-agent row;
- public system diagnostics reject local-agent rows even if an upstream source
  regresses and serialize only bounded metadata for ordinary jobs.

The new focused suites validate the repository SQL boundary, job-by-id service
boundary, and public JSON/YAML diagnostic boundary. I independently ran all
three: 3 suites and 8 tests passed.

## Residual findings and conditions

### DB-01 — Medium: terminal local-agent data retention is incomplete

Completed, cancelled, and expired local-agent `job_data` rows can contain
repository/test/diff output. The ordinary GPT compactor only targets GPT jobs,
and generic retained-failure cleanup only handles failed rows. Consequently,
successful local-agent rows can grow without a defined deletion horizon.

**Condition:** before production enablement, define and implement a bounded
retention/compaction policy for terminal local-agent rows and their events. Keep
manual-reconciliation rows quarantined until an explicit resolution/archive
operation. The policy must preserve audit requirements and delete bindings and
jobs in foreign-key-safe order.

### DB-02 — Medium: production migration promotion is intentionally unresolved

The checked migration runner is preview-only. That prevents accidental
production mutation, but the table is required for local-agent idempotency.

**Condition:** keep production local-agent job creation fail-closed until a
separately approved production migration runbook establishes exact target
identity, backup/rollback procedure, migration execution, post-migration
verification, and observability.

### DB-03 — Low: verifier labels are stronger than the implemented check

The verifier checks the exact definitions of all expected named constraints and
indexes, but its catalog queries filter to expected names. An unexpected extra
constraint or index would not make the returned `exactConstraints` or
`exactIndexes` flags false.

**Condition:** either query and reject unexpected table constraints/indexes, or
rename the result fields/documentation to `expectedConstraintsValid` and
`expectedIndexesValid`. This does not invalidate the current migration because
the migration itself creates the reviewed expected set.

### DB-04 — Medium: productivity cleanup and snapshot bounds are operational follow-ups

Expired productivity command receipts are removed opportunistically by the next
command in the same tenant, and the canonical current-state snapshot reads all
tasks/projects before deriving projections. Dormant tenants retain expired
receipts, while very large active tenants can incur avoidable memory/latency.

**Condition:** before materially increasing tenant volume, add a bounded
maintenance path for expired receipts and either paginate/cap state inputs or
introduce a rebuildable projection. Preserve the existing repository,
transaction, and trusted-tenant boundaries.

### DB-05 — Low: reversible productivity migration lacks a rollback artifact

Preview teardown removes the isolated database, but the productivity SQL change
does not include a conventional compensation file matching the repository's
guidance for reversible migrations.

**Condition:** document that the migration is forward-only or add a guarded
rollback that refuses to drop non-empty productivity tables. Do not infer
authorization to execute it.

## Validation evidence

Commands actually executed by this reviewer:

```text
git diff --check 59989445..87788342
```

Passed.

```text
node scripts/run-jest.mjs \
  --testPathPatterns=local-agent-job-repository \
  --testPathPatterns=local-agent-hardening-migration \
  --testPathPatterns=job-repository.cleanupRetainedFailedJobs \
  --testPathPatterns=job-event-repository \
  --testPathPatterns=productivity-repository \
  --testPathPatterns=productivity-schema-parity \
  --coverage=false --runInBand
```

Passed: 6 suites, 58 tests.

```text
node scripts/run-jest.mjs \
  --testPathPatterns=job-repository.local-agent-boundary \
  --testPathPatterns=system-diagnostics-local-agent-boundary \
  --testPathPatterns=worker-control-service \
  --coverage=false --runInBand
```

Passed: 3 suites, 8 tests.

```text
npm run validate:railway
```

Passed.

```text
$env:LOCAL_AGENT_HARDENING_REQUIRE_DATABASE='1'
Remove-Item Env:LOCAL_AGENT_HARDENING_TEST_DATABASE_URL
npm run test:local-agent-postgres
```

Expected negative check: exited non-zero with
`LOCAL_AGENT_HARDENING_TEST_DATABASE_URL_REQUIRED`, confirming the CI path does
not silently skip without a database.

Observed required head checks were all successful, including:

- Build (Node 20.19.0)
- Lint & Type Check
- Test Suite (unit)
- Test Suite (integration)
- Local Agent PostgreSQL Concurrency
- Local Agent Sandbox (Linux)
- Railway Compatibility
- Deployment Readiness
- API and worker Railway preview statuses
- All Checks Complete

The reviewer did not apply a migration or mutate a Railway resource.

## Merge recommendation

Approve the database/job-semantics portion once the Round-2 generic-inspection
remediation and its tests are committed to the PR candidate and the required CI
matrix passes that new commit. The five residual conditions above should be
tracked before production enablement, but they do not block merging the
isolated, fail-closed preview implementation.
