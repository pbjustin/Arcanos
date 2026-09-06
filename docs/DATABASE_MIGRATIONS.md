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

Durable Gaming document chunking uses these existing tables without a new
migration. One source owns immutable revisions, and each revision owns up to
500 bounded knowledge records. Existing JSONB `normalized` data carries chunk
text and deterministic ordinal/offset/hash metadata; each `search_text` contains
only that chunk's evidence and bounded search metadata. The revision text is a
16,000-character preview, while its hash covers the full accepted document and
index-policy version. Refresh supersession and historical revision reactivation
occur inside the source-locking transaction. Lexical queries exclude superseded
records and inactive sources; historical single-record revisions stay readable
until a controlled refresh. No vector columns or automatic reindex are added.

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

`migrations/20260829_backstage_notion_rag_v3_snapshot_capacity.sql` is the
bounded authoritative-snapshot capacity upgrade. Apply it after V2. It raises
only the monolith storage and reader ceiling from 2,048 to 4,096 chunks;
partition shard ceilings remain separate and unchanged. This compatibility
rollout first retained a 2,048-chunk writer fence while 4,096-capable readers
were deployed. The follow-up bounded release advances
`BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT` to the already-supported
4,096 reader ceiling, so readers and writers now share the same bounded limit.
The shared invariant prevents the writer ceiling from exceeding reader capacity.
Candidates of 4,097 chunks or more fail at chunking before embedding, candidate
creation, persistence, validation, or activation; no path truncates the source
to satisfy the fence. The writer validates the complete candidate in memory,
serializes page and chunk records into record- and byte-bounded batches,
inserts every batch inside the existing single
transaction, and compares exact persisted page and chunk counts before the
authority head can flip. The V3 `BN002` fence independently repeats both count
checks for alternate or rolling-version writers. Any batch, count, lease, or
activation failure rolls the candidate back and leaves the prior active
snapshot readable. Authoritative synchronization also passes one absolute,
non-renewable cycle deadline into activation. Before every persistence batch,
inventory check, head update, and commit, the repository reapplies a
transaction-local statement timeout bounded by the remaining cycle budget.
A lost commit response is reconciled against the active head on a fresh,
bounded read before the writer reports success or failure.

The V3 rollback refuses with SQLSTATE `55000` if declared or persisted immutable
history exceeds 2,048 chunks. It never truncates or deletes a snapshot to make a
downgrade fit. During a rolling release, an older reader encountering a newly
expanded snapshot fails closed rather than loading a partial index. Every
serving web and worker revision must therefore contain the 4,096-capable reader
release before a worker with the raised writer fence is deployed or allowed to
sync.

`migrations/20260829_backstage_notion_rag_v4_sync_status.sql` adds only the
bounded latest synchronization-attempt projection. It does not own or replace
the immutable snapshot rows or the authority head. Attempt start and completion
are fenced by the existing live sync lease and by an increasing per-universe
generation, so an older attempt cannot overwrite a newer result. A failed or
interrupted refresh records only bounded counts and enumerated phase/reason
metadata; it cannot clear, invalidate, or detach the active snapshot pointer.
Readers combine this independent attempt state with the active snapshot header
to distinguish `current_complete`, `last_known_good`, and `unavailable` without
describing stale continuity as current. Continuity reads carry explicit bounded
`last_known_good` metadata, while protected booking generation remains fail
closed while a refresh is incomplete, after a failed refresh, or after
freshness expiry. An in-progress refresh does not interrupt continuity reads
already pinned to the prior complete active snapshot. The
V4 rollback drops only the status table; it leaves the complete active snapshot
and authority head untouched.

`migrations/20260902_backstage_notion_rag_candidate_search_v1.sql` adds derived
native search material for monolithic snapshot candidates. It leaves canonical
snapshot/page/chunk rows and the active authority pointer unchanged. The new
sidecar converts each validated JSONB embedding once to `DOUBLE PRECISION[]`,
stores its norm, precomputes a `TSVECTOR` with a GIN index, and persists the
bounded booking-brand mask. Exact cosine scoring and deterministic tie-breaking
remain application/database behavior over the supported maximum of 4,096
chunks. This release intentionally does not assume that the `pgvector`
extension or an ANN operator class is installed in PostgreSQL 18.

The migration deliberately leaves the new table empty; it does not scan or
rewrite historical immutable snapshots. Roll it out in this order:

1. Apply and verify the additive migration before starting a compatible worker.
   The migration installs the `BN003` activation fence without changing the
   current head. After installation, any worker revision changing
   `active_snapshot_id` must supply exact declared/canonical/sidecar count and
   membership parity. A legacy canonical-only writer therefore fails closed
   and leaves the prior active head unchanged instead of activating a snapshot
   that the native reader cannot use.
2. Keep the old web reader and the legacy worker deployment active and healthy;
   the canonical paired Railway promotion preflights both baseline services.
   Do not select the backfill target until the migration has committed. The
   installed `BN003` fence then rejects every later canonical-only head change
   from the legacy writer, so re-read the exact active target after the fence
   is installed rather than treating a failed legacy sync as backfill evidence.
3. With separately confirmed production authorization and the exact active
   Notion `universe_id`, `snapshot_id`, and expected chunk count, run
   `scripts/backstage-notion-candidate-search-backfill.mjs` with its dedicated
   database environment variable and explicit `--execute`. The idempotent
   script inserts only missing rows in batches of at most 128. Every database
   phase uses a 1-second lock timeout and 15-second statement/idle timeout. Its
   final bounded transaction holds `FOR SHARE` on the exact active authority
   head while it requires canonical chunk count, sidecar count, and recomputed
   valid-sidecar count to equal the operator-confirmed count. A head rotation,
   malformed embedding, incomplete sidecar, timeout, or count mismatch prevents
   the `completed:true` report. A successful report includes `targetDigest`,
   defined as the SHA-256 digest of the UTF-8 JSON encoding of the normalized
   versioned tuple `["backstage-notion-candidate-backfill-target/v1",
   trimmedUniverseId, lowercaseSnapshotId, expectedChunksInteger]`; it does not
   emit the raw identifiers.
4. Only after independently recomputing and matching `targetDigest` from the
   separately confirmed exact values, and after a read-only review establishes
   that the same snapshot is still active, dispatch the canonical paired
   Railway promotion. It deploys the compatible dual-writing worker first and
   the native-reader web second. The new writer populates canonical chunks and
   their derived search rows in one transaction, checks exact inventory parity,
   and cannot activate a partially indexed candidate snapshot. Do not dispatch
   the paired promotion before the exact active target passes backfill and
   digest verification; its general coordinated-writer confirmation is not a
   candidate-sidecar completeness gate.

   The pre-promotion `targetDigest` proves the backfilled legacy active target.
   If the compatible worker safely activates a successor before the web step,
   that digest is historical evidence rather than proof of the new current
   head. The compatible writer transaction and `BN003` fence protect the
   successor; the post-promotion read-only checks must establish the current
   head and native-query outcome without relabeling the earlier digest.

   New readers fall back to the legacy JSONB query only when the entire
   sidecar query fails with SQLSTATE `42P01` because the table is absent. Once
   the table exists, an empty, incomplete, malformed, or mismatched sidecar
   fails closed; it never silently selects the legacy query.

Do not apply this migration or run the backfill as routine validation, and do
not execute either production operation without separate target-specific
authorization. For rollback, first drain every new reader and writer and deploy
the old web and worker revisions. Only then may the conservative compensation
drop the derived table and its helper functions. It does not delete or alter
canonical snapshots, chunks, or the authority head; removing it while a new
reader or writer remains active is unsupported.

The V2 fence rollback takes `ACCESS EXCLUSIVE` on the head table and refuses with
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

`migrations/20260829_backstage_notion_partition_complete_manifest_head_guard.sql`
upgrades existing installations to the complete-manifest head guard already used
by fresh runtime/bootstrap storage. A head cannot be cleared after activation and
can advance only by exact compare-and-swap generations to a sealed manifest for
the desired configuration. The manifest must contain every configured shard,
have no omissions, and bind fresh readable snapshots with one supported index
and embedding contract. A partial collection therefore cannot become active,
and the guarded rollback restores only the prior guard definition; it does not
rewrite data or synthesize a manifest.

`migrations/20260829_backstage_notion_partition_source_generation_v1.sql` adds
the immutable source-generation barrier. One verified authority capture records
the exact universe, configuration version, source digest, page/chunk coverage,
verification time, and verification hash. Every sealed shard and its manifest
must bind the same generation and digest, while manifest coverage must equal the
captured authority corpus. Triggers reject mixed-generation, missing-generation,
or incomplete manifests before they can become active. The compensation removes
only the additive enforcement hooks; it intentionally retains provenance columns
and every immutable source-generation record rather than deleting history to
enable a downgrade.

`migrations/20260830_backstage_notion_partition_cutover_evidence_v1.sql` adds
durable, content-free cutover evidence plus current and published reconciliation
generations on the partition universe head. Registration advances the current
generation before shard work; manifest activation atomically publishes only that
exact generation with the active pointer. Rollback atomically reactivates a prior
complete manifest and advances/publishes a new generation, invalidating evidence
from the superseded epoch. Evidence is tied by foreign keys and constraints to
the exact manifest, configuration, source generation/digest, supported embedding
and index contract, fresh readable rollback monolith, and finite validity window.
It records representative-query, exact-scope, relevant-retrieval,
complete-scope, and cursor-stability parity. Missing, stale, mixed, failed, or
expired evidence keeps the cutover gate closed; neither schema creation nor
synchronization changes the deployed read mode. The rollback refuses while any
verified evidence row exists instead of deleting that evidence implicitly.

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

### Worker hard-budget evidence migration

`migrations/20260830_job_events_worker_budget_v1/` adds the strict evidence
contract used to serialize queue claims and conservative native OpenAI
transport-capacity admission for each `JOB_WORKER_STATS_ID`. It adds nullable `stats_worker_id`,
`claim_generation`, and `operation` columns to `job_events`, validates the named
event-shape constraint separately, and builds two partial B-tree indexes with
standalone `CREATE INDEX CONCURRENTLY` phases. Runtime startup creates those
indexes only with a newly created, empty `job_events` table; a populated
existing table must use the reviewed six-phase migration. Startup and the
migration verifiers reject same-name columns, constraints, or indexes with a
different catalog shape.

The ledger uses one PostgreSQL clock and strict `(T - 1 hour, T]` windows.
Per-kind/per-group transaction advisory locks serialize concurrent slots and
replicas. A `worker.budget.job_claim` row commits in the same transaction as the
ordered queue claim and generation increment. A
`worker.budget.ai_provider_attempt` row commits before its corresponding native
transport handoff. Cancellation after that commit can still prevent native
dispatch, but neither that cancellation nor a later provider failure refunds
the conservative reservation. The reserved
nil UUID is a documented non-job subject for worker-owned startup/scheduled
embedding work and never identifies a stored queue row.

Budget admission transactions install transaction-local PostgreSQL 18 bounds
before advisory locking: a one-second lock wait, five-second statement limit,
and ten-second whole-transaction ceiling. Claim transactions further cap the
whole-transaction ceiling at half their effective lease, so their single
database-clock lease cannot commit already expired. The readiness budget-usage
query runs inside the same bounded read-committed transaction contract. Lock,
statement, and whole-transaction timeouts are retryable database dependency
failures and never admit unrecorded work.

This additive schema is not sufficient for a mixed-version hard-quota rollout.
Drain all legacy claim and provider-call paths and keep them quiet for one full
hour, then apply and verify all six phases before compatible workers accept
claims. Provider attempts and retries made by legacy code cannot be exactly
backfilled. Configure identical maxima on every slot and replica sharing a stats
group. The rollback scripts take an access-exclusive table lock, compare the
owned objects to their canonical catalog definitions, and refuse destructive
DDL if budget evidence remains or the contract has drifted. Run migration,
verification, and rollback only against an explicitly confirmed target; the
PostgreSQL 18 integration suite uses only the guarded disposable
`JOB_WORKER_BUDGET_TEST_DATABASE_URL` target and never ambient `DATABASE_URL`.
Rollback phase 2 refuses to bypass guarded phase-1 index removal or to remove
columns with auxiliary dependent objects; after the complete owned contract is
absent, rerunning phase 2 is a no-op.

The repository-owned Railway hold for this incompatible rollout is the exact
`20260830-job-events-worker-budget-v1` value of
`ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD`. It must be active before this
change reaches `main` and remain active through the drain, uninterrupted
one-hour quiet window, two ordered passes through all six phases, compatible
worker-first/web-second activation, verification, and any rollback decision.
Automatic promotion remains blocked while it is active. The exact manual
attestation does not perform or verify the migration. Restore the inactive
`none` sentinel only in a separately reviewed change after the exact installed
contract and indexes, every compatible writer revision, identical group limits,
absence of restartable legacy paths, and paired health/readiness are verified.
The change introducing this migration cannot remove its own hold.

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
`ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD` in
`.github/workflows/railway-auto-deploy.yml`. With that hold active, successful
`main` CI could not automatically start the Railway deployment job. A
deliberate manual dispatch required the exact typed attestation
`DAG WRITERS DRAINED: 20260727-dag-snapshot-generation-v1`; the workflow did
not perform or verify the drain itself. The guard has since been generalized;
current coordinated rollouts use the `COORDINATED WRITERS DRAINED: <hold-id>`
prefix documented above.

That DAG rollout was verified and its marker was returned to `none`. The same
repository control is now assigned the worker hard-budget hold documented
above. For a future incompatible writer migration, set a reviewed non-`none`
hold before the change reaches `main`, keep it active through rollout and any
rollback, and return to `none` only after every writer is compatible and
healthy. Deleting, blanking, or malforming the marker fails closed instead of
silently lifting the hold.

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
