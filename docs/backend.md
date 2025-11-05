# 🧠 Arcanos Backend Documentation

This guide describes how the Arcanos backend boots, configures services, and
exposes its API surface. The project is a TypeScript service that compiles to
`dist/` and runs on Node.js ≥ 18 with Express, the OpenAI SDK v5, and a modular
persistence layer.

---

## 🚀 Quick Start

1. Install dependencies
   ```bash
   npm install
   ```
2. Compile TypeScript
   ```bash
   npm run build
   ```
3. Launch the server (automatically selects a free port if the preferred one is
   unavailable)
   ```bash
   npm start            # runs dist/start-server.js
   ```

The runtime entry point `src/start-server.ts` calls `startServer()` from
`src/server.ts`. Build artifacts live in `dist/` (see `package.json` scripts and
`tsconfig.json`).

---

## 🏗️ Runtime Architecture

### Startup pipeline
When `startServer()` runs, the following lifecycle executes:

1. **`performStartup()`** (`src/startup.ts`)
   - Validates environment variables and filesystem expectations through
     `utils/envValidation.ts` and `utils/environmentSecurity.ts`.
   - Initializes the database connection with a fallback to in-memory storage if
     PostgreSQL is unavailable (`db/index.ts`).
   - Bootstraps the memory store (`memory/store.ts`) and verifies persistence
     schemas (`persistenceManagerHierarchy.ts`).
   - Ensures the configured OpenAI API key can initialize an SDK client
     (`services/openai.ts`).

2. **`createApp()`** (`src/app.ts`)
   - Creates the Express instance with CORS, JSON body parsing, structured
     logging, and diagnostics middleware.
   - Installs OpenAI clients on `app.locals` via `init-openai.ts`.
   - Registers every route bundle through `routes/register.ts` and installs
     fallback/error middleware.

3. **Port selection & worker bootstrap** (`src/server.ts`)
   - Resolves a preferred port from `PORT`/`HOST` with automatic fallback using
     `utils/portUtils.ts`.
   - Calls `initializeWorkers()` (`utils/workerBoot.ts`) to load optional worker
     modules located in `workers/`. When the directory is absent the call
     completes without error.
   - Logs a boot summary including active models, worker settings, and health
     endpoints.

4. **Background automation**
   - `src/logic/aiCron.ts` schedules a heartbeat every minute that writes
     `memory/heartbeat.json` and logs recent activity.
   - `runSystemDiagnostic()` (`services/gptSync.ts`) executes shortly after
     startup to verify OpenAI connectivity.

5. **Lifecycle guards**
   - Signal handlers perform graceful shutdowns and print Railway diagnostics.
     Uncaught errors are logged and keep the process alive where possible.

---

## ⚙️ Environment Configuration

### Required

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | API key used to initialize the OpenAI SDK client. Without it, AI endpoints return mock responses. |

### Model selection priority
`services/openai.ts` chooses the first defined value in the list below and
defaults to `gpt-4o` when none are provided:
`OPENAI_MODEL` → `FINETUNED_MODEL_ID` → `FINE_TUNED_MODEL_ID` → `AI_MODEL`.

### Server & logging

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Preferred HTTP port. `startServer()` falls back to the next available port if occupied. |
| `HOST` | `0.0.0.0` | Bind address. |
| `SERVER_URL` | `http://127.0.0.1:<port>` | Used when generating status URLs for backend sync. |
| `NODE_ENV` | `development` | Controls logging verbosity and error payloads. |
| `LOG_LEVEL` | `info` | Logging level for structured logs. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Location for persisted log artifacts. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Base directory for memory files (used by `memoryAware` utilities). |

### Database connectivity

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Primary connection string. When omitted or connection fails, an in-memory persistence fallback is used. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Optional components that are assembled into `DATABASE_URL` if the main variable is missing. |

Database initialization is coordinated through `initializeDatabase()`
(`db/index.ts`), which populates status information consumed by health
endpoints.

### Worker & cron controls

| Variable | Default | Description |
|----------|---------|-------------|
| `RUN_WORKERS` | `true` (disabled automatically in tests) | Enables loading and scheduling of worker modules from `workers/`. |
| `WORKER_COUNT` | `4` | Reported worker count in diagnostics and status responses. |
| `WORKER_MODEL` | Falls back to selected AI model | Model identifier propagated to worker contexts. |
| `WORKER_API_TIMEOUT_MS` | `60000` | Timeout for OpenAI requests executed by workers. |

If `RUN_WORKERS` is disabled or no worker modules exist, initialization completes
with empty worker lists while still validating the database connection for
observability.

### Security & compliance

| Variable | Purpose |
|----------|---------|
| `TRUSTED_GPT_IDS` | Comma-separated list of GPT IDs that bypass the `x-confirmed: yes` requirement enforced by `middleware/confirmGate.ts`. |
| `ALLOW_ROOT_OVERRIDE` & `ROOT_OVERRIDE_TOKEN` | Allow elevated persistence operations during troubleshooting (`persistenceManagerHierarchy.ts`). |
| `ADMIN_KEY`, `REGISTER_KEY` | Optional keys used by orchestration and registration workflows. |

Additional environment validation and enforcement rules can be found in
`utils/environmentValidation.ts` and `utils/envValidation.ts`; failures are
surfaced during `performStartup()` and will abort the boot when marked critical.

---

## 🧠 Data & Memory Layer

- **Primary storage** – `db/` implements a modular persistence layer with schema
  validation, query helpers, and repositories. `initializeDatabase()` attempts to
  connect using the configured PostgreSQL credentials.
- **Fallback mode** – If PostgreSQL cannot be reached, operations such as memory
  storage degrade gracefully to in-memory implementations while health endpoints
  report the degraded state.
- **Session memory** – `memory/store.ts` maintains a hybrid cache backed by
  filesystem snapshots located under `ARC_MEMORY_PATH`.
- **State management** – `services/stateManager.ts` exposes `loadState()` /
  `updateState()` for `/status` routes and records the currently running port,
  version, and uptime.

---

## 📡 API Surface

Routes are registered in `routes/register.ts`. Highlights include:

### Health & diagnostics
- `GET /` – Plain-text "ARCANOS is live" banner.
- `GET /railway/healthcheck` – Railway probe compatible with platform defaults.
- `GET /health` – Aggregated service health (OpenAI, database, caches) with
  degraded status reporting.
- `GET /healthz` – Liveness probe.
- `GET /readyz` – Readiness probe (ensures database/OpenAI availability).
- `GET /status` / `POST /status` – Read and update the in-memory system state
  (`services/stateManager.ts`).

### Core AI entry points
- `POST /ask` – Primary chat endpoint routed through `logic/trinity.ts` (no
  confirmation required).
- `POST /brain` – Alias for `/ask` that retains the confirmation gate
  requirement.
- `POST /arcanos` – Diagnostic endpoint powered by `logic/arcanos.ts` (requires
  confirmation).
- `POST /siri` – Siri-style assistant entry point (requires confirmation).
- `POST /arcanos-pipeline` – Multi-stage reasoning pipeline combining the default
  model, a GPT‑3.5 sub-agent, and GPT‑5 oversight.
- `POST /api/arcanos/ask` – Minimal JSON API for programmatic access (requires
  confirmation).

### Memory & worker management
- `GET /api/memory/health` – Database-backed memory health report.
- `POST /api/memory/save`, `GET /api/memory/load`, `DELETE /api/memory/delete`,
  `GET /api/memory/list`, `GET /api/memory/view`, `POST /api/memory/bulk` –
  CRUD-style memory APIs (write operations gated by `confirmGate`).
- `GET /workers/status` – Worker initialization status and scheduler insights.
- `POST /workers/run/:workerId` – Execute a worker module by ID (requires
  confirmation).
- `POST /heartbeat` – Append heartbeat telemetry to `logs/heartbeat.log`.

### Additional integrations
- `/write`, `/guide`, `/audit`, `/sim` – Core AI utility routes (confirmation
  required).
- `/api/sim/*` – Simulation API with health/examples endpoints and optional
  streaming.
- `/image` – Image generation using OpenAI Images API.
- `/rag/*` – Retrieval augmented generation ingestion and query helpers.
- `/commands/research` – Research module for summarizing external sources.
- `/sdk/research` – SDK entry point that reuses the same research pipeline for
  Railway deployments and OpenAI SDK consumers.
- `/api/ask-hrc` – Hallucination-resistant classification endpoint.
- `/gpt/*` – GPT routing helpers defined in `routes/gptRouter.ts`.
- `/backstage/*` – Backstage tooling endpoints for legacy integrations.
- `/api/pr-analysis/*`, `/api/openai/*`, `/api/commands/*` – Specialized APIs for
  PR review, OpenAI compatibility, and command execution.

> **Confirmation header** – Mutating routes generally require `x-confirmed: yes`
> unless the caller identifies as a trusted GPT (`TRUSTED_GPT_IDS`). Requests are
> logged with the outcome for audit compliance.

---

## 📈 Observability & Health Checks

- Structured logging originates from `utils/structuredLogging.ts`. Log
  categories map to the boot summary printed in `server.ts`.
- Heartbeat data lives in `memory/heartbeat.json` and is refreshed every minute
  by `logic/aiCron.ts`.
- `/health`, `/healthz`, `/readyz`, and `/status` surface database and OpenAI
  availability, cache stats, and uptime metrics.
- `services/gptSync.ts` executes a post-boot diagnostic to validate external
  connectivity.

---

## 🔐 Security Controls

- `middleware/confirmGate.ts` enforces confirmation requirements and trusted GPT
  overrides.
- `utils/environmentSecurity.ts` applies safe-mode overrides when critical
  configuration is missing.
- `utils/security.ts` centralizes request validation schemas, rate limiting, and
  security headers used across routes.

---

## 🧪 Testing & Tooling

- `npm test` runs Jest suites covering environment security, memory round-trips,
  OpenAI fallbacks, and worker coordination.
- `npm run lint` enforces TypeScript style via ESLint.
- `npm run build && npm start` validates the production build path.

For more granular diagnostics see `docs/api/API_REFERENCE.md` and
`docs/CONFIGURATION.md`.
