# Database and Migrations

## Overview
Arcanos uses PostgreSQL when `DATABASE_URL` or equivalent `PG*` variables are configured. Without a database, several backend paths continue in reduced or in-memory mode, but queued async jobs and durable inspection require PostgreSQL.

## Prerequisites
- PostgreSQL access for migration development or validation.
- `DATABASE_URL` or a complete `PG*` connection set when running database-backed paths.
- Node dependencies installed from the repository root.

## Sources
| Path | Purpose |
| --- | --- |
| `src/core/db/` | Runtime database initialization, schema checks, and repositories used by the backend and worker. |
| `src/core/db/schema.ts` | Idempotent runtime table definitions; `src/db/schema.ts` is a compatibility re-export. |
| `prisma/schema.prisma` | Prisma schema for ActionPlan/CLEAR-related models and Prisma client generation during Docker builds. |
| `migrations/**` | Hand-written SQL migrations, versioned migration bundles, validation manifests, and rollback/compensation SQL for runtime tables. |
| `contracts/job_status.openapi.v1.json` | Contract for job status reads. |
| `contracts/job_result.openapi.v1.json` | Contract for job result reads. |

## Runtime Behavior
- The backend calls `initializeDatabaseWithSchema()` during startup, reusing
  an already-connected pool when available, and continues with in-memory
  fallback when no connected, schema-ready pool can be established. A worker
  heartbeat is written only after that exact pool is ready.
- Runtime schema readiness is keyed to the concrete PostgreSQL pool object.
  Concurrent callers for one pool share one initialization attempt, completed
  pools do not repeat DDL, and a failed attempt can be retried. Replacing a
  pool creates independent readiness state; completion from an obsolete or
  disconnected pool cannot mark the current pool ready.
- Startup performs one read-only catalog query to compare the database's
  configured collation version with
  `pg_database_collation_actual_version(oid)`. A mismatch emits a warning with
  both versions and requires separately approved operator maintenance; startup
  never runs `REINDEX`, refreshes the stored version, or otherwise repairs
  collation state.
- The dedicated worker process requires database connectivity before it can claim queued jobs.
- GPT and worker job state is stored in database-backed job tables, not Redis.
- Redis supports fast shared state and health visibility; it is not the durable job source of truth.
- Shared database queries execute once by default. A caller may opt into at
  most three total attempts only with
  `{ retry: 'transient-read', idempotent: true, auditedQueryId: ... }`; the
  helper accepts that policy only when the identifier and normalized SQL
  exactly match an immutable audited-query registry entry, and only retries an
  explicit transient PostgreSQL SQLSTATE. Pool acquisition failures are
  single-attempt and remain outside this query-execution retry policy. There is
  no environment switch that can silently enable retries for writes, dynamic
  SQL, arbitrary `SELECT` statements, or all reads.

## Local Configuration
```env
DATABASE_URL=postgresql://user:password@host:5432/database
```

Railway deployments can also use:
```env
DATABASE_PRIVATE_URL=postgresql://user:password@postgres.railway.internal:5432/database?sslmode=no-verify
DATABASE_PUBLIC_URL=postgresql://user:password@public-proxy.rlwy.net:12345/database?sslmode=no-verify
```

For local access to a Railway Postgres proxy, set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` as shown in `.env.example`.

## Setup
Copy the backend env template and set a database connection:
```bash
cp .env.example .env
```

## Migration Workflow
1. Add an idempotent SQL migration under `migrations/`.
2. Add a rollback SQL file when the change is reversible.
3. Update runtime initialization or repository code if the app must create/read new tables.
4. Update `docs/API.md`, `docs/CONFIGURATION.md`, or worker docs when response shapes or operational behavior change.
5. Run focused tests for the changed repository/route and full validation before deploy.

Recommended validation:
```bash
npm run build:packages
npm run type-check
node scripts/run-jest.mjs --testPathPatterns=<db-or-route-pattern> --coverage=false
npm run validate:railway
```

### Backstage storyline serialized-beat migration

`migrations/20260805_backstage_storyline_serialized_data.sql` adds nullable
`backstage_story_beats.serialized_data` plus nullable BIGINT
`storage_sequence`. A validated paired-component constraint requires every
populated serialization to parse as a JSON object, occupy at most 16,384 bytes
when converted to UTF-8, carry a positive storage sequence, and retain a finite
non-null legacy timestamp. The serialized text is the authoritative exact beat
representation so JSON escapes such as `\\u0000` and unpaired UTF-16 surrogates
never pass through PostgreSQL's stricter JSONB conversion. New rows retain `{}`
in the legacy `data` JSONB column only as a compatibility placeholder.

`storage_sequence`, not the caller-visible timestamp, is the deterministic
append and retention order. Each mutation first compacts the bounded retained
set to a dense order before appending, so extreme finite timestamps and manual
BIGINT extremes cannot poison or overflow later writes. Runtime initialization
verifies both exact additive columns and compares the named constraint through
PostgreSQL's canonical deparsed expression; same-named or reserved-verifier
drift fails closed. No source-validation command applies this migration.

The first successful post-upgrade storyline mutation runs under the shared
storyline advisory transaction lock and a `SHARE ROW EXCLUSIVE` relation lock.
The relation lock lets ordinary reads continue while fencing legacy binaries
that insert without taking the advisory lock: an older write is either visible
before containment begins or commits after the current mutation. The mutation
admits at most the newest 100 legacy JSON-object rows whose PostgreSQL
serialization satisfies the byte contract, densely ranks existing authoritative
rows before those admitted legacy rows without arithmetic on stored BIGINT
extremes, stores each admitted serialization, inserts the new exact
caller-validated serialization, removes every uncontained or non-finite legacy
row, prunes to 100 total rows, and reads the bounded chronological state before
commit. The transaction explicitly uses `READ COMMITTED` before taking its
fixed locks so a waiting writer observes the preceding committed mutation. This transition
intentionally makes oversized, non-object, non-finite, and out-of-retention
pre-contract rows ineligible for the new public timeline rather than returning
an unbounded legacy value.

`migrations/20260805_backstage_storyline_serialized_data.rollback.sql` removes
only the exactly verified named constraint and two nullable storage columns,
and only before any exact storyline content has been written. Because the text
column is authoritative while the legacy JSONB value is `{}` for new beats,
populated storage makes rollback destructive; the rollback therefore refuses
that state rather than discarding canon. It also fails closed when an owned
definition has drifted, the constraint is missing, or another object depends on
the columns. It is provided for reviewed rollback planning and is never run as
routine validation.

### Gaming knowledge-source migration

`migrations/20260808_gaming_knowledge_sources.sql` adds the durable Gaming
source, revision, and knowledge-record tables used by the authenticated source
ingestion workflow. Source identity is unique by normalized game key and a
SHA-256 canonical-URL digest; the repository verifies the full canonical URL
before treating a digest match as the same source. Successful refreshes append
an immutable revision and atomically supersede only that source's prior active
knowledge records. Unchanged content updates freshness timestamps without
duplicating records.

The rollback file is intended only for an explicitly confirmed disposable
database because dropping these tables removes ingested Gaming knowledge. Do
not apply either file as routine validation. Runtime startup mirrors the
additive table and index definitions in `src/core/db/schema.ts`.

### Local-agent hardening migration

The additive
`migrations/20260724_local_agent_job_hardening_v1/01_local_agent_job_idempotency.sql`
migration creates the database-authoritative local-agent idempotency binding.
Use only the guarded `db:local-agent-hardening:*` commands documented in
`LOCAL_AGENT_CAPABILITY_BRIDGE.md`; apply, verify, and compensation require an
explicitly identified isolated preview PostgreSQL service.

The verifier checks the complete binding-table column contract, constraints,
foreign-key behavior, and indexes. It also checks that every binding matches
its linked `job_data` envelope and that each live, unexpired, or
manual-reconciliation local-agent job has a binding. A mismatch fails closed
and requires operator reconciliation.

When
`autonomy_state.localAgent.manualReconciliationRequired` is `true`, the job
and its binding are quarantined indefinitely: the key cannot become reusable
when its ordinary idempotency window expires, and generic failed-job cleanup
must not delete the job or cascade-delete its binding. Removal requires a
future explicit, audited reconciliation workflow; age-based cleanup is not a
resolution mechanism.

Local-agent terminal result acceptance compares both the assignment expiry and
active lease against PostgreSQL `NOW()` in the locked read and terminal
update. Application-host clock skew therefore cannot authorize a late result.

CI runs the two-connection migration, schema-drift, parity, and uniqueness
tests against an isolated PostgreSQL 18 service:

```bash
ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1 \
LOCAL_AGENT_HARDENING_TEST_DATABASE_URL=postgresql://... \
npm run test:local-agent-postgres
```

The shared required flag governs both required PostgreSQL package commands and
all seven suites. `npm run test:postgres-fencing` additionally requires
`JOB_CLAIM_FENCING_TEST_DATABASE_URL`,
`DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL`,
`JOB_WORKER_BUDGET_TEST_DATABASE_URL`,
`JOB_STALE_RECOVERY_TEST_DATABASE_URL`,
`BACKSTAGE_ROSTER_ATOMICITY_TEST_DATABASE_URL`, and
`BACKSTAGE_STORYLINE_ATOMICITY_TEST_DATABASE_URL`. With the sentinel set, a
missing dedicated URL fails before `describe.skip`; without it, an absent URL
retains the intentional local skip. No suite reads ambient `DATABASE_URL`.
Every configured target must use credentials, an explicit loopback port, and
the exact disposable database `arcanos_audit_pg18_20260727`. Never point either
test command at production or a retained preview database.

### Generic queue claim-generation fencing migration

`migrations/20260727_job_claim_generation_v1.sql` adds the non-negative
`BIGINT NOT NULL DEFAULT 0` `job_data.claim_generation` token used by generic
workers. Runtime initialization in `src/core/db/schema.ts` enforces the same
column and validated check-constraint contract. Both paths fail closed when an
existing column or named constraint has an incompatible definition.

Each non-local-agent claim atomically increments the generation. Heartbeat,
retry, provider-deferral, and terminal writes then require the exact worker,
generation, running status, and unexpired lease. PostgreSQL `BIGINT` values
remain validated decimal strings in TypeScript to avoid JavaScript number
precision loss. Local-agent jobs retain their separate assignment protocol.

`migrations/20260727_job_claim_generation_v1.rollback.sql` refuses rollback
while any running job is not provably `local-agent`, verifies the exact column
and named constraint before destructive DDL, then removes only that fencing
contract. Validate this migration only against an explicitly created disposable
PostgreSQL 18 database by setting
`JOB_CLAIM_FENCING_TEST_DATABASE_URL`; the guarded test never reads an
inherited `DATABASE_URL`. Required runs also set the shared
`ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` sentinel described above.

### Generic worker stats-identity migration

`migrations/20260801_job_worker_stats_identity_v1/` adds nullable
`job_data.stats_worker_id`, the exact configured worker-group identity stamped
on every generic queue claim. It remains separate from `last_worker_id`, which
continues to fence the individual slot lease, and from `worker_id`, which
continues to identify the producer.

The rollout is deliberately phased. Add and verify the column first, precheck
the index name, run `CREATE INDEX CONCURRENTLY` as its own non-transactional
statement, then run the exact catalog verifier. The partial B-tree on
`(stats_worker_id, updated_at)` supports the hourly budget window without
putting an ordinary index build on application startup. No migration is applied
by source validation.

If the concurrent build is interrupted, the exact same-name index may remain
invalid or not ready. The normal precheck refuses that state. With claims still
quiesced, use the migration's guarded atomic recovery drop and rerun phases 2-4;
the recovery refuses a healthy index or any unexpected definition. Destructive
rollback likewise verifies and atomically drops only the owned index, requires
all compatible readers and writers to be drained, and verifies the exact empty,
dependency-free plain column before removing it. Recovery and rollback use an
access-exclusive `job_data` lock to keep verification and removal inseparable;
all phases must run under one reviewed trusted schema/search-path context.

Old workers do not stamp the column. Compatible-worker bootstrap performs stale
recovery and GPT lifecycle cleanup before reading exact stats, so legacy rows
can receive a fresh `updated_at` while `stats_worker_id` remains null. This
includes recoverable running rows, pending GPT rows, and retained terminal GPT
rows whose lifecycle deadline can later expire. A quiet-window-only transition
is unsupported. Draining workers and waiting one hour alone is insufficient.

Production must establish one continuous freeze of all `job_data` mutators
before inspecting or changing legacy rows. Every transition, including an exact
backfill, must run under the same continuous freeze. Under that freeze, use a
reviewed, bounded exact backfill based on confirmed deployment-specific
slot-to-group evidence or take the no-backfill path. Fail closed if any affected
row cannot be mapped or accounted for exactly.

Both paths must pass the migration README's common post-transition read-only
gate: zero generic running rows, zero trailing-hour null running/terminal rows,
zero null pending GPT rows, and zero null retained terminal GPT rows. A single
query cannot close a concurrent-writer race. The compatible worker must be the
first released mutator. Complete compatible worker activation and
bootstrap/readiness verification before releasing the remaining compatible
writers. Prefix inference is intentionally unsupported because
`JOB_WORKER_STATS_ID` can differ from `JOB_WORKER_ID`. The guarded PostgreSQL 18
suite uses only `JOB_WORKER_BUDGET_TEST_DATABASE_URL` and refuses non-loopback or
unexpected database targets. The shared required-PostgreSQL sentinel turns a
missing database URL into a hard failure instead of a skipped database suite.

### DAG snapshot-generation fencing migration

`migrations/20260727_dag_run_snapshot_generation_v1.sql` adds the
non-negative `BIGINT NOT NULL DEFAULT 0`
`dag_runs.snapshot_generation` fencing token. Runtime initialization enforces
the same exact type, default, nullability, and validated named-check contract.
At the TypeScript repository boundary, generations remain canonical decimal
strings so PostgreSQL `BIGINT` precision is preserved.

The DAG service captures generation `1` before admitting a new run and
deep-clones the complete persistence envelope before each serialized write.
An upsert applies only when its generation is higher than the stored
generation. Initial persistence must apply before execution launches; an
exception or rejected generation removes only the new local/tracker state.
Later rejected generations quarantine that run's persistence lane and emit one
ownership-conflict diagnostic, preventing further stale writes without
rewriting run lifecycle state.

This change requires a coordinated writer rollout. A pre-fencing binary still
uses an unconditional conflict update and can overwrite snapshot data without
advancing `snapshot_generation`, so applying the schema migration alone does
not fence mixed-version writers. Drain or stop every DAG-writing process,
apply the migration and compatible code together, and do not allow an older
binary to run concurrently. Likewise, attempt rollback only after all writers
are stopped or confirmed compatible with the rolled-back schema.

The repository-level Railway fail-safe for this rollout is the
`20260727-dag-snapshot-generation-v1` value of
`ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD` in
`.github/workflows/railway-auto-deploy.yml`. With that hold active, successful
`main` CI cannot automatically start the Railway deployment job. A deliberate
manual dispatch requires the exact typed attestation
`DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1`; the workflow does
not perform or verify the drain itself and deploys only its one configured
service.

Keep the hold active until the migration and compatible revision are verified
on every DAG-writing process, all older replicas are gone, and post-deploy
health is accepted. Keep it active through any rollback. Then set the marker to
the exact sentinel `none` in a reviewed follow-up commit to restore normal
automatic promotion. Deleting, blanking, or malforming the marker fails closed
instead of silently lifting the hold.

`migrations/20260727_dag_run_snapshot_generation_v1.rollback.sql` verifies
the complete installed column and validated constraint before destructive
DDL, and refuses rollback while any row has an unknown or nonterminal status.
Validate this migration only against the explicitly created disposable
PostgreSQL 18 database selected through
`DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL`. The guarded integration test
requires an explicit loopback host and port plus the exact disposable database
name, rejects URL overrides, and never reads an inherited `DATABASE_URL`.
Required runs also set the shared `ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1`
sentinel described above.

### Productivity core migration

`migrations/20260724_productivity_core.sql` is an additive, idempotent,
forward-only migration. It intentionally has no automated rollback: dropping
its workspace, project, task, note, review, event, or command-receipt tables
could destroy canonical user data. Preview rollback is performed by discarding
the isolated preview database. Any future production compensation must be a
separately reviewed, operator-approved data migration or archival procedure;
do not add or execute an unconditional table-drop rollback.

## Run locally
Start the backend after configuring the database:
```bash
npm run build
npm start
```

Start the dedicated worker only when the database and OpenAI key are configured and you intend to consume the configured queue:
```bash
npm run start:worker
```

This is an active worker process, not a read-only probe. It initializes database state, writes heartbeat state, and can claim queued jobs from the configured database.

## Deploy (Railway)
Attach PostgreSQL to the Railway environment or set a valid external `DATABASE_URL`. The web and worker services must point at the same database for async jobs to be observable and claimable.

## Current Script Gaps
The root `package.json` still lists `db:init` and `db:patch`, but the referenced compiled JavaScript files are not present in `scripts/` in this checkout. Treat those scripts as unavailable until the script targets are repaired or replaced with a documented migration runner.

## Troubleshooting
- Worker exits with database bootstrap errors: configure `DATABASE_URL`, `DATABASE_PRIVATE_URL`, `DATABASE_PUBLIC_URL`, or the complete `PG*` set.
- API health reports database degraded: attach PostgreSQL or accept reduced in-memory behavior for local development.
- Queued jobs never complete: confirm the worker service can connect to the same database as the web service.

## References
- `../.env.example`
- `../prisma/schema.prisma`
- `../migrations/`
- `../src/core/db/`
- `CONFIGURATION.md`
- `RAILWAY_DEPLOYMENT.md`
