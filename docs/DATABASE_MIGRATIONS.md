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
| `src/db/schema.ts` | Idempotent table definitions used by older schema initialization tooling. |
| `prisma/schema.prisma` | Prisma schema for ActionPlan/CLEAR-related models and Prisma client generation during Docker builds. |
| `migrations/*.sql` | Hand-written SQL migrations and rollback SQL for runtime tables. |
| `contracts/job_status.openapi.v1.json` | Contract for job status reads. |
| `contracts/job_result.openapi.v1.json` | Contract for job result reads. |

## Runtime Behavior
- The backend calls `initializeDatabaseWithSchema()` during startup and continues with in-memory fallback when the database is unavailable.
- The dedicated worker process requires database connectivity before it can claim queued jobs.
- GPT and worker job state is stored in database-backed job tables, not Redis.
- Redis supports fast shared state and health visibility; it is not the durable job source of truth.

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

## Run locally
Start the backend after configuring the database:
```bash
npm run build
npm start
```

Start the dedicated worker only when the database and OpenAI key are configured:
```bash
npm run start:worker
```

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
