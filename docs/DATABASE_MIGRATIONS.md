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
- Completed/cancelled `ask` and `dag-node` rows receive explicit per-type
  `retention_until` deadlines at terminal persistence. Worker inspection
  deletes only expired, non-idempotency-protected rows from that exact
  allowlist in deterministic `FOR UPDATE SKIP LOCKED` batches, after the
  active worker-budget and queue-diagnostics observation windows. Legacy rows
  with a null deadline remain protected. Each enabled cleanup pass reports only
  a bounded aggregate legacy-null inventory (never IDs or payloads), and the
  worker warns once when protected rows first appear. Any deadline backfill or
  cutover remains a separately reviewed operation.
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

### Backstage Booker universe-scope migration

`migrations/20260814_backstage_universe_scope_v1.sql` adds a bounded,
non-null `universe_id` to `backstage_events`, `backstage_wrestlers`,
`backstage_storylines`, and `backstage_story_beats`. Existing rows are
backfilled into `legacy`, which also remains the database default for older
callers. Named check constraints enforce the same identifier syntax as the
public action schemas:
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.

The migration replaces global wrestler-name and storyline-key uniqueness with
`(universe_id, name)` and `(universe_id, story_key)` uniqueness. It also adds
universe-first recency indexes for roster, event, storyline, and story-beat
reads. Runtime bootstrap in `src/core/db/schema.ts` installs the additive
columns, checks, scoped uniqueness, and indexes but deliberately retains the
legacy global constraints. Their absence is the activation marker for
non-`legacy` durable writes, so runtime startup alone cannot expose
universe-scoped rows to an older replica's global readers. While either global
constraint remains, the repository blocks all four non-`legacy` mutations
before domain DML. Structured callers receive a `non_durable` receipt with
`database_write_failed` and continue in the universe-scoped process-memory
fallback; `legacy` database writes continue normally.

Before applying the explicit migration, stop and drain every older Backstage
Booker replica that uses global roster or storyline reads and confirm that only
universe-aware replicas can resume. The migration removes
`backstage_wrestlers_name_key` and `backstage_storylines_story_key_key`; once
that transaction commits, new replicas admit non-`legacy` writes. Do not apply
the migration while an older reader or writer can still serve traffic.
The same drain-and-activate boundary applies to a fresh database: current
runtime table creation installs both legacy global constraints alongside the
composite scoped constraints. Startup never activates non-`legacy` durability
by dropping a global constraint; only the reviewed explicit migration does so.

All four Backstage mutations run in PostgreSQL transactions. Legacy roster
upserts retain the original fixed transaction-scoped advisory lock so they
serialize with older replicas; activated non-legacy universes use independent
hashed roster-lock resources. Story-beat mutations retain the original fixed
storyline advisory lock for every universe and also take the existing relation
writer fence, preserving mixed-version containment at the cost of serializing
storyline writes across universes. Named storyline saves serialize per universe
under a transaction advisory lock and obtain a database revision after that
lock; the service uses the revision to fence per-key and latest convenience
views by commit order. Booking-generation context uses a
read-only repeatable-read transaction across roster, event, story-beat, and
saved-storyline queries instead of combining values from different database
snapshots. The explicit pre-activation gate and recognized availability or
transient database failures use the service's disclosed universe-scoped
process-memory fallback and return `non_durable`. Integrity, programming, and
result-mapping failures propagate instead of being mislabeled as degraded
persistence. An indeterminate commit is reported as `unknown` and is not
retried automatically. The unknown path does not mutate the fallback, audit
mirror, or exact-memory convenience keys. For `saveStoryline`, it also returns
`saved: null` instead of asserting a result that PostgreSQL did not confirm.

`migrations/20260814_backstage_universe_scope_v1.rollback.sql` is guarded. It
refuses to remove universe scoping while any affected table contains a
non-`legacy` row, because restoring global uniqueness could collapse distinct
universe records. Before evaluating that guard it takes `ACCESS EXCLUSIVE`
locks on all four tables in the same fixed order as context reads and retains
them through the rollback, preventing a concurrent writer from inserting a
non-legacy row between the guard and schema removal. Do not apply either file
as routine validation, and do not interpret the presence of this schema as a
canon/storyline domain model.

### Backstage Booker canon/storyline migration

`migrations/20260814_backstage_canon_storyline_v1.sql` installs the additive
Phase 2A canon substrate after the universe-scope migration is active. It does
not alter, import, or dual-write the Phase One `backstage_storylines` prose or
the bounded `backstage_story_beats` continuity cache. Older replicas ignore the
new tables, so this additive step requires no additional mixed-version drain;
non-`legacy` writes still require the earlier universe-scope activation marker.
Runtime startup mirrors the additive definitions in `src/core/db/schema.ts`.
Do not apply the migration or runtime initializer as routine validation.
The forward migration's transactional table phase and the guarded rollback pin
their transaction-local `search_path` to `public, pg_catalog`; the preceding
non-transactional concurrent-index phase schema-qualifies its shared table.
Every owned object therefore resolves in the intended application schema rather
than a caller-controlled session schema.
The two canon UUID defaults bind PostgreSQL's built-in
`pg_catalog.gen_random_uuid()` explicitly. Re-running the forward migration
also normalizes pre-promotion Phase 2 installs that bound those defaults to
pgcrypto's legacy `public.gen_random_uuid()` wrapper, before the exact catalog
verifier runs.

The migration adds:

- `backstage_canon_heads`, the one-row-per-universe serialization and semantic
  revision anchor;
- `backstage_canon_revisions`, immutable mutation-ID, request-fingerprint, and
  exact-result evidence used for replay after lost acknowledgements;
- `backstage_storyline_threads`, versioned typed storyline aggregates separate
  from legacy saved prose;
- `backstage_storyline_participants`, with composite universe/storyline and
  universe/roster foreign keys; and
- `backstage_storyline_canon_beats`, the immutable, storyline-local beat ledger
  with same-universe event and retcon references.

The only Phase One schema addition is a named unique identity on
`backstage_events(universe_id, id)`, used as the target of the beat-to-event
composite foreign key. The migration builds that index with
`CREATE UNIQUE INDEX CONCURRENTLY` before `BEGIN`, then attaches it as the named
constraint inside the transactional phase. Execute the file with a phase-aware
client such as `psql --set=ON_ERROR_STOP=1 --file=<migration>` against the
separately approved target; never wrap the complete file in another transaction,
submit all of it as one database query, or allow execution to continue after a
failed phase. Successful reruns are idempotent because
the attached constraint retains the index name. If an interrupted concurrent
build leaves that name invalid or incomplete, the transactional verifier fails
closed; inspect the exact object, remove only that invalid index with a separately
approved `DROP INDEX CONCURRENTLY`, and rerun the migration. Runtime startup
creates the constraint inline only for a genuinely new `backstage_events` table.
For an existing table, it verifies the constraint and fails closed if the
explicit migration was skipped, so startup never performs a blocking index
build. Every Phase 2 relationship includes `universe_id`, uses
`RESTRICT` rather than cascading canon away, and keeps revision foreign keys
deferred until the immutable revision/result row is inserted in the same
transaction. Writers lock the canon head before checking mutation replay or
storyline versions. A new mutation advances the head exactly once; an identical
`(universe_id, mutation_id, request_fingerprint)` replay returns the stored
result without another revision, while a changed fingerprint fails closed.

The guarded rollback acquires exclusive locks in repository order and refuses
with SQLSTATE `55000` if any head has a nonzero revision or any Phase 2
revision, storyline, participant, or beat row exists. Revision-zero head seed
rows alone are disposable. It drops only the five Phase 2 tables and retains
`uq_backstage_events_universe_id`, because the forward migration may have
adopted an exact pre-existing shared-table constraint whose ownership it cannot
prove. Once canon has been written, roll back application code while preserving
the schema and data; do not drop the ledger. Ordinary source validation never
applies either file; the dedicated disposable PostgreSQL 18 integration suite
applies and rolls them back only against its explicitly guarded loopback test
database.

Phase 2 must be rolled back before the Phase One universe-scope rollback because
the participant table references Phase One's scoped roster identity. The Phase
One rollback now rejects the reverse order with SQLSTATE `55000` while any Phase
2 table remains, instead of falling through to a lower-level dependency error.

### Backstage Notion RAG authority migration

`migrations/20260819_backstage_notion_rag_v1.sql` adds a dedicated derived
index; it does not use the global `rag_docs` corpus or rewrite any legacy
Backstage row. Runtime startup mirrors the additive DDL in
`src/core/db/schema.ts`. The migration creates one universe authority/head
table, immutable snapshot/page/chunk tables, and a token-fenced sync lease.
Chunks store deterministic SHA-256 identities and JSONB embeddings scoped by
universe, snapshot, and model. A no-change sync updates only the head's
`last_verified_at`.

First activation occurs in one transaction: it locks and revalidates the
unexpired lease, drains all nine legacy tables in a fixed
`SHARE ROW EXCLUSIVE` order, advances a singleton authority epoch, takes
`ACCESS EXCLUSIVE` on the authority-head table, inserts the complete immutable
snapshot, rechecks the lease, and flips `authority='notion'` plus
`active_snapshot_id`. Legacy read transactions take `ACCESS SHARE` on the head
table before establishing their repeatable-read snapshot, so cutover drains
them before the flip. The epoch's locking read makes a stale repeatable-read
writer fail rather than observe a pre-cutover or absent universe head.

Triggers reject `INSERT`, `UPDATE`, and `DELETE` affecting that universe in
legacy events, roster, prose storyline, story-beat, canon head/revision, typed
storyline/participant, and canon-beat tables. They also prevent deletion or
downgrade of a Notion-authoritative head and permit active-snapshot rotation
only when the old and new snapshots use the same root page. The application
guard is earlier and cheaper, but these triggers are the database invariant.
All authority-boundary rejection uses SQLSTATE `BN001`; same-root snapshot
rotation and `last_verified_at` refresh remain permitted.

`migrations/20260819_backstage_notion_rag_v2_index_version_fence.sql` is the
additive rolling-upgrade fence for immutable snapshot activation. Runtime
startup installs the same trigger before a worker can become ready. Apply V2
only after `20260819_backstage_notion_rag_v1.sql`; its filename sorts after V1
for forward-only migration enumeration. Every page in both the candidate and
current snapshot contributes an `indexFormat`
marker; the canonical `backstage-notion-rag-index-vN` suffix is parsed as a
bounded integer, while a missing or malformed marker is legacy version `0`.
The trigger rejects incomplete page inventories, mixed versions, active-head
clears, and candidate versions below the current version with SQLSTATE
`BN002`. It permits initial legacy activation, legacy-to-current upgrade, and
same-version rotation. Root identity remains governed independently by the
authority-persistence trigger: a Notion-authoritative root cannot be replaced
through snapshot rotation, so a deliberate root reset still requires the
separately reviewed authority-restoration procedure.

The fence rollback takes `ACCESS EXCLUSIVE` on the head table and refuses with
SQLSTATE `55000` while any snapshot is active. Apply that rollback before the
V1 storage rollback only on an unused installation; removing the fence from a
live authority would allow an older worker to reactivate legacy metadata.

The rollback file is intentionally guarded. It locks every affected table and
refuses with SQLSTATE `55000` when any authority head, snapshot, page, chunk, or
lease row exists. It never uses `CASCADE`. Once activated, preserve/export the
derived history and roll back application behavior through a separate approved
authority-restoration procedure; do not drop the schema as routine rollback.
V1 retains prior successful immutable snapshots and has no automatic purge.
Ordinary validation must not apply either file to a configured/shared database;
use only a dedicated disposable PostgreSQL 18 target.

### Backstage Notion partition shadow storage migration

`migrations/20260824_backstage_notion_partition_storage_v1.sql` adds the
partitioned index as an independent shadow store. It does not alter the
monolithic authority head, serve partitioned reads, or perform a production
cutover. Runtime startup executes the same transactional DDL from
`src/core/db/backstageNotionPartitionStorageSchema.ts` after the monolithic
tables exist.

An immutable configuration-generation header identifies the exact desired
shard set. Stable `(universe_id, shard_key)` identities are separate from
immutable configuration versions, titles, roots, tags, tiers, and bounded
per-shard capacity. Normalized page, chunk, and model-version embedding records
allow unchanged content to be reused. Embeddings use validated one-dimensional
`DOUBLE PRECISION[]` values; PostgreSQL recomputes the non-zero finite norm and
does not require `pgvector`.

Page versions, shard snapshots, and universe manifests begin in `building` and
support exactly one validated transition to `sealed`. Parent-locking triggers
reject every later child insert, update, or delete. Immutable snapshot chunk
occurrences pin each selected snapshot page and page version to the exact chunk
and embedding model/version. A manifest records either a selected snapshot or
an explicit optional omission for every shard in its sealed configuration;
its ownership primary key prevents one page from belonging to two member
shards. Membership also stores the immutable snapshot verification time used by
future freshness decisions. Mutable shard and universe heads accept only sealed
objects and require exact compare-and-swap generation increments. Shard and
provider leases independently fence distributed synchronization.

Partition candidate ranking uses stock PostgreSQL 18 and remains additive to
the shadow schema. One read-only, repeatable-read statement fences the exact
sealed manifest, immutable shard tuples, page ownership, embedding contract,
and durable Notion authority before returning any content. A request already
pinned to manifest A may finish coherently after manifest B becomes active;
the query never consults mutable shard heads or mixes snapshots. Up to 2,048
selected chunks are ranked exhaustively. Larger selections use a versioned
bounded hybrid pool: the content GIN index contributes at most 256 lexical
candidates, and a database-side cosine scan contributes the best 32 semantic
candidates from every selected shard. Total universe size is therefore not a
search ceiling, and growth in one selected shard cannot remove every semantic
candidate from another. The fallback is not an ANN index: it scans embeddings
only in the requested immutable shards, validates the complete selected
occurrence set, and may fail its five-second statement budget rather than
silently return a partial authority view. Each transaction limits `work_mem`
to 8 MiB and temporary files to 256 MiB; at most 128 ranked chunks, without
embedding arrays, cross into the web process. The initial lexical GIN index
covers chunk content only. Metadata-weighted lexical indexing and optional
`pgvector` acceleration require separate measured schema and infrastructure
changes; neither is assumed by this migration or the PostgreSQL 18 CI image.

`migrations/20260824_backstage_notion_partition_storage_v1.rollback.sql`
acquires exclusive locks in a fixed order and refuses with SQLSTATE `55000` if
any partition table contains a row. It never uses `CASCADE`. Validate execution
only through the dedicated PostgreSQL 18 integration suite and its explicitly
guarded disposable loopback database; ordinary static validation must not apply
the migration to a configured or shared database.

`migrations/20260824_backstage_notion_partition_scope_reads_v1/` adds the
partial parent-page index used by bounded recursive subtree resolution through
an exact catalog precheck, a standalone `CREATE INDEX CONCURRENTLY`, and an
exact post-build verifier. Its guarded recovery removes only an exact invalid
index left by an interrupted concurrent build. Scope
reads pin an exact sealed universe manifest and its immutable shard tuples;
page, subtree, and positional section eligibility is established before chunk
integrity checks or candidate generation. Complete-scope reads use deterministic
keyset pagination and return at most 128 chunks per application page without
projecting embedding arrays. Its guarded, idempotent rollback removes only the
additive exact index and does not remove partition history.

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
all nine suites. `npm run test:postgres-fencing` additionally requires
`JOB_CLAIM_FENCING_TEST_DATABASE_URL`,
`DAG_SNAPSHOT_GENERATION_TEST_DATABASE_URL`,
`JOB_WORKER_BUDGET_TEST_DATABASE_URL`,
`JOB_STALE_RECOVERY_TEST_DATABASE_URL`,
`BACKSTAGE_ROSTER_ATOMICITY_TEST_DATABASE_URL`,
`BACKSTAGE_STORYLINE_ATOMICITY_TEST_DATABASE_URL`,
`BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL`, and
`NON_GPT_TERMINAL_RETENTION_TEST_DATABASE_URL`. With the sentinel set, a
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

The repository-level Railway fail-safe used for this completed rollout was the
`20260727-dag-snapshot-generation-v1` value of
`ARCANOS_COORDINATED_DAG_WRITER_ROLLOUT_HOLD` in
`.github/workflows/railway-auto-deploy.yml`. With that hold active, successful
`main` CI could not automatically start the Railway deployment job. A
deliberate manual dispatch required the exact typed attestation
`DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1`; the workflow does
not perform or verify the drain itself.

That rollout is now verified and the marker is the exact sentinel `none`, which
restores normal worker-first web/worker pair promotion. For a future
incompatible writer migration, set a reviewed non-`none` hold before the change
reaches `main`, keep it active through rollout and any rollback, and return to
`none` only after every writer is compatible and healthy. Deleting, blanking,
or malforming the marker fails closed instead of silently lifting the hold.

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
