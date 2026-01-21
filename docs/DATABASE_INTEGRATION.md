# ARCANOS Database Integration

The database layer powers durable memory, retrieval, and worker telemetry for the
backend. The implementation lives under `src/db/` and is designed to fall back to
console/in-memory flows whenever PostgreSQL is unavailable so that local
development and CI continue to run.

---

## Architecture overview

The monolithic `db.ts` file has been refactored into a modular structure and now
re-exports stable helpers for backward compatibility:

| Module | Responsibility |
| --- | --- |
| `client.ts` | Connection pooling, SSL enforcement, connection status helpers, graceful shutdown (`initializeDatabase`, `getPool`, `getStatus`). |
| `schema.ts` | Zod schemas plus the SQL migrations executed during boot (`initializeTables`, `refreshDatabaseCollation`). |
| `query.ts` | Centralized query helper with caching, retry, and transaction utilities. |
| `repositories/` | Entity-specific helpers (`memoryRepository`, `ragRepository`, `executionLogRepository`, `jobRepository`, `reasoningLogRepository`, `selfReflectionRepository`). |
| `auditStore.ts` | Audit/persistence adapter that hides the underlying SQL client (Knex today, Prisma-ready interface). |
| `sessionCacheStore.ts` | Session cache adapter for the session persistence layer, isolated behind a DB-neutral contract. |
| `index.ts` | Public surface that wires the client, schema, and repositories, and exposes `initializeDatabaseWithSchema()` for worker/server boot. |

`src/db.ts` re-exports everything from `src/db/index.ts` so existing imports continue to work while the modular layout remains organized.

---

## Schema & entities

`schema.ts` provisions the tables listed below during startup:

- **Core persistence** – `memory`, `saves`, and `audit_logs` hold key/value
  state plus legacy persistence snapshots.
- **Retrieval** – `rag_docs` stores fetched documents and embeddings.
- **Backstage tooling** – `backstage_events`, `backstage_wrestlers`,
  `backstage_storylines`, and `backstage_story_beats` retain simulation data.
- **Self-reflection** – `self_reflections` captures AI retrospection payloads.
- **Worker telemetry** – `execution_logs`, `job_data`, and `reasoning_logs`
  store worker heartbeats, queued work, and GPT‑5 oversight summaries.

Every schema export also ships with a matching Zod type so higher-level modules
can validate payloads before writing to the database.

--- 

## Migration source of truth

Prisma is the source of truth for **domain** tables. Add or change core
application models in `prisma/schema.prisma` and ship migrations from there to
avoid drift. The SQL bootstrapping in `schema.ts` is a transitional layer for
legacy/infra tables (for example, audit logs or session caches) and should stay
aligned with Prisma migrations as those tables are migrated or deprecated.

---

## Repository helpers in practice

- `saveMemory`, `loadMemory`, `deleteMemory` back the `/api/memory/*` routes and
  enforce UPSERT semantics with optimistic caching for reads.
- `saveRagDoc` and `loadAllRagDocs` support the `/rag/fetch`, `/rag/save`, and
  `/rag/query` ingestion pipeline.
- `logExecution` and `logExecutionBatch` are called by worker contexts and
  `utils/workerContext.ts` so every worker run is mirrored into
  `execution_logs` even when the automation runs outside the main server.
- `createJob`, `updateJob`, and `getLatestJob` are used by
  `worker-planner-engine` to reason about queue depth and liveness.
- `logReasoning` and `saveSelfReflection` persist GPT‑5.2 reasoning summaries and
  CLEAR/self-reflection payloads for later audit.

These helpers guard against missing connections by checking
`isDatabaseConnected()` before running a query. When the pool is offline they
log to stdout and return fallback data so callers do not crash.

---

## API touchpoints

The following HTTP routes rely on the shared database module:

| Route | Usage |
| --- | --- |
| `/api/memory/save`, `/api/memory/load`, `/api/memory/delete`, `/api/memory/list`, `/api/memory/view`, `/api/memory/bulk`, `/api/memory/health` | CRUD operations and status reporting. Errors bubble up when no database is configured so operators know persistence is disabled. |
| `/rag/*` | Fetch, store, and query documents with embeddings before answering retrieval-augmented prompts. |
| `/api/memory/health` & `/workers/status` | Surface the connection status returned by `getStatus()` so dashboards can show degraded persistence. |
| `/workers/run/:workerId` | Workers executed via the HTTP API inherit the same `createWorkerContext()` used during `initializeWorkers()`, which injects the database `query` helper. |
| `/commands/research`, `/sdk/research`, `/api/ask-hrc` | Persist generated insights, diagnostics, and audit trails through the repositories described above. |

Because `initializeWorkers()` calls `initializeDatabase('worker-boot')` during
server startup, the worker status payload always includes the latest connection
state even if automation is disabled via `RUN_WORKERS`.

---

## Configuration

The connection helper automatically reads either `DATABASE_URL` or assembles a
connection string from `PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, and
`PGDATABASE`. When the host is not `localhost` it appends `sslmode=require`
unless one is already provided, ensuring managed deployments negotiate SSL.
Additional variables such as `DATABASE_PUBLIC_URL`, `PGDATA`, and
`POSTGRES_USER/PASSWORD` are loaded so Railway-provisioned environments that only
set a subset of credentials still boot correctly.

Useful scripts:
- `npm run db:init` – ensures the pool and schema can be created.
- `npm run db:patch` – reruns the table sync logic (`schema.ts`).

---

## Boot sequence

1. `performStartup()` (`src/startup.ts`) calls `initializeDatabase('server')`.
   Failures log a warning and the service continues in in-memory mode while the
   health endpoints show the degraded status.
2. `initializeWorkers()` repeats the initialization with the worker identifier
   so that worker heartbeats can be written even when they start before the
   server. If `RUN_WORKERS` is not `true`/`1`, the helper still records the
   connection state for `/workers/status`.
3. The `/api/memory/health` route reads the latest status via `getStatus()` to
   display `connected`, `hasPool`, and `error` fields.

---

## Fallback & observability

- `logExecution`/`logExecutionBatch` print to stdout whenever the pool is
  offline so worker telemetry is never lost.
- `query()` throws a descriptive `Database not configured` error when a helper
  is called without a connection; the HTTP handlers wrap these errors with JSON
  responses that explain persistence is disabled.
- The worker context exposes `context.db.query` so every custom worker benefits
  from the same retry/caching logic without re-implementing pool management.
- `/api/memory/health` is the quickest way to confirm the current status from an
  operator dashboard.

---

## Testing expectations

Jest suites call `initializeDatabase()` against ephemeral instances and verify
that missing credentials trigger the fallback pathways described above. When a
real database is available, the tests assert that memory CRUD helpers, RAG
repositories, and worker logging all function end-to-end.
