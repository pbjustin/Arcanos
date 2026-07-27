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
LOCAL_AGENT_HARDENING_REQUIRE_DATABASE=1 \
LOCAL_AGENT_HARDENING_TEST_DATABASE_URL=postgresql://... \
npm run test:local-agent-postgres
```

The required flag prevents a missing CI database variable from turning the
database suite into a silent skip. Never point this test command at production
or a retained preview database.

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
inherited `DATABASE_URL`.

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

`migrations/20260727_dag_run_snapshot_generation_v1.rollback.sql` verifies
the complete installed column and validated constraint before destructive
DDL, and refuses rollback while any row has an unknown or nonterminal status.
Validate this migration only against the explicitly created disposable
PostgreSQL 18 database selected through
`DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL`. The guarded integration test
requires an explicit loopback host and port plus the exact disposable database
name, rejects URL overrides, and never reads an inherited `DATABASE_URL`.

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
